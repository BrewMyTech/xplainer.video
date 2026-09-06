/**
 * The readiness announcement, and the wait a parent does instead of sleeping.
 *
 * [ADR 0025](../../../../docs/adr/0025-daemon-updates-and-readiness.md) §Part three decides it:
 * "the daemon announces readiness exactly once — after ownership is acquired, reconciliation has
 * finished and both listeners are bound — and … every parent (installer, supervisor, desktop app)
 * waits for that announcement rather than sleeping." The mechanism is one line of JSON on stdout,
 * on every platform, needing nothing Node does not already have.
 *
 * **Who reads it.** A parent that spawned the daemon itself — `apps/desktop`, a `docs/daemon.md`
 * recipe, a test harness — reads it from the pipe, and that is the primary mechanism. A post-install
 * hook restarting a *supervised* daemon cannot, because a supervised daemon's stdout goes to the
 * supervisor's log sink and the hook is not its parent; that caller polls an authenticated
 * `GET /healthz` instead, which is why `contract_version` appears in both places from one constant.
 *
 * **Two consequences of that decision are rules, not details.** Stdout is part of the contract for
 * anything that spawns the daemon, so the line "must not move behind a `--quiet` flag or a
 * log-level filter" — and everything else `serve` says goes to **stderr**, so the one JSON line is
 * the whole of stdout.
 *
 * **The shape.** `{event, port, socket, contract_version, pid}`, one line, once.
 *
 * §Part three of the record *sketches* a different set of key names, and ADR 0025's
 * **§Note, 2026-09-07** is where this shape is decided, where that sketch and the sentence in
 * §Note, 2026-09-06 §(a) about it are corrected, and where each of the four differences is argued —
 * `event` rather than an `xplainer` key, `contract_version` rather than `contract`, no `version`,
 * and `pid`. Read it there rather than here: the record is what a future implementer opens, and
 * reasoning that lives only in a docblock is reasoning they never meet. This file is the shape's
 * only writer and only parser, and `ready.test.ts` is where the exact bytes are asserted.
 *
 * The one field whose *behaviour* is a fact about this module rather than about the record:
 * `socket` is nullable, because a server bound without one is a supported shape
 * (`services/media-service` binds no socket) and a parent that cannot use a path it has no
 * filesystem access to needs to tell that case from "an older daemon".
 */

import type { ChildProcess } from "node:child_process";

/** The `event` value that marks the one readiness line. */
export const READY_EVENT = "ready";

/** How long {@link waitForReadyLine} waits before giving up on a daemon that never announced. */
export const READY_TIMEOUT_MS = 30_000;

/** The line itself, before it is serialised. */
export type ReadyAnnouncement = {
  event: typeof READY_EVENT;
  /** The TCP port actually bound, resolved — so `--port 0` announces its real value. */
  port: number;
  /** The IPC socket path (a named pipe on Windows), or `null` for a TCP-only binding. */
  socket: string | null;
  /** `MCP_CONTRACT_VERSION`, so a parent gets the skew answer without a handshake. */
  contract_version: string;
  pid: number;
};

/** What {@link readyAnnouncement} is built from. */
export type ReadyFields = {
  port: number;
  socket?: string | null;
  contractVersion: string;
  pid: number;
};

/** Build the announcement, filling in the fields whose absence has a meaning. */
export function readyAnnouncement(fields: ReadyFields): ReadyAnnouncement {
  return {
    event: READY_EVENT,
    port: fields.port,
    socket: fields.socket ?? null,
    contract_version: fields.contractVersion,
    pid: fields.pid,
  };
}

/** The exact bytes written to stdout: one JSON object, one newline, nothing else. */
export function formatReadyLine(announcement: ReadyAnnouncement): string {
  return `${JSON.stringify(announcement)}\n`;
}

