/**
 * The identity triple, and the four verdicts it produces.
 *
 * ADR 0024's note of 2026-09-06 §Process identity is explicit about which inputs may and may not
 * license a kill, and the pair that matters most is a **live pid whose token differs** against a
 * **live pid whose token matches** — the same number, opposite answers, which is the whole reason a
 * pid is not an identity. Both are asserted below against this process, whose token is real and
 * whose liveness is not in doubt.
 *
 * Every case here runs on all three platforms and every process in it is real; nothing is mocked
 * and nothing is skipped. Two of them are **platform-conditional in what they expect** rather than
 * in whether they run, and the reason is written where the branch is: the resolution of a start
 * token differs by platform, and macOS's is one second, which is the residual ADR 0024's note names
 * and declines to close.
 *
 * This file is the reason the Windows half of the tuple exists at all. Until 2026-09-09
 * `worker-identity.ts` read `ps` on every platform that is not Linux, so on Windows
 * `processStartToken` answered `null`, `machineBootId` answered `null`, and every case below that
 * needs a token would have failed — none of them was ever run there to find out. `daemon-windows.yml`
 * now runs this file on `windows-latest`, which is what makes the assertions here Windows evidence
 * rather than macOS evidence with a Windows-shaped comment.
 *
 * The Windows probe's two pure halves — the script it sends and the reader that takes the answer
 * apart — are asserted from **every** platform, for the reason `pipe-acl.test.ts` gives for its
 * own: the part that is easy to get wrong is the text, and the text can be read anywhere.
 */

import { spawn } from "node:child_process";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { foreignStartToken } from "./testing/platform.js";
import { exitedPid } from "./testing/records.js";
import {
  classifyWorker,
  identify,
  isAlive,
  machineBootId,
  processStartToken,
  readWindowsIdentity,
  selfIdentity,
  WINDOWS_IDENTITY_PREFIX,
  windowsIdentityScript,
} from "./worker-identity.js";

/**
 * How long a case that spawns several real identity probes is given.
 *
 * Vitest's default of 5 s is a macOS number: the probe there is a `ps` at about 4.5 ms, and a case
 * that takes six of them is over in a tenth of a second. On Windows the same probe is a
 * `powershell.exe` start, so a handful of them is seconds rather than milliseconds and the default
 * would fail these cases for the machine rather than for the code. Written per case, rather than
 * once for the file, so it is visible at every call that pays it.
 */
const PROBE_BUDGET_MS = 30_000;

/** A child that will outlive the case, and the pid it is running as. */
function sleeper(): { pid: number; ended: Promise<void> } {
  const child = spawn(process.execPath, ["-e", "setTimeout(function () {}, 30000);"], {
    stdio: "ignore",
  });
  const ended = new Promise<void>((done) => {
    child.once("exit", () => {
      done();
    });
  });
  if (child.pid === undefined) {
    throw new Error("node did not report a pid for a child it had just spawned");
  }
  return { pid: child.pid, ended };
}

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

  it(
    "answers the same token every time it is asked about the same live process",
    () => {
      // The whole mechanism rests on this: a token read at spawn time and a token read at
      // reconciliation are compared for equality, so a probe that is merely *correct* and not
      // *reproducible* would classify every worker a stranger and never kill one. It is asserted
      // because Windows reads a 100 ns file time out of CIM and could have rendered it through a
      // formatter, a locale or a time zone — none of which survives being read twice.
      const first = processStartToken(process.pid);
      const second = processStartToken(process.pid);

      expect(first).not.toBeNull();
      expect(second).toBe(first);
    },
    PROBE_BUDGET_MS,
  );

  it(
    "gives a freshly spawned child a token of its own wherever the clock is finer than a second",
    async () => {
      const child = sleeper();

      const mine = processStartToken(process.pid);
      const theirs = processStartToken(child.pid);

      expect(theirs).not.toBeNull();
      // macOS's `ps -o lstart=` has **one-second** resolution, and ADR 0024's note names that as
      // the residual it declines to close: a child started in the same wall-clock second as its
      // parent carries the same token there, and no assertion can make that false. Linux counts
      // clock ticks and Windows a 100 ns file time, so on those two a different process is
      // required to read differently — which on Windows is the difference between a tuple that can
      // decide and the `(pid, null, null)` this platform had until 2026-09-09.
      if (process.platform !== "darwin") {
        expect(theirs).not.toBe(mine);
      }

      process.kill(child.pid, "SIGKILL");
      await child.ended;
    },
    PROBE_BUDGET_MS,
  );
});

