---
"@xplainer/cli": minor
---

Crossing from a daemon installed before `toolchain.json` format 2 to this release is a reinstall,
and nothing does it by accident. `xplainer setup` refuses with exit `3` while the installed daemon's
runtime reads format 1, and `xplainer update` refuses the same way before it runs anything — no
registry check, no `setup`, no `connect` — so a format-2 marker never lands under a daemon that
would read it as a missing toolchain. Both print the three commands that do the reinstall, and run
none of them:

    xplainer daemon uninstall
    xplainer setup
    xplainer daemon install

`xplainer update --check` reports the same fact as a `daemon:` line and exits `0`. A `daemon.json`
whose recorded runtime cannot be read counts as a daemon from before the cut, and the refusal says
so; a `daemon.json` that cannot be read at all stops both commands with exit `11`.

`daemon update` refuses, exit `3`, having staged and drained nothing, when the installed and
incoming runtimes read different marker formats, in either direction. Within one format it no longer
re-hashes the render workspace against both runtimes; it refuses instead when `toolchain.json` does
not satisfy what the incoming runtime declares it needs — an `ffmpeg` recorded, present, the size
`setup` recorded and at or above its libavcodec floor — and names `xplainer setup`. A payload
`xplainer runtime build` assembles now records `toolchain: { format, ffmpeg_min_libavcodec }` in its
manifest, which moves to `manifest_version` 2; a payload without the block is read as format 1.
