/**
 * `daemon install` and `daemon uninstall`, proved against a real daemon and a recorded supervisor.
 *
 * **What is real here, and what is a seam.** The payload is a real payload-1 artefact; the staged
 * directory is a real content-addressed copy of it; the launcher, the unit, the plist and the task
 * XML are the shipped renderers' real bytes on a real disk; and the daemon this install *verifies*
 * is a **real spawned process** that mints a real bearer token and answers a real authenticated
 * `GET /healthz` over loopback. The one seam is `run` — how a supervisor command reaches the
 * outside world — which `preflight.ts` established as a parameter for the reason `state-dir.ts`
 * gives about `platform`: three platforms' orderings have to be checkable from one machine, and a
 * Task Scheduler sequence cannot be run on macOS at all.
 *
 * The seam is not a double for the thing under test. What is under test is `installDaemon`'s
 * **ordering, its recording and its rollback**, and every one of those is asserted against the
 * filesystem, against a live HTTP answer, or against the exact argument vectors the supervisor was
 * handed. {@link supervisorHarness} is a supervisor rather than a stub: `enable-linger` creates the
 * marker, the start command **starts the daemon out of the launch spec the install just recorded**,
 * and the stop command stops it. An install that never wrote a coherent artefact would fail here in
 * the same way it fails on a real machine.
 *
 * The end-to-end case — the real `serve`, out of a `runtime build` payload, under a real
 * `launchctl` or a real `systemctl` — is `install.supervisor.test.ts`, which runs only when it is
 * asked to because it writes to the machine's own service manager.
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readDaemonState } from "../daemon/daemon-state.js";
import {
  ADMIN_REQUIRED_EXIT_CODE,
  DAEMON_UNHEALTHY_EXIT_CODE,
  PRECONDITION_UNMET_EXIT_CODE,
} from "../daemon/exit-codes.js";
import { CHILD_CLI, spawnEntry } from "../daemon/testing/spawn-child.js";
import { InstallRefusal, installDaemon } from "./install.js";
import { launcherPath } from "./launcher.js";
import {
  type InstallPreflight,
  type ProbeCommand,
  type ProbeResult,
  type ProbeRunner,
  preflightInstall,
  preflightWriteLocations,
} from "./preflight.js";
import { stagedRuntimeRoot } from "./stage.js";
import type { SupervisorEnvironment } from "./supervisors/artefact.js";
import { buildFixturePayload } from "./testing/payload.js";
import { writeToolchainMarker } from "./testing/toolchain.js";
import { uninstallDaemon } from "./uninstall.js";

/** The budget for a case that stages a payload and starts a real daemon out of it. */
const SPAWN_TIMEOUT_MS = 60_000;

/** How long an install waits for `/healthz` here. Long enough for a spawn, short enough to fail. */
const HEALTH_MS = 20_000;

/** How long a *deliberate* health failure waits before the install gives up. */
const DOOMED_HEALTH_MS = 750;

let payloadDir = "";
let suiteScratch = "";
const scratch: string[] = [];
const children: ChildProcess[] = [];

beforeAll(() => {
  suiteScratch = realpathSync(mkdtempSync(join(tmpdir(), "xplainer-install-suite-")));
  // One payload for the whole suite: it carries a copy of this process's interpreter, and the
  // second name is what lets a `win32` launch spec point at a file that exists on this machine.
  payloadDir = buildFixturePayload({
    outDir: join(suiteScratch, "payload"),
    version: "1.2.3",
    marker: "installed",
    extraInterpreters: ["node.exe"],
  }).outDir;
}, 120_000);

afterAll(() => {
  rmSync(suiteScratch, { recursive: true, force: true });
});

/** Spawn one `xplainer <argv>` through the sources, and kill it after the test either way. */
function run(entry: string, argv: readonly string[], env: Record<string, string>) {
  const child = spawnEntry(entry, argv, env);
  children.push(child.process);
  return child;
}

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A throwaway directory that is removed after the test. */
function scratchDirectory(prefix = "xplainer-install-"): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(directory);
  return directory;
}

