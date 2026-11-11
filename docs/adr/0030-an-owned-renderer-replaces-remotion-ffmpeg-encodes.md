# 0030. An owned renderer replaces Remotion, and a spawned FFmpeg encodes

- Status: accepted
- Date: 2026-11-11
- Deciders: @rishavanand
- Settled by: the owner's decisions of 2026-11-11, relayed by the coordinator — the Phase 0 verdict
  **go**, "only use ffmpeg without fallback", and "go ahead with own build" — taken on the Phase 0
  spike report `.omc/research/remotion-replacement-spike.md` (branch `spike-own-renderer`), the
  design `.omc/research/own-renderer-design.md`, the earlier spec
  `.omc/plans/remotion-replacement-spec.md`, and the separate distribution analysis
  `.omc/research/ffmpeg-distribution-analysis.md`. The Phase 1 plan that built it is
  `.omc/plans/own-renderer-phase1.md`, whose boundary decisions **B1** and **B2** the coordinator
  confirmed the same day. None of these documents is public;
  [`README.md` §Provenance](README.md#provenance) is where citations of this kind resolve.
- Amended by dated note, and no body rewritten:
  **[ADR 0005](0005-download-on-first-run-chrome-headless-shell-and-tts.md)** — the browser
  `setup` acquires is now the one that draws, and ffmpeg becomes a fourth acquired component in
  Phase 2; **[ADR 0018](0018-engine-owns-the-composition-shell.md)** — the ownership model is
  unchanged and the engine shell now imports `@xplainer/motion`; and
  **[ADR 0027](0027-relocatable-runtime-artefact-and-the-supervisor-switch.md)** — payload 1 gains
  the renderer's pure-JS dependencies and payload 2 is removed in Phase 2; and
  **[ADR 0022](0022-open-source-the-published-packages.md)** — two of its five Remotion disclosure
  surfaces stop carrying a sentence that is no longer true.
- Builds on: **[ADR 0018](0018-engine-owns-the-composition-shell.md)** — "a scene remains arbitrary
  React" is the constraint every option below was judged against;
  **[ADR 0028](0028-in-process-onnx-speech-and-a-g2p-we-own.md)** — the precedent of acquiring a
  native component at `setup` rather than depending on it, and of owning the layer whose licence was
  the problem; **[ADR 0022](0022-open-source-the-published-packages.md)** — the published packages
  are Apache-2.0, and this record narrows the Remotion disclosure that record required (§Consequences).
- **Every number below is a measurement.** Numbers marked *spike* come from the Phase 0 spike, run on
  a macOS 27.0 Apple M5 Pro (6 performance and 12 efficiency cores) whose one-minute load average
  other sessions kept between 4.7 and 14.4, and in the `infra/e2e` Debian 12 image, linux/arm64,
  under OrbStack on the same machine. Every other number comes from the two commits that carry
  Phase 1 — `90b24b9` (`@xplainer/motion`) and `61aa387` (the renderer) — and their tests.

## Context and Problem Statement

Until this record, `explainer_still` and `explainer_render` spawned the Remotion CLI. A render
needed **payload 2** ([ADR 0027](0027-relocatable-runtime-artefact-and-the-supervisor-switch.md)):
about 120 MB of pinned Remotion tree, platform-specific because `@remotion/compositor-<platform>`
is, materialised by `xplainer setup --workspace` with `npm ci`, and resolved through the runtime's
own interpreter because its CLI begins `#!/usr/bin/env node` (ADR 0027 D1). Remotion bundled the
video, drove a headless Chrome and encoded the MP4, all inside that tree.

Four costs followed from that, and every one is already written down somewhere in this repository:

- **The licence is not ours to settle.** Remotion is free for individuals and companies of up to
  three people; a larger company needs its own licence. ADR 0022 had to require a disclosure on five
  surfaces because of it, and the hosted tier is relocated and **deferred pending a written answer
  from Remotion AG** on whether a rendering service may accept user-authored code
  ([ADR 0023](0023-split-the-repository.md), `docs/ROADMAP.md` Phase 3).
- **Payload 2 has a lifetime of its own, and users pay for it.** ADR 0027's decision A refuses
  every update whose template pins differ — exit `3`, a reinstall, no workspace rollback guarantee —
  and its D2 found the hoisted tree pinning a `zod` Remotion's own version guard rejects.
- **Two copies of one browser.** `setup` acquired a `chrome-headless-shell` and recorded its path in
  `toolchain.json`; the gate checked that path existed and nothing handed it to Remotion, which
  fetched the same build again into a cache of its own (`docs/ROADMAP.md`'s P1-1 amendment of
  2026-09-09, and the `scripts/e2e/render.mjs` docblock until this change).
- **The renderer is a black box at the one place determinism is decided.** The frame clock, the
  readiness of images and fonts, and the encoder's settings all lived inside a dependency.

What must not change is the authoring contract. ADR 0018 rejected a component library and a scene
schema because "a scene remains arbitrary React" is the product; `SKILL.md` teaches an API agents
already write; the eight tools, their schemas, the `explainer_job` envelope, and the
`timings.json` and `captions.json` contracts are published. A replacement has to keep all of them.

## Decision Drivers

- **A scene stays arbitrary React, written against the same API.** A video an agent wrote last week
  must keep rendering for at least one release, unchanged.
- **Frames are deterministic.** The same input on the same machine and toolchain gives the same
  pixels, whatever order the frames are captured in.
- **Throughput clears the Phase 0 bar.** Capture plus encode at **≥ 20 fps on macOS** and
  **≥ 12 fps in the Linux container** for 1080p (P0-6).
- **No Remotion code, and no GPL code in this repository or linked into anything it ships.** The
  original brief's rule was "no GPL/AGPL/SSPL/BUSL code". How the chosen option stands against that
  rule is stated under §Decision Outcome rather than argued away.
- **Nothing downloads at install** (`AC-1d`), including a dependency's own install script on the
  user's machine — the reasoning ADR 0005's 2026-09-10 note records for `onnxruntime-node`.
- **The contracts do not move.** Eight tools, their schemas, the job envelope, the two JSON files.

## Considered Options

1. **Keep Remotion.**
2. **OpenH264 built to WASM, AAC from `@mediabunny/aac-encoder`, muxed by `mediabunny`** — the
   design's original encoder, zero GPL, nothing acquired at `setup`.
3. **In-page WebCodecs** — the page encodes its own frames with `VideoEncoder` and a muxer in Node
   writes the file.
4. **FFmpeg as a separate, spawned process, fed PNG bytes on stdin**, with Chrome headless as the
   frame source and TypeScript in Node driving both.

**Option 1 keeps every cost in §Context.** The licence question stays with a vendor, payload 2 stays
on every machine and in every update, and the second browser stays. Nothing about it fails a
measurement; it fails the drivers that are not about measurements.

**Option 2 was measured in the spike and is the appendix rather than the decision** (*spike*, macOS
arm64). OpenH264 v2.7.0 compiled with Emscripten `-O3 -msimd128` to a 420,067-byte module encoded
explainer-like content at 42.5–58.9 fps on one thread, which passes; the full pipeline (worker
thread, PNG decode in Node, OpenH264, `mediabunny` mux) ran the animated stress scene at 20.2–21.3
fps with `optimizeForSpeed:true`, and the MP4 passed every `ffprobe` clause. Against that: output was
**not reproducible at 2 or 4 threads**, rate control **failed on stress content** (17.3 Mbit/s
against a 5 Mbit/s target, at 23 dB), the profile ceiling is Constrained Baseline, a build of our
own carries no patent grant, and an `@mediabunny/aac-encoder` that is neither finalised nor cancelled
**hangs Node**, because its worker runs an unconditional `setInterval`. It became the appendix when
the owner chose FFmpeg with no fallback.

**Option 3 is closer than the design believed, and still not chosen.** The design recorded in-page
H.264 as unsupported; the spike measured it **supported** on chrome-headless-shell 149
(`avc1.42E028` and `avc1.640028` both encode). VP9 and AV1 encoded the scaffold at 361–398 and
375–389 fps. But AAC has no in-page encoder to pair with them, Opus in MP4 played **6.71 ms late** in
AVFoundation and WebKit because the file had no edit list, VP9 and AV1 in MP4 do not play in
QuickTime or most chat-tool previews by the design's own reading, and AV1 is not cleanly royalty-free (Sisvel sells a
royalty-bearing licence; Dolby sued Snap over AV1 in March 2026). It also routes every frame through
a second encoding path inside the page whose failure modes are Chrome's.

