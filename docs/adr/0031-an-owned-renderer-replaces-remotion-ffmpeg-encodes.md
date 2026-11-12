# 0031. An owned renderer replaces Remotion, and a spawned FFmpeg encodes

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
  under OrbStack on the same machine. Every other number comes from this branch — `90b24b9`
  (`@xplainer/motion`), `61aa387` (the renderer) and the commits the throughput table and the
  review notes name — and their tests.

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
  pixels. As built that holds for frames captured front to back — which a render does, and a still
  does by stepping through every earlier frame first — and only a scene that is a pure function of
  the frame is order-independent (the final design review; §What this record does not decide).
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
  and `HEAD`, to any `Host` but its own, and to any path that does not start with a per-server
  128-bit token (`4922e6d`), so another local user cannot read the bundle while a render runs. As first built the page was `file://`, from which a
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
  frame could not see either, and `delayRender` is how a scene says "wait for this". When the pass
  bound runs out with the DOM still changing, the frame is released with one page warning in the job
  log naming it (`4922e6d`). Past the budget
  the frame fails `IMAGE_TIMEOUT`, and an image that will not decode fails `IMAGE_BROKEN`. **CSS
  `background-image` is not waited for** — it is not an `<img>` — and that is a known gap rather than
  a guarantee.
- **CSS animations and transitions are deterministic, and a still is pre-rolled to match the
  render.** Each is seeked to film time minus the film time at which the harness *first saw* it, so
  a video rendered front to back starts every animation at the frame its element mounted. As first
  built, a still at frame 70 of an element mounted at frame 40 had no earlier frame to have seen it
  on and showed it at 0 ms; the final design review's answer is that a still steps the page through
  frames 0 to n − 1 without a screenshot and then captures n (`4922e6d`), so it is the render's
  frame by construction, at about 0.17 ms a frame — 19 ms to reach frame 90, 155 ms to reach 900.
  The page's `Math.random` is mulberry32 from a fixed seed, reset at mount and never per frame, for
  the same reason. `interpolate()` on `useCurrentFrame()` stays the way to animate, because CSS time
  ignores `<Sequence>`, `<Loop>` and `<Freeze>`, and `SKILL.md` says so.
- **The motion math follows documented formulas, not another library's numerics.** `spring` is the
  closed-form damped harmonic oscillator; `Easing` is React Native's set of names with Penner's
  closed forms and CSS `cubic-bezier`; `random(seed)` is FNV-1a into mulberry32. The suite holds
  **at least 585 comparisons** at **1e-9** against independent derivations — RK4 at ≤ 5e-5 s, closed forms,
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
| CSS / Tailwind `animate-*` and `transition-*` | Seeked to film time and deterministic; a still matches the render because it is pre-rolled, but CSS time ignores `<Sequence>`, `<Loop>` and `<Freeze>` (above) |
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
| `4922e6d` (the branch as reviewed: pre-rolled stills, seeded page, token-prefixed server) | animated | 3 | **22.24–22.38** | 21.17–21.28 | 2.90 → 3.76 | **pass** |

The animated MP4 was **1,991,045 bytes with sha256 `c9e7de71…f1f45d` under all four**, so neither
the change that passed the gate nor any of the review's changes moved a pixel; the first run failing is what found it (§The page
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

## Note, 2026-11-12: Phase 2's twelve decisions, and the sentences of this record they amend

