---
"@xplainer/cli": patch
---

**`xplainer daemon install` takes no arguments on a machine that installed from npm.**

`install/program.ts` has always known four program sources, and `package-manager` was a refusal
because nothing was published. `xplainer` and `@xplainer/cli` have been on npm since `0.0.1`, so the
refusal was the only thing left making a user assemble a ~165 MB payload by hand before they could
install the daemon — friction sitting in front of the mode that
[ADR 0029](../docs/adr/0029-the-agent-path-may-be-http-when-the-token-never-enters-the-config.md)
measured as the *cheaper* one.

`commands/daemon.ts` now builds a payload out of the installed package and hands it to the installer
as an ordinary `payloadDir`. `--runtime` still wins when it is given, and a checkout or a CI runner
still takes `runtime-dir`, because neither has a `node_modules/@xplainer/cli` above it.

**It assembles rather than pointing at the install directly, and that is the point.** A supervisor
artefact needs an absolute interpreter path that stays valid, and
`~/.nvm/versions/node/<v>/bin/node` does not: the next `nvm install` leaves a supervisor entry
naming a file that is gone. The payload carries its own copy of `process.execPath`, so the daemon
survives the interpreter it was installed with disappearing.

**Where the building happens is load-bearing, and it took two defects to get right.** The obvious
home was `install/program.ts`, the module that decides where a program comes from — and putting it
there made that module write ~165 MB, while its own contract says "Nothing here writes, so a refusal
leaves a machine exactly as it was". Two callers paid for the broken promise. `connect/spawn.ts`
resolves a program only in order to write one line into an agent's configuration, and began
assembling a payload to do it — on exactly the machine that command exists for. And the branch of
the installer the payload arrived through pushes no rollback undo, so a failed install kept the
bytes while reporting that everything it wrote had been undone.

So the write lives in `install/materialise.ts`, under a verb that says so; the caller discards it in
a `finally`; the payload is built outside the state directory, where nothing can mistake it for a
staged runtime; and `install/program.ts` no longer imports the assembler at all — a property held by
a test that walks its transitive import closure and asserts neither writing module is in it, rather
than by a comment or by a grep over one file, both of which were tried and both of which a review
bypassed with one import.

**A payload that has to be built is built after the preflight, and that took a thunk.** `--runtime`
names a directory that already exists, so resolving it early costs nothing; assembling ~146 MB
early costs 1.3 s and 146 MB ahead of an install that may be about to refuse for want of a setup
marker, twice over when two installers race. `payloadDir` therefore takes `string | (() => string)`
and phase 3 is what calls it — below the read-only phase 1, inside the operation lock.

Two adjacent things this reached:

- `install/install.ts` takes the `program_source` as an input rather than re-deriving it from the
  directory it produced, because both sources end in an identical content-addressed slot and a
  resolver looking at the result would answer `runtime-dir` for either. That record is the only
  place saying whether the bytes came from a registry or from somebody's working copy.
- `daemon update` now admits `package-manager` beside `runtime-dir`. Its guard was written as
  "not `runtime-dir`" while the fourth value was unreachable, so making it reachable would otherwise
  have closed updates for every npm-installed machine — on the route this change exists to enable.

**A payload that will not build is a refusal that rolls back.** Building at phase 3 put the build
*after* the phase that enables lingering, so a machine that could not assemble — out of disk, a
partial npm tree — was told the install had refused while the linger marker it had just created
stayed enabled, and with it nothing recorded that would let `uninstall` remove it later. The build
happens inside the same `try` as the staging now, so every failure from there reports what it undid:
exit `3`, the assembler's own sentence, and `rolled back: disabled lingering for <user>`.

**Held at `patch` deliberately.** This adds a capability and on a `0.0.x` line a `minor` marker
produces `0.1.0`, which is a release decision rather than a changelog one. Nothing here is breaking:
every existing invocation resolves exactly as it did.
