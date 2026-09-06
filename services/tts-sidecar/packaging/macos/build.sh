#!/usr/bin/env bash
# Build a relocatable native Kokoro-FastAPI bundle for macOS.
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
xplainer TTS sidecar — macOS bundle (not implemented; roadmap phase 2)

Target:  macOS 13+, arm64 and x86_64 built separately (no universal binary:
         the ONNX runtime ships per-arch wheels).
Output:  dist/xplainer-tts-macos-<arch>.tar.gz

Intended steps:
  1. Resolve the Kokoro-FastAPI source at the same upstream revision the pinned
     image digest in ../../Dockerfile was built from, so the native bundle and
     the container serve identical behaviour.
  2. Create a standalone CPython 3.12 runtime for the target arch from a
     python-build-standalone release, pinned by checksum.
  3. Install the Kokoro-FastAPI dependency closure into that runtime with
     `uv pip install --python <runtime> --require-hashes`, CPU wheels only.
  4. Vendor espeak-ng and its data directory, and rewrite the loader paths so
     PHONEMIZER_ESPEAK_PATH and ESPEAK_DATA_PATH resolve inside the bundle.
  5. Rewrite absolute install paths to @loader_path-relative ones with
     install_name_tool, then verify with `otool -L` that nothing outside the
     bundle and outside /usr/lib is referenced.
  6. Exclude the voice pack. It is downloaded by `xplainer setup` on first run
     (spec Round 4), and baking it in would defeat the whole decision.
  7. Smoke-test the bundle from a directory other than the build directory:
     start it, poll /v1/audio/voices, synthesise one short utterance, confirm
     the response carries word timestamps.
  8. tar+gzip to dist/ and emit a SHA-256 alongside, which is what the updater
     manifest consumed by `xplainer setup` will reference.

Deliberately NOT done here:
  - No codesign, no notarisation, no stapling. Roadmap phase 4 owns signing
    identities; an unsigned bundle is Gatekeeper-quarantined and that is the
    known, accepted state for now.
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