**Option 4 is the fastest and the plainest, and it is GPL.** libx264 `medium` at CRF 18 encodes the
491 captured 1080p frames at **197–655 fps on macOS and 172–278 fps on Linux** (*spike*), and its
output is byte-identical run to run on each build. The encoder is never the bottleneck: capture takes
**96.6–99.6 %** of the loop on both hosts. One process decodes the PNGs, converts to limited-range
BT.709 4:2:0, encodes H.264 and AAC, resamples the narration and muxes. FFmpeg's native `aac` writes
the 1,024-sample priming into the `elst`, and the container's duration lands **0.0003 ms** (macOS)
and **0.33 ms** (Linux) from `timings.json`'s `totalMs`. **Every FFmpeg build that carries libx264 is
GPL**, and every downloadable candidate is GPLv3.

## Decision Outcome

Chosen: **option 4.** The renderer is ours: a clean-room authoring API, a page harness that runs the
video on film time, a zero-dependency DevTools client, and a spawned FFmpeg.

```
daemon/workers.ts  renderWorkerCommand() — still and render, XPLAINER_STATE_DIR in env
  └── workers/render.ts <root> <jobId>            (its own process, in the job's process group)
        1. render/bundle.ts   esbuild-wasm: harness first, then videos/<slug>/index.ts;
                              React, React DOM and @xplainer/motion from the CLI's own install;
                              Tailwind via compile(); static-data.js        BUNDLE_FAILED
        2. render/cdp.ts      toolchain.json's chrome.path over --remote-debugging-pipe
                                                                            CHROME_LAUNCH_FAILED
        3. render/capture.ts  readiness, then per frame: __xplainer.setFrame(n),
                              Page.captureScreenshot PNG              READINESS_TIMEOUT, PAGE_ERROR, …
        4. render/encode.ts   PNG bytes → ffmpeg stdin → .explainer.mp4.partial-<pid> → rename
                                                       FFMPEG_NOT_FOUND, FFMPEG_NO_LIBX264, ENCODE_FAILED
  page side: @xplainer/motion            (packages/motion — a new published member, Apache-2.0)
             @xplainer/motion/harness    window.__xplainer = { metadata(), setFrame(n), readiness() }
```

