/**
 * A Chrome DevTools Protocol client over `--remote-debugging-pipe`, with no dependency.
 *
 * Chrome reads commands from fd 3 and writes replies and events to fd 4, each message one JSON
 * document followed by a NUL byte. That is the whole transport: no port, no WebSocket, nothing
 * another process on the machine can connect to, and nothing to install. Sessions are **flat** —
 * a page's commands carry its `sessionId` on the same pipe, and its events come back tagged with
 * it — so one connection drives the browser and every page it opens.
 *
 * **Everything pending fails when Chrome exits, with the tail of what Chrome printed.** A browser
 * that dies mid-render otherwise leaves a call waiting for its 60-second timeout and then reports
 * "timed out", which says nothing; the stderr tail usually says exactly why it died. The failure is
 * `PAGE_ERROR`, and it waits for the output to finish arriving — `close`, not `exit`, bounded —
 * because the line that says why is the last one Chrome writes.
 *
 * **From spawn to profile removal, a worker that exits takes the browser and its profile with it.**
 * The `exit` hook is registered before the handshake, not after it: a `SIGTERM` that lands while
 * Chrome is still starting ends the worker through `process.exit()` before `launchChrome` has
 * returned anything the worker could clean up.
 *
 * **Chrome is a plain child of the worker, in the worker's process group.** The runner starts each
 * worker `detached`, which makes it a group leader, and signals the whole group on a cancel or a
 * drain (`daemon/process-group.ts`). Spawning Chrome detached here would take it out of that group
 * and out of the daemon's reach, so it is deliberately not.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Readable, Writable } from "node:stream";
import { RenderError } from "./render-error.js";

/**
 * The launch flags, in order. `--user-data-dir` is appended per launch and removed on close.
 *
 * Each is there for a reason a render can see: no GPU and no partial raster so every frame is
 * rasterised the same way, a fixed device scale and window so the pixels are the pixels asked
 * for, sRGB and unhinted fonts so colour and glyph positions do not depend on the host's display
 * settings, and the throttling switches off so a page nobody is looking at still runs its timers.
 */
export const CHROME_FLAGS: readonly string[] = [
  "--headless",
  "--remote-debugging-pipe",
  "--disable-gpu",
  "--disable-partial-raster",
  "--hide-scrollbars",
  "--force-device-scale-factor=1",
  "--font-render-hinting=none",
  "--force-color-profile=srgb",
  "--window-size=1920,1080",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-breakpad",
  "--disable-extensions",
  "--disable-hang-monitor",
  "--disable-component-update",
  "--no-pings",
];

/** Chrome's own switch for running without its sandbox. */
export const NO_SANDBOX_FLAG = "--no-sandbox";

/** What one CDP call may take, unless the caller says otherwise. */
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;

/** How long Chrome has to answer its first call before the launch counts as failed. */
export const LAUNCH_TIMEOUT_MS = 30_000;

/** How long `close()` waits for `Browser.close` before it kills the process. */
export const CLOSE_GRACE_MS = 5_000;

/**
 * How long, after Chrome exits, its output may take to finish arriving. `close` normally comes
 * within milliseconds; a helper that inherited the pipes and outlives the browser would hold it
 * open indefinitely, so the wait is bounded.
 */
export const OUTPUT_SETTLE_MS = 2_000;

/** How much of Chrome's output is kept for a failure message. */
const OUTPUT_TAIL_CHARS = 8_000;

/** How much of that tail a failure message quotes. */
const QUOTED_TAIL_CHARS = 2_000;

/**
 * The line Chrome prints when it cannot set up its sandbox. Ubuntu 24.04 restricts unprivileged
 * user namespaces through AppArmor, which is exactly what a GitHub runner is.
 */
const SANDBOX_FAILURE = /No usable sandbox/;

/** A listener for one CDP event's `params`. */
export type CdpListener = (params: unknown) => void;

/** Per-call options. */
export type CallOptions = {
  /** How long the call may take before it is rejected. Defaults to {@link DEFAULT_CALL_TIMEOUT_MS}. */
  timeoutMs?: number;
};

