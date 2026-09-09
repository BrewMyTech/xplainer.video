/**
 * The exit codes the daemon start-up path uses, in one place.
 *
 * `apps/cli/AGENTS.md` makes this a rule: "Exit codes are a documented table, in
 * `docs/ARCHITECTURE.md` §6 and in the ADR that owns each one. A new code is added to the table and
 * to ADR 0020's successor — never invented at the call site." Nothing here is new. Each constant
 * names the row it implements, and `NOT_IMPLEMENTED_EXIT_CODE = 2` keeps its own export site in
 * `../not-implemented.ts`.
 */

/**
 * The command was asked for something it does not do, and it has written nothing.
 *
 * This is the code **Commander itself** exits with when it rejects an argument, so the CLI already
 * had it before anything here was written: a flag it does not know, a missing required argument, a
 * `--help`-adjacent parse failure. A hand-written refusal of the same shape — `serve --bind` naming
 * an address the command will not bind without an acknowledgement, `status` with a `--url` it
 * cannot turn into an endpoint, `connect claude --scope` naming a file that vendor's CLI owns —
 * must use the same value, because a caller cannot tell which half of the parser refused it and a
 * second "you asked for something impossible" code would be a distinction with no reader.
 *
 * It is exported here, and named, for the rule `apps/cli/AGENTS.md` states above: a code used at a
 * call site is a code that is not in the table. `docs/ARCHITECTURE.md` §6 carries the row.
 */
export const USAGE_EXIT_CODE = 1;

/**
 * A precondition this command needs was not met, and it has written nothing.
 *
 * [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md) §Degraded paths states the
 * rule this code serves: "**probe before writing; on refusal, write nothing, exit with the
 * documented code, and print the one command that fixes it.**" That record's own first user is
 * `daemon install` refusing a machine with no `setup` marker; `xplainer connect` is the second, and
 * the condition is the one §Ordering names — "`connect` refuses to write an agent configuration
 * pointing at a daemon that has never answered (`--force` overrides)". It is also what `connect`
 * exits with when the file it would edit exists and cannot be understood, which is the same shape:
 * a precondition of writing, unmet, with nothing written.
 */
export const PRECONDITION_UNMET_EXIT_CODE = 3;

/**
 * The daemon is set up on this machine and is not answering.
 *
 * ADR 0020 gives `4` to "installed but not healthy", and `xplainer status` is the first command
 * that can be in that position: a state directory that names a port, and nothing at that port that
 * answers an authenticated `GET /healthz` with a `200`. A daemon that answers `401` to *our* token
 * is the same row for the same reason — "something is on our port that is not our daemon".
 */
export const DAEMON_UNHEALTHY_EXIT_CODE = 4;

/**
 * The install needs an administrator, and this process is not one.
 *
 * [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md) §Degraded paths measures the
 * one place this happens: a Windows Scheduled Task registered for a standard user without the
 * "Log on as a batch job" right registers and then will not launch —
 * `SCHED_S_BATCH_LOGON_PROBLEM` (`0x0004131C`), "The task is registered, but may fail to start" —
 * so `install` "verifies rather than assumes": register, start, poll `/healthz` for 15 s, and on
 * failure "read `LastTaskResult`, name the missing right, unregister, and exit `5`". `--at-boot` is
 * the second door onto the same code, because "Only a member of the Administrators group can create
 * a task with a boot trigger".
 *
 * It is the *privilege* that is missing and never the supervisor, which is what separates it from
 * {@link NO_SUPERVISOR_EXIT_CODE}: the machine has one, it answered, and it said no. Nothing is
 * left registered — the unregister is part of the refusal, not a cleanup a user has to run.
 */
export const ADMIN_REQUIRED_EXIT_CODE = 5;

