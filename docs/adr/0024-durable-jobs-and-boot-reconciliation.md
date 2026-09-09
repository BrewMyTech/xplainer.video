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

## Note, 2026-09-06: P1-S1 settled

Spike **P1-S1** has reported. This note records the four mechanisms the body above marks
*proposed*, each with the measurement that produced it. It amends nothing: every decision above —
ownership precedes reconciliation precedes bind, records are durable and outlive the process that
wrote them, the write is durable before the `job_id` is returned, and a recorded pid is not an
identity — stands exactly as written. What follows is the mechanism under each.

The evidence is one run of [`apps/cli/spikes/p1-s1-ownership.mjs`](../../apps/cli/spikes/p1-s1-ownership.mjs),
committed with this note. It is a **check, not a demonstration**: it exits non-zero if any
ownership expectation fails, so a later change that breaks one is caught by running it rather than
by reading it. The run quoted below is `darwin/arm64`, Node v24.20.0, libuv 1.52.1, APFS on the
internal SSD, 2026-09-06, and it exited `0`. **Linux and Windows were not measured.** Where this
note speaks about them it cites their documentation and says which sentences are unmeasured.

### Ownership

**Decided: an `owner.lock` file in the state directory, created with `O_EXCL`, carrying the
identity tuple; staleness is inferred from that tuple, and a takeover is confirmed by read-back
before it is believed.**

The record is `{format_version, pid, start_time, boot_nonce, hostname, acquired_at}`, written
through `fs.openSync(path, "wx")` — `O_CREAT|O_EXCL|O_WRONLY` — then `fsync`ed, with the containing
directory `fsync`ed after it. Acquisition is:

1. `O_EXCL` create. Success is ownership, and it is the only path with no inference in it.
2. `EEXIST` → read the lock and classify the holder by the **tuple**, never by the pid alone.
   Alive-and-matching refuses with exit `10` **having written nothing**. Three conditions are
   stale: not alive; alive but with a different start time, which is pid reuse; and zero-length,
   which is an acquirer that died between the `O_EXCL` and the write.
3. Takeover of a stale lock: re-read and confirm the bytes are unchanged, `unlink`, `O_EXCL` create
   again, then wait 100 ms, read back, and check the `boot_nonce` is still ours. A process that
   lost that race exits `10` — and because ownership precedes reconciliation, it exits before it
   has rewritten anything.

**Why a lock file and not an advisory lock.** ADR 0024's spike text asks whether `flock`/`LockFileEx`
is preferable to a file whose staleness has to be inferred. It would be — a kernel-released lock
needs no inference at all — but Node core exposes neither, so it is reachable only through a native
dependency, and ADR 0020 makes `npx` the supported install path. The price of inference is step 3's
100 ms settle, paid only on the crash-recovery path.

The six scenarios, each in its own state directory and each run in a child process so the exit code
is the real one:

```text
  [A] a fresh state directory: O_EXCL creates the lock
      [try 98755] O_EXCL create succeeded; directory flush after it: ok
      [try 98755] outcome=acquired
    PASS  exit code: got 0, wanted 0
      lock file:
      { "format_version": 1, "pid": 98755, "start_time": "Sun Sep  6 19:07:22 2026",
        "boot_nonce": "e9da686f-1757-499f-b1bc-359897e0a421",
        "hostname": "Rishavs-MacBook-Pro.local", "acquired_at": "2026-09-06T13:37:22.689Z" }

  [B] a second acquirer while the holder is alive: refused, and it wrote nothing
      [try 98823] O_EXCL create refused with EEXIST — inspecting the holder
      [try 98823] holder: pid 98799 is alive and started "Sun Sep  6 19:07:22 2026"
      [try 98823] refusing with exit 10, having written nothing
    PASS  exit code: got 10, wanted 10
    PASS  state directory unchanged: got "owner.lock size=230 mtimeMs=1788701842740.5764
          sha256:6c3d7d3eeb2631a7", wanted "owner.lock size=230 mtimeMs=1788701842740.5764
          sha256:6c3d7d3eeb2631a7"
    PASS  the holder was still alive throughout: got null, wanted null

  [C] the same directory after the holder is SIGKILLed: taken over
      holder exit: code=null signal=SIGKILL
    PASS  the holder died by SIGKILL, not on its own: got "SIGKILL", wanted "SIGKILL"
      [try 98871] holder: pid 98799 is not alive
      [try 98871] took over the stale lock; directory flush after it: ok
      [try 98871] read-back after 100 ms confirms the lock is ours
    PASS  exit code: got 0, wanted 0

  [D] a lock naming a live pid whose start time does not match: pid reuse, taken over
      [try 98943] holder: pid 98752 is alive but started "Sun Sep  6 19:07:22 2026",
                  not "Thu Jan  1 00:00:00 1970" — the number was reused
    PASS  exit code: got 0, wanted 0

  [E] a lock naming the same live pid AND its real start time: refused (control for D)
      [try 98995] holder: pid 98752 is alive and started "Sun Sep  6 19:07:22 2026"
    PASS  exit code: got 10, wanted 10

  [F] a zero-length lock — an acquirer that died between O_EXCL and the write: taken over
      [try 99044] holder: zero-length lock: an acquirer died between O_EXCL and the write
    PASS  exit code: got 0, wanted 0
```

