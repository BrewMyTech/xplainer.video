/**
 * The check `connect` makes before it writes anything: is there a daemon on this machine at all?
 *
 * [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md) §Ordering states the rule as
 * a refusal — "`connect` refuses to write an agent configuration pointing at a daemon that has never
 * answered (`--force` overrides). A working-looking config for a daemon that is not running is the
 * single most likely first-run support ticket, and it is cheap to prevent." The evidence that a
 * daemon has answered is `daemon.json`'s recorded port: `serve` writes it at bind and nothing else
 * does, so a state directory with a port in it is a state directory a daemon has bound in.
 *
 * **The port is read and never written.** The entry `connect` produces carries no URL, no port and
 * no token (§The agent path is IPC, not TCP), so the port is not *in* the configuration — it is the
 * proof that there is something to configure, and the number this command prints so a user can see
 * which daemon it means. That is also the difference between reading `daemon.json` and assuming
 * `8787`: the assumption is unfalsifiable, and on a machine with two users it is wrong.
 *
 * The precedence itself is `daemon/binding.ts`'s {@link resolveDaemonPort}, not a rule restated
 * here — that function exists so `serve`, `status` and `connect` cannot each invent their own order.
 */

import { type PortSource, resolveDaemonPort } from "../daemon/binding.js";
import { readDaemonState } from "../daemon/daemon-state.js";
import { stateDirLayout } from "../daemon/state-dir.js";
import { DEFAULT_PORT } from "../server.js";

/** Either a daemon worth pointing an agent at, or the sentence explaining why not. */
export type PreflightResult =
  | { ok: true; port: number; source: PortSource }
  | { ok: false; message: string };

/** What {@link preflightDaemon} weighs. */
export type PreflightRequest = {
  /** The resolved state directory to look in. */
  stateDir: string;
  /** ADR 0020's documented override: write the entry even though no daemon has bound here. */
  force?: boolean;
};

/**
 * Decide whether there is a daemon to connect to, reading `daemon.json` and nothing else.
 *
 * A `StateFileUnreadableError` from the read is deliberately **not** caught: a `daemon.json` that
 * exists and cannot be parsed is exit `11`'s condition, and swallowing it here would turn a
 * corrupted state directory into the "no daemon yet" message, sending a user to run a `serve` that
 * will refuse for the same reason.
 */
export function preflightDaemon(request: PreflightRequest): PreflightResult {
  const state = readDaemonState(request.stateDir);
  if (state.port === null && request.force !== true) {
    return {
      ok: false,
      message:
        `no daemon has ever bound in ${request.stateDir}, so there is nothing for an agent to ` +
        `attach to — ${stateDirLayout(request.stateDir).daemonState} records no port. Run ` +
        "`xplainer serve` once (or, from phase 2, `xplainer daemon install`) and connect again; " +
        "`--force` writes the entry anyway.",
    };
  }
  const decision = resolveDaemonPort({ recorded: state.port, fallback: DEFAULT_PORT });
  return { ok: true, port: decision.port, source: decision.source };
}
