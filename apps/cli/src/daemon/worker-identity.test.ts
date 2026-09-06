/**
 * The identity triple, and the four verdicts it produces.
 *
 * ADR 0024's note of 2026-09-06 §Process identity is explicit about which inputs may and may not
 * license a kill, and the pair that matters most is a **live pid whose token differs** against a
 * **live pid whose token matches** — the same number, opposite answers, which is the whole reason a
 * pid is not an identity. Both are asserted below against this process, whose token is real and
 * whose liveness is not in doubt.
 */

import { spawn } from "node:child_process";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { exitedPid } from "./testing/records.js";
import {
  classifyWorker,
  identify,
  isAlive,
  machineBootId,
  processStartToken,
  selfIdentity,
} from "./worker-identity.js";

describe("isAlive", () => {
  it("is true for this process and false for one that has exited", () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(exitedPid())).toBe(false);
  });
});

describe("processStartToken", () => {
  it("reads a token for a live process and none for a dead one", () => {
    expect(processStartToken(process.pid)).not.toBeNull();
    // ADR 0024's note: "an exited pid yields isAlive=false and token=null, so a null token is
    // indistinguishable from 'gone' and must never on its own license a kill".
    expect(processStartToken(exitedPid())).toBeNull();
  });
});

describe("selfIdentity", () => {
  it("is memoised, because reading the token is a process spawn", () => {
    expect(selfIdentity()).toBe(selfIdentity());
    expect(selfIdentity().pid).toBe(process.pid);
    expect(selfIdentity().boot_id).toBe(machineBootId());
  });
});

describe("classifyWorker", () => {
  it("says `ours` when the whole tuple matches", () => {
    expect(classifyWorker(identify(process.pid), machineBootId())).toBe("ours");
  });

  it("says `stranger` when the pid is alive but the start token differs — pid reuse", () => {
    const recorded = { ...identify(process.pid), start_time: "Thu Jan  1 00:00:00 1970" };

    expect(classifyWorker(recorded, machineBootId())).toBe("stranger");
  });

  it("says `gone` for a pid that is not alive", () => {
    expect(classifyWorker(identify(exitedPid()), machineBootId())).toBe("gone");
  });

  it("says `gone` when the record belongs to a different machine boot", () => {
    const recorded = { ...identify(process.pid), boot_id: "kern.boottime=1" };

    // Nothing recorded before a reboot can still be running, "and there is nothing to be uncertain
    // about" — ADR 0024's note, which is why this is `gone` rather than `uncertain`.
    expect(classifyWorker(recorded, "kern.boottime=2")).toBe("gone");
  });

  it("says `uncertain` when the pid is alive and the record carries no token", () => {
    const recorded = { pid: process.pid, start_time: null, boot_id: machineBootId() };

    expect(classifyWorker(recorded, machineBootId())).toBe("uncertain");
  });

  it("falls through to the tuple when only one side knows its boot id", () => {
    const recorded = { ...identify(process.pid), boot_id: null };

    expect(classifyWorker(recorded, machineBootId())).toBe("ours");
    expect(classifyWorker(identify(process.pid), null)).toBe("ours");
  });

  it("identifies a freshly spawned child and then stops identifying it once it is gone", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(function () {}, 50);"], {
      stdio: "ignore",
    });
    const pid = child.pid;
    expect(pid).toBeDefined();
    const recorded = identify(pid ?? 0);

    expect(classifyWorker(recorded, machineBootId())).toBe("ours");

    await new Promise<void>((done) => {
      child.once("exit", () => {
        done();
      });
    });

    expect(classifyWorker(recorded, machineBootId())).toBe("gone");
  });
});
