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
