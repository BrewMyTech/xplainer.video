# 0025. The package manager updates the daemon; the daemon drains, announces readiness, and the shim refuses a skewed contract

- Status: accepted
- Date: 2026-09-06
- Deciders: @rishavanand
- Settled by: `.omc/plans/ralplan-agent-first-architecture.md` — the RALPLAN-DR plan for the
  agent-first architecture, whose durability findings **L2** (updating a daemon that is always
  running, and the version skew that follows) and **L3** (how a parent knows the daemon is up) this
  record answers. Consensus at round 3: Critic APPROVE, Architect SOUND-WITH-CHANGES with every
  remaining item folded in.
- Builds on: **[ADR 0020](0020-always-running-local-daemon.md)**, which made the local runtime an
  installed, supervised daemon and pinned a copy of the interpreter and the CLI under the state
  directory, and **[ADR 0024](0024-durable-jobs-and-boot-reconciliation.md)**, whose drain this
  record's update sequence calls and whose exclusive ownership its rollback must not violate.
  ADR 0020 carries a dated note pointing here; it is not rewritten, and — see §Readiness — its
  `Type=exec` is **not** amended by this record.
- **Mechanisms deliberately left open.** The contract-version advertisement, the compatibility
  predicate, its interaction with ADR 0024's enum-extension policy and the achievability of
  unknown-value tolerance are all spike **P1-S3**; the systemd readiness mechanism is spike
  **P2-S4**. Wherever the text reads "Proposed mechanism, to be confirmed by spike …", the decision
  above it is binding and the mechanism inside it is not.

## Context and Problem Statement

ADR 0020 turned `xplainer serve` from a command a human runs into a service the operating system
starts. That buys the product its pitch — installed once, and simply there — and it creates three
problems a foreground command never had.

**Updating something that is always running is not the same as installing it.** ADR 0020 records
that "until the SEA binaries exist, `ExecStart` points at a path that a package manager can delete",
and that the phase-2 installer therefore "pins a copy of `process.execPath` and the CLI under the
state directory". So `npm i -g @xplainer/cli` replaces the **globally installed** CLI and leaves the
**pinned copy the supervisor actually executes** exactly where it was. The user believes they have
upgraded. The daemon that answers their agent has not.

**An upgrade produces version skew inside a single agent session.** `xplainer mcp --attach` is a
fresh process spawned per session; the daemon is not. So the shim an agent starts on Tuesday
afternoon may be newer than the daemon it attaches to, which has been up since Monday. Today it
attaches anyway, and the failure surfaces as a tool call that returns something the shim did not
expect — the least legible failure available.

**Nobody knows when the daemon is ready.** ADR 0020's ordering is
`setup → daemon install → (wait for /healthz) → connect`, and that parenthesis is doing real work
that nothing implements. Worse, ADR 0024 adds two things that must finish before the daemon is
usable and that no port check can observe: acquiring exclusive ownership of the state directory, and
reconciling every job record. A supervisor that reports the unit active the moment `execve` succeeds
is reporting something true and useless. A caller that sleeps two seconds and hopes is guessing, and
a caller that polls an unauthenticated port is confirming that a socket exists.

The three are one record because they are one sequence. An update drains, restarts and must **know**
the replacement came up; if it did not, it must roll back to a daemon that is itself ready; and
afterwards the shim must tell an agent, in one legible sentence, when the pair it is holding cannot
speak to each other.

## Decision Drivers

- **The daemon must not update itself.** ADR 0020 already states "**The daemon does not become an
  updater**" about the toolchain. The same rule applied to the daemon's own code is not a new
  principle, and a process that rewrites the executable it is running from is a class of bug rather
  than a feature.
- **An interrupted update must leave a working daemon.** The failure mode to design against is not
  "the upgrade failed"; it is "the upgrade failed and now nothing renders".
- **A skew failure must name its own fix.** An agent that gets an unexplained error retries it. An
  agent that gets "daemon speaks contract 1, this shim speaks contract 2 — run *X*" can act.
- **Compare the contract, not the release.** Two releases that serve the same contract must attach
  cleanly, or every patch release breaks every live agent session.
- **Readiness is a fact the daemon knows and nobody else does.** Only the daemon knows it has
  ownership, has reconciled and has bound both listeners. Any mechanism that infers readiness from
  outside is inferring it from evidence that is available earlier than the fact.
- **Do not decide what has not been measured.** Round 1 of the settling plan asserted a fifteen-line
  `sd_notify` write that Node cannot perform, and round 2 promised an unknown-value tolerance this
  repository's own codegen forbids. Both are corrected below rather than defended.

## Considered Options

**For updates.**

1. **The daemon self-updates** — downloads a new version, swaps itself, restarts.
2. **The package manager installs; a post-install hook stages, drains, switches, restarts, verifies
   and rolls back.** **Chosen.**
3. **`electron-updater` (ADR 0004) is extended from the desktop app to the daemon.**
4. **Nothing** — the user upgrades and restarts by hand, and finds out from a support thread that
   the supervisor still executes the old pinned copy.

**For version skew.**

5. **Ignore it.** Attach and hope the surfaces are compatible.
6. **Compare the release version** from the MCP `initialize` handshake's `serverInfo.version`.
7. **Compare an explicitly advertised contract version, and exit `8` on an incompatible pair.**
   **Chosen.**

**For readiness.**

8. **Sleep.** A fixed delay in the installer and in the desktop spawn path.
9. **Poll the port.** Connect until the TCP handshake succeeds.
10. **The daemon announces readiness exactly once, after ownership, reconciliation and both binds,
    and every parent waits for that announcement.** **Chosen.**

