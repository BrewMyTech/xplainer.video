# `infra/` — delivery, and the local speech container

Nothing in here runs a service for anyone. This directory used to describe the
hosted plane — a VM, a firewall, a five-service Compose stack and the `mcp`
hostname in front of it. All of that moved to the private repository
**`BrewMyTech/xplainer-hosted`**, with its history, and none of it is coming
back. What is left is four things that serve the *local* product, kept for
reasons written out below so that none of them is mistaken for a hosted
leftover.

| Path | What it is | Who it serves |
| --- | --- | --- |
| `terraform/` | An R2 bucket for release artefacts, the custom domain that delivers them, and the Cache Rule that makes it worth having. | Auto-update, and the first-run downloads `xplainer setup` performs — the **toolchain manifest is published** and the release artefacts are not, which *The delivery position* below states in full. |
| `docker-compose.tts.yml` | The Kokoro TTS container on `127.0.0.1:8880`, alone. | A developer who has Docker and wants the pinned speech server in one command. |
| `e2e/` | A Debian image that runs the end-to-end render on Linux, and its build-context filter. | Roadmap **P1-1**, whose second half is "on a headless Linux VM". |
| `ffmpeg/` | The pinned build of the static macOS FFmpeg `xplainer setup` downloads, its smoke test, and the scripts that package and publish it with its source to `cdn.xplainer.video/toolchain/v1/ffmpeg/`. [`ffmpeg/README.md`](ffmpeg/README.md) is its account. | `setup` on macOS, through `.github/workflows/ffmpeg-macos.yml`. |

They are independent of each other. None of them is required to build, test or
run the CLI: `pnpm turbo build lint typecheck test` touches all four not at
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
| `cloudflare_r2_custom_domain.cdn` | `cdn.<zone>` → the bucket, proxied, with the DNS record and certificate R2 owns. The hostname an update feed or a first-run download is served from. |
| `cloudflare_ruleset.cdn_cache` | The Cache Rule: artefacts 30 days at the edge, manifests five minutes, errors never (below). |

That is the whole module. Four inputs, two outputs, one bucket, one custom domain, one ruleset of
two rules.

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

**Both halves are declared in this module**, as of 2026-09-11:
`cloudflare_r2_custom_domain.cdn` connects the bucket to `cdn.<zone>`, and
`cloudflare_ruleset.cdn_cache` is the Cache Rule that turns caching on. Without
that second resource the custom domain is proxied but *not* cached, which is the
same bill as `r2.dev` with extra steps.

**This section used to say both were manual, and the reason it gave was wrong.**
It claimed `cloudflare_r2_custom_domain` "wants the record to already exist", so
that declaring it would split one hostname across two half-owning resources.
The opposite is true, and was measured against the real zone on 2026-09-11:
R2 **creates and owns** the DNS record. Connecting the domain *replaced* the
proxied CNAME Terraform had made — a new record id, pointing at `public.r2.dev`
rather than at the S3 endpoint the module used to write — which left Terraform
holding an id that no longer existed and planning to recreate the broken record
beside the working one. So the hand-rolled `cloudflare_dns_record` is gone: the
record was never Terraform's to own, and the S3 endpoint it pointed at answers
anonymous reads with an auth error rather than an object, so it could not have
delivered an artefact even unreplaced.

Two operational notes, both observed on the first real apply:

- **`cloudflare_r2_custom_domain` does not support `terraform import`** (provider
  v5.24.0: *"This resource does not support import"*). A domain connected by
  hand or by API therefore cannot be adopted — delete it and let Terraform
  create it, which is free as long as nothing is being served yet.
- **A newly connected domain answers `403` with `error code: 1014` until
  ownership verification completes**, while `ssl` reaches `active` first. That is
  Cloudflare's cross-account CNAME rejection and it clears on its own; the
  `status` object on the custom domain is what to watch, not the HTTP code.

Verify with a cold then a warm request:

```sh
curl -sI https://cdn.<zone>/<key> | grep -i cf-cache-status   # expect MISS
curl -sI https://cdn.<zone>/<key> | grep -i cf-cache-status   # expect HIT
```

### The cache rule, and publishing a manifest

*Added 2026-11-12.* `cf-cache-status` on `cdn.xplainer.video` reads **`DYNAMIC`** on that date:
the Cache Rule declared below has never been applied, so every download is served from R2 with no
caching at all. Applying it turns caching on for the first time. The ruleset has two rules, in
this order, and a later matching rule's setting wins:

