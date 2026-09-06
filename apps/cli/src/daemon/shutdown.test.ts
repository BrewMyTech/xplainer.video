/**
 * The six steps between a signal and exit `0`, in their order.
 *
 * The *signal* is proved where it can only be proved — against a real `serve` in
 * `commands/serve.test.ts`, which sends a real `SIGTERM` and watches a real process group die. What
 * is proved here is the part a signal cannot show you: that the steps happen in ADR 0024 §Drain on
 * planned restart's order, that a second signal during a drain is ignored rather than obeyed, and
 * that `runtime.json` and the socket are gone before the exit code is chosen. Registration is
 * asserted by counting `process`'s own listeners, which is the only honest way to say "this daemon
 * would answer a `SIGTERM`" without sending one to the test runner.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { writeRuntimeState } from "./daemon-state.js";
import { DEFAULT_DRAIN_TIMEOUT_MS } from "./runner.js";
import {
  CLEAN_SHUTDOWN_EXIT_CODE,
  installShutdownHandlers,
  SHUTDOWN_SIGNALS,
  type ShutdownHandle,
} from "./shutdown.js";
import { stateDirLayout } from "./state-dir.js";

const scratch: string[] = [];
const handles: ShutdownHandle[] = [];

function stateDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "xplainer-shutdown-"));
  scratch.push(dir);
  writeRuntimeState(dir, {
    pid: process.pid,
    run_id: "run-1",
    boot_id: null,
    port: 8787,
    addresses: ["http://127.0.0.1:8787"],
    socket: null,
    started_at: "2026-09-06T00:00:00.000Z",
  });
  return dir;
}

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.dispose();
  }
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Install the handlers over recorders, and keep the handle for teardown. */
function install(options: {
  stateDir: string;
  steps: string[];
  exits: number[];
  socketPath?: string | null;
  drainTimeoutMs?: number;
  drain?: (timeoutMs: number) => Promise<void>;
}): ShutdownHandle {
  const { steps, exits } = options;
  const handle = installShutdownHandlers({
    stateDir: options.stateDir,
    drain:
      options.drain ??
      (async (timeoutMs) => {
        steps.push(`drain(${timeoutMs})`);
      }),
    listeners: [
      {
        close: async () => {
          steps.push("close tcp");
        },
      },
      {
        close: async () => {
          steps.push("close ipc");
        },
      },
    ],
    ...(options.socketPath === undefined ? {} : { socketPath: options.socketPath }),
    ...(options.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: options.drainTimeoutMs }),
    log: (line) => {
      steps.push(`log: ${line}`);
    },
    exit: (code) => {
      exits.push(code);
    },
  });
  handles.push(handle);
  return handle;
}

describe("installShutdownHandlers", () => {
  it("drains, then closes every listener, then removes runtime.json, then exits 0", async () => {
    const stateDir = stateDirectory();
    const steps: string[] = [];
    const exits: number[] = [];
    const handle = install({ stateDir, steps, exits });

    await handle.shutdown("SIGTERM");

    expect(steps.filter((step) => !step.startsWith("log: "))).toEqual([
      `drain(${DEFAULT_DRAIN_TIMEOUT_MS})`,
      "close tcp",
      "close ipc",
    ]);
    expect(existsSync(stateDirLayout(stateDir).runtimeState)).toBe(false);
    expect(exits).toEqual([CLEAN_SHUTDOWN_EXIT_CODE]);
  });

  /** ADR 0024 step 2: twenty seconds, and twenty seconds plus teardown is P1-7's whole budget. */
  it("gives the drain ADR 0024's twenty seconds unless told otherwise", async () => {
    const steps: string[] = [];
    const handle = install({ stateDir: stateDirectory(), steps, exits: [], drainTimeoutMs: 500 });

    await handle.shutdown("SIGTERM");

    expect(steps).toContain("drain(500)");
    expect(DEFAULT_DRAIN_TIMEOUT_MS).toBe(20_000);
  });

  it("removes the socket it made, and does not mind one that is already gone", async () => {
    const stateDir = stateDirectory();
    const socketPath = join(stateDir, "xplainer.sock");
    writeFileSync(socketPath, "");

    await install({ stateDir, steps: [], exits: [], socketPath }).shutdown("SIGTERM");
    expect(existsSync(socketPath)).toBe(false);

    const second = stateDirectory();
    const exits: number[] = [];
    await install({
      stateDir: second,
      steps: [],
      exits,
      socketPath: join(second, "never-created.sock"),
    }).shutdown("SIGTERM");
    expect(exits).toEqual([CLEAN_SHUTDOWN_EXIT_CODE]);
  });

  /**
   * An impatient supervisor sends `SIGTERM` twice. Restarting the sequence from the top would mean
   * step 3 killing what step 2 is still waiting for, so the second one is a logged no-op.
   */
  it("ignores a second signal that arrives mid-drain", async () => {
    const stateDir = stateDirectory();
    const steps: string[] = [];
    const exits: number[] = [];
    let releaseDrain = (): void => {};
    const drainStarted = new Promise<void>((started) => {
      releaseDrain = started;
    });
    let finishDrain = (): void => {};
    const drainFinished = new Promise<void>((done) => {
      finishDrain = done;
    });

    const handle = install({
      stateDir,
      steps,
      exits,
      drain: async () => {
        steps.push("drain");
        releaseDrain();
        await drainFinished;
      },
    });

    const first = handle.shutdown("SIGTERM");
    await drainStarted;
    await handle.shutdown("SIGTERM");
    finishDrain();
    await first;

    expect(steps.filter((step) => step === "drain")).toHaveLength(1);
    expect(steps.join("\n")).toContain("already shutting down");
    expect(exits).toEqual([CLEAN_SHUTDOWN_EXIT_CODE]);
  });

  it("registers a handler for SIGTERM and SIGINT, and removes both on dispose", () => {
    const before = SHUTDOWN_SIGNALS.map((signal) => process.listenerCount(signal));

    const handle = install({ stateDir: stateDirectory(), steps: [], exits: [] });
    const during = SHUTDOWN_SIGNALS.map((signal) => process.listenerCount(signal));
    handle.dispose();
    const after = SHUTDOWN_SIGNALS.map((signal) => process.listenerCount(signal));

    expect(during).toEqual(before.map((count) => count + 1));
    expect(after).toEqual(before);
    expect([...SHUTDOWN_SIGNALS]).toEqual(["SIGTERM", "SIGINT"]);
  });
});
