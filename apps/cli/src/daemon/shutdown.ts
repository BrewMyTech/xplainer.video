/**
 * `SIGTERM`, and the six steps between it and exit `0`.
 *
 * [ADR 0024](../../../../docs/adr/0024-durable-jobs-and-boot-reconciliation.md) §Drain on planned
 * restart is the whole specification, in its own order:
 *
 * 1. **Stop accepting new jobs** — a named "shutting down" error, not a connection reset. That is
 *    `JobRunner.drain()`'s first act: `enqueue()` throws `NotAcceptingJobsError` from then on.
 * 2. **Let in-flight jobs reach a checkpoint for at most 20 s** ({@link DEFAULT_DRAIN_TIMEOUT_MS}).
 * 3. **Hard-stop: kill Chrome and ffmpeg children** — the worker's whole *process group*, `SIGTERM`
 *    then `SIGKILL`, because the expensive half of a render is what the worker started.
 * 4. **Mark anything still `running` as `error`** with `error_code: "daemon_shutdown"`.
 * 5. **Mark anything still `queued` the same way**, deliberately: "a queued job has no partial
 *    state, so it is always safe to retry — said here rather than left to be inferred, because an
 *    agent that cannot distinguish the two cases has to treat both as suspect."
 * 6. **Remove `runtime.json` and the socket, exit `0`** — ADR 0020's portable "do not restart"
 *    signal on all three supervisors.
 *
 * Steps 1–5 are the runner's and are reached through `StartedDaemon.close(timeoutMs)`; this module
 * owns the signal, the ordering, step 6, and the exit. "Twenty seconds plus teardown fits inside
 * P1-7's 25-second budget."
 *
 * **Why the listeners close after the drain and not before.** Closing first would reset the
 * connection of a client that is mid-request — including the `explainer_job` poll an agent is
 * making *about the job being drained*, which is the one answer it most needs. `close()` on a Node
 * server stops new connections and lets in-flight ones finish, which is the behaviour step 1 asks
 * for at the transport layer.
 *
 * **Why it exits rather than letting the loop drain.** A daemon whose last handle happens to be
 * unref'd would exit on its own; one that has any live handle left would hang for ever, and P1-7
 * is a *bounded* 25 seconds. So the exit is explicit and the code is `0`, which is the difference
 * between a supervisor calling this a clean stop and a supervisor restarting it immediately.
 */

import { unlinkSync } from "node:fs";
import process from "node:process";
import { removeRuntimeState } from "./daemon-state.js";
import { DEFAULT_DRAIN_TIMEOUT_MS } from "./runner.js";

/** The signals a foreground daemon must handle. `SIGINT` is the same event with a keyboard. */
export const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT"];

/** The exit code of a completed drain (ADR 0020 §Restart on crash). */
export const CLEAN_SHUTDOWN_EXIT_CODE = 0;

/** Anything with a `close()` that resolves — a bound listener, in practice. */
export type ClosableListener = {
  close(): Promise<void>;
};

/** What {@link installShutdownHandlers} needs. */
export type ShutdownOptions = {
  /** The state directory whose `runtime.json` is removed at step 6. */
  stateDir: string;
  /**
   * Steps 1–5: drain the runner within `timeoutMs`, then release ownership.
   *
   * This is `StartedDaemon.close`, passed as a function so the shutdown sequence can be tested
   * against a recorded call rather than against a whole daemon.
   */
  drain: (timeoutMs: number) => Promise<void>;
  /** The listeners to close once the drain is done — TCP now, TCP and IPC from P1-9. */
  listeners: readonly ClosableListener[];
  /** The IPC socket to unlink at step 6, when there is one. */
  socketPath?: string | null;
  /** Defaults to ADR 0024's 20 s. */
  drainTimeoutMs?: number;
  /** Where the shutdown narrative goes. Silent by default. */
  log?: (line: string) => void;
  /** How the process ends. `process.exit` in production, a recorder in a test. */
  exit: (code: number) => void;
  /** Defaults to {@link SHUTDOWN_SIGNALS}. */
  signals?: readonly NodeJS.Signals[];
};

/** The installed handlers, and a way to run or remove them without a signal. */
export type ShutdownHandle = {
  /** Run the sequence. Safe to call twice: the second call is a no-op, not a second drain. */
  shutdown(reason: string): Promise<void>;
  /** Remove the signal listeners. For tests, and for a caller that shuts down another way. */
  dispose(): void;
};

/** Delete the socket file, if this daemon made one. Absent is the desired state either way. */
function removeSocket(path: string | null | undefined): void {
  if (path === undefined || path === null || path === "") {
    return;
  }
  try {
    unlinkSync(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

/**
 * Register the signal handlers, and return the sequence they run.
 *
 * A second signal during the drain is **ignored rather than obeyed**: an impatient supervisor that
 * sends `SIGTERM` twice must not restart the sequence from the top, because step 3 is already
 * killing what step 2 was waiting for. The supervisor's own escalation to `SIGKILL` remains the
 * backstop, and the 25-second budget is what makes that escalation unnecessary.
 */
export function installShutdownHandlers(options: ShutdownOptions): ShutdownHandle {
  const log = options.log ?? ((): void => {});
  const signals = options.signals ?? SHUTDOWN_SIGNALS;
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  let started = false;

  const shutdown = async (reason: string): Promise<void> => {
    if (started) {
      log(`xplainer serve: ${reason} received while already shutting down; ignoring it.`);
      return;
    }
    started = true;
    log(
      `xplainer serve: ${reason}; draining for up to ${drainTimeoutMs / 1000} s, then stopping ` +
        "every worker process group.",
    );

    await options.drain(drainTimeoutMs);
    for (const listener of options.listeners) {
      await listener.close();
    }
    removeSocket(options.socketPath);
    removeRuntimeState(options.stateDir);
    log(`xplainer serve: stopped cleanly; exiting ${CLEAN_SHUTDOWN_EXIT_CODE}.`);
    options.exit(CLEAN_SHUTDOWN_EXIT_CODE);
  };

  const handlers = signals.map((signal): [NodeJS.Signals, () => void] => [
    signal,
    () => {
      void shutdown(signal);
    },
  ]);
  for (const [signal, handler] of handlers) {
    process.on(signal, handler);
  }

  return {
    shutdown,
    dispose(): void {
      for (const [signal, handler] of handlers) {
        process.off(signal, handler);
      }
    },
  };
}