### The owner's decisions, 2026-11-11

- **Phase 0's verdict is go**, on the FFmpeg design with one change: `optimizeForSpeed:true`
  (below).
- **The encoder is FFmpeg as a separate, spawned process, and there is no fallback encoder.** No
  Remotion, no OpenH264 or other WASM encoder, no Mediabunny encode.
- **Chrome headless stays the frame source, and the renderer is TypeScript in Node.**
- **FFmpeg distribution** ("go ahead with own build"): on **macOS**, our own CI-built static FFmpeg
  9.0.2 with x264, zlib and VideoToolbox, GPLv2+, hosted under
  `cdn.xplainer.video/toolchain/v1/ffmpeg/<version>/` with its source bundle beside it; on **Linux
  and Windows**, the pinned BtbN build (release `autobuild-2026-10-31-12-59`, `n9.0.2-39`) fetched
  from upstream, converging on our own builds later. The analysis behind it holds that a pinned fetch
  from the publisher's URL is not GPL conveying, and sets two checklists: for the fetch, a
  one-sentence notice before the download, `LICENSE.txt` and `PROVENANCE.txt` beside the binary, no
  mirror, and a re-pin at least every 20 months; for our own build, inputs pinned by sha256,
  `LICENSE`, `SOURCE.txt` and `BUILDINFO.txt` in the artefact, the source retained, signing once a
  Developer ID exists, and **a patent decision before the first macOS release** on whether the
  default encoder is x264 or `h264_videotoolbox`.
- **Counsel's questions are open, and this record does not close them.** Whether a `setup` fetch of
  an upstream URL against a pinned digest makes the project a distributor; whether upstream archives
  that ship no source and no written offer affect us when fetched rather than mirrored; what source,
  notice and retention obligations follow if we mirror or build; and who "sells" the AVC product
  when a user's machine fetches the binary, and whether Via LA's AAC programme reaches a CLI that
  drives FFmpeg's `aac`. **Phase 2 implements acquisition**; Phase 1 acquires nothing.

**The licence position, stated without softening.** FFmpeg runs as a separate process and is never
linked, bundled or shipped by anything in this repository; no published tarball contains it and no
source file in this tree is GPL. That is the whole of the claim. **It is not a claim that this route
satisfies the original "no GPL/AGPL/SSPL/BUSL code" rule** — every libx264 build is GPL, and the
route depends on one at run time. Accepting that is the owner's decision, recorded here with the
open questions above, and not a conclusion this record draws.

### The pipeline as built (`61aa387`)

- **Bundle.** `esbuild-wasm` 0.28.2 — the same esbuild compiled to WebAssembly, MIT, no
  dependencies and no install script, where native `esbuild` runs `node install.js` with a
  registry-download fallback — builds a generated entry that imports `@xplainer/motion/harness`
  **before** the video's `index.ts`, so the frozen clock exists before any scene module runs, as one
  classic script (`format: "iife"`, `target: "chrome149"`, `jsx: "automatic"`). React, React DOM
  (19.2.8) and `@xplainer/motion` resolve from the CLI's own install, never from the workspace, so
  there is one React and it is the tested one; any other bare import is refused by name, and every
  import — relative, absolute or a Tailwind `@import` — must resolve inside the workspace root or the
  CLI's own install, or the bundle fails naming the path (`a830be3`). Tailwind is
  `tailwindcss` 4.2.0's own `compile()` over candidates split out of every bundled source file —
  no `@tailwindcss/oxide`, no `lightningcss`, no platform binary. `timings.json` and `captions.json`
  travel in a generated `static-data.js`, and the harness answers the composition's
  `fetch(staticFile(…))` from it. Bundling took **0.47–0.8 s**.