## Decision Outcome

Chosen: options 2, 7 and 10.

Option 1 contradicts ADR 0020 and is the one shape that can leave a machine with no working daemon
and no way to install one. Option 3 gives the daemon a second update channel with a different
failure vocabulary, for the benefit of the one consumer that already has an updater; the desktop app
keeps `electron-updater` and the daemon is not added to it. Option 4 is the status quo and it is the
bug. Option 5 trades a legible error for an illegible one. Option 6 compares the wrong number, and
the measurement is below. Options 8 and 9 both answer a different question than the one asked:
a sleep asserts a duration, a port check asserts a bind, and readiness is neither.

### Part one — the package manager updates the daemon

**The package manager updates the binary. The daemon never self-updates.** ADR 0020 already states
the rule for the toolchain; this record applies it to the daemon's own code and records the
mechanics 0020 left out.

The sequence, stated in full because the round-1 version of it ("`npm i -g` and restart") is wrong
about what an update replaces:

1. **Install** the new version through the package manager — or, from phase 4, the signed SEA
   binary.
2. **Stage** the new runtime beside the pinned copy under the state directory. Do not overwrite in
   place: a half-copied interpreter is an unstartable daemon, and the window is exactly as long as
   copying 120 MB of Node takes.
3. **Drain** the running daemon using [ADR 0024](0024-durable-jobs-and-boot-reconciliation.md)'s
   handler — in-flight jobs reach a checkpoint or are marked `error` with
   `error_code: "daemon_shutdown"`, and nothing is left `running`.
4. **Switch** the executable the **supervisor** launches — not only the path `daemon.json` records.
5. **Restart, and wait for the readiness signal** defined in part three. Not for the supervisor's
   own idea of "started".
6. **If readiness does not arrive** within a bounded timeout: stop the replacement *before* starting
   anything else, switch back to the previous pinned copy, restart, verify **its** readiness, and
   report the failure with the old version running. The previous copy is retained until the new one
   has been ready once.

Three gaps that the first drafts of this sequence left open, closed here:

- **Step 2 has an owner.** Staging is the **post-install hook's** work, never the daemon's — the
  daemon must not write the runtime it is executing from. The hook stages, then invokes step 3
  onward. This keeps ADR 0020's "the daemon does not become an updater" true of steps 2 and 4 as
  well as of the download.
- **Step 4 is a supervisor edit, not a state-file edit.** ADR 0020 records `daemon.json` as holding
  "the supervisor kind and artefact path, the resolved program and interpreter", and the artefact is
  `~/.config/systemd/user/xplainer.service`, the LaunchAgent plist, or the Task XML. Rewriting
  `daemon.json` alone leaves `ExecStart` pointing at the old copy, so the switch is a no-op that
  reports success. Either the artefact is rewritten and the supervisor reloaded, or `ExecStart`
  points at a stable indirection that the switch flips. This record states the requirement and
  leaves the choice to phase 2, because a rewritten unit file and a flipped symlink have different
  failure modes and Windows has neither.
- **Step 6 stops before it starts.** Rolling back without first stopping the timed-out replacement
  risks two daemons contending for the exclusive ownership ADR 0024 requires — and the rollback
  would be the process that loses. State written by the newer version is **preserved rather than
  deleted**, per ADR 0024's rule that a `format_version` newer than the reader understands is a
  rollback signal and not corruption.

**Failure injection is part of the criterion, not an afterthought.** P2-12's method includes a staged
copy that fails to start, a readiness timeout, and a rollback that must itself become ready — each
ending with a daemon that is running and answering, the previous pinned copy in place, the newer
version's state intact, and exactly one owner.

`xplainer daemon restart` performs steps 3–6 and is a **phase-2** deliverable, because that is where
the installer and the pinned copy exist. **What phase 1 owes the user is a remediation that exists
in phase 1:** the skew error below must name a command the user can actually run at that point.
Until `daemon restart` ships, that is stopping and re-running `xplainer serve` — or, where a
supervisor is already installed, the supervisor's own restart command — and the message names the
one that applies, rather than a phase-2 subcommand the user does not have.

`electron-updater` (ADR 0004) stays the desktop app's story and is not extended to the daemon.

### Part two — version skew, and the shim's exit code `8`

After an upgrade the running daemon can be older than the `xplainer mcp --attach` shim an agent just
spawned. On attach, the shim compares the daemon's **contract** version with its own — and when it
deems the pair **incompatible**, exits with a new code **`8`** and a message naming both versions
and a command that fixes it. Code `8` is the next free value after ADR 0020's `2`–`7`; the daemon's
own `10`, `11`, `12` and `70` are untouched.

The shim's own contract version is `MCP_CONTRACT_VERSION`, which today lives at
`packages/mcp-server/src/server.ts:44` and reads `manifest.version` from
`packages/protocol/schemas/manifest.json` — **not** in `@xplainer/protocol`, where an earlier draft
of this record placed it. Whether it moves there, or the shim reads `manifest.version` directly, is
part of the phase-1 work P1-S3 scopes.

It compares that contract version, not the release version. Two releases that serve the same
contract must attach cleanly, or every patch release breaks every agent session that outlives it.

**"Incompatible", not "different".** An earlier draft wrote "on mismatch", which is exact-match
semantics — and exact-versus-major-compatible is precisely what the spike below is convened to
settle. So this record states the *behaviour* (an incompatible pair exits `8` with both versions
named and a remediation that exists) and defers the *predicate*.