`[B]` is the criterion this record cares about most: the refusing process hashed the state directory
before and after itself, and the size, mtime and SHA-256 of every file were identical. `[D]` and
`[E]` are the pair — same live pid, opposite verdicts — that show the identity is the tuple and not
the number.

**Still open, and honestly so.** ADR 0024's spike text also asks how `O_EXCL` behaves on a network
or container-shared home directory. **That was not measured** — this run had no NFS or SMB mount —
so it stays open. The phase-1 store therefore treats the state directory as local storage and
claims nothing about a shared home; whoever needs that answer runs the same script against such a
mount.

### Storage shape

**Decided: one JSON file per job under `jobs/`, written temp-then-`rename` — option 3a above
stands, and `node:sqlite` is rejected.**

Measured, 200 records of the realistic shape, on the machine named above:

| Shape | Per durable record |
|---|---|
| JSON, temp-then-rename, no flush | 0.166 ms |
| JSON, `fdatasyncSync` on the file | 4.245 ms |
| JSON, `fsyncSync` on the file | 4.073 ms |
| **JSON, `fsyncSync` on the file and then the directory** | **7.339 ms** |
| **`node:sqlite` WAL, `synchronous=FULL`, `fullfsync=ON`** | **3.684 ms** |
| `node:sqlite` WAL, `synchronous=FULL`, `fullfsync=OFF` (the default) | 0.072 ms |
| `node:sqlite` WAL, `synchronous=NORMAL` (the default) | 0.019 ms |

The two bold rows are the only fair comparison, and getting to them was itself a finding: SQLite's
unix VFS calls plain `fsync(2)` unless `PRAGMA fullfsync` is on, while Node's `fsyncSync` on macOS
is already `fcntl(F_FULLFSYNC)` (see §Write durability). Timed against each other with the pragma
off, a `node:sqlite` insert looks 100× faster than a JSON write; it is doing a weaker flush, which
on Apple's own account may never reach the platters.

Two more measurements, same run:

- **Listing**, which is what `explainer_list` costs: `readdir` plus read plus parse over 200 JSON
  files is **4.3 ms**; one indexed `SELECT` over the same 200 rows is **0.4 ms**.
- **Crash consistency**, which is the only part of this that is about correctness: a child announced
  each id only once its write had returned, then `SIGKILL`ed itself. Both shapes recovered
  **20 of 20**. WAL bought no measured crash advantage over temp-then-rename with both flushes.

**The reason.** At equal durability the file store costs 3.7 ms more per durable record. A job takes
on the order of three durable writes — enqueue, start, finish — so the choice is worth about 11 ms
per job, against renders measured in tens of seconds. Nothing in the timings decides this, and the
crash test declines to decide it either. What decides it is a rule already written above:
§An unknown format version is not corruption requires that a record written by a **newer** daemon is
left untouched and reported `daemon_restarted`, because ADR 0025's rollback step depends on newer
state surviving a downgrade. That rule is **per record**, and SQLite has one schema for the whole
file: a newer daemon that migrates the table has already changed state the rolled-back daemon must
still read, and cannot decline to touch. One file per job makes "leave this one alone" expressible;
one database does not.

The body above named its own change-of-mind condition — a WAL database that meets the same crash
criteria "with materially less hand-written recovery code". Measured, it is not materially less.
Ownership, boot reconciliation, the identity tuple and the bounded log tail are the same code either
way. SQLite removes exactly one branch, the torn-write case that scenario `[F]` exercises, and adds
schema migration plus the wider corruption blast radius the body already names.

**The rejected option's strongest point, stated rather than buried:** at equal durability
`node:sqlite` WAL is almost exactly twice as cheap per durable record — 3.684 ms against 7.339 ms —
because one commit is one `F_FULLFSYNC` where the file store needs two, one for the file and one for
the directory entry. It also needs no bespoke torn-write handling at all; `[F]` is precisely the
class of bug the file store now has to write and keep tested. If the runner ever issues enough
durable writes for 3.7 ms each to show up in a job's wall-clock time, that is the number to reopen
this on, and `node:sqlite` costs no dependency to reach for.

### Write durability

**Decided: temp file → `fsync` the file → close → `rename` → `fsync` the containing directory, on
every platform, with the directory flush attempted and its failure recorded rather than thrown.**

What each platform actually promises:

- **Linux.** `fsync(2)` on the file is not enough on its own:
  "Calling `fsync()` does not necessarily ensure that the entry in the directory containing the file
  has also reached disk. For that an explicit `fsync()` on a file descriptor for the directory is
  also needed."
  ([`fsync(2)`, man7.org](https://man7.org/linux/man-pages/man2/fsync.2.html)) Both flushes are real
  and both are required. **Unmeasured here** — the spike ran on macOS — though the script's Linux
  branch reads `/proc/<pid>/stat` and runs unchanged there.
- **macOS.** Apple's `fsync(2)` is explicitly *weaker* than Linux's: "while `fsync()` will flush all
  data from the host to the drive […] the drive itself may not physically write the data to the
  platters for quite some time", and it names `F_FULLFSYNC` as the answer
  ([`fsync(2)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fsync.2.html)).
  `F_FULLFSYNC` "does the same thing as `fsync(2)` then asks the drive to flush all buffered data to
  the permanent storage device […] acts as a barrier […] currently implemented on HFS, MS-DOS (FAT),
  Universal Disk Format (UDF) and APFS file systems"
  ([`fcntl(2)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fcntl.2.html)).
  **Measured, this costs nothing extra to get from Node:** libuv's `uv__fs_fsync` on `__APPLE__`
  issues `fcntl(F_FULLFSYNC)` and falls back to `F_BARRIERFSYNC` and then `fsync`
  ([`src/unix/fs.c`](https://github.com/libuv/libuv/blob/v1.x/src/unix/fs.c)), and Node 24.20.0
  bundles libuv 1.52.1. The timings corroborate the source: `fdatasyncSync` costs the same as
  `fsyncSync` (4.245 ms against 4.073 ms), which is only true if both take that one path, and 4 ms
  is a device-cache flush — a page-cache-only write measured 0.166 ms. So the store gets Apple's
  strongest guarantee with no native module and no `fcntl` binding, and there is **no cheaper flush
  available from Node on macOS** if one were ever wanted. `fsyncSync` on a *directory* descriptor
  also succeeds on APFS (`ok` in every scenario above) and costs 3.27 ms per record on top of the
  file's 4.07 ms.
- **Windows.** There is no directory handle to sync. `FlushFileBuffers` "flushes the buffers of a
  specified file and causes all buffered data to be written to a file", and the handle must have
  `GENERIC_WRITE` access
  ([`FlushFileBuffers`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers));
  Win32 documents no equivalent for a directory handle. **Unmeasured** — no Windows machine was in
  this spike.

**What the store therefore does.** The same four steps everywhere, because three of them are
identical and the fourth degrades cleanly: the directory flush goes through a helper that opens the
directory, `fsync`s it, and **returns a string instead of throwing**, so a platform that refuses is
a recorded fact and not a crashed daemon. On Linux and macOS it returns `ok` and the guarantee is
complete. On Windows it will fail at the open, and the daemon logs that once at startup as a known
platform limitation. Windows then gets its durability a different way: the `job_id` is appended to a
single `jobs/index.jsonl` that is flushed with `FlushFileBuffers` before the tool call returns —
appending to a file that already exists creates no directory entry, so it needs no directory flush
to be durable. That is the Windows plan, not a measurement, and it is confirmed when phase 1's
Windows half is built.

### Process identity

**Decided: the identity of a recorded process is the triple (pid, process start time, daemon boot
id) — never the pid.**

Per platform, and what each costs:

- **macOS:** `ps -o lstart= -p <pid>`. Resolution is **one second**; the token is a formatted date.
- **Linux:** field 22 of `/proc/<pid>/stat`, the start time in clock ticks since boot — finer
  (1/100 s at the usual `USER_HZ`) and immune to a locale-formatted date. Implemented in the script,
  unrun here.
- **Windows:** the process creation time — `Win32_Process.CreationDate`, or `Process.StartTime` —
  at 100 ns. Unmeasured.

The macOS probe, from the run above:

```text
  $ ps -o pid=,lstart= -p $$        (this process, pid 98752)
      98752 Sun Sep  6 19:07:22 2026
  ps exit status: 0
  identity token this platform yields: "Sun Sep  6 19:07:22 2026"
  platform: darwin  node: v24.20.0  libuv: 1.52.1
  a child that has already exited (pid 99555): isAlive=false, token=null
```

Two measurements shape how the store uses this. First, **reading the token is a process spawn and
costs about 4.5 ms** — found the hard way, when an earlier revision of the script called it once per
record and made every storage-shape number 4.5 ms per record, hiding the thing being measured. So
the token is read once per acquisition and once per worker at reconciliation, **never per write**.
Second, **an exited pid yields `isAlive=false` and `token=null`**, so a null token is
indistinguishable from "gone" and must never on its own license a kill.

**`workers_uncertain: true` is set on a reconciled job when, for at least one recorded worker, the
daemon can decide neither "this is the process I recorded" nor "this is a stranger".** Exactly two
cases reach that:

1. the pid is alive and its start token **cannot be read** — `ps` fails, or the process belongs to
   another user and the platform refuses; and
2. the **record carries no start token** for that worker, because the daemon that wrote it could not
   read one.

It is **not** set when the pid is not alive; when the pid is alive and the tokens **differ**, which
is a positive identification of a stranger and is certain (scenario `[D]`); or when the recorded
daemon boot id differs from this boot, because then nothing recorded can still be running and there
is nothing to be uncertain about. On this spike's evidence `workers_uncertain` is the exception
rather than the rule: across the six scenarios the same classifier returned a definite verdict every
time, and the only input that maps to case 2 is `[F]`, a record with no identity in it at all.

The same "no identity recorded" input has **opposite** safe defaults in the two places it is used,
which is worth stating because it looks like an inconsistency and is not. For the **lock**, no
identity means *take it over*: a lock nobody can prove is held would otherwise block the daemon for
ever. For a **worker**, no identity means *do not kill, set `workers_uncertain`*: a process nobody
can prove is ours is a stranger, and §What happens when identity cannot be established already
prices that at a quarantined output directory rather than a kill.

One residual risk is named rather than closed. When the tuple **matches**, macOS's one-second
resolution cannot exclude a pid that was recycled to a process started in the same wall-clock
second, which on this platform would take a full traversal of the pid space inside that second. The
daemon does not attempt a stronger guess; §A recorded PID is not an identity's own driver — a wrong
kill is worse than a leaked process — is what makes quarantine the answer, and the finer Linux and
Windows tokens narrow the window on those platforms rather than on this one.

## Note, 2026-09-06: P1-S3 settled — §Extending the `error_code` enum is closed

Spike **P1-S3** has reported, and this note closes the one question
§Extending the `error_code` enum left open: **whether adding a member is a minor or a breaking
contract change.** The rest of that section is unchanged and remains the policy — the enum stays
small and general, an addition is expected rather than exceptional, and the schema and its generated
code change in one commit.

**Decided: adding an `error_code` member is a minor contract change.** It moves the minor component
of `schemas/manifest.json`'s `version`; it does not move the major; and under the major-compatible
predicate P1-S3 chose, a shim already attached to a daemon that gained a member stays attached.

**Why, and what makes it true rather than merely declared.** This section declined to answer in
2026-09-06's original text because the answer depended on two things it did not own: the shim's
compatibility predicate, and whether a generated consumer could tolerate a value it had never heard
of. Both are now settled in
[ADR 0025 §Note, 2026-09-06: P1-S3 settled](0025-daemon-updates-and-readiness.md), which carries the
measurements. The short form:

- The predicate is **major-compatible**, so a minor bump does not exit `8` on a live agent session.
  Under an exact predicate the "minor" classification would have been a lie in practice: every
  addition would have severed every attached shim until its daemon restarted.
- Unknown-value tolerance turned out to be **achievable in both languages**, at a measured codegen
  cost. `schemas/manifest.json` gains an `open_enums` table naming `JobErrorCode` and its fallback,
  and `scripts/codegen.mjs` emits a decoder from it in each language: an `enum._missing_` hook on
  the generated Python `StrEnum`, and a `toJobErrorCode()` function beside a frozen
  `JOB_ERROR_CODE_VALUES` tuple in TypeScript, where the union type alone gave a consumer nothing to
  call. An unrecognised member decodes to `internal`; a non-string still fails.

**Why not breaking.** That was the live alternative, and it is refused on this record's own evidence:
§Extending the `error_code` enum states that "adding a member is **expected**, not exceptional" and
that "the first real implementation will want an eighth". Classifying the most routine change the
enum has as a major bump would make every one of them an interruption for every agent session on the
machine.

**What a contributor adding a member does now.** Add it to `schemas/job-error-code.json`, run
`pnpm --filter @xplainer/protocol codegen`, commit the regenerated output in the same commit
(AC-9c), and move the **minor** component of `schemas/manifest.json`'s `version`. Nothing else: the
decoders are generated, so no consumer has a list to update, and the fallback means a consumer built
against the older contract keeps parsing.

**What is deliberately not bought.** The fallback discards the unrecognised string — an agent
holding a decoded value sees `internal` and cannot recover `disk_full` from it. That is the price of
a closed, greppable type, and it is affordable only because `error` is never rewritten and carries
the human-readable half of the same failure. §Extending the `error_code` enum's first bullet already
draws that line between the two fields; this note relies on it.

## Note, 2026-09-07: `workers_uncertain` is narrower than US-005 asked for, and that is this record

US-005 criterion 4 was worded "a worker that does not match is left alone and the record carries
`workers_uncertain: true`"; `apps/cli/src/daemon/reconciler.ts:186-197` sets the flag only when
identity cannot be *read*, and leaves a positively identified stranger alone with no flag — which is
what §Note, 2026-09-06 §Process identity decides above ("it is **not** set … when the tokens
**differ**, which is a positive identification of a stranger and is certain"), and both branches are
tested at `reconciler.test.ts:153` and `:182`. The code follows this record and not the criterion's
looser wording; the deviation simply had not been written down.

## Note, 2026-09-07: ownership of the store is not ownership of the workspace — one writer per video

§Scope names the hazard this note closes: "The record's orphaned worker processes … race a retry
over the same output directory … Two writers to one video directory is a corrupted output that
neither process reports." §Exclusive ownership was the answer, and while the daemon was the only
thing that ran jobs it was a complete one — the lock on the state directory implied the workspace,
because the default workspace root is *inside* that directory and only its owner ran a worker.

**Phase 1 broke that implication, deliberately.** `xplainer mcp` — the `npx -y @xplainer/cli mcp`
bundle path, with no daemon behind it — was given the real worker registry over
`resolveWorkspaceRoot(stateDir)`, the same root a running daemon resolves, while explicitly **not**
taking `owner.lock`: a bundle entry that refused to start because a daemon happened to be running
would defeat its own reason to exist. So a daemon and any number of stdio sessions can hold the same
workspace at once. Each has its own job store, so the *records* never collide; the *files* are one
set, and `out/<slug>/explainer.mp4` and `public/<slug>/timings.json` had no exclusion at all.

**Decided: the exclusion is keyed by the video, not by the process.**
`<workspace>/locks/<slug>.lock` (`apps/cli/src/daemon/video-lock.ts`) is taken when a job leaves the
queue and released when its record reaches a terminal state. Three consequences are the decision:

- **It is taken in the worker factory, last.** The factory is already ADR 0018's layer 4 — the last
  gate before Chrome starts — and it is the only in-process moment between "queued" and "spawned".
  Taking it *after* every refusal above it is what stops a job that is refused for a missing caption
  file from leaving behind a lock that would then refuse the retry it just asked for.
- **It is released in `finish()`**, the single function every terminal outcome passes through —
  clean exit, non-zero exit, an unspawnable command, a cancellation, a drain — because a lock a
  crashed render never gave back would refuse that video for the life of the daemon, which is worse
  than the race it prevents. A `SIGKILL`ed process leaves a stale file, and the next acquirer
  classifies the holder with the same tuple §Note, 2026-09-06 §Ownership settles and takes it over.
- **A held video fails one job, not the process.** `VideoBusyError` names the holder and says to
  retry, and the runner turns it into an `error`/`internal` record an agent can poll to a
  conclusion. Refusing to *start* would have been the ownership answer, and it is the wrong one
  here: the second caller is a legitimate agent on a machine that supports several.

**What this does not decide.** The direct, synchronous tools — `explainer_create`,
`explainer_put_source`, `explainer_put_media` — are not behind this lock. They are millisecond file
writes rather than minute-long process groups, and the interleaving they can produce is one an agent
can already produce inside a single daemon by calling `put_source` during its own render; that is a
question about tool ordering, not about two processes, and it is left open here rather than answered
badly. The `requests/` document is likewise still keyed by job id per store, so two stores can
overwrite one another's; `agreedSlug()` turns that into a named, retryable failure rather than a
wrong render, and moving those documents into the store that owns them is phase 2's to do.

## Note, 2026-09-08: P2-S5 settled — one drain, three restart adapters, and `kickstart -k` measured

Spike **P2-S5** has reported. It answers the mechanism §Drain on planned restart left open — "how
each supervisor is persuaded to allow it" — and it changes nothing this record *decides*: the drain
is still the same six steps, still capped at 20 s, and still ends in exit `0` as the portable "do
not restart" signal. The block above marked **Proposed mechanism, to be confirmed by spikes P2-S4
and P2-S5** is answered here rather than edited.

**Decided: one application-level drain reached over the IPC listener, and three adapters that
differ only in how the supervisor is asked to start again.** On Linux `KillMode=mixed` is required
and its reason is now measured rather than argued; on macOS `launchctl kickstart -k` is **graceful**
— it sends `SIGTERM` first and waits — so it is the counterpart of `systemctl --user restart` and
not the kill this record called it; on Windows the route over the named pipe is the mechanism with
no fallback beneath it.

| | ask for the drain | response to exit `0` | restart command |
|---|---|---|---|
| Linux | `POST /api/daemon/drain` over the socket, or `SIGTERM` to the main process | `Restart=on-failure` does not restart | `systemctl --user start xplainer` |
| macOS | the same route over the same socket | `KeepAlive{SuccessfulExit:false}` does not restart | `launchctl kickstart gui/$(id -u)/video.xplainer.daemon` |
| Windows | the same route over the named pipe | the task ends | `schtasks /Run /TN "\xplainer\<user>-daemon"` |

The measurement is `apps/cli/spikes/p2-s5-drain.mjs`, which exits `0` only when every expectation
holds and prints the numbers quoted below. It ran on 2026-09-08 against **macOS 26.5** in
`gui/501` (13/13) and against **systemd 252 (252.39-1~deb12u2)** on `linux/arm64` (11/11) inside
`infra/e2e/Dockerfile.systemd` — the image spike P2-S4 already builds, reused rather than
duplicated — booted `--privileged --cgroupns=host` on OrbStack 29.4.0, Node v24.20.0 throughout.
Every figure below comes from one run of it; across three consecutive runs the millisecond figures
moved by a few ms and the counts did not move at all.

**The spike carries its own listener, and that is why it could run at all.** The route it asks for,
`POST /api/daemon/drain`, is built by **T13, two batches later**. Measuring the supervisors through
a route that does not exist yet would have meant either deferring the spike or measuring only Linux,
which is the one platform with a signal fallback and therefore the one the question is least about.
So the harness binds its own unix socket — a named pipe on Windows — with a fixture route that runs
a **fake** drain: sleep, kill the child, exit `0`. Every question below is about the *supervisor*,
and none of them needs the production route. The fixture is written into a scratch directory at run
time and never ships. **T13 proves these same three adapters against the real route.**

### Linux: `KillMode=mixed`, and what the default actually does

The claim this record made without measuring it — that `KillMode=control-group` signals Chrome and
ffmpeg at the same instant as the daemon — holds exactly. Two units differing in one key, each
restarted with `systemctl --user restart` while the fixture held a child that records every signal
it receives:

```
KillMode=mixed           daemon: bound → SIGTERM → drain → child killed → exit 0
                         child:  started                      (no signal, ever)
KillMode=control-group   daemon SIGTERM at 1788811452701
                         child  SIGTERM at 1788811452701      (skew 0 ms)
```

So `mixed` is not a preference: under the default the drain is not a drain, because the processes it
exists to shut down cleanly are already dying. The restart itself waited — 1213 ms against a 1200 ms
drain — which is the other half of the claim, and the unit came back up behind the same command.

Three more rows, each measured: **`Restart=on-failure` declines an exit `0`** — after the route
drain the unit sat at `ActiveState=inactive Result=success MainPID=0 NRestarts=0` for a five-second
window, well above `RestartSec=2` — while an exit `7` was restarted 2230 ms later with
`NRestarts=1`, so the negative discriminates rather than describing a unit that never restarts
anything. **`SIGTERM` to the main process reaches the same drain**, which is the Linux row's second
half and exists on neither other platform. And **`TimeoutStopSec` supplies escalation, not a
drain**: a 2 s budget against an 8 s drain returned in 2240 ms with `Result=timeout` and the drain
unfinished, which is why the shipped `TimeoutStopSec=45s` has to exceed the 20 s cap rather than
implement it.

### macOS: `kickstart -k` is graceful, and `ExitTimeOut` is what bounds it

This record wrote that `launchctl kickstart -k` "is documented only as kill-and-restart and its
graceful behaviour is **unverified**". It is now verified, and the answer is the opposite of what the
name suggests:

```
launchctl kickstart -k gui/501/<label>   returned after 1211 ms      (a 1200 ms drain)
the old instance's record: bound → signal(SIGTERM) → drain_started → drain_completed → exit 0
```

It sends `SIGTERM`, the drain runs to completion, **and the command itself blocks until the process
is gone** before starting the replacement. The grace is bounded by `ExitTimeOut`, measured by
shortening it: with `ExitTimeOut=3` against an 8000 ms drain the command returned in 3012 ms and the
old instance's record stops at `drain_started` — killed mid-drain. So the plist's **`ExitTimeOut=45`
is the macOS counterpart of `TimeoutStopSec=45s`**, and it is what has to exceed this record's 20 s
cap. `kickstart -k` is therefore a legitimate supervisor-initiated restart on macOS, the analogue of
`systemctl --user restart`, and not merely a kill.

`kickstart` **without** `-k` is a different command and both are needed: on a running job it
returned `0` in 4 ms and did nothing at all — same pid, still serving — which is exactly what makes
it the clean *start* half after a drain the daemon has already taken. `KeepAlive{SuccessfulExit:
false}` does not restart an exit `0` (`state = not running, last exit code = 0`, observed for five
seconds against a probe `ThrottleInterval` of 1), and does restart an exit `7` 1096 ms later.

**Two smaller measurements that cost time to rediscover.** `launchctl bootout` returns **before** the
job has exited: the spike's own case asserts it, and measured it returning in 5 ms with the label
still in the domain, which left it 1205 ms later when the drain it had just triggered finished. A `bootstrap`
issued in that gap fails with `Bootstrap failed: 5: Input/output error` — hit while building this
spike, which reads like a malformed plist and is not one — so anything that replaces a loaded agent
must wait for the label to leave the domain first; **T12's uninstall and reinstall paths are where
that matters**. Separately, and also found the hard way rather than asserted: a unix socket path
much over 100 bytes fails the bind with `EINVAL` on macOS, which is a constraint on where
`--socket` (T7) may point and not merely on where this spike puts its own.

### Windows: the design, and honestly not a measurement

**No Windows host was reachable from the session that ran this spike, so the Task Scheduler row is
not measured.** It is the `[runner]` half: the spike carries a Windows arm written from the
`schtasks` documentation and this plan's adapter table, and `windows-latest` is where it becomes
evidence. What it will assert is the same shape as the other two — the fixture route runs the drain
over a **named pipe**, the task ends on exit `0` and nothing brings it back on its own, and
`schtasks /Run /TN "\xplainer\<user>-daemon"` starts it again — plus the fact that gives Windows a
drain at all: Node maps `SIGTERM` there to `TerminateProcess`, so the process dies with no handler
run and no drain, and the route is the mechanism rather than a fallback. Until that job has run, the
Windows row of the table above is a design and the other two are measurements, and this note says so
rather than letting the table imply otherwise.

### What this note does not decide

The production drain route is **T13's**, and the six steps §Drain on planned restart lists are
unchanged by anything here — this spike measured supervisors, not the drain's own behaviour, and its
fixture is a sleep. `AllowHardTerminate`, the Job Object that closes `process-group.ts`'s
grandchild gap, and the circuit breaker's measured boundary are their own stories (T14) and are not
settled by this measurement.

## Note, 2026-09-08, later the same day: the two things the P2-S5 note deferred

The note above closes with a §What this note does not decide that names three things: the production
drain route, "the Job Object that closes `process-group.ts`'s grandchild gap", and "the circuit
breaker's measured boundary". The first is built and its three adapters are proved against the real
route rather than the spike's fixture. The other two are settled here, because both belong beside
the drain rather than in a record of their own, and because one of them corrects a number this record
wrote as prose.

**The Windows Job Object, and what it closes.** `process.kill(-pid)` is a POSIX idiom Node does not
implement on `win32`: the pid alone is signalled and every grandchild is left, which on this project
means an orphaned `chrome.exe` after each logoff. That was a documented gap while phase 1 did not
target Windows. Windows' own answer to "these processes are one unit" is a **Job Object** with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`: every process in the job dies when the last handle closes, and
a process created by one already in the job joins it automatically. **Node cannot create one** — there
is no Job Object API in the runtime and this project ships no native addon — so the handle is held by
a keeper process, `powershell.exe -EncodedCommand`, which `Add-Type`s four `kernel32` entry points,
creates the job, assigns the worker, sweeps `Win32_Process` for descendants that already existed
(because `AssignProcessToJobObject` does not reach back to children made before the assignment, and
the keeper takes a few hundred milliseconds to start), and then waits. Killing the keeper takes the
tree; the keeper outliving a killed worker closes the job a moment later and takes the survivors.
Two facts make it sound rather than lucky: jobs have been **nestable** since Windows 8 and Server
2012, so a process a hosted runner or a Scheduled Task already put in a job can still be assigned to
ours; and `-EncodedCommand` is used rather than `-Command` because the script is multi-line and
quoted, and a command line assembled around that is a quoting bug waiting to be written. **This one
is proven on a runner**: `process-group`'s own suite ran green on `windows-latest` in the proof round
of 2026-09-08.

**The breaker's boundary is 30,000 ms, inclusive, and it is measured against the run's own end.**
This record's §Consequences moved crash history to the durable directory beside the job store, which
is where `recentStarts[]` lives. What the note adds is the predicate over it. The boundary is
**inclusive** — 30,000 ms is fast and 30,001 ms is not — which matters because launchd's
`ThrottleInterval` is 30 s and therefore sits *exactly* on it, and because Task Scheduler's
`<RestartOnFailure>` has a one-minute schema minimum and therefore sits outside it. Those two numbers
are why the window must be measured against **each run's own recorded end** rather than against the
next run's start: measuring the gap between starts measures the supervisor's retry cadence, and under
two of the three supervisors that cadence is at or beyond the boundary, so the breaker could never
latch at all. Five consecutive fast failures latch, and the daemon then exits `0` — the same portable
"do not restart" signal the drain above ends with, which is why the two belong on one record.

The rule for a start that recorded **no** end, the validation that makes a backward clock step reset
the streak instead of counting it, and the residual that validation still leaves open are decided in
[ADR 0027](0027-relocatable-runtime-artefact-and-the-supervisor-switch.md) §D6, together with the
identity tuple each start persists so that a later start can establish the death was real. Nothing in
this record's own decision — durable job records, exclusive ownership, boot reconciliation, the
`error_code` enum — is changed by any of it.

**One honest correction to the note above.** Its §Windows section says the Task Scheduler row "is not
measured" and is "a design". Part of it now is: the P2-S5 spike's Windows arm ran on `windows-latest`
and exited `0`, so the drain over the named pipe and the task ending on exit `0` are measured. The
Task Scheduler **restart adapter** proofs are a different job and were still red at the last dispatch,
and GitHub Actions has since been billing-blocked for the organisation, so they stay honestly unmet.
ADR 0027 §Runner evidence lists every leg either way.

## Note, 2026-09-09: the Windows half of the identity tuple existed only from this change

The note of 2026-09-06 §Process identity lists three platforms and prices two of them. Its Windows
row reads, in full: "**Windows:** the process creation time — `Win32_Process.CreationDate`, or
`Process.StartTime` — at 100 ns. Unmeasured." **Unmeasured turned out to mean unimplemented**, and
this note records what that cost, what closes it, and what the close costs.

**What was actually shipped.** `worker-identity.ts` read `/proc/<pid>/stat` on Linux and spawned
`ps -o lstart=` on *every other platform*; Windows has no `ps`, so the spawn failed and the token
was `null`. The boot id was read only on Linux and macOS and answered `null` elsewhere. So on
Windows `selfIdentity()` was `(pid, null, null)`, and the decision this record makes — that the
identity of a recorded process is the triple, and that only a positive match of it licenses a kill —
was not implemented on the platform at all. Three consequences, each of them a rule in this record
that could not fire:

1. **Reconciliation could never take a positive decision.** `classifyWorker()`'s boot check needs
   both ids and had neither; its token comparison needs a recorded token and an observed one and had
   neither. Every live pid therefore reached the `uncertain` branch: no orphaned worker was ever
   killed, no stranger was ever positively identified, and §What happens when identity cannot be
   established's expensive answer — `workers_uncertain: true` and a quarantined output directory —
   was the answer to *both* of the two cases it is meant to tell apart.
2. **A stale `owner.lock` naming a reused pid blocked the daemon.** `lock.ts`'s scenario `[D]` — a
   live pid whose token differs, take over — needs an observed token to differ from. With none, the
   holder was always believed and the next `serve` exited `10` until somebody deleted the file.
3. **`startIsProvablyGone()` was `false` for any recorded pid Windows had since handed out again**,
   which is one half of ADR 0027 §D6's rule for a start that died before it could record its own
   end.

**How it surfaced, and why it took a while.** As a flake in T14's Windows leg, whose eleventh
expectation is that each of five recorded starts "carries an identity tuple a later start can decide
`provably gone` from". Whether that fails is decided by whether the machine happened to reuse one of
those five pids: run `34319237168` was green and run `34333162332` was red, on the same code, the
same day. The transcript of the red one prints `start_time <none>, boot <none>` against every
recorded start, which is the whole defect in one column and had been printing all along.

**What closes it.** Both halves are read from CIM in **one** `powershell.exe`:
`Win32_Process.CreationDate` for the start token and `Win32_OperatingSystem.LastBootUpTime` for the
boot id, each rendered by `ToFileTimeUtc()` — a 64-bit count of 100 ns intervals since 1601, which
is an exact integer and not a formatted date, so neither a locale, a time zone nor an output
formatter can make two readers of the same process disagree. The lines are written with
`[Console]::Out.WriteLine`, past the formatter that wraps redirected output at 80 columns, and the
reader accepts a value only when it is entirely digits. `wmic` is not used and is not a fallback: it
is removed from current Windows images, so a probe built on it would answer `null` — "uncertain" —
on exactly the machines this is for. A probe that cannot run answers `null`, which is `uncertain`,
which is the same refusal every other platform makes when it cannot say.

**What it costs, measured rather than assumed** — `windows-latest`, node v24.20.0, 2026-09-09, run
`34339968171` job `102428197910`, from `daemon/testing/identity-cost.ts`:

```text
  platform: win32  node: v24.20.0  pid: 6464
  selfIdentity() cold:      2870.6 ms      (one powershell.exe, both halves)
    start_time: CreationDate=134334230704561090
    boot_id:    LastBootUpTime=134334228835081440
  selfIdentity() memoised:  0.012 ms
  machineBootId() memoised: 0.006 ms
  processStartToken(live pid), 5 readings: 332.6, 331.4, 342.3, 335.6, 326.4 ms
    mean: 333.7 ms
  distinct tokens across 5 further readings: 1
  a bare powershell.exe that only prints, 5 readings: 177.1, 172.7, 171.7, 175.2, 169.8 ms
    mean: 173.3 ms
```

Run `34338721332`, the first dispatch of the same job, read 2771.1 ms cold and a 318.1 ms mean over
the same five readings, so the numbers reproduce.

So **about 330 ms warm and 2.9 s cold**, against the 4.5 ms this record priced the macOS `ps` at —
seventy times the number the cost discipline was written around. **The last line is why no cheaper
query is worth looking for.** A `powershell.exe -NoProfile -NonInteractive` that does nothing but
print one line costs 173 ms, so the spawn is already more than half of the 334 ms and the two CIM
queries are the rest. `[System.Diagnostics.Process]::GetProcessById($pid).StartTime` would read the
same clock out of pure .NET and skip WMI altogether, and at best it halves a number whose larger
half it cannot touch — while answering `Access is denied` for a pid belonging to another account,
which is precisely the pid-reuse case the token exists to decide. The only thing that would remove
the spawn is a native addon, which [ADR 0020](0020-always-running-local-daemon.md) rules out for the
same reason it rules out DPAPI.

The discipline itself does not change; it becomes load-bearing rather than tidy. `selfIdentity()` is
memoised and takes **both** halves out of the one invocation, which is the only reason it is one
spawn and not two; `machineBootId()` is memoised from the same reading; and `classifyWorker()`
reaches the probe only for a recorded pid that is still alive, because a dead one is decided by
`isAlive` and a record from another boot by the boot id, neither of which spawns anything.

**The steady-state effect on a daemon is one warm probe per start, and that was measured too**, on
run `34338749290`, by comparing two Windows runs of the same suites: `commands/serve.test.ts`, 31
cases each starting a real daemon, went from 84,494 ms to 93,965 ms (+305 ms per start);
`install/lifecycle.test.ts`, 23 cases, from 20,124 ms to 27,406 ms (+317 ms per start). Both numbers
are the measured probe, once, and nothing else. The **cold** 2.8 s is not additional to a daemon
start in practice: `daemon/pipe-acl.ts` already spawns a `powershell.exe` at the bind, so before this
change the first PowerShell of the process was that one and it paid the same cold start. What the
change does is move which call pays it. The one place that was visible is a test: `server.test.ts`'s
first case builds a backend, which calls `selfIdentity()`, which was the first PowerShell that
worker had ever started — 15 s on a runner paging it in for the first time, against a 5 s per-case
budget, reported as `answers GET /healthz` timing out. That file now warms the probe once in a
`beforeAll` that says so.

**What this note does not change.** Nothing in the decision above: the triple, the four verdicts,
the opposite safe defaults for the lock and for a worker, and `workers_uncertain`'s two cases are
all exactly as written. The residual that §Process identity names for macOS — a one-second token
cannot exclude a pid recycled inside the same second — is narrower on Windows for the reason that
row already gave: 100 ns is finer than a pid space can be traversed. And the sentence that has to be
retired is the row's last word: the Windows token is no longer *unmeasured*, and no record in this
repository may say that it is.
