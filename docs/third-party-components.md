# Third-party components

xplainer's own packages are Apache-2.0. To render a video it also runs programs and uses data that
other people publish, each under its own licence. None of them is bundled in an xplainer package:
`xplainer setup` downloads them onto the machine it runs on, from the URL and to the sha256 that the
reviewed toolchain manifest names, and says what it is fetching before it fetches it. This page lists
them, says who publishes each, and under what licence.

The patent position of anything here is **your own**. A copyright licence grants no patent rights,
and whether a use you make of an encoder, a codec or the videos it produces needs a patent licence
depends on that use and your jurisdiction; nothing in xplainer's licence, or on this page, answers
that for you.

## FFmpeg

The final MP4 is encoded by **FFmpeg**, which xplainer runs as a separate program: it passes
arguments, writes frames to FFmpeg's standard input and reads the file FFmpeg writes. xplainer does
not link FFmpeg, does not modify it, and does not ship it inside any package.

| Platform | The build `setup` acquires | Published by | Licence |
|---|---|---|---|
| macOS (Apple silicon and Intel) | FFmpeg 9.0.2 with x264 and zlib, built from unmodified upstream sources by [`ffmpeg-macos.yml`](../.github/workflows/ffmpeg-macos.yml) | xplainer.video, at `https://cdn.xplainer.video/toolchain/v1/ffmpeg/9.0.2/` | GNU General Public License, version 2 or later |
| Linux, Windows | The `gpl` build of FFmpeg's 9.0 release branch (`n9.0.2-39`) from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds), fetched from BtbN's own release | BtbN | GNU General Public License, version 3 or later |

**The macOS build is ours, so its source is ours to publish, and it is published beside it**: the
FFmpeg, x264 and zlib release tarballs, the scripts and workflow that built it at the exact commit,
and a `MANIFEST` of their digests, listed at
<https://cdn.xplainer.video/toolchain/v1/ffmpeg/9.0.2/source/README.txt>.
Every macOS download carries `LICENSE` (the licence texts of all three, verbatim), `SOURCE.txt` (that
address, the digests and the exact configure lines) and `BUILDINFO.txt` (what the binary reports
about itself). How the build is made, and the rules it keeps, are in
[`infra/ffmpeg/README.md`](../infra/ffmpeg/README.md).

**The Linux and Windows builds are BtbN's**, downloaded from BtbN's release by your machine, and
BtbN's own `LICENSE.txt` is kept beside the binary. FFmpeg's source is at
<https://ffmpeg.org/download.html>, and the scripts that pin every library in BtbN's build are at
<https://github.com/BtbN/FFmpeg-Builds>.

You can use an FFmpeg you installed yourself instead; `XPLAINER_FFMPEG`, then `PATH`, is where the
renderer looks first, and its licence is whatever its publisher says.

FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.

*Status, 2026-11-11: the macOS build and its workflow exist; `setup`'s acquisition of FFmpeg is being
wired in the same phase. Until a release carries it, rendering uses the ffmpeg you install, as the
[README](../README.md#rendering-needs-ffmpeg) says.*

## The headless browser

Frames are drawn by the **Chrome headless shell** from Google's
[Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/) builds, downloaded from
Google's own storage. It is Chromium, under the Chromium licence and the third-party notices that
ship inside the download as `LICENSE.headless_shell`.

## Speech

With the default on-device speech route, `setup` downloads the **Kokoro-82M** model and a voice pack
from [`onnx-community/Kokoro-82M-v1.0-ONNX-timestamped`](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped)
(Apache-2.0), pinned by revision and digest, and **ONNX Runtime** (`onnxruntime-node`, MIT, Microsoft)
from the npm registry. The other speech routes run software you choose and install yourself, under
its own terms.

## What xplainer itself redistributes

The npm packages do carry two pieces of third-party data, and the root [`NOTICE`](../NOTICE) states
both: the CMU Pronouncing Dictionary (2-clause BSD) and the Kokoro tokenizer (Apache-2.0), in
`@xplainer/render-core`.