> **Proposed mechanism, to be confirmed by spike P1-S3.** Round 1 said the shim "reads
> `serverInfo.version`" from the MCP `initialize` handshake. Measured: `apps/cli/src/server.ts:87`
> resolves `const version = options.version ?? CLI_VERSION` and line 93 passes it into
> `createMcpServer`, so `serverInfo.version` is the **release** version today — and the MCP
> specification treats that field as identifying the *implementation*, not any application-level
> contract. Reusing it would compare exactly the wrong number. The daemon must therefore advertise
> the contract version **explicitly**. Candidates for P1-S3 to choose between: adding `contract` to
> the existing `/healthz` body, which returns `{status, version}` at `apps/cli/src/server.ts:90`; an
> `instructions` or `_meta` field on the handshake result; or a dedicated read-only MCP resource.
>
> **P1-S3 settles four linked questions, not one.** They cannot be answered independently:
>
> 1. **The advertisement.** Which of the candidates above carries the contract version.
> 2. **The compatibility predicate.** Exact match, or major-compatible. P1-13 is written against
>    whichever this picks and must not presuppose it.
> 3. **How that predicate interacts with the enum-extension policy.**
>    [ADR 0024](0024-durable-jobs-and-boot-reconciliation.md) leaves open whether adding an
>    `error_code` member is a **minor** or a **breaking** contract change, and this is the question
>    that settles it. If it were minor and the predicate were exact, a minor bump would exit `8` on
>    every live agent session until the daemon restarts — precisely the outcome the "compare the
>    contract, not the release" rule exists to prevent. The exits are: a major-compatible predicate;
>    additive changes that do not move the compared version; or classifying an enum addition as
>    breaking and accepting that cost. Pick one, here, once.
> 4. **Whether unknown-value tolerance is achievable at all**, and for which languages — see the
>    block immediately below.

**Unknown-value tolerance: promised in an earlier draft, unachievable as written.** That draft had
this record promise that "a consumer must treat an unrecognised `error_code` as equivalent to
`internal` rather than failing validation". Measured against this repository's own codegen, the
promise cannot be kept for Python consumers. `job-error-code.json` is shaped exactly like
`job-state.json`, and `job-state.json` generates:

```python
class JobState(StrEnum):
    queued = 'queued'
    running = 'running'
    ...
```

A Pydantic field typed with that `StrEnum` raises `ValidationError` on a value outside the members.
Prose in a schema `description` does not change a generated validator. TypeScript consumers are
unaffected, because the union is erased at runtime — but `packages/protocol`'s `files` allowlist
ships `python/**/*.py`, so Python consumers are a **shipped** surface and not a hypothetical one.

This record therefore states the constraint rather than a promise it cannot keep, and hands the
resolution to P1-S3 as its fourth question. The options, none of them free:

- **Change the generated shape for this one schema** — a `Literal` union plus a fallback, or a
  `model_validator`. That means a codegen change, because AC-9c forbids hand-editing anything under
  `generated/`.
- **Leave the enum closed** and accept that a new member is a **breaking** change for Python
  consumers. That makes the "minor bump" reading of the extension policy wrong, and ties directly to
  question 3.
- **Type the wire field as an open `string`**, with the enum published alongside as documentation.
  That buys tolerance at the cost of the greppable contract the field exists to provide.

**What ships now is unaffected**, because the initial enum has seven members and no consumer exists
to be broken. What must not happen is freezing "consumers tolerate unknown values" into an accepted
record while the repository generates validators that do the opposite.

**The extension policy itself lives in ADR 0024.** The field, the enum and its `null`-until-phase-1
consequence are there, so a contributor adding a member opens that record. This one cross-references
it, because the skew check and the extension policy are one decision with two halves — question 3
above is the seam.

### Part three — readiness is announced, not inferred

A parent needs to know the daemon is up, and polling in a loop is a guess dressed as a check. **The
decision is that the daemon announces readiness exactly once — after ownership is acquired,
reconciliation has finished and both listeners are bound — and that every parent (installer,
supervisor, desktop app) waits for that announcement rather than sleeping.**

**Primary, every platform, supervised or not:** exactly one line of JSON on stdout, written once,
after that point:

```json
{"xplainer":"ready","contract":"…","version":"…","port":…,"socket":"…"}
```

