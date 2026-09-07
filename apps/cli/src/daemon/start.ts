/**
 * `serve`'s start-up, in the order [ADR 0024](../../../../docs/adr/0024-durable-jobs-and-boot-reconciliation.md)
 * makes an invariant: **ownership, then reconciliation, then bind.**
 *
 * That ordering is the decision, not an implementation note. Reconciliation is the step that
 * rewrites other processes' records, so a second `serve` — started by hand while the supervised
 * daemon is mid-render — must be turned away *before* it touches anything. ADR 0020's own note
 * says it plainly: "the argument that a second `serve` is harmless because the recorded port makes
 * it exit `10` holds only at **bind**, and reconciliation happens earlier — so ownership, not the
 * port, is what makes the single-writer property true."
 *
 * The bind itself stays in `commands/serve.ts`, which is what {@link StartedDaemon.markReady}
 * exists for: this module hands back a reconciled runner and a way to record the port once
 * something is actually listening on it.
 *
 * The runner is built here, so the **worker registry** is registered here too: `workers.ts` turns a
 * job record into the narration worker or the pinned Remotion CLI, over the workspace root
 * `workspace-root.ts` resolves from this run's state directory. That root travels back out on
 * {@link StartedDaemon.workspaceRoot} so the backend `commands/serve.ts` builds serves the same
 * videos the workers render.
 *
 * Three refusals leave here as an outcome rather than an exception, because each one has a
 * documented exit code and a sentence a user can act on (`docs/ARCHITECTURE.md` §6):
 *
 * - **`10`** — another process owns the state directory. Nothing was written.
 * - **`11`** — `daemon.json` exists and cannot be read as JSON. Refusing beats guessing, because
 *   the file carries the crash history the circuit breaker counts.
 * - **`0`** — the circuit breaker is latched. Exit `0` is the portable "do not restart" signal on
 *   all three supervisors (ADR 0020 §Restart on crash), so a crash loop stops being a crash loop.
 */

import { resolveWorkspaceRoot } from "../workspace-root.js";
import {
  isStalled,
  markDaemonReady,
  newDaemonStart,
  readDaemonState,
  recordDaemonStart,
  recordStall,
  StateFileUnreadableError,
  updateDaemonState,
  writeRuntimeState,
} from "./daemon-state.js";
import { DIRECTORY_FLUSH_OK, flushDirectory } from "./durable-write.js";
import { DAEMON_INTERNAL_EXIT_CODE, OWNERSHIP_REFUSED_EXIT_CODE } from "./exit-codes.js";
import { createJobStore, type JobOwner } from "./job-store.js";
import { acquireOwnership, type OwnershipRecord, releaseOwnership } from "./lock.js";
import { type ReconcileOutcome, reconcileJobs } from "./reconciler.js";
import { createJobRunner, type JobRunner, type WorkerRegistry } from "./runner.js";
import { resolveStateDir, stateDirLayout } from "./state-dir.js";
import { selfIdentity } from "./worker-identity.js";
import { createWorkerRegistry } from "./workers.js";

/**
 * What the daemon is listening on, once something is.
 *
 * It is one argument rather than four because the two state files are written from it in one act:
 * the durable half of it goes to `daemon.json` (the port a later `serve` and `status` read back, the
 * contract version, the token file's path) and the ephemeral half to `runtime.json` (this run's pid,
 * its addresses, its socket) — ADR 0020 §Port and discovery's split, applied at the one moment both
 * facts are known.
 */
export type DaemonBinding = {
  /** The TCP port actually bound, resolved — so `--port 0` records its real value. */
  port: number;
  /** Every origin this run answers on. */
  addresses: readonly string[];
  /** The IPC socket path, or `null` while the daemon has only a TCP listener (P1-9). */
  socket: string | null;
  /** The path — never the value — of the bearer token file (R-SEC-6). */
  tokenFile: string;
  /** `MCP_CONTRACT_VERSION`, so `status` can report it without an HTTP call. */
  contractVersion: string;
};

