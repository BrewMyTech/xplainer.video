# `infra/ffmpeg/` — the macOS FFmpeg we build and publish

`xplainer setup` acquires FFmpeg as a separate program ([ADR 0031](../../docs/adr/0031-an-owned-renderer-replaces-remotion-ffmpeg-encodes.md),
"The owner's decisions, 2026-11-11"). On Linux and Windows it fetches a pinned upstream build; on
**macOS it fetches this one**: a static FFmpeg 9.0.2 with x264 and zlib, built here by
[`.github/workflows/ffmpeg-macos.yml`](../../.github/workflows/ffmpeg-macos.yml) and published with
its complete corresponding source at `https://cdn.xplainer.video/toolchain/v1/ffmpeg/<version>/`.

## The licence boundary

- **No GPL code is in this repository.** FFmpeg, x264 and zlib enter only as their unmodified
  upstream tarballs, downloaded at build time and checked against the sha256 in `pins.env`. Nothing
  is patched.
- **These scripts are published as part of that source, so they need a licence that lets a
  recipient rebuild.** The root `LICENSE` currently makes `infra/` proprietary. Which open licence
  this directory and the workflow carry is the owner's decision, recorded as `XP_SCRIPTS_LICENCE`
  in `pins.env`; until it is made, that value is `UNDECIDED` and `publish.sh` refuses to publish.
- **The binary is GPL version 2 or later.** `--enable-gpl --enable-libx264`, and neither
  `--enable-version3` nor `--enable-nonfree`, which is the class Debian's build has. `smoke.mjs`
  refuses a binary whose `-buildconf` or `-L` says otherwise.
- **It is a separate program.** The CLI spawns it with arguments, writes PNG frames to its stdin and
  reads the file it writes; nothing links `libav*`. That is what keeps the CLI's own licence its own.
- **We distribute it, so we publish its source beside it**: the three tarballs, the scripts and
  workflow at the commit, and a `MANIFEST` of digests, at `<version>/source/`. Every zip carries
  `LICENSE` (the four licence texts, verbatim) and `SOURCE.txt` (where that source is, and the exact
  configure lines).

## Files

| File | What it does |
|---|---|
| `pins.env` | Every input: version, URL and sha256 of FFmpeg, x264, zlib and nasm; the signing-key fingerprints; the Xcode, deployment target and zip timestamp. The review of a bump is the diff of this file |
| `keys/` | The FFmpeg release key and zlib's maintainer key, committed so that a tarball's signature is never checked against a key fetched from the same server |
| `fetch.sh <cache>` | Downloads into a cache, checks every sha256 and both signatures; tries the published source bundle when an upstream URL has gone |
| `build.sh <arm64\|x64>` | nasm (x64 only, build tool), static zlib, static x264, then FFmpeg, under the fixed root `/tmp/xplainer-ffmpeg-build/<arch>`; collects `LICENSE` |
| `smoke.mjs <ffmpeg>` | The acceptance test: the `setup` probe, its smoke encode, and the renderer's exact argv twice (byte-compared), box by box |
| `source-bundle.sh <cache> <dist>` | The `source/` directory and its `MANIFEST` |
| `package.sh <arm64\|x64> <dist>` | The zip (`ffmpeg`, `LICENSE`, `SOURCE.txt`, `BUILDINFO.txt`) and its manifest row |
| `assemble.sh <artefacts> <release>` | The digest comparison across runs, and the release directory with the manifest fragment and `SHA256SUMS` |
| `publish.sh <release>` | Uploads to R2, never overwriting, and reads every object back through the CDN |

## Build it on a Mac

```sh
infra/ffmpeg/build.sh arm64                                    # or x64, a cross-compile on Apple silicon
node infra/ffmpeg/smoke.mjs /tmp/xplainer-ffmpeg-build/arm64/out/ffmpeg
infra/ffmpeg/source-bundle.sh ~/.cache/xplainer-ffmpeg /tmp/ffmpeg-dist
infra/ffmpeg/package.sh arm64 /tmp/ffmpeg-dist
```

