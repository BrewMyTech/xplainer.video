/**
 * Killing the group, not the pid.
 *
 * ADR 0024 §Scope: every asynchronous job type, and its children is about a real failure: a render
 * is a Remotion process that starts a browser that starts renderers, so signalling only the process
 * the daemon holds leaves the expensive half alive to "race a retry over the same output
 * directory". The worker here stands in for that shape — a leader that spawns an unref'd
 * grandchild — and the assertion is that the grandchild is gone too.
 */

import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { groupOf, signalGroup, terminateGroup } from "./process-group.js";
import { isAlive } from "./worker-identity.js";

/**
 * A leader that ignores `SIGTERM` for ever and then prints its grandchild's pid.
 *
 * **The handler is installed before the line is printed, and that order is the test.** libuv writes
 * to a pipe synchronously when it can, so the parent can be scheduled on another core and read the
 * announcement while this process is still between two statements — and a leader signalled in that
 * window dies of `SIGTERM`'s default action, leaving nothing for `SIGKILL` to reach and turning
 * "escalated to SIGKILL" into "SIGTERM was enough". Announcing last closes the window.
 */
const STUBBORN_LEADER = `
const { spawn } = require("node:child_process");
process.on("SIGTERM", function () {});
const kid = spawn(process.execPath, ["-e", "process.on('SIGTERM', function () {}); setInterval(function () {}, 1000);"], {
  stdio: "ignore",
});
kid.unref();
process.stdout.write("grandchild " + kid.pid + "\\n");
setInterval(function () {}, 1000);
`;

function firstLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline >= 0) {
        resolve(buffered.slice(0, newline));
      }
    });
    child.once("error", reject);
    child.once("exit", () => {
      reject(new Error("the worker exited before it said anything"));
    });
  });
}

async function untilGone(pid: number, timeoutMs = 5_000): Promise<boolean> {
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

describe("terminateGroup", () => {
  it("kills a leader that ignores SIGTERM, and the grandchild it left behind", async () => {
    const leader = spawn(process.execPath, ["-e", STUBBORN_LEADER], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const announced = await firstLine(leader);
    const grandchild = Number(announced.replace("grandchild ", ""));
    const target = groupOf(leader);

    expect(target).not.toBeNull();
    expect(isAlive(grandchild)).toBe(true);

    const teardown = await terminateGroup(target ?? { pid: 0, pgid: null }, 200);

    expect(teardown.signal).toBe("SIGKILL");
    expect(await untilGone(leader.pid ?? 0)).toBe(true);
    expect(await untilGone(grandchild)).toBe(true);
  });

  it("reports that there was nothing to signal when the group is already gone", async () => {
    const leader = spawn(process.execPath, ["-e", "process.exitCode = 0;"], { detached: true });
    const target = groupOf(leader);
    await new Promise<void>((done) => {
      leader.once("exit", () => {
        done();
      });
    });

    const teardown = await terminateGroup(target ?? { pid: 0, pgid: null }, 50);

    expect(teardown).toEqual({ signalled: false, signal: null });
  });
});

describe("groupOf and signalGroup", () => {
  it("addresses the group on a platform that has them, and the pid where it does not", () => {
    const leader = spawn(process.execPath, ["-e", "setTimeout(function () {}, 300);"], {
      detached: true,
      stdio: "ignore",
    });
    const target = groupOf(leader);

    expect(target?.pid).toBe(leader.pid);
    expect(target?.pgid).toBe(process.platform === "win32" ? null : leader.pid);
    expect(signalGroup(target ?? { pid: 0, pgid: null }, "SIGKILL")).toBe(true);
  });
});