- **The browser.** `render/cdp.ts` speaks CDP as NUL-delimited JSON on fds 3 and 4 with flat
  sessions — no port, no WebSocket, nothing another process can connect to — and launches
  `toolchain.json`'s `chrome.path` with `--headless --remote-debugging-pipe --disable-gpu
  --disable-partial-raster --hide-scrollbars --force-device-scale-factor=1
  --font-render-hinting=none --force-color-profile=srgb --window-size=1920,1080
  --disable-background-timer-throttling --disable-backgrounding-occluded-windows
  --disable-renderer-backgrounding --disable-breakpad --disable-extensions --disable-hang-monitor
  --disable-component-update --no-pings` and a temporary profile. On Linux it adds `--no-sandbox` as
  root, or once after Chrome's own "No usable sandbox" exit, and logs it. Chrome is a plain child in
  the worker's process group, so the daemon's group teardown reaches it.
- **The page is served, not opened from a file (`a830be3`).** The worker serves the bundle at `/` and
  the video's `public/<slug>/` at `/public/` from `127.0.0.1` on a port the OS picks, and answers
  `404` to anything outside either root after decoding, `..` and symlinks, to any method but `GET`
  and `HEAD`, and to any `Host` but its own. As first built the page was `file://`, from which a
  scene's `<img src="file:///…">` could draw any image or font the daemon's user can read into a
  frame; an `http:` origin cannot load `file:` at all.
- **Capture.** Readiness is polled every 100 ms for up to 30 s, with the pending list logged once a
  second after the first ten and `READINESS_TIMEOUT` naming what never arrived. Each frame is
  `setFrame(n)` then `Page.captureScreenshot({format: "png", fromSurface: true,
  captureBeyondViewport: false, optimizeForSpeed: true, clip})`. An uncaught exception, a
  `console.error` or a renderer crash is `PAGE_ERROR` with the frame index.
- **`optimizeForSpeed: true` is the design's one correction.** With the design's `false`, the
  animated scene captured at **9.2–10.7 fps** on macOS and **6.5–8.7 fps** on Linux and failed P0-6;
  with `true` it ran at **21.6–25.8** and **14.8–16.6 fps**. Over 491 animated frames it changed 0
  pixels, maximum channel delta 0, at about twice the bytes on the pipe (*spike*). A video frame is
  opaque, so the alpha damage that makes others avoid it for PNG does not apply.
- **Encode.** `ffmpeg -hide_banner -loglevel error -f image2pipe -c:v png -framerate <fps> -i pipe:0
  -i <public>/<slug>/<timings.audio> -filter_complex
  "[0:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv[v];[1:a]aresample=48000[a]"
  -map [v] -map [a] -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a aac -b:a 96k -ac 1
  -movflags +faststart -f mp4 <out>/.explainer.mp4.partial-<pid>`, renamed onto `explainer.mp4` only
  after exit `0`. The colour tags are set **in the filter graph** because as output options they
  were written as `unknown` with no `colr` box. PNG bytes go to stdin exactly as Chrome produced them,
  and the loop waits for `drain` only when `write()` says the pipe is full: decoding in Node and
  sending raw frames made Node the bottleneck at a third of the speed and wrote the identical file
  (*spike*). A one-time `-encoders` check refuses a build without libx264 before any frame is
  captured.
- **Progress and failure.** A JSON line `{"event":"progress","frame":n,"of":N,"captureFps":x}` every
  15 frames and a final `{"event":"done",…}`; a failure is one `<CODE>: <sentence>` on stderr and a
  non-zero exit, which the runner records as `render_failed`. `SIGTERM` or `SIGINT` kills ffmpeg and
  Chrome, waits for both, and removes the partial, the profile and the bundle directory.
- **Measured in this phase**, on a machine whose one-minute load average was about 8.6: the walking
  skeleton captured and encoded at **44.2–44.8 fps**, and `render.test.ts` — create, narrate, still,
  render, read back with `ffprobe` — took **8.3 s**. Every render test drives a real Chrome and a
  real ffmpeg; nothing is mocked.

### The page runs on film time (`90b24b9`)

`@xplainer/motion/harness` freezes `Date` and `performance.now` to `frame / fps · 1000` ms, runs
`setTimeout` and `setInterval` on film time, and queues `requestAnimationFrame` callbacks. `setFrame(n)`
fires the timers due by then in due order, drains the queued callbacks with the film timestamp and
commits the frame **inside one `flushSync`**, so whatever a timer sets lands in the frame it belongs
to. Then every Web Animation — CSS animations, CSS transitions, `element.animate()` — is paused and
seeked to film time, and the frame settles in passes: render holds, then images (complete and
decoded), then `document.fonts.ready`, then a forced layout and two `MessageChannel` tasks — and
another pass while the last one changed a node, left a font loading, or left a hold or an image
outstanding. Five decisions inside it are worth recording because each was argued or measured:

- **A `delayRender` released from a timer no longer deadlocks** — the spike's correction, fixed rather
  than documented away. `const h = delayRender(); setTimeout(() => continueRender(h), 100)`
  deadlocks on a pure film clock: the timer waits for the next frame and the frame waits for the
  timer. So **while a hold is out, the timers created since the previous frame was released run on
  the wall clock**; film time, `Date` and `performance.now` stay frozen. Moving *all* pending timers
  onto the wall clock was the obvious version and was **measured non-deterministic**: an interval
  created at frame 0 ticked a frame early on the one frame that took a 100 ms hold. The code review
  added the two halves the first build missed (`320fa7b`): animation-frame callbacks requested since
  the release follow the same rule, because `requestAnimationFrame(() => continueRender(h))` was the
  same deadlock; and when the hold releases, every timer the wait created is **rebased** onto the
  frame's film instant, because a timer scheduled from film time plus the wait's wall time landed on
  frame 5, 23 or 50 as an image took 20, 600 or 1500 ms.
