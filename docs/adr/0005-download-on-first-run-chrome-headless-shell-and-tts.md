# 0005. Chrome Headless Shell and the TTS sidecar are downloaded on first run

- Status: accepted
- Date: 2026-09-05
- Deciders: @rishavanand
- Settled by: interview round 4 (contrarian probe — "what if the local app did NOT bundle
  TTS in the installer?")

## Context and Problem Statement

The local runtime needs two large third-party artefacts that are not application code:

- **Chrome Headless Shell**, which Remotion drives to render frames.
- **A Kokoro-FastAPI-compatible TTS service** — a Python/ONNX stack plus voice models,
  several hundred megabytes before compression.

Both have to reach the user's machine somehow. The obvious answer is to put them in the
installer, and the obvious answer is the expensive one: bundling the TTS stack means
building and shipping it **three times**, once per operating system, in every release, and
it makes the desktop installer an order of magnitude larger than the app inside it. Round 4
put that assumption under a contrarian probe specifically because it was the hardest
packaging problem in the project.

## Decision Drivers

- Installer size and release-pipeline cost: three per-OS TTS builds attached to every
  release is the single largest packaging burden the project would carry.
- The CLI, not the desktop app, is now the local runtime (ADR 0016), and it installs via
  `npx xplainer` on a headless Linux VM where "the installer" does not exist as a concept.
- Model and browser versions change on a different cadence from the application; coupling
  them to the app version forces a full release to ship a model fix.
- CI must not download models or browsers during `pnpm install` — AC-1d greps every
  `package.json` for a `postinstall` that fetches a browser, a model or a binary.

## Considered Options

1. **Bundle both in every installer.** Largest installers, three builds per release,
   offline-capable from the first launch.
2. **Download both on first run**, from a CDN, driven by an explicit `xplainer setup`
   command. Small installers and a small npm package; first launch needs a network.
3. **Require the user to install them** — "install Docker, then `docker run` Kokoro; make
   sure Chrome is on your PATH". Zero packaging work, and a setup experience that loses
   most non-technical users at step one.

## Decision Outcome

Chosen: **option 2 — download on first run**, as an explicit, resumable, user-visible
`xplainer setup` step rather than a silent background fetch.

Option 1 was rejected on the round-4 reasoning: the bundle multiplies by three operating
systems, inflates every release, and buys offline first-launch that almost no user needs
and that the hosted tier does not need at all. Option 3 was rejected because the product's
whole premise is that an agent can drive it — a setup path with three manual prerequisites
is a support burden, not a product.

Making `setup` an explicit command rather than an install hook is deliberate: a
`postinstall` that downloads hundreds of megabytes turns `pnpm install` into a
network-bound operation in CI, on every runner, forever, and it is exactly what AC-1d
forbids.

**In this phase nothing is downloaded.** `xplainer setup` is a registered command that
prints `not implemented in this phase` to stderr and exits 2 (spec §Non-Goals), and
`services/tts-sidecar/packaging/` holds per-OS script stubs plus a README stating plainly
that they are deliberately not run in CI. The stubs refuse to run without an explicit
`--i-know-this-is-a-stub` flag so they cannot be mistaken for working builds. The real
downloads land at roadmap phase 2.

## Consequences

- **A CDN and a version/checksum manifest become infrastructure**, not an afterthought: the
  `TTSModelPackage` entity carries a per-OS artefact, a version and a checksum, and the
  download path has to verify the checksum before extracting.
- **First run needs a network**, and the failure has to be legible: a download that fails
  behind a corporate proxy must say so, not produce a render that fails later with a
  missing-binary error.
- **The hosted plane takes the opposite decision, deliberately.** The `media-service` image
  bakes Chrome Headless Shell in at **build** time via `remotion browser ensure` against a
  pinned local `remotion` CLI, so a container never downloads anything at runtime, and a
  missing browser fails the image build rather than the first render (ADR 0010).
- **Two acquisition paths for one binary** is a real cost: local downloads at first run,
  hosted bakes at build time, and the two can drift on version. They are tied together by
  the same pinned Remotion line that `packages/render-core/template/package.json` fixes.
- **Installers stay small enough to be worth signing and auto-updating** at phase 4, which
  would have been painful with a several-hundred-megabyte payload.

## Note, 2026-09-08: the acquisition step now has three artefacts, and one of them has no route on Windows

Added as a dated note rather than a rewrite. The decision is unchanged and phase 2 built exactly what
it chose: a visible, explicit, resumable `xplainer setup` that acquires large third-party artefacts
on first run instead of bundling them in installers. Three things happened underneath it.

**There are three artefacts now, not two.** This record names Chrome Headless Shell and a
Kokoro-FastAPI-compatible speech service. `setup` also materialises a third: the **render
workspace**, the pinned Remotion tree a render needs, resolved from
`packages/render-core/template/package.json` and its committed `package-lock.json` by an `npm ci`
that runs the package manager shipped inside the runtime artefact. That is an *extension* of this
record rather than a contradiction of it — the workspace is a large third-party tree acquired by the
visible first-run step this record defines, for the same reason the other two are — and it is
decided in [ADR 0027](0027-relocatable-runtime-artefact-and-the-supervisor-switch.md), which also
records why it is a second payload with a lifetime of its own rather than something an installer
carries. This record's "**first run needs a network**" now covers all three.

**The manifest's Chrome digest is an *expected* value captured at manifest-build time, and it is not
a trust anchor.** This record makes "a version/checksum manifest" infrastructure and requires the
download path to "verify the checksum before extracting", and that is what happens. What the check
establishes is worth stating exactly, because it is less than the word *checksum* suggests: the URL
`setup` fetches is the one the pinned Remotion line itself chooses for this platform, and the digest
beside it is the digest of that artefact **as it was when the manifest was built**. So the check
proves consistency with the manifest; it does not prove the bytes are the intended release, and it
cannot, because pinning Remotion pins the *selection* and not the bytes.

**Nothing is published to R2, so one of the three speech routes has nothing to fetch.** As of
2026-09-08 no artefact of ours is published anywhere — see ADR 0027's dated context — which leaves
`setup` with three speech routes and different coverage per platform: `--tts-url` records a
Kokoro-FastAPI server the user already runs, the `docker` route pulls the pinned image by digest, and
the `bundle` route has no published bundle to fetch. On macOS and Linux the first two are real. **On
Windows none of the three is available**: nothing is published, a Windows host need not have a
container engine that can pull a `linux/amd64` image, and `--tts-url` records a server somebody else
runs rather than acquiring one here. So the roadmap's phase-2 speech criterion (`P2-4`) is **met on
macOS and Linux and pending on Windows**, and `setup` says so in a sentence rather than leaving a
reader to notice a hole. What closes it is the phase-4 milestone this record's own consequence
anticipates: native speech bundles per platform, published with the manifest behind a connected
custom domain.

Nothing above is rewritten. Download-on-first-run is still the decision, the installer still stays
small enough to be worth signing, and the two acquisition paths for one browser — local download at
first run, hosted bake at build time — are still tied together by the same pinned Remotion line.

## Note, 2026-09-10: this is now implemented for speech, and it needed no CDN of ours to do it

Added as a dated note rather than a rewrite. The decision is unchanged and is the one that was
carried out. [ADR 0028](0028-in-process-onnx-speech-and-a-g2p-we-own.md) is the record; three things
happened underneath this one.

**Speech is acquired on first run, for real, on every platform but one.** The note above records
`setup` with three speech routes, a `bundle` route with nothing published to fetch, and **no working
route at all on Windows**. There is now a fourth: `xplainer setup` fetches the Kokoro-82M ONNX graph
and one voice pack from the HuggingFace repository they live in, and this platform's ONNX Runtime
from the npm registry — four artefacts, each pinned by digest, each verified before use, each
committed by one `rename`, measured at 39.7 s for all four on darwin-arm64. That is precisely the
resumable, verified, explicitly-invoked first-run acquisition this record chose over bundling, and
it is the first time the speech half of it exists rather than being described. The exception is
`darwin-x64`: ONNX Runtime publishes no binding for it, so an Intel Mac is refused by name and keeps
the two routes it had.

**It needed neither a CDN nor a manifest of ours, which this record's first Consequence assumed it
would.** That consequence books "a CDN and a version/checksum manifest become infrastructure" and a
`TTSModelPackage` entity carrying a per-OS artefact, a version and a checksum. The `onnx` route
carries no per-OS artefact of ours at all: every byte comes from the component's own upstream home,
pinned by revision and digest in reviewed code, so nothing has to be published for it to work and
the R2 bucket, the connected custom domain and its Cache Rule are not on its path. The manifest
remains infrastructure for the **browser**, whose expected digest it carries, and for the `bundle`
route, which still reads it. The prediction was right about the browser and wrong about speech — and
being wrong about speech is what removed a phase-4 milestone rather than adding one.

**This record's own fourth Decision Driver is what rejected the obvious dependency, and it did the
work in a case its stated mechanism does not cover.** The driver reads: *"CI must not download models
or browsers during `pnpm install` — AC-1d greps every `package.json` for a `postinstall` that
fetches a browser, a model or a binary."* `onnxruntime-node` declares exactly such a `postinstall`
— it fetches a 191,730,792-byte CUDA package from `api.nuget.org` on `linux/x64` — and taking it as
a dependency would have run that fetch on **the user's** `npm install` and on every CI runner that
installed this package. The grep AC-1d names reads the `package.json` files *in this repository* and
would not have seen it; what caught it was reading the dependency, which is the driver being applied
rather than the gate firing. AC-1d carries a dated note of its own saying so, and this is the second
time the "explicit command, never an install hook" reasoning in §Decision Outcome has decided
something — the first was `setup` itself.

## Note, 2026-09-11: the manifest is published, and a published build could not take this path without it

Added as a dated note rather than a rewrite. The decision is unchanged; what changed is that one
sentence of the 2026-09-08 note above has expired and the first §Consequence has been discharged
rather than merely booked.

**"Nothing is published to R2" is retired.** That note's third paragraph opens with it, and as of
this date it is false: `https://cdn.xplainer.video/toolchain/v1/manifest.json` answers `200` as
`application/json` with `cf-cache-status: HIT`, and its SHA-256 equals that of the reviewed document
committed at `apps/cli/src/setup/toolchain.manifest.json`, which is the check the two copies are held
to. Only the first clause goes: the same paragraph's account of the **`bundle` route having nothing
to fetch** stands, because all four `speech` entries still read `"status": "unavailable"`. What is
published is the manifest, not the artefacts it would name.

**The first §Consequence is now a fact rather than a prediction, and one of its three pieces is
still a hand-run command.** It books "a CDN and a version/checksum manifest become infrastructure,
not an afterthought". The infrastructure exists and is declared: `infra/terraform` holds
`cloudflare_r2_bucket.artifacts`, `cloudflare_r2_custom_domain.cdn` and
`cloudflare_ruleset.cdn_cache`, so the custom domain and its Cache Rule — which `infra/README.md`
once recorded as steps Terraform deliberately did not manage — are resources it owns. The **upload**
is not: no command in this repository puts a file in that bucket and no workflow is scheduled to, so
a change to the committed manifest that nobody re-publishes leaves `setup` handing users an expected
digest for an artefact the served document no longer describes. That is the same class of drift this
record's §Consequences names for two acquisition paths of one browser, arriving in a different place.

**And this is what made the decision reachable at all from a published build, which is worth stating
because the record could not have anticipated the mechanism.** §Decision Outcome chooses
download-on-first-run driven by an explicit `xplainer setup`; `apps/cli/src/setup/source.ts`
deliberately keeps the committed manifest **out** of the npm tarball, so a user is never silently
served the copy a reviewer happens to have. An installed `xplainer` therefore
has exactly two manifest sources, `--manifest` and the network — and while the network answered
nothing, the browser could be acquired only by someone with a checkout or a hand-supplied file. From
this date `xplainer setup` on a clean state directory with no flags completes at exit `0` and
acquires browser, speech and workspace. Speech is the route that needed none of this, exactly as the
note of 2026-09-10 argues; the browser is the one that did, and the digest it is admitted on is still
an *expected* value captured at manifest-build time rather than a trust anchor, which the note of
2026-09-08 states in full and this note does not weaken.

## Note, 2026-11-11: the browser `setup` acquires is the one that draws, and ffmpeg is the next component

Added as a dated note rather than a rewrite. The decision is unchanged.
[ADR 0031](0031-an-owned-renderer-replaces-remotion-ffmpeg-encodes.md) replaces Remotion with a
renderer of our own, and three things happened underneath this record.

**Chrome is launched by our renderer, from `toolchain.json`'s `chrome.path`, and the "two copies"
defect is gone by construction.** Until this date the browser `setup` acquired was checked for
existence and then never used: Remotion fetched the same `chrome-headless-shell` build again into a
cache of its own. The render worker now starts the recorded headless shell over
`--remote-debugging-pipe` and nothing else, so one acquired artefact serves the still, the render
and every test, and no render downloads anything.

**"The pinned Remotion line" becomes ours in Phase 2, and is already ours in code.** This record's
fourth Consequence ties the two acquisition paths for one browser together by "the same pinned
Remotion line", and the note of 2026-09-08 says the URL `setup` fetches is "the one the pinned
Remotion line itself chooses". Both stay accurate as descriptions of *which* artefact is fetched:
`apps/cli/src/setup/manifest.ts` mirrors that line's URL selector, and the committed manifest's
recorded URLs and expected digests are unchanged. What changed is that `@xplainer/cli` no longer
installs Remotion, so the mirror is now a selector this package owns, frozen at the pinned line, and
checked against the manifest rather than against the function it copied. Renaming it — the
`remotion` provider token, the `remotion.media` URLs — and giving linux-arm64 a source, since Chrome
for Testing publishes none, is Phase 2's Chrome-manifest work.

**ffmpeg is a new acquired component, in Phase 2; today it is found rather than acquired.** The
owner decided on 2026-11-11 how it arrives: on macOS our own CI-built static FFmpeg with its source
bundle beside it on `cdn.xplainer.video`, which would be the first binary of ours that CDN serves;
on Linux and Windows the pinned BtbN build fetched from upstream. That is this record's option 2,
applied to a fourth artefact. Until Phase 2 builds it, the renderer resolves `XPLAINER_FFMPEG`, then
`PATH`, then `/opt/homebrew/bin` and `/usr/local/bin`, and otherwise refuses with
`FFMPEG_NOT_FOUND` naming the install command — which is this record's rejected option 3, "require
the user to install them", for one component. It is tolerable only because ADR 0031's hard
condition holds: nothing is released between that record's Phase 1 and its Phase 2. The render
workspace, this record's third artefact since 2026-09-08, is still acquired by `setup --workspace`
and is no longer read by any render; Phase 2 removes it.

Nothing above is rewritten. Download-on-first-run is still the decision, and it now covers the one
component that a render cannot run without and that this record never named.

## Note, 2026-11-12: `toolchain.json` records ffmpeg as its third component, and the workspace as none

Added as a dated note rather than a rewrite. The decision is unchanged. It records what
[ADR 0031](0031-an-owned-renderer-replaces-remotion-ffmpeg-encodes.md)'s note of 2026-11-12 (D1, D2)
does to the record this decision's acquisition step writes, and corrects two sentences of this
record's note of 2026-11-11.

**The marker is version 2, and its three components are the browser, speech and ffmpeg.**
`toolchain.json` at `format_version` 2 records `chrome`, `speech` and, optionally, `ffmpeg` — a
component with a recorded libavcodec version, its licence and the probe output it was admitted on —
and no `workspace`. The render workspace, this record's third artefact since the note of 2026-09-08,
stops being something the marker records, because no render reads it: `setup --workspace` still
acquires it until Phase 2 removes it, and records nothing when it does. A version-1 marker is still
read, and judged exactly as a version-2 one is: the gate no longer asks about a workspace at all. The provider that acquires ffmpeg, and writes the component
this note describes, is the next step of the same plan — so for now a marker records the component
only where one was already written.

**The note of 2026-11-11 said two things that stop being true.** Its "giving linux-arm64 a source,
since Chrome for Testing publishes none" was true of the 149 line and is not of 157: Chrome for
Testing has published linux-arm64 since 153.0.8001.0, so the browser on all five platform keys now
comes from one publisher (ADR 0031 §Note, 2026-11-12, D4), and the `remotion` provider token and the
`remotion.media` URLs that note expected Phase 2 to rename are gone with the manifest's version 2
(D3). And its description of the renderer resolving `XPLAINER_FFMPEG`, then `PATH`, then
`/opt/homebrew/bin` and `/usr/local/bin` is the order D6 retires: with the ffmpeg provider, an
override or the recorded `ffmpeg.path` is the whole of it, and a system ffmpeg is used only when it
is named to `setup --ffmpeg-path`. That retirement lands with the provider, not with this note.

**Crossing the marker's version is a reinstall, and the first-run step says so.** A daemon installed
from before this date reads version 1, which requires the workspace a version-2 marker no longer
carries. So `xplainer setup` refuses, exit `3`, while such a daemon is installed, and so does
`xplainer update` before it runs anything — each printing `xplainer daemon uninstall`,
`xplainer setup` and `xplainer daemon install` and running none of them — and `daemon update` will
not move a daemon across the cut in either direction (ADR 0031 §Note, 2026-11-12, D2). This record's
option 1, the visible and interruptible step, is the step those refusals point back to.

Nothing above is rewritten. Download-on-first-run is still the decision.
