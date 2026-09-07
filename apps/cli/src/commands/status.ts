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
 *
 * **`--json` is the machine surface, and its answer is a condition code rather than a sentence.**
 * [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md) asks for a machine surface
 * for `resolveDaemonUrl()`'s consumer, and `apps/desktop`'s discovery shells out to this command
 * rather than reimplementing state-directory resolution. Prose is what that consumer must not have
 * to parse: {@link STATUS_CONDITIONS} is a closed set, each member is one observation this command
 * actually made, and a new member is added here and to the desktop's mapping together.
 *
 * **What is deliberately not a condition.** Contract compatibility is a relation between a daemon
 * and *the shim asking*, not a property of the daemon, so this command reports the daemon's
 * `contract_version` in `health` and never decides. `isContractCompatible()` is the caller's to
 * apply against its own version — which is exactly what `mcp --attach` does before it proxies — and
 * a condition code here would be this CLI's answer wearing the asker's clothes. Nor is "the user
 * switched the service off": that is supervisor state, invisible to HTTP and to the files this
 * command owns, and reaching it needs the documented supervisor queries `daemon status` runs.
 *
 * The JSON is **one object on one line**, the same shape of contract as the daemon's ready line,
 * and it carries no secret: `token_file` is a path, as it is everywhere else (R-SEC-6). The two
 * refusals that happen *before* a report can exist — a state file that cannot be read (`11`) and a
 * `--url` that is not an endpoint (`1`) — write a sentence to stderr and nothing to stdout, so a
 * caller distinguishes them by exit code rather than by parsing an error object.
 */

import { readFileSync } from "node:fs";
import process from "node:process";
import { Command } from "commander";
import { type PortSource, resolveDaemonEndpoint } from "../daemon/binding.js";
import {
  type DaemonState,
  readDaemonState,
  readRuntimeState,
  StateFileUnreadableError,
} from "../daemon/daemon-state.js";
import {
  DAEMON_INTERNAL_EXIT_CODE,
  DAEMON_UNHEALTHY_EXIT_CODE,
  USAGE_EXIT_CODE,
} from "../daemon/exit-codes.js";
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

/**
 * Every condition `status` can report, and the whole set a consumer has to handle.
 *
 * Ordered as the classifier tries them, which is also roughly best to worst:
 *
 * - `ready` — an authenticated `GET /healthz` answered `200`. The only one that exits `0`.
 * - `stalled` — the circuit breaker is latched in `daemon.json` and nothing is answering, so no
 *   supervisor is going to start this daemon until `xplainer daemon restart` clears it. It is
 *   distinct from `unreachable` because the remedy is a command rather than an investigation.
 * - `unauthorized` — a `401` against a token this machine holds: something is on our port that is
 *   not our daemon (ADR 0020 §Security R-SEC-4).
 * - `token_absent` — a `401` and no token to present, which is the *same* HTTP status and a
 *   completely different problem: the token file is missing or empty.
 * - `unhealthy` — bound and answering, with something other than `200`.
 * - `unreachable` — nothing answered, on a machine where a daemon has bound before.
 * - `absent` — nothing answered and nothing here has ever bound: no recorded port and no
 *   `runtime.json`. "No daemon is installed", which is actionable, rather than "no answer", which
 *   is not.
 */
export const STATUS_CONDITIONS = [
  "ready",
  "stalled",
  "unauthorized",
  "token_absent",
  "unhealthy",
  "unreachable",
  "absent",
] as const;

/** One of {@link STATUS_CONDITIONS}. */
export type StatusCondition = (typeof STATUS_CONDITIONS)[number];

/** The version of the `--json` document's shape, so a consumer can refuse one it cannot read. */
export const STATUS_REPORT_VERSION = 1;