describe("machineBootId", () => {
  it(
    "reads this machine's boot exactly, on each of the three platforms that expose one",
    () => {
      // Linux has `/proc/sys/kernel/random/boot_id`, macOS `kern.boottime`, Windows
      // `Win32_OperatingSystem.LastBootUpTime`. Those are the three platforms this daemon supports,
      // so `null` here is not "a platform that cannot say" — it is the Windows defect of 2026-09-09,
      // where a boot id nobody could read made `classifyWorker`'s first and cheapest check dead code.
      expect(machineBootId()).not.toBeNull();
      expect(machineBootId()).toBe(machineBootId());
    },
    PROBE_BUDGET_MS,
  );
});

describe("selfIdentity", () => {
  it("is memoised, because reading the token is a process spawn", () => {
    expect(selfIdentity()).toBe(selfIdentity());
    expect(selfIdentity().pid).toBe(process.pid);
    expect(selfIdentity().boot_id).toBe(machineBootId());
  });

  it(
    "carries all three members, on every platform this daemon runs on",
    () => {
      // The tuple is the decision. A daemon whose own identity is `(pid, null, null)` records that
      // in `owner.lock` and in every job it writes, and every later reader of those records is then
      // `uncertain` about them for ever — which is what Windows did until 2026-09-09.
      expect(selfIdentity().start_time).not.toBeNull();
      expect(selfIdentity().boot_id).not.toBeNull();
    },
    PROBE_BUDGET_MS,
  );
});

describe("classifyWorker", () => {
  it(
    "says `ours` when the whole tuple matches",
    () => {
      expect(classifyWorker(identify(process.pid), machineBootId())).toBe("ours");
    },
    PROBE_BUDGET_MS,
  );

  it(
    "says `stranger` when the pid is alive but the start token differs — pid reuse",
    () => {
      const recorded = { ...identify(process.pid), start_time: foreignStartToken() };

      expect(classifyWorker(recorded, machineBootId())).toBe("stranger");
    },
    PROBE_BUDGET_MS,
  );

  it(
    "says `gone` for a pid that is not alive",
    () => {
      expect(classifyWorker(identify(exitedPid()), machineBootId())).toBe("gone");
    },
    PROBE_BUDGET_MS,
  );

  it(
    "says `gone` when the record belongs to a different machine boot",
    () => {
      const recorded = { ...identify(process.pid), boot_id: "kern.boottime=1" };

      // Nothing recorded before a reboot can still be running, "and there is nothing to be uncertain
      // about" — ADR 0024's note, which is why this is `gone` rather than `uncertain`.
      expect(classifyWorker(recorded, "kern.boottime=2")).toBe("gone");
    },
    PROBE_BUDGET_MS,
  );

  it(
    "says `uncertain` when the pid is alive and the record carries no token",
    () => {
      const recorded = { pid: process.pid, start_time: null, boot_id: machineBootId() };

      expect(classifyWorker(recorded, machineBootId())).toBe("uncertain");
    },
    PROBE_BUDGET_MS,
  );

  it(
    "falls through to the tuple when only one side knows its boot id",
    () => {
      const recorded = { ...identify(process.pid), boot_id: null };

      expect(classifyWorker(recorded, machineBootId())).toBe("ours");
      expect(classifyWorker(identify(process.pid), null)).toBe("ours");
    },
    PROBE_BUDGET_MS,
  );

  it(
    "identifies a freshly spawned child and then stops identifying it once it is gone",
    async () => {
      // The child waits to be killed rather than exiting on a timer of its own. It used to run
      // `setTimeout(…, 50)`, which is a race the probe has to win: on macOS `identify()` is a 4.5 ms
      // `ps` and always did, and on `windows-latest` it is a ~330 ms `powershell.exe` and never
      // does — the child is already gone when the first verdict is taken, so `ours` reads `gone`
      // and the case fails for the platform's probe cost rather than for the classifier. Measured
      // on run 34338721332, 2026-09-09. When the child dies is now this case's decision.
      const child = sleeper();
      const recorded = identify(child.pid);

      expect(classifyWorker(recorded, machineBootId())).toBe("ours");

      process.kill(child.pid, "SIGKILL");
      await child.ended;

      expect(classifyWorker(recorded, machineBootId())).toBe("gone");
    },
    PROBE_BUDGET_MS,
  );
});

