# `infra/` — delivery, and the local speech container

Nothing in here runs a service for anyone. This directory used to describe the
hosted plane — a VM, a firewall, a five-service Compose stack and the `mcp`
hostname in front of it. All of that moved to the private repository
**`BrewMyTech/xplainer-hosted`**, with its history, and none of it is coming
back. What is left is three things that serve the *local* product, kept for
reasons written out below so that none of them is mistaken for a hosted
leftover.

| Path | What it is | Who it serves |
| --- | --- | --- |
| `terraform/` | An R2 bucket for release artefacts and the cached custom domain that delivers them. | Auto-update, and the first-run downloads `xplainer setup` performs. |
| `docker-compose.tts.yml` | The Kokoro TTS container on `127.0.0.1:8880`, alone. | A developer who has Docker and wants the pinned speech server in one command. |
| `e2e/` | A Debian image that runs the end-to-end render on Linux, and its build-context filter. | Roadmap **P1-1**, whose second half is "on a headless Linux VM". |

They are independent of each other. None of them is required to build, test or
run the CLI: `pnpm turbo build lint typecheck test` touches all three not at
all, and the desktop app builds with `--publish never` today.

---

## Terraform — the delivery primitive

```sh
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # then fill in the token
terraform init
terraform plan
terraform apply
```

To check the configuration with no credentials at all, which is what CI does:

```sh
terraform -chdir=infra/terraform fmt -check
terraform -chdir=infra/terraform init -backend=false
terraform -chdir=infra/terraform validate
```

### What it declares

| Resource | Purpose |
| --- | --- |
| `cloudflare_r2_bucket.artifacts` | Release artefacts: signed CLI and desktop builds, the per-OS TTS bundles, and the version/checksum manifest naming them. No AWS (ADR 0011). |
| `cloudflare_dns_record.cdn` | `cdn.<zone>` → the bucket, proxied. The hostname an update feed or a first-run download is served from. |

That is the whole module. Four inputs, two outputs, one bucket, one record.

### Why a public, local-first repository declares any infrastructure at all

Because a locally-installed product still has to be *delivered*, and delivery is
the part that is easy to get expensively wrong.

- **ADR 0005** books "a CDN and a version/checksum manifest become
  infrastructure, not an afterthought" for the standalone TTS builds that
  `xplainer setup` fetches on first run. Those bundles are several hundred
  megabytes each and one is fetched per install.
- **Roadmap phase 4** owns pointing `electron-updater` at a real update feed.
  Today `apps/desktop/electron-builder.yml` sets `publish: null` and
  `.github/workflows/desktop.yml` runs `electron-builder --publish never`, both
  deliberately; `electron-updater` is a declared dependency with no call site.
- **ADR 0011** is the decision record behind the choice of R2 for both.

So this module is ahead of its consumers, on purpose. It is the object storage
and the cached hostname those two features will be built on, and it is the piece
worth getting right before there is a download bill.

### R2 delivery needs a custom domain **and** a Cache Rule

This is the part that is easy to get wrong and expensive to leave wrong, so it
is written out rather than assumed.

A bucket's built-in `*.r2.dev` URL **is not cached by Cloudflare**. Serving a
~110 MB CLI binary or a several-hundred-megabyte voice pack from it pays R2
Class B operations and egress on every single download, and no amount of
front-end caching fixes it. Delivery therefore has to go through a custom domain
on a zone you control — `cdn.<zone>`, which `terraform` creates as a proxied
CNAME — with a Cache Rule that actually turns caching on.

Terraform creates the DNS record. Two steps are **not** in this module and must
be done once, in the dashboard or by API:

1. **Connect the bucket to the custom domain.** R2 → the bucket → Settings →
   Custom Domains → add `cdn.<zone>`. This is what makes Cloudflare route the
   proxied hostname to the bucket. It is not declared here because the resource
   that does it (`cloudflare_r2_custom_domain`) also wants the record to already
   exist, and splitting one hostname across two resources that each half-own it
   is worse than one documented step.
2. **Add a Cache Rule for that hostname.** Rules → Cache Rules → match
   `hostname eq "cdn.<zone>"` → *Eligible for cache*, with a long Edge TTL. A
   release artefact is immutable — a published version's bytes never change, and
   a new version gets a new key — so a long TTL is safe and is the entire point.
   Without this rule the custom domain is proxied but not cached, which is the
   same bill as `r2.dev` with extra steps.

Verify with a cold then a warm request:

```sh
curl -sI https://cdn.<zone>/<key> | grep -i cf-cache-status   # expect MISS
curl -sI https://cdn.<zone>/<key> | grep -i cf-cache-status   # expect HIT
```

### The bucket is a new bucket, not a renamed one

The resource here is `cloudflare_r2_bucket.artifacts`, defaulting to
`xplainer-artifacts`. The hosted plane's bucket was `renders` /
`xplainer-renders` and is now declared in `BrewMyTech/xplainer-hosted`.

There is deliberately no `moved` block joining them. Rendered MP4s are per-user
output with a different lifecycle, a different access model and a different
cache policy from immutable, publicly readable release artefacts. Reusing one
bucket would put both behind one Cache Rule, which is how user render output
ends up cached at the edge under a public-read policy.

### Bucket location is left unset on purpose

`cloudflare_r2_bucket.artifacts` sets `account_id` and `name` and nothing else.
`location` is a one-way choice made at bucket creation, and `storage_class`
changes the bill; both are optional and computed, so leaving them out lets
Cloudflare pick and keeps this module from failing an `apply` on a guessed enum
value. Artefacts are served from cache, so a location hint matters much less
here than it did for renders. If you want to set it anyway, check the accepted
values for the pinned provider version first:

```sh
terraform -chdir=infra/terraform providers schema -json \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['provider_schemas']['registry.terraform.io/cloudflare/cloudflare']['resource_schemas']['cloudflare_r2_bucket']['block']['attributes']['location']['description'])"
```

### Provider pin

`versions.tf` pins `cloudflare/cloudflare ~> 5.24`, and the major is
load-bearing: the provider's v4 → v5 rewrite renamed and moved resources, and
this module uses two v5 names — `cloudflare_dns_record` (v4 called it
`cloudflare_record`) and `cloudflare_r2_bucket`. Both were confirmed against the
installed provider's own schema rather than from documentation:

```sh
terraform -chdir=infra/terraform providers schema -json \
  | grep -o 'cloudflare_r2_bucket\|cloudflare_dns_record' | sort -u
```

`~> 5.24` admits 5.x minor and patch upgrades and refuses 6.0, where the next
rename would otherwise land silently. Re-run the command above before widening
it.

The `hetznercloud/hcloud` pin left with the VM, and `.terraform.lock.hcl` no
longer carries its hashes.

### No backend, still

`terraform init -backend=false` is how the checks above run, and a real `apply`
writes local state, which `infra/terraform/.gitignore` keeps out of git.
Choosing a remote backend is a decision for whoever first applies this for real.

---

## Docker Compose — the local speech container

```sh
docker compose -f infra/docker-compose.tts.yml config       # parses, exits 0
docker compose -f infra/docker-compose.tts.yml up --build
```

One service. It builds `services/tts-sidecar` — a pinned upstream
Kokoro-FastAPI image plus a liveness probe (ADR 0006) — and publishes it on
`127.0.0.1:8880`, which is exactly where `packages/tts-client` looks by default
(`DEFAULT_BASE_URL` in `packages/tts-client/src/client.ts`). So a `up` here and
a CLI on the same machine need no configuration to find each other.

The build context is `../services/tts-sidecar`, not `.`, because Compose
resolves a context relative to the compose file and this file lives in `infra/`.

**This is a convenience, not the shipping path.** A user is not expected to have
Docker: `xplainer setup` downloads a per-OS standalone build instead (ADR 0005,
recipes in `services/tts-sidecar/packaging/`). Compose is here for the developer
who already has Docker and wants the pinned image in one command.

There is no committed `.env.example` any more. Every variable in the old one
configured a hosted service; the only survivor was the TTS port, and 8880 is
already the default in this file, in `services/tts-sidecar/Dockerfile` and in
`services/tts-sidecar/src/xplainer_tts_sidecar/config.py`. Both interpolations
here carry inline defaults, so `docker compose config` exits 0 with no `.env`
present at all.

---

## The end-to-end proof image

```sh
pnpm e2e:render:linux
```

`e2e/Dockerfile` is `node:24-bookworm-slim` plus ffmpeg, the Chrome headless
shell's Debian library set and a Liberation font, with this repository installed,
built and its Remotion browser already downloaded. `scripts/e2e/linux.mjs` is what
runs it: it builds the image, creates a user-defined bridge network, starts its
own Kokoro container on it, runs `pnpm e2e:render` inside the image against that
container — which waits for `/v1/audio/voices` to answer before it narrates —
copies the transcript and the MP4 out of a bind-mounted `/artifacts`, and removes
both containers and the network on the way out, on the failure path too.

**It starts its own Kokoro and publishes no host port.** A developer machine very
often already has a Kokoro answering on 8880, and this proof must neither disturb
it nor depend on it, so the render reaches its own by container name over the
private network.

**It is not a Compose service, and it must not become one.** The sequence ends in
a teardown that has to run after a failure, which a Compose file cannot express;
`docker-compose.tts.yml` above stays the one Compose file here. The build context
is the repository root filtered by `e2e/Dockerfile.dockerignore` — BuildKit
prefers a `<dockerfile>.dockerignore` over the context root's, which is what
keeps this proof's ignore rules out of the root of the repository.

The same proof runs on a GitHub runner from `.github/workflows/e2e-linux.yml`,
which is `workflow_dispatch` only: it renders a real video, so it is run when
the proof is wanted rather than on every push.

---

## What used to be here

Relocated to **`BrewMyTech/xplainer-hosted`**, with full history:

- `docker-compose.hosted.yml` — the `api`, `worker`, `media-service` and
  `postgres` services. `tts` stayed, reduced into `docker-compose.tts.yml`.
- `.env.example` — Postgres credentials and the hosted published ports.
- `terraform/` — `hcloud_server.app`, `hcloud_firewall.app`, the
  `hcloud_ssh_keys` data source, the `vm_provider` / `hcloud_token` /
  `server_type` / `location` variables, the `server_ipv4` and `mcp_hostname`
  outputs, and `cloudflare_dns_record.mcp`.

`cloudflare_dns_record.mcp` is worth naming specifically: it was the hostname
both plugin bundles in `packages/skill` shipped as
`https://mcp.xplainer.video/mcp`. Removing the record and leaving the bundles
pointing at it would publish an install that silently does nothing, so the
bundles move to a local transport in the same change.

---

## Related decisions

- ADR 0005 — a CDN and a version/checksum manifest for the first-run downloads
- ADR 0006 — the Kokoro-FastAPI HTTP contract as the TTS interface
- ADR 0011 — Cloudflare R2 for storage and delivery, no AWS
