---
"@xplainer/cli": minor
---

`xplainer daemon install` and `xplainer daemon uninstall` do the thing, on all three platforms, with a rollback that leaves a failed install invisible.

**`install` is preflight → stage → render → register → verify, and the last step is the one that
makes it an install.** A supervisor that accepted a unit has said nothing about whether the daemon
runs, so `install` starts it and polls an **authenticated** `GET /healthz` with a bounded timeout —
which is the wait ADR 0025's note of 2026-09-08 assigns to the caller when it rejects `Type=notify`
— and reads the port out of the `runtime.json` the daemon itself wrote rather than out of the
artefact it was asked for. Every step that changes anything registers its own undo beside it, so a
failure at step nine removes what steps one to eight wrote: the registration, the record, the
artefact, the launcher, the staged runtime, the linger marker, and the empty directories the
install's own `mkdir -p` invented — `~/.config/systemd/user` among them, which is the user's tree
and not this project's.

**The orders are the ones the platforms actually require, and each is now checked against the
argument vectors a supervisor was handed.** On Linux lingering goes **first**, because
`loginctl enable-linger` is the one step that can be refused outright, and the check that follows is
`test -e /var/lib/systemd/linger/$USER` rather than `loginctl`'s exit status — `loginctl` is a client
of `logind` and reports what it was told. On macOS `launchctl enable` precedes `bootstrap`, because
`man launchctl` says a disabled service "cannot be loaded in the specified domain until it is once
again enabled" and that state survives reboots; `bootout` comes before both, because `bootstrap`
does not refresh an already-loaded definition, and `kickstart` comes last. On Windows
`Register-ScheduledTask -Xml … -Force` is followed by `Start-ScheduledTask`, and a health failure
there reads `LastTaskResult`, names `SCHED_S_BATCH_LOGON_PROBLEM` (`0x0004131C`) as a **candidate**
rather than a diagnosis, unregisters, and exits `5`.

**`uninstall` deletes the token rather than rotating it.** P2-9 asks for no live token afterwards and
rotation mints a new value and leaves it on disk, so the file goes — wherever `XPLAINER_TOKEN_FILE`
put it — along with the artefact, `runtime.json`, `owner.lock`, the socket, every staged runtime and
the launcher. `toolchain.json` and the workspace stay: the marker is `setup`'s and the workspace is
the user's videos.

**It never disables lingering, not even lingering this project enabled**, because
`/var/lib/systemd/linger/$USER` is per user and not per service: anything else the user has since
arranged to survive logout depends on it. `daemon.json` records that we enabled it and `uninstall`
reports it with the one line that undoes it. The rollback of a *failed* install is the single
exception, and only there because the marker is seconds old.

**Two exit codes stop being reserved.** `5` — the install needs an administrator — is what a denied
`enable-linger` and a Windows principal without the "Log on as a batch job" right both take, and `6`
now leads with `sudo loginctl enable-linger` instead of `connect --spawn` when systemd booted the
machine and the user manager is absent *because* lingering is: measured inside the project's own
systemd container, `systemctl --user is-system-running` answers "Failed to connect to bus" in that
state, and the old message called a fixable machine an unsupported one.

**A `launchctl` disable record for our label is cleared; an `enabled` one is named and left.**
`launchctl` sets a record's value and has no verb that removes it — `enable` and `disable` are the
only two, and the store is root-owned — so `uninstall` clears the record that would break a later
install and reports the inert one it cannot remove, rather than "cleaning up" with
`launchctl disable` and creating exactly the stale disable record the preflight exists to warn about.

**Fixed on the way past.** `xplainer mcp --attach` reads the daemon's recorded `socket_path` before
falling back to the path derived from the state directory, so a daemon started with `serve --socket`
elsewhere — which is what an installed one is — is reached rather than reported unreachable. And the
install preflight's `launchctl print-disabled` reader matched `=> true`, which no modern macOS
prints: captured verbatim from macOS on 2026-09-08, the store spells a record `=> disabled` or
`=> enabled`, so the probe answered "not disabled" for every label on the platform and the one
condition it exists to catch was unreachable.

`xplainer daemon start`, `stop`, `status` and `logs` join them, over the same one supervisor seam.

**`daemon status` is built from `/healthz`, our own state files, and three documented
machine-readable supervisor queries — and never from `launchctl print`.** The blanket "never parse a
supervisor" rule made one of ADR 0020's **own** required sentences unobservable: whether the user
switched the service off appears in no HTTP response and in no file this project owns, because Login
Items & Extensions changes launchd's disable store and touches nothing of ours. So the rule is
narrowed to the surface whose own manual disowns it — `launchctl print`, "This output is NOT API in
any sense at all" — and three queries with stable answers are allowed: `launchctl print-disabled
gui/$UID`, `systemctl --user is-enabled xplainer.service` and `(Get-ScheduledTask …).State` for the
switched-off fact, and `systemctl --user show -p ExecStart -p Environment -p WorkingDirectory
--value` and `Get-ScheduledTask` for the loaded configuration, which **macOS does not have** and
which `/healthz`'s responding identity stands in for there.

**The four sentences ADR 0020 requires are values with a state tag, not prose in a command**, and
the test compares them with the four quoted strings read out of the ADR file itself. Reword one in
either place and the suite fails. Two of the four name a platform's own surface — "Login Items &
Extensions" means nothing on Linux and lingering is a systemd concept — so the ADR's exact sentence
is what the platform it was written for produces, and the other two make the same claim about the
surface their user actually has.

**`daemon status --json` answers from a closed set of conditions**, the same members `xplainer
status` uses plus two that need a supervisor or the setup marker: `disabled`, which no HTTP response
can see, and `degraded` — the daemon answered `200` and the toolchain `setup` recorded is not on
this machine. `degraded` exits `0`, because the daemon is running and a script that gates on "is it
up" should not fail over a missing Chrome; the sentence and `toolchain.missing` are how a reader
finds out.

**`start` and `stop` wait for a post-condition rather than for an exit status.** All three
supervisors return as soon as they have accepted the request, so a start that trusted the status
would report success for a daemon that never bound. `start` waits for an authenticated `200` through
the same `awaitHealthy` the install uses — reading the port out of the `runtime.json` this start
wrote, which is the only correct answer for a daemon installed with `--port 0` — and `stop` waits
until nothing answers, tolerating the non-zero status all three report for stopping something that
was not running. `stop` leaves the registration in place: on macOS it sends `SIGTERM` with
`launchctl kill` rather than booting the job out, because a stop that deregistered would be an
uninstall with another name.

**`daemon logs` execs `journalctl --user -u xplainer` on Linux and tails the daemon's own file on
macOS and Windows**, which is ADR 0020's deliberate asymmetry: journald already does retention, and
launchd has no log-rotation key at all. Windows now records that file's path — `%LOCALAPPDATA%\
xplainer\logs\daemon.log`, the one ADR 0020's platform table names — instead of `journald`, which
was never true there: a Scheduled Task's `<Exec>` captures no output at all, so Windows is the
platform where the daemon writing its own log is the only way there is one. The writer that keeps
that file under a size bound is not in this release, and `daemon logs` reads whatever is there.