describe("windowsIdentityScript", () => {
  it("asks for the process and the boot together, which is what makes selfIdentity one spawn", () => {
    const script = windowsIdentityScript(4321);

    expect(script).toContain("Get-CimInstance Win32_Process -Filter 'ProcessId=4321'");
    expect(script).toContain("Get-CimInstance Win32_OperatingSystem");
    // `wmic` is removed from current Windows images, so a probe built on it would answer `null` —
    // "uncertain" — on exactly the machines this is for.
    expect(script).not.toContain("wmic");
  });

  it("asks for the boot alone when there is no process to ask about", () => {
    const script = windowsIdentityScript(null);

    expect(script).toContain("Get-CimInstance Win32_OperatingSystem");
    expect(script).not.toContain("Win32_Process");
  });

  it("leaves out the process clause for anything that is not a pid", () => {
    // This string is pasted into a script. A value that reaches a WQL filter without being one of
    // the things a pid can be is not a value to paste, and the probe answering `null` for it is
    // `uncertain`, which is the safe verdict rather than a guess.
    for (const notAPid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(windowsIdentityScript(notAPid)).not.toContain("Win32_Process");
    }
  });

  it("writes with [Console]::Out.WriteLine, because the output formatter wraps at 80 columns", () => {
    const script = windowsIdentityScript(4321);

    // A file time is 18 digits and the prefix is 17 characters, so a wrapped line would still look
    // like a number and would be read as a token this machine can never produce again.
    expect(script).toContain("[Console]::Out.WriteLine");
    expect(script).not.toContain("Write-Output");
    expect(script).not.toContain("Format-List");
  });

  it("renders both times as an exact file time rather than a formatted date", () => {
    const script = windowsIdentityScript(4321);

    expect(script).toContain("$p.CreationDate.ToFileTimeUtc()");
    expect(script).toContain("$os.LastBootUpTime.ToFileTimeUtc()");
  });
});

describe("readWindowsIdentity", () => {
  it("takes both halves out of the probe's own output", () => {
    const answer = readWindowsIdentity(
      `${WINDOWS_IDENTITY_PREFIX} CreationDate=133711223344556677\r\n` +
        `${WINDOWS_IDENTITY_PREFIX} LastBootUpTime=133711000000000000\r\n`,
    );

    expect(answer).toEqual({
      start_time: "CreationDate=133711223344556677",
      boot_id: "LastBootUpTime=133711000000000000",
    });
  });

  it("answers null for the half the probe did not say", () => {
    const answer = readWindowsIdentity(`${WINDOWS_IDENTITY_PREFIX} LastBootUpTime=133711000000000`);

    expect(answer.start_time).toBeNull();
    expect(answer.boot_id).toBe("LastBootUpTime=133711000000000");
  });

  it("discards a value that is not a file time rather than recording one that is not", () => {
    // A token that cannot be produced again is worse than none: it would make every later reading
    // of the same process a `stranger`, which is the verdict certain enough to leave a live worker
    // alone *without* setting `workers_uncertain`. So an empty value, an error message PowerShell
    // wrote where a number was expected, and a key this reader does not know are all dropped.
    const answer = readWindowsIdentity(
      `${WINDOWS_IDENTITY_PREFIX} CreationDate=Get-CimInstance : Access is denied.\n` +
        `${WINDOWS_IDENTITY_PREFIX} LastBootUpTime=\n` +
        `${WINDOWS_IDENTITY_PREFIX} StartTime=133711223344556677\n` +
        `${WINDOWS_IDENTITY_PREFIX} 133711223344556677\n`,
    );

    expect(answer).toEqual({ start_time: null, boot_id: null });
  });

  it("ignores every line that is not the probe's own", () => {
    // The digits test cannot catch a *wrapped* number, because half of one is still a number.
    // Nothing detects that here and nothing tries to: it is prevented at the source, by writing
    // through `[Console]::Out.WriteLine` instead of PowerShell's 80-column output formatter. What
    // this reader does is refuse everything the probe did not deliberately label.
    const answer = readWindowsIdentity(
      `CreationDate=133711223344556677\n${WINDOWS_IDENTITY_PREFIX}-other CreationDate=1\n\n`,
    );

    expect(answer).toEqual({ start_time: null, boot_id: null });
  });
});
