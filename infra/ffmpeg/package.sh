#!/usr/bin/env bash
# Package one built ffmpeg as the artefact `xplainer setup` downloads.
#
#   infra/ffmpeg/package.sh <arm64|x64> <dist-dir>
#
# Reads XP_ROOT/<arch>/out (build.sh) and <dist-dir>/source.env
# (source-bundle.sh). Writes, into <dist-dir>:
#
#   ffmpeg-<XP_BUILD_VERSION>-darwin-<arch>.zip
#     ffmpeg-<XP_BUILD_VERSION>-darwin-<arch>/ffmpeg
#     ffmpeg-<XP_BUILD_VERSION>-darwin-<arch>/LICENSE        FFmpeg, x264, zlib
#     ffmpeg-<XP_BUILD_VERSION>-darwin-<arch>/SOURCE.txt     where the source is
#     ffmpeg-<XP_BUILD_VERSION>-darwin-<arch>/BUILDINFO.txt  what the binary says
#   ffmpeg-<XP_BUILD_VERSION>-darwin-<arch>.json
#     the manifest row for this platform: DESIGN.md §4.1's shape, plus the
#     `licence`, `extra_members` and `source_url` fields `xplainer setup` reads
#     for a build it fetches from us (the licence class it checks -buildconf
#     against, the files it keeps beside the binary, and where the source is)
#
# The zip is deterministic: fixed entry order, fixed modification times, no
# extra fields. Two builds of the same binary from the same commit on the same
# runner image therefore produce the same zip.
#
# BUILDINFO.txt is the binary's own account of itself, so the binary must run
# here — natively, or under Rosetta 2 for x64 on Apple silicon.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pins.env
. "$here/pins.env"

target="${1:?usage: package.sh <arm64|x64> <dist-dir>}"
dist="${2:?usage: package.sh <arm64|x64> <dist-dir>}"
case "$target" in
  arm64 | x64) ;;
  *)
    echo "package.sh: unknown target '$target'" >&2
    exit 2
    ;;
esac

mkdir -p "$dist"
dist="$(cd "$dist" && pwd)"
root="${XP_ROOT:-/tmp/xplainer-ffmpeg-build}/$target"
out="$root/out"
# shellcheck source=/dev/null
. "$dist/source.env"

platform="darwin-$target"
name="ffmpeg-$XP_BUILD_VERSION-$platform"
binary="$out/ffmpeg"
repository="${GITHUB_REPOSITORY:-BrewMyTech/xplainer.video}"
# An R2 custom domain serves no directory index, so the address that leads to
# the source is the bundle's README, which lists every file in it.
source_url="$XP_CDN_BASE/$XP_BUILD_VERSION/source/README.txt"

if ! "$binary" -hide_banner -version >/dev/null 2>&1; then
  echo "package.sh: $binary does not run on this host ($(uname -m)); BUILDINFO.txt is" \
    "the binary's own output, so package it where it runs (Rosetta 2 for x64)." >&2
  exit 1
fi

sha256_of() {
  shasum -a 256 "$1" | cut -d' ' -f1
}
size_of() {
  stat -f %z "$1"
}

pkg="$root/pkg"
stage="$pkg/$name"
rm -rf "$pkg"
mkdir -p "$stage" "$dist"
install -m 0755 "$binary" "$stage/ffmpeg"
install -m 0644 "$out/LICENSE" "$stage/LICENSE"

