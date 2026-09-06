# Build a relocatable native Kokoro-FastAPI bundle for Windows.
#
# STUB. This script builds nothing. It is deliberately not run in CI; see
# ../README.md for why, and for the download-on-first-run contract it serves.
#
# Usage:
#   ./build.ps1 --i-know-this-is-a-stub   # prints the intended steps, exits 0
#   ./build.ps1                           # prints the same steps, exits 2
#
# The flag is spelled exactly as it is in macos/build.sh and linux/build.sh so
# one caller can drive all three identically. That is also why this script
# declares no param() block: with no parameters, PowerShell passes every token
# through to $args verbatim, including a POSIX-style '--' flag it would
# otherwise try to bind as a parameter name.
$ErrorActionPreference = 'Stop'

$acknowledged = $args -contains '--i-know-this-is-a-stub'

Write-Output @'
xplainer TTS sidecar - Windows bundle (not implemented; roadmap phase 2)

Target:  Windows 10 21H2+, x64.
Output:  dist/xplainer-tts-windows-x64.zip

Intended steps:
  1. Resolve the Kokoro-FastAPI source at the same upstream revision the pinned
     image digest in ../../Dockerfile was built from, so the native bundle and
     the container serve identical behaviour.
  2. Create a standalone CPython 3.12 runtime from a python-build-standalone
     release, pinned by checksum.
  3. Install the Kokoro-FastAPI dependency closure into that runtime with
     `uv pip install --python <runtime> --require-hashes`, CPU wheels only.
  4. Vendor espeak-ng.dll and its data directory, and point
     PHONEMIZER_ESPEAK_PATH and ESPEAK_DATA_PATH at the bundled copies through
     the launcher.
  5. Emit a launcher .exe rather than a .bat, so the desktop app can spawn the
     sidecar without a console window flashing on screen.
  6. Exclude the voice pack. It is downloaded by `xplainer setup` on first run
     (spec Round 4), and baking it in would defeat the whole decision.
  7. Smoke-test the bundle on a machine with no Python on PATH: start it, poll
     /v1/audio/voices, synthesise one short utterance, confirm the response
     carries word timestamps.
  8. Compress-Archive to dist/ and emit a SHA-256 alongside, which is what the
     updater manifest consumed by `xplainer setup` will reference.

Deliberately NOT done here:
  - No Authenticode signing. Roadmap phase 4 owns certificates; an unsigned
    bundle triggers SmartScreen and that is the known, accepted state for now.
  - No MSI or installer. This produces one relocatable zip.
  - No download of the voice model.
  - No CI invocation of this script, on any runner.
'@

if ($acknowledged) {
  exit 0
}

[Console]::Error.WriteLine('')
[Console]::Error.WriteLine('build.ps1: refusing to run: this is a stub that produces no artifact.')
[Console]::Error.WriteLine('Re-run with --i-know-this-is-a-stub to acknowledge and exit 0.')
exit 2
