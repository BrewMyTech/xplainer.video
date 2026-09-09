/**
 * A supervisor that really starts and stops the daemon, and records what the journal said when.
 *
 * `install.test.ts` established the shape and the reason: `run` — how a supervisor command reaches
 * the outside world — is the one seam, because three platforms' command sequences have to be
 * checkable from one machine and a Task Scheduler sequence cannot be run on macOS at all. Everything
 * else is real: a real payload, a real staged copy, real artefact bytes on a real disk, and a real
 * spawned daemon that mints a real bearer token and answers a real authenticated `GET /healthz`.
 *
 * This harness adds the one thing an update needs that an install did not: **at every supervisor
 * command it records what `<state>/update.json` said at that moment**. That turns "the durable
 * record's transitions" from something a test would have to infer into a sequence it can assert —
 * the switch commands must see `drained`, the start command must see `switched` — which is the
 * evidence that each boundary was made durable *before* the step it licenses ran, rather than
 * written at the end from memory.
 *
 * It lives beside the suite rather than inside it because two processes need it: the test, and the
 * child entry that parks a half-finished transaction so it can be killed
 * ({@link file://./interrupt-update.ts}). A second copy of "what does `launchctl bootstrap` do" in
 * the child would be a second opinion about the platform.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { readDaemonState, readRuntimeState } from "../../../daemon/daemon-state.js";
import { isAlive } from "../../../daemon/worker-identity.js";
import { type ProbeResult, type ProbeRunner, spell } from "../../preflight.js";
import type { SupervisorEnvironment } from "../../supervisors/artefact.js";
import { readUpdateJournal, type UpdateTransition } from "../journal.js";

/** Where this harness sends the daemon's own output, in the state directory it was given. */
export const HARNESS_LOG_FILE = "supervisor-daemon.log";

/**
 * The line the parked updater prints before it stops existing.
 *
 * It lives here rather than in `interrupt-update.ts` because that module *is* a child entry: it
 * installs a daemon and starts an update the moment it is loaded, so a suite that imported a
 * constant from it would run an install inside the Vitest worker.
 */
export const PARKED_LINE = "parked at";

/** One supervisor command, and the journal's transition at the moment it was run. */
export type HarnessCall = {
  /** `program arg arg`, exactly as it was run. */
  command: string;
  /** The transition `<state>/update.json` recorded then, or `null` when there was no journal. */
  transition: UpdateTransition | null;
};

/** What one harness recorded and can be asked to do differently. */
export type UpdateHarness = {
  run: ProbeRunner;
  /** Every command, in order, with the journal's state at the time. */
  calls: HarnessCall[];
  /** Every command, in order, as `program arg arg`. */
  commands(): string[];
  /** Refuse to start a launch spec whose executable names this runtime directory. */
  refuseStartOf(runtimeDir: string): void;
  /** Stop whatever it started, for a suite's `afterEach`. */
  stopAll(): void;
};

/** What {@link updateHarness} needs. */
export type UpdateHarnessOptions = {
  /** The state directory whose `daemon.json` names the spec to start. */
  stateDir: string;
  /** Where `loginctl enable-linger` should create its marker, for the Linux ordering. */
  lingerMarker?: string | undefined;
  /** Told about every daemon this harness spawns, so a suite can kill it. */
  onSpawn?: ((child: ChildProcess) => void) | undefined;
};

/**
 * The account and directories a fixture install renders its artefact paths from.
 *
 * A scratch `home` rather than this account's, for the reason `supervisor-proof.ts` gives about its
 * throwaway label: a test must not put a plist in a real user's `~/Library/LaunchAgents` or a unit
 * in their `~/.config/systemd/user`. Every field is filled so the same object drives all three
 * platforms' renderers.
 */
