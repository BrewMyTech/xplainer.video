/**
 * The update transaction, against a real daemon, a real journal and a recorded supervisor.
 *
 * **What is real here, and what is a seam.** Two payload-1 artefacts are real: a real interpreter,
 * a real entry, a real manifest, staged by the shipped content-addressed stager into real
 * directories. The supervisor artefact, the launcher and `daemon.json` are the shipped renderers'
 * real bytes on a real disk. The daemon that is drained and the daemon that answers afterwards are
 * **real spawned processes** that mint a real bearer token, answer a real authenticated
 * `GET /healthz` and accept a real `POST /api/daemon/drain` over a real unix socket. The journal is
 * the real file at `<state>/update.json`, read back off disk at every supervisor command. The
 * updater that dies is a **real process, killed with `SIGKILL`**.
 *
 * The one seam is `run` — how a supervisor command reaches the outside world — for the reason
 * `install.test.ts` gives: three platforms' sequences have to be checkable from one machine, and a
 * Task Scheduler sequence cannot be run on macOS at all. It is not a double for what is under test:
 * what is under test is the **order**, the **journal** and the **rollback**, and each of those is
 * asserted against the filesystem, a live HTTP answer, or the exact commands the supervisor was
 * handed. The end-to-end case — a real `launchctl`, a real payload from `runtime build` — is
 * `testing/update-proof.ts`, which runs only when it is asked to because it writes to this
 * machine's own service manager.
 */

import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readDaemonState, readRuntimeState } from "../../daemon/daemon-state.js";
import {
  DAEMON_UNHEALTHY_EXIT_CODE,
  OWNERSHIP_REFUSED_EXIT_CODE,
  PRECONDITION_UNMET_EXIT_CODE,
} from "../../daemon/exit-codes.js";
import {
  CHILD_CLI,
  killAndWait,
  removeTree,
  spawnEntry,
  untilGone,
} from "../../daemon/testing/spawn-child.js";
import { isAlive } from "../../daemon/worker-identity.js";
import { verifyWorkspacePayload } from "../../runtime/verify.js";
import { installDaemon } from "../install.js";
import { launcherPath } from "../launcher.js";
import { stagedRuntimeRoot } from "../stage.js";
import { buildFixturePayload, type FixturePayload } from "../testing/payload.js";
import { writeToolchainMarker } from "../testing/toolchain.js";
import {
  readUpdateJournal,
  TRANSITION_MEANING,
  UPDATE_TRANSITIONS,
  type UpdateTransition,
  updateJournalPath,
} from "./journal.js";
import { OperationLockRefused, operationLockPath } from "./lock.js";
import {
  RECOVER_COMMAND,
  readUpdateStatus,
  recoverUpdate,
  updateStatusSentences,
} from "./recover.js";
import { templatePinsOf } from "./stage.js";
import {
  fixtureEnvironment,
  fixtureLingerMarker,
  PARKED_LINE,
  type UpdateHarness,
  updateHarness,
  windowsFixtureEnvironment,
} from "./testing/harness.js";
import { renderersAmong, untilProcessesNaming } from "./testing/survivors.js";
import { writeFixtureWorkspace } from "./testing/workspace.js";
import { UpdateRefusal, updateDaemon } from "./transaction.js";

/** The pins both supported runtimes declare. Identical, which is what makes an update legal. */
const PINS = { remotion: "4.0.495", react: "19.2.3" } as const;

/** The pins a runtime that may not be updated to declares. One package, one different version. */
const OTHER_PINS = { remotion: "4.0.500", react: "19.2.3" } as const;

/** The budget for a case that stages a payload and starts a real daemon out of it. */
const SPAWN_TIMEOUT_MS = 90_000;

/** How long a readiness wait may take here. Long enough for a spawn, short enough to fail. */
const HEALTH_MS = 20_000;

/** How long a *deliberate* readiness failure waits before the transaction rolls back. */
const DOOMED_HEALTH_MS = 1_500;

/** The child entry that parks a half-finished transaction so the suite can kill it. */
const INTERRUPT_UPDATE = fileURLToPath(new URL("./testing/interrupt-update.ts", import.meta.url));

/**
 * The first command a switch's **reload** runs, per platform.
 *
 * `switchRuntime()` rewrites the artefact, the launcher and `daemon.json` and only then tells the
 * supervisor anything, so this command is the line between "the file names the incoming runtime"
 * and "the supervisor has read it" — which is where the `drained` boundary's kill lands.
 */
function firstReloadCommand(platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return "bootout";
  }
  return platform === "win32" ? "Register-ScheduledTask" : "daemon-reload";
}

/** The same command on the platform this suite is running on. */
const SWITCH_COMMAND = firstReloadCommand(process.platform);

/** The command that asks the supervisor to start what it now holds, per platform. */
function startCommandWord(platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return "kickstart";
  }
  return platform === "win32" ? "Start-ScheduledTask" : "--user start";
}

/** The command that asks it to stop what it is running, which is a rollback's first act. */
function stopCommandWord(platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return "launchctl kill";
  }
  return platform === "win32" ? "Stop-ScheduledTask" : "--user stop";
}

let suiteScratch = "";
let alpha: FixturePayload;
let beta: FixturePayload;
let gamma: FixturePayload;
const scratch: string[] = [];
/**
 * Every state directory a case made, so a daemon nobody holds a handle for is still cleaned up.
 *
 * A killed updater's daemon is **orphaned**: the process that spawned it is gone, so the suite has
 * no `ChildProcess` for it, and a case that fails before its recovery would leave a real daemon
 * running on this machine. The pid its own `runtime.json` names is the only handle left.
 */
const stateDirs: string[] = [];
const children: ChildProcess[] = [];
const harnesses: UpdateHarness[] = [];
/**
 * Files a `win32` case wrote **into this process's working directory**, to be removed after it.
 *
 * A Windows artefact path is built with `win32.join`, so on POSIX the whole thing — backslashes
 * included — is one filename with no separators in it, and `writeFileSync` puts it in the cwd
 * rather than under the scratch root the environment named. `install.test.ts` never sees this
 * because its Windows case ends in a rollback that removes the file; a case that *succeeds* has to
 * tidy up after itself.
 */
const stray: string[] = [];

beforeAll(() => {
  suiteScratch = realpathSync(mkdtempSync(join(tmpdir(), "xplainer-update-suite-")));
  // The marker and the version are the same string on purpose: the fixture daemon reports its
  // marker as `/healthz`'s `version`, and the transaction's readiness check compares that against
  // the version of the package the payload's launch contract names. Two runtimes that reported the
  // same release would make the identity assertion vacuous, which is the thing being tested.
  alpha = buildFixturePayload({
    outDir: join(suiteScratch, "alpha"),
    version: "1.2.3-alpha",
    marker: "1.2.3-alpha",
    templatePins: PINS,
    // `runtime/verify.ts` refuses a payload whose manifest names another platform, so a Windows
    // payload cannot be staged here at all. What *is* checkable everywhere is the artefact, the
    // argv and the command sequence, and those need only a file at the name a `win32` launch
    // contract picks.
    extraInterpreters: ["node.exe"],
  });
  beta = buildFixturePayload({
    outDir: join(suiteScratch, "beta"),
    version: "2.0.0-beta",
    marker: "2.0.0-beta",
    templatePins: PINS,
    extraInterpreters: ["node.exe"],
  });
  // Never started, so it needs no interpreter: it exists to be refused before anything is staged.
  gamma = buildFixturePayload({
    outDir: join(suiteScratch, "gamma"),
    version: "3.0.0-gamma",
    marker: "3.0.0-gamma",
    templatePins: OTHER_PINS,
    runnable: false,
  });
}, 180_000);