/** A state directory with the setup marker already in it, which is what an install requires. */
function installableState(): string {
  const stateDir = join(scratchDirectory(), "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeToolchainMarker(stateDir);
  return stateDir;
}

/** One command as a single line, which is how the assertions below name a sequence. */
function line(command: ProbeCommand): string {
  return `${command.program} ${command.argv.join(" ")}`;
}

/** What one harness recorded and can be asked to do differently. */
type SupervisorHarness = {
  run: ProbeRunner;
  /** Every command, in order, as `program arg arg`. */
  commands: string[];
  /** Make `enable-linger` report success and create no marker, which is how logind refuses. */
  refuseLinger(): void;
  /** Never start the daemon, so the install's own health check is what fails. */
  refuseStart(): void;
};

/**
 * A supervisor that really does the two things a supervisor does.
 *
 * `enable-linger` creates the marker (which is what makes the install's `existsSync` check mean
 * something), the platform's start command spawns the daemon **from the launch spec the install
 * recorded in `daemon.json`**, and the platform's stop command kills it. Everything else answers
 * `0` and is recorded.
 */
function supervisorHarness(options: {
  stateDir: string;
  lingerMarker?: string;
  printDisabled?: string;
}): SupervisorHarness {
  const commands: string[] = [];
  let lingerRefused = false;
  let startRefused = false;
  let daemon: ChildProcess | null = null;

  const start = (): void => {
    if (startRefused || daemon !== null) {
      return;
    }
    const spec = readDaemonState(options.stateDir).launch_spec;
    if (spec === null) {
      throw new Error("the supervisor was asked to start a daemon before a spec was recorded");
    }
    daemon = spawn(spec.executable, [...spec.argv], {
      cwd: spec.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(daemon);
  };

  const stop = (): void => {
    daemon?.kill("SIGTERM");
    daemon = null;
  };

  const run: ProbeRunner = (command) => {
    commands.push(line(command));
    const spelled = line(command);
    const answer: ProbeResult = { started: true, status: 0, stdout: "", stderr: "" };

    if (command.program === "loginctl" && command.argv.includes("enable-linger")) {
      if (lingerRefused) {
        return {
          started: true,
          status: 1,
          stdout: "",
          stderr: "Could not enable linger: Access denied\n",
        };
      }
      if (options.lingerMarker !== undefined) {
        mkdirSync(join(options.lingerMarker, ".."), { recursive: true });
        writeFileSync(options.lingerMarker, "");
      }
      return answer;
    }
    if (command.program === "loginctl" && command.argv.includes("disable-linger")) {
      if (options.lingerMarker !== undefined) {
        rmSync(options.lingerMarker, { force: true });
      }
      return answer;
    }
    if (command.program === "launchctl" && command.argv[0] === "print-disabled") {
      return { ...answer, stdout: options.printDisabled ?? "\tdisabled services = {\n\t}\n" };
    }
    if (command.program === "systemctl" && command.argv[0] === "--user") {
      if (command.argv.includes("is-system-running")) {
        return { ...answer, stdout: "running\n" };
      }
      if (command.argv.includes("enable")) {
        start();
      }
      if (command.argv.includes("disable")) {
        stop();
      }
      return answer;
    }
    if (command.program === "launchctl" && command.argv[0] === "bootstrap") {
      // `RunAtLoad` is what starts a freshly bootstrapped job, so this is where the process appears.
      start();
      return answer;
    }
    if (command.program === "launchctl" && command.argv[0] === "bootout") {
      stop();
      return answer;
    }
    if (spelled.includes("Start-ScheduledTask")) {
      start();
      return answer;
    }
    if (spelled.includes("Unregister-ScheduledTask")) {
      stop();
      return answer;
    }
    if (spelled.includes("Get-ScheduledTaskInfo")) {
      return { ...answer, stdout: "LastTaskResult    : 267036\nNumberOfMissedRuns : 0\n" };
    }
    return answer;
  };

  return {
    run,
    commands,
    refuseLinger: () => {
      lingerRefused = true;
    },
    refuseStart: () => {
      startRefused = true;
    },
  };
}

/**
 * A POSIX account and directories, built inside a scratch tree so nothing real is touched.
 *
 * `lingerDir` is filled on every platform, not only where the case says `platform: "linux"`. The
 * marker is the one input this suite reads off the **machine** rather than off the fixture, and a
 * Linux host resolves `/var/lib/systemd/linger/$USER` for it under any recording supervisor — so a
 * case that ever ran unqualified would read the runner's own account and exit `5`.
 */
function fixtureEnvironment(root: string): SupervisorEnvironment {
  // Both Linux system directories are filled on every platform, not only where the case says
  // `platform: "linux"`. They are the two inputs this suite would otherwise read off the **host**
  // rather than off the fixture, and a Linux runner answers both: `/var/lib/systemd/linger/$USER`
  // for a marker no recording supervisor ever created, and `/run/systemd/system` for whether
  // systemd is init at all. The linger directory is created by the harness when the install asks
  // for lingering; the booted one has to exist before the probe, so it is made here.
  const lingerDir = join(root, "linger");
  const systemdBooted = join(root, "run-systemd-system");
  mkdirSync(systemdBooted, { recursive: true });
  return { home: join(root, "home"), account: "tester", lingerDir, systemdBooted };
}

/** A Windows account and directories, built inside a scratch tree so nothing real is touched. */
function windowsEnvironment(root: string): SupervisorEnvironment {
  return {
    home: join(root, "Users", "tester"),
    account: "CORP\\tester",
    localAppData: join(root, "Users", "tester", "AppData", "Local"),
    systemRoot: join(root, "Windows"),
    lingerDir: join(root, "linger"),
    systemdBooted: join(root, "run-systemd-system"),
  };
}

/** Every file under `root`, by path, as a SHA-256. */
function hashTree(root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        hashes[path] = "directory";
        walk(path);
      } else {
        hashes[path] = createHash("sha256").update(readFileSync(path)).digest("hex");
      }
    }
  };
  walk(root);
  return hashes;
}