- **There is no `LATE_IMAGE` failure, and the reason changed under review.** As first built, every
  `<img>` present when the settle looked had to be complete and decoded, and the record called a
  late image unreachable. The code review reached one: an `<img>` mounted two effect → `setState`
  hops after the commit appeared after the settle had looked, and was first awaited on the next
  frame. The settle now passes again while the last pass changed a node (`320fa7b`), so an image the
  frame's own work mounts is awaited on that frame. What it still cannot see — a `fetch` with no
  `delayRender`, renders that change no node, a chain longer than the pass bound — a check on a later
  frame could not see either, and `delayRender` is how a scene says "wait for this". Past the budget
  the frame fails `IMAGE_TIMEOUT`, and an image that will not decode fails `IMAGE_BROKEN`. **CSS
  `background-image` is not waited for** — it is not an `<img>` — and that is a known gap rather than
  a guarantee.
- **CSS animations and transitions are deterministic now, and a still can disagree with the render.**
  Each is seeked to film time minus the film time at which the harness *first saw* it. A video
  rendered front to back therefore starts every animation at the frame its element mounted; a single
  still at frame 70 of an element mounted at frame 40 has no earlier frame to have seen it on and
  shows it at 0 ms. `interpolate()` on `useCurrentFrame()` stays the way to animate, because it is a
  pure function of the frame, and `SKILL.md` says so.
- **The motion math follows documented formulas, not another library's numerics.** `spring` is the
  closed-form damped harmonic oscillator; `Easing` is React Native's set of names with Penner's
  closed forms and CSS `cubic-bezier`; `random(seed)` is FNV-1a into mulberry32. The suite holds
  **585 comparisons** at **1e-9** against independent derivations — RK4 at ≤ 5e-5 s, closed forms,
  bisection — with a worst error of **7.3e-12**, and `bezier(1,0,0,1)`-like curves at 1e-5 because
  their inverse is ill-conditioned in double precision. **Values are not guaranteed identical to
  Remotion's**, and `random(seed)` returns different, equally deterministic numbers.
  `overshootClamping` rests at the target from its first arrival, in closed form (`320fa7b`); as
  first built it clamped each sample and sank back below the target after arriving.
- **A frame is settled without waiting for a frame (`5af310d`).** As first built, the settle step
  waited one native animation frame before every capture "so the compositor has the committed DOM".
  `Page.captureScreenshot` draws a fresh frame of its own, so the wait bought no pixel and cost about
  10 ms a frame: it is what failed the first run of the throughput gate below, and without it the
  animated scene's MP4 was **byte-identical**. A synchronous layout read now starts the font and
  image loads the new DOM needs. The one thing a frame delivers that a layout read does not is an
  observer notification — `ResizeObserver` and `IntersectionObserver` report in a frame's rendering
  steps — so the harness installs subclasses of both that record their use, and once a page has made
  either, every settle waits one native frame again. The pass's tail grew from one task to two under
  review, because one was measured to release the frame between an effect and the commit its
  `setState` asks for; the gate below measured no cost.

### `--disable-threaded-animation`, decided by measurement

The design disagreed with itself about this flag (its §2.2 sets it, its §2.3 omits it). Measured with
an endless CSS spin plus a transition: **with** the harness seeking Web Animations, 30 of 30 frames
were identical across two Chrome processes both with and without the flag, and the frames were the
same either way; **without** the seeking — the spike's shim — 0 of 30 were identical either way.
The seeking is what makes CSS animation deterministic, the flag adds nothing to it, and it is not set.

### The Phase 1 boundary: B1, B2, and a hard condition

**A tree that contains Phase 1 and not Phase 2 is not a shippable state.** Nothing is released
between the two — the owner's Q6, a hard cut — because `xplainer setup --workspace` still
npm-installs Remotion into the user's workspace until Phase 2 deletes that payload. A release cut
from this tree would install a renderer nothing runs, demand an ffmpeg nothing acquires, and carry
Remotion's licence terms onto machines that no longer use it.