Inputs are cached in `XP_CACHE` (default `~/.cache/xplainer-ffmpeg`); a build with a warm cache takes
under a minute on an M-series Mac. A local build names your Xcode in `BUILDINFO.txt`, and its digest
is not the one CI publishes unless your Xcode is the one `pins.env` names. A bundle made from a
working tree with uncommitted changes is named `-dirty-` and `publish.sh` refuses it.

## What it contains, and why

The configure line starts from `--disable-everything --disable-autodetect` and enables exactly what
the renderer's argv (`encodeArgs()` in `apps/cli/src/render/encode.ts`) and `setup`'s probe name:
`file` and `pipe`; the `image2pipe`, `png_pipe`, `rawvideo`, `wav` and raw PCM demuxers; the `png`,
`rawvideo` and PCM decoders; `libx264`, `aac` and `h264_videotoolbox`; the `mp4` muxer; and the
`scale`, `format`, `setparams` and `aresample` filters. `--disable-autodetect` also turns threads
off, and the `ffmpeg` program cannot build without them, hence `--enable-pthreads`.

`h264_videotoolbox` is compiled in although nothing uses it: making Apple's encoder the macOS
default is the patent position counsel may recommend (analysis §5 Q3 to Q5), and keeping it in the
binary makes that a one-line change in the CLI rather than a rebuild.

The result links statically against x264 and zlib, and dynamically only against `libSystem` and the
VideoToolbox, CoreFoundation, CoreMedia, CoreVideo and CoreServices frameworks; it runs on macOS
12.0 and later. Measured on the first local build: 4.5 MB for arm64 and 5.4 MB for x64, about 2 MB
zipped.

## Reproducibility

`build.sh` builds in a fixed root, because FFmpeg records its configure line — include and library
paths included — in the binary. It also sets `ZERO_AR_DATE`, `SOURCE_DATE_EPOCH`,
`-ffile-prefix-map`, an explicit `SDKROOT`, and `--disable-debug`; `package.sh` writes the zip with
fixed timestamps, a fixed entry order and no extra fields. Two builds on one machine produce the same
binary and the same zip. The workflow builds each architecture twice on separate runners and reports
whether they agree; the digest of run 1 is the pin either way.

## Publishing

The workflow's `publish` input uploads from the `toolchain-cdn` environment, whose secrets
`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` and variable `R2_ACCOUNT_ID` belong to an R2 token
with Object Read & Write on the `xplainer-artifacts` bucket only (`R2_BUCKET` overrides the bucket).
Without them the job uploads nothing and says so; the release is then the run's `ffmpeg-release`
artefact.

**Published keys are immutable.** The CDN caches them for 30 days and `setup` pins them by digest,
so `publish.sh` skips an object that already holds the same bytes and stops on one that holds
different bytes. Changing any pin therefore means a new `XP_BUILD_VERSION`: `9.0.2`, then `9.0.2-2`.

After a publish, the manifest fragment `ffmpeg-<version>.json` is what `apps/cli`'s toolchain
manifest takes for its `darwin-arm64` and `darwin-x64` rows.

## Obligations that outlive a build

- **Retention.** Never delete the `source/` of a version that is served, and keep it for three years
  after the binary stops being served.
- **Signing.** arm64 output carries the linker's ad-hoc signature, which is all `setup`'s download
  path needs; x64 is unsigned. There is no Developer ID certificate, so nothing is notarised;
  whether to get one is a future owner decision, shared with the desktop app.
- **Security updates.** An FFmpeg or x264 advisory means a bump: change the pins, bump
  `XP_BUILD_VERSION`, dispatch the workflow, and move the manifest rows to the new digests.
- **Open questions** that are not this directory's to answer: the patent decision before the first
  macOS release (Checklist B item 9), and counsel's questions in the analysis §5.
