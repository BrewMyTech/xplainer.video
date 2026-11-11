#!/usr/bin/env bash
# Assemble the complete corresponding source of a build: the directory that is
# published at <XP_CDN_BASE>/<XP_BUILD_VERSION>/source/, beside the binaries.
#
#   infra/ffmpeg/source-bundle.sh <cache-dir> <dist-dir>
#
# Writes <dist-dir>/source/ holding
#
#   ffmpeg-<v>.tar.xz (+ .asc)   FFmpeg, as released on ffmpeg.org
#   x264-<commit>.tar.bz2        x264, as code.videolan.org archives that commit
#   zlib-<v>.tar.gz (+ .asc)     zlib, as released on GitHub
#   nasm-<v>.tar.xz              the x86-64 assembler; a build tool, carried so
#                                that the bundle rebuilds offline
#   xplainer-ffmpeg-build-*.tar.gz
#                                these scripts, the workflow that ran them, and
#                                the repository's licence files, at the commit
#   README.txt                   how to rebuild from this directory alone
#   MANIFEST                     sha256 of every file above
#
# and <dist-dir>/source.env, which package.sh reads to write SOURCE.txt.
#
# The three upstream tarballs are byte-for-byte what fetch.sh verified; nothing
# is unpacked or repacked. That is the GPL's "equivalent access to copy the
# source code from the same place" (v2 §3), with the "scripts used to control
# compilation and installation" beside it.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pins.env
. "$here/pins.env"

cache="${1:?usage: source-bundle.sh <cache-dir> <dist-dir>}"
dist="${2:?usage: source-bundle.sh <cache-dir> <dist-dir>}"
mkdir -p "$dist"
dist="$(cd "$dist" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
source_dir="$dist/source"

"$here/fetch.sh" "$cache" >/dev/null

rm -rf "$source_dir"
mkdir -p "$source_dir"
for url in "$FFMPEG_URL" "$FFMPEG_ASC_URL" "$X264_URL" "$ZLIB_URL" "$ZLIB_ASC_URL" "$NASM_URL"; do
  cp "$cache/${url##*/}" "$source_dir/"
done

# --- the scripts, at the commit ----------------------------------------------
# What controls the build: this directory, the workflow, and the licence of
# both. Archived from a scratch index built from the working tree, so that a
# local run with uncommitted changes archives what actually ran; such a bundle
# is named -dirty and is never published (publish.sh refuses it).
paths=(infra/ffmpeg .github/workflows/ffmpeg-macos.yml LICENSE LICENSE-APACHE-2.0 NOTICE)
commit="$(git -C "$repo" rev-parse HEAD)"
commit_time="$(git -C "$repo" log -1 --format=%cI HEAD)"
if [ -n "$(git -C "$repo" status --porcelain -- "${paths[@]}")" ]; then
  dirty=yes
else
  dirty=no
fi
index="$(mktemp)"
rm -f "$index"
tree="$(
  cd "$repo"
  GIT_INDEX_FILE="$index" git read-tree --empty
  GIT_INDEX_FILE="$index" git add -- "${paths[@]}"
  GIT_INDEX_FILE="$index" git write-tree
)"
rm -f "$index"
if [ "$dirty" = yes ]; then
  scripts="xplainer-ffmpeg-build-${commit:0:12}-dirty-${tree:0:12}.tar.gz"
else
  scripts="xplainer-ffmpeg-build-${commit:0:12}.tar.gz"
fi
git -C "$repo" archive --format=tar --prefix=xplainer-ffmpeg-build/ --mtime="$commit_time" "$tree" |
  gzip -n -9 >"$source_dir/$scripts"

cat >"$source_dir/README.txt" <<EOF
Complete corresponding source for the ffmpeg programs published in the
directory above this one: FFmpeg $FFMPEG_VERSION, x264 $X264_COMMIT and
zlib $ZLIB_VERSION, all unmodified, built by the scripts in $scripts.

To rebuild on a Mac with Xcode $XCODE_VERSION:

  tar -xzf $scripts
  cd xplainer-ffmpeg-build
  XP_CACHE="\$PWD/.." XP_SOURCE_MIRROR= infra/ffmpeg/build.sh arm64   # or x64

build.sh verifies every tarball in this directory against the sha256 pinned
in infra/ffmpeg/pins.env, and FFmpeg's and zlib's signatures against the keys
in infra/ffmpeg/keys/, before it builds; it needs no network when the files
are here. MANIFEST lists the sha256 of every file in this directory.

Scripts commit: $commit (working tree: $([ "$dirty" = yes ] && echo modified || echo clean))
EOF

(
  cd "$source_dir"
  find . -maxdepth 1 -type f | sed 's#^\./##' | LC_ALL=C sort | while IFS= read -r name; do
    shasum -a 256 "$name"
  done
) >"$dist/MANIFEST.partial"
mv "$dist/MANIFEST.partial" "$source_dir/MANIFEST"
manifest_sha256="$(shasum -a 256 "$source_dir/MANIFEST" | cut -d' ' -f1)"

cat >"$dist/source.env" <<EOF
SCRIPTS_COMMIT=$commit
SCRIPTS_DIRTY=$dirty
SCRIPTS_ARCHIVE=$scripts
MANIFEST_SHA256=$manifest_sha256
EOF

echo "source    $source_dir (MANIFEST sha256 $manifest_sha256, scripts $scripts)"
