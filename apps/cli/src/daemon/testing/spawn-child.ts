/**
 * Spawning one of the child entries beside this file, and watching what it says.
 *
 * Three suites need the same four things — a real `node` running this package's *sources*, its
 * stdout and stderr accumulated as they arrive, a wait for a line, and a wait for the exit — and
 * they need them for the same reason: the properties under test are properties of a **process**.
 * A second `serve` that exits `10`, a `SIGKILL`ed daemon, a `SIGTERM` drain that has 25 seconds to
 * finish and a ready line a parent reads from a pipe cannot be observed from inside the Vitest
 * worker at all.
 *
 * The harness lives here rather than being copied into each suite so that the spawn is described
 * once: `node --import ./ts-source-hook.ts <entry>.ts`, which is what lets a child import
 * `./job-store.js` from a `.ts` file and needs no build (see `ts-source-hook.ts` for why a built
 * `dist/` is the wrong dependency for these tests).
 *
 * It deliberately does **not** keep a registry of what it spawned. Each suite owns its own cleanup
 * in `afterEach`, because a shared one would outlive a single file's tests and a stray daemon that
 * still holds a state directory is the one failure mode these tests must never introduce.
 *
 * {@link untilGone} is here for the same "described once" reason: four suites end in "and the pid
 * it left behind is gone", and a process that has been signalled dies on the kernel's schedule
 * rather than on the assertion's. {@link killAndWait} and {@link removeTree} are the other half of
 * that sentence — a suite's own `afterEach` waits for the children it started and only then removes
 * what they were writing into, because on Windows a dying process still holds its files.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isAlive } from "../worker-identity.js";

/**
 * The `--import` hook that lets a spawned `node` resolve this package's `.ts` sources, as a URL.
 *
 * **A file URL rather than a path, because `--import` takes a module specifier.** An absolute
 * Windows path is a specifier with the scheme `c:`, and Node refuses it:
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME: Only URLs with a scheme in: file, data, and node are supported`
 * — measured on `windows-latest` on 2026-09-08, where it took out every suite that spawns a child.
 * `new URL(…, import.meta.url).href` is already a `file:` URL on all three platforms, so this is
 * one form everywhere rather than a Windows branch. The entry beside it stays a path: that argument
 * is a script Node resolves, not a specifier it parses.
 */
export const TS_SOURCE_HOOK = new URL("./ts-source-hook.ts", import.meta.url).href;

/** `xplainer serve` through the real command tree. */
export const CHILD_SERVE = fileURLToPath(new URL("./child-serve.ts", import.meta.url));

/** The whole command tree, with argv passed through — `mcp`, `mcp --attach`, anything. */
export const CHILD_CLI = fileURLToPath(new URL("./child-cli.ts", import.meta.url));

/** A daemon whose `/healthz` says whatever `XPLAINER_TEST_HEALTHZ` says, over the real socket. */
export const CHILD_FAKE_DAEMON = fileURLToPath(new URL("./child-fake-daemon.ts", import.meta.url));

/** A daemon that enqueues a job and then kills itself. */
export const CHILD_DAEMON = fileURLToPath(new URL("./child-daemon.ts", import.meta.url));

/** `xplainer serve` with one long fake job already running when it announces readiness. */
export const CHILD_SERVE_JOB = fileURLToPath(new URL("./child-serve-job.ts", import.meta.url));

/**
 * Poll until `pid` is no longer alive, or until `timeoutMs` runs out.
 *
 * @returns `true` if it went away in time, `false` if it was still alive at the deadline — so an
 * assertion says which of the two happened rather than timing the whole test out.
 */
export async function untilGone(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return true;
    }
    await new Promise<void>((done) => {
      setTimeout(done, 20);
    });
  }
  return false;
}

/**
 * Signal a child and wait for it to have actually exited.
 *
 * **Killing is not reaping, and on Windows the difference has a cost.** `child.kill()` returns as
 * soon as the signal — a `TerminateProcess` there — has been asked for, and the process still holds
 * every handle it had until the kernel has finished with it. A cleanup that removes a directory in
 * that window gets `EPERM` on the files the dying process still has open, which is what
 * `windows-latest` reported for `lifecycle.test.ts`'s scratch directories on 2026-09-08.
 *
 * @returns `true` when the child is gone, `false` when the deadline passed first — so a caller can
 * clean up anyway rather than hanging on a process that will not die.
 */
