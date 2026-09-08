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
import {
  groupOf,
  jobKeeperCommand,
  KILL_ON_JOB_CLOSE,
  signalGroup,
  terminateGroup,
  treeKillCommand,
} from "./process-group.js";
import { untilGone } from "./testing/spawn-child.js";
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

/**
 * Windows' answer to "these processes are one unit", asserted from a machine that cannot run it.
 *
 * The keeper is a `powershell.exe` holding a kill-on-close Job Object open for the life of one
 * worker, and on macOS and Linux nothing starts one — {@link groupOf} has a real process group to
 * use instead. What can be checked anywhere is the command: it is built here, it is base64 UTF-16LE
 * because a multi-line script with quotes in it must not go through command-line quoting, and
 * decoding it back is how this suite reads what the runner will execute.
 *
 * **The behaviour itself is `[runner]` evidence.** `daemon-windows.yml` runs this file on
 * `windows-latest`, where the two `terminateGroup` cases above become the assertion that a
 * grandchild dies with its leader. Until that workflow has reported, the Windows half is a design.
 */
describe("the Windows Job Object keeper", () => {
  function script(pid: number): string {
    const { argv } = jobKeeperCommand(pid);
    const encoded = argv[argv.indexOf("-EncodedCommand") + 1] ?? "";
    return Buffer.from(encoded, "base64").toString("utf16le");
  }

  it("asks for a job that kills everything in it when its last handle closes", () => {
    const text = script(4242);

    expect(text).toContain(`private const uint KillOnJobClose = ${KILL_ON_JOB_CLOSE};`);
    expect(text).toContain("CreateJobObjectW");
    expect(text).toContain("SetInformationJobObject");
    expect(text).toContain("AssignProcessToJobObject");
  });

  it("assigns the worker, sweeps up the descendants it already had, and then only waits", () => {
    const text = script(4242);

    expect(text).toContain("$target = 4242");
    expect(text).toContain("[XplainerJobObject]::Assign($target)");
    // The window `AssignProcessToJobObject` cannot close by itself: children that existed before
    // the keeper was ready are not reached by it, so they are assigned one by one.
    expect(text).toContain("Get-XplainerDescendants $target");
    expect(text).toContain("Get-CimInstance Win32_Process");
    expect(text).toContain("$process.WaitForExit()");
  });

  it("is a powershell command with no shell and no quoting to get wrong", () => {
    const command = jobKeeperCommand(4242);

    expect(command.program).toBe("powershell.exe");
    expect(command.argv.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(command.argv).toHaveLength(4);
    expect(command.argv[3]).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("refuses a pid that is not one, rather than interpolating it into a script", () => {
    expect(() => jobKeeperCommand(0)).toThrow(RangeError);
    expect(() => jobKeeperCommand(-1)).toThrow(RangeError);
    expect(() => jobKeeperCommand(1.5)).toThrow(RangeError);
  });

  it("keeps taskkill as the weaker fallback, spelled the way it will be run", () => {
    expect(treeKillCommand(4242)).toEqual({
      program: "taskkill",
      argv: ["/PID", "4242", "/T", "/F"],
    });
  });

  it("starts no keeper on a platform that has process groups", () => {
    const leader = spawn(process.execPath, ["-e", "setTimeout(function () {}, 200);"], {
      detached: true,
      stdio: "ignore",
    });
    const target = groupOf(leader);

    if (process.platform === "win32") {
      // The one line of this file that only means something on the runner: a keeper was started,
      // and its pid is what `terminateGroup` closes the job with.
      expect(typeof target?.jobKeeper).toBe("number");
    } else {
      expect(target?.jobKeeper).toBeUndefined();
    }
    expect(target?.pgid === null).toBe(process.platform === "win32");
    expect(signalGroup(target ?? { pid: 0, pgid: null }, "SIGKILL")).toBe(true);
  });
});
