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

  # The R2 bucket's S3-compatible origin. The cdn record is a proxied CNAME at
  # this hostname, which is the shape Cloudflare's own "connect a custom domain"
  # flow produces for a bucket.
  r2_origin_hostname = "${var.r2_bucket_name}.${var.cloudflare_account_id}.r2.cloudflarestorage.com"
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

# --- DNS ---------------------------------------------------------------------

# cdn.<zone> fronts the R2 bucket. Proxied is not optional here: the bucket's
# own r2.dev URL is explicitly not cached by Cloudflare, so serving a ~110 MB
# CLI binary or a several-hundred-megabyte voice pack from it would pay origin
# egress on every single download. The DNS record is only half of that setup —
# the bucket must also be connected to this custom domain, and a Cache Rule must
# be created for it. Both steps are written out in infra/README.md.
#
# ttl = 1 means "automatic" and is required whenever proxied is true.
resource "cloudflare_dns_record" "cdn" {
  zone_id = local.zone_id
  name    = local.cdn_hostname
  type    = "CNAME"
  content = local.r2_origin_hostname
  ttl     = 1
  proxied = true
  comment = "Release artefact delivery for ${cloudflare_r2_bucket.artifacts.name}; managed by infra/terraform"
}
