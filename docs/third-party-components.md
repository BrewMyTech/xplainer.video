# Third-party components

xplainer's own packages are Apache-2.0. To render a video it also runs programs and uses data that
other people publish, each under its own licence. None of them is bundled in an xplainer package:
`xplainer setup` downloads them onto the machine it runs on, from the URL and to the sha256 that the
reviewed toolchain manifest — or, for speech, this build's own pins — names, and says what it is
fetching before it fetches it. This page lists them, says who publishes each, and under what
licence.

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
| Linux, Windows | The `gpl` build of FFmpeg's 9.0 release branch (`n9.0.2-39`) from BtbN's [FFmpeg-Builds](https://github.com/FFmpeg-Builds/FFmpeg-Builds), fetched from that project's own release | BtbN | GNU General Public License, version 3 or later |

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
<https://github.com/FFmpeg-Builds/FFmpeg-Builds>, where the project moved from
`github.com/BtbN/FFmpeg-Builds`.

Every FFmpeg `setup` downloads is kept with a `PROVENANCE.txt` it writes itself: the URL, the
archive's and the binary's digests, the publisher, the licence, the version, where the source is,
and the date.

You can use an FFmpeg you installed yourself instead, but only by naming it:
`xplainer setup --ffmpeg-path <file>` records it after the same checks the downloaded one passes,
and `XPLAINER_FFMPEG` overrides the recorded one for any process it is set in. Nothing searches
`PATH` or a Homebrew directory for one. Its licence is whatever its publisher says.

FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.

*Status, 2026-11-12: `setup` acquires FFmpeg as this page describes, and the macOS build is
published. No version published to npm yet carries this renderer: 0.0.11 and earlier render through
the previous one, which brought its own encoder.*

## The headless browser

Frames are drawn by the **Chrome headless shell**, downloaded from Google's own storage.

| Platform | The build `setup` acquires | Published by | Licence |
|---|---|---|---|
| macOS (Apple silicon and Intel), Linux (x64 and arm64), Windows (x64) | `chrome-headless-shell` 157.0.8103.50 from [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/), at `https://storage.googleapis.com/chrome-for-testing-public/` | Google | Chromium's licence and the third-party notices in `LICENSE.headless_shell`, which ships inside every download and stays beside the binary |

The Linux builds need glibc 2.25 or newer, so a musl system such as Alpine has no browser to render
with, and Windows on arm64 has no build at all.

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