/** What `status --json` writes: one object, one line, no secrets. */
export type StatusReport = {
  schema_version: number;
  condition: StatusCondition;
  /** The code this invocation exits with, so a caller reading the document agrees with `$?`. */
  exit_code: number;
  /** Where this command looked, which is the state directory the daemon was told to use. */
  state_dir: string;
  /**
   * `daemon.json`'s fields, as `serve` and `install` write them — with one substitution:
   * `token_file` carries the path this command actually read, which is the recorded one where a run
   * has recorded it and the resolved default where none has. A report naming a file the reader
   * would then have to re-derive is a report that has answered a different question.
   */
  daemon: DaemonState;
  /** `runtime.json` as found, or `null`. A hint: it is never trusted without the probe. */
  runtime: Record<string, unknown> | null;
  /** What was probed, and what came back. */
  probe: {
    url: string;
    port: number;
    /** Which precedence step chose the port: a configured URL, `daemon.json`, or the default. */
    port_source: PortSource;
    /** The HTTP status, or `null` when nothing answered at all. */
    http_status: number | null;
    /** Why nothing answered, or `null`. */
    error: string | null;
  };
  /** The `/healthz` body, present only for a `200`. */
  health: { status: string | null; version: string | null; contract_version: string | null } | null;
};

/**
 * Which condition the facts add up to.
 *
 * One pure function over what was observed, so the prose path and the JSON path can never disagree
 * about what happened. It is not exported: every branch is asserted against a real daemon in
 * `status.test.ts`, and a classifier a test could reach directly is a classifier a test could agree
 * with while the command did something else.
 */
function classifyStatus(facts: {
  probe: Probe;
  token: string | null;
  recordedPort: number | null;
  runtimePresent: boolean;
  stalled: boolean;
  configuredUrl: boolean;
}): StatusCondition {
  if (facts.probe.kind === "ok") {
    return "ready";
  }
  if (facts.stalled) {
    return "stalled";
  }
  if (facts.probe.kind === "unauthenticated") {
    return facts.token === null ? "token_absent" : "unauthorized";
  }
  if (facts.probe.kind === "http") {
    return "unhealthy";
  }
  // Nothing answered. Whether that is "not running" or "not installed" is the difference between
  // an investigation and an install, and the two state files are what tells them apart — unless a
  // URL was configured, in which case the probe was never about this machine's files at all.
  return !facts.configuredUrl && facts.recordedPort === null && !facts.runtimePresent
    ? "absent"
    : "unreachable";
}

function asReportedString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** The status the probe saw, or `null` when nothing answered and there was no status at all. */
function probeHttpStatus(result: Probe): number | null {
  if (result.kind === "ok") {
    return 200;
  }
  if (result.kind === "unauthenticated") {
    return 401;
  }
  return result.kind === "http" ? result.status : null;
}

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
    .option("--json", "write one JSON object with a stable condition code instead of prose")
    .action(async (options: { url?: string; json?: boolean }) => {
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
        io.exit(USAGE_EXIT_CODE);
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
        `socket:          ${daemonState.socket_path ?? "unrecorded — no run has bound here yet"}`,
        `probing:         ${endpoint.url}/healthz (port from ${endpoint.source})`,
      ];
      if (daemonState.stalled !== null) {
        lines.push(
          `stalled:         since ${daemonState.stalled.at}: ${daemonState.stalled.reason}`,
        );
      }

      const result = await probe(endpoint.url, token);
      const condition = classifyStatus({
        probe: result,
        token,
        recordedPort: daemonState.port,
        runtimePresent: runtime !== null,
        stalled: daemonState.stalled !== null,
        configuredUrl: endpoint.source === "configured",
      });
      const exitCode = condition === "ready" ? 0 : DAEMON_UNHEALTHY_EXIT_CODE;

      if (options.json === true) {
        const report: StatusReport = {
          schema_version: STATUS_REPORT_VERSION,
          condition,
          exit_code: exitCode,
          state_dir: stateDir,
          // The token's *path*, which is what the probe above used; the value never appears here
          // or anywhere else this command writes (R-SEC-6).
          daemon: { ...daemonState, token_file: tokenPath },
          runtime,
          probe: {
            url: endpoint.url,
            port: endpoint.port,
            port_source: endpoint.source,
            http_status: probeHttpStatus(result),
            error: result.kind === "unreachable" ? result.reason : null,
          },
          health:
            result.kind === "ok"
              ? {
                  status: asReportedString(result.body.status),
                  version: asReportedString(result.body.version),
                  contract_version: asReportedString(result.body.contract_version),
                }
              : null,
        };
        io.writeOut(`${JSON.stringify(report)}\n`);
        if (exitCode !== 0) {
          io.exit(exitCode);
        }
        return;
      }

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
      io.exit(exitCode);
    });
}
