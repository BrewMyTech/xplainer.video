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

/** Internal error: the daemon could not start for a reason it cannot classify (ADR 0020). */
export const DAEMON_INTERNAL_EXIT_CODE = 70;