Added as a dated note rather than a rewrite: nothing above is edited, and every earlier sentence
this note changes is quoted where it is changed. The decisions are **D1–D12** of the Phase 2 plan,
`.omc/plans/phase2-toolchain.md`, approved by the owner on 2026-11-12 and relayed by the
coordinator; like the documents in this record's header it is not public, and
[`README.md` §Provenance](README.md#provenance) is where its citation resolves. They are written
down here before any of their code lands, as Follow-up 8 asks of the marker's shape. None of D1–D12
is built on this date; each later step of the plan lands one or more of them, with its tests, in a
commit of its own.

### The owner's decisions behind them

- **Q1 — the Remotion tree an older `setup` installed is deleted**, not merely reported (D7).
- **Q2 — Chrome for Testing 157.0.8103.50 on all five render platforms** (D4).
- **Q3 — crossing the cut stops with exit `3` and prints three commands**; nothing reinstalls the
  daemon on the user's behalf (D2).
- **Q4 — `xz-decompress@0.2.3` is accepted as it stands, with a `NOTICE` paragraph for its three
  parts** (D5). Decided on 2026-11-11; the rest on 2026-11-12.
- **The page's network is allowed by default**, which is what Remotion did. This answers the first
  bullet of Follow-up 8. An opt-in deny is not in Phase 2's scope.
- **There is no Developer ID, and our macOS FFmpeg ships ad-hoc signed.**

The last two each amend a sentence of their own, quoted under §The page's network and §Signing
below.

### The macOS FFmpeg is published

Our own static FFmpeg 9.0.2 — the build §The owner's decisions, 2026-11-11 chose for macOS — was
published on 2026-11-12 by the `ffmpeg-macos` workflow, run `43133391215`, on `main` at `73be23c`.
Its manifest fragment is `https://cdn.xplainer.video/toolchain/v1/ffmpeg/9.0.2/ffmpeg-9.0.2.json`,
sha256 `3921809380dee9fb1a79fe419f7cff1b71daeb32d156559e44f72a795348a4b9`, and its two rows are:

```
darwin-arm64  ffmpeg-9.0.2-darwin-arm64.zip   2,012,286 B
              sha256 543246c663ec70903e1abb8823c825f234b7171a78e109820310d7cbbab68071
              member ffmpeg-9.0.2-darwin-arm64/ffmpeg   4,533,080 B
              sha256 0a8b6c740e77005fa9ecc42e1635c2c979428a6e16da9983a27ba1ba0aefd3c6
darwin-x64    ffmpeg-9.0.2-darwin-x64.zip     2,172,480 B
              sha256 3486a8fbf6934c4f494913a79a6d5e274db97c72c268eb9d71a446b2289a8ec5
              member ffmpeg-9.0.2-darwin-x64/ffmpeg     5,300,616 B
              sha256 52e637da7a4fc2e9bb996201563bbda2dca13173ade15d6704affb4bac0bd59c
```

Both archives live under `https://cdn.xplainer.video/toolchain/v1/ffmpeg/9.0.2/`, carry `LICENSE`,
`SOURCE.txt` and `BUILDINFO.txt` beside the binary, declare `GPL-2.0-or-later`, and name
`…/9.0.2/source/README.txt` as their source, because the bucket serves no directory index. These
are the rows D3's manifest carries. The plan drafted macOS **placeholder** rows for the case where
they did not yet exist, and a skip in D12 to keep `setup` working on a Mac while they were; neither
is written, because the case never arises.

### D1 — the marker is `format_version` 2, without `workspace`

`toolchain.json` moves to `format_version: 2`. `chrome` and `speech` stay required; `ffmpeg` is
optional in the schema; `workspace` is no longer written, and stays in the schema as a deprecated
optional property so that a version-1 document still validates. This build reads both versions, and
a version-1 marker is a valid shape describing an incomplete toolchain. What a render needs is
decided by the gate (D12), not by the schema.

**Amends** Follow-up 1's "an optional `ffmpeg` component in `toolchain.json` that keeps
`format_version` 1 (moving the version would make a rolled-back daemon report degraded while it
has everything it needs)". The parenthesis is right about a rollback that stays inside one format,
and it is the reason D2 exists: no rollback is allowed to cross the cut, so no rolled-back daemon
reads a version-2 marker. Follow-up 8's statement that "`workspace` is required by the schema and by
the reader" stops being true when this lands; the review's pick it names — `format_version` 2
without `workspace` — is the one taken.

### D2 — the cut is a reinstall, refused wherever it could be crossed by accident

Payload 1's runtime manifest gains `toolchain: { format: 2, ffmpeg_min_libavcodec: 60 }`, and its
`MANIFEST_VERSION` moves from 1 to 2; a payload built before the cut has no such block and reads as
format 1. Then:

- **(a) `daemon update`** refuses, exit `3`, having staged and drained nothing, when the installed
  and incoming formats differ, in either direction; and, within one format, when the marker does
  not satisfy the incoming runtime's `toolchain` requirements as `checkToolchain` judges them —
  because an update's readiness check is a `200`, and a degraded `/healthz` is a `200` too. The
  toolchain clause takes the place of the two that asked whether the installed workspace satisfies
  both runtimes; the template-pin refusal of ADR 0027's decision A leaves with payload 2.
- **(b) `xplainer update`** reads the installed daemon's format **before** its `setup` step, and
  across the cut stops with exit `3` having run nothing.
- **(c) `xplainer setup`** refuses, exit `3`, while an installed daemon's runtime reads format 1,
  so a version-2 marker never sits under a version-1 daemon.

(b) and (c) print the same three commands — `xplainer daemon uninstall`, `xplainer setup`,
`xplainer daemon install` — and run none of them (Q3). A daemon is detected through `daemon.json`'s
`runtime_dir` and that runtime's manifest; a recorded daemon whose manifest cannot be read is
treated as format 1, and the refusal says so.

**Amends** Follow-up 8's "an update transaction that refuses to roll back across the cut with a
named, one-way message". The refusal moves from the rollback to the update itself, and widens to
the two commands that would otherwise cross the cut first: `xplainer update` runs `setup` before it
touches the daemon, so a refusal at rollback time would fire only after the marker every installed
daemon reads had been rewritten. `e2e/update.mjs`'s "the rolled-back daemon renders" keeps holding,
because no rollback crosses the cut.

### D3 — a second toolchain manifest, at a new path

The manifest `setup` reads moves to `toolchain/v2/manifest.json`, at `format_version` 2. Its
`browser` and `ffmpeg` blocks are selected by a `<platform>-<arch>` key, and every URL in them must
start with a prefix an allowlist **in code** maps to its publisher — Chrome for Testing to Google,
`github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/` to BtbN's FFmpeg-Builds,
`cdn.xplainer.video/toolchain/v1/ffmpeg/` to this project — checked at parse time. `speech` carries
over unchanged. The version-1 document stays on the CDN, untouched, for released CLIs: 0.0.9 reads
`toolchain/v1/manifest.json`, requires `chrome.remotion`, and refuses a document of a newer format.

**Amends** Follow-up 2's "make the Chrome selector ours in name as well as in code". There is no
selector left to rename: the mirror of the pinned Remotion line's URL function in
`setup/manifest.ts` is deleted, and Chrome is selected by platform key, exactly as Follow-up 1
decides for ffmpeg "because there is no upstream selector to mirror". §B1's sentence placing "the
`remotion` provider token, the `remotion.media` URLs, `toolchain.manifest.json`, and the selector in
`setup/manifest.ts` that mirrors the pinned Remotion line's" in Phase 2 is discharged by D3 and D4
together.

### D4 — Chrome for Testing 157.0.8103.50, on all five platforms

The browser pin moves from `chrome-headless-shell` 149.0.7790.0 to Chrome for Testing
157.0.8103.50 on darwin-arm64, darwin-x64, linux-x64, linux-arm64 and win32-x64. Measured on
2026-11-11 and re-hashed from the same downloads on 2026-11-12:

```
linux-arm64  55add1fa634756811fd644094ec226fc7e405be698fb07dbf0634bca689e293a  128,169,705 B
linux64      7bf0d41e424efd1d6281c4162993ab9dc5de92fac213c211614905a71c057d0f  128,166,087 B
mac-arm64    082e3fe8fcfac75aec2ef0949d70e8d2254a99ea465450e287e6c06a3f1863ed  104,775,379 B
mac-x64      886beb07d8237b8acc2b879843a3506b3a56284264b82c806c7d80546e24e0ad  110,442,622 B
win64        9e59432baf484387bdc9cc4a8efca499fb558aeda93e536eb8b859a065ddb884  126,512,350 B
```

each `…/157.0.8103.50/<platform>/chrome-headless-shell-<platform>.zip`, and **each carries
`LICENSE.headless_shell`** — one publisher, one version and an in-archive licence everywhere, and
no artefact hosted by Remotion. 157.0.8103.50 was the Stable channel, revision 1717349, when it was
measured; by 2026-11-12 Stable reads 157.0.8103.78 on the same revision. The pin is the build that
was measured, and following Stable is a re-pin. On linux-x64, measured on 2026-11-11, the binary's
strong glibc references floor at 2.17, the publisher's `deb.deps` says `libc6 >= 2.25`, and every
`NEEDED` soname exists on Amazon Linux 2023, so the Chrome for Testing row is the only one that
platform needs: the row's
`min_glibc` is the publisher's `deb.deps` value, and the `remotion.media` rows go. The provider
token `remotion` becomes `manifest`.

**The fallback**, if the throughput gate fails on 157 (below): Chrome for Testing 149.0.7790.0 for
the four platforms it covers, and Playwright's `chromium-tip-of-tree` r1421 for linux-arm64 — still
with no `remotion.media` URL. Playwright's build is not the primary because it ships no licence or
notices file.

**Amends** Follow-up 2's "**linux-arm64 has no Chrome for Testing build** — the spike's Linux legs
ran on `headless_shell` 149.0.7790.0 from Remotion's linux-arm64 artefact — so the manifest needs a
source for it". That was true of the 149 line and is not true of 157: Chrome for Testing has
published linux-arm64 since 153.0.8001.0 (its own `known-good-versions-with-downloads.json`), so the
source is the same publisher as the other four. ADR 0005's note of 2026-11-11 makes the same claim
("Chrome for Testing publishes none") and is corrected by a note of its own (below).

**And** §The idle-machine throughput gate measured `chrome-headless-shell` 149.0.7790.0. That table
stands as a measurement of 149; the gate is re-run on 157 by the shipped worker, three runs with the
load recorded, and the result is recorded in a later dated note — or D4's fallback is taken. The
bundle's `target: "chrome149"` (§The pipeline as built) is a syntax floor that 157 meets, and D4 does
not move it.

### D5 — xz is decoded by `xz-decompress@0.2.3`

Both Linux FFmpeg pins ship only as `.tar.xz`. `setup/tar.ts` takes a decompressor — gzip or xz —
instead of hard-coding gunzip, and the xz decompressor is `xz-decompress@0.2.3`, pinned exactly:
MIT, no dependencies, no install or postinstall script, XZ Embedded compiled to WebAssembly and
inlined as a `data:` URI, `stream/web` its only `require`, and no network code. **Its tarball and
both upstream repositories carry no licence file.** The grant is `package.json`'s
`"license": "MIT"` and the bundle's own header, which names xzwasm (© Steve Sanderson, MIT), XZ
Embedded by Lasse Collin and Igor Pavlov (public domain) and walloc (© 2020 Igalia, S.L., MIT) —
which is why the owner accepted it with a `NOTICE` paragraph naming all three (Q4). Decoding stops
once every member `setup` keeps has been seen, which is safe because the archive's digest is
verified before a byte of it is decoded.

**Measured** on the real BtbN linux-arm64 pin — `ffmpeg-n9.0.2-39-g7adfbe40dc-linuxarm64-gpl-9.0.tar.xz`,
128,664,064 B, sha256 `6cad88ae5bcec356cfc5d7979a036cc4007128201928a0cf243df3db483276cc`, equal to
the release's own `checksums.sha256` — with Node 24.20.0 on the Apple M5 Pro above, at a one-minute
load average of 5.7–7.1, two runs: `bin/ffmpeg` (131,591,912 B, sha256
`091fe4df4902fedd20f4d5accab14d02947a531d14d789cc7e8f18b0a808e6d1`, the design's `member_sha256`)
is fully decoded at **2.28–2.31 s** with a peak RSS of 122–125 MB; `LICENSE.txt` (35,147 B, sha256
`8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903`) is the 31st of 73 entries and
ends 404.2 MB into the 415.8 MB tar, after `ffplay` and `ffprobe`, so keeping it decodes 97 % of the
archive: **6.80–6.88 s at 143–147 MB**, against 6.85–6.94 s for all of it. The plan's survey of
2026-11-11, at a load of 4.4, measured 2.26 s and 6.7–6.8 s at 143 MB, and called `LICENSE.txt` the
last member, which it is not; the early stop is worth about 1 % on this archive and is kept because
it costs nothing and an archive whose licence comes first would gain the rest.

**Amends** Follow-up 1's "(an in-house LZMA2-with-CRC64 single-stream decoder is recommended,
`xz-decompress@0.2.3` the fallback)". The order is reversed. The dependency is about 52 KB unpacked
against an estimated 600–800 lines of decoder to write and test, and it measured well; the in-house
decoder is now the fallback if the dependency ever has to go.

### D6 — no automatic system ffmpeg

`setup` downloads the pin. A system ffmpeg is used only when someone names it:
`setup --ffmpeg-path <file>` probes it — libavcodec ≥ 60, and `libx264` and a non-experimental
`aac` listed — and records it with provider `path` and its digest as *recorded* rather than
*expected*. Render-time resolution becomes **`XPLAINER_FFMPEG`** (an override) → **`toolchain.json`'s
`ffmpeg.path`** → **`FFMPEG_NOT_FOUND`**, and the `PATH` lookup and the `/opt/homebrew/bin` and
`/usr/local/bin` fallbacks are deleted from `render/encode.ts`. The design's preference for a system
ffmpeg found on `PATH` is not taken, because the pinned build is what makes MP4 bytes reproducible.

**Amends** §B2's "Phase 2 puts the acquired component in front of this order", and Follow-up 1's
"placed in front of B2's order". The acquired component goes behind the override and replaces the
rest of the order rather than standing in front of it. Follow-up 5's "only a system ffmpeg
(`apk add ffmpeg`) would serve it" is served on musl/Alpine in the same way: by name, through
`--ffmpeg-path`, never by search. §Consequences' "Pinning the build is Phase 2, with acquisition"
holds for the download route; a binary named with `--ffmpeg-path` makes MP4 bytes reproducible per
that binary, as any build does.

### D7 — the old Remotion tree is deleted

`setup` removes `<workspace>/node_modules`, `package.json`, `package-lock.json` and
`workspace.manifest.json` **only when** `workspace.manifest.json` records a `remotion_entry` **and**
`package.json`'s name and pins equal the last template's — so an `XPLAINER_VIDEOS_DIR` pointing at a
user's own project is never touched — and only after D2 (c) has passed. It prints what it removed.
It never touches `videos/`, `public/`, `out/`, `requests/` or `locks/`. About 234 MB leaves each
machine that ran an older `setup --workspace` (Q1). Nothing in this record says otherwise: §B1 kept
the payload "until Phase 2", and D2 means no rollback needs it again.

### D8 — the hard condition becomes a gate

`scripts/check-release-ready.mjs`, offline, refuses while (a) `packages/render-core/template/`
still holds a `package.json`, or anything under `template/` names Remotion; (b) any render
platform's `browser` or `ffmpeg` row is not `recorded`; or (d) any entry of a committed
`docs/release-blockers.json` lacks its evidence — a run id or an ADR note. It runs as
`prepublishOnly` on every published member, and `check-publish-contract` gains a self-tested rule
requiring that hook. The one network rule (c) — the published `toolchain/v2/manifest.json` is
byte-identical to the committed copy — runs once, from a root `release:publish` wrapper, before
`pnpm publish -r`, so a CDN failure cannot leave a release half-published. Its rule functions are
self-tested inside `pnpm verify`. This is Follow-up 8's last bullet, built: "so the hard condition
is a gate and not a sentence". With the macOS rows recorded, (b) has nothing to refuse today; what
keeps the gate red is (d) — the Linux 12 fps run and the Windows pipe proof (Follow-ups 6 and 8),
the macOS default-encoder patent decision (§The owner's decisions, 2026-11-11), the re-pin snapshot
of the distribution analysis's Checklist A7, and the upload of the version-2 manifest. The
page-network entry is recorded as decided, with this note as its evidence.

### D9 — the Remotion grep gate is committed

`scripts/check-no-remotion.mjs`, in `pnpm verify` and as its own CI step, runs
`git grep -niP '@remotion/|\bremotion\b'` over tracked files — case-insensitive, so prose is caught
as well as imports — and allows exactly: `LEGACY_IMPORT_ALIASES` in `render/bundle.ts` and its test
(the one-release alias §What an existing video meets records), `SKILL.md`'s migration paragraph, the
`AC-14f` desktop gate and the places that describe it, a pronunciation entry in
`render-core/src/g2p/data/lexicon.txt`, `docs/adr/`, `docs/ROADMAP.md`, the `CHANGELOG.md` files,
`.changeset/` and the checker itself. "No Remotion code" stops being a sentence too.

### D10 — `daemon status` and `/healthz` agree

`daemon status` takes its verdict from `checkToolchain` at stat depth, with a second sentence for
`toolchain_stale`; `xplainer status --json` gains `health.reason` and a `toolchain` object; and both
commands print a `toolchain:` block naming the browser version, ffmpeg's version, licence, publisher
and provider, and the speech route.

**Amends** Follow-up 4's "**A ticket, not a fix**": it is fixed, in Phase 2.

### D11 — payload 1 drops npm

`copyNpm` and `LaunchContract.npm_cli` go, because their only purpose was `setup --workspace`; the
reader treats `npm_cli` as optional under `MANIFEST_VERSION` 2 (D2), one-way like everything else at
the cut. §Consequences' "**Payload 1 grows by pure JavaScript and nothing else**" stays true of
what Phase 2 adds — `xz-decompress` is JavaScript with WebAssembly inside, as `esbuild-wasm`
already is, with no native code, no platform package and no install script — and payload 1 also
loses something for the first time.

### D12 — what needs ffmpeg

A **render** needs an executable `XPLAINER_FFMPEG` or a valid `ffmpeg` in the marker; a **still**
needs neither, because the render worker encodes only for a render. Both the call-time refusal in
`backend.ts` — which keeps the code `WORKSPACE_NOT_INSTALLED`, because the code is published API —
and the worker-factory gate in `daemon/workers.ts` take the job's kind, and `/healthz` reports
`degraded` with `toolchain_missing` while renders are unavailable. This is Follow-up 8's third
bullet, "ffmpeg is judged at the gate, in `assertToolchainReady`, once the marker records it".
§Consequences' "A machine without ffmpeg refuses every render with `FFMPEG_NOT_FOUND` … before a
frame is captured" becomes: refuses every render at the call, before a worker or a browser starts.
The worker's own `FFMPEG_NOT_FOUND` remains for an `XPLAINER_FFMPEG` naming nothing.

### The page's network: allowed by default

**Amends** §Consequences' "so it is the owner's decision and Follow-up 8": the owner has decided,
and the page keeps the network, as it had under Remotion. Everything that Consequence says the page
can reach, it can still reach — a scene can draw `<img src="http://10.…">` into a frame or `fetch` a
CORS-permissive service from wherever the daemon runs, and a remote font or image makes the pixels
depend on someone else's server — and that is now the accepted cost rather than an open question,
in exchange for the web fonts scenes load from CDNs today. A deny-by-default page, or an opt-in to
one, is a later decision.

### Signing

**Amends** §The owner's decisions, 2026-11-11, which lists for our own build "signing once a
Developer ID exists". No Developer ID will exist for Phase 2: the macOS binary ships ad-hoc signed,
which carries no identity, and that closes the distribution analysis's Checklist B5. The patent
decision in the same sentence is not amended and is still open.

### What later steps add to other records

The three records whose 2026-11-11 notes described Phase 2 as still to come each gain a dated note
in the step that changes what they describe, and the index in [`README.md`](README.md) gains each
date as it lands:

- **[ADR 0005](0005-download-on-first-run-chrome-headless-shell-and-tts.md)** — with the marker's
  version 2 (plan step 4): ffmpeg becomes the third acquired component and the workspace stops being
  one; its 2026-11-11 note's "Chrome for Testing publishes none" for linux-arm64 and its
  description of the `PATH` and Homebrew fallbacks stop being true.
- **[ADR 0027](0027-relocatable-runtime-artefact-and-the-supervisor-switch.md)** — with payload 2's
  removal (plan step 6): one payload, and an update transaction with no template-pin refusals.
- **[ADR 0022](0022-open-source-the-published-packages.md)** — with the words and licences (plan
  step 8): the three READMEs, `LICENSE` and `NOTICE` stop carrying a Remotion disclosure, because
  nothing installs Remotion any more.

### What this note does not amend

The licence position under §Decision Outcome; counsel's questions, which stay open; the hard
condition, which D8 turns into a gate without changing what it requires; the patent decision before
the first macOS release; Follow-ups 3, 6 and 7; and Follow-up 5's "win32-arm64 has an FFmpeg pin and
no Chrome row, so it cannot render", which Chrome for Testing 157 does not change.

## Note, 2026-11-12, later the same day: the throughput gate on Chrome 157, and the grep gate as committed

Added as a dated note: nothing above is edited, including the note before this one. It records two
things that note left to be measured or written: the throughput gate re-run on the browser D4 pins,
which D4 says "is recorded in a later dated note — or D4's fallback is taken", and the allowlist
D9's gate was committed with, which is not the list D9 wrote down.

### Chrome for Testing 157 clears the 20 fps gate

**Method — unchanged** from §The idle-machine throughput gate: `apps/cli/spikes/p1-render-fps.mjs`
spawns the built `dist/workers/render.js` as `daemon/workers.ts` does, on the same animated stress
scene — 491 frames, four segments, a 220 Hz tone — and reports per run the loop fps (first progress
line to the `done` line: capture plus encode, the quantity P0-6 bounds), the total fps from spawn to
exit, and the one-minute load average before and after. It exits `1` when any run's loop fps is
under 20. Only where the browser and the encoder come from has changed: the script now takes them
from a `toolchain.json` written by `xplainer setup`, because the `PATH` and Homebrew lookups the
Phase 1 runs relied on are gone (D6). Here that marker came from
`setup --manifest apps/cli/src/setup/toolchain.manifest.json` — the committed format-2 manifest,
never the network one — into a scratch state directory, and records both components with provider
`manifest`; and, as the plan's AC-A12 requires, **`XPLAINER_FFMPEG` was set explicitly** to the same
ffmpeg, which the worker's first line names as its source on every run.

**Toolchain and machine.** Chrome for Testing **157.0.8103.50** (`chrome-headless-shell-mac-arm64`,
archive sha256 `082e3fe8…63ed`; `--version` prints `Google Chrome for Testing 157.0.8103.50`); our
FFmpeg **9.0.2** for darwin-arm64 (archive `543246c6…8071`, binary `0a8b6c74…d3c6`, re-hashed on
disk before the runs, libavcodec 63.1.102, `GPL-2.0-or-later`); the render worker as Phase 2's plan
steps 1–10b leave it; Node 24.20.0. The machine is the one every number in this record comes from:
macOS 27.0 (26A428) on the Apple M5 Pro, 6 performance and 12 efficiency cores, 18 logical CPUs,
64 GB. The command, with `<state>` the scratch state directory:

```
XPLAINER_FFMPEG=<state>/toolchain/ffmpeg-9.0.2-543246c663ec/ffmpeg \
  node apps/cli/spikes/p1-render-fps.mjs --marker <state>/toolchain.json             # three runs
XPLAINER_FFMPEG=<same> node apps/cli/spikes/p1-render-fps.mjs --marker <same> --runs 1   # three times
```

**Result, 2026-11-12, 06:09–06:12 UTC.** The first line is the method above as it was run for
Phase 1, one invocation of three runs; the second is three separate invocations of one run each,
with `uptime` read before every one. **The machine was not idle**: other sessions held the
one-minute load average between 1.51 and 2.60 (five- and fifteen-minute averages 2.22–2.44), and
every number is the script's own output.

| Harness | Scene | Runs | Loop fps | Total fps | Load before → after | Verdict |
|---|---|---|---|---|---|---|
| Phase 2, Chrome for Testing 157.0.8103.50, our FFmpeg 9.0.2 | animated | 3 | **21.53–21.62** | 20.42–20.60 | 1.51 → 1.71 | **pass** |
| the same, three invocations of `--runs 1` | animated | 3 | **21.56–21.58** | 20.54–20.59 | 1.70 → 2.60 | **pass** |

Run by run, loop / total fps and load: 21.62 / 20.42 (1.51 → 2.42), 21.60 / 20.60 (2.42 → 2.11),
21.53 / 20.53 (2.11 → 1.71); then 21.58 / 20.59 (1.70 → 2.09), 21.56 / 20.55 (2.09 → 2.54),
21.56 / 20.54 (2.54 → 2.60). The median of the six is 21.57 fps and the slowest is 21.53. The MP4
was **1,363,076 bytes in all six**; its digest was not taken. It is not the 1,991,045 bytes above,
and is not expected to be: both the browser and the encoder changed, and determinism is promised
per host and per toolchain (§Consequences).

**Verdict: pass. D4 stands and its fallback is not taken.** The release blocker
`chrome-157-throughput` in `docs/release-blockers.json` is closed with this section as its
evidence.

**The margin is thinner than on 149.** The slowest run is 7.6 % over the bar, where the last
Phase 1 row (`4922e6d`, 22.24–22.38 fps) was 11–12 %: about 3 % slower, at a lower load. Two
things moved at once — the browser, 149.0.7790.0 → 157.0.8103.50, and the encoder, Homebrew's
8.1.1 → our static 9.0.2 — and these runs do not separate them. §The idle-machine throughput gate's
"**The margin is 8–12 %, and it is this machine's.**" stands as a measurement of 149 with Homebrew's
encoder; on the pinned toolchain the figure is 7.6–8.1 %, and the rest of that paragraph is
unchanged: no run at a load average under 1, no host with 4 to 8 cores, no Intel Mac, and the Linux
container's 12 fps bar still unrun — that one stays open as its own release blocker,
`linux-12fps-run`.

### The grep gate's allowlist is wider than D9's list

D9 says the gate "allows exactly" a list: `LEGACY_IMPORT_ALIASES` in `render/bundle.ts` and its
test, `SKILL.md`'s migration paragraph, `AC-14f` and the places that describe it, a pronunciation
entry in `lexicon.txt`, `docs/adr/`, `docs/ROADMAP.md`, the changelogs, `.changeset/` and the
checker. **This note amends that sentence**: the list `scripts/check-no-remotion.mjs` was committed
with is wider, and the script — where every entry carries its reason and is held to the lines it was
written for — is the authority. What it admits beyond D9's list, and why:

- **`apps/cli/src/setup/previous-renderer.ts`, `LAST_TEMPLATE`'s pins only** — the lines naming the
  old template's packages at `4.0.495`. D7 deletes an older `setup --workspace`'s tree only when its
  `package.json` names and pins equal the last template's, so the recogniser has to carry them
  verbatim; nothing else in that file is admitted.
- **`lexicon.txt`'s header line** that lists the words CMUdict lacks, beside the pronunciation entry
  D9 named: it is why that entry exists.
- **Three criteria in `docs/acceptance-criteria.md`, quoted as written** — AC-7's quoted text and
  row 7a with its amendment of 2026-11-11, and AC-11's quoted text — each scoped by its heading, so
  a new line in those sections is still a hit. They are retired by the dated notes beneath them
  (7a by the note of 2026-11-12; 11a, the half of AC-11 that named it, relocated with
  media-service), and a criterion quoted as written cannot be reworded. D9 named only that file's
  `AC-14f` lines.
- **`docs/media/xplainer-intro.mp4` and `docs/media/xplainer-intro/source.json`** — the intro video,
  a recording the previous renderer made, which carries the name in its metadata, and its source,
  whose on-screen copy names it. It is kept as it was made; its re-render is booked in
  `docs/ROADMAP.md`, and both entries are deleted with it, which the gate enforces by failing on an
  entry that admits nothing.
- **Two names, exempted rather than allowlisted** — taken out of a line before it is judged, so a
  line that still matches afterwards is a hit like any other: this record's own file name, linked
  wherever the decision is cited, and the checker's, as a file (`check-no-remotion`) and as the
  root script (`check:no-remotion`), wherever either is wired in or described. D9 admitted the
  checker as a file; these admit its name and this record's elsewhere.

One item of D9's list is **narrower** as committed: `render/bundle.ts`'s test has no entry, because
it reads the legacy names out of `LEGACY_IMPORT_ALIASES` rather than spelling them, and the entry
for `bundle.ts` admits only the alias table's lines.
