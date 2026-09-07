---
"@xplainer/cli": patch
---

The program resolver, the runtime stager, the stable launcher, and exit codes `5`, `6` and `7`.

**One resolver decides where an install's program comes from**, and records its answer in
`daemon.json` as `program_source`. The four sources are tried in a fixed order and there is no
registry to add a fifth to: `explicit` (`--program <absolute path>`, taken verbatim after a
preflight), `sea-binary` (`--from-binary`, accepted as a request and refused as phase-4 work),
`package-manager` (refused, because nothing is published yet — the branch a publish adds locates the
global install and hands its directory to the same stager) and `runtime-dir`, the phase-2 default: a
payload-1 artefact staged under the state directory. The two refusals are branches rather than
absences on purpose — a resolver that fell through to the default when it was asked for a source it
cannot serve would write `runtime-dir` into the one field whose whole job is to say where the program
came from.

**The stager materialises a payload at `<state>/runtime/<version>-<digest>/` by temp dir → rename.**
The temporary directory is a *sibling* of the target, because `rename(2)` is atomic only within one
filesystem and a state directory relocated onto another volume would otherwise turn the operation
this rests on into a copy-and-delete that can be interrupted: the invariant is that **a half-copied
runtime is never visible under its final name**. The name is the content — the version of the package
the launch contract's entry lies in, plus a SHA-256 over every file hash, every symlink target and
the host facts the payload was built against — so re-staging the same artefact copies nothing, a
payload that differs by one byte gets a directory of its own, and an update can stage the new runtime
beside the running one. The payload is re-hashed against its own manifest *before* the copy, so a
tampered artefact is refused while the state directory still holds nothing the call made. The build's
`created_at` is deliberately not in the digest: two builds of one tree are one runtime.

**`<state>/bin/xplainer` (`xplainer.cmd` on Windows) is the one name a consumer may hold across an
update.** It is a generated two-line script: `#!/bin/sh` and `exec "<runtime>/bin/node"
"<runtime>/lib/node_modules/@xplainer/cli/dist/bin.js" "$@"`. `exec` costs nothing — a shell that
`exec`s keeps the same pid — and the file is rewritten by the same small-file temp → rename as the
unit, the plist and the task XML, with the mode set on the temporary so the name never appears
carrying one a consumer cannot run. Without it, `connect` writes a `<version>-<digest>` directory into
an agent's configuration and the next update points it at a deleted path.

**Three exit codes gain names and rows.** `5` administrator privileges required, `6` no supported
supervisor, `7` an install-time port or label conflict. The distinction between `7` and `10` is
stated in `docs/ARCHITECTURE.md` §6 and asserted by a test, because it is the one a reader gets
wrong: **`7` is install-time preflight** — the port `install` is about to record is held, nothing is
registered and nothing is recorded — and **`10` is `serve`-time ownership**, the state directory or
the recorded port taken by a process running now. Same symptom, two lifecycles, two remediations.

No command exits `5`, `6` or `7` yet and nothing writes a launcher yet: `xplainer daemon install` is
still a registered stub, and it is the first caller of all of this.
