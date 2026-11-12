---
"@xplainer/cli": minor
---

**A render no longer looks for ffmpeg on `PATH` or in the Homebrew directories.** It uses
`XPLAINER_FFMPEG` when that is set, and otherwise the ffmpeg `toolchain.json` records; with neither,
the render fails with `FFMPEG_NOT_FOUND` and says to run `xplainer setup`. `XPLAINER_FFMPEG` must
be an absolute path: a relative one, or a bare `ffmpeg`, is refused rather than looked up.

A still needs no ffmpeg, so the daemon now judges a job by its kind: a still is queued on a machine
with no ffmpeg recorded, or with a recorded one that has since been removed, replaced or found too
old, and a render is refused there with `WORKSPACE_NOT_INSTALLED`, as before — unless
`XPLAINER_FFMPEG` names an executable, which a render then uses whatever the recorded one has become.
A recorded ffmpeg that has lost its execute bit is refused as `toolchain_stale` at the call, rather
than by the render after the browser has started. `/healthz` reports `degraded` with
`toolchain_missing` or `toolchain_stale` whenever a render would be refused.

`xplainer status` and `xplainer daemon status` both print a `toolchain:` block — whether this
machine's `toolchain.json` admits a render, and which browser, ffmpeg and speech route it records —
and, on a line of its own, an `XPLAINER_FFMPEG` set in the shell running the command, which a
supervised daemon never inherits. `daemon status` takes its condition from the daemon's own
`/healthz` whenever the daemon answers, so the two agree, and says so when the toolchain has changed
since `setup` recorded it. With `--url`, `xplainer status` says the block is this machine's.
`xplainer status --json` gains `health.reason` and a `toolchain` object.
