/**
 * The two state files, and the circuit breaker that lives in the durable one.
 *
 * [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md) §Port and discovery gives
 * them opposite lifetimes: **`daemon.json` is durable and must survive reboot**, while
 * **`runtime.json` is ephemeral, written at bind and never trusted without a liveness check**.
 *
 * `recentStarts[]` and the `stalled` flag live in `daemon.json`, and that placement is a
 * correction, not a preference. ADR 0020 §Restart on crash originally put them in `runtime.json`;
 * its own note of 2026-09-06 records why that was wrong — on Linux `runtime.json` sits in systemd's
 * `RuntimeDirectory=`, where "the innermost subdirectories are removed when the unit is stopped",
 * so "the circuit breaker therefore forgets its history on every clean stop, which is not what a
 * breaker is for". [ADR 0024](../../../../docs/adr/0024-durable-jobs-and-boot-reconciliation.md)
 * §Consequences moves crash history to the durable directory alongside the job store, and this file
 * is where that move happens.
 *
 * **How a failed start is recognised without a corpse.** ADR 0020 words the breaker as "if the last
 * five runs all failed within 30 seconds of starting". A daemon that was `SIGKILL`ed writes no
 * epitaph, so neither the failure nor its timing can be read from the dead process. Both are
 * inferred from what *is* durable:
 *
 * - a run **failed** if its entry has no `ready_at` — it never got as far as announcing itself, and
 *   {@link markDaemonReady} is called immediately after the listeners are bound;
 * - it failed **fast** if the next run started within {@link FAILED_START_WINDOW_MS} of it, which is
 *   what a supervisor restarting a crash loop looks like from here.
 *
 * {@link isStalled} is a pure function over those entries so both halves are testable without
 * killing anything, and the daemon exits `0` when it trips — the portable "do not restart" signal
 * on all three supervisors.
 *
 * Every write is a read-modify-write that **preserves keys this daemon does not know about**. Phase
 * 2's `xplainer daemon install` owns most of `daemon.json` — the socket path, the token file path,
 * the supervisor kind and artefact, the installing version — and a `serve` that rewrote the file
 * from its own narrow view would silently uninstall the daemon it is part of.
 */

import { readFileSync } from "node:fs";
import process from "node:process";
import { writeJsonDurably } from "./durable-write.js";
import { STATE_UNREADABLE_EXIT_CODE } from "./exit-codes.js";
import { stateDirLayout } from "./state-dir.js";

/** The version this daemon writes into both files. */
export const STATE_FORMAT_VERSION = 1;

/** A run that never reached ready, and whose successor started within this, failed fast. */
export const FAILED_START_WINDOW_MS = 30_000;

/** How many consecutive fast failures trip the breaker (ADR 0020 §Restart on crash). */
export const STALL_AFTER_FAILED_STARTS = 5;

/** How much start history is kept. Enough to decide, and short enough to read with `cat`. */
export const RECENT_STARTS_KEPT = 10;

/** One entry in `recentStarts[]`. */
export type DaemonStart = {
  started_at: string;
  pid: number;
  /** The acquisition's `boot_nonce`, so two runs with the same pid are told apart. */
  run_id: string;
  /** When the daemon announced itself, or `null` if it never did. */
  ready_at: string | null;
};

/** The latched stall the breaker writes, in words a `status` command can print. */
export type StallRecord = {
  at: string;
  reason: string;
};

/** The fields of `daemon.json` this daemon reads and writes. Others are preserved untouched. */
export type DaemonState = {
  format_version: number;
  /** The port the last successful bind used. */
  port: number | null;
  /** The contract version this daemon speaks, so `status` can report it without an HTTP call. */
  contract_version: string | null;
  /** What a directory flush did on this platform, recorded once rather than thrown. */
  directory_flush: string | null;
  recentStarts: DaemonStart[];
  stalled: StallRecord | null;
};

/** The fields of `runtime.json` this story writes. */
export type RuntimeState = {
  format_version: number;
  pid: number;
  /** The daemon run, matching the `run_id` in `recentStarts[]` and in every job record's owner. */
  run_id: string;
  boot_id: string | null;
  port: number;
  started_at: string;
};

/** A state file exists and cannot be read. Carries ADR 0020's exit code for that condition. */
export class StateFileUnreadableError extends Error {
  readonly exitCode: number = STATE_UNREADABLE_EXIT_CODE;
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(`xplainer serve: ${path} exists but cannot be read as JSON (${String(cause)})`);
    this.name = "StateFileUnreadableError";
    this.path = path;
  }
}

function readObject(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    // Absent is the ordinary state of a directory no daemon has used yet. Anything else — a mode
    // that forbids the read, a directory where a file should be — is a state file that exists and
    // cannot be read, which ADR 0020 gives its own exit code rather than silently overwriting.
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw new StateFileUnreadableError(path, error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new StateFileUnreadableError(path, error);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new StateFileUnreadableError(path, "the file does not hold a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function asStarts(value: unknown): DaemonStart[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is DaemonStart => {
    if (typeof entry !== "object" || entry === null) {
      return false;
    }
    const candidate = entry as Partial<DaemonStart>;
    return typeof candidate.started_at === "string" && typeof candidate.pid === "number";
  });
}