1. **Every key on the hostname**: cacheable, 30 days at the edge, an hour in the browser — and
   **every 4xx and 5xx `no-store`** (`status_code_ttl`, value `-1`). The edge TTL *overrides* the
   origin, so without that clause one request made before an object's upload would cache its `404`
   for 30 days after the object arrived. That is why no session requests an artefact or manifest
   URL before it is published, a rule this clause makes cheaper to break but does not retire.
2. **Any path ending `/manifest.json`** (`toolchain/v1/manifest.json`, `toolchain/v2/manifest.json`):
   five minutes at the edge and in the browser, errors still `no-store`. A manifest is the one key
   that is rewritten in place.

**Applying it is the owner's step.** It needs an API token with `Zone:Cache Rules:Edit` beside the
DNS and R2 permissions `variables.tf` lists:

```sh
cd infra/terraform
TF_VAR_cloudflare_api_token=<token> terraform init
TF_VAR_cloudflare_api_token=<token> terraform plan
TF_VAR_cloudflare_api_token=<token> terraform apply
```

`plan` must show exactly one change, to `cloudflare_ruleset.cdn_cache` — a create if the ruleset
was never applied, as `DYNAMIC` suggests, otherwise an in-place update — and nothing else. If the
create is refused because the zone already has an `http_request_cache_settings` entry-point
ruleset (one made in the dashboard), that ruleset has to be deleted or imported first. Then check
with the cold-and-warm `curl` pair above, once on an artefact (`MISS` then `HIT`) and once on a key
that does not exist (`cf-cache-status` never `HIT`).

**Publishing a manifest** is an upload to its key followed by either a purge of that one URL (a
token with `Zone:Cache Purge`) or a five-minute wait:

```sh
curl -X POST "https://api.cloudflare.com/client/v4/zones/<zone_id>/purge_cache" \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  --data '{"files":["https://cdn.xplainer.video/toolchain/v2/manifest.json"]}'
```

An artefact key is never rewritten and never needs a purge: a changed build is a new version and a
new key.

### The delivery position

*Rewritten 2026-11-12, for the toolchain manifest's format 2 and ADR 0031's Phase 2. The section
it replaces described the format-1 manifest as the one `xplainer setup` reads, a browser on the
previous renderer's URL line, and a first run that installed a render workspace from the npm
registry; none of those describes this tree. The constraint behind all of it is unchanged: a
published build has **exactly two** manifest sources — `--manifest` and the network — because
`source.ts` keeps the committed copy out of the tarball, so a manifest that is not on the CDN is a
`setup` that cannot acquire a browser or an FFmpeg for any user without a checkout.*

**There are two manifests, and only one is published.**

- **Format 1**, at `https://cdn.xplainer.video/toolchain/v1/manifest.json`, is published and stays
  exactly as it is, because the CLIs already released read it: 0.0.9 requires its old browser
  block and refuses a document of a newer format. Its SHA-256 equalled the committed copy's from
  2026-09-11 until 2026-11-12, when format 2 replaced the committed copy; nothing in this tree
  reads or re-publishes it.
