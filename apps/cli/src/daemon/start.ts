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
 *
 * **This module is also where the run's identity is frozen.** ADR 0025's consistency check
 * compares three rows — the launch spec `daemon.json` records, the configuration the supervisor
 * actually loaded, and the process that is actually answering — and the third of those is
 * {@link StartedDaemon.identity}: a `run_id` that is the ownership acquisition's own `boot_nonce`,
 * and a `runtime_digest` taken **once**, here, after ownership and before anything binds, over what
 * this process was *launched with*. It is deliberately not read from `daemon.json`: on macOS there
 * is no loaded-configuration query at all (§1.3b D7) and row 3 is the only detector there, so a
 * snapshot that read the desired record would agree with it by construction and see nothing.
 *
 * **This module is also where a run says how it ended.** `newDaemonStart()` writes the run's
 * identity tuple with its start record, and {@link StartedDaemon.close} writes the end — which is
 * what lets `daemon-state.ts`'s breaker count a run's own life instead of the spacing between two
 * supervisor retries. The one path that deliberately writes no end is the `catch` below: an
 * unexpected throw between the start record and the runner is reported as `70` and leaves an entry
 * with no outcome, which D6's unknown rule then bounds by the next start rather than by a claim
 * this process is in no state to make.
 */

import { dirname } from "node:path";
import process from "node:process";
import { identityDigest, payloadDigestIn } from "../install/supervisors/identity.js";
import type { LaunchSettings } from "../runtime/launch-spec.js";
import { resolveWorkspaceRoot } from "../workspace-root.js";
import {
  isStalled,
  markDaemonReady,
  newDaemonStart,
  readDaemonState,
  recordDaemonEnd,
  recordDaemonStart,
  recordStall,
  StateFileUnreadableError,
  updateDaemonState,
  writeRuntimeState,
} from "./daemon-state.js";
import { DIRECTORY_FLUSH_OK, flushDirectory } from "./durable-write.js";
import { DAEMON_INTERNAL_EXIT_CODE, OWNERSHIP_REFUSED_EXIT_CODE } from "./exit-codes.js";
import { resolveIpcSocket } from "./ipc.js";
import { createJobStore, type JobOwner } from "./job-store.js";
import { acquireOwnership, type OwnershipRecord, releaseOwnership } from "./lock.js";
import { type ReconcileOutcome, reconcileJobs } from "./reconciler.js";
import { createJobRunner, type JobRunner, type WorkerRegistry } from "./runner.js";
import { resolveStateDir, stateDirLayout } from "./state-dir.js";
import { resolveTokenPathSetting } from "./token.js";
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
  /** `MCP_CONTRACT_VERSION`, so `status` can report it without an HTTP call. */
  contractVersion: string;
};

/**
 * Who is answering, as the answering process itself states it.
 *
 * Both fields are pinned to real values rather than to anything a reader could derive for itself,
 * which is what makes this the third row of ADR 0025's consistency check rather than a second copy
 * of the first:
 *
 * - **`run_id` is the ownership acquisition's `boot_nonce`** — a fresh `randomUUID()` per
 *   acquisition, the same value `recentStarts[]`, `runtime.json` and every job record's owner
 *   carry. Two runs of an identical configuration therefore differ here and nowhere else, which is
 *   what tells a stale process apart from a fresh one.
 * - **`runtime_digest` is the immutable startup snapshot** {@link captureRuntimeIdentity} takes.
 */
export type RuntimeIdentity = {
  /** The acquisition's `boot_nonce`. */
  run_id: string;
  /** The startup snapshot's digest. */
  runtime_digest: string;
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
  /**
   * What this run says about itself on `/healthz`, frozen before anything bound.
   *
   * A field rather than a method, because "taken once" is a property this type can make true rather
   * than one a caller has to remember: there is no second moment at which a different answer could
   * be produced, and a later edit to `daemon.json` cannot reach it.
   */
  identity: RuntimeIdentity;
  /**
   * The three settings this run resolved, exactly as they went into {@link StartedDaemon.identity}.
   *
   * Handed back so the snapshot is **inspectable** rather than only comparable: a digest that
   * disagrees is worth nothing if nobody can see the four values it was taken over, and this is the
   * one of the four a caller cannot reconstruct from `process`. `serve` resolves the same three
   * through the same pure resolvers for its own messages, which name which input decided each
   * setting — a fact a resolved path does not carry.
   */
  settings: Readonly<LaunchSettings>;
  /** What boot reconciliation did, so a caller can report it. */
  reconciliation: ReconcileOutcome;
  /** The job runner, already holding the reconciled records. */
  runner: JobRunner;
  /** Record where this run is listening and stamp it as a *successful* start. */
  markReady(binding: DaemonBinding): void;
  /**
   * Stop the runner, record how this run ended, and give the state directory back.
   *
   * This is not the `SIGTERM` drain: that one gives an in-flight job 20 s, removes `runtime.json`
   * and the socket, and exits `0`, and it is `daemon/shutdown.ts`'s (P1-7). This is the narrower
   * thing a failed bind and a test teardown need — and it is also the one path every orderly end
   * goes through, which is why the breaker's outcome is written here.
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
  /**
   * `serve --token-file`, as it was given. Resolved here so the startup snapshot carries it.
   *
   * The flag rather than the resolved path, because the precedence — flag, then
   * `XPLAINER_TOKEN_FILE`, then the state directory — is `token.ts`'s to apply and a caller that
   * applied it itself would be a second copy of it.
   */
  tokenFile?: string | undefined;
  /** `serve --socket`, as it was given. Resolved here for the same reason. */
  socket?: string | undefined;
  now?: () => Date;
  killGraceMs?: number;
  logFlushIntervalMs?: number;
};

