# Delivery infrastructure for the local tier: one R2 bucket holding release
# artefacts, and the cached custom domain that serves them (ADR 0011).
#
# This is the storage-and-delivery primitive that auto-update and first-run
# downloads are built on. ADR 0005 books "a CDN and a version/checksum manifest
# become infrastructure, not an afterthought" for the per-OS TTS bundles that
# `xplainer setup` fetches on first run; roadmap phase 4 owns pointing
# `electron-updater` at a real feed. Neither is wired yet — `publish: null` in
# apps/desktop/electron-builder.yml and `--publish never` in
# .github/workflows/desktop.yml are the current, deliberate state. What is
# declared here is the bucket and the cached hostname both of them will need,
# because getting the cache wrong is the expensive mistake (see infra/README.md).
#
# The hosted plane's VM, firewall and `mcp` DNS record are no longer declared
# here. They moved, with the rest of the hosted tier, to the private repository
# BrewMyTech/xplainer-hosted.

locals {
  cdn_hostname = "cdn.${var.zone_name}"
}

# --- Cloudflare zone ---------------------------------------------------------

# The zone is looked up by name rather than taken as an opaque id variable, so
# the tfvars file holds a domain a human can check by reading it. The plural
# data source is used on purpose: `cloudflare_zones` returns a `result` list
# whose elements carry a documented `id`, whereas the singular data source
# populates its id only for some of its lookup forms.
data "cloudflare_zones" "primary" {
  name = var.zone_name

  account = {
    id = var.cloudflare_account_id
  }
}

locals {
  zone_id = data.cloudflare_zones.primary.result[0].id
}

# --- Storage -----------------------------------------------------------------

# Release artefacts: signed CLI and desktop builds, the per-OS TTS bundles
# `xplainer setup` downloads on first run, and the version/checksum manifest
# that names them (ADR 0005). No AWS (ADR 0011).
#
# This is NOT a rename of the `renders` bucket that used to be declared here,
# and there is deliberately no `moved` block: rendered MP4s are per-user output
# with a different lifecycle, a different cache policy and a different access
# model from immutable, publicly readable release artefacts, and putting both
# behind one Cache Rule would be a mistake. The renders bucket is now declared
# in the private BrewMyTech/xplainer-hosted repository, which is the only place
# that still has anything to write into it.
#
# `location` and `storage_class` are left unset on purpose. Both are optional
# and computed, and a location hint is a one-way choice made at creation time;
# picking one here from a guessed enum value would fail at apply rather than at
# validate. infra/README.md records how to set it deliberately.
resource "cloudflare_r2_bucket" "artifacts" {
  account_id = var.cloudflare_account_id
  name       = var.r2_bucket_name
}

# --- Delivery ----------------------------------------------------------------

# cdn.<zone> fronts the R2 bucket, and this resource is the *whole* of that
# connection: R2 creates and owns the DNS record, provisions the certificate,
# and proves ownership. Proxying is not optional — the bucket's own r2.dev URL
# is explicitly not cached by Cloudflare, so serving a ~110 MB CLI binary or a
# several-hundred-megabyte voice pack from it would pay origin egress on every
# single download.
#
# **This used to be a hand-rolled `cloudflare_dns_record` pointing a proxied
# CNAME at `<bucket>.<account>.r2.cloudflarestorage.com`, and that was wrong in
# two ways.** That hostname is the S3-compatible *API* endpoint, which answers
# anonymous reads with an auth error rather than an object, so the record could
# never have delivered an artefact. And connecting the bucket to the custom
# domain — which R2 requires regardless — *replaces* that record with its own
# CNAME onto `public.r2.dev`, leaving Terraform holding a record id that no
# longer exists: a later `apply` would recreate the broken record beside the
# working one. Both were observed on 2026-09-11 against the real zone, which is
# how they were found. The record is R2's to manage, so Terraform manages the
# custom domain and not the record.
resource "cloudflare_r2_custom_domain" "cdn" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.artifacts.name
  domain      = local.cdn_hostname
  zone_id     = local.zone_id
  enabled     = true
  min_tls     = "1.2"
}

# --- Cache -------------------------------------------------------------------

# Connecting the custom domain proxies the hostname; it does NOT cache it. A
# proxied-but-uncached bucket pays R2 Class B operations and egress on every
# download, which is the same bill as `r2.dev` with extra steps — so this rule
# is the half that makes the custom domain worth having, and leaving it out is
# the expensive mistake rather than a missing nicety.
#
# A release artefact is immutable: a published version's bytes never change and
# a new version gets a new key, so a long edge TTL is safe and is the whole
# point. Two things are not, and each gets its own clause:
#
# - **An error is never cached.** The edge TTL below *overrides* the origin, so
#   without `status_code_ttl` a `404` for a key requested before its upload
#   would be served from the edge for the full 30 days after the object
#   arrived — a URL poisoned by one premature request. Every 4xx and 5xx is
#   `-1` (no-store) in both rules.
# - **A manifest is the one mutable kind of key** (`toolchain/v1/manifest.json`,
#   `toolchain/v2/manifest.json`): it is rewritten when a new artefact is
#   published. The second rule matches it by path and caps both TTLs at five
#   minutes. It sits after the first rule on purpose: when several cache rules
#   match, Cloudflare applies them in order and a later rule's setting wins.
#   A publish that cannot wait five minutes purges the one URL
#   (infra/README.md §Publishing a manifest).
resource "cloudflare_ruleset" "cdn_cache" {
  zone_id = local.zone_id
  name    = "Cache release artefacts on ${local.cdn_hostname}"
  kind    = "zone"
  phase   = "http_request_cache_settings"

  rules = [
    {
      ref         = "cdn_artefacts_eligible_for_cache"
      description = "Release artefacts on ${local.cdn_hostname} are immutable and cacheable; errors are not"
      expression  = "(http.host eq \"${local.cdn_hostname}\")"
      action      = "set_cache_settings"
      enabled     = true

      action_parameters = {
        cache = true

        edge_ttl = {
          mode    = "override_origin"
          default = 2592000 # 30 days

          status_code_ttl = [{
            status_code_range = { from = 400, to = 599 }
            value             = -1 # no-store: a premature 404 must not outlive the upload
          }]
        }

        browser_ttl = {
          mode    = "override_origin"
          default = 3600 # 1 hour
        }
      }
    },
    {
      ref         = "cdn_manifests_short_ttl"
      description = "Manifests on ${local.cdn_hostname} are rewritten on publish: five minutes at the edge and in the browser"
      expression  = "(http.host eq \"${local.cdn_hostname}\" and ends_with(http.request.uri.path, \"/manifest.json\"))"
      action      = "set_cache_settings"
      enabled     = true

      action_parameters = {
        cache = true

        edge_ttl = {
          mode    = "override_origin"
          default = 300 # 5 minutes

          status_code_ttl = [{
            status_code_range = { from = 400, to = 599 }
            value             = -1
          }]
        }

        browser_ttl = {
          mode    = "override_origin"
          default = 300
        }
      }
    },
  ]
}