- **B1 — the user-workspace payload stays until Phase 2.** `packages/render-core/template/` keeps its
  `package.json` and `package-lock.json` with their Remotion pins; payload 2 (`assembleWorkspace`,
  `remotionEntryPath`, `runtime verify --workspace`, the runtime manifest's `remotion_entry`),
  `setup/providers/workspace.ts`, `checkWorkspace` in the toolchain gate, the update transaction's
  template-pin refusals, and the D1/D2 proofs in `scripts/e2e/` are untouched. Removing
  `@remotion/cli` from the template changes the workspace manifest a rolled-back daemon reads, which
  is Phase 2's toolchain work. **The renderer reads nothing from the workspace's `node_modules`.**
  `remotion.config.ts` is deleted, because only Remotion read it. The Chrome manifest — the
  `remotion` provider token, the `remotion.media` URLs, `toolchain.manifest.json`, and the selector
  in `setup/manifest.ts` that mirrors the pinned Remotion line's — is also Phase 2.
- **B2 — ffmpeg is found, not acquired, and the toolchain schema does not change.** `toolchain.json`'s
  schema has `additionalProperties: false` and no `ffmpeg`, so recording one is a schema change, and
  Phase 1 makes none; a schema validator would refuse such a marker, while the deployed reader
  (`setup/toolchain.ts`, `readToolchainMarker`) ignores a key it does not know, which is what lets
  Phase 2 add one as optional (Follow-up 1). Phase 1 resolves `XPLAINER_FFMPEG`, then `PATH`, then
  `/opt/homebrew/bin` and `/usr/local/bin` — a launchd daemon's `PATH` has neither — and otherwise
  refuses with `FFMPEG_NOT_FOUND`, naming every place looked and the install command for macOS and
  Debian. `XPLAINER_FFMPEG` naming a file that is not there is a refusal, never a fall-through.
  Phase 2 puts the acquired component in front of this order.

### What an existing video meets, and the one-release alias

The scaffold's engine-owned files take every authoring API from `@xplainer/motion` — React is the
only other package they name — and every name an agent's `Scenes.tsx` reached for in `SKILL.md` has
the same shape there. For one release the bundler
also maps `remotion`, `@remotion/media` and `@remotion/captions` onto `@xplainer/motion` — one table,
`LEGACY_IMPORT_ALIASES` in `render/bundle.ts` — and prints one deprecation line per agent file that
used one, naming the file and the import to use instead. Beyond that:

| Usage | Now |
|---|---|
| `<Video>` / `<OffthreadVideo>` | Throws `NOT_SUPPORTED_IN_V1: video assets …` when rendered; use `<Img>` stills |
| A second `<Audio>` in a scene | Fails `NOT_SUPPORTED_IN_V1`: the encoder muxes only the narration, and it would otherwise vanish from the MP4 |
| Any other `@remotion/*` package (`three`, `lottie`, `transitions`, …) | `BUNDLE_FAILED` naming the specifier |
| A package the old workspace tree happened to provide (`zod`, `@remotion/media-utils`, …) | `BUNDLE_FAILED` naming it: only React, React DOM and `@xplainer/motion` are provided |
| WebGL | Not supported; a 2D `<canvas>` works |
| Remotion Studio, `npm run studio` | Gone; `explainer_still` is the preview |
| `remotion.config.ts` | Gone; Tailwind is compiled for every video |
| CSS / Tailwind `animate-*` and `transition-*` | Seeked to film time, deterministic, but a still can show them at 0 ms (above) |
| `spring`, `Easing`, `random` values | Follow the documented formulas; may differ slightly from Remotion's |

### The idle-machine throughput gate

The spike's macOS margin on busy content was thin — 21.6–25.8 fps live against a 20 fps bar, and
18.3 fps on one capture-only run — and every macOS number was taken under load. So an idle-machine
re-measure is a **Phase 1 gate**, run on the shipped worker rather than on a copy of its loop.

**Method.** `apps/cli/spikes/p1-render-fps.mjs` spawns the built `dist/workers/render.js` exactly as
`daemon/workers.ts` does, on the spike's animated stress scene ported onto `@xplainer/motion` —
springs, eased transforms at fractional pixels, a rotated `<Img>`, gradients, shadows, an SVG dash
and Tailwind utilities, **491 frames** over four segments with boundaries at 148, 178 and 328, a
220 Hz tone standing in for narration. Three runs. Each reports the loop fps — first progress line
to the `done` line, which is capture plus encode, the quantity P0-6 bounds — the total fps from spawn
to exit with Chrome's launch and the bundle included, the host's core count, and the one-minute
load average before and after. The script exits `1` when any run's loop fps is under the bar, 20 fps
on macOS.

**Result, 2026-11-11** — macOS 27.0 on the Apple M5 Pro above (18 logical CPUs), the
`chrome-headless-shell` 149.0.7790.0 the committed manifest pins, Homebrew's ffmpeg 8.1.1. **The
machine was not idle**: other sessions kept the one-minute load average between 1.6 and 7.9 across
the runs, and no quieter window came. Every number is the script's own output.

| Harness | Scene | Runs | Loop fps | Total fps | Load before → after | Verdict |
|---|---|---|---|---|---|---|
| `61aa387` (a native frame per settle) | animated | 3 | **18.19–18.20** | 17.52–17.53 | 1.79 → 2.53 | **fail** |
| `5af310d` (a forced layout per settle) | animated | 3 | **21.59–22.34** | 20.74–21.40 | 3.38 → 7.90 | **pass** |
| `5af310d` | the scaffold with an empty `Scenes.tsx` | 1 | 25.25 | 24.18 | 7.49 → 5.87 | pass |
| `320fa7b` + `a830be3` (settle in passes, page over loopback HTTP) | animated | 3 | **22.17–22.34** | 21.14–21.20 | 1.64 → 2.68 | **pass** |

The animated MP4 was **1,991,045 bytes with sha256 `c9e7de71…f1f45d` under all three**, so neither
the change that passed the gate nor the review's settle and serving changes moved a pixel; the first run failing is what found it (§The page
runs on film time). Steady at 18.2 fps to the hundredth across three runs, at a load near 2, was
the signature of a wait rather than of work.