followed by a newline. This needs nothing Node does not already have. It is what `apps/desktop`
waits on when it spawns a bundled daemon (ADR 0016's phase-2 spawn path), and what a
`docs/daemon.md` self-supervision recipe waits on.

**Who can actually read that line.** A **supervised** daemon's stdout goes to the supervisor's log
sink — the journal, the plist's `StandardOutPath`, the Task's redirect — and the post-install hook
is not its parent, so it cannot read the stream at all. The split is therefore explicit:

- **A parent that spawned the daemon itself** — the desktop app, a `docs/daemon.md` recipe, a test
  harness — reads the ready line directly from the pipe. This is the primary mechanism and it is
  free.
- **A post-install hook restarting a supervised daemon** cannot, so it waits on one of two things,
  chosen by spike P2-S4: a supervisor-native readiness report, if the spike adopts one, or an
  authenticated `GET /healthz` polled with a bounded timeout and a named failure. The health probe
  must carry the token ADR 0020 §Security defines and must assert a **successful, authenticated**
  response — a `401` proves the port is bound and proves nothing about readiness.

> **Proposed mechanism, to be confirmed by spike P2-S4 — systemd `Type=notify`.** Round 1 said the
> `READY=1` write is "a `dgram` send of one datagram, about fifteen lines, no new dependency". That
> is **false**: `$NOTIFY_SOCKET` names an `AF_UNIX` datagram socket, and Node's built-in
> `node:dgram` supports UDP over IPv4 and IPv6 only — it cannot open a Unix datagram socket at all.
> The options are therefore a dependency (a small `sd_notify` package), a native addon, or staying
> on `Type=exec` and having the post-install step poll an authenticated `/healthz` with a bounded
> timeout. **Waiting on the stdout ready line is not among them for this caller:** a supervised
> daemon's stdout goes to the supervisor's log sink and the post-install hook is not its parent, as
> the paragraph above sets out. P2-S4 picks one, weighing a new runtime dependency in a package
> whose install path is `npx` against what the notification protocol buys.
>
> **Consequence for ADR 0020: no amendment in this round.** Round 1 planned to record
> `Type=exec` → `Type=notify` as an accepted amendment. Because the mechanism is unproven,
> ADR 0020's `Type=exec` **stands**. Its dated note says only that readiness is now a decided
> requirement; that `Type=exec` reports the unit active as soon as `execve` succeeds — before the
> port is bound, and long before jobs are reconciled; and that whether the fix is the notification
> protocol or a readiness wait in the installer is open pending this spike.
>
> **A round-2 claim withdrawn.** Round 2 added that "`Type=notify` would not, on its own, weaken
> ADR 0020's foreground-process invariant: it forbids forking just as `Type=exec` does". That is
> **false** — systemd's notification protocol supports a service moving its main PID, via `MAINPID=`
> in the notification or `NotifyAccess=all`, so `Type=notify` does *not* forbid forking the way
> `Type=exec` does. The invariant ADR 0020 states — `serve` stays a foreground process and never
> forks, and `serve --detach` is never added — is a **property of this daemon that must be preserved
> deliberately**, not something the unit type enforces on its behalf. P2-S4 records that explicitly,
> so a later contributor does not read the unit type as a guard it is not.

**Why L3 is not its own record.** Readiness exists to serve two callers, and both are in this
record: the update sequence needs to know the drain finished and the replacement is up, and the
desktop spawn path needs the same fact without a supervisor at all. Splitting it produces a record
whose Context is a forward reference to this one.

## Consequences

- **`serve` writes to stdout in a machine-readable format**, once, at a defined point. That makes
  stdout part of the contract for anything that spawns the daemon directly, and it means the ready
  line must not move behind a `--quiet` flag or a log-level filter.
- **The ready line carries the contract version**, so a directly-spawning parent gets the skew
  answer without a handshake. This overlaps deliberately with whatever P1-S3 picks for the
  supervised path; one of them may subsume the other, and that is the spike's call.
- **A new exit code, `8`, joins the CLI's table** — the first addition since ADR 0020 fixed `2`–`7`.
  It belongs to the shim, not the daemon.
- **The post-install hook becomes a real component with real failure modes**, not a one-line
  `npm` lifecycle script: it stages, drains, switches a supervisor artefact, waits, and rolls back.
  P2-12's failure injection exists because a rollback path that has never been executed is a
  hypothesis.
- **The previous pinned copy is retained** until the replacement has been ready once, which costs
  disk — roughly a second copy of the ~120 MB ADR 0020 already accepted — until the SEA binaries
  make the pin unnecessary.
- **Phase 1 must ship a remediation string that is true in phase 1.** The skew message naming
  `xplainer daemon restart` before that subcommand exists would be a worse failure than the skew.

## Phase placement

- **Phase 1 (P1-13, P1-14, with spike P1-S3):** the shim's contract-version check and exit `8`, and
  the stdout ready line — because that is where `mcp --attach` and `serve`'s startup path first
  exist.
- **Phase 2 (P2-13, with spike P2-S4):** the supervisor keys, the staged post-install update
  sequence and `xplainer daemon restart` — because that is where the installer, the supervisor
  artefacts and the pinned copy exist.

## What this record does not decide

- **How the contract version is advertised, and what "compatible" means.** Both are P1-S3, along
  with the enum-extension consequence and the tolerance question.
- **Which readiness mechanism a supervised post-install hook uses.** P2-S4.
- **How the drain reaches the daemon on macOS and Windows.** That is ADR 0024's drain and spike
  P2-S5; this record calls the drain and does not implement it.
- **Whether the switch in step 4 is a rewritten supervisor artefact or a flipped indirection.** A
  phase-2 choice, stated as a requirement here.
- **Anything about the desktop app's own update channel.** `electron-updater` (ADR 0004) is
  unchanged and is not extended.
- **Anything about the hosted tier.** `services/media-service` is deployed, not installed, and
  nothing here applies to it.

## Note, 2026-09-06: P1-S3 settled

Spike **P1-S3** has reported. This note answers the four linked questions §Part two hands it —
(a) the advertisement, (b) the predicate, (c) its interaction with
[ADR 0024](0024-durable-jobs-and-boot-reconciliation.md)'s enum-extension policy, and (d) whether
unknown-value tolerance is achievable per language and at what codegen cost. It amends nothing
above: the *behaviour* this record decided — an incompatible pair exits `8` naming both versions
and a remediation that exists — stands exactly as written, and the mechanism marked *proposed*
under it is what follows. ADR 0024 carries the matching note, because that is where the enum lives.

Everything measured below was measured on `darwin/arm64`, Node v24.20.0, Python 3.13.15,
pydantic 2.13.5, `datamodel-code-generator` 0.76.2, `json-schema-to-typescript` 16.0.0,
Ajv 8.20.0, on 2026-09-06.

### (a) Advertisement — `contract_version` on `GET /healthz`

**Decided: the daemon advertises its contract version as `contract_version` in the `/healthz`
JSON body, and `MCP_CONTRACT_VERSION` moves to `@xplainer/protocol`.**

`GET /healthz` now answers `{"status":"ok","version":…,"contract_version":…}` at
`apps/cli/src/server.ts`, where it previously answered `{status, version}`. `version` is unchanged
and is still the **release** number — `options.version ?? CLI_VERSION` — so the two numbers sit
side by side in one body and neither can be mistaken for the other. `apps/cli/src/server.test.ts`
covers both: that `contract_version` equals `MCP_CONTRACT_VERSION`, and that binding the server with
an explicit release version of `9.9.9-…` moves `version` and leaves `contract_version` alone.

Why this candidate and not the other two §Part two listed:

- **An `instructions` or `_meta` field on the `initialize` result** is only readable *after* an MCP
  session has been opened. The shim's whole job at that point is to decide whether it may open one:
  a check that requires the session it is gating is not a gate. The `/healthz` body is readable
  with one unauthenticated-shaped `GET` before any transport is connected. (From P1-7 that request
  carries the bearer token like every other TCP route; over the unix socket of P1-9 the filesystem
  is the auth. Neither changes where the number lives.)
- **A dedicated read-only MCP resource** has the same ordering problem and adds a surface to the
  contract to carry one string.
- **`serverInfo.version`** was already refuted in the body above and is not revisited.

The ready line §Part three defines already carries `"contract"`, and this note deliberately keeps
both: a parent that spawned the daemon reads the line from the pipe and needs no request at all,
while `xplainer mcp --attach` is not that parent and reads `/healthz`. They are one fact published
twice, from one constant, which is why the constant had to move.

**`MCP_CONTRACT_VERSION` now lives in `packages/protocol`.** It is generated into
`src/generated/manifest.ts` from `schemas/manifest.json`'s `version` and exported from
`src/index.ts`, so it appears in `api/protocol.api.md`. It is generated rather than hand-written
because `packages/protocol` builds with `rootDir: "src"`, so a `schemas/manifest.json` import from
inside `src/` does not compile — the same reason `TOOL_NAMES` is generated. `@xplainer/mcp-server`
re-exports the name from `src/server.ts`, so every existing caller and
`packages/mcp-server/api/mcp-server.api.md`'s entry keep working; what changed is where the value
comes from. The move is what lets the shim read the number without depending on the MCP server,
which is the package it may be about to refuse to talk to.

### (b) The predicate — major-compatible, and `isContractCompatible` in `@xplainer/protocol`

**Decided: major-compatible. Two contract versions may speak to each other when both parse and
their major components are equal.**

`isContractCompatible(daemon, shim)` is exported from `@xplainer/protocol`
(`src/contract-version.ts`), with tests for an equal pair, a compatible-but-different pair in both
directions (`1.1` against `1`, and `1` against `1.1`), an incompatible pair (`2` against `1`), and
nine unparseable strings.

The reasoning is the one §Part two names and question 3 sharpens. A shim is spawned per session and
the daemon is not, so under an **exact** predicate the first additive contract change would exit `8`
on every agent session that is alive when the daemon restarts — for a change that added a value
nobody had to understand. That is the outcome "compare the contract, not the release" exists to
prevent, one level down. So additive changes move the minor component and attach; a change that
removes or repurposes something moves the major and refuses.

Two properties are deliberate and are tested:

- **It is symmetric.** A newer shim meeting an older daemon is the just-upgraded case; an older shim
  meeting a newer daemon is the long-lived-agent case. Neither is more dangerous than the other once
  unknown enum members decode instead of throwing, which is (d).
- **An unparseable version is incompatible, not "probably fine".** The cost of refusing is one
  legible error naming both versions; the cost of attaching anyway is the illegible failure this
  record was written to eliminate.

**Measured, the two predicates agree on everything that ships today**, which is worth writing down
because it means this choice buys nothing now and everything later:
`schemas/manifest.json`'s `version` is `"1"` — a bare major, not `"1.0.0"` — so exact equality and
major equality select the same pairs until the first minor bump. The first minor bump is the eighth
`error_code`.

### (c) The enum-extension policy — a minor change, and ADR 0024 now says so

**Decided: adding an `error_code` member is a minor contract change.** It moves the minor component
of the contract version and not the major, so under the predicate above a shim that is already
attached stays attached; and because both generated decoders tolerate an unrecognised value (d), the
record it receives also parses.

This is the seam question 3 named, and the two halves are one decision: a minor classification is
only honest if a consumer can survive the value. Classifying the addition as **breaking** was the
alternative, and it was rejected on ADR 0024's own evidence — that record states plainly that
"adding a member is expected, not exceptional" and that "the first real implementation will want an
eighth". A policy that turns each expected addition into a major bump would exit `8` on every live
session for the most routine change the enum has.

ADR 0024 §Extending the `error_code` enum is closed by its own dated note, which is where a
contributor adding a member will be reading.

### (d) Tolerance — achievable in both languages, at a measured codegen cost

**Decided: tolerate. Both generated bindings decode an unrecognised member as `internal` rather
than rejecting the record, and the codegen change that does it has landed with tests in both
languages.**

**What codegen emitted before this change**, measured by running it and reading the output.

TypeScript, `src/generated/types.ts`:

```ts
export type JobErrorCode =
  | "daemon_restarted"
  | "daemon_shutdown"
  ...
```

Python, `python/xplainer_protocol/generated/models.py`:

```python
class JobErrorCode(StrEnum):
    daemon_restarted = 'daemon_restarted'
    ...
    internal = 'internal'
```

**What each does with an unknown member.** The TypeScript union is erased at runtime, so nothing
rejects anything — and nothing *decodes* anything either: a consumer that wants a value it can
branch on has no function to call, so "TypeScript consumers are unaffected" is true about failure
and misleading about capability. The Python model rejects outright:

```text
1 validation error for ExplainerJobOutput
error_code
  Input should be 'daemon_restarted', 'daemon_shutdown', 'toolchain_missing', 'render_failed',
  'tts_failed', 'cancelled' or 'internal'
  [type=enum, input_value='disk_full', input_type=str]
```

That is the measurement the body above predicted, reproduced.

**What makes an unknown member decode, per language.**

- **Python:** an `enum._missing_` hook on the generated `StrEnum`. Pydantic v2 routes enum
  validation through `EnumType.__call__`, so `_missing_` is the one hook it consults; measured, a
  class with `_missing_` returning `cls.internal` accepts `'disk_full'` and yields
  `JobErrorCode.internal`, while `None` still parses as `None`. The generated hook returns `None`
  for a **non-string** input, which is `enum`'s way of saying the lookup really failed, so `7` is
  still a `ValidationError`: tolerance is for a newer contract, not for a malformed record.
  `datamodel-code-generator` has no option that emits this, so codegen appends it.
- **TypeScript:** a generated `toJobErrorCode(value: string): JobErrorCode` beside a frozen
  `JOB_ERROR_CODE_VALUES` tuple, in a new `src/generated/open-enums.ts`. The type needed nothing;
  the *consumer* needed a decoder.

**Where "this enum is open" is declared.** In `schemas/manifest.json`, as
`"open_enums": { "JobErrorCode": "internal" }` — a title-to-fallback table codegen reads the way it
already reads `engine_owned_files`. **A vendor keyword in the schema document itself was tried
first and rejected on a measurement:** a strict Ajv 2020 instance — which is what
`packages/protocol`'s own test builds, and `schemas/**` is a *published* surface a consumer may
compile the same way — fails outright with

```text
strict mode: unknown keyword: "x-open-enum"
```

`manifest.json` is a data document nothing compiles as a schema, so it can carry contract facts that
a schema document cannot.

**The codegen cost, measured.** `scripts/codegen.mjs` grows by 265 lines and loses 5 — 140 lines of
code, most of which is the TypeScript template it emits, and 111 of comment. It adds one output
file, taking codegen from five generated files to six. Determinism, which AC-9c depends on, is
preserved and was checked rather than assumed: two consecutive `codegen` runs over an unchanged
`schemas/` produce byte-identical output in both languages. Every step of the Python post-processing
asserts what it found — the `class JobErrorCode(StrEnum):` header, the two-blank-line separator the
generator puts between definitions, and the presence of the fallback member — and throws otherwise,
so a `datamodel-code-generator` upgrade that changed the emitted shape fails the build instead of
quietly emitting a strict enum and making this note false.

**One defect the tests caught, recorded because it is the kind that survives review.** The first
version of the emitted decoder was an object literal indexed by the wire value, so
`toJobErrorCode("toString")` returned `Object.prototype.toString` — a function, from a decoder whose
return type says `JobErrorCode`. The generated lookup is a `Map`, and the test that found it is kept.

**What this costs the caller.** The original string is not preserved: an unknown code decodes to
`internal` and is gone. That is acceptable only because `error` is never rewritten and carries the
human-readable half of the same failure, which is exactly the division of labour
[ADR 0024](0024-durable-jobs-and-boot-reconciliation.md) gives the two fields. A consumer that wants
the raw value reads the untyped JSON; a consumer that wants to branch calls the decoder.

**The third option §Part two costed — typing the wire field as an open `string`** with the enum
published alongside as documentation — is rejected. It buys the same tolerance and gives up the
greppable contract, and the measured cost of keeping the enum is one classmethod and one function,
both generated.

## Note, 2026-09-07: the ready line as shipped — this shape, and not §Part three's sketch

**Correcting two passages in this record, neither of which is edited.** §Part three sketches the
line as

```json
{"xplainer":"ready","contract":"…","version":"…","port":…,"socket":"…"}
```

and §Note, 2026-09-06 §(a) says "The ready line §Part three defines already carries `"contract"`".
Neither describes what US-007 and US-008 built. What ships, byte for byte from a live `serve` on a
throwaway state directory:

```json
{"event":"ready","port":8787,"socket":"/…/ipc/xplainer.sock","contract_version":"1","pid":36439}
```

**Decided: that shape is the artefact.** `{event, port, socket, contract_version, pid}`, one line,
once, on stdout, after ownership, reconciliation and both binds. `apps/cli/src/daemon/ready.ts` is
its only writer and its only parser; `apps/cli/src/daemon/ready.test.ts` asserts the exact bytes and
the rejection of five near-misses, and `apps/cli/AGENTS.md` §Commands now waits on it with
`head -n 1` over a fifo rather than sleeping. Everything §Part three *decides* is unchanged — one
line, exactly once, at that point, on every platform, never behind a `--quiet` flag, and stdout is
nothing else. What changes is four key names, and the reasons are these, recorded here rather than
only in the source file (root `AGENTS.md`: a record is corrected by a dated note, and reasoning that
lives only in a docblock is reasoning a reader of the record never meets).

**`event` rather than an `xplainer` key.** The sketch's discriminant is the *product name*, which
says which program wrote the line and not what the line is. §Part three decides "exactly one line of
JSON on stdout" at a defined point; it does not decide that no second kind of line may ever exist,
and phase 2's supervised daemon is the obvious place a second one appears. A field named for what it
discriminates is what lets that arrive without breaking a parser written today — `parseReadyLine`
returns `null` for `{"event":"stopping",…}` rather than mistaking it for readiness, which is a test
case. `apps/cli/AGENTS.md` states the consequence as an invariant: a second kind of stdout line
means a second `event` value, never a bare line.

**`contract_version` rather than `contract`.** Spelled exactly as the `/healthz` body spells it, and
read from the same `MCP_CONTRACT_VERSION` constant in `@xplainer/protocol`. §Note, 2026-09-06 §(a)
already decided these are "one fact published twice, from one constant"; two spellings of it would
have made a parent reading the pipe and a shim polling the endpoint compare two different field
names for one value, which is how the second copy drifts.

**No `version`.** The release number is a fact about the binary the parent has just spawned: it
either knows it already or can ask `/healthz`, which carries both numbers side by side. The contract
version is the one a parent must act on *before* it speaks, so it is the one the pipe carries. This
is the same division §Part two draws between the contract and the release, applied to the line.

**`socket` is kept, and `pid` is added.** `socket` is what makes "both listeners are bound" a thing
the line attests to rather than a thing §Part three asserts; it is nullable because a server bound
without one is supported (`services/media-service` binds no socket), and a parent with no filesystem
access to the path has to tell that case from "an older daemon". `pid` is here because a parent that
spawned the daemon through a shell wrapper otherwise does not know which process to signal, and the
whole point of waiting for this line is to be able to manage what you started.

**What was not reconsidered.** The `/healthz` half of §Note, 2026-09-06 §(a) stands unchanged: the
shim reads `contract_version` there, not from the ready line, because `xplainer mcp --attach` is not
the daemon's parent and has no pipe to read.

## Note, 2026-09-08: P2-S4 settled — `Type=exec` stands, and the readiness wait is the caller's

Spike **P2-S4** has reported. It answers the one mechanism §Part three left open — what a
post-install hook restarting a *supervised* daemon waits on — and it changes nothing this record
*decides*: readiness is still announced exactly once, after ownership, reconciliation and both
binds, and every parent still waits for an announcement rather than sleeping. What follows is the
mechanism under that decision, and the block above marked **Proposed mechanism, to be confirmed by
spike P2-S4** is answered here rather than edited.

**Decided: `Type=notify` is rejected. ADR 0020's `Type=exec` stands, with no `NotifyAccess=` line
beside it, and the readiness wait belongs to the caller — an authenticated `GET /healthz` polled
with a bounded timeout and a named failure.** So the open question in
[ADR 0020](0020-always-running-local-daemon.md)'s note of 2026-09-06 closes on its second branch,
and that record needs no amendment: the unit type it wrote down is the unit type that ships.

The measurement is `apps/cli/spikes/p2-s4-readiness.mjs`, which exits `0` only when all 22 of its
expectations hold and prints the transcript quoted below. It ran on 2026-09-08 against **systemd
252 (252.39-1~deb12u2)** on `linux/arm64`, Node v24.20.0, inside `infra/e2e/Dockerfile.systemd` —
a Debian bookworm image booting real systemd as PID 1, run `--privileged --cgroupns=host` on
OrbStack 29.4.0 from macOS. **The container did host a `systemctl --user` instance**, so the
escape clause in the story ("if a privileged container cannot host one, the runner is the
evidence") did not fire; the whole measurement is against a per-user manager, which is the
instance the shipped unit lives in. One thing that instance needs is not obvious and is recorded
in the Dockerfile: without `libpam-systemd`, `user@<uid>.service` starts, fails to
`dlopen(pam_systemd.so)` and dies with "`$XDG_RUNTIME_DIR` is not set".

**Every unit that ran the daemon launched the B1 artefact**, not a checkout: `ExecStart` names
`<payload>/bin/node` and `<payload>/lib/node_modules/@xplainer/cli/dist/bin.js` from a payload 1
assembled by `xplainer runtime build` into a scratch directory (5791 files, 146.7 MB, 102
packages), and the spike reads `systemctl --user show -p ExecStart -p Environment` back and
requires that neither names the checkout. The one unit that does not run the daemon — the stand-in
below for a process that binds nothing — still runs the payload's own interpreter. The spike
therefore measures readiness and not packaging.

### What the two candidates actually do

Five starts of each, each on a fresh port and a fresh state directory whose bearer token was
minted before the start, so that the probe issued the instant `systemctl --user start` returns is
**authenticated** — a `401` proves a bind and nothing about readiness, which is why the token is
part of the measurement. Every number below comes from one run of the spike; the millisecond
figures move by a few ms between runs and the counts did not move at all across four.

| | `Type=exec` | `Type=notify`, `NotifyAccess=all` |
|---|---|---|
| mean `systemctl --user start` | **4.5 ms** | **125.3 ms** |
| authenticated `200` at that instant, no sleep, no retry | **0/5** (`ECONNREFUSED` every time) | **5/5** |
| mean time to the first authenticated `200` | 129.8 ms, 6–7 polls at 20 ms | inside the start |
| starts that succeeded | 5/5 | 5/5 |

So both mechanisms work, and `Type=notify` is the one that makes `systemctl start` mean *ready*.
It is rejected on what it costs, not on whether it functions.

**1. Node cannot write `READY=1`, measured from inside the daemon.** The spike launches the daemon
with an `--import` hook, so the three probes run in the daemon's own process with
`$NOTIFY_SOCKET=/run/user/1000/systemd/notify` set:

```
dgram.createSocket("unix_dgram")   → ERR_SOCKET_BAD_TYPE: Bad socket type specified.
                                     Valid types are: udp4, udp6
dgram udp4 send to the socket path → ERR_SOCKET_BAD_PORT: Port should be > 0 and < 65536.
                                     Received type number (0).
net.connect(NOTIFY_SOCKET)         → EPROTOTYPE: connect EPROTOTYPE /run/user/1000/systemd/notify
```

`node:dgram` is UDP-only, `node:net` speaks `SOCK_STREAM` to a unix path and the notify socket is
`SOCK_DGRAM`, and a `udp4` socket cannot be pointed at a filesystem path. **There is no
native-free writer in Node — not "no convenient one".** Round 1's "about fifteen lines, no new
dependency" is doubly wrong and is not recoverable by trying harder. Of the three routes this
record listed, the native addon is out on the artefact's own terms: it would need either a
toolchain on the machine the artefact is installed on — the spike found no `cc`, `gcc`, `c++`,
`make` or `node-gyp` on the measured host, and the premise of payload 1 is a machine with no Node,
let alone a compiler — or a prebuilt binary for every target, which payload 1 does not carry and
`runtime.manifest.json` would have to start describing. What remains is `systemd-notify(1)` spawned
as a **child**, and that one costs nothing in dependencies — `/usr/bin/systemd-notify` ships inside
the `systemd` package itself, so any host with a unit to install already has it.

**2. `NotifyAccess` follows from the choice, and getting it wrong is not a degradation.** Because
the only writer is a child, `NotifyAccess=all` is not a preference — it is the setting the
mechanism requires. Round 1 of the plan permitted the child and then rendered `NotifyAccess=main`.
Measured, that combination does not silently under-report; it does not start at all:

```
systemctl --user start → rc=1 after 8234 ms, ActiveState=failed, Result=timeout
journal: Got notification message from PID 293, but reception only permitted for main PID 285
the sender's own view: systemd-notify exited 0
```

The manager names the refusal and drops the notification; `systemd-notify` reports success to the
daemon regardless, so nothing on the sending side could detect it. A unit template that lets
`Type=` and `NotifyAccess=` be chosen independently is therefore a template that can render a
daemon which never starts, and **T9 renders neither**: `Type=exec`, no `NotifyAccess=`.

**3. `Type=notify` does not preserve the foreground-process invariant.** This record already
withdrew the round-2 claim that it does, on a reading of the protocol. It is now measured. A unit
whose `ExecStart` is a wrapper that forks the daemon and then sends `READY=1` with
`--pid=<its child>`:

```
the process systemd forked (the wrapper): 304
the pid the wrapper handed over:          311
the manager's MainPID afterwards:         311 → …/bin/node …/dist/bin.js serve --port 36157
```

The manager tracks as the service's main process one it never forked, and the start job succeeds.
`NotifyAccess=all` accepts `READY=1` and `MAINPID=` from *any* process in the cgroup, so under
`Type=notify` a future `serve --detach` would be a working configuration rather than a refused
one. ADR 0020's invariant — `serve` stays a foreground process, never forks, and `serve --detach`
is never added — is a property **this project keeps deliberately**. No unit type enforces it, and
a later contributor must not read one as a guard it is not.

**4. It is Linux-only.** macOS and Windows have no equivalent of the notification protocol, so the
authenticated `/healthz` wait with a bounded timeout has to exist anyway for the other two
platforms. Adopting `Type=notify` would add a *second* readiness mechanism on one of three
platforms — and the platform-specific one is the one that rots, because two of three callers never
exercise it.

### What `Type=notify` buys, recorded rather than argued away

`Type=exec` reports a unit active as soon as `execve` succeeds, and the spike measured what that
means for a daemon that never becomes ready: a stand-in process that binds nothing left the unit
at `ActiveState=active SubState=running` for the whole polling window while an authenticated probe
got nothing. A caller-side wait catches that at install time, which is when the caller is
watching; on a later boot nobody is. **That is a real gap and it is this decision's residual.**

The spike also measured the route that closes it without the notification protocol: `Type=exec`
with the same authenticated poll as `ExecStartPost=`. The start job then completes only after a
`200` (measured: `rc=0` after 174.6 ms, immediate authenticated probe `200`), and a poll that
never authenticates fails the unit and stops the daemon behind it rather than leaving it active
(measured: `rc=1` after 3066 ms, `ActiveState=failed`, and a later probe `ECONNREFUSED`). It needs
one unit line and one readiness-wait verb on the CLI, reusing exactly the code the post-install
hook and the macOS and Windows callers already need.

**It is measured and recorded here, and not adopted by this note.** No story in this phase renders
that line or ships that verb, and adopting a mechanism nothing implements is how a record acquires
a decision the code does not have. A later story that wants supervisor-side detection of a start
that hangs before readiness has its measurement here and needs no second spike.

### Two smaller confirmations

- **The ready line goes to the journal**, which is the premise §Part three argues from rather than
  measures. A supervised daemon's `{"event":"ready",…}` line was read back with
  `journalctl --user -u`, so the post-install hook — not the daemon's parent — has no pipe to read
  it from, whichever mechanism is chosen.
- **`401` is not readiness.** On a daemon already answering, the same `/healthz` returned `401`
  without the bearer token and `200` with it. A poller that accepted any response would be calling
  a bound port readiness.
