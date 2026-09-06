/**
 * `xplainer status` — what the two state files say, checked against a real request.
 *
 * [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md) §Port and discovery makes
 * this command necessary and tells it what to distrust: `daemon.json` is durable and survives a
 * reboot, `runtime.json` is "written by `serve` at bind, removed on clean shutdown, and **never
 * trusted without a liveness check**" — on macOS and Windows nothing reaps it, so a `SIGKILL`ed
 * daemon leaves a file describing a run that no longer exists. So every fact printed here is
 * labelled with where it came from, and the liveness line is the answer to an **authenticated
 * `GET /healthz`** rather than the presence of a file.
 *
 * The probe carries the bearer token deliberately, and
 * [ADR 0025](../../../../docs/adr/0025-daemon-updates-and-readiness.md) §Part three is explicit that
 * this is the only useful form: it "must assert a **successful, authenticated** response — a `401`
 * proves the port is bound and proves nothing about readiness". That is also what makes the
 * unhappy path legible rather than mysterious: a `401` against *our own* token is the sentence
 * "something is on our port that is not our daemon" (ADR 0020 §Security R-SEC-4), which is a
 * different problem from a daemon that is not running, and the two must not print the same line.
 *
 * Exit codes are the table's, not this file's: `0` healthy, `4` installed but not healthy — no
 * answer, a `401`, or a non-`200` — and `11` for a state file that exists and cannot be read.
 */

import { readFileSync } from "node:fs";
import process from "node:process";
import { Command } from "commander";
import { resolveDaemonEndpoint } from "../daemon/binding.js";
import {
  type DaemonState,
  readDaemonState,
  readRuntimeState,
  StateFileUnreadableError,
} from "../daemon/daemon-state.js";
import { DAEMON_INTERNAL_EXIT_CODE, DAEMON_UNHEALTHY_EXIT_CODE } from "../daemon/exit-codes.js";
import { resolveStateDir } from "../daemon/state-dir.js";
import { resolveTokenPath } from "../daemon/token.js";
import type { CliIo } from "../io.js";
import { DEFAULT_PORT } from "../server.js";

/** How long the probe waits before calling the daemon unhealthy. */
export const PROBE_TIMEOUT_MS = 3_000;

/** The environment variable that points `status` at a daemon other than this machine's. */
export const DAEMON_URL_ENV = "XPLAINER_DAEMON_URL";

/** What `/healthz` answers with when it is our daemon answering. */
type HealthBody = {
  status?: unknown;
  version?: unknown;
  contract_version?: unknown;
};

/** The probe's outcome, in the three shapes that need different sentences. */
type Probe =
  | { kind: "ok"; body: HealthBody }
  | { kind: "unauthenticated" }
  | { kind: "http"; status: number }
  | { kind: "unreachable"; reason: string };

async function probe(url: string, token: string | null): Promise<Probe> {
  try {
    const response = await fetch(`${url}/healthz`, {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.status === 401) {
      return { kind: "unauthenticated" };
    }
    if (!response.ok) {
      return { kind: "http", status: response.status };
    }
    return { kind: "ok", body: (await response.json()) as HealthBody };
  } catch (error) {
    return { kind: "unreachable", reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The one line that says what a failed probe found — in words that tell the three cases apart.
 *
 * A `401` has two readings and they need different remedies: with a token in hand it means
 * "something is on our port that is not our daemon" (ADR 0020 §Security R-SEC-4), and with no token
 * it means only that this command could not prove who it is. Printing the first sentence for the
 * second case would send a user hunting for an intruder that is really a missing file.
 */
function describeFailedProbe(
  result: Exclude<Probe, { kind: "ok" }>,
  tokenPath: string,
  token: string | null,
): string {
  if (result.kind === "unauthenticated") {
    return token === null
      ? "daemon:          something is listening there, and this command had no token to present " +
          `— ${tokenPath} is absent or empty, so the daemon answered 401`
      : "daemon:          something is on that port that is not this daemon — it refused the " +
          `token in ${tokenPath} with 401`;
  }
  if (result.kind === "http") {
    return `daemon:          answered ${result.status} rather than 200; it is bound but not healthy`;
  }
  return `daemon:          not answering (${result.reason})`;
}

/** Read the token file for the probe. A missing one is a fact to report, not a failure to raise. */
function readTokenQuietly(path: string): string | null {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

export function createStatusCommand(io: CliIo): Command {
  return new Command("status")
    .description("Report where this machine's daemon is, and whether it answers")
    .option(
      "--url <url>",
      `daemon origin to probe (default: ${DAEMON_URL_ENV}, else the recorded port)`,
    )
    .action(async (options: { url?: string }) => {
      const stateDir = resolveStateDir();
      let daemonState: DaemonState;
      let runtime: Record<string, unknown> | null;
      try {
        daemonState = readDaemonState(stateDir);
        runtime = readRuntimeState(stateDir);
      } catch (error) {
        if (error instanceof StateFileUnreadableError) {
          io.writeErr(`xplainer status: ${error.message}\n`);
          io.exit(error.exitCode);
        }
        io.writeErr(`xplainer status: ${error instanceof Error ? error.message : String(error)}\n`);
        io.exit(DAEMON_INTERNAL_EXIT_CODE);
      }

      const endpoint = resolveDaemonEndpoint({
        configuredUrl: options.url ?? process.env[DAEMON_URL_ENV] ?? null,
        recordedPort: daemonState.port,
        fallbackPort: DEFAULT_PORT,
      });
      if (!endpoint.ok) {
        io.writeErr(`xplainer status: ${endpoint.message}\n`);
        io.exit(1);
      }

      const tokenPath = daemonState.token_file ?? resolveTokenPath(stateDir);
      const token = readTokenQuietly(tokenPath);

      const lines = [
        `state directory: ${stateDir}`,
        `daemon.json:     port ${daemonState.port ?? "unrecorded"}, contract ${daemonState.contract_version ?? "unrecorded"}`,
        `runtime.json:    ${
          runtime === null
            ? "absent — no run has bound, or the last one shut down cleanly"
            : `pid ${String(runtime.pid ?? "unknown")}, addresses ${JSON.stringify(runtime.addresses ?? [])}, socket ${JSON.stringify(runtime.socket ?? null)} (a hint until the probe below confirms it)`
        }`,
        `token file:      ${tokenPath}${token === null ? " (absent or empty)" : ""}`,
        `probing:         ${endpoint.url}/healthz (port from ${endpoint.source})`,
      ];
      if (daemonState.stalled !== null) {
        lines.push(
          `stalled:         since ${daemonState.stalled.at}: ${daemonState.stalled.reason}`,
        );
      }

      const result = await probe(endpoint.url, token);
      if (result.kind === "ok") {
        lines.push(
          `daemon:          running and healthy — version ${String(result.body.version)}, ` +
            `contract ${String(result.body.contract_version)}`,
        );
        io.writeOut(`${lines.join("\n")}\n`);
        return;
      }

      lines.push(describeFailedProbe(result, tokenPath, token));
      io.writeOut(`${lines.join("\n")}\n`);
      io.exit(DAEMON_UNHEALTHY_EXIT_CODE);
    });
}