**The margin is 8–12 %, and it is this machine's.** Not run, and not claimed: a re-measure at a load
average under 1; a host with 4 to 8 cores, which macOS cannot simulate on this one because it has no
CPU pinning; and the Linux container's 12 fps bar, which needs the Docker engine that did not answer
on this date. A slower Mac under the same scene may sit under 20 fps; the encoder preset and the
capture format are the two levers left, and neither is pulled by this record.

## Consequences

- **Determinism is promised per host and per toolchain, and not across hosts.** The same input,
  Chrome build and host give byte-identical PNGs: 491 of 491 across separate processes, on both hosts
  and both scenes (*spike*), and `capture.test.ts` asserts byte-identical frames across two Chrome
  processes whenever the suite has a browser. **Every frame differs between macOS and Linux**, by 0.2–8.7 % of its pixels
  (*spike*); the cause was not isolated, and the largest differences are shadows, SVG strokes and a
  rotated image, not only text, so matching fonts on a Linux host is necessary and not shown to be
  sufficient. `SKILL.md` promises reproducibility on the same machine and nothing more.
- **MP4 bytes are reproducible only per FFmpeg build.** libx264 was byte-identical in every
  configuration on each build, and the live pipeline writes the same bytes as an offline encode of
  the same frames; two builds encoding the same frames differ by **55 bytes, all of them AAC**
  (*spike*). Pinning the build is Phase 2, with acquisition. VideoToolbox is not used: it scores
  39.51 dB average PSNR against libx264 `medium`'s 43.12 dB at matched bitrate, has no CRF, and
  changes one SEI byte on every run.
- **The browser `setup` acquires is the browser that draws.** The worker launches `toolchain.json`'s
  `chrome.path` and nothing else, so the two-copies defect is gone by construction and no render
  downloads anything.
- **ffmpeg is a prerequisite of this tree, and that is acceptable only because of the hard
  condition.** A machine without ffmpeg refuses every render with `FFMPEG_NOT_FOUND`, and one whose
  ffmpeg lacks libx264 with `FFMPEG_NO_LIBX264`, both before a frame is captured. The root
  `README.md` says so. No user meets it, because nothing ships until Phase 2 acquires the binary.
- **Payload 1 grows by pure JavaScript and nothing else.** `@xplainer/cli` depends on
  `@xplainer/motion`, `esbuild-wasm`, `tailwindcss`, `react` and `react-dom`: no native code, no
  platform package, no install script. The assembler's closure copier already follows them, and the
  per-platform 120 MB payload 2 leaves in Phase 2.
- **A new published member, `packages/motion`**, `open-later`, Apache-2.0, with an API report for
  its main entry. It is clean-room: written from public behaviour and documented formulas, with no
  Remotion source opened. Its main entry is side-effect free and imports in Node; its `./harness`
  entry is browser-only and is the renderer's interface, so renaming a `pending` name or a failure
  code is a change on both sides in one commit.
- **Existing videos' motion can shift slightly.** A curve ported from Remotion follows the equation,
  not Remotion's numerics, so an overshoot can differ in its last few hundredths, and `random(seed)`
  scatters differently.
- **ADR 0018's provenance test against `max` loses three of its four files.** The scaffold's
  `index.ts`, `Root.tsx` and `Captions.tsx` now import `@xplainer/motion`, so they cannot be the
  upstream bytes and are change detectors from this date; `types.ts`, which imports nothing, is the
  one provenance fixture left, and the retained upstream `Video.tsx.max` and its divergence test are
  retired. `packages/render-core/test/fixtures/README.md` carries the dated note.
- **The Remotion disclosure ADR 0022 required narrows to the surfaces that stay true.** `SKILL.md`'s
  line and the three plugin and marketplace manifest `description` fields said that rendering uses
  Remotion, which is now false, and they no longer say it. The root `README.md`,
  `apps/cli/README.md` and `packages/render-core/README.md` keep the disclosure, and the `LICENSE`
  and `NOTICE` files keep theirs, because `setup --workspace` still installs Remotion on the user's
  machine; Phase 2 removes them with the payload. Under the hard condition no release carries the
  narrower set while the workspace install exists.
- **The page still reaches the network** (the final design review). Files are closed — the page is
  served from loopback and a scene's imports stay in the workspace — but nothing intercepts a
  request, so a scene can draw `<img src="http://10.…">` into a frame, or `fetch` a CORS-permissive
  service, from wherever the daemon runs; on Linux as root its renderer runs `--no-sandbox`. That
  matters on a remote daemon, whose scene author may not own the machine, and it is a determinism
  hole as well: a remote font or image makes the pixels depend on someone else's server. Closing it
  — deny by default, allow the page's own origin, `data:` and `blob:`, and refuse with a code naming
  the URL — would also refuse a web font loaded from a CDN, which scenes do today, so it is the
  owner's decision and Follow-up 8.
