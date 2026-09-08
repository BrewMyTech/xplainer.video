/**
 * The two one-click controls, asserted by the program each one actually executed.
 *
 * Decision D10 is a claim about a *spawn*, so every case here runs a real one: a real payload laid
 * out the way the packaged application's is, a real launcher at the path `daemon install` writes,
 * and a recording program at the end of both — the pattern `apps/cli/src/commands/connect.test.ts`
 * uses for a vendor CLI. Two cases per control, which are the two situations the controls exist to
 * span:
 *
 *   * **No launcher on disk.** Nothing is installed, so the packaged payload's own interpreter and
 *     its own entry are what run. This is the case that was broken in three rounds of the plan and
 *     is the reason D10 exists.
 *   * **A launcher on disk.** An install has happened, so `<state>/bin/xplainer` runs and no entry
 *     is prepended, because the launcher carries the interpreter and the entry inside itself.
 *
 * The last case is the one that would catch a regression to any earlier round: whatever else
 * changes, no argv here may be a bare `xplainer` on `PATH`.
 */

import { existsSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import process from "node:process";
import { afterAll, describe, expect, it } from "vitest";
import { CONNECT_VENDORS } from "../shared/ipc";
import { connectAgent, connectArgv, installArgv, startAtLogin } from "./controls";
import { launcherPath, resolveCliProgram } from "./discovery";
import { packagedCliEntry, packagedInterpreter, packagedPayloadRoot } from "./paths";
import { cleanUpFixtures, temporaryDirectory } from "./testing/live-daemon";
import { onlyRun, recordFile, recordingLauncher, recordingPayload } from "./testing/recording-cli";

/** A spawn, a recorded line and a process exit all fit inside this. */
const CASE_TIMEOUT_MS = 30_000;

afterAll(async () => {
  await cleanUpFixtures();
}, CASE_TIMEOUT_MS);

/**
 * The program the recorder says ran, against the one this app resolved — as **files**.
 *
 * A launcher on Windows is a `.cmd`, and the only way a batch file can name itself is `%~f0`, whose
 * fully-qualified answer need not be the same *spelling* the parent used: a temporary directory
 * under `C:\\Users\\RUNNER~1\\…` is the same file as one under `C:\\Users\\runneradmin\\…`.
 * Comparing the two through `realpathSync` keeps the claim — this exact file is what ran — without
 * asserting a spelling neither side promises.
 */
function expectRan(recorded: string, expected: string): void {
  expect(realpathSync(recorded)).toBe(realpathSync(expected));
}

/** A packaged application with nothing installed: a payload, and a state directory with no `bin/`. */
function cleanMachine(): { resources: string; stateDir: string; record: string } {
  const record = recordFile();
  return { resources: recordingPayload(record), stateDir: temporaryDirectory(), record };
}

describe("the one-click Add to Claude Code / Codex control", () => {
  for (const vendor of CONNECT_VENDORS) {
    it(
      `runs the packaged payload's own interpreter and entry for ${vendor} when no launcher exists`,
      async () => {
        const { resources, stateDir, record } = cleanMachine();
        expect(existsSync(launcherPath(stateDir))).toBe(false);

        const outcome = await connectAgent(vendor, { resourcesPath: resources, stateDir });

        expect(outcome.event).toBe("control_ran");
        if (outcome.event !== "control_ran") {
          return;
        }
        expect(outcome.stage).toBe("payload");
        expect(outcome.ok).toBe(true);

        // What was executed, as the child itself recorded being executed: the payload's `bin/node`,
        // the payload's `dist/bin.js`, and then the verb.
        const payload = packagedPayloadRoot(resources, process.platform);
        const run = onlyRun(record);
        expect(run.executable).toBe(packagedInterpreter(payload, process.platform));
        expect(run.argv).toEqual([packagedCliEntry(payload, process.platform), "connect", vendor]);
        // What the window is told is what ran, not a summary of it.
        expect(outcome.executable).toBe(run.executable);
        expect(outcome.argv).toEqual(run.argv);
      },
      CASE_TIMEOUT_MS,
    );

    it(
      `runs the stable launcher for ${vendor} once an install has written one`,
      async () => {
        const { resources, stateDir, record } = cleanMachine();
        const launcher = recordingLauncher(stateDir, record);

        const outcome = await connectAgent(vendor, { resourcesPath: resources, stateDir });

        expect(outcome.event).toBe("control_ran");
        if (outcome.event !== "control_ran") {
          return;
        }
        expect(outcome.stage).toBe("launcher");
        expect(outcome.executable).toBe(launcher);

        // No entry is prepended: the launcher is the interpreter and the entry, which is what makes
        // it the one name that survives an update moving the runtime out from under it.
        const run = onlyRun(record);
        expectRan(run.executable, launcher);
        expect(run.argv).toEqual(["connect", vendor]);
        expect(outcome.argv).toEqual(run.argv);
      },
      CASE_TIMEOUT_MS,
    );
  }

  it("writes no agent configuration of its own — it only runs the CLI's writer", () => {
    // The argv is the whole of what this control does. `connect` is the writer, and there is no
    // second spelling of a scope, a `config.toml` table or a `claude mcp add` in this app.
    expect(connectArgv("claude")).toEqual(["connect", "claude"]);
    expect(connectArgv("codex")).toEqual(["connect", "codex"]);
  });
});

describe("the start-xplainer-at-login control", () => {
  it(
    "runs the packaged payload and stages the payload it is running out of",
    async () => {
      const { resources, stateDir, record } = cleanMachine();
      expect(existsSync(launcherPath(stateDir))).toBe(false);

      const outcome = await startAtLogin({ resourcesPath: resources, stateDir });

      expect(outcome.event).toBe("control_ran");
      if (outcome.event !== "control_ran") {
        return;
      }
      expect(outcome.stage).toBe("payload");

      const payload = packagedPayloadRoot(resources, process.platform);
      const run = onlyRun(record);
      expect(run.executable).toBe(packagedInterpreter(payload, process.platform));
      // `--runtime` is what makes this reachable on a clean machine: nothing is staged under
      // `<state>/runtime/` yet, and the packaged app is carrying a payload-1 directory.
      expect(run.argv).toEqual([
        packagedCliEntry(payload, process.platform),
        "daemon",
        "install",
        "--runtime",
        payload,
      ]);
      expect(outcome.argv).toEqual(run.argv);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "runs the stable launcher once one exists, and stages nothing over what is already there",
    async () => {
      const { resources, stateDir, record } = cleanMachine();
      const launcher = recordingLauncher(stateDir, record);

      const outcome = await startAtLogin({ resourcesPath: resources, stateDir });

      expect(outcome.event).toBe("control_ran");
      if (outcome.event !== "control_ran") {
        return;
      }
      expect(outcome.stage).toBe("launcher");
      expect(outcome.executable).toBe(launcher);

      const run = onlyRun(record);
      expectRan(run.executable, launcher);
      expect(run.argv).toEqual(["daemon", "install"]);
      expect(outcome.argv).toEqual(run.argv);
    },
    CASE_TIMEOUT_MS,
  );

  it("writes no plist, unit or scheduled task of its own", () => {
    const resources = "/Applications/Xplainer.app/Contents/Resources";
    const payload = { kind: "payload", executable: "", leadingArgs: [], cwd: "" } as const;
    const launcher = { kind: "launcher", executable: "", leadingArgs: [], cwd: "" } as const;

    // `daemon install` is the only verb either branch names, on every platform.
    expect(installArgv(payload, resources, "darwin").slice(0, 2)).toEqual(["daemon", "install"]);
    expect(installArgv(launcher, resources, "win32")).toEqual(["daemon", "install"]);
  });
});

describe("every shell-out goes through D10's two-stage resolution", () => {
  it("names an absolute program at both stages, and never a bare `xplainer`", async () => {
    const { resources, stateDir } = cleanMachine();

    const clean = resolveCliProgram({ resourcesPath: resources, stateDir });
    expect(clean.kind).toBe("payload");
    expect(isAbsolute(clean.executable)).toBe(true);
    expect(clean.executable).not.toBe("xplainer");

    recordingLauncher(stateDir, recordFile());
    const installed = resolveCliProgram({ resourcesPath: resources, stateDir });
    expect(installed.kind).toBe("launcher");
    expect(isAbsolute(installed.executable)).toBe(true);
    expect(installed.executable).toBe(launcherPath(stateDir));
  });

  it("says so by name when there is neither a launcher nor a usable payload", async () => {
    const outcome = await connectAgent("claude", {
      resourcesPath: temporaryDirectory(),
      stateDir: temporaryDirectory(),
    });

    expect(outcome.event).toBe("control_unavailable");
    if (outcome.event !== "control_unavailable") {
      return;
    }
    expect(outcome.reason).toBe("payload-unavailable");
    expect(outcome.detail).toMatch(/carries no runtime\.manifest\.json/);
  });
});