export function fixtureEnvironment(home: string): SupervisorEnvironment {
  // The two Linux system directories are part of the fixture on every platform. They are what a
  // Linux host would otherwise answer from itself: `/var/lib/systemd/linger/$USER`, a marker no
  // recording supervisor ever creates, and `/run/systemd/system`, which is absent in a plain
  // container and makes the preflight refuse before any of this suite's subject matter is reached.
  // The booted directory has to exist for the systemd branch to be reachable, so it is made here;
  // the linger marker is created by this module's own `enable-linger`, which is the ordering
  // `install.ts` asserts.
  const systemdBooted = join(home, "run-systemd-system");
  mkdirSync(systemdBooted, { recursive: true });
  return {
    home,
    account: "tester",
    configHome: join(home, ".config"),
    localAppData: join(home, "AppData", "Local"),
    systemRoot: join(home, "Windows"),
    lingerDir: join(home, "linger"),
    systemdBooted,
  };
}

/**
 * The marker `loginctl enable-linger` would create for an environment, spelled once.
 *
 * The suite needs the same string the preflight will compose — `<lingerDir>/<account>` — because
 * the harness has to *create* it when the install asks for lingering and `install.ts` then checks
 * that the file is there. Two spellings of one path would let the harness satisfy a check nobody
 * was making.
 */
export function fixtureLingerMarker(environment: SupervisorEnvironment): string {
  return `${environment.lingerDir ?? ""}/${environment.account}`;
}

/**
 * A Windows account and its directories, inside a scratch tree so nothing real is touched.
 *
 * The `win32` renderers build every artefact path from these four fields, so a case that drives the
 * Task Scheduler sequence from another machine needs one — and needs the *same* one in the suite
 * and in the child entry that parks a `win32` transaction, or the two would name two tasks.
 */
export function windowsFixtureEnvironment(root: string): SupervisorEnvironment {
  return {
    home: join(root, "Users", "tester"),
    account: "CORP\\tester",
    configHome: join(root, "Users", "tester", ".config"),
    localAppData: join(root, "Users", "tester", "AppData", "Local"),
    systemRoot: join(root, "Windows"),
    lingerDir: join(root, "linger"),
    systemdBooted: join(root, "run-systemd-system"),
  };
}

/**
 * A supervisor that does the two things a supervisor does, and records the journal as it goes.
 *
 * The start reads **`daemon.json`'s launch spec**, which is what makes a switch observable: after
 * the artefact has been rewritten the record names the incoming runtime, so the process this
 * harness spawns is the incoming daemon and the `/healthz` the transaction waits on is that
 * process's own answer. A harness that spawned a path the test had composed would prove nothing
 * about the switch.
 */