# --- SOURCE.txt ----------------------------------------------------------------
{
  cat <<EOF
FFmpeg $FFMPEG_VERSION for macOS ($platform), built by xplainer.video

This ffmpeg program is built from unmodified upstream sources: FFmpeg
$FFMPEG_VERSION, x264 $X264_COMMIT and zlib $ZLIB_VERSION. It is licensed under
the GNU General Public License, version 2 or later; the licence texts are in
LICENSE beside this file. It is a separate program: xplainer runs it, and is
not linked with it.

COMPLETE CORRESPONDING SOURCE, published at the same place as this program:

  $source_url

  MANIFEST sha256 $MANIFEST_SHA256

EOF
  sed 's/^/  /' "$dist/source/MANIFEST"
  cat <<EOF

UPSTREAM INPUTS, each pinned by sha256 in infra/ffmpeg/pins.env:

  FFmpeg $FFMPEG_VERSION
    $FFMPEG_URL
    sha256 $FFMPEG_SHA256
    OpenPGP signature verified against the FFmpeg release key $FFMPEG_KEY_FPR
  x264 $X264_COMMIT
    $X264_URL
    sha256 $X264_SHA256
  zlib $ZLIB_VERSION
    $ZLIB_URL
    sha256 $ZLIB_SHA256
    OpenPGP signature verified against $ZLIB_KEY_FPR

BUILD SCRIPTS AND WORKFLOW (licence: $XP_SCRIPTS_LICENCE):

  $SCRIPTS_ARCHIVE, in the directory above
  https://github.com/$repository/tree/$SCRIPTS_COMMIT/infra/ffmpeg
  commit $SCRIPTS_COMMIT (working tree: $([ "$SCRIPTS_DIRTY" = yes ] && echo modified || echo clean))

CONFIGURE LINES, exactly as run:

EOF
  sed 's/^/  /' "$out/configure.txt"
} >"$stage/SOURCE.txt"

# --- BUILDINFO.txt ---------------------------------------------------------------
section() { # title, then a command whose stdout and stderr are the body
  local title="$1"
  shift
  printf '== %s ==\n' "$title"
  # A command that exits non-zero still has its say: `codesign -dv` exits 1 on
  # the unsigned x64 binary, and that answer is what belongs in the record.
  # codesign names the file by its real path, which under /tmp is /private/tmp.
  { "$@" 2>&1 || printf '(exit %d)\n' "$?"; } |
    sed -e "s#/private$stage/##g" -e "s#$stage/##g" -e 's/[[:space:]]*$//'
  printf '\n'
}
{
  printf 'FFmpeg %s for macOS (%s), built by xplainer.video\n\n' "$FFMPEG_VERSION" "$platform"
  printf 'ffmpeg sha256: %s\n' "$(sha256_of "$stage/ffmpeg")"
  printf 'ffmpeg size:   %s bytes\n\n' "$(size_of "$stage/ffmpeg")"
  printf '== toolchain ==\n'
  cat "$out/toolchain.txt"
  if [ "$target" = x64 ] && [ "$(uname -m)" = arm64 ]; then
    printf 'output below:      executed under Rosetta 2 on arm64\n'
  fi
  printf '\n'
  section "ffmpeg -version" "$stage/ffmpeg" -hide_banner -version
  section "ffmpeg -buildconf" "$stage/ffmpeg" -hide_banner -buildconf
  section "ffmpeg -L" "$stage/ffmpeg" -hide_banner -L
  section "otool -L ffmpeg" otool -L "$stage/ffmpeg"
  section "vtool -show-build ffmpeg" vtool -show-build "$stage/ffmpeg"
  section "lipo -archs ffmpeg" lipo -archs "$stage/ffmpeg"
  section "codesign -dv ffmpeg" codesign -dv "$stage/ffmpeg"
} >"$stage/BUILDINFO.txt"

# --- the zip -----------------------------------------------------------------------
chmod 0644 "$stage/SOURCE.txt" "$stage/BUILDINFO.txt"
TZ=UTC touch -t "$ZIP_MTIME" "$stage" "$stage"/*
zip_path="$dist/$name.zip"
rm -f "$zip_path"
(
  cd "$pkg"
  LC_ALL=C find "$name" -type f | LC_ALL=C sort | TZ=UTC zip -X -D -q -9 "$zip_path" -@
)

zip_sha256="$(sha256_of "$zip_path")"
member_sha256="$(sha256_of "$stage/ffmpeg")"
cat >"$dist/$name.json" <<EOF
{
  "$platform": {
    "status": "recorded",
    "version": "$FFMPEG_VERSION",
    "url": "$XP_CDN_BASE/$XP_BUILD_VERSION/$name.zip",
    "sha256": "$zip_sha256",
    "size": $(size_of "$zip_path"),
    "member": "$name/ffmpeg",
    "member_sha256": "$member_sha256",
    "member_size": $(size_of "$stage/ffmpeg"),
    "licence": "GPL-2.0-or-later",
    "licence_member": "$name/LICENSE",
    "extra_members": ["$name/SOURCE.txt", "$name/BUILDINFO.txt"],
    "source_url": "$source_url"
  }
}
EOF

echo "packaged  $zip_path"
echo "          zip sha256 $zip_sha256, ffmpeg sha256 $member_sha256"
