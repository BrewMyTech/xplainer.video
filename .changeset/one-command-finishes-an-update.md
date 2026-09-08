---
"@xplainer/cli": minor
---

`daemon update` and `daemon recover`: the update is a transaction, and one command finishes it.

**ADR 0025's six update steps become a recoverable transaction**, because an ordered call sequence
has no answer to "the updater died". `xplainer daemon update --from <runtime dir>` stages the
incoming payload beside the running one, drains the daemon over ADR 0024's own
`POST /api/daemon/drain`, rewrites the supervisor artefact and the stable launcher, reloads or
re-registers with the supervisor, starts the replacement and waits for it to answer an
**authenticated** `GET /healthz` from a run that is not the one that was drained and that reports
the release it was launched from. If it does not, the replacement is **stopped before anything else
is started** — or the rollback would contend for ADR 0024's exclusive ownership and lose — the
retained previous runtime is put back, and the command exits `4` with the old version running.

**An operation lock, and it is not `owner.lock`.** `<state>/update.lock` keeps two updaters, or an
updater and an installer, from interleaving; `owner.lock` belongs to the daemon this transaction
drains on purpose. A live holder is refused with exit `10` — ADR 0020's code, reused per ADR 0024
§Exclusive ownership rather than a new one — and a lock whose holder is provably gone is taken over
by the same tuple check and settle-then-read-back that `daemon/lock.ts` uses, because otherwise a
dead updater's lock would block the recovery for ever.

**A durable journal, and a recovery that is commanded rather than automatic.**
`<state>/update.json` names the last completed transition and the retained previous runtime, written
temp → `fsync` → `rename` at every boundary. `daemon status` **reports** an interrupted transaction
and names the command; `xplainer daemon recover` — also `daemon update --recover`, and the first
thing `daemon restart` does — completes it or rolls it back. `status` never repairs. The cost is
stated rather than hidden: on Linux and macOS, an updater that dies between the drain and the
restart leaves nothing running until that command is run, because the daemon exited `0` and `0` is
the portable "do not restart" signal for both `Restart=on-failure` and
`KeepAlive{SuccessfulExit:false}`. Every step between two boundaries is idempotent, so a recovery
**repeats** the interrupted step rather than repairing it. A journal written by a newer release is
preserved and named, never acted on: a newer `format_version` is a rollback signal and not
corruption.

**The source of the new runtime is explicit**: `--from <dir>`, or `--build` to assemble one from
this program's own checkout. Never whatever is on `PATH` — a package manager replaces the *global*
CLI and leaves the pinned copy the supervisor executes exactly where it was, which is the fact this
command exists for.

**A workspace-changing update is refused, and that is this phase's supported class.** Before
anything is staged or drained, `update` requires the installed and incoming runtimes to pin
**identical** `template/package.json` versions — pins, never the template package's own version
string — **and** the installed workspace to verify against both. Otherwise it exits `3` having
written nothing and drained nothing, and names the reinstall path — `setup --workspace` then
`daemon install` — spelled with the **new runtime's own interpreter and entry**, because the
installed launcher execs the old runtime and would re-resolve the old pins. Both clauses are load
bearing: a workspace that satisfies only the incoming runtime passes for a user who has already run
`setup --workspace`, and the rollback target is exactly the runtime it no longer satisfies. Staging
a matching workspace beside the new runtime does not make the update proceed; keeping one payload
transactional is what makes the rollback mean something.

`daemon --help` now lists nine verbs. `daemon status --json` gains an additive `update` field
carrying the journal's state; every existing field, the condition set and the exit codes are
unchanged.