afterAll(() => {
  removeTree(suiteScratch);
});

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    harness.stopAll();
  }
  // Killed **and waited for** before anything below removes what they were writing into: a
  // signalled process still holds every handle it had, and Windows refuses to unlink a file with an
  // open handle. `windows-latest` answered `EPERM ... \\?\\C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\
  // xplainer-update-…` here on 2026-09-08.
  await Promise.all(children.splice(0).map((child) => killAndWait(child, 5_000)));
  for (const stateDir of stateDirs.splice(0)) {
    const orphan = readRuntimeState(stateDir)?.pid;
    if (typeof orphan === "number" && isAlive(orphan)) {
      try {
        process.kill(orphan, "SIGKILL");
      } catch {
        // It exited between the liveness check and the signal, which is the outcome asked for.
      }
    }
  }
  for (const path of stray.splice(0)) {
    rmSync(path, { force: true });
  }
  for (const directory of scratch.splice(0)) {
    removeTree(directory);
  }
});

/** A throwaway directory that is removed after the test. */
function scratchDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "xplainer-update-")));
  scratch.push(directory);
  return directory;
}

/** One machine: a state directory with a setup marker, a home, and a verified workspace. */
function machine(
  options: { resolved?: Record<string, string>; pins?: Readonly<Record<string, string>> } = {},
) {
  const root = scratchDirectory();
  const stateDir = join(root, "state");
  const home = join(root, "home");
  const workspaceRoot = join(root, "workspace");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(home, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  writeToolchainMarker(stateDir);
  stateDirs.push(stateDir);
  writeFixtureWorkspace({
    outDir: workspaceRoot,
    // The pins the workspace was installed from, which is `setup --workspace`'s answer and not
    // always the installed runtime's: the sixth refusal case is the machine where they differ.
    pins: options.pins ?? PINS,
    ...(options.resolved === undefined ? {} : { resolved: options.resolved }),
  });
  return {
    root,
    stateDir,
    home,
    workspaceRoot,
    // **The same object the interrupted updater builds for itself.** `interruptEnvironment()` hands
    // the child the scratch *root* on `win32`, because that is the tree `windowsFixtureEnvironment`
    // hangs `Users/tester` and `AppData` off — so a recovery running in *this* process with
    // `fixtureEnvironment(home)` would render its artefact at a second path entirely and leave the
    // registered one saying whatever the interrupted switch had written there. `windows-latest`
    // reported exactly that on 2026-09-08: after a recovery the mirror still named the incoming
    // runtime, at three of the five boundaries.
    environment:
      process.platform === "win32" ? windowsFixtureEnvironment(root) : fixtureEnvironment(home),
  };
}

/** One machine, as {@link machine} builds it. */
type Machine = ReturnType<typeof machine>;

/**
 * A Windows account and directories, inside a scratch tree so nothing real is touched.
 *
 * It lives in `testing/harness.ts` beside {@link fixtureEnvironment} because two processes build
 * one: this suite, and the child entry that parks a `win32` transaction so it can be killed.
 */
function windowsEnvironment(root: string) {
  return windowsFixtureEnvironment(root);
}

/**
 * A harness that the suite will stop afterwards, whatever the case does.
 *
 * It is given the machine and not just its state directory so it can create the linger marker the
 * **fixture** environment names. `install.ts` checks `existsSync` on `<lingerDir>/<account>` after
 * it asks `loginctl` for lingering, and a Linux host with no injected directory resolves the
 * runner's own `/var/lib/systemd/linger/$USER` — which no recording supervisor ever creates, so
 * every case here refused with exit `5` on Linux while passing on macOS, where the marker is not
 * consulted at all.
 */
function harnessFor(where: Pick<Machine, "stateDir" | "environment">): UpdateHarness {
  const harness = updateHarness({
    stateDir: where.stateDir,
    lingerMarker: fixtureLingerMarker(where.environment),
    onSpawn: (child) => {
      children.push(child);
    },
  });
  harnesses.push(harness);
  return harness;
}

/** Install one payload, exactly as `daemon install` would, and leave it answering. */
async function installed(
  where: ReturnType<typeof machine>,
  payload: FixturePayload,
  harness: UpdateHarness,
) {
  return installDaemon({
    stateDir: where.stateDir,
    payloadDir: payload.outDir,
    port: 0,
    environment: where.environment,
    run: harness.run,
    healthTimeoutMs: HEALTH_MS,
  });
}

/** The refusal a call produced, typed, so a case can assert its code and its message. */
async function refusalFrom(act: () => Promise<unknown>): Promise<UpdateRefusal> {
  const error = await act().then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(UpdateRefusal);
  return error as UpdateRefusal;
}

/** Every staged runtime's directory name, which is the set an update must not have added to. */
function stagedSlots(stateDir: string): string[] {
  return readdirSync(stagedRuntimeRoot(stateDir))
    .filter((name) => !name.startsWith("."))
    .sort();
}

/** A file's bytes as a SHA-256, for "this was not touched". */
function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * The daemon's own answer to an authenticated `/healthz`, or `null` when nothing answers.
 *
 * `node:http` with `agent: false`, not `fetch`: a pooled keep-alive socket outlives the response
 * and holds the worker open after the assertions are done, which is the same reason
 * `install/health.ts` opens one connection per attempt and lets it close.
 */
async function askHealth(stateDir: string): Promise<{ status: number; version: unknown } | null> {
  const runtime = readRuntimeState(stateDir);
  const daemon = readDaemonState(stateDir);
  if (runtime === null || typeof runtime.port !== "number" || daemon.token_file === null) {
    return null;
  }
  const token = readFileSync(daemon.token_file, "utf8").trim();
  return new Promise((resolve) => {
    const call = httpRequest(
      {
        host: "127.0.0.1",
        port: runtime.port as number,
        path: "/healthz",
        method: "GET",
        agent: false,
        headers: { authorization: `Bearer ${token}` },
        timeout: 3_000,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          const parsed = JSON.parse(body) as { version?: unknown };
          resolve({ status: response.statusCode ?? 0, version: parsed.version });
        });
      },
    );
    call.on("error", () => {
      resolve(null);
    });
    call.on("timeout", () => {
      call.destroy();
      resolve(null);
    });
    call.end();
  });
}

