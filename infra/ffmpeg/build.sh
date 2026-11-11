#!/usr/bin/env bash
# Build a static FFmpeg for macOS from the pinned, unmodified upstream sources.
#
#   infra/ffmpeg/build.sh <arm64|x64>
#
# Inputs come from XP_CACHE (default: ~/.cache/xplainer-ffmpeg), filled and
# verified by fetch.sh, which this script runs first. Everything is built under
# XP_ROOT/<arch> (default: /tmp/xplainer-ffmpeg-build/<arch>), which is removed
# and recreated. The results land in XP_ROOT/<arch>/out:
#
#   ffmpeg            the program — statically linked against x264 and zlib;
#                     dynamically only against libSystem and Apple frameworks
#   LICENSE           the licences of FFmpeg, x264 and zlib, verbatim
#   configure.txt     the exact configure and compiler lines of all three
#   toolchain.txt     Xcode, SDK and compiler that built it
#
# THE ROOT IS FIXED ON PURPOSE. FFmpeg records its configure line in the binary
# (`ffmpeg -buildconf`), and that line names the include and library paths of
# the x264 and zlib it was built against. Two builds are byte-comparable only
# if those paths are the same, so the root is a constant rather than a mktemp.
#
# WHAT THE RESULT IS. FFmpeg configured with --enable-gpl --enable-libx264 and
# neither --enable-version3 nor --enable-nonfree: GPL version 2 or later, the
# same class as Debian's build. Nothing is patched. The component list is the
# smallest that runs apps/cli/src/render/encode.ts's argv and the setup probe's
# smoke encode, plus h264_videotoolbox so that making Apple's encoder the macOS
# default stays a one-line change (ADR 0031, "The owner's decisions").
#
# x64 on an arm64 host (and arm64 on an Intel host) is a cross-compile; nasm is
# built from its pinned source for the x86-64 target only, and is a build tool:
# no part of it ends up in the artefact.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pins.env
. "$here/pins.env"

target="${1:?usage: build.sh <arm64|x64>}"
case "$target" in
  arm64) clang_arch=arm64 x264_host=aarch64-apple-darwin ffmpeg_arch=aarch64 ;;
  x64) clang_arch=x86_64 x264_host=x86_64-apple-darwin ffmpeg_arch=x86_64 ;;
  *)
    echo "build.sh: unknown target '$target' (expected arm64 or x64)" >&2
    exit 2
    ;;
esac

case "$(uname -m)" in
  arm64) host=arm64 ;;
  x86_64) host=x64 ;;
  *)
    echo "build.sh: unsupported build host $(uname -m)" >&2
    exit 2
    ;;
esac

# A missing tool otherwise surfaces deep inside a configure log: FFmpeg finds
# x264 only through pkg-config, and fetch.sh checks signatures with gpg.
for tool in clang make pkg-config gpg curl shasum tar; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "build.sh: $tool is not on PATH; it needs Xcode (or its Command Line Tools), gpg and pkg-config" >&2
    exit 1
  fi
done

cache="${XP_CACHE:-$HOME/.cache/xplainer-ffmpeg}"
root="${XP_ROOT:-/tmp/xplainer-ffmpeg-build}/$target"
jobs="$(sysctl -n hw.ncpu)"

"$here/fetch.sh" "$cache"

rm -rf "$root"
mkdir -p "$root/src" "$root/prefix" "$root/tools/bin" "$root/out"
src="$root/src"
prefix="$root/prefix"
out="$root/out"

tar -xJf "$cache/${FFMPEG_URL##*/}" -C "$src"
tar -xjf "$cache/${X264_URL##*/}" -C "$src"
tar -xzf "$cache/${ZLIB_URL##*/}" -C "$src"
ffmpeg_src="$src/ffmpeg-$FFMPEG_VERSION"
x264_src="$src/x264-$X264_COMMIT"
zlib_src="$src/zlib-$ZLIB_VERSION"

# Reproducibility: no archive timestamps, no build paths in debug or __FILE__
# strings, and a fixed clock for anything that reads one.
export ZERO_AR_DATE=1
# The SDK is named rather than left to xcrun's default, which can resolve to the
# Command Line Tools' SDK instead of the selected Xcode's.
SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
export SDKROOT
export MACOSX_DEPLOYMENT_TARGET="$MACOS_MIN"
SOURCE_DATE_EPOCH="$(TZ=UTC date -j -f %Y%m%d%H%M "$ZIP_MTIME" +%s)"
export SOURCE_DATE_EPOCH
# Only the libraries built here are visible to pkg-config, never the host's.
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
export PKG_CONFIG_PATH=""

target_flags="-arch $clang_arch -mmacosx-version-min=$MACOS_MIN -ffile-prefix-map=$root=."
target_ldflags="-arch $clang_arch -mmacosx-version-min=$MACOS_MIN"

record() { # title, then the command words
  local title="$1"
  shift
  {
    printf '%s\n  ' "$title"
    printf '%q ' "$@"
    printf '\n\n'
  } >>"$out/configure.txt"
}

# --- nasm: x86-64 assembly, build host only ---------------------------------
if [ "$target" = x64 ]; then
  tar -xJf "$cache/${NASM_URL##*/}" -C "$src"
  (
    cd "$src/nasm-$NASM_VERSION"
    # nasm runs on the build host, so it is built for the host, unflagged.
    env -u MACOSX_DEPLOYMENT_TARGET ./configure --prefix="$root/tools" >/dev/null
    make -j"$jobs" nasm >/dev/null
    install -m 0755 nasm "$root/tools/bin/nasm"
  )
  export PATH="$root/tools/bin:$PATH"
  echo "nasm      $(nasm -v)"
fi

