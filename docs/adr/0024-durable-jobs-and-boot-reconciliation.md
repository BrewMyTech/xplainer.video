# 0024. Render jobs are durable records, reconciled at boot by their exclusive owner

- Status: accepted
- Date: 2026-09-06
- Deciders: @rishavanand
- Settled by: `.omc/plans/ralplan-agent-first-architecture.md` — the RALPLAN-DR plan for the
  agent-first architecture, whose durability finding **L1** this record answers. Consensus at
  round 3: Critic APPROVE, Architect SOUND-WITH-CHANGES with every remaining item folded in.
- Builds on: **[ADR 0008](0008-async-job-model-poll-and-progress-no-agent-webhooks.md)**, which
  fixed the job shape and the five states and deliberately left the queue implementation open, and
  **[ADR 0020](0020-always-running-local-daemon.md)**, which made the local runtime an installed,
  supervised, always-running per-user daemon with a durable state directory. This record decides
  **where job records live, who is allowed to touch them, and what happens to them when the daemon
  dies without warning** — which neither of those records answers and neither contains. Both carry
  dated notes pointing here; neither is rewritten.
- **Mechanisms deliberately left open.** Several decisions below state a *requirement* and name a
  spike that settles the *mechanism*: the storage shape, the ownership primitive, the per-platform
  force of a directory flush and the means of confirming a worker's identity are all **P1-S1**; the
  drain's reach on the three supervisors is **P2-S4** and **P2-S5**. Wherever the text reads
  "Proposed mechanism, to be confirmed by spike …", the decision above it is binding and the
  mechanism inside it is not.

## Context and Problem Statement

`xplainer serve` has no job store. `apps/cli/src/commands/serve.ts` binds the server and returns;
the eight tools are registered and the three asynchronous ones — `explainer_narrate`,
`explainer_still`, `explainer_render` — answer with "not implemented in this phase" payloads
(ADR 0008, §Consequences: "the real job runner lands with roadmap phase 1"). So the question of
where a job record lives is open *and* free right now, and it stops being free the moment the phase-1
runner writes the first one.

[ADR 0020](0020-always-running-local-daemon.md) is what makes the question urgent rather than
academic. A foreground server that a human starts and Ctrl-Cs loses its in-memory jobs when the
human closes the terminal, and the human knows why. A supervised daemon that starts at login,
restarts on crash and is expected to be *simply there* loses them on a Tuesday, three hours into a
render, to an OOM kill nobody saw — and the caller is not a human who can infer what happened. The
caller is an agent holding a `job_id` and a polling loop.

