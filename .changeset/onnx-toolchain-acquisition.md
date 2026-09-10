---
"@xplainer/cli": minor
"@xplainer/protocol": minor
---

`xplainer setup` acquires everything the in-process ONNX speech path needs: the Kokoro-82M int8
graph and one voice pack from the HuggingFace repository they live in, pinned to revision
`dd4401a9`, and **this platform's ONNX Runtime** from the npm registry. Four artefacts, each pinned
by digest, each fetched from its own upstream home — this project hosts none of it — and the
existing verify-then-commit path does all of it: `HEAD`, `Range` resume, streaming SHA-256, the
named refusals, and a commit that is one `rename`.

**Why the runtime is acquired rather than depended on, with the numbers.** `onnxruntime-node`
declares no `optionalDependencies` and carries **five** platforms in one package —
`darwin/arm64` 88,043,128 bytes, `linux/x64` 45,116,232, `linux/arm64` 24,932,672,
`win32/x64` 66,310,760, `win32/arm64` 71,871,080, and no `darwin/x64` at all — so depending on it
would put 296,273,872 bytes of foreign-platform binaries into payload 1's closure and into every
global install. It also declares a `postinstall` that fetches a **191,730,792-byte** CUDA package
from `api.nuget.org` on `linux/x64`, which `AC-1d` forbids outright and which cannot be turned off
from inside this repository. And Microsoft's per-platform release archives are not an alternative:
they carry the C shared library, the headers and the CMake package, and **no
`onnxruntime_binding.node`** — the N-API binding exists only inside the npm package, and the two
halves are different builds of the same version (28,497,752 bytes against 44,726,808 on
`linux/x64`) so they cannot be mixed. So `setup` fetches the npm tarball, keeps this platform's
`bin/napi-v6` subtree plus Microsoft's own `dist/` loader verbatim, and puts `onnxruntime-common`
where that loader's own `require` resolves it. The same bytes cross the wire either way; a third of
them stay on disk, nothing is fetched from a third feed, and `@xplainer/cli`'s published tarball and
payload 1 are unchanged.

Measured end to end on darwin-arm64: 39.7 s to acquire all four, 16 files and 88,062,119 bytes taken
out of the 296 MB archive, 181,392,041 bytes committed, and the acquired tree loads through
`createRequire` and answers `waveform[1,33600]` / `durations[1,9]` on the pinned voice. An Intel Mac
is **refused by name** before anything is fetched, because that binding does not exist.

`toolchain.json` gains an optional `files` array on `ToolchainComponent`, and `provider: "onnx"`
uses it. `path` still names one artefact — the model graph, which is what every existing reader
looks at — and `files` names the rest: the voice, every file in this platform's native subtree, and
one witness inside each committed tree. ADR 0020 makes `daemon install` "verify the recorded paths
still exist", and for a component made of several files that check is only meaningful if every path
is recorded; both readers of the marker now check all of them. The field is **optional**, so
`format_version` does not move: an older build reads the marker exactly as it did.

**One voice, deliberately.** Nothing in the eight-tool contract can select a second — a voice no
caller can name is 0.5 MB of unreachable bytes and a digest somebody has to review — and adding one
later is two lines and a reviewed digest on a command that is re-runnable by design.

**The `onnx` route sits below `docker` and above `bundle`**, which was decided against the proofs
rather than by preference: `scripts/e2e/toolchain.mjs` opens `marker.speech.path` *as the docker
receipt* on any machine whose `docker version` answers, so an `onnx`-first order would have that
gate parse a 92 MB model. Docker keeps every host with an engine; `onnx` closes every host without
one — which is Windows, and every locked-down laptop and Linux container besides.

**A pre-existing warm-cache defect is fixed here**, independent of any of the above.
`providers/speech-bundle.ts` skipped the download **and the verification** whenever its destination
directory already existed, and then recorded the digest it had merely been told for a tree nothing
on this machine had ever checked — and because the destination was named after the *version*, a
re-published artefact at an unchanged version would have been served out of that cold cache for
ever. Cache identity now binds the digest, and every committed acquisition carries a record inside
the tree it commits (written before the `rename`, so it is present exactly when the tree is) that a
later run re-verifies. Nothing records a digest it did not observe.

Two internal modules make it work and neither adds a dependency: a **streaming gzip-tarball
reader** with a member selector, because the npm registry serves `.tgz` and this platform's subtree
is one of five in it, and the record-and-re-verify machinery above. `deliveryPosition()` loses its
Windows paragraph — the sentence saying Windows has no working speech route is what the `onnx` route
makes false.
