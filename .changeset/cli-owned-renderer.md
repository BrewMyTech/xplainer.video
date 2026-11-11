---
"@xplainer/cli": minor
---

`explainer_still` and `explainer_render` render with xplainer's own pipeline instead of the
Remotion CLI. The tools, their schemas and the job envelope are unchanged.

A render bundles the video with esbuild-wasm against this package's own React and
`@xplainer/motion` — the workspace's `node_modules` is never read — opens it in the headless shell
`xplainer setup` recorded in `toolchain.json`, captures one PNG per frame over the DevTools
protocol, and pipes every frame into ffmpeg: libx264 at CRF 18, AAC at 96 kb/s, BT.709, `+faststart`.
A still is one captured frame, taken after the page has stepped through every earlier frame, so it
is the frame the render will produce. No browser is downloaded during a render any more; the one `setup`
acquired is the one that draws. The page is served from `127.0.0.1` on a port the render picks,
never opened from `file://`, and a scene's imports must stay inside the workspace, so a scene cannot
draw or embed a file from elsewhere on the machine.

**A render now needs ffmpeg with libx264 on the machine.** It is found through `XPLAINER_FFMPEG`,
then `PATH`, then `/opt/homebrew/bin` and `/usr/local/bin` (a launchd daemon's `PATH` has neither);
`xplainer setup` does not acquire it.

A failed still or render still ends `render_failed`, and its log now ends in one named line:
`BUNDLE_FAILED`, `CHROME_LAUNCH_FAILED`, `READINESS_TIMEOUT`, `PAGE_ERROR`,
`DELAY_RENDER_TIMEOUT`, `IMAGE_BROKEN`, `IMAGE_TIMEOUT`, `NOT_SUPPORTED_IN_V1`,
`FFMPEG_NOT_FOUND`, `FFMPEG_NO_LIBX264`, `ENCODE_FAILED`, `FRAME_OUT_OF_RANGE`,
`TOOLCHAIN_MISSING` or `RENDER_CANCELLED`. A render prints a progress line every 15 frames —
`{"event":"progress","frame":n,"of":N,"captureFps":x}` — and a final `{"event":"done",…}`.

A scene that imports `remotion`, `@remotion/media` or `@remotion/captions` still renders for one
release: those names are aliased to `@xplainer/motion`, and the job log names each file that used
one and what to import instead.

Remotion is no longer a devDependency of this package.
