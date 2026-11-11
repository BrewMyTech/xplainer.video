#!/usr/bin/env bash
# Turn the build jobs' artefacts into one release directory, and report how the
# repeated builds compared.
#
#   infra/ffmpeg/assemble.sh <artefacts-dir> <release-dir>
#
# <artefacts-dir> holds one directory per build job, named
# ffmpeg-<arch>-run<n>, each with that job's zip, its manifest row (.json) and
# its source.env; and one ffmpeg-source directory holding the source bundle's
# files (upload-artifact stores a directory's contents, not the directory).
#
# <release-dir> becomes exactly what is published under
# <XP_CDN_BASE>/<XP_BUILD_VERSION>/:
#
#   ffmpeg-<v>-darwin-<arch>.zip   run 1 of each architecture
#   ffmpeg-<v>.json                the manifest fragment for `xplainer setup`:
#                                  {"ffmpeg": {"expected": {<platform>: row}}}
#   SHA256SUMS                     the zips and the fragment
#   source/                        the complete corresponding source
#
# The comparison table goes to stdout as Markdown, for the job summary. A
# difference between runs is reported, not fatal: the digest recorded here is
# the pin whether or not a second build reproduces it (Checklist B item 6).
# What IS fatal: a zip whose bytes do not match its own manifest row, and two
# jobs that disagree about the source bundle, because then SOURCE.txt in one of
# the zips names a source that is not the one being published.
#
# Runs on Linux or macOS; needs jq.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pins.env
. "$here/pins.env"

artefacts="${1:?usage: assemble.sh <artefacts-dir> <release-dir>}"
release="${2:?usage: assemble.sh <artefacts-dir> <release-dir>}"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

rm -rf "$release"
mkdir -p "$release"

manifests=()
echo "### FFmpeg $XP_BUILD_VERSION for macOS: build digests"
echo
echo "| platform | run | ffmpeg sha256 | ffmpeg bytes | zip sha256 | zip bytes |"
echo "|---|---|---|---|---|---|"
for job in "$artefacts"/ffmpeg-*-run*; do
  [ -d "$job" ] || continue
  run="${job##*-run}"
  row="$(find "$job" -maxdepth 1 -name "ffmpeg-$XP_BUILD_VERSION-darwin-*.json" | head -n 1)"
  if [ -z "$row" ]; then
    echo "assemble.sh: $job has no manifest row" >&2
    exit 1
  fi
  platform="$(jq -r 'keys[0]' "$row")"
  zip="$job/ffmpeg-$XP_BUILD_VERSION-$platform.zip"
  recorded="$(jq -r --arg p "$platform" '.[$p].sha256' "$row")"
  actual="$(sha256_of "$zip")"
  if [ "$recorded" != "$actual" ]; then
    echo "assemble.sh: $zip hashes to $actual but its row records $recorded" >&2
    exit 1
  fi
  jq -r --arg p "$platform" --arg run "$run" \
    '.[$p] | "| \($p) | \($run) | `\(.member_sha256)` | \(.member_size) | `\(.sha256)` | \(.size) |"' "$row"
  # shellcheck source=/dev/null
  manifests+=("$(. "$job/source.env" && echo "$MANIFEST_SHA256")")
  if [ "$run" = 1 ]; then
    cp "$zip" "$row" "$release/"
  fi
done
echo

if [ "${#manifests[@]}" -eq 0 ]; then
  echo "assemble.sh: no build artefacts under $artefacts" >&2
  exit 1
fi
if [ "$(printf '%s\n' "${manifests[@]}" | sort -u | wc -l | tr -d ' ')" != 1 ]; then
  echo "assemble.sh: the build jobs disagree about the source bundle: ${manifests[*]}" >&2
  exit 1
fi
if [ ! -f "$artefacts/ffmpeg-source/MANIFEST" ] ||
  [ "$(sha256_of "$artefacts/ffmpeg-source/MANIFEST")" != "${manifests[0]}" ]; then
  echo "assemble.sh: the source bundle artefact is missing or is not the one the builds recorded" >&2
  exit 1
fi
cp -R "$artefacts/ffmpeg-source" "$release/source"

echo "**Bit-stability** (same platform, separate runners, same commit):"
echo
for row in "$release"/ffmpeg-"$XP_BUILD_VERSION"-darwin-*.json; do
  platform="$(jq -r 'keys[0]' "$row")"
  digests="$(cat "$artefacts"/ffmpeg-*-run*/ffmpeg-"$XP_BUILD_VERSION"-"$platform".json |
    jq -r --arg p "$platform" '.[$p].member_sha256' | sort -u)"
  zips="$(cat "$artefacts"/ffmpeg-*-run*/ffmpeg-"$XP_BUILD_VERSION"-"$platform".json |
    jq -r --arg p "$platform" '.[$p].sha256' | sort -u)"
  runs="$(find "$artefacts" -maxdepth 1 -name "ffmpeg-*-run*" -type d |
    while IFS= read -r job; do ls "$job"; done | grep -c "^ffmpeg-$XP_BUILD_VERSION-$platform.zip$" || true)"
  if [ "$runs" -lt 2 ]; then
    echo "- $platform: built once; not compared"
  elif [ "$(echo "$digests" | wc -l | tr -d ' ')" = 1 ] && [ "$(echo "$zips" | wc -l | tr -d ' ')" = 1 ]; then
    echo "- $platform: **bit-stable** across $runs builds (ffmpeg and zip identical)"
  elif [ "$(echo "$digests" | wc -l | tr -d ' ')" = 1 ]; then
    echo "- $platform: ffmpeg identical across $runs builds; the zips differ (BUILDINFO.txt records the runner)"
  else
    echo "- $platform: **not bit-stable**: $runs builds gave $(echo "$digests" | wc -l | tr -d ' ') different binaries; run 1 is the pin"
  fi
done
echo

jq -s '{ffmpeg: {expected: add}}' "$release"/ffmpeg-"$XP_BUILD_VERSION"-darwin-*.json \
  >"$release/ffmpeg-$XP_BUILD_VERSION.json"
rm -f "$release"/ffmpeg-"$XP_BUILD_VERSION"-darwin-*.json
(
  cd "$release"
  for file in ffmpeg-"$XP_BUILD_VERSION"-darwin-*.zip "ffmpeg-$XP_BUILD_VERSION.json"; do
    printf '%s  %s\n' "$(sha256_of "$file")" "$file"
  done
) >"$release/SHA256SUMS"

echo "**Release directory** for \`$XP_CDN_BASE/$XP_BUILD_VERSION/\`:"
echo
echo '```'
cat "$release/SHA256SUMS"
echo "source/MANIFEST $(sha256_of "$release/source/MANIFEST")"
echo '```'
echo
echo '```json'
cat "$release/ffmpeg-$XP_BUILD_VERSION.json"
echo '```'
