---
"@xplainer/cli": minor
---

**A render no longer looks for ffmpeg on `PATH` or in the Homebrew directories.** It uses
`XPLAINER_FFMPEG` when that is set, and otherwise the ffmpeg `toolchain.json` records; with neither,
the render fails with `FFMPEG_NOT_FOUND` and says to run `xplainer setup`. A still needs no ffmpeg,
so the daemon now judges a job by its kind: a still is queued on a machine with no ffmpeg recorded,
and a render is refused there with `WORKSPACE_NOT_INSTALLED`, as before. `/healthz` reports
`degraded` with `toolchain_missing` whenever a render would be refused.

`xplainer status` and `xplainer daemon status` both print a `toolchain:` block — whether a render
would be admitted, and which browser, ffmpeg and speech route the marker records. `daemon status`
takes its verdict from the same check the daemon applies, and says so when the toolchain has changed
since `setup` recorded it. `xplainer status --json` gains `health.reason` and a `toolchain` object.