/**
 * The immutable startup snapshot, over what this process was **launched with**.
 *
 * Four inputs, and each one is there because dropping it would let a real failure pass:
 *
 * - **the effective argv** — `process.argv` is the interpreter followed by the entry file and every
 *   word the supervisor passed, which is exactly `[spec.executable, ...spec.argv]` on the desired
 *   side;
 * - **the resolved settings**, so a daemon that took a platform default while `daemon.json`
 *   recorded something else is a mismatch rather than an agreement;
 * - **the working directory**, which is a launch spec field and a thing a supervisor gets wrong;
 * - **the payload's content hash**, found by walking up from the entry file, so two payloads of the
 *   same release version are still two payloads.
 *
 * Nothing here reads `daemon.json`. That is the point: T17's own verification hand-edits it and
 * requires this value to be **unchanged**, because on macOS this is the only detector there is.
 */
export function captureRuntimeIdentity(request: {
  runId: string;
  settings: LaunchSettings;
  argv?: readonly string[] | undefined;
  cwd?: string | undefined;
  entry?: string | undefined;
}): RuntimeIdentity {
  const argv = request.argv ?? process.argv;
  // The entry file, which is where the payload is looked for. `process.argv[1]` on a real launch;
  // `process.execPath`'s directory is the fallback, because a host that was handed no entry at all
  // is still running out of *some* directory and answering "no payload" is a fact rather than a
  // guess.
  const entry = request.entry ?? argv[1] ?? process.execPath;
  return Object.freeze({
    run_id: request.runId,
    runtime_digest: identityDigest({
      argv,
      settings: request.settings,
      cwd: request.cwd ?? process.cwd(),
      runtimeDigest: payloadDigestIn(dirname(entry)),
    }),
  });
}

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

  // The identity, frozen here: ownership is held, the settings are resolved, and nothing has bound.
  // `serve` asks for the same three settings again through the same pure resolvers, which is why
  // they travel back out on `StartedDaemon.settings` rather than being resolved twice.
  const settings: LaunchSettings = {
    stateDir,
    tokenFile: resolveTokenPathSetting(stateDir, {
      ...(options.tokenFile === undefined ? {} : { flag: options.tokenFile }),
    }).path,
    socket: resolveIpcSocket({
      stateDir,
      ...(options.socket === undefined ? {} : { flag: options.socket }),
    }).path,
  };
  const identity = captureRuntimeIdentity({ runId: ownership.boot_nonce, settings });

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
    workers: options.workers ?? createWorkerRegistry({ root: workspaceRoot, stateDir }),
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
      identity,
      settings,
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
        // write is what makes ADR 0020's "the recorded port is a contract" true; `socket_path` and
        // `contract_version` are here so a reader learns them without an HTTP call it may not be
        // able to make — and `socket_path` in particular is what a `--socket` was for, since a
        // setting nothing records is a setting nothing can check.
        //
        // `token_file` is **not** here, and its absence is load-bearing: it is written by
        // `commands/serve.ts` in the same call as `token_origin`, at the moment the token's
        // provenance is decided, because the two are one fact about one file and a record carrying
        // either alone answers R-SEC-9 about a file it cannot name. Readiness is far too late for
        // it — a start that mints and then fails to bind never reaches this method at all.
        updateDaemonState(stateDir, {
          port: binding.port,
          contract_version: binding.contractVersion,
          socket_path: binding.socket,
        });
        markDaemonReady(stateDir, ownership.boot_nonce, now().toISOString());
      },

      async close(drainTimeoutMs = 0): Promise<void> {
        // `finally`, not a plain sequence: a drain that rejects — step 4 or 5 writing a record onto
        // a full disk — must still record this run's end and give the state directory back, or the
        // next `serve` meets a lock held by a pid that is no longer serving and has to wait for the
        // staleness check to say so. The rejection still propagates: `shutdown.ts` is what decides
        // the exit code, and it tears the rest down either way.
        try {
          await runner.drain(drainTimeoutMs);
        } finally {
          try {
            // The breaker's evidence, written by the run it is about. `close()` is reached from
            // every orderly end this process has — an unreadable token file, a socket that cannot
            // be prepared, a bind that fails, and the drain itself — so a run that ends *without*
            // one of these ended by `SIGKILL`, a panic or a power cut, and the absence of the
            // record is what puts it under D6's unknown rule rather than a guess made in its name.
            recordDaemonEnd(stateDir, ownership.boot_nonce, now().toISOString());
          } finally {
            releaseOwnership(stateDir, ownership);
          }
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