- **Format 2**, at `https://cdn.xplainer.video/toolchain/v2/manifest.json` — the address
  `apps/cli/src/setup/manifest.ts` fixes for this build, and the only one it reads over the
  network — is committed at `apps/cli/src/setup/toolchain.manifest.json` and **was uploaded on
  2026-11-12, by the owner, through the R2 dashboard** (owner ask `6c7459ce`). Read back that day,
  it answered `200` as `application/json` with `cache-control: max-age=300`, and its SHA-256
  (`a8c93fd5…f380bd`) equalled the committed copy's at `main` `ed88c42`. No command in this
  repository uploads it. A change to the committed copy is therefore re-uploaded verbatim the same
  way, and its URL purged or its five-minute TTL waited out (§*The cache rule, and publishing a
  manifest* above), before any release of a CLI that reads it. `pnpm release:publish`
  (`scripts/release-publish.mjs`, ADR 0031's note of 2026-11-12, D8) compares the published document
  with the committed copy byte for byte before `pnpm publish -r`, and refuses on any difference, so
  a forgotten re-upload stops a release rather than shipping one. A local `setup` still passes
  `--manifest` naming the committed copy, so a checkout tests the manifest it has rather than the
  one that is published.

**What else is published, and by what.** The macOS FFmpeg 9.0.2 archives and their source bundle,
under `toolchain/v1/ffmpeg/9.0.2/`, uploaded by `.github/workflows/ffmpeg-macos.yml` from `main`
([`ffmpeg/README.md`](ffmpeg/README.md)); a published version key is never rewritten. No other
command or workflow in this repository uploads anything, the manifest included. The
**per-platform speech bundles** remain unpublished and their four manifest entries still say
`"status": "unavailable"`; that is phase 4, and it is genuinely deferred rather than broken,
because the `onnx` route acquires speech from its components' own upstream homes and needs no
manifest at all.

`xplainer setup` says the same thing rather than reporting a DNS or HTTP error: `deliveryPosition()`
in `manifest.ts` is the paragraph its refusal carries, and it names what still works on the machine
that is reading it.

| Platform | Browser | FFmpeg | Speech | Roadmap **P2-4** |
| --- | --- | --- | --- | --- |
| macOS arm64, Linux, Windows | Chrome for Testing 157.0.8103.50, from Google's storage, on the **expected** digest the manifest carries | ours from this CDN on macOS; BtbN's FFmpeg-Builds release on Linux and Windows; each on two expected digests | the `onnx` route: Kokoro-82M, one voice and this platform's ONNX Runtime, each from its own upstream home and none of them from here | met for the browser and speech; FFmpeg on a Linux or Windows runner is still to be proved |
| macOS x64 (Intel) | the same | ours, from this CDN | `onnx` is structurally unavailable — `onnxruntime-node` ships no `darwin/x64` binding — so `docker`'s pinned image, or `--tts-url` | the same |

**The browser's and FFmpeg's bytes never come from a host the manifest picks.** Each row names its
own URL, and `manifest.ts`'s `ARTEFACT_ALLOWLIST` admits a URL only under a prefix it maps to a
publisher — Google's `chrome-for-testing-public` bucket, BtbN's FFmpeg-Builds releases on GitHub,
and `cdn.xplainer.video/toolchain/v1/ffmpeg/` — so what the manifest supplies is the choice of row
and its expected digests, and a new host is a reviewed code change.

**The `bundle` provider is finished code with nothing to fetch.** Its download, resume, checksum
and atomic-install path is proved against the fixture server in
`apps/cli/src/setup/testing/artefact-server.ts`. What is missing is the publication, and **the
milestone that closes it is phase 4**: a native relocatable speech bundle per platform, published
with the manifest to this bucket, behind the custom domain and the Cache Rule declared above.

**First-run rendering needs a network, by the same argument.** The desktop installer carries the
interpreter payload and none of the toolchain: the browser, FFmpeg and speech come to a few
hundred megabytes, which would not survive the size argument in
[ADR 0005](../docs/adr/0005-download-on-first-run-chrome-headless-shell-and-tts.md), so the first
`xplainer setup` downloads them. No package manager runs any more: the render workspace that used
to be installed from the npm registry now holds only a video's sources and outputs, and the one
thing still fetched from the registry is ONNX Runtime's tarball, by version and digest, for the
`onnx` speech route.

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
shell's Debian library set and a Liberation font, with this repository installed
and built. The image's own ffmpeg is the proof's tool — `ffprobe` on the MP4 and
the frame extract — and no longer what renders: a render never looks on `PATH`,
and uses the one `setup` acquires below. `scripts/e2e/linux.mjs` is what
runs it: it builds the image, creates a user-defined bridge network, starts its
own Kokoro container on it, runs `pnpm e2e:render` inside the image against that
container — which waits for `/v1/audio/voices` to answer before it narrates —
copies the transcript and the MP4 out of a bind-mounted `/artifacts`, and removes
both containers and the network on the way out, on the failure path too.

**The container needs the public network too, not only Kokoro.** Since 2026-09-09
`render.mjs` runs a real `xplainer setup` inside it — the toolchain gate refuses
`explainer_still` and `explainer_render` on a machine with no
`<state>/toolchain.json` — so the run fetches a headless shell and an FFmpeg
from the reviewed manifest; no package manager runs, because the workspace is
sources and outputs only. That headless shell is the only browser in the run —
the render worker launches the copy `setup` recorded — so the image carries none
of its own. On arm64 the container is linux-arm64 with bookworm's glibc 2.36,
which meets the `linux-arm64` row's floor of 2.25.

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
