# Desktop packaging for the TTS sidecar

## These scripts are deliberately not run in CI

Nothing under `packaging/` is invoked by `.github/workflows/ci.yml`, by
`.github/workflows/desktop.yml`, or by any Turbo task. That is a decision, not
an omission, and it holds for the whole of this scaffold phase (spec section
Non-Goals: no TTS, no packaging, no signing).

Three reasons it stays that way:

1. **There is nothing to package yet.** The sidecar in this repository is a
   connection contract — a base URL, a pinned image digest, two endpoint paths
   and a default voice. A build script that produced an artifact today would be
   packaging an empty box.
2. **A packaged Kokoro runtime is several hundred megabytes.** Building it on
   three runners on every push would dominate CI wall-clock time for an artifact
   nobody downloads, and would do so before anyone has decided what the artifact
   should contain.
3. **Signing and notarisation are out of scope.** macOS notarisation needs an
   Apple Developer identity and Windows needs an Authenticode certificate.
   Neither exists, and both are roadmap phase 4 work.

Each script therefore refuses to run without `--i-know-this-is-a-stub`. Passing
that flag prints the intended steps and exits 0; omitting it prints the same
steps and exits non-zero, so a script cannot be mistaken for a working build by
a human, by a Makefile, or by a future CI job that wires it up by accident.

## What these scripts will do: download on first run

The distribution decision (spec Round 4, ADR 0005) is that **installers do not
bundle TTS**. The Kokoro runtime and its voice model are fetched on first run by
`xplainer setup`, not shipped inside the desktop installer.

The consequences that shape the scripts here:

- **Installers stay small.** A Kokoro runtime bundled into macOS, Linux and
  Windows installers would be paid for three times over in every release.
- **The model is a runtime asset, not a build input.** It is downloaded to a
  per-user application data directory and reused across upgrades, so an app
  update does not re-download it.
- **The docker path is the reference path.** Where Docker is available,
  `xplainer setup` runs the image pinned by digest in `../Dockerfile` and these
  native bundles are not used at all. They exist for machines where a container
  runtime is unwanted or unavailable.

So the scripts in this directory are responsible for producing a *relocatable
native Kokoro-FastAPI bundle* that `xplainer setup` can download and unpack —
not for producing an installer, and not for downloading anything themselves.

## Per-OS entry points

| Script                | Target                | Produces                              |
| --------------------- | --------------------- | ------------------------------------- |
| `macos/build.sh`      | macOS 13+, arm64+x64  | `dist/xplainer-tts-macos-<arch>.tar.gz` |
| `linux/build.sh`      | glibc 2.35+, x86_64   | `dist/xplainer-tts-linux-x86_64.tar.gz` |
| `windows/build.ps1`   | Windows 10+, x64      | `dist/xplainer-tts-windows-x64.zip`     |

Each script prints its own intended steps when invoked; read the script itself
for the detail rather than duplicating it here, so the two cannot drift.

## When this stops being a stub

Roadmap phase 2 ("Desktop GUI + first-run downloads") owns the real
implementation, alongside `xplainer setup`. At that point these scripts get a
release workflow of their own — still not `ci.yml`, because the size and runtime
arguments above do not change. Until then, this file is the whole specification.