/** Hash every location an install could have written to, absences included. */
function hashLocations(locations: readonly string[]): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const location of locations) {
    if (!existsSync(location)) {
      hashes[location] = "absent";
      continue;
    }
    if (statSync(location).isDirectory()) {
      hashes[location] = "directory";
      Object.assign(hashes, hashTree(location));
      continue;
    }
    hashes[location] = createHash("sha256").update(readFileSync(location)).digest("hex");
  }
  return hashes;
}

/** The locations an install of this shape would write to, from the preflight's own answer. */
async function writeLocations(request: {
  stateDir: string;
  platform: NodeJS.Platform;
  environment: SupervisorEnvironment;
  run: ProbeRunner;
}): Promise<{ preflight: InstallPreflight; locations: readonly string[] }> {
  const preflight = await preflightInstall({
    stateDir: request.stateDir,
    port: 0,
    platform: request.platform,
    environment: request.environment,
    run: request.run,
  });
  return { preflight, locations: preflightWriteLocations(preflight) };
}

describe("daemon install — the refusal writes nothing", () => {
  /**
   * P2-10's obligation, hashed rather than read off a return value. The locations come from the
   * preflight's own answer, so a new place an install can write is a new hashed path here with no
   * edit: the state directory, the artefact, **the directory the artefact lives in** — which on
   * macOS is `~/Library/LaunchAgents` — the linger marker, and the log directory.
   */
  it("refuses 3 with no setup marker, and every hashed location is unchanged", async () => {
    const root = scratchDirectory();
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const environment: SupervisorEnvironment = fixtureEnvironment(root);
    mkdirSync(join(environment.home, "Library", "LaunchAgents"), { recursive: true });
    mkdirSync(join(environment.home, "Library", "Logs", "xplainer"), { recursive: true });
    const harness = supervisorHarness({ stateDir });
    const { locations } = await writeLocations({
      stateDir,
      platform: "darwin",
      environment,
      run: harness.run,
    });
    expect(locations).toContain(join(environment.home, "Library", "LaunchAgents"));
    expect(locations).toContain(join(environment.home, "Library", "Logs", "xplainer"));
    const before = hashLocations(locations);

    const refusal = await installDaemon({
      stateDir,
      payloadDir,
      port: 0,
      platform: "darwin",
      environment,
      run: harness.run,
      uid: 501,
    }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(InstallRefusal);
    expect((refusal as InstallRefusal).exitCode).toBe(PRECONDITION_UNMET_EXIT_CODE);
    expect((refusal as InstallRefusal).phase).toBe("preflight");
    expect((refusal as InstallRefusal).message).toContain("xplainer setup");
    expect((refusal as InstallRefusal).undone).toEqual([]);
    expect(hashLocations(locations)).toEqual(before);
    // Not a single supervisor command ran: the refusal is a decision, not an attempt.
    expect(harness.commands.filter((entry) => !entry.includes("print-disabled"))).toEqual([]);
  });

  /**
   * The Windows half of the same obligation, and the one location no renderer produces: the task
   * store. `Register-ScheduledTask` writes there, not this process, so a check that hashed only the
   * XML under `%LOCALAPPDATA%` would miss a task that got registered anyway.
   */
  it("hashes the Windows task store as well as the XML this process would write", async () => {
    const root = scratchDirectory();
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const environment = windowsEnvironment(root);
    const harness = supervisorHarness({ stateDir });

    const { locations } = await writeLocations({
      stateDir,
      platform: "win32",
      environment,
      run: harness.run,
    });

    // `win32.join`, because that is what the renderers use: a Windows path is separated by
    // backslashes even when the test that composes it is running on macOS.
    expect(locations).toContain(win32.join(root, "Windows", "System32", "Tasks", "xplainer"));
    expect(locations).toContain(
      win32.join(environment.localAppData ?? "", "xplainer", "service", "xplainer-daemon.xml"),
    );
  });
});

describe("daemon install — Linux", () => {
  /**
   * The order T11 fixes, read off the commands the supervisor was actually handed: lingering
   * **first**, because it is the step that can be refused, and only then `daemon-reload` and
   * `enable --now`. The install ends in a real `200` from a real process.
   */
  it(
    "enables lingering before it registers, and verifies with an authenticated GET /healthz",
    async () => {
      const root = scratchDirectory();
      const stateDir = installableState();
      const environment = fixtureEnvironment(root);
      const lingerDir = String(environment.lingerDir);
      mkdirSync(lingerDir, { recursive: true });
      const harness = supervisorHarness({ stateDir, lingerMarker: join(lingerDir, "tester") });

      const outcome = await installDaemon({
        stateDir,
        payloadDir,
        port: 0,
        platform: "linux",
        environment,
        run: harness.run,
        healthTimeoutMs: HEALTH_MS,
      });

      expect(harness.commands.filter((entry) => !entry.includes("is-system-running"))).toEqual([
        "loginctl --no-ask-password enable-linger tester",
        "systemctl --user daemon-reload",
        "systemctl --user enable --now xplainer.service",
      ]);
      expect(existsSync(join(lingerDir, "tester"))).toBe(true);
      expect(outcome.linger).toMatchObject({ applicable: true, enabledByUs: true });
      expect(outcome.health.version).toBe("installed");
      expect(outcome.health.port).toBeGreaterThan(0);
      // The unit is on disk where systemd looks, and it names the staged runtime.
      const unit = join(environment.home, ".config", "systemd", "user", "xplainer.service");
      expect(readFileSync(unit, "utf8")).toContain(outcome.runtimeDir);
      // And the record says what an uninstall needs and cannot re-derive.
      expect(readDaemonState(stateDir)).toMatchObject({
        supervisor_kind: "systemd",
        supervisor_artefact: unit,
        runtime_dir: outcome.runtimeDir,
        linger_enabled_by_us: true,
        program_source: "runtime-dir",
        log_sink: "journald",
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  /**
   * The refusal that is the whole reason lingering goes first: `loginctl` answers, the marker does
   * not appear, and the install exits `5` with nothing staged and nothing registered. The check is
   * the **marker**, not `loginctl`'s status, because `loginctl` is a client of `logind`.
   */
  it("exits 5 when lingering is denied, with nothing staged and nothing registered", async () => {
    const root = scratchDirectory();
    const stateDir = installableState();
    const environment = fixtureEnvironment(root);
    const lingerDir = String(environment.lingerDir);
    mkdirSync(lingerDir, { recursive: true });
    const harness = supervisorHarness({ stateDir, lingerMarker: join(lingerDir, "tester") });
    harness.refuseLinger();

    const refusal = await installDaemon({
      stateDir,
      payloadDir,
      port: 0,
      platform: "linux",
      environment,
      run: harness.run,
      healthTimeoutMs: DOOMED_HEALTH_MS,
    }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(InstallRefusal);
    expect((refusal as InstallRefusal).exitCode).toBe(ADMIN_REQUIRED_EXIT_CODE);
    expect((refusal as InstallRefusal).phase).toBe("linger");
    expect((refusal as InstallRefusal).message).toContain("sudo loginctl enable-linger tester");
    expect(harness.commands.filter((entry) => !entry.includes("is-system-running"))).toEqual([
      "loginctl --no-ask-password enable-linger tester",
    ]);
    expect(existsSync(stagedRuntimeRoot(stateDir))).toBe(false);
    expect(existsSync(join(environment.home, ".config"))).toBe(false);
  });

  /**
   * The rollback, at the last step that can fail: everything is written, the supervisor accepts the
   * registration, and no daemon answers. Exit `4`, and the machine goes back to what it was —
   * **including the linger marker**, which is the one case the plan lets an uninstall's rule be
   * broken, because there the marker is seconds old and nothing has had time to depend on it.
   */
  it(
    "rolls back everything, the linger marker included, when the daemon never answers",
    async () => {
      const root = scratchDirectory();
      const stateDir = installableState();
      const environment = fixtureEnvironment(root);
      const lingerDir = String(environment.lingerDir);
      mkdirSync(lingerDir, { recursive: true });
      const harness = supervisorHarness({ stateDir, lingerMarker: join(lingerDir, "tester") });
      harness.refuseStart();
      const { locations } = await writeLocations({
        stateDir,
        platform: "linux",
        environment,
        run: harness.run,
      });
      const before = hashLocations(locations);

      const refusal = (await installDaemon({
        stateDir,
        payloadDir,
        port: 0,
        platform: "linux",
        environment,
        run: harness.run,
        healthTimeoutMs: DOOMED_HEALTH_MS,
      }).catch((error: unknown) => error)) as InstallRefusal;

      expect(refusal).toBeInstanceOf(InstallRefusal);
      expect(refusal.exitCode).toBe(DAEMON_UNHEALTHY_EXIT_CODE);
      expect(refusal.phase).toBe("verify");
      expect(refusal.undone.join("\n")).toContain("deregistered xplainer.service");
      expect(harness.commands).toContain("systemctl --user disable --now xplainer.service");
      expect(existsSync(join(lingerDir, "tester"))).toBe(false);
      expect(
        existsSync(join(environment.home, ".config", "systemd", "user", "xplainer.service")),
      ).toBe(false);
      expect(existsSync(launcherPath(stateDir, "linux"))).toBe(false);
      // The empty directories the install's own `mkdir -p` invented are gone too: `<state>/bin`,
      // `<state>/runtime` and — the one that is the user's tree and not ours — `~/.config`.
      expect(existsSync(stagedRuntimeRoot(stateDir))).toBe(false);
      expect(existsSync(join(environment.home, ".config"))).toBe(false);
      expect(hashLocations(locations)).toEqual(before);
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe("daemon install — macOS", () => {
  /**
   * `enable` before `bootstrap`, which is the correction round 1 of the plan needed: `man launchctl`
   * says a disabled service "cannot be loaded in the specified domain until it is once again
   * enabled". `bootout` comes first because `bootstrap` does not refresh an already-loaded
   * definition, and `kickstart` last.
   */
  it(
    "enables the label before it bootstraps the plist, boots out first, and kickstarts last",
    async () => {
      const root = scratchDirectory();
      const stateDir = installableState();
      const environment: SupervisorEnvironment = fixtureEnvironment(root);
      const harness = supervisorHarness({ stateDir });

      const outcome = await installDaemon({
        stateDir,
        payloadDir,
        port: 0,
        platform: "darwin",
        environment,
        run: harness.run,
        uid: 501,
        healthTimeoutMs: HEALTH_MS,
      });

      const plist = join(
        environment.home,
        "Library",
        "LaunchAgents",
        "video.xplainer.daemon.plist",
      );
      expect(harness.commands.filter((entry) => !entry.includes("print-disabled"))).toEqual([
        "launchctl bootout gui/501/video.xplainer.daemon",
        "launchctl enable gui/501/video.xplainer.daemon",
        `launchctl bootstrap gui/501 ${plist}`,
        "launchctl kickstart gui/501/video.xplainer.daemon",
      ]);
      expect(outcome.artefact).toBe(plist);
      expect(statSync(plist).mode & 0o777).toBe(0o600);
      expect(readFileSync(plist, "utf8")).toContain(outcome.runtimeDir);
      expect(outcome.linger.applicable).toBe(false);
      expect(readDaemonState(stateDir)).toMatchObject({
        supervisor_kind: "launchd",
        linger_enabled_by_us: null,
        launchd_enable_record_created: true,
        log_sink: join(environment.home, "Library", "Logs", "xplainer", "daemon.log"),
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  /** A re-install over a loaded job is the ordinary case, and it has to leave one install behind. */
  it(
    "re-installs over itself: the launcher and the plist keep their paths and the daemon answers",
    async () => {
      const root = scratchDirectory();
      const stateDir = installableState();
      const environment: SupervisorEnvironment = fixtureEnvironment(root);
      const harness = supervisorHarness({ stateDir });
      const options = {
        stateDir,
        payloadDir,
        port: 0,
        platform: "darwin" as const,
        environment,
        run: harness.run,
        uid: 501,
        healthTimeoutMs: HEALTH_MS,
      };

      const first = await installDaemon(options);
      // The daemon the first install started is still up; the second one boots it out and starts it
      // again, which is exactly what a supervisor does with a replaced definition.
      const second = await installDaemon(options);

      expect(second.artefact).toBe(first.artefact);
      expect(second.launcher).toBe(first.launcher);
      expect(second.runtimeDir).toBe(first.runtimeDir);
      expect(second.reusedRuntime).toBe(true);
      expect(readdirSync(stagedRuntimeRoot(stateDir))).toHaveLength(1);
      expect(second.health.version).toBe("installed");
      // The second install's own bootout is in the transcript, before its enable.
      const bootouts = harness.commands.filter((entry) => entry.includes("bootout"));
      expect(bootouts).toHaveLength(2);
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe("daemon install — Windows", () => {
  /**
   * Criterion 6, end to end: register from the XML with `-Force`, start, poll, and on failure read
   * `LastTaskResult`, name the missing right as a **candidate**, unregister and exit `5`. The plan
   * is explicit that a health timeout does not uniquely diagnose a missing right, so the message is
   * checked for the candidate wording rather than for a diagnosis.
   */
  it(
    "registers with -Force, and on a health failure reads LastTaskResult, unregisters and exits 5",
    async () => {
      const root = scratchDirectory();
      const stateDir = installableState();
      const environment = windowsEnvironment(root);
      const harness = supervisorHarness({ stateDir });
      harness.refuseStart();
      const { locations } = await writeLocations({
        stateDir,
        platform: "win32",
        environment,
        run: harness.run,
      });
      const before = hashLocations(locations);

      const refusal = (await installDaemon({
        stateDir,
        payloadDir,
        port: 0,
        platform: "win32",
        environment,
        run: harness.run,
        healthTimeoutMs: DOOMED_HEALTH_MS,
      }).catch((error: unknown) => error)) as InstallRefusal;

      expect(refusal).toBeInstanceOf(InstallRefusal);
      expect(refusal.exitCode).toBe(ADMIN_REQUIRED_EXIT_CODE);
      expect(refusal.phase).toBe("verify");
      expect(refusal.message).toContain("0x0004131C");
      expect(refusal.message).toContain("SCHED_S_BATCH_LOGON_PROBLEM");
      expect(refusal.message).toContain("candidate and not a diagnosis");
      expect(refusal.message).toContain("267036");
      const scripts = harness.commands.filter((entry) => entry.startsWith("powershell.exe"));
      expect(scripts[0]).toContain("Register-ScheduledTask -Xml (Get-Content -Path ");
      // The document is UTF-8 on disk and declares `UTF-16`, because what Task Scheduler parses is
      // the string PowerShell decoded; the read has to say which encoding the bytes are in.
      expect(scripts[0]).toContain("-Raw -Encoding UTF8)");
      // `Register-` alone takes the task's **path** in `-TaskName`, because it is creating the
      // name; every cmdlet after it is a CIM query whose `TaskName` is the leaf, and a full path
      // there matches nothing quietly (`install/register.ts`'s `scheduledTaskSelector`).
      expect(scripts[0]).toContain("-TaskName '\\xplainer\\tester-daemon' -Force");
      const selector = "-TaskPath '\\xplainer\\' -TaskName 'tester-daemon'";
      expect(scripts[1]).toContain(`Start-ScheduledTask ${selector}`);
      expect(scripts[2]).toContain(`Get-ScheduledTaskInfo ${selector}`);
      // Two steps, not one: `Unregister-ScheduledTask` takes the registration away and leaves a
      // running instance running, so a rollback that only unregistered would leave the daemon it
      // started holding the state directory it is about to remove (`install/register.ts`).
      expect(scripts[3]).toContain(`Stop-ScheduledTask ${selector}`);
      expect(scripts[4]).toContain(`Unregister-ScheduledTask ${selector}`);
      // Rolled back: the XML this process wrote is gone again, and so is everything else — the
      // hashed set here is the Windows one, task store included.
      expect(
        existsSync(
          win32.join(environment.localAppData ?? "", "xplainer", "service", "xplainer-daemon.xml"),
        ),
      ).toBe(false);
      expect(hashLocations(locations)).toEqual(before);
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe("install → uninstall → install", () => {
  /**
   * The round trip T11's verification section asks for. `daemon status --json` is `commands/`'s and
   * is asserted there; what this case needs from the middle step is that the installed daemon is
   * **reachable on the recorded port with the recorded token**, which is the fact that report is
   * built from — so it is asked directly, over HTTP, before anything is removed.
   */
  it(
    "removes the artefact, the state files, the launcher and the token — and re-installs first time",
    async () => {
      const root = scratchDirectory();
      const stateDir = installableState();
      const environment: SupervisorEnvironment = fixtureEnvironment(root);
      const harness = supervisorHarness({
        stateDir,
        printDisabled: '\tdisabled services = {\n\t\t"video.xplainer.daemon" => enabled\n\t}\n',
      });
      const options = {
        stateDir,
        payloadDir,
        port: 0,
        platform: "darwin" as const,
        environment,
        run: harness.run,
        uid: 501,
        healthTimeoutMs: HEALTH_MS,
      };

      const installed = await installDaemon(options);

      // The middle step the criterion names, run as a real `xplainer status --json` child against
      // the state directory the install just wrote. It is the report a consumer reads, and it is
      // built from an authenticated probe of its own — so a `ready` here is the daemon answering,
      // not this test reading back what it wrote.
      const status = run(CHILD_CLI, ["status", "--json"], { XPLAINER_STATE_DIR: stateDir });
      expect((await status.waitForExit()).code).toBe(0);
      expect(JSON.parse(status.stdout())).toMatchObject({
        condition: "ready",
        exit_code: 0,
        state_dir: stateDir,
        probe: { port: installed.health.port, http_status: 200 },
        daemon: {
          supervisor_kind: "launchd",
          supervisor_artefact: installed.artefact,
          runtime_dir: installed.runtimeDir,
          token_file: installed.health.tokenFile,
        },
      });

      // And the same fact asked directly, so "ready" is not the only thing standing for it.
      const token = readFileSync(installed.health.tokenFile, "utf8").trim();
      const health = await fetch(installed.health.url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: "ok" });
      expect(
        (await fetch(installed.health.url)).status,
        "an unauthenticated probe must not pass for a health check",
      ).toBe(401);

      const removed = uninstallDaemon({
        stateDir,
        platform: "darwin",
        environment,
        run: harness.run,
        uid: 501,
      });

      expect(removed.wasInstalled).toBe(true);
      expect(existsSync(installed.artefact)).toBe(false);
      expect(existsSync(installed.launcher)).toBe(false);
      expect(existsSync(join(stateDir, "runtime.json"))).toBe(false);
      expect(existsSync(join(stateDir, "daemon.json"))).toBe(false);
      expect(existsSync(join(stateDir, "owner.lock"))).toBe(false);
      expect(existsSync(stagedRuntimeRoot(stateDir))).toBe(false);
      expect(existsSync(installed.health.tokenFile)).toBe(false);
      expect(removed.token).toEqual({ path: installed.health.tokenFile, deleted: true });
      // The setup marker is not an install artefact, and a re-install needs it.
      expect(existsSync(join(stateDir, "toolchain.json"))).toBe(true);

      const again = await installDaemon(options);

      expect(again.health.version).toBe("installed");
      expect(again.artefact).toBe(installed.artefact);
      expect(again.launcher).toBe(installed.launcher);
      expect(again.reusedRuntime).toBe(false);
      expect(existsSync(again.health.tokenFile)).toBe(true);
    },
    SPAWN_TIMEOUT_MS,
  );
});