/** Read one line as an announcement, or `null` if it is not one. Never throws on rubbish. */
export function parseReadyLine(line: string): ReadyAnnouncement | null {
  const trimmed = line.trim();
  if (trimmed === "" || !trimmed.startsWith("{")) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const candidate = parsed as Partial<ReadyAnnouncement>;
  if (
    candidate.event !== READY_EVENT ||
    typeof candidate.port !== "number" ||
    typeof candidate.contract_version !== "string" ||
    typeof candidate.pid !== "number"
  ) {
    return null;
  }
  const socket = typeof candidate.socket === "string" ? candidate.socket : null;
  return {
    event: READY_EVENT,
    port: candidate.port,
    socket,
    contract_version: candidate.contract_version,
    pid: candidate.pid,
  };
}

/** The daemon bound nothing within the deadline. */
export class ReadyTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, output: string) {
    super(
      `xplainer: the daemon did not announce readiness within ${timeoutMs} ms. ` +
        `What it said instead: ${summarise(output)}`,
    );
    this.name = "ReadyTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** The daemon exited before announcing — the refusal paths, which all have exit codes. */
export class ExitedBeforeReadyError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(exitCode: number | null, signal: NodeJS.Signals | null, output: string) {
    super(
      "xplainer: the daemon exited before announcing readiness " +
        `(${exitCode === null ? `signal ${String(signal)}` : `exit code ${exitCode}`}). ` +
        `What it said: ${summarise(output)}`,
    );
    this.name = "ExitedBeforeReadyError";
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

/** The tail of whatever the child said, bounded, so an error message stays readable. */
function summarise(output: string): string {
  const trimmed = output.trim();
  if (trimmed === "") {
    return "nothing at all.";
  }
  return trimmed.length > 500 ? `…${trimmed.slice(-500)}` : trimmed;
}

/** What {@link waitForReadyLine} allows. */
export type WaitForReadyOptions = {
  /** How long to wait. Defaults to {@link READY_TIMEOUT_MS}. */
  timeoutMs?: number;
};

/**
 * Wait for the ready line on a spawned daemon's stdout.
 *
 * Both failure paths P1-14 names are here and are distinguishable, because they need different
 * remedies: {@link ExitedBeforeReadyError} carries the exit code — `10`, `11`, `12` and `0` all
 * mean something specific — while {@link ReadyTimeoutError} means a process that is still alive and
 * has not bound, which is the case a parent must **stop** before starting anything else, or two
 * daemons contend for exclusive ownership (ADR 0025 §The update sequence).
 *
 * The child is never killed here. Deciding that belongs to the caller, which is the only party that
 * knows whether the process is its own to stop.
 */
export function waitForReadyLine(
  child: ChildProcess,
  options: WaitForReadyOptions = {},
): Promise<ReadyAnnouncement> {
  const timeoutMs = options.timeoutMs ?? READY_TIMEOUT_MS;

  return new Promise<ReadyAnnouncement>((resolve, reject) => {
    let stdout = "";
    let seen = "";
    let settled = false;

    const finish = (act: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("exit", onExit);
      child.off("error", onError);
      act();
    };

    const onStdout = (chunk: Buffer | string): void => {
      stdout += String(chunk);
      seen += String(chunk);
      // Only whole lines are considered: a partial write must never be parsed as rubbish and
      // discarded, because the announcement is made exactly once and there is no second chance.
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        const announcement = parseReadyLine(line);
        if (announcement !== null) {
          finish(() => {
            resolve(announcement);
          });
          return;
        }
      }
    };

    const onStderr = (chunk: Buffer | string): void => {
      seen += String(chunk);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(() => {
        reject(new ExitedBeforeReadyError(code, signal, seen));
      });
    };

    const onError = (error: Error): void => {
      finish(() => {
        reject(error);
      });
    };

    const timer = setTimeout(() => {
      finish(() => {
        reject(new ReadyTimeoutError(timeoutMs, seen));
      });
    }, timeoutMs);

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}