describe("daemon update — the transaction", () => {
  it(
    "stages, drains over the socket, switches the artefact and leaves the new runtime answering",
    async () => {
      const where = machine();
      const harness = harnessFor(where);
      await installed(where, alpha, harness);
      const before = readRuntimeState(where.stateDir);
      const drainedPid = before?.pid as number;
      expect(before?.run_id).toContain("1.2.3-alpha");

      const outcome = await updateDaemon({
        stateDir: where.stateDir,
        from: beta.outDir,
        environment: where.environment,
        run: harness.run,
        workspaceRoot: where.workspaceRoot,
        healthTimeoutMs: HEALTH_MS,
      });

      // ADR 0025 step 3: the drain went over the socket, not through the supervisor.
      expect(outcome.commands.some((command) => command.startsWith("POST /api/daemon/drain"))).toBe(
        true,
      );
      expect(await untilGone(drainedPid)).toBe(true);

      // Step 4: the artefact the supervisor reads now names the incoming runtime, and so do the
      // launcher and the record. The artefact is read off disk rather than from the outcome.
      const daemon = readDaemonState(where.stateDir);
      expect(daemon.runtime_dir).toBe(outcome.incoming.runtime_dir);
      expect(readFileSync(outcome.supervisor.artefact, "utf8")).toContain(
        outcome.incoming.runtime_dir,
      );
      expect(readFileSync(launcherPath(where.stateDir), "utf8")).toContain(
        outcome.incoming.runtime_dir,
      );

      // Step 5: readiness is the new runtime's own authenticated answer, from a new run.
      expect(outcome.health.version).toBe("2.0.0-beta");
      expect(outcome.rolledBack).toBe(false);
      expect(outcome.runId).not.toBe(before?.run_id);
      expect((await askHealth(where.stateDir))?.version).toBe("2.0.0-beta");

      // The retained previous runtime is still on disk, which is what a rollback would need.
      expect(existsSync(outcome.previous.runtime_dir)).toBe(true);
      expect(stagedSlots(where.stateDir)).toHaveLength(2);

      // And the journal is gone, which is how a completed transaction is recorded.
      expect(existsSync(updateJournalPath(where.stateDir))).toBe(false);
      expect(existsSync(operationLockPath(where.stateDir))).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "makes each boundary durable before the step it licenses runs",
    async () => {
      const where = machine();
      const harness = harnessFor(where);
      await installed(where, alpha, harness);
      const untilInstall = harness.calls.length;

      await updateDaemon({
        stateDir: where.stateDir,
        from: beta.outDir,
        environment: where.environment,
        run: harness.run,
        workspaceRoot: where.workspaceRoot,
        healthTimeoutMs: HEALTH_MS,
      });

      // Every command the *update* ran, with what `<state>/update.json` said at that moment. The
      // switch must see `drained` and the start must see `switched`: a journal written at the end
      // from memory would show `null` here, and a journal written after the step would show the
      // previous transition.
      const updateCalls = harness.calls.slice(untilInstall);
      const reload = updateCalls.filter((call) => call.command.includes(SWITCH_COMMAND));
      expect(reload.length).toBeGreaterThan(0);
      for (const call of reload) {
        expect(call.transition).toBe("drained");
      }
      const start = updateCalls.find((call) =>
        call.command.includes(startCommandWord(process.platform)),
      );
      expect(start?.transition).toBe("switched");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "stops the replacement before it starts anything, and puts the retained runtime back",
    async () => {
      const where = machine();
      const harness = harnessFor(where);
      const install = await installed(where, alpha, harness);
      const untilInstall = harness.calls.length;

      // The staged copy of the incoming runtime is never started, which is round 1's first
      // injected failure and step 6's precondition.
      harness.refuseStartOf(join(stagedRuntimeRoot(where.stateDir), "2.0.0-beta-"));

      // A record the newer version wrote, in the shape ADR 0024 gives one: a `format_version` this
      // build does not understand. ADR 0025 says state written by the newer version is
      // **preserved rather than deleted**, so the rollback must leave it exactly here.
      const newerRecord = join(where.stateDir, "jobs", "written-by-the-newer-version.json");
      mkdirSync(join(where.stateDir, "jobs"), { recursive: true });
      writeFileSync(newerRecord, `${JSON.stringify({ format_version: 99, id: "job-1" })}\n`);
      const newerRecordHash = hashFile(newerRecord);

      const refusal = await refusalFrom(() =>
        updateDaemon({
          stateDir: where.stateDir,
          from: beta.outDir,
          environment: where.environment,
          run: harness.run,
          workspaceRoot: where.workspaceRoot,
          healthTimeoutMs: DOOMED_HEALTH_MS,
        }),
      );

      expect(refusal.exitCode).toBe(DAEMON_UNHEALTHY_EXIT_CODE);
      expect(refusal.message).toContain("1.2.3-alpha");
      expect(refusal.message).toContain("is installed and answering");

      // The stop comes before the rollback's own reload, or two daemons would contend for the
      // state directory and the rollback would be the one that loses.
      const rollbackCalls = harness.calls.slice(untilInstall).map((call) => call.command);
      const stoppedAt = rollbackCalls.findIndex((command) =>
        command.includes(stopCommandWord(process.platform)),
      );
      let rolledBackAt = -1;
      for (const [index, command] of rollbackCalls.entries()) {
        if (command.includes(SWITCH_COMMAND)) {
          rolledBackAt = index;
        }
      }
      expect(stoppedAt).toBeGreaterThanOrEqual(0);
      expect(rolledBackAt).toBeGreaterThan(stoppedAt);

      // The machine is back on the runtime it was installed with, and it is answering.
      expect(readDaemonState(where.stateDir).runtime_dir).toBe(install.runtimeDir);
      expect(readFileSync(install.artefact, "utf8")).toContain(install.runtimeDir);
      expect((await askHealth(where.stateDir))?.version).toBe("1.2.3-alpha");
      expect(existsSync(updateJournalPath(where.stateDir))).toBe(false);
      expect(hashFile(newerRecord)).toBe(newerRecordHash);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "re-registers the task on Windows, and falls back to the supervisor when no socket answers",
    async () => {
      // The Windows sequence, driven from this machine exactly as `install.test.ts` drives the
      // Windows install: the artefact, the argv and the command order are what differ per platform,
      // and none of them needs Windows to be asserted. What the fixture cannot do here is bind a
      // named pipe, so this case is also the one that exercises the drain's **fallback**: the route
      // could not be asked, and the supervisor's own stop is what ends the running daemon.
      const where = machine();
      const harness = harnessFor(where);
      const environment = windowsEnvironment(where.root);
      const install = await installDaemon({
        stateDir: where.stateDir,
        payloadDir: alpha.outDir,
        port: 0,
        platform: "win32",
        environment,
        run: harness.run,
        uid: 0,
        healthTimeoutMs: HEALTH_MS,
      });
      stray.push(install.artefact);
      const untilInstall = harness.calls.length;

      const outcome = await updateDaemon({
        stateDir: where.stateDir,
        from: beta.outDir,
        platform: "win32",
        environment,
        run: harness.run,
        uid: 0,
        workspaceRoot: where.workspaceRoot,
        healthTimeoutMs: HEALTH_MS,
      });

      const updateCalls = harness.calls.slice(untilInstall);
      const register = updateCalls.find((call) => call.command.includes("Register-ScheduledTask"));
      expect(register?.command).toContain("-Force");
      expect(register?.transition).toBe("drained");
      expect(
        updateCalls.findIndex((call) => call.command.includes("Stop-ScheduledTask")),
      ).toBeLessThan(updateCalls.indexOf(register as (typeof updateCalls)[number]));
      expect(outcome.health.version).toBe("2.0.0-beta");
      expect(readFileSync(outcome.supervisor.artefact, "utf8")).toContain(
        outcome.incoming.runtime_dir,
      );
      expect(existsSync(updateJournalPath(where.stateDir))).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe("daemon update — the pre-drain precondition (D9)", () => {
  it(
    "refuses a runtime whose template pins differ, having staged nothing and drained nothing",
    async () => {
      const where = machine();
      const harness = harnessFor(where);
      await installed(where, alpha, harness);
      const before = readRuntimeState(where.stateDir);

      const refusal = await refusalFrom(() =>
        updateDaemon({
          stateDir: where.stateDir,
          from: gamma.outDir,
          environment: where.environment,
          run: harness.run,
          workspaceRoot: where.workspaceRoot,
        }),
      );

      expect(refusal.exitCode).toBe(PRECONDITION_UNMET_EXIT_CODE);
      expect(refusal.message).toContain("remotion: installed 4.0.495, incoming 4.0.500");
      expect(refusal.message).toContain("REINSTALL");
      // The reinstall path, run from the NEW runtime's own program rather than the launcher.
      expect(refusal.message).toContain(`${gamma.interpreter} ${gamma.entry} setup --workspace`);
      expect(refusal.message).toContain(
        `${gamma.interpreter} ${gamma.entry} daemon install --runtime ${gamma.outDir}`,
      );
      expect(refusal.message).not.toContain(launcherPath(where.stateDir));

      // Nothing staged, nothing drained, no journal.
      const slots = stagedSlots(where.stateDir);
      expect(slots).toHaveLength(1);
      expect(slots[0]).toContain("1.2.3-alpha");
      expect(readRuntimeState(where.stateDir)?.run_id).toBe(before?.run_id);
      expect((await askHealth(where.stateDir))?.version).toBe("1.2.3-alpha");
      expect(existsSync(updateJournalPath(where.stateDir))).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "still refuses when a matching payload 2 is staged beside the new runtime",
    async () => {
      const where = machine();
      const harness = harnessFor(where);
      await installed(where, alpha, harness);
      // Round 4's paired path, offered and not taken: a workspace that satisfies the incoming
      // runtime exactly, staged beside it. D9 dropped that route, so the refusal is unchanged.
      const paired = join(scratchDirectory(), "payload-2");
      mkdirSync(paired, { recursive: true });
      writeFixtureWorkspace({ outDir: paired, pins: OTHER_PINS });

      const refusal = await refusalFrom(() =>
        updateDaemon({
          stateDir: where.stateDir,
          from: gamma.outDir,
          environment: where.environment,
          run: harness.run,
          workspaceRoot: where.workspaceRoot,
        }),
      );

      expect(refusal.exitCode).toBe(PRECONDITION_UNMET_EXIT_CODE);
      expect(refusal.message).toContain("REINSTALL");
      expect(existsSync(updateJournalPath(where.stateDir))).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "refuses when the installed workspace does not satisfy the runtimes it must serve",
    async () => {
      // Identical pins on both sides, and a workspace that resolved something else — the state a
      // machine is in when its workspace was installed from a different template.
      const where = machine({ resolved: { remotion: "4.0.400", react: "19.2.3" } });
      const harness = harnessFor(where);
      await installed(where, alpha, harness);

      const refusal = await refusalFrom(() =>
        updateDaemon({
          stateDir: where.stateDir,
          from: beta.outDir,
          environment: where.environment,
          run: harness.run,
          workspaceRoot: where.workspaceRoot,
        }),
      );

      expect(refusal.exitCode).toBe(PRECONDITION_UNMET_EXIT_CODE);
      expect(refusal.message).toContain("does not satisfy the installed runtime");
      expect(refusal.message).toContain("xplainer setup --workspace");
      expect(stagedSlots(where.stateDir)).toHaveLength(1);
      expect((await askHealth(where.stateDir))?.version).toBe("1.2.3-alpha");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "refuses when there is no verified workspace at all",
    async () => {
      const where = machine();
      const harness = harnessFor(where);
      await installed(where, alpha, harness);
      const empty = join(scratchDirectory(), "no-workspace");
      mkdirSync(empty, { recursive: true });

      const refusal = await refusalFrom(() =>
        updateDaemon({
          stateDir: where.stateDir,
          from: beta.outDir,
          environment: where.environment,
          run: harness.run,
          workspaceRoot: empty,
        }),
      );

      expect(refusal.exitCode).toBe(PRECONDITION_UNMET_EXIT_CODE);
      expect(refusal.message).toContain("xplainer setup --workspace");
      expect(stagedSlots(where.stateDir)).toHaveLength(1);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "will not take the runtime from PATH: the source is named or there is no update",
    async () => {
      const where = machine();
      const harness = harnessFor(where);
      await installed(where, alpha, harness);

      const neither = await refusalFrom(() =>
        updateDaemon({
          stateDir: where.stateDir,
          environment: where.environment,
          run: harness.run,
          workspaceRoot: where.workspaceRoot,
        }),
      );
      expect(neither.exitCode).toBe(PRECONDITION_UNMET_EXIT_CODE);
      expect(neither.message).toContain("--from <dir>");
      expect(neither.message).toContain("PATH");

      const both = await refusalFrom(() =>
        updateDaemon({
          stateDir: where.stateDir,
          from: beta.outDir,
          build: true,
          environment: where.environment,
          run: harness.run,
          workspaceRoot: where.workspaceRoot,
        }),
      );
      expect(both.exitCode).toBe(PRECONDITION_UNMET_EXIT_CODE);
      expect(both.message).toContain("two different runtimes");
      expect(existsSync(updateJournalPath(where.stateDir))).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe("daemon update — the operation lock and the commanded recovery", () => {
  it(
    "refuses a second updater, and an installer, while an operation holds the lock",
    async () => {
      const where = machine();
      const parked = spawnEntry(INTERRUPT_UPDATE, [], interruptEnvironment(where));
      children.push(parked.process);
      await parked.waitForLine(PARKED_LINE, SPAWN_TIMEOUT_MS);

      const refused = await updateDaemon({
        stateDir: where.stateDir,
        from: beta.outDir,
        environment: where.environment,
        run: harnessFor(where).run,
        workspaceRoot: where.workspaceRoot,
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(OperationLockRefused);
      expect((refused as OperationLockRefused).exitCode).toBe(OWNERSHIP_REFUSED_EXIT_CODE);
      expect((refused as Error).message).toContain("update in pid");

      // The installer is turned away by the same lock, and **before** it reaches a supervisor:
      // this spawn runs the real `daemon install`, and the only thing standing between it and this
      // machine's own service manager is the guard under test.
      const install = spawnEntry(CHILD_CLI, ["daemon", "install", "--runtime", alpha.outDir], {
        XPLAINER_STATE_DIR: where.stateDir,
        HOME: where.home,
      });
      children.push(install.process);
      const exit = await install.waitForExit();
      expect(exit.code).toBe(OWNERSHIP_REFUSED_EXIT_CODE);
      expect(install.stderr()).toContain("update.lock");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "reports an interrupted transaction, never repairs it from status, and recovers it on command",
    async () => {
      const where = machine();
      const parked = spawnEntry(INTERRUPT_UPDATE, [], interruptEnvironment(where));
      children.push(parked.process);
      await parked.waitForLine(PARKED_LINE, SPAWN_TIMEOUT_MS);
      parked.process.kill("SIGKILL");
      expect(await untilGone(parked.process.pid as number)).toBe(true);

      // The journal survived the updater, and it names the boundary and the retained runtime.
      const read = readUpdateJournal(where.stateDir);
      expect(read.state).toBe("present");
      expect(read.journal?.transition).toBe("drained");
      expect(read.journal?.previous.slot).toContain("1.2.3-alpha");
      expect(read.journal?.incoming.slot).toContain("2.0.0-beta");

      const status = readUpdateStatus(where.stateDir);
      expect(status.state).toBe("interrupted");
      expect(updateStatusSentences(status).join(" ")).toContain(RECOVER_COMMAND);

      // `daemon status` reports it and changes nothing — the file it read is byte-identical after.
      const before = hashFile(updateJournalPath(where.stateDir));
      const reported = spawnEntry(CHILD_CLI, ["daemon", "status"], {
        XPLAINER_STATE_DIR: where.stateDir,
        HOME: where.home,
      });
      children.push(reported.process);
      await reported.waitForExit();
      expect(reported.stdout()).toContain("INTERRUPTED");
      expect(reported.stdout()).toContain(RECOVER_COMMAND);
      expect(hashFile(updateJournalPath(where.stateDir))).toBe(before);

      // Neither verb starts a second transaction over an unfinished one: a second one would
      // journal a new previous runtime over the one the first is still holding.
      const second = await refusalFrom(() =>
        updateDaemon({
          stateDir: where.stateDir,
          from: beta.outDir,
          environment: where.environment,
          run: harnessFor(where).run,
          workspaceRoot: where.workspaceRoot,
        }),
      );
      expect(second.exitCode).toBe(PRECONDITION_UNMET_EXIT_CODE);
      expect(second.message).toContain("will not start a second one");
      expect(second.message).toContain(RECOVER_COMMAND);
      expect(readUpdateJournal(where.stateDir).journal?.transition).toBe("drained");

      const install = spawnEntry(CHILD_CLI, ["daemon", "install", "--runtime", alpha.outDir], {
        XPLAINER_STATE_DIR: where.stateDir,
        HOME: where.home,
      });
      children.push(install.process);
      expect((await install.waitForExit()).code).toBe(PRECONDITION_UNMET_EXIT_CODE);
      expect(install.stderr()).toContain(RECOVER_COMMAND);

      // One command restores service, and it takes over the lock the dead updater left behind.
      const harness = harnessFor(where);
      const outcome = await recoverUpdate({
        stateDir: where.stateDir,
        environment: where.environment,
        run: harness.run,
        workspaceRoot: where.workspaceRoot,
        healthTimeoutMs: HEALTH_MS,
      });

      expect(outcome.rolledBack).toBe(false);
      expect(outcome.running.slot).toContain("2.0.0-beta");
      expect(outcome.health.version).toBe("2.0.0-beta");
      expect((await askHealth(where.stateDir))?.version).toBe("2.0.0-beta");
      expect(existsSync(updateJournalPath(where.stateDir))).toBe(false);
      expect(existsSync(operationLockPath(where.stateDir))).toBe(false);
      expect(readUpdateStatus(where.stateDir).state).toBe("none");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "offers both verbs on the command line, and each refuses with its documented code",
    async () => {
      // Neither spawn reaches a supervisor: `update` reads `daemon.json` first and `recover` reads
      // the journal first, so a state directory with neither is refused before anything is run.
      const where = machine();

      const update = spawnEntry(CHILD_CLI, ["daemon", "update", "--from", beta.outDir], {
        XPLAINER_STATE_DIR: where.stateDir,
        HOME: where.home,
      });
      children.push(update.process);
      expect((await update.waitForExit()).code).toBe(PRECONDITION_UNMET_EXIT_CODE);
      expect(update.stderr()).toContain("nothing is installed");
      expect(update.stderr()).toContain("xplainer daemon install");

      const recover = spawnEntry(CHILD_CLI, ["daemon", "recover"], {
        XPLAINER_STATE_DIR: where.stateDir,
        HOME: where.home,
      });
      children.push(recover.process);
      expect((await recover.waitForExit()).code).toBe(PRECONDITION_UNMET_EXIT_CODE);
      expect(recover.stderr()).toContain("there is no unfinished update to recover");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "preserves a journal written by a newer release rather than acting on it",
    async () => {
      const where = machine();
      const harness = harnessFor(where);
      await installed(where, alpha, harness);
      const path = updateJournalPath(where.stateDir);
      writeFileSync(path, `${JSON.stringify({ format_version: 99, transition: "elsewhere" })}\n`);
      const before = hashFile(path);

      const status = readUpdateStatus(where.stateDir);
      expect(status.state).toBe("newer");
      expect(updateStatusSentences(status).join(" ")).toContain("rollback signal");

      const refusal = await refusalFrom(() =>
        updateDaemon({
          stateDir: where.stateDir,
          from: beta.outDir,
          environment: where.environment,
          run: harness.run,
          workspaceRoot: where.workspaceRoot,
        }),
      );
      expect(refusal.exitCode).toBe(PRECONDITION_UNMET_EXIT_CODE);
      expect(refusal.message).toContain("format_version 99");
      expect(hashFile(path)).toBe(before);
    },
    SPAWN_TIMEOUT_MS,
  );
});

/**
 * The environment the parked updater is told everything through.
 *
 * `XPLAINER_TEST_PARK_AT` is a **transition**, not a command: the boundary a kill lands on is a
 * value in the journal, and the supervisor verb that follows it is a different word on each of the
 * three platforms. The refusal to start the incoming runtime is set for every case, because the
 * boundaries past the switch are reachable only when the replacement does not become ready.
 */
function interruptEnvironment(
  where: Machine,
  boundary: UpdateTransition = "drained",
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  return {
    XPLAINER_TEST_STATE_DIR: where.stateDir,
    // On `win32` the account and its directories are built from the scratch **root**, because that
    // is the tree `windowsFixtureEnvironment()` hangs `Users/tester` and `AppData` off.
    XPLAINER_TEST_HOME: platform === "win32" ? where.root : where.home,
    XPLAINER_TEST_PAYLOAD_A: alpha.outDir,
    XPLAINER_TEST_PAYLOAD_B: beta.outDir,
    XPLAINER_TEST_WORKSPACE: where.workspaceRoot,
    XPLAINER_TEST_PARK_AT: boundary,
    XPLAINER_TEST_REFUSE_START: incomingSlotPrefix(where.stateDir),
    XPLAINER_TEST_HEALTH_MS: String(DOOMED_HEALTH_MS),
    ...(platform === process.platform ? {} : { XPLAINER_TEST_PLATFORM: platform }),
  };
}

// ── T16: failure injection, including the updater's own death ────────────────────────────────

/** The version payload A declares, and therefore the first half of its staged directory's name. */
const PREVIOUS_VERSION = "1.2.3-alpha";

/** The same for payload B, the runtime an update switches to. */
const INCOMING_VERSION = "2.0.0-beta";

/** Where the incoming runtime is staged, as the prefix a supervisor is told to refuse to start. */
function incomingSlotPrefix(stateDir: string): string {
  return join(stagedRuntimeRoot(stateDir), `${INCOMING_VERSION}-`);
}

/** The staged directory a runtime of this version lives in, read off disk rather than composed. */
function stagedDirectoryFor(stateDir: string, version: string): string {
  const slot = stagedSlots(stateDir).find((name) => name.startsWith(`${version}-`));
  expect(slot).toBeDefined();
  return join(stagedRuntimeRoot(stateDir), slot as string);
}

/**
 * The sixth assertion, in the half that is provable without a browser: **it can render**.
 *
 * Round 4's four assertions — the previous runtime answering, the newer version's state intact, one
 * owner, no surviving Chrome — all pass on a daemon that answers `/healthz` and cannot render, which
 * is the failure class the whole precondition exists for. What makes the rolled-back daemon able to
 * render is that the installed workspace satisfies **the runtime that is installed now**, and that
 * is asked here of the shipped verifier: it re-hashes every file of the workspace and compares its
 * resolved versions against the pins in the rolled-back runtime's own `template/package.json`.
 *
 * **What is deferred, and to where.** The PNG itself needs a Chrome headless shell and a real
 * payload 2 — T19's and T33's, in B6 — so `scripts/e2e/toolchain.mjs` **reruns every rollback case
 * and renders a still against the recovered daemon**. B5 proves the transaction, the journal, the
 * boundaries, the recovery command and this readiness; B6 proves the image.
 */
function expectRenderReady(where: Machine): void {
  const installedRuntime = readDaemonState(where.stateDir).runtime_dir;
  expect(installedRuntime).not.toBeNull();
  const report = verifyWorkspacePayload(
    where.workspaceRoot,
    templatePinsOf(installedRuntime as string, "installed"),
  );
  expect(report.ok).toBe(true);
  expect(report.checked).toBeGreaterThan(0);
}

/**
 * Start a real update, let it reach `boundary`, and `SIGKILL` the updater there.
 *
 * @returns the line the updater printed as it parked, which says **exactly** where it stopped —
 * the evidence for what had and had not been done, at boundaries where the filesystem alone cannot
 * say (see {@link firstReloadCommand}).
 */
async function killUpdaterAt(
  where: Machine,
  boundary: UpdateTransition,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const parked = spawnEntry(INTERRUPT_UPDATE, [], interruptEnvironment(where, boundary, platform));
  children.push(parked.process);
  const line = await parked.waitForLine(`${PARKED_LINE} ${boundary}`, SPAWN_TIMEOUT_MS);
  parked.process.kill("SIGKILL");
  expect(await untilGone(parked.process.pid as number)).toBe(true);
  return line;
}

/**
 * Where a kill at `boundary` must have landed, as substrings of the line the updater parks on.
 *
 * Two of them rather than one for the three boundaries a supervisor command follows, because the
 * line carries the whole command — `systemctl --user start xplainer.service was about to run` — and
 * what is being asserted is which command it was and that it had **not** run.
 */
function parkedWhere(boundary: UpdateTransition, platform: NodeJS.Platform): readonly string[] {
  switch (boundary) {
    case "staged":
      return ["the drain reached this updater's own socket"];
    case "drained":
      return [firstReloadCommand(platform), "was about to run"];
    case "switched":
      return [startCommandWord(platform), "was about to run"];
    case "started":
      // The readiness wait has timed out and the rollback is about to stop the replacement: the
      // journal still says `started`, and this is the first supervisor command after it.
      return [stopCommandWord(platform), "was about to run"];
    case "rolling-back":
      return [firstReloadCommand(platform), "was about to run"];
  }
}

describe("daemon update — the updater's own death, at every durable boundary", () => {
  // One case per boundary, and each of them runs the **two steps** the plan settles. Round 2
  // asserted step 2's four properties at every boundary with no step 1, which cannot hold where
  // the daemon has exited `0` and no supervisor restarts on success: at four of these five
  // boundaries there is legitimately nothing running until the named command is run, and asserting
  // a live daemon there would be asserting a guarantee this design deliberately does not make.
  for (const boundary of UPDATE_TRANSITIONS) {
    it(
      `reports the interruption at "${boundary}", then restores service on the named command`,
      async () => {
        const where = machine();
        const parked = await killUpdaterAt(where, boundary);
        const previousDir = stagedDirectoryFor(where.stateDir, PREVIOUS_VERSION);
        const incomingDir = stagedDirectoryFor(where.stateDir, INCOMING_VERSION);
        for (const fragment of parkedWhere(boundary, process.platform)) {
          expect(parked).toContain(fragment);
        }

        // ── step 1, immediately after the kill and before anything else ──────────────────────
        const read = readUpdateJournal(where.stateDir);
        expect(read.state).toBe("present");
        expect(read.journal?.transition).toBe(boundary);
        expect(read.journal?.previous.runtime_dir).toBe(previousDir);
        expect(read.journal?.incoming.runtime_dir).toBe(incomingDir);

        const status = readUpdateStatus(where.stateDir);
        expect(status.state).toBe("interrupted");
        const sentences = updateStatusSentences(status).join(" ");
        expect(sentences).toContain(`INTERRUPTED at "${boundary}"`);
        expect(sentences).toContain(TRANSITION_MEANING[boundary]);
        expect(sentences).toContain(RECOVER_COMMAND);

        // The command a person actually runs says the same three things, and repairs nothing.
        const journalBefore = hashFile(updateJournalPath(where.stateDir));
        const reported = spawnEntry(CHILD_CLI, ["daemon", "status"], {
          XPLAINER_STATE_DIR: where.stateDir,
          HOME: where.home,
        });
        children.push(reported.process);
        await reported.waitForExit();
        expect(reported.stdout()).toContain("INTERRUPTED");
        expect(reported.stdout()).toContain(boundary);
        expect(reported.stdout()).toContain(RECOVER_COMMAND);
        expect(hashFile(updateJournalPath(where.stateDir))).toBe(journalBefore);

        // Whether a daemon is answering is **not** asserted to be true, and that is the point.
        // Past `staged` the drain has left nothing running, the daemon exited `0`, and `0` is the
        // portable "do not restart" signal in both `Restart=on-failure` and
        // `KeepAlive{SuccessfulExit:false}` — T15's stated cost, asserted rather than glossed.
        const answering = await askHealth(where.stateDir);
        if (boundary === "staged") {
          // The daemon the updater had not yet drained is still running, and answering on the port
          // `runtime.json` records — so the record, the process and the answer are asserted
          // together. They are one object because when this fails there is no host here to re-run
          // it on: `windows-latest` reported `undefined` for the version on 2026-09-08 and the
          // three candidate causes — the record gone, the process gone with the parent it was
          // spawned from, or a live daemon that stopped answering — are indistinguishable from a
          // single `undefined`.
          const record = readRuntimeState(where.stateDir);
          expect({
            version: answering?.version,
            recorded: record === null ? "no runtime.json" : { pid: record.pid, port: record.port },
            alive: typeof record?.pid === "number" && isAlive(record.pid),
          }).toEqual({
            version: PREVIOUS_VERSION,
            recorded: { pid: expect.any(Number), port: expect.any(Number) },
            alive: true,
          });
        } else {
          expect(answering).toBeNull();
        }

        // What the artefact names, which is **not** the same question as what the supervisor holds.
        // `switchRuntime()` rewrites the artefact, the launcher and the record before it runs a
        // single reload command, in both directions — so the file turns over at the *start* of the
        // forward switch and again at the start of the rollback's, one step earlier each time than
        // the supervisor that reads it. At `drained` the file already names the incoming runtime
        // while launchd, systemd and Task Scheduler still hold the definition they last loaded,
        // which is the same asymmetry §1.3b D7 records for macOS and the reason the parked line
        // above is what settles what a supervisor restarting on its own would start.
        const artefact = readDaemonState(where.stateDir).supervisor_artefact as string;
        const registered = readFileSync(artefact, "utf8");
        const written =
          boundary === "staged" || boundary === "rolling-back" ? previousDir : incomingDir;
        expect(registered).toContain(written);
        expect(registered).not.toContain(written === previousDir ? incomingDir : previousDir);

        // ── step 2, after running the named recovery command ─────────────────────────────────
        // State the newer version wrote, in the shape ADR 0024 gives one: a `format_version` this
        // build does not understand, which that record calls a rollback signal and never
        // corruption. Nothing in the rollback may touch it.
        const newerRecord = join(where.stateDir, "jobs", "written-by-the-newer-version.json");
        mkdirSync(join(where.stateDir, "jobs"), { recursive: true });
        writeFileSync(newerRecord, `${JSON.stringify({ format_version: 99, id: "job-1" })}\n`);
        const newerRecordHash = hashFile(newerRecord);

        // The replacement still will not start — round 1's first injected failure — so every one
        // of these recoveries ends in a rollback, which is what makes the six assertions below
        // the same six at every boundary.
        const harness = harnessFor(where);
        harness.refuseStartOf(incomingSlotPrefix(where.stateDir));
        const recovered = await refusalFrom(() =>
          recoverUpdate({
            stateDir: where.stateDir,
            environment: where.environment,
            run: harness.run,
            workspaceRoot: where.workspaceRoot,
            healthTimeoutMs: DOOMED_HEALTH_MS,
          }),
        );
        expect(recovered.exitCode).toBe(DAEMON_UNHEALTHY_EXIT_CODE);
        expect(recovered.message).toContain("is installed and answering");

        // 1. the previous runtime is running and answering, and it is what is registered.
        expect((await askHealth(where.stateDir))?.version).toBe(PREVIOUS_VERSION);
        expect(readDaemonState(where.stateDir).runtime_dir).toBe(previousDir);
        expect(readFileSync(artefact, "utf8")).toContain(previousDir);

        // 2. the newer version's state is intact, byte for byte.
        expect(hashFile(newerRecord)).toBe(newerRecordHash);

        // 3. exactly one process is running out of this machine's directories. The fixture daemon
        //    takes no ownership lock — `owner.lock` is the real `serve`'s, and the real one is
        //    asserted by `scripts/e2e/update.mjs` against a real daemon — so the evidence here is
        //    the process table itself, which is what that lock exists to keep to one holder.
        // 4. no Chrome and no ffmpeg survives, out of the same listing.
        const surviving = await untilProcessesNaming(where.root, 1);
        expect(surviving).toHaveLength(1);
        expect(surviving[0]).toContain(previousDir);
        expect(renderersAmong(surviving)).toEqual([]);

        // 5. the transaction is closed: no journal, no operation lock, nothing to recover.
        expect(existsSync(updateJournalPath(where.stateDir))).toBe(false);
        expect(existsSync(operationLockPath(where.stateDir))).toBe(false);
        expect(readUpdateStatus(where.stateDir).state).toBe("none");

        // 6. and the daemon that came back can render.
        expectRenderReady(where);
      },
      SPAWN_TIMEOUT_MS,
    );
  }

  it(
    "on Windows the task names the old runtime before the switch and the new one after it",
    async () => {
      // The `PT5M` repetition restarts the task with no command — but it starts **whatever the
      // task is currently registered to run**, which is why the automatic-restore claim holds only
      // before the switch. Both halves are read off the registered artefact here, from this
      // machine, exactly as `install.test.ts` drives the rest of the Windows sequence: the XML, the
      // argv and the command order are this process's own work and need no Windows to be asserted.
      // The two steps themselves run on Windows in `daemon-update.yml`'s `windows-latest` leg.
      for (const [boundary, held] of [
        ["drained", "previous"],
        ["switched", "incoming"],
      ] as const) {
        const where = machine();
        const parked = await killUpdaterAt(where, boundary, "win32");
        const artefact = readDaemonState(where.stateDir).supervisor_artefact as string;
        stray.push(artefact);
        const mirror = readFileSync(artefact, "utf8");
        const previousDir = stagedDirectoryFor(where.stateDir, PREVIOUS_VERSION);
        const incomingDir = stagedDirectoryFor(where.stateDir, INCOMING_VERSION);
        expect(mirror).toContain("<Task");
        expect(mirror).toContain("<Interval>PT5M</Interval>");

        if (held === "previous") {
          // `Register-ScheduledTask` had not run, so Task Scheduler still holds the registration it
          // was last given and the repetition starts the **previous** runtime with no command. The
          // XML on disk already names the incoming one, which is exactly why T17's consistency
          // check reads `Get-ScheduledTask` and never this mirror.
          expect(parked).toContain("Register-ScheduledTask");
          expect(parked).toContain("was about to run");
          expect(mirror).toContain(incomingDir);
        } else {
          // It has run: the registration names the incoming runtime, so the repetition starts the
          // one that may not start, and the recovery command is still needed.
          expect(parked).toContain("Start-ScheduledTask");
          expect(parked).toContain("was about to run");
          expect(mirror).toContain(incomingDir);
          expect(mirror).not.toContain(previousDir);
        }

        const status = readUpdateStatus(where.stateDir);
        expect(status.state).toBe("interrupted");
        expect(readUpdateJournal(where.stateDir).journal?.transition).toBe(boundary);
        expect(updateStatusSentences(status).join(" ")).toContain(RECOVER_COMMAND);
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "keeps the journal when the rollback itself will not start, and finishes on a second command",
    async () => {
      // Round 1's third case: the rollback is the thing that must become ready. Neither runtime
      // will start, so the transaction turns around and then cannot land — and the one property
      // that matters is that it leaves the journal exactly where a second command can pick it up.
      const where = machine();
      const harness = harnessFor(where);
      await installed(where, alpha, harness);
      harness.refuseStartOf(stagedRuntimeRoot(where.stateDir));

      const stranded = await refusalFrom(() =>
        updateDaemon({
          stateDir: where.stateDir,
          from: beta.outDir,
          environment: where.environment,
          run: harness.run,
          workspaceRoot: where.workspaceRoot,
          healthTimeoutMs: DOOMED_HEALTH_MS,
        }),
      );
      expect(stranded.exitCode).toBe(DAEMON_UNHEALTHY_EXIT_CODE);
      expect(stranded.message).toContain("did not answer either");
      expect(stranded.recoverable).toBe(true);
      expect(stranded.message).toContain(RECOVER_COMMAND);
      expect(readUpdateJournal(where.stateDir).journal?.transition).toBe("rolling-back");
      expect(await askHealth(where.stateDir)).toBeNull();

      // The second command, with the previous runtime no longer refused: the rollback lands.
      const second = harnessFor(where);
      second.refuseStartOf(incomingSlotPrefix(where.stateDir));
      const rolled = await refusalFrom(() =>
        recoverUpdate({
          stateDir: where.stateDir,
          environment: where.environment,
          run: second.run,
          workspaceRoot: where.workspaceRoot,
          healthTimeoutMs: DOOMED_HEALTH_MS,
        }),
      );
      expect(rolled.message).toContain("is installed and answering");
      expect((await askHealth(where.stateDir))?.version).toBe(PREVIOUS_VERSION);
      expect(existsSync(updateJournalPath(where.stateDir))).toBe(false);
      expect(readUpdateStatus(where.stateDir).state).toBe("none");
      expectRenderReady(where);
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe("daemon update — the precondition is the three-way one (D9's second clause)", () => {
  it(
    "refuses when the workspace already matches B and the rollback target's pins differ",
    async () => {
      // The machine a user is on after running `setup --workspace` from the new runtime: the
      // workspace matches **B**. `setup --workspace` is T18/T19's command, so the state it leaves
      // is written directly here — and it is the state, not the route to it, that this case is
      // about. §1.3d A settles that the route cannot be taken through the installed launcher
      // anyway, because that launcher execs A and would re-resolve A's pins.
      const where = machine({ pins: OTHER_PINS });
      const harness = harnessFor(where);
      await installed(where, alpha, harness);
      const before = readRuntimeState(where.stateDir);

      // This is what makes the case the one the second clause exists for: a check written as
      // "does the workspace satisfy the incoming runtime" **passes** here.
      expect(verifyWorkspacePayload(where.workspaceRoot, OTHER_PINS).ok).toBe(true);
      // And the rollback target is precisely the runtime it no longer satisfies.
      expect(verifyWorkspacePayload(where.workspaceRoot, PINS).ok).toBe(false);

      const refusal = await refusalFrom(() =>
        updateDaemon({
          stateDir: where.stateDir,
          from: gamma.outDir,
          environment: where.environment,
          run: harness.run,
          workspaceRoot: where.workspaceRoot,
        }),
      );

      expect(refusal.exitCode).toBe(PRECONDITION_UNMET_EXIT_CODE);
      expect(refusal.phase).toBe("precondition");
      expect(refusal.message).toContain("remotion: installed 4.0.495, incoming 4.0.500");
      expect(refusal.message).toContain("REINSTALL");
      expect(refusal.message).toContain(`${gamma.interpreter} ${gamma.entry} setup --workspace`);

      // Untouched: nothing staged, nothing drained, the same run still answering, no journal.
      expect(stagedSlots(where.stateDir)).toHaveLength(1);
      expect(readRuntimeState(where.stateDir)?.run_id).toBe(before?.run_id);
      expect((await askHealth(where.stateDir))?.version).toBe(PREVIOUS_VERSION);
      expect(existsSync(updateJournalPath(where.stateDir))).toBe(false);
      expect(existsSync(operationLockPath(where.stateDir))).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );

  /**
   * The other side of the same clause, and the one that made the check refuse **every** machine.
   *
   * `openTransaction()` verifies the live workspace with `verifyWorkspacePayload()`, which used to
   * re-hash the tree in payload 1's exhaustive mode: anything the payload manifest did not describe
   * was a mismatch. A workspace manifest describes `node_modules/`, `package.json` and
   * `package-lock.json` and deliberately nothing else, while `setup` copies three template files in
   * beside them and the user's own renders land in `videos/` and `out/` — so `xplainer daemon
   * update` exited `3` on every machine `xplainer setup` had ever run on, before anything was
   * staged, with no way for a user to get past it. `scripts/e2e/toolchain.mjs` met it first, on a
   * real workspace, and could not reach a single rollback case.
   *
   * The files written here are the exact set a real workspace holds: the three template files
   * `materialiseWorkspace()` copies, the user's video tree, and the cache Remotion's own webpack
   * leaves **inside** `node_modules/` after the first render.
   */
  it(
    "accepts a workspace holding the template files, the user's videos and Remotion's cache",
    async () => {
      const where = machine();
      const harness = harnessFor(where);
      await installed(where, alpha, harness);

      for (const name of ["remotion.config.ts", "tailwind.css", "tsconfig.json"]) {
        writeFileSync(join(where.workspaceRoot, name), "// engine-owned\n");
      }
      mkdirSync(join(where.workspaceRoot, "videos", "demo"), { recursive: true });
      writeFileSync(join(where.workspaceRoot, "videos", "demo", "timings.json"), "{}\n");
      mkdirSync(join(where.workspaceRoot, "out", "demo"), { recursive: true });
      writeFileSync(join(where.workspaceRoot, "out", "demo", "explainer.mp4"), "mp4");
      mkdirSync(join(where.workspaceRoot, "node_modules", ".cache", "webpack"), {
        recursive: true,
      });
      writeFileSync(join(where.workspaceRoot, "node_modules", ".cache", "webpack", "0.pack"), "c");

      const outcome = await updateDaemon({
        stateDir: where.stateDir,
        from: beta.outDir,
        environment: where.environment,
        run: harness.run,
        workspaceRoot: where.workspaceRoot,
        healthTimeoutMs: HEALTH_MS,
      });

      expect(outcome.rolledBack).toBe(false);
      expect(outcome.health.version).toBe("2.0.0-beta");
      expect((await askHealth(where.stateDir))?.version).toBe("2.0.0-beta");
      // The pins were still proved rather than waved through: the precondition prints how many
      // files of the workspace it re-hashed, and every one of them is a manifest entry.
      expect(outcome.steps.join("\n")).toMatch(/[1-9]\d* files re-hashed/);
    },
    SPAWN_TIMEOUT_MS,
  );
});
