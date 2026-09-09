/**
 * The daemon's control channel: asking a *running* daemon to drain, and the two things around it.
 *
 * `install/lifecycle.ts` addresses the **supervisor** — start this unit, stop that job, is the task
 * switched off. This file addresses the **daemon**, which is a different party: it is the only one
 * that knows what is in flight, and
 * [ADR 0024](../../../../docs/adr/0024-durable-jobs-and-boot-reconciliation.md) §Drain on planned
 * restart is its six steps and not the supervisor's. Three things live here:
 *
 * - {@link requestDrain} — one `POST /api/daemon/drain` over the IPC socket. **The socket, never
 *   the port**: ADR 0020 §The agent path is IPC, not TCP makes filesystem permissions that
 *   transport's authentication, and `server.ts` answers this route `404` over TCP with or without a
 *   bearer token. A token that lets a caller render must not also let it stop the machine's daemon.
 * - {@link clearStartLatch} — the *application* half of what `xplainer daemon restart` clears
 *   first. `daemon/start.ts` refuses to start while `daemon.json` carries a `stalled` record, and
 *   `isStalled()` re-latches from `recentStarts[]` alone, so clearing one without the other is a
 *   restart that latches again on the next start.
 * - {@link awaitStopped} — the wait for the process named in the acknowledgement to be gone, and
 *   for step 6 to have removed `runtime.json`.
 *
 * **What "waits for exit `0`" can honestly mean from outside.** The exit code of a supervised
 * process is the supervisor's to know, and only one of the three offers a documented query for it
 * (`systemctl --user show -p Result -p ExecMainStatus`; `launchctl print`'s own manual says "This
 * output is NOT API in any sense at all", and `install/lifecycle.ts` calls it nowhere). So the
 * evidence this module produces is the evidence an outside observer can have: the daemon accepted
 * the drain, its pid went away, and `runtime.json` — which only step 6 removes — is gone.
 * `install/lifecycle.ts` adds the supervisor's own verdict on the one platform that has one.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { createSocketFetch } from "../mcp/socket-fetch.js";
import { DRAIN_PATH, type DrainAcknowledgement } from "../server.js";
import {
  readDaemonState,
  readRuntimeState,
  type StallRecord,
  updateDaemonState,
} from "./daemon-state.js";
import { isAlive } from "./worker-identity.js";

/** How long one `POST /api/daemon/drain` may take to be *acknowledged*. */
export const DRAIN_REQUEST_TIMEOUT_MS = 5_000;

/** How long {@link awaitStopped} waits for the process to be gone, by default. */
export const STOP_TIMEOUT_MS = 30_000;

/** How often it asks again. */
export const STOP_POLL_INTERVAL_MS = 100;

/**
 * Why a drain was not accepted, in the four cases that have different next steps.
 *
 * - `not-listening` — nothing is on that socket: no daemon, or one that has already gone. The
 *   caller's goal is met, which is why `daemon restart` treats it as an already-stopped daemon.
 * - `no-route` — something answered `404`, so it is a daemon older than this route. The remedy is
 *   the supervisor's stop command, and it is a fallback the caller has to choose deliberately.
 * - `refused` — it answered, with something else. The status is in the detail.
 * - `unreadable` — it answered `202` with a body this release cannot read, which is a skew worth
 *   naming rather than a drain worth assuming.
 */
export type DrainRefusalReason = "not-listening" | "no-route" | "refused" | "unreadable";

/** What one {@link requestDrain} produced. */
export type DrainResult =
  | { ok: true; acknowledgement: DrainAcknowledgement }
  | { ok: false; reason: DrainRefusalReason; detail: string };

/** What {@link requestDrain} needs. */
export type DrainRequest = {
  /** The unix socket path, or the Windows named pipe name, from `daemon.json`'s `socket_path`. */
  socketPath: string;
  /** How long to wait for the acknowledgement. Defaults to {@link DRAIN_REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number | undefined;
  /** The HTTP client. A parameter so a refusal can be tested without a daemon to refuse it. */
  fetch?: ((url: string, init: RequestInit) => Promise<Response>) | undefined;
};

/** The errors a dial gets when there is nothing at the other end of the path. */
const ABSENT_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
]);

/** The `code` of a thrown dial failure, wherever Node hung it. */
function errorCode(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== undefined && cause !== null) {
      return errorCode(cause);
    }
  }
  return "";
}

/** Whether a body is the acknowledgement `server.ts` documents. */
function asAcknowledgement(body: unknown): DrainAcknowledgement | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (
    record.event !== "draining" ||
    typeof record.timeout_ms !== "number" ||
    typeof record.pid !== "number" ||
    typeof record.already_draining !== "boolean"
  ) {
    return null;
  }
  return {
    event: "draining",
    timeout_ms: record.timeout_ms,
    pid: record.pid,
    already_draining: record.already_draining,
  };
}

/**
 * Ask the daemon on this socket to run ADR 0024's six steps.
 *
 * Returns as soon as the daemon has **acknowledged**, which is the whole contract of the route: the
 * drain itself takes up to the cap the answer carries, and {@link awaitStopped} is the other half.
 *
 * The transport is `mcp/socket-fetch.ts` — the one HTTP-over-a-unix-socket client in this package,
 * written because Node's own `fetch` has no supported way to name a socket path. Reusing it is
 * deliberate: a second implementation of "speak HTTP to the daemon's socket" is a second thing to
 * get the `Host` header wrong in.
 */