export function updateHarness(options: UpdateHarnessOptions): UpdateHarness {
  const calls: HarnessCall[] = [];
  let child: ChildProcess | null = null;
  let refuseFor: string | null = null;

  const start = (): void => {
    if (child !== null) {
      return;
    }
    const spec = readDaemonState(options.stateDir).launch_spec;
    if (spec === null) {
      throw new Error("the supervisor was asked to start a daemon before a spec was recorded");
    }
    if (refuseFor !== null && spec.executable.startsWith(refuseFor)) {
      return;
    }
    // **A log sink, not a pipe held by whoever asked for the start.** Every real supervisor writes
    // the daemon's output to a file it owns — `StandardErrorPath`, the journal, the task's log —
    // and none of them hands the daemon a pipe whose reader is the process that called `start`.
    // That difference is load-bearing at the `staged` boundary: the updater is killed there and the
    // daemon it had not yet drained must go on serving, which it cannot do while its own stderr
    // drains into a dead parent. It is also the fix for a pipe nobody reads, which is a daemon that
    // eventually blocks on writing to it. `log_sink` is a recorded field for the same reason.
    const sink = join(options.stateDir, HARNESS_LOG_FILE);
    const fd = openSync(sink, "a", 0o600);
    const spawned = spawn(spec.executable, [...spec.argv], {
      cwd: spec.cwd,
      stdio: ["ignore", fd, fd],
      // **`detached` because a supervisor's child outlives the process that asked for the start,
      // and on Windows that is not the default.** libuv puts every non-detached child into a single
      // Job Object whose handle the parent holds, with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`: when
      // the parent goes, the handle closes, the job closes, and every child in it is killed.
      // `UV_PROCESS_DETACHED` is what adds `CREATE_BREAKAWAY_FROM_JOB`.
      //
      // That is the whole of the `staged` boundary. The updater is killed there **before** it has
      // drained, so the daemon it was about to drain has to still be running and still answering —
      // and on `windows-latest` it was neither: `runtime.json` named a pid that was gone and
      // `/healthz` answered nothing (runs 34304152961 and 34307691608, and 2026-09-08 before
      // them). On POSIX the same child is simply reparented, which is why the other two platforms
      // never saw it. `stop()` signals the recorded pid, so a new process group changes nothing
      // about how this harness ends a daemon.
      detached: true,
    });
    child = spawned;
    spawned.once("exit", () => {
      closeSync(fd);
      if (child === spawned) {
        child = null;
      }
    });
    options.onSpawn?.(spawned);
  };

  /**
   * Stop the daemon **this state directory records**, whoever started it.
   *
   * A supervisor's stop is not addressed to a process this harness happens to hold a handle for:
   * `systemctl --user stop` and `launchctl kill` end the job the manager started, and the manager
   * outlives every updater. T16 makes that difference load-bearing. An updater killed at the
   * `staged` boundary leaves the daemon it had not yet drained **running and orphaned**, and the
   * recovery that follows runs in another process — so a stop that could only signal `child` would
   * find nothing to signal, `stopDaemon()` would wait for a daemon that never stops answering, and
   * the case would fail for a reason that has nothing to do with the transaction. The recorded pid
   * is signalled as well, which is what the real supervisor would have done.
   */
  const stop = (signal: NodeJS.Signals = "SIGTERM"): void => {
    child?.kill(signal);
    child = null;
    const recorded = readRuntimeState(options.stateDir)?.pid;
    if (typeof recorded !== "number" || !isAlive(recorded)) {
      return;
    }
    try {
      process.kill(recorded, signal);
    } catch {
      // It exited between the liveness check and the signal, which is the outcome asked for.
    }
  };

  const run: ProbeRunner = (command) => {
    const spelled = spell(command);
    const read = readUpdateJournal(options.stateDir);
    calls.push({ command: spelled, transition: read.journal?.transition ?? null });
    const answer: ProbeResult = { started: true, status: 0, stdout: "", stderr: "" };

    if (command.program === "loginctl" && command.argv.includes("enable-linger")) {
      if (options.lingerMarker !== undefined) {
        mkdirSync(dirname(options.lingerMarker), { recursive: true });
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
      return { ...answer, stdout: "\tdisabled services = {\n\t}\n" };
    }
    if (command.program === "systemctl" && command.argv[0] === "--user") {
      if (command.argv.includes("is-system-running")) {
        return { ...answer, stdout: "running\n" };
      }
      if (command.argv.includes("enable") || command.argv[1] === "start") {
        start();
      }
      if (command.argv.includes("disable") || command.argv[1] === "stop") {
        stop();
      }
      return answer;
    }
    if (command.program === "launchctl") {
      // `RunAtLoad` is what starts a freshly bootstrapped job, so `bootstrap` is where the process
      // appears — which is also why the switch boots the job out first.
      if (command.argv[0] === "bootstrap" || command.argv[0] === "kickstart") {
        start();
      }
      if (command.argv[0] === "bootout" || command.argv[0] === "kill") {
        stop();
      }
      return answer;
    }
    if (spelled.includes("Register-ScheduledTask") || spelled.includes("Start-ScheduledTask")) {
      start();
      return answer;
    }
    if (spelled.includes("Stop-ScheduledTask") || spelled.includes("Unregister-ScheduledTask")) {
      stop();
      return answer;
    }
    if (spelled.includes("Get-ScheduledTaskInfo")) {
      return { ...answer, stdout: "LastTaskResult    : 267011\nNumberOfMissedRuns : 0\n" };
    }
    return answer;
  };

  return {
    run,
    calls,
    commands: () => calls.map((call) => call.command),
    refuseStartOf: (runtimeDir: string) => {
      refuseFor = runtimeDir;
    },
    stopAll: () => {
      stop("SIGKILL");
    },
  };
}