/** What a started daemon hands back to the command that binds the listeners. */
export type StartedDaemon = {
  stateDir: string;
  /**
   * The shared Remotion workspace root this run's workers read and write under.
   *
   * Resolved here, once, and handed back so that `commands/serve.ts` builds the backend over the
   * same root the worker registry was built over. Two independent resolutions could disagree — a
   * test that overrides the state directory but not `XPLAINER_VIDEOS_DIR` is exactly that case —
   * and a backend that enqueues into one workspace while the workers render out of another fails
   * in a way no error message would explain.
   */
  workspaceRoot: string;
  /** The lock this run holds. */
  ownership: OwnershipRecord;
  /** What boot reconciliation did, so a caller can report it. */
  reconciliation: ReconcileOutcome;
  /** The job runner, already holding the reconciled records. */
  runner: JobRunner;
  /** Record where this run is listening and stamp it as a *successful* start. */
  markReady(binding: DaemonBinding): void;
  /**
   * Stop the runner and give the state directory back.
   *
   * This is not the `SIGTERM` drain: that one gives an in-flight job 20 s, removes `runtime.json`
   * and the socket, and exits `0`, and it lands with roadmap P1-7 alongside the signal handler.
   * This is the narrower thing a failed bind and a test teardown need.
   */
  close(drainTimeoutMs?: number): Promise<void>;
};

/** Either a running daemon, or a refusal with the exit code and the sentence that explains it. */
export type DaemonStartOutcome =
  | { started: true; daemon: StartedDaemon }
  | { started: false; exitCode: number; message: string };

