---
"@xplainer/cli": minor
"@xplainer/protocol": minor
---

The install preflight, the entry an installed machine actually gets, and `connect --spawn`.

**One read-only preflight answers every question before an install writes anything.** ADR 0020's
rule for the degraded paths is "probe before writing; on refusal, write nothing, exit with the
documented code, and print the one command that fixes it", and `install/preflight.ts` is the probing
half in full: the setup marker and whether the files it records still exist, the supervisor **and
whether this user has a manager to register with**, the resolved program's executability, the port,
the linger marker, a stale `launchctl` disable record, and the token file. Its refusals carry codes
from the table and invent none — `3` for a missing marker, a stale one or a program that will not
execute, `6` for no user manager and for a Task Scheduler that refuses a query, `7` for a held port,
with the holding pid named in words from `lsof` or `ss` where either answers.

**Read-only is the property, and lingering is where it is won.** The preflight reads
`/var/lib/systemd/linger/$USER` and **never** attempts `loginctl enable-linger`: enabling lingering
*creates* that marker, which is a write inside the phase whose whole contract is that a refusal
leaves the machine as it was. The absent marker is a fact the writing phase acts on, which is also
what makes `daemon.json`'s `linger_enabled_by_us` meaningful — an install can only remove a setting
it made. Every refusal case is asserted against a hashed snapshot of the state directory *and* of
the supervisor's own artefact location, so "writes nothing" is a comparison rather than a claim.

**systemd is detected by `/run/systemd/system`, never by `command -v systemctl`** — that directory
is what `sd_booted(3)` checks, and Debian and Ubuntu base images ship the binary without systemd as
PID 1, so the naive probe reports a supervisor on exactly the container that has none. Presence is
still not enough: `systemctl --user is-system-running` is what establishes that *this user* has a
manager, and "systemd booted this machine" and "you have somewhere to put a unit" are two different
facts with the same remediation and different sentences.

**`connect` writes the stable launcher, and `--spawn` exists.** A runtime-directory install puts
nothing on `PATH`, so `connect` used to fall through to `npx -y @xplainer/cli` — an entry pointing at
a package this phase does not publish, written on the one machine that already has the code. The
order is now `<state>/bin/xplainer`, then the binary on `PATH`, then `npx`, and a version-scoped
runtime directory is never written. `xplainer connect claude|codex --spawn` writes the other entry —
`xplainer mcp` **without** `--attach`, the eight tools inside the agent's own session — and it
**bypasses the daemon preflight**, because it is the remediation both exit-`6` messages lead with
and is offered exactly when there is no daemon to check for. It works with no launch record: the
launcher when an install wrote one, the staged runtime otherwise, which is the one place a
version-scoped path is allowed and it is allowed because a refused install has no update to break
it.

**`mcp --attach`'s skew message names a command this machine can run.** It printed
`npm i -g @xplainer/cli@<version>`; nothing is published, so it named a package that does not exist.
It now names the launcher the daemon's own install wrote — the one name a shim and a daemon share
across an update — or, where there is none, the command that creates it. A dated note in
`mcp/attach.ts` records that the npm form returns when the publish happens.

**`@xplainer/protocol` gains `toolchain.json`.** The setup marker becomes a checked contract with
generated bindings in both languages — the Chrome and speech versions, resolved paths, `sha256` and
provider, and the workspace payload's platform and version — because three surfaces read it and none
of them owns it: `setup` writes it, the install preflight validates it, and `daemon update` compares
the workspace it records against an incoming runtime's template pins. An unknown newer
`format_version` is a rollback signal rather than corruption, so a marker a later build wrote is
read rather than rejected.
