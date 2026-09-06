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