# --- zlib: static, for FFmpeg's PNG decoder ----------------------------------
(
  cd "$zlib_src"
  zlib_cflags="-O3 -fPIC $target_flags"
  record "zlib $ZLIB_VERSION (CC=clang CFLAGS='$zlib_cflags')" \
    ./configure --static --prefix="$prefix"
  CC=clang CFLAGS="$zlib_cflags" ./configure --static --prefix="$prefix" >/dev/null
  make -j"$jobs" >/dev/null
  make install >/dev/null
)

# --- x264: static library only -----------------------------------------------
x264_args=(
  --prefix="$prefix"
  --host="$x264_host"
  --enable-static
  --disable-cli
  --enable-pic
  --disable-opencl
  --bit-depth=8
  --chroma-format=420
  --disable-avs
  --disable-swscale
  --disable-lavf
  --disable-ffms
  --disable-gpac
  --disable-lsmash
  --extra-cflags="$target_flags"
  --extra-ldflags="$target_ldflags"
)
(
  cd "$x264_src"
  record "x264 $X264_COMMIT (CC=clang)" ./configure "${x264_args[@]}"
  CC=clang ./configure "${x264_args[@]}" >/dev/null
  make -j"$jobs" >/dev/null
  make install-lib-static >/dev/null
)

# --- FFmpeg -------------------------------------------------------------------
ffmpeg_args=(
  --prefix="$prefix"
  --cc=clang
  --arch="$ffmpeg_arch"
  --target-os=darwin
  # Licence class: GPL version 2 or later. No --enable-version3, no nonfree.
  --enable-gpl
  --enable-libx264
  # Start from nothing; nothing is picked up from the host by accident.
  --disable-autodetect
  --disable-everything
  --disable-debug
  --disable-doc
  --disable-network
  --disable-ffplay
  --disable-ffprobe
  --disable-avdevice
  # --disable-autodetect also turns threads off, and the ffmpeg program and
  # h264_videotoolbox both depend on them.
  --enable-pthreads
  --enable-zlib
  --enable-videotoolbox
  --enable-swscale
  --enable-swresample
  "--enable-protocol=file,pipe"
  "--enable-demuxer=image2pipe,image_png_pipe,rawvideo,wav,pcm_s16le,pcm_f32le"
  "--enable-decoder=png,rawvideo,pcm_s16le,pcm_f32le"
  "--enable-encoder=libx264,h264_videotoolbox,aac"
  --enable-muxer=mp4
  "--enable-parser=h264,aac,png"
  "--enable-bsf=aac_adtstoasc,h264_mp4toannexb,extract_extradata"
  "--enable-filter=scale,format,setparams,aresample,aformat,null,anull"
  --pkg-config-flags=--static
  --extra-cflags="$target_flags -I$prefix/include"
  --extra-ldflags="$target_ldflags -L$prefix/lib"
)
if [ "$target" != "$host" ]; then
  ffmpeg_args+=(--enable-cross-compile)
fi
(
  cd "$ffmpeg_src"
  record "FFmpeg $FFMPEG_VERSION" ./configure "${ffmpeg_args[@]}"
  if ! ./configure "${ffmpeg_args[@]}" >"$root/ffmpeg-configure.log" 2>&1; then
    tail -n 40 ffbuild/config.log >&2 || true
    exit 1
  fi
  make -j"$jobs" ffmpeg >/dev/null
)

install -m 0755 "$ffmpeg_src/ffmpeg" "$out/ffmpeg"

# --- the licences, verbatim, in one file ------------------------------------
licence_section() { # title file
  printf '%s\n%s\n%s\n\n' "$(printf '=%.0s' {1..79})" "$1" "$(printf '=%.0s' {1..79})"
  cat "$2"
  printf '\n\n'
}
{
  cat <<EOF
This ffmpeg program is built from three unmodified upstream source trees, and
is distributed under the GNU General Public License, version 2 or later, which
FFmpeg's own licence requires of a build configured with --enable-gpl. The
licence texts of all three follow, verbatim, in this order: FFmpeg's
LICENSE.md, FFmpeg's COPYING.GPLv2, x264's COPYING, and zlib's LICENSE.

The complete corresponding source is described in SOURCE.txt beside this file.


EOF
  licence_section "FFmpeg $FFMPEG_VERSION: LICENSE.md" "$ffmpeg_src/LICENSE.md"
  licence_section "FFmpeg $FFMPEG_VERSION: COPYING.GPLv2" "$ffmpeg_src/COPYING.GPLv2"
  licence_section "x264 $X264_COMMIT: COPYING" "$x264_src/COPYING"
  licence_section "zlib $ZLIB_VERSION: LICENSE" "$zlib_src/LICENSE"
} >"$out/LICENSE"

# --- what built it -------------------------------------------------------------
{
  echo "target:             darwin-$target ($clang_arch)"
  echo "build host:         $(uname -m), macOS $(sw_vers -productVersion) ($(sw_vers -buildVersion))"
  echo "cross-compiled:     $([ "$target" != "$host" ] && echo yes || echo no)"
  echo "runner image:       ${ImageOS:-not a GitHub runner} ${ImageVersion:-}"
  echo "xcode:              $(xcodebuild -version 2>/dev/null | tr '\n' ' ')"
  echo "sdk:                $SDKROOT, $(xcrun --sdk macosx --show-sdk-version) ($(xcrun --sdk macosx --show-sdk-build-version))"
  echo "clang:              $(clang --version | head -n 1)"
  echo "deployment target:  macOS $MACOS_MIN"
  if [ "$target" = x64 ]; then
    echo "nasm (build only):  $NASM_VERSION"
  fi
} >"$out/toolchain.txt"

echo "built     $out/ffmpeg"
shasum -a 256 "$out/ffmpeg"
