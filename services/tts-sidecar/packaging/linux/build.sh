#!/usr/bin/env bash
# Build a relocatable native Kokoro-FastAPI bundle for Linux.
#
# STUB. This script builds nothing. It is deliberately not run in CI; see
# ../README.md for why, and for the download-on-first-run contract it serves.
#
# Usage:
#   ./build.sh --i-know-this-is-a-stub   # prints the intended steps, exits 0
#   ./build.sh                           # prints the same steps, exits 2
set -euo pipefail

acknowledged=0
for arg in "$@"; do
  if [ "$arg" = "--i-know-this-is-a-stub" ]; then
    acknowledged=1
  fi
done

cat <<'STEPS'
xplainer TTS sidecar — Linux bundle (not implemented; roadmap phase 2)

Target:  x86_64, glibc 2.35+ (built inside a manylinux_2_35 container so the
         host distribution of whoever runs this cannot leak into the bundle).
Output:  dist/xplainer-tts-linux-x86_64.tar.gz

Intended steps:
  1. Resolve the Kokoro-FastAPI source at the same upstream revision the pinned
     image digest in ../../Dockerfile was built from, so the native bundle and
     the container serve identical behaviour.
  2. Create a standalone CPython 3.12 runtime from a python-build-standalone
     release, pinned by checksum.
  3. Install the Kokoro-FastAPI dependency closure into that runtime with
     `uv pip install --python <runtime> --require-hashes`, CPU wheels only.
  4. Vendor espeak-ng and its data directory, and point PHONEMIZER_ESPEAK_PATH
     and ESPEAK_DATA_PATH at the bundled copies through the launcher script.
  5. Set RPATH to $ORIGIN-relative paths with patchelf, then verify with
     `ldd` that the only unresolved sonames are the glibc baseline ones.
  6. Exclude the voice pack. It is downloaded by `xplainer setup` on first run
     (spec Round 4), and baking it in would defeat the whole decision.
  7. Smoke-test the bundle in a bare container with no Python installed: start
     it, poll /v1/audio/voices, synthesise one short utterance, confirm the
     response carries word timestamps.
  8. tar+gzip to dist/ and emit a SHA-256 alongside, which is what the updater
     manifest consumed by `xplainer setup` will reference.

Deliberately NOT done here:
  - No .deb, .rpm, AppImage or Flatpak. This produces one relocatable tarball;
    distribution packaging is a separate decision nobody has needed yet.
  - No aarch64 build. Add one when a Linux arm64 target actually exists;
    guessing at it now would ship an untested artifact.
  - No download of the voice model.
  - No CI invocation of this script, on any runner.
STEPS

if [ "$acknowledged" -eq 1 ]; then
  exit 0
fi

echo "" >&2
echo "build.sh: refusing to run: this is a stub that produces no artifact." >&2
echo "Re-run with --i-know-this-is-a-stub to acknowledge and exit 0." >&2
exit 2
