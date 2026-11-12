---
"@xplainer/cli": minor
---

`xplainer setup` reads a new toolchain manifest, format 2, at
`https://cdn.xplainer.video/toolchain/v2/manifest.json`. The version-1 document stays where it is
for the CLIs already released, which keep reading it.

**The browser is Chrome for Testing 157.0.8103.50 on every platform** — macOS on Apple silicon and
Intel, Linux on x64 and arm64, and Windows on x64 — downloaded from Google's own storage. Linux on
arm64 gets the same publisher's build as the other four, with its licence file in the archive, and
nothing is fetched from `remotion.media` any more. The Linux builds need glibc 2.25 or newer, and
`setup` says so before it downloads anything on a machine that has less, or none.

The manifest now has a row per platform for the browser and, for the first time, for ffmpeg: our
own FFmpeg 9.0.2 build for macOS, and BtbN's FFmpeg-Builds 9.0.2 for Linux and Windows (on arm64
too), and `setup` acquires ffmpeg from them. Every
download URL in either block must come from a publisher the CLI names in its own code — Google's
Chrome for Testing bucket, BtbN's FFmpeg-Builds releases, or this project's CDN — and a manifest
naming anything else is refused when it is read, before anything is fetched.

`toolchain.json` records the browser's provider as `manifest`. A marker an older `setup` wrote
keeps reading as it did.