/**
 * This machine has none of the three supervisors, so there is nothing to install into.
 *
 * ADR 0020's whole design is "systemd user unit, LaunchAgent, or Windows Scheduled Task", and a
 * machine with none of them — a Linux container with no per-user systemd, a distribution without
 * `loginctl` lingering, an environment where `systemctl --user` cannot reach a manager — is a
 * machine where an always-running daemon cannot be arranged by this command at all. That is a
 * refusal and not an internal error: `install` writes nothing, and the remediation ADR 0020 §Degraded
 * paths prints is the one that works without a supervisor — `xplainer connect claude --spawn`,
 * which lets an agent start the daemon itself.
 *
 * Distinct from {@link ADMIN_REQUIRED_EXIT_CODE} on purpose. "There is no supervisor here" and "the
 * supervisor here will not let *you* do that" have different next steps, and a caller that could not
 * tell them apart would offer the wrong one.
 */
export const NO_SUPERVISOR_EXIT_CODE = 6;

/**
 * An install-time preflight found the port or the label it is about to record already taken.
 *
 * ADR 0020 words the row "port or label conflict", and the distinction from
 * {@link OWNERSHIP_REFUSED_EXIT_CODE} is the one an agent will otherwise get wrong, so it is stated
 * here and in `docs/ARCHITECTURE.md` §6 in the same words: **`7` is install-time** — "the port I am
 * about to record is held", or a unit, label or task of this name belongs to something else —
 * and **`10` is `serve`-time** — the state directory is owned, or the recorded port is taken, by a
 * process that is running now. Same symptom, two lifecycles, two codes.
 *
 * They are two codes rather than one because they have different remediations and different
 * blast radii. A `7` is a decision not yet made: `daemon.json` still records whatever it recorded
 * before, nothing is registered, and the fix is to choose another port or remove the other
 * installation. A `10` is a *running* conflict against an install that already exists, and the fix
 * is to find the process. Recording a port at install and discovering at every start that it was
 * never available is exactly the failure this preflight exists to make impossible.
 */
export const INSTALL_CONFLICT_EXIT_CODE = 7;

/**
 * `xplainer mcp --attach` and the daemon do not speak compatible tool contracts.
 *
 * [ADR 0025](../../../../docs/adr/0025-daemon-updates-and-readiness.md) §Part two: "when it deems
 * the pair **incompatible**, exits with a new code **`8`** and a message naming both versions and a
 * command that fixes it. Code `8` is the next free value after ADR 0020's `2`–`7`." It is the
 * *contract* version that is compared and never the release — "Two releases that serve the same
 * contract must attach cleanly" — and the predicate is `isContractCompatible` in
 * `@xplainer/protocol`, which is major-compatible and treats an unparseable version as
 * incompatible.
 */
export const CONTRACT_SKEW_EXIT_CODE = 8;

/**
 * Another process already holds this machine's runtime.
 *
 * [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md) records `10` as "the
 * recorded port is taken"; [ADR 0024](../../../../docs/adr/0024-durable-jobs-and-boot-reconciliation.md)
 * §Exclusive ownership reuses it for a refused lock, deliberately — "ownership failure is the same
 * condition detected earlier, and reuses the code rather than adding an eleventh one for a
 * user-visible situation that is identical". A process that exits `10` has written nothing.
 */
export const OWNERSHIP_REFUSED_EXIT_CODE = 10;

/** A state file exists and cannot be read or parsed (ADR 0020 §`serve` gains four things). */
export const STATE_UNREADABLE_EXIT_CODE = 11;

/**
 * The bearer token file exists and cannot be read.
 *
 * ADR 0020 words the row as "`12` token file missing (it cannot enforce authentication, so it must
 * not serve)", and that clause is the whole rule: a daemon with no usable token would either serve
 * every caller unauthenticated or answer `401` to its own user for ever. Both are worse than not
 * binding, so `serve` refuses. An *absent* file is not this condition — `daemon/token.ts` mints one
 * on first start — but a file that cannot be read or that holds no token is.
 */
export const TOKEN_UNREADABLE_EXIT_CODE = 12;

/** Internal error: the daemon could not start for a reason it cannot classify (ADR 0020). */
export const DAEMON_INTERNAL_EXIT_CODE = 70;