- **Windows `--remote-debugging-pipe` is unproven.** The CDP client has run against a real Chrome on
  macOS and Linux only; whether Chrome on Windows reads the pipe on the descriptors Node hands it has
  not been tried on any host.
- **QuickTime Player, the Safari app and VLC were never run against an output** (*spike*). Seven
  decoders were — AVFoundation, Google Chrome 157, Chrome for Testing 148, chrome-headless-shell 149
  and 148, Playwright Firefox 144 and WebKit in a `WKWebView` — and all decoded every frame with
  frame-accurate seeks.

## What this record does not decide

- **The hosted tier.** It was deferred pending Remotion AG's answer and is relocated
  ([ADR 0023](0023-split-the-repository.md)); whether an owned renderer changes that deferral is a
  decision for the repository it lives in.
- **Counsel's answers**, listed under §Decision Outcome.
- **Dedup, a second capture tab and `HeadlessExperimental.beginFrame`.** All three are booked by the
  design as later phases; a second tab would capture a range that does not start at frame 0, so it
  would need the same pre-roll a still has (§The page runs on film time); BeginFrame's first frame never returned on macOS 148 or 149 under any flag
  set tried, so it would be Linux-only and probe-gated if it is ever built.

## Follow-ups

1. **Phase 2 — FFmpeg acquisition**, per the owner's decision: an optional `ffmpeg` component in
   `toolchain.json` that keeps `format_version` 1 (moving the version would make a rolled-back daemon
   report degraded while it has everything it needs), placed in front of B2's order; manifest rows
   selected by **platform key** with a URL-prefix allowlist checked at parse time, because there is
   no upstream selector to mirror; an **xz decoder**, since both Linux pins ship only as `.tar.xz` and
   `setup/tar.ts` reads gzip (an in-house LZMA2-with-CRC64 single-stream decoder is recommended,
   `xz-decompress@0.2.3` the fallback); the two checklists above; and the pinned build that makes MP4
   bytes reproducible.
2. **Phase 2 — the payload and the Chrome manifest.** Remove payload 2 and everything B1 kept, then the
   Remotion sentences in `README.md`, `LICENSE` and `NOTICE`; make the Chrome selector ours in name as
   well as in code. **linux-arm64 has no Chrome for Testing build** — the spike's Linux legs ran on
   `headless_shell` 149.0.7790.0 from Remotion's linux-arm64 artefact — so the manifest needs a
   source for it.
3. **WebGL is not in v1, and the flag set that enables it is recorded.** `--headless
   --remote-debugging-pipe --hide-scrollbars --window-size=1920,1080 --use-gl=angle
   --use-angle=swiftshader --enable-unsafe-swiftshader --enable-webgl --ignore-gpu-blocklist`, plus
   `--no-sandbox` on Linux as root, gave working WebGL 1 and 2 on SwiftShader on both hosts with an
   exact readback (*spike*). It does **not** set `--disable-gpu`, which the capture set does, so
   WebGL would be a second flag set; WebGPU exposed `navigator.gpu` with a `null` adapter.
4. **A ticket, not a fix: `daemon status` may report `ready` while `/healthz` says
   `toolchain_stale`.** Found by reading the code, not observed running: `daemon status` judges the
   toolchain by file existence alone.
5. **Uncovered platforms.** musl/Alpine has no FFmpeg download candidate, so only a system ffmpeg
   (`apk add ffmpeg`) would serve it — and its Chrome is glibc-linked regardless; win32-arm64 has an
   FFmpeg pin and no Chrome row, so it cannot render.
6. **Windows `--remote-debugging-pipe`** gets a Phase 2 end-to-end proof on a hosted runner.
7. **The alias for `remotion` and `@remotion/*` is removed in the release after cut-over**, and the
   changeset that removes it says so.
8. **Before Phase 2 releases, from the final design review.**
   - **The page's network**, above: deny by default, or a recorded decision not to, with the remote
     web font cost in front of the owner.
   - **The marker across the cut.** `workspace` is required by the schema and by the reader, and
     `checkWorkspace` wants an installed Remotion tree that Phase 2 deletes; after the cut `setup`
     either writes a `workspace` that describes nothing or a rolled-back daemon reads the marker as
     missing, and `e2e/update.mjs`'s "the rolled-back daemon renders" cannot hold across it. Decide
     the shape in a dated note before Phase 2's code: the review's pick is `format_version` 2 without
     `workspace`, and an update transaction that refuses to roll back across the cut with a named,
     one-way message.
   - **ffmpeg is judged at the gate**, in `assertToolchainReady`, once the marker records it — today
     `findFfmpeg()` runs inside the worker, after the job has started, and `XPLAINER_FFMPEG` is an
     environment variable that a Task Scheduler daemon has no way to receive.
   - **The release gate includes the Linux fps run and the Windows pipe proof**, not only the macOS
     gate above, and a check that fails a publish while `template/package.json` still pins
     `remotion`, so the hard condition is a gate and not a sentence.