export async function requestDrain(request: DrainRequest): Promise<DrainResult> {
  const timeoutMs = request.timeoutMs ?? DRAIN_REQUEST_TIMEOUT_MS;
  const call = request.fetch ?? createSocketFetch({ socketPath: request.socketPath });

  let response: Response;
  try {
    response = await call(`http://xplainer.ipc${DRAIN_PATH}`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const code = errorCode(error);
    if (ABSENT_CODES.has(code)) {
      return {
        ok: false,
        reason: "not-listening",
        detail: `nothing is listening on ${request.socketPath} (${code})`,
      };
    }
    return {
      ok: false,
      reason: "refused",
      detail: `${request.socketPath} could not be asked: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (response.status === 404) {
    return {
      ok: false,
      reason: "no-route",
      detail:
        `the daemon on ${request.socketPath} answered 404: it is a release older than ` +
        `POST ${DRAIN_PATH}, so it can only be stopped through its supervisor`,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: "refused",
      detail: `the daemon on ${request.socketPath} answered ${String(response.status)}`,
    };
  }

  const acknowledgement = asAcknowledgement(await response.json().catch(() => null));
  if (acknowledgement === null) {
    return {
      ok: false,
      reason: "unreadable",
      detail:
        `the daemon on ${request.socketPath} accepted the drain and described it in a shape this ` +
        "release does not understand",
    };
  }
  return { ok: true, acknowledgement };
}

/** What {@link clearStartLatch} found and removed. */
export type ClearedLatch = {
  /** The latched stall that was there, or `null` if the daemon had not latched. */
  stalled: StallRecord | null;
  /** How many start records were discarded with it. */
  startsCleared: number;
};

/**
 * Clear the application's own failure latch, so the next `serve` is allowed to start.
 *
 * **Both fields, not just `stalled`.** `daemon/start.ts` refuses outright while `stalled` is set,
 * and then asks `isStalled(recentStarts)` — which latches again from a history of five fast
 * failures the moment a sixth start joins it. Clearing the record and leaving the history is
 * therefore a `restart` that appears to work and re-latches on the next start, which is the bug
 * this comment exists to stop somebody re-introducing.
 *
 * The history is evidence, not accounting: `daemon status` reports it as "failed starts", and a
 * restart is exactly the moment a person has decided that history is spent.
 */
export function clearStartLatch(stateDir: string): ClearedLatch {
  const before = readDaemonState(stateDir);
  if (before.stalled === null && before.recentStarts.length === 0) {
    return { stalled: null, startsCleared: 0 };
  }
  updateDaemonState(stateDir, { stalled: null, recentStarts: [] });
  return { stalled: before.stalled, startsCleared: before.recentStarts.length };
}

/** What {@link awaitStopped} needs. */
export type StopWaitRequest = {
  /** The state directory whose `runtime.json` step 6 removes. */
  stateDir: string;
  /** The process from the acknowledgement. */
  pid: number;
  /** The whole budget. Defaults to {@link STOP_TIMEOUT_MS}. */
  timeoutMs?: number | undefined;
  /** How often to ask. Defaults to {@link STOP_POLL_INTERVAL_MS}. */
  intervalMs?: number | undefined;
  /** The clock, for a test that does not want to spend the budget. */
  now?: (() => number) | undefined;
};

/** What the wait saw. */
export type StopWaitResult = {
  /** Whether the process is gone. */
  stopped: boolean;
  /** Whether `runtime.json` is gone with it, which is step 6 having run. */
  runtimeRecordRemoved: boolean;
  elapsedMs: number;
};

/**
 * Wait for the drained process to be gone, and for step 6 to have removed `runtime.json`.
 *
 * Both, because either alone lies: a `runtime.json` that is still there after the pid went is a
 * daemon that was killed rather than drained, and a pid that is still alive when the file has gone
 * is a drain that is still finishing. `isAlive()` is `process.kill(pid, 0)` and treats `EPERM` as
 * alive, which is the right side to err on — a pid we may not signal is a pid that is running.
 *
 * There is a pid-reuse hazard in any such wait and it is bounded here by how short the wait is: the
 * pid came from an acknowledgement seconds earlier, and the kernel would have to wrap its whole pid
 * space inside the drain's own budget to hand it out again.
 */
export async function awaitStopped(request: StopWaitRequest): Promise<StopWaitResult> {
  const now = request.now ?? Date.now;
  const intervalMs = request.intervalMs ?? STOP_POLL_INTERVAL_MS;
  const started = now();
  const deadline = started + (request.timeoutMs ?? STOP_TIMEOUT_MS);

  for (;;) {
    const stopped = !isAlive(request.pid);
    const runtimeRecordRemoved = readRuntimeState(request.stateDir) === null;
    if (stopped && runtimeRecordRemoved) {
      return { stopped, runtimeRecordRemoved, elapsedMs: now() - started };
    }
    if (now() >= deadline) {
      return { stopped, runtimeRecordRemoved, elapsedMs: now() - started };
    }
    await sleep(intervalMs);
  }
}