[ADR 0008](0008-async-job-model-poll-and-progress-no-agent-webhooks.md) makes a promise that only
holds if something on disk keeps it: `explainer_render` returns a `job_id` immediately and the agent
polls `explainer_job` until a terminal state. That contract has an implicit clause — **polling
terminates** — and 0008 names it explicitly for the hosted tier ("honouring the contract's implicit
promise that polling *terminates* becomes work someone has to do"). Nothing yet does that work
locally. Without it there are exactly two outcomes after an ungraceful restart, and both are
failures:

- The daemon has no memory of the id, so `explainer_job` answers `404`. The agent has an identifier
  that never existed, for a video whose files may be half-written on disk.
- Or the daemon rebuilds something optimistic from the filesystem and reports `running` for a job
  whose process died at 03:12. The agent polls that state forever. An agent has no intuition that
  tells it "this has been running too long"; it has a loop and a backoff.

Three gaps follow, and they are separable:

1. **Nothing is written down.** Job state is process memory, so it does not survive the process.
2. **Nothing reconciles at boot.** Even with records on disk, a daemon that starts and ignores them
   leaves `running` rows that no longer describe reality.
3. **Nothing owns the state directory.** ADR 0020 gives the daemon a durable state directory and a
   recorded port, and reasons that a second `serve` exits `10` when the port is taken — but that
   check happens at **bind**, which is after a second process would have already read and rewritten
   the first one's records.

ADR 0020 does address the *process*: restart on crash, a circuit breaker, and — in scope for
phase 1 — "a render whose process dies must land in `error` with a bounded log tail, never stay
stuck in `running`". It does not say where that record lives, what re-establishes it after the
process is gone, or what happens to the Chrome and ffmpeg children the dead process left behind.
That is this record.

## Decision Drivers

- **A poll must terminate.** This is the contract ADR 0008 wrote and the property an agent cannot
  work around. Every decision below is subordinate to it: after any restart, every job an agent
  holds an id for must reach a terminal, explained state.
- **Always-on makes restart routine, not exceptional.** Login, logout, reboot, a package upgrade, an
  OOM kill and a crash-restart are all normal events for the daemon ADR 0020 describes. Anything
  that only survives a *graceful* stop survives almost nothing.
- **An agent debugs with `cat`, `ls` and `grep`.** The first consumer of this state is a program
  that reads text. A format it can read without a tool is worth real weight, and this repository has
  already paid for that preference twice (`daemon.json`, `runtime.json`).
- **There is exactly one writer, and that has to be made true rather than assumed.** ADR 0020's "one
  supervised process per user per machine" is a property of the *installed* configuration, not a
  guarantee against a hand-run `xplainer serve` in a terminal.
- **Do not decide what has not been measured.** Round 2 of the settling plan rejected a database for
  a reason that turned out to be false, and round 1 asserted supervisor behaviour that turned out to
  be wrong on all three platforms. Where the measurement has not been done, this record states the
  requirement and names the spike.
- **A wrong kill is worse than a leaked process.** Recovery code runs at the moment of least
  information, on a machine that may have rebooted. It must not do anything irreversible on a guess.

## Considered Options

1. **Keep jobs in memory; let the agent notice.** No store, no reconciliation. `explainer_job`
   answers `404` for an id it has never seen.
2. **Rely on ADR 0020's supervision.** Restart-on-crash plus the circuit breaker, with the job
   contract left as it is: the process comes back, so the "service" is fine.
3. **Durable job records in a single-writer store under the state directory, read and reconciled at
   boot by a process that has first acquired exclusive ownership of that directory.** **Chosen.**
   Two storage shapes remain live under it:
   - **3a. One JSON file per job** in a `jobs/` subdirectory, written temp-then-rename. **The
     proposal.**
   - **3b. `node:sqlite` in WAL mode**, one database file. Held open by spike P1-S1.
4. **An external broker or database** — Redis, Postgres, a queue daemon. The hosted tier's answer
   (ADR 0017, in the private repository) transplanted to a laptop.

## Decision Outcome

**Chosen: option 3.** Job records are durable, they outlive the process that wrote them, and a
starting daemon reconciles them before it accepts a request — after acquiring exclusive ownership of
the state directory.

Options 1 and 2 fail the first decision driver outright. Option 1 makes `404` a routine answer to a
correct id, which turns every restart into an unexplained failure for the caller least able to
interpret it. Option 2 confuses the process being healthy with the *work* being accounted for: a
restarted daemon with no memory is exactly as unhelpful to a polling agent as a dead one, and
ADR 0020's own phase-1 line — a dead render must land in `error`, never stay `running` — is
unimplementable without somewhere to write that `error`. Option 4 is disqualified by ADR 0020's
install story rather than by dislike: the supported install path is `npm`/`npx`, and requiring a
user to run a broker to render a video contradicts "installed once, and simply there".

### Durability: job records outlive the process that wrote them

`serve` persists every job to a single-writer store under the durable state directory ADR 0020
already defines — `${XDG_STATE_HOME:-~/.local/state}/xplainer/` on Linux,
`~/Library/Application Support/video.xplainer/` on macOS, `%LOCALAPPDATA%\xplainer\state\` on
Windows — in a `jobs/` subdirectory. The proposal is a file store: one file per job, not a database.

**The round-2 rationale for that was half false and is withdrawn.** Round 2 argued that a database
"adds a native dependency to a package whose install path is `npx`". Measured: `node:sqlite` is
**built into Node 24.20.0** — an in-memory database opens with no package installed — so SQLite
costs no dependency at all, and an argument resting on that premise cannot stand.

Three narrower reasons survive, and they are preferences rather than proofs:

- **There is exactly one writer by construction** (see §Exclusive ownership below), so the
  transactions a database buys have no contention to resolve.
- **A directory of one JSON file per job is inspectable with `cat` and `ls`** by an agent debugging a
  stuck job. A binary database file is not, and the debugging audience here is a program with a
  shell.
- **A corrupt single record is recoverable by quarantining one file.** A corrupt database page is
  not; it takes the jobs either side of it with it.

Because those are preferences and not measurements, the shape is a spike question rather than a
settled one.

> **Proposed mechanism, to be confirmed by spike P1-S1.** The storage shape is part of what P1-S1
> settles, alongside the ownership mechanism below: whether one JSON file per job under an
> exclusively-owned directory gives the durability and crash behaviour the criteria demand, or
> whether `node:sqlite` in WAL mode does it with less bespoke code. What is **decided** and not open
> is that job records are durable, that they outlive the process that wrote them, and that boot
> reconciliation reads them. This record states the file store as the proposal and names what would
> change its mind: a WAL-mode database that meets the same crash criteria with materially less
> hand-written recovery code wins, and the inspectability argument is then paid for with a
> `xplainer daemon jobs` subcommand rather than with `cat`.

### Exclusive ownership, acquired before anything else

`serve` **acquires exclusive ownership of the state directory first, then reconciles, then binds.**
That ordering is the decision; it is an invariant, not an implementation note.

Round 1 of the settling plan argued that no lock was needed, because "the daemon is one supervised
process per user per machine (ADR 0020) and the recorded port makes a second one exit `10`". The
ordering in that argument is wrong. Reconciliation is the step that *rewrites* other processes'
records — it takes every `queued` or `running` job whose owner it cannot see and marks it `error`.
A second `serve`, started by hand while the supervised daemon is mid-render, would perform exactly
that rewrite and only afterwards discover the port was taken. It would kill the live daemon's jobs
on paper, and quite possibly its children in fact, before exiting.

So: a process that cannot acquire ownership exits `10` **having touched nothing** — no
reconciliation, no rewrite, no signal sent. `10` is ADR 0020's "another process already holds this
machine's runtime", recorded there as the port being taken; ownership failure is the same condition
detected earlier, and reuses the code rather than adding an eleventh one for a user-visible
situation that is identical.

> **Proposed mechanism, to be confirmed by spike P1-S1.** The candidate is an `O_EXCL` lock file in
> the state directory holding pid and boot id, with a liveness check plus takeover of a stale lock.
> What the spike must establish: behaviour on each of the three platforms when the holder was
> `SIGKILL`ed, behaviour on a network or container-shared home directory (where advisory locking and
> `O_EXCL` both have a reputation and neither has a guarantee), and whether an advisory
> `flock`/`LockFileEx` is preferable to a file whose staleness has to be inferred. Until P1-S1
> reports, the *decision* — ownership precedes reconciliation precedes bind — is binding and the
> *mechanism* is not.

### Durability of the write itself

A record is persisted **before** the tool call returns its `job_id`. An agent must never hold an
identifier for a job that no restart can find; returning the id first and writing "shortly after"
reintroduces the `404` this record exists to remove, in a window narrow enough that it will only
ever be hit in production.

Each record is written temp-then-`rename` within the same directory; the temporary file is flushed
before the rename, **and the containing directory is flushed after it**. The second flush is not
decoration. A rename is atomic with respect to a reader, but the directory entry it creates is not
durable until the directory itself is synced, so a crash in between loses a record whose id the
caller has already been given — precisely the failure the first flush was supposed to prevent.

The per-platform guarantee is not uniform: `fsync` on a directory descriptor has different force on
Linux and macOS, and Windows offers no directory handle to sync at all. This record therefore
requires the flush and refuses to assert one behaviour for all three; what each platform actually
promises is P1-S1's third question.

### An unknown format version is not corruption

Every record carries a `format_version`. Round 2 of the settling plan collapsed three different
conditions into one "corrupt" bucket, which would make a **rollback** destroy the jobs it was
rolling back to: a newer daemon writes version *n+1*, the update fails, the previous runtime starts,
reads version *n+1*, and files every live job as corrupt. The three conditions are separate:

- **Unparseable JSON or a failed checksum is corruption.** Quarantine the file to `jobs/corrupt/`,
  report the job as `error` with `error_code: "internal"`, continue. One bad record must never stop
  a daemon from starting.
- **A version newer than this daemon understands is a rollback signal.** Leave the record untouched,
  report the job as `error` with `error_code: "daemon_restarted"` so the agent can retry, and log
  once naming both versions. **Never rewrite a record written by a newer format.** This is the rule
  [ADR 0025](0025-daemon-updates-and-readiness.md)'s rollback step depends on: state written by the
  newer version is preserved rather than deleted.
- **A version older than the current one** is migrated forward, or left alone if the reader is
  compatible. Which of those applies is a phase-1 decision taken with the runner, not a scaffold
  one.

### Boot reconciliation

After acquiring ownership and before binding, `serve` reads every job record. Any job in `queued` or
`running` whose recorded pid is not alive, or whose recorded daemon boot-id differs from this one,
is rewritten to:

- `status: "error"`,
- `exit_code: null`,
- `error_code: "daemon_restarted"`,
- `finished_at` = now,
- and a final `output.lines` entry naming what happened.

The agent's next `explainer_job` poll therefore receives a terminal, explained, retryable answer —
not a `404`, and not a `running` that never advances. The boot-id comparison is what catches the
case a liveness check alone cannot: after a reboot, the recorded pid may well be alive and belong to
something else entirely.

### Scope: every asynchronous job type, and its children

Reconciliation covers all three queueing tools — `explainer_narrate`, `explainer_still`,
`explainer_render` — not renders alone. A stuck narrate is the same failure for an agent as a stuck
render.

And recovering a *record* is not the whole job. The record's orphaned worker processes — Chrome,
ffmpeg, a TTS request in flight — race a retry over the same output directory if they are still
running when the agent tries again. Two writers to one video directory is a corrupted output that
neither process reports.

### A recorded PID is not an identity

Round 2 said a reconciled job's "recorded child pids are killed if alive". On its own that is a
recipe for killing an unrelated process: PIDs are reused, and a daemon restarting after a reboot
finds the numbers it recorded belonging to whatever the machine has started since. On a laptop that
rebooted overnight, the pid that was ffmpeg at 03:12 is somebody's editor at 09:00.

**Killing is therefore conditional on the process still being the one that was recorded**,
established by more than the number: a start-time or boot-id check is a requirement of this record.
The per-platform means is left to P1-S1 — `/proc/<pid>` start ticks, `kqueue`, a Windows process
handle plus creation time, or a process group the daemon created and can signal as a unit — because
the four have different reliability and only one of them is portable.

### What happens when identity cannot be established

Round 2 left two requirements in contradiction: workers "must be terminated or adopted before the
record is marked terminal", and yet a worker of uncertain identity "is left alone and logged"
because "a leaked worker is a smaller failure than a killed stranger". Both cannot hold. This record
picks one and states it: **uncertain ownership isolates the retry; it does not block it, and it does
not license a kill.**

Concretely:

- A reconciled job whose workers were **all positively identified and terminated** is marked
  `error`, and its output directory is reusable.
- A reconciled job with **at least one worker the daemon could not positively identify** is *also*
  marked `error` — an agent must never be left polling — but the record carries
  `workers_uncertain: true`, the final `output.lines` entry names it, and the job's output directory
  is **quarantined**: a retry writes to a fresh directory rather than the one a possible survivor
  may still hold open.

Blocking the retry instead was considered and rejected. It converts an unkillable stray process into
a permanent denial of service for that video, which is a worse failure than one orphaned directory
that a later `uninstall` or prune reclaims. The `workers_uncertain` field and the quarantine naming
are phase-1 work, sized with the reconciler.

### Why this is not covered by P1-7

`docs/ROADMAP.md`'s P1-7 already requires that a job interrupted by `SIGTERM` reports `error` with a
bounded log tail. That is the **graceful** path, and it is the daemon writing its own epitaph while
it still has a working process to write with.

This record covers the path where the daemon never gets to run that code: `SIGKILL`, a panic, an OOM
kill, power loss, `systemctl --user kill -s KILL`. ADR 0020 gives the daemon restart-on-crash and a
circuit breaker, and says nothing about what the *jobs* look like afterwards. ADR 0008 defines the
job shape without deciding where it lives. This record closes both gaps, and the two criteria are
counterparts: P1-7 is the graceful half, P1-12 the ungraceful one.

### Drain on planned restart

A `SIGTERM` starts a drain:

1. Stop accepting new jobs — `/mcp` and `/api/*` answer a named "shutting down" error, not a
   connection reset.
2. Let in-flight jobs reach a checkpoint for at most **20 s**.
3. Hard-stop: kill Chrome and ffmpeg children.
4. Mark anything still `running` as `error` with `error_code: "daemon_shutdown"`.
5. Mark anything still `queued` as `error` with the **same** code. A queued job has no partial
   state, so it is always safe to retry — said here rather than left to be inferred, because an
   agent that cannot distinguish the two cases has to treat both as suspect.
6. Remove `runtime.json` and the socket, exit `0` — which is ADR 0020's portable "do not restart"
   signal on all three supervisors.

Twenty seconds plus teardown fits inside P1-7's 25-second budget, which is unchanged.

> **Proposed mechanism, to be confirmed by spikes P2-S4 and P2-S5.** Round 1 asserted that
> supervisor grace "must exceed" the drain and named `TimeoutStopSec=45s`, `ExitTimeOut = 45` and
> "the equivalent stop grace in the Scheduled Task". Two corrections. First, `TimeoutStopSec` bounds
> how long systemd waits before escalating, but it does **not** by itself give the daemon a private
> 25 seconds: the default `KillMode=control-group` sends the stop signal to **every** process in the
> cgroup, so Chrome and ffmpeg receive `SIGTERM` at the same instant the daemon does. That is not a
> drain; it is a simultaneous execution with a longer countdown. A daemon-controlled drain needs an
> explicit kill strategy — `KillMode=mixed`, so only the main process is signalled and the daemon
> stays responsible for its children. Second, there is no single portable "restart gracefully"
> command: `launchctl kickstart -k` is documented only as kill-and-restart and its graceful
> behaviour is **unverified**, while `Restart-ScheduledTask` is **not** a cmdlet in the standard
> `ScheduledTasks` module, and Windows has no `SIGTERM` for Node to catch. So this record decides
> **one application-level drain operation, reached through a per-platform adapter**, and leaves the
> adapter mechanics to P2-S5 and the systemd keys to P2-S4. What is decided is the drain's
> behaviour and its 20-second cap; what is open is how each supervisor is persuaded to allow it.

## Consequences

- **The store is a new on-disk format that `uninstall` must remove.** This amends the list P2-9
  enumerates in `docs/ROADMAP.md`: the state directory now holds a `jobs/` subdirectory, its
  `corrupt/` quarantine, and the ownership artefact.
- **The reconciler needs a boot id**, which is one more field in `runtime.json`.
- **`runtime.json` is the wrong home for anything that must survive a stop.** ADR 0020 puts
  `recentStarts[]` and the `stalled` flag there, and also records that on Linux `runtime.json` lives
  in systemd's `RuntimeDirectory=`, where "the innermost subdirectories are removed when the unit is
  stopped". The circuit breaker therefore forgets its history on every clean stop — five failed
  starts separated by one `systemctl --user restart` do not trip it. That is a defect in ADR 0020,
  not in this record, and it is named here rather than filed: **crash history moves to the durable
  directory alongside the job store.** ADR 0020's dated note points here.
- **`explainer_list` gains a source of truth that survives restart**, which it did not have. Today
  it could only ever have listed what the current process happened to remember.
- **`error_code` is `null` until the phase-1 job runner exists.** The field is added to
  `explainer_job`'s output schema now, because `packages/protocol` is published for the first time
  in phase 1 and after that a required field is a breaking change for every consumer. Nothing writes
  a non-null value until P1-12. Recording that here means a future reader finds a required field
  with no writer as a **decision** rather than as a bug.
- **Retention, retry and leftover artefacts are open, and deferred to phase 1 with the runner:** how
  long terminal job records are retained and who prunes them; whether a reconciled job is
  auto-retried or only reported (this record says **reported** — idempotency of a manual retry is
  the runner's problem, and an automatic retry of a job whose workers may still be alive is the
  collision this record just spent a section avoiding); and who owns the partial audio and video
  artefacts a killed render leaves in a video's directory.

### Extending the `error_code` enum — the policy lives here, where the enum lives

`packages/protocol/schemas/job-error-code.json` is a closed `string` enum with seven initial
members: `daemon_restarted`, `daemon_shutdown`, `toolchain_missing`, `render_failed`, `tts_failed`,
`cancelled`, `internal`. A contributor adding a member opens **this** record, because this is where
the field, the enum and the `null`-until-phase-1 consequence live.

What this record states:

- The enum is deliberately **small and general**. It exists so an agent can branch on a
  machine-readable reason without parsing English out of `error`, which stays the human-readable
  half.
- **Adding a member is expected**, not exceptional. The seven were chosen before the job runner
  exists, and the first real implementation will want an eighth.
- **The schema and its generated code change in one commit.** That is not a new rule; it is AC-9c,
  enforced by regenerating and running `git diff --exit-code`.

What this record **does not** state, because it is not yet decidable, is **whether adding a member
is a minor or a breaking contract change.** That depends on the compatibility predicate the shim
uses and on whether generated consumers can tolerate an unknown value at all — and measured, this
repository's Python codegen turns a closed enum into a `StrEnum` that Pydantic rejects unknown
members against, so tolerance is not free and may not be reachable without a codegen change. Both
questions belong to spike **P1-S3**, and
[ADR 0025](0025-daemon-updates-and-readiness.md) carries the analysis and the options. This record
points at it and declines to pre-empt it: an extension policy written here before the predicate is
chosen would be a decision taken in the wrong record on the strength of a guess.

## Phase placement

Stated here so the split is not inferred from the roadmap alone:

- **Phase 1 (P1-12, with spike P1-S1):** exclusive ownership, the job store, the durable write, the
  boot reconciler, `workers_uncertain` and output-directory quarantine.
- **Phase 2 (P2-12, with spikes P2-S4 and P2-S5):** the supervisor grace keys and kill strategy, and
  the per-platform drain adapters — because that is the phase where `xplainer daemon install` and
  the supervisor artefacts exist at all.

## What this record does not decide

- **The storage shape**, the **ownership primitive**, the **per-platform force of a directory
  flush** and the **means of confirming a worker's identity**. All four are P1-S1's, and all four
  are questions of mechanism under decisions that are binding.
- **The contract-version predicate, the readiness signal and the update sequence.** Those are
  [ADR 0025](0025-daemon-updates-and-readiness.md), which cites this record's drain.
- **Anything about the hosted tier's queue.** ADR 0008 keeps both tiers behind one contract, and the
  hosted queue lives in the private repository. Nothing here applies to it.
- **Whether a cancel tool should exist.** `cancelled` is in both enums and there is still no
  `explainer_cancel` in the eight tools; ADR 0008 already records that adding one is a protocol
  change, and this record does not make it.