/** What {@link startDaemon} needs, all of it optional and all of it injected by the tests. */
export type StartDaemonOptions = {
  /** Overrides `XPLAINER_STATE_DIR` and the platform default. */
  stateDir?: string;
  /**
   * Which job kinds this daemon can run.
   *
   * Defaults to the real registry from `workers.ts` over {@link StartedDaemon.workspaceRoot}: the
   * narration worker and the two Remotion commands. Only the tests pass one, and they pass a worker
   * that needs neither Remotion nor a TTS server.
   */
  workers?: WorkerRegistry;
  /** Where the start-up narrative goes. Silent by default. */
  log?: (line: string) => void;
  now?: () => Date;
  killGraceMs?: number;
  logFlushIntervalMs?: number;
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Acquire, reconcile, and build the runner — or report why not.
 *
 * Never throws for a condition that has an exit code; an unexpected throw is converted to `70`,
 * which is the row `docs/ARCHITECTURE.md` §6 gives to "internal error".
 */
export async function startDaemon(options: StartDaemonOptions = {}): Promise<DaemonStartOutcome> {
  const stateDir = options.stateDir ?? resolveStateDir();
  const log = options.log ?? ((): void => {});
  const now = options.now ?? ((): Date => new Date());

  const acquisition = await acquireOwnership(stateDir);
  for (const step of acquisition.steps) {
    log(`xplainer serve: ${step}`);
  }
  if (!acquisition.ok) {
    return {
      started: false,
      exitCode: OWNERSHIP_REFUSED_EXIT_CODE,
      message:
        `xplainer serve: another xplainer daemon already owns ${stateDir} ` +
        `(${stateDirLayout(stateDir).lock}); this process wrote nothing and is exiting ` +
        `${OWNERSHIP_REFUSED_EXIT_CODE}. Stop the running daemon, or point this one at another ` +
        "state directory with XPLAINER_STATE_DIR.",
    };
  }

  const ownership = acquisition.record;
  try {
    return await startOwnedDaemon({ ...options, stateDir, log, now, ownership });
  } catch (error) {
    releaseOwnership(stateDir, ownership);
    if (error instanceof StateFileUnreadableError) {
      return { started: false, exitCode: error.exitCode, message: error.message };
    }
    return {
      started: false,
      exitCode: DAEMON_INTERNAL_EXIT_CODE,
      message: `xplainer serve: could not start: ${describe(error)}`,
    };
  }
}

type OwnedStartOptions = StartDaemonOptions & {
  stateDir: string;
  log: (line: string) => void;
  now: () => Date;
  ownership: OwnershipRecord;
};

async function startOwnedDaemon(options: OwnedStartOptions): Promise<DaemonStartOutcome> {
  const { stateDir, log, now, ownership } = options;
  const workspaceRoot = resolveWorkspaceRoot(stateDir);

  // Probed once, and recorded rather than thrown: ADR 0024 §Write durability requires the flush and
  // refuses to assert one behaviour for all three platforms, so a platform that cannot flush a
  // directory is a line in the log and a field in `daemon.json`, not a crashed daemon.
  const directoryFlush = flushDirectory(stateDir);
  if (directoryFlush !== DIRECTORY_FLUSH_OK) {
    log(
      `xplainer serve: this platform cannot flush a directory (${directoryFlush}); a job record's ` +
        "directory entry is therefore durable only as far as the filesystem makes it.",
    );
  }

  // The breaker is decided on the history *before* this run is appended, so "the last five runs"
  // means five previous runs and not four plus this attempt. A latched stall is honoured without
  // re-deciding it: ADR 0020 gives `xplainer daemon restart` the job of clearing it.
  const startedAt = now();
  const before = readDaemonState(stateDir);
  const latched = before.stalled;
  if (latched !== null) {
    releaseOwnership(stateDir, ownership);
    return {
      started: false,
      exitCode: 0,
      message: `xplainer serve: this daemon is stalled since ${latched.at}: ${latched.reason}`,
    };
  }
  const stall = isStalled(before.recentStarts, startedAt.getTime());
  if (stall !== null) {
    recordStall(stateDir, stall);
    releaseOwnership(stateDir, ownership);
    return { started: false, exitCode: 0, message: `xplainer serve: ${stall.reason}` };
  }

  recordDaemonStart(stateDir, newDaemonStart(ownership.boot_nonce, startedAt.toISOString()), {
    directory_flush: directoryFlush,
  });

  const store = createJobStore(stateDir);
  const reconciliation = await reconcileJobs(store, {
    now,
    ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
  });
  for (const line of describeReconciliation(reconciliation)) {
    log(`xplainer serve: ${line}`);
  }

  const owner: JobOwner = { ...selfIdentity(), run_id: ownership.boot_nonce };
  const runner = createJobRunner({
    store,
    owner,
    records: reconciliation.records,
    now,
    // The real three kinds, unless a caller substitutes its own — which only the tests do, with a
    // worker that needs neither Remotion nor a TTS server.
    workers: options.workers ?? createWorkerRegistry({ root: workspaceRoot }),
    ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
    ...(options.logFlushIntervalMs === undefined
      ? {}
      : { logFlushIntervalMs: options.logFlushIntervalMs }),
  });

  return {
    started: true,
    daemon: {
      stateDir,
      workspaceRoot,
      ownership,
      reconciliation,
      runner,

      markReady(binding: DaemonBinding): void {
        writeRuntimeState(stateDir, {
          pid: ownership.pid,
          run_id: ownership.boot_nonce,
          boot_id: ownership.boot_id,
          port: binding.port,
          addresses: [...binding.addresses],
          socket: binding.socket,
          started_at: startedAt.toISOString(),
        });
        // The durable half. `port` is what a later `serve` binds and what `status` probes, so this
        // write is what makes ADR 0020's "the recorded port is a contract" true; `token_file` and
        // `contract_version` are here so a reader learns both without an HTTP call it may not be
        // able to make.
        updateDaemonState(stateDir, {
          port: binding.port,
          contract_version: binding.contractVersion,
          token_file: binding.tokenFile,
        });
        markDaemonReady(stateDir, ownership.boot_nonce, now().toISOString());
      },

      async close(drainTimeoutMs = 0): Promise<void> {
        // `finally`, not a plain sequence: a drain that rejects — step 4 or 5 writing a record onto
        // a full disk — must still give the state directory back, or the next `serve` meets a lock
        // held by a pid that is no longer serving and has to wait for the staleness check to say
        // so. The rejection still propagates: `shutdown.ts` is what decides the exit code, and it
        // tears the rest down either way.
        try {
          await runner.drain(drainTimeoutMs);
        } finally {
          releaseOwnership(stateDir, ownership);
        }
      },
    },
  };
}

/** Turn a reconciliation into the lines a start-up log should carry, and nothing when it did none. */
export function describeReconciliation(outcome: ReconcileOutcome): string[] {
  const lines: string[] = [];
  if (outcome.reconciled.length > 0) {
    lines.push(
      `reconciled ${outcome.reconciled.length} job(s) left behind by a previous run: ` +
        `${outcome.reconciled.join(", ")} are now error/daemon_restarted.`,
    );
  }
  if (outcome.killed.length > 0) {
    lines.push(`stopped ${outcome.killed.length} orphaned worker process group(s).`);
  }
  for (const moved of outcome.quarantined) {
    lines.push(`job ${moved.job_id}: output directory quarantined to ${moved.to}.`);
  }
  if (outcome.corrupt.length > 0) {
    lines.push(
      `quarantined ${outcome.corrupt.length} unreadable record(s): ${outcome.corrupt.join(", ")}.`,
    );
  }
  if (outcome.newerFormat.length > 0) {
    lines.push(
      `left ${outcome.newerFormat.length} record(s) written by a newer daemon untouched: ` +
        `${outcome.newerFormat.join(", ")}.`,
    );
  }
  return lines;
}