type PendingCall = {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/** Listeners keyed by event name, with an unsubscribe handle per subscription. */
class Listeners {
  readonly #byMethod = new Map<string, Set<CdpListener>>();

  on(method: string, listener: CdpListener): () => void {
    const set = this.#byMethod.get(method) ?? new Set<CdpListener>();
    set.add(listener);
    this.#byMethod.set(method, set);
    return () => {
      set.delete(listener);
    };
  }

  emit(method: string, params: unknown): void {
    for (const listener of this.#byMethod.get(method) ?? []) {
      listener(params);
    }
  }
}

/** One attached target — a page — on a {@link CdpConnection}. */
export class CdpSession {
  /** The flat-mode session id every command for this target carries. */
  readonly sessionId: string;
  readonly #connection: CdpConnection;
  readonly #listeners: Listeners = new Listeners();

  constructor(connection: CdpConnection, sessionId: string) {
    this.#connection = connection;
    this.sessionId = sessionId;
  }

  /** Subscribe to one of this target's events. Returns the unsubscribe function. */
  on(method: string, listener: CdpListener): () => void {
    return this.#listeners.on(method, listener);
  }

  /** Send a command to this target. */
  send(method: string, params: object = {}, options: CallOptions = {}): Promise<unknown> {
    return this.#connection.send(method, params, this.sessionId, options);
  }

  /** Deliver an event the connection routed here. */
  dispatch(method: string, params: unknown): void {
    this.#listeners.emit(method, params);
  }
}

/** A CDP connection over a pair of streams: commands out on one, NUL-framed replies in on the other. */
export class CdpConnection {
  readonly #write: Writable;
  #nextId = 1;
  readonly #pending: Map<number, PendingCall> = new Map();
  readonly #sessions: Map<string, CdpSession> = new Map();
  readonly #listeners: Listeners = new Listeners();
  /** Bytes of a message whose terminating NUL has not arrived yet. */
  #partial: Buffer[] = [];
  #closed: Error | null = null;

  constructor(write: Writable, read: Readable) {
    this.#write = write;
    read.on("data", (chunk: Buffer | string) => {
      this.#receive(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    });
    read.on("error", (error: Error) => {
      this.fail(error);
    });
    write.on("error", (error: Error) => {
      this.fail(error);
    });
  }

  /** Split a chunk on NUL, carrying a trailing partial message over to the next chunk. */
  #receive(chunk: Buffer): void {
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(0, start);
      if (end === -1) {
        break;
      }
      this.#partial.push(chunk.subarray(start, end));
      const text = Buffer.concat(this.#partial).toString("utf8");
      this.#partial = [];
      start = end + 1;
      let message: unknown;
      try {
        message = JSON.parse(text);
      } catch (error) {
        this.fail(new Error(`the browser sent a message that is not JSON (${String(error)})`));
        return;
      }
      this.#deliver(message);
    }
    if (start < chunk.length) {
      this.#partial.push(chunk.subarray(start));
    }
  }

  #deliver(message: unknown): void {
    if (typeof message !== "object" || message === null) {
      return;
    }
    const { id, method, params, sessionId, result, error } = message as {
      id?: unknown;
      method?: unknown;
      params?: unknown;
      sessionId?: unknown;
      result?: unknown;
      error?: { code?: unknown; message?: unknown };
    };
    if (typeof id === "number") {
      const call = this.#pending.get(id);
      if (call === undefined) {
        return;
      }
      this.#pending.delete(id);
      clearTimeout(call.timer);
      if (error !== undefined) {
        call.reject(
          new Error(`CDP ${call.method} failed: ${String(error.code)} ${String(error.message)}`),
        );
      } else {
        call.resolve(result);
      }
      return;
    }
    if (typeof method !== "string") {
      return;
    }
    if (typeof sessionId === "string") {
      this.#sessions.get(sessionId)?.dispatch(method, params);
    } else {
      this.#listeners.emit(method, params);
    }
  }

  /** Subscribe to a browser-level event. Returns the unsubscribe function. */
  on(method: string, listener: CdpListener): () => void {
    return this.#listeners.on(method, listener);
  }

  /**
   * Send one command and wait for its reply.
   *
   * @param sessionId the target the command is for, or `undefined` for the browser itself
   */
  send(
    method: string,
    params: object = {},
    sessionId: string | undefined = undefined,
    options: CallOptions = {},
  ): Promise<unknown> {
    if (this.#closed !== null) {
      return Promise.reject(this.#closed);
    }
    const id = this.#nextId;
    this.#nextId += 1;
    const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const message =
      sessionId === undefined ? { id, method, params } : { id, method, params, sessionId };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP ${method} had no answer after ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      this.#write.write(`${JSON.stringify(message)}\0`);
    });
  }

  /** Reject every pending call and every later one with `error`. The first failure wins. */
  fail(error: Error): void {
    this.#closed ??= error;
    for (const call of this.#pending.values()) {
      clearTimeout(call.timer);
      call.reject(this.#closed);
    }
    this.#pending.clear();
  }

  /** Open a blank page and attach to it in flat mode. */
  async newPage(): Promise<CdpSession> {
    const created = await this.send("Target.createTarget", { url: "about:blank" });
    const targetId = stringField(created, "targetId");
    const attached = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = stringField(attached, "sessionId");
    const session = new CdpSession(this, sessionId);
    this.#sessions.set(sessionId, session);
    return session;
  }
}

/** One string field of a CDP result, or a failure saying which one was missing. */
export function stringField(result: unknown, field: string): string {
  const value =
    typeof result === "object" && result !== null
      ? (result as Record<string, unknown>)[field]
      : undefined;
  if (typeof value !== "string") {
    throw new Error(`the browser's answer has no ${field}: ${JSON.stringify(result)}`);
  }
  return value;
}

/** Send `signal` to `pid`; whether it was delivered. `0` asks only whether the process exists. */
function signal(pid: number, which: NodeJS.Signals | 0): boolean {
  try {
    process.kill(pid, which);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every process descended from `pid`, from one `ps` listing — Chrome's GPU, network and renderer
 * helpers, and on Linux the zygote between the browser and its renderers. Empty on Windows, where
 * the worker's Job Object is what takes the tree down, and on any failure to list.
 */
function descendantsOf(pid: number | undefined): number[] {
  if (pid === undefined || process.platform === "win32") {
    return [];
  }
  let listing: string;
  try {
    listing = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of listing.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (
      child !== undefined &&
      parent !== undefined &&
      Number.isInteger(child) &&
      Number.isInteger(parent)
    ) {
      children.set(parent, [...(children.get(parent) ?? []), child]);
    }
  }
  const found: number[] = [];
  const queue = [pid];
  for (let index = 0; index < queue.length; index += 1) {
    for (const descendant of children.get(queue[index] ?? -1) ?? []) {
      found.push(descendant);
      queue.push(descendant);
    }
  }
  return found;
}

/** How a Chrome process ended. */
export type ChromeExit = { code: number | null; signal: NodeJS.Signals | null };

/** A running headless Chrome and the connection that drives it. */
export type Chrome = {
  connection: CdpConnection;
  /** The browser process, for a test that needs to see it gone. */
  pid: number;
  /** The throwaway profile, unique to this launch and removed by `close()`/`kill()`. */
  userDataDir: string;
  /** Every argument Chrome was started with. */
  args: readonly string[];
  /** Settles when the browser process has exited. */
  exited: Promise<ChromeExit>;
  /** What Chrome has printed most recently, for a failure message. */
  outputTail: () => string;
  /** `Browser.close`, then `SIGKILL` after {@link CLOSE_GRACE_MS}; then the profile is removed. */
  close: () => Promise<void>;
  /**
   * `SIGKILL` now, wait for the exit, remove the profile. For a signal, not for a normal end — and
   * it cuts short a `close()` already waiting on `Browser.close`.
   */
  kill: () => Promise<void>;
};

/** What {@link launchChrome} needs. */
export type LaunchChromeOptions = {
  /** The headless shell `toolchain.json` records. */
  executable: string;
  /** Where a line about the launch goes — the job log, in the worker. */
  log: (line: string) => void;
  /** Where the throwaway profile is made. Defaults to the system temporary directory. */
  tmpRoot?: string;
  /** Flags after {@link CHROME_FLAGS}, for a measurement that needs one more. */
  extraFlags?: readonly string[];
};

type Attempt = { ok: true; chrome: Chrome } | { ok: false; reason: string; tail: string };

/**
 * Start Chrome and wait until it answers, or fail with `CHROME_LAUNCH_FAILED`.
 *
 * On Linux, `--no-sandbox` is added up front when running as root (Chrome refuses to sandbox uid 0
 * at all), and otherwise only after Chrome itself has said it has no usable sandbox — once, and
 * logged, so a render that ran unsandboxed says so in its own job log. That is decided on the
 * output read up to `close`, not `exit`: the sandbox line is Chrome's last, and `exit` can arrive
 * before it has been read.
 */
export async function launchChrome(options: LaunchChromeOptions): Promise<Chrome> {
  const linux = process.platform === "linux";
  const asRoot = linux && process.getuid?.() === 0;
  const first = await attempt(options, asRoot ? [NO_SANDBOX_FLAG] : []);
  if (first.ok) {
    return first.chrome;
  }
  const sandboxLine = first.tail.split("\n").find((line) => SANDBOX_FAILURE.test(line));
  if (linux && !asRoot && sandboxLine !== undefined) {
    options.log(`[xplainer] chrome: ${sandboxLine.trim()}`);
    options.log(`[xplainer] chrome: relaunching once with ${NO_SANDBOX_FLAG}`);
    const second = await attempt(options, [NO_SANDBOX_FLAG]);
    if (second.ok) {
      return second.chrome;
    }
    throw launchFailure(options.executable, second);
  }
  throw launchFailure(options.executable, first);
}

/** How a browser process ended, as the sentence a failure starts with. */
function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return `the browser exited (code ${String(code)}, signal ${String(signal)})`;
}

function launchFailure(executable: string, failed: { reason: string; tail: string }): RenderError {
  const tail = failed.tail.trim().slice(-QUOTED_TAIL_CHARS);
  return new RenderError(
    "CHROME_LAUNCH_FAILED",
    `${executable}: ${failed.reason}${tail === "" ? "" : `\n${tail}`}`,
  );
}

async function attempt(
  options: LaunchChromeOptions,
  sandboxFlags: readonly string[],
): Promise<Attempt> {
  const userDataDir = mkdtempSync(join(options.tmpRoot ?? tmpdir(), "xplainer-chrome-"));
  const removeProfile = (): void => {
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  const args = [
    ...CHROME_FLAGS,
    ...sandboxFlags,
    ...(options.extraFlags ?? []),
    `--user-data-dir=${userDataDir}`,
  ];

  let child: ChildProcess;
  try {
    child = spawn(options.executable, args, { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
  } catch (error) {
    removeProfile();
    return { ok: false, reason: String(error), tail: "" };
  }

  // A worker that exits without closing — `process.exit()` from a signal handler, during the
  // handshake below or mid-render, or an uncaught throw — must not leave the browser running or its
  // profile behind. Synchronous, because `exit` listeners are; removed once the profile is gone.
  const onWorkerExit = (): void => {
    child.kill("SIGKILL");
    try {
      removeProfile();
    } catch {
      // The process is ending and there is nowhere left to report it.
    }
  };
  process.once("exit", onWorkerExit);
  const discardProfile = (): void => {
    removeProfile();
    process.removeListener("exit", onWorkerExit);
  };

  let tail = "";
  const keep = (data: Buffer): void => {
    tail = (tail + data.toString("utf8")).slice(-OUTPUT_TAIL_CHARS);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);

  const exited = new Promise<ChromeExit>((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
    child.once("error", () => {
      resolve({ code: null, signal: null });
    });
  });
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => {
      resolve();
    });
    child.once("error", () => {
      resolve();
    });
  });
  /** The exit, once everything Chrome printed before it has been read — or {@link OUTPUT_SETTLE_MS} on. */
  const settled = exited.then(async (exit) => {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, OUTPUT_SETTLE_MS);
      }),
    ]);
    clearTimeout(timer);
    return exit;
  });

  const toBrowser = child.stdio[3];
  const fromBrowser = child.stdio[4];
  if (!(toBrowser instanceof Writable) || !(fromBrowser instanceof Readable)) {
    child.kill("SIGKILL");
    await settled;
    discardProfile();
    return { ok: false, reason: "the browser's debugging pipe was not opened", tail };
  }
  const connection = new CdpConnection(toBrowser, fromBrowser);
  child.once("error", (error) => {
    connection.fail(error);
  });
  void settled.then(({ code, signal }) => {
    connection.fail(
      new RenderError(
        "PAGE_ERROR",
        describeExit(code, signal) +
          (tail.trim() === "" ? "" : `:\n${tail.trim().slice(-QUOTED_TAIL_CHARS)}`),
      ),
    );
  });

  try {
    await connection.send("Browser.getVersion", {}, undefined, { timeoutMs: LAUNCH_TIMEOUT_MS });
  } catch (error) {
    child.kill("SIGKILL");
    const { code, signal } = await settled;
    discardProfile();
    // The browser's own exit is described without its output, which the failure quotes once.
    const reason =
      error instanceof RenderError
        ? describeExit(code, signal)
        : error instanceof Error
          ? error.message
          : String(error);
    return { ok: false, reason, tail };
  }

  let ending: Promise<void> | null = null;
  const end = (graceMs: number): Promise<void> => {
    ending ??= (async () => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, graceMs);
      // Killed rather than closed, the browser cannot shut its helpers down — and a GPU or network
      // process that outlives it can still write into the profile after it has been removed. So
      // they are found while the browser is still their parent, and killed with it.
      const running = child.exitCode === null && child.signalCode === null;
      const helpers = graceMs > 0 || !running ? [] : descendantsOf(child.pid);
      if (graceMs > 0) {
        connection
          .send("Browser.close", {}, undefined, { timeoutMs: graceMs })
          .catch(() => undefined);
      } else {
        child.kill("SIGKILL");
        for (const pid of helpers) {
          signal(pid, "SIGKILL");
        }
      }
      await exited;
      clearTimeout(timer);
      const deadline = Date.now() + CLOSE_GRACE_MS;
      while (helpers.some((pid) => signal(pid, 0)) && Date.now() < deadline) {
        await new Promise((resolve) => {
          setTimeout(resolve, 25);
        });
      }
      discardProfile();
    })();
    return ending;
  };

  return {
    ok: true,
    chrome: {
      connection,
      pid: child.pid ?? -1,
      userDataDir,
      args,
      exited,
      outputTail: () => tail,
      close: () => end(CLOSE_GRACE_MS),
      kill: () => {
        // A close already under way would wait out its grace for `Browser.close`; a signal cannot.
        if (ending !== null) {
          child.kill("SIGKILL");
        }
        return end(0);
      },
    },
  };
}