function asStall(value: unknown): StallRecord | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Partial<StallRecord>;
  return typeof candidate.at === "string" && typeof candidate.reason === "string"
    ? { at: candidate.at, reason: candidate.reason }
    : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Read `daemon.json`, filling in the defaults of a directory that has never held one. */
export function readDaemonState(stateDir: string): DaemonState {
  const raw = readObject(stateDirLayout(stateDir).daemonState);
  return {
    format_version:
      typeof raw.format_version === "number" ? raw.format_version : STATE_FORMAT_VERSION,
    port: typeof raw.port === "number" ? raw.port : null,
    contract_version: asNullableString(raw.contract_version),
    directory_flush: asNullableString(raw.directory_flush),
    recentStarts: asStarts(raw.recentStarts),
    stalled: asStall(raw.stalled),
  };
}

/**
 * Merge `changes` into `daemon.json` and write it durably, keeping every other key.
 *
 * The read is what preserves an installer's fields; the durable write is what makes the breaker's
 * history survive the crash it is counting.
 */
export function updateDaemonState(stateDir: string, changes: Partial<DaemonState>): DaemonState {
  const path = stateDirLayout(stateDir).daemonState;
  const raw = readObject(path);
  const next = { ...raw, format_version: STATE_FORMAT_VERSION, ...changes };
  writeJsonDurably(path, next);
  return readDaemonState(stateDir);
}

/**
 * Has this daemon failed to start {@link STALL_AFTER_FAILED_STARTS} times in a row, fast?
 *
 * `starts` is the history *including* the run being decided, which is why the newest entry's
 * failure window is measured against `nowMs`: a supervisor that has restarted the daemon five times
 * in the last two and a half minutes is a crash loop whether or not the sixth attempt has died yet.
 */
export function isStalled(starts: readonly DaemonStart[], nowMs: number): StallRecord | null {
  if (starts.length < STALL_AFTER_FAILED_STARTS) {
    return null;
  }
  const recent = starts.slice(-STALL_AFTER_FAILED_STARTS);
  for (const [index, start] of recent.entries()) {
    if (start.ready_at !== null) {
      return null;
    }
    const next = recent[index + 1];
    const endedBy = next === undefined ? nowMs : Date.parse(next.started_at);
    if (
      !Number.isFinite(endedBy) ||
      endedBy - Date.parse(start.started_at) > FAILED_START_WINDOW_MS
    ) {
      return null;
    }
  }
  const first = recent[0];
  return {
    at: new Date(nowMs).toISOString(),
    reason:
      `the last ${STALL_AFTER_FAILED_STARTS} starts each failed before the daemon was ready, ` +
      `and each within ${FAILED_START_WINDOW_MS / 1000} s of starting (first at ${first?.started_at ?? "unknown"}). ` +
      "Exiting 0 so the supervisor stops restarting; `xplainer daemon restart` clears this.",
  };
}

/** Add this run to `recentStarts[]`, trimming the history to what a decision needs. */
export function recordDaemonStart(
  stateDir: string,
  start: DaemonStart,
  extra: Partial<DaemonState> = {},
): DaemonState {
  const history = readDaemonState(stateDir).recentStarts;
  const recentStarts = [...history, start].slice(-RECENT_STARTS_KEPT);
  return updateDaemonState(stateDir, { recentStarts, ...extra });
}

/** Stamp `ready_at` on this run's entry, which is what makes it a *successful* start. */
export function markDaemonReady(stateDir: string, runId: string, readyAt: string): DaemonState {
  const recentStarts = readDaemonState(stateDir).recentStarts.map((entry) =>
    entry.run_id === runId ? { ...entry, ready_at: readyAt } : entry,
  );
  return updateDaemonState(stateDir, { recentStarts });
}

/** Latch the breaker, in words `xplainer daemon status` can print verbatim. */
export function recordStall(stateDir: string, stall: StallRecord): DaemonState {
  return updateDaemonState(stateDir, { stalled: stall });
}

/**
 * Write `runtime.json` after the listener is bound.
 *
 * This story writes the pid, the run and the bound port. The bound addresses, the socket path and
 * the removal on clean shutdown arrive with the `SIGTERM` drain and the IPC listener, which are
 * ADR 0020 §The agent path is IPC and roadmap P1-7. Nothing reads this file without a liveness
 * check, which is why a stale one left by a `SIGKILL` is a hint rather than a lie.
 */
export function writeRuntimeState(
  stateDir: string,
  state: Omit<RuntimeState, "format_version">,
): RuntimeState {
  const record: RuntimeState = { format_version: STATE_FORMAT_VERSION, ...state };
  writeJsonDurably(stateDirLayout(stateDir).runtimeState, record);
  return record;
}

/** Read `runtime.json`, or `null` where none has been written. */
export function readRuntimeState(stateDir: string): Record<string, unknown> | null {
  const raw = readObject(stateDirLayout(stateDir).runtimeState);
  return Object.keys(raw).length === 0 ? null : raw;
}

/** This process's own start entry, before it is known whether the start succeeded. */
export function newDaemonStart(runId: string, startedAt: string): DaemonStart {
  return { started_at: startedAt, pid: process.pid, run_id: runId, ready_at: null };
}
