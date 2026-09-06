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
 * rather than on the assertion's.
 */

import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isAlive } from "../worker-identity.js";

/** The `--import` hook that lets a spawned `node` resolve this package's `.ts` sources. */
export const TS_SOURCE_HOOK = fileURLToPath(new URL("./ts-source-hook.ts", import.meta.url));

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
