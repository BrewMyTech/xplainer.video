---
"@xplainer/cli": minor
---

**`xplainer setup` now acquires ffmpeg**, between the browser and speech. It downloads the FFmpeg
9.0.2 build the manifest names for this platform — our own build on macOS, BtbN's FFmpeg-Builds on
Linux and Windows — and before the first request it says who built and published that binary, the
licence it is under, and where its source is. It keeps the `ffmpeg` executable and its licence and
build files, checks the executable against the digest and size the manifest records, writes a
`PROVENANCE.txt` beside it, and asks the binary itself for its version, its `configure` flags and
its licence. A binary whose answers disagree with each other or with the manifest — a different
digest, a GPL build without `--enable-gpl`, a libavcodec older than 60, no `libx264`, an
experimental `aac` — is refused with exit `3`, and nothing is kept. A second run checks the kept
files and asks the binary again instead of downloading it.

`setup --ffmpeg-path <file>` records an ffmpeg you name instead: the same questions are asked of it,
its digest is recorded rather than expected, and the marker says it was named rather than acquired.
`setup --skip-ffmpeg` leaves ffmpeg out of the run; the two together are a usage error, exit `1`. On
a platform the manifest has no FFmpeg for, `setup` says so, skips it and still exits `0`.