export async function killAndWait(child: ChildProcess, timeoutMs = 10_000): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  const exited = new Promise<boolean>((resolve) => {
    child.once("exit", () => {
      resolve(true);
    });
  });
  child.kill("SIGKILL");
  const timeout = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
    timer.unref();
  });
  return Promise.race([exited, timeout]);
}

/**
 * One exit as a single comparable string: `signal SIGKILL`, `code 1`, `code 0`.
 *
 * A pair of `{ code, signal }` compared field by field makes a platform difference two assertions
 * that have to agree; one string makes it one, and the failure prints what this machine actually
 * reported rather than `expected null to be 'SIGKILL'`.
 */
export function describeExit(exit: { code: number | null; signal: NodeJS.Signals | null }): string {
  return exit.signal !== null ? `signal ${exit.signal}` : `code ${String(exit.code)}`;
}

/**
 * What an abrupt, unhandled kill looks like to whoever is watching, on this platform.
 *
 * POSIX delivers a signal and the waiter is told which. **Windows has no signals**: `uv_kill` turns
 * `SIGKILL` into `TerminateProcess(handle, 1)` — "killed processes normally return 1", libuv's own
 * comment — so a watcher is told a code and no signal. The one exception is a watcher that *asked*
 * for the kill through `child.kill()`: libuv records the signal on the process handle before it
 * terminates and reports it back, which `windows-latest` confirmed on 2026-09-08 (the assertion on
 * a parent-initiated kill passed there; the one on a child that killed itself did not).
 *
 * @param by who asked for it — `itself` for a process that called `process.kill(process.pid, …)`,
 * `the watcher` for one this process killed with `child.kill()`.
 */
export function abruptKill(by: "itself" | "the watcher"): string {
  if (process.platform !== "win32" || by === "the watcher") {
    return "signal SIGKILL";
  }
  return "code 1";
}

/**
 * Remove a scratch tree, retrying the way Windows needs.
 *
 * `rm(2)` on POSIX detaches a name from an inode a process may still hold open and returns; Windows
 * refuses the unlink while any handle is open, and reports `EPERM`. Node's own `maxRetries` covers
 * exactly that set of errors — `EBUSY`, `EMFILE`, `ENFILE`, `ENOTEMPTY`, `EPERM` — with a back-off
 * between attempts, so a directory whose last writer is on its way out is removed a moment later
 * rather than failing a suite in `afterEach`. {@link killAndWait} first is still the fix; this is
 * the second line, for the handles a child left behind in a grandchild.
 */
export function removeTree(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

/** A spawned child, and everything a test needs to observe it. */
export type SpawnedChild = {
  /** The process itself, for signalling it and for reading `exitCode`. */
  process: ChildProcess;
  /** Everything written to stdout so far. */
  stdout(): string;
  /** Everything written to stderr so far. */
  stderr(): string;
  /**
   * Resolve with the first line of either stream that contains `match`.
   *
   * Rejects if the child exits first, and says what it printed — a test that times out with no
   * output is a test that has to be re-run under a debugger to learn anything.
   */
  waitForLine(match: string, timeoutMs?: number): Promise<string>;
  /** Resolve when the child exits, with the code or the signal that ended it. */
  waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

/** Start `entry` under the source hook, with `env` added to this process's environment. */
export function spawnEntry(
  entry: string,
  args: readonly string[] = [],
  env: Record<string, string> = {},
): SpawnedChild {
  const child = spawn(process.execPath, ["--import", TS_SOURCE_HOOK, entry, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let out = "";
  let err = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    out += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    err += chunk;
  });

  return {
    process: child,
    stdout: () => out,
    stderr: () => err,
    async waitForLine(match: string, timeoutMs = 20_000): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const line = `${out}\n${err}`.split("\n").find((candidate) => candidate.includes(match));
        if (line !== undefined) {
          return line;
        }
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(
            `the child exited before printing "${match}"\nstdout:${out}\nstderr:${err}`,
          );
        }
        await new Promise<void>((done) => {
          setTimeout(done, 20);
        });
      }
      throw new Error(`timed out waiting for "${match}"\nstdout:${out}\nstderr:${err}`);
    },
    waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
      if (child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
      }
      return new Promise((resolve) => {
        child.once("exit", (code, signal) => {
          resolve({ code, signal });
        });
      });
    },
  };
}
