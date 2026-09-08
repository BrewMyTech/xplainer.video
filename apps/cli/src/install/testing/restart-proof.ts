/**
 * The three restart adapters, against the **real** drain route and a **real** service manager.
 *
 * Spike `apps/cli/spikes/p2-s5-drain.mjs` measured the supervisors two batches ago and had to carry
 * its own listener to do it: `POST /api/daemon/drain` did not exist yet, so the route it asked for
 * was a fixture that slept, killed a child and exited `0`. ADR 0024's note of 2026-09-08 says what
 * closes that gap — "**T13 proves these same three adapters against the real route**" — and this is
 * that proof. Everything under the supervisor here is the shipped daemon: the real `serve`, the
 * real six-step drain, the real socket, the real bearer token, the real job store with a job
 * running in it.
 *
 * It is a proof rather than a test — a script that exits `0` only when every expectation held, and
 * prints the transcript that is the evidence. It is **not** part of `pnpm verify`, because it talks
 * to the machine's own service manager.
 *
 * ```sh
 * # macOS, on this machine, under a throwaway label removed in a `finally`:
 * node --import apps/cli/src/daemon/testing/ts-source-hook.ts \
 *   apps/cli/src/install/testing/restart-proof.ts
 *
 * # Linux, inside the systemd container, as root, which re-enters as the unprivileged user:
 * docker build -f infra/e2e/Dockerfile.systemd -t xplainer-p2s4-systemd "$(mktemp -d)"
 * docker run -d --name xplainer-t13 --privileged --cgroupns=host \
 *   -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
 *   -v "$PWD:/repo:ro" xplainer-p2s4-systemd
 * docker exec xplainer-t13 node --import /repo/apps/cli/src/daemon/testing/ts-source-hook.ts \
 *   /repo/apps/cli/src/install/testing/restart-proof.ts
 *
 * # ubuntu-latest and windows-latest, where the account the job runs as is the account:
 * node --import apps/cli/src/daemon/testing/ts-source-hook.ts \
 *   apps/cli/src/install/testing/restart-proof.ts --here
 * ```
 *
 * ## What each platform is asked, and why these three questions
 *
 * 1. **The supervisor's own restart, during a job.** `systemctl --user restart`,
 *    `launchctl kickstart -k` and — on Windows, where there is no such thing — `Stop-ScheduledTask`
 *    followed by `Start-ScheduledTask`. What has to be true is that the daemon's *drain* ran inside
 *    it: the job that was running ends as `error` with `error_code: "daemon_shutdown"`, which is a
 *    record only the six steps write, and the daemon is answering again afterwards.
 * 2. **The real route, and what the supervisor does with the exit `0` it produces.** `POST
 *    /api/daemon/drain` over the socket, then the daemon is watched going away and **not coming
 *    back**: `Restart=on-failure`, `KeepAlive{SuccessfulExit:false}` and a task that has ended are
 *    the three ways of declining to restart a clean exit, and a proof that skipped this would be
 *    describing a supervisor that never restarts anything.
 * 3. **The shipped `xplainer daemon restart`.** The same route, the latches cleared first, and the
 *    adapter's own start command — end to end, against the real manager.
 *
 * ## What is a stand-in here, and what is not
 *
 * **The label, the unit name and the task name are throwaways**, removed in a `finally`. On macOS
 * that is not a preference: `launchctl` has no verb that removes an entry from the disable store,
 * so a proof that used the product's label would leave a permanent record in a real user's
 * launchd. The artefact around the name is the **shipped renderer's** output, byte for byte, so
 * `KillMode=mixed`, `TimeoutStopSec=45s`, `ExitTimeOut=45` and `KeepAlive` are the values that ship.
 *
 * **The program is this package's own sources rather than a staged payload.** `install.test.ts` and
 * `lifecycle-proof.ts` prove the payload half against a fixture whose miniature daemon deliberately
 * has no drain route; what is under test *here* is the drain, so the launch contract names this
 * interpreter and `daemon/testing/child-serve-job.ts` — the real `serve` with one long job already
 * running when it announces readiness. A generated shim carries that job's configuration, because a
 * supervisor artefact has no per-run environment to put it in.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { awaitStopped, requestDrain } from "../../daemon/control.js";
import { readDaemonState, readRuntimeState, updateDaemonState } from "../../daemon/daemon-state.js";
import { resolveIpcPath } from "../../daemon/ipc.js";
import { createJobStore } from "../../daemon/job-store.js";
import { isAlive } from "../../daemon/worker-identity.js";
import type { LaunchSpec } from "../../runtime/launch-spec.js";
import { SETTING_FLAGS } from "../../runtime/launch-spec.js";
import { DRAIN_PATH } from "../../server.js";
import { restartDaemon } from "../lifecycle.js";
import { currentSupervisorEnvironment, type ProbeCommand, runProbe } from "../preflight.js";
import {
  deregisterCommands,
  guiService,
  type RegistrationTarget,
  registerCommands,
} from "../register.js";
import type { SupervisorEnvironment } from "../supervisors/artefact.js";
import { renderLaunchAgentPlist } from "../supervisors/launchd.js";
import { renderScheduledTask } from "../supervisors/schtasks.js";
import { renderSystemdUnit } from "../supervisors/systemd.js";

/** The launchd label this proof registers under. Never the product's, and booted out in a `finally`. */
export const THROWAWAY_LABEL = "video.xplainer.t13-proof";

/** The systemd unit and the scheduled task, named the same way and for the same reason. */
export const THROWAWAY_UNIT = "xplainer-t13-proof.service";
export const THROWAWAY_TASK = "\\xplainer\\t13-proof";

/** The account and uid the container's unprivileged half runs as, matching `lifecycle-proof.ts`. */
const LINUX_USER = "xplainer";
const LINUX_UID = 1000;

/** This file, which a child is re-entered through. */
const SELF = fileURLToPath(import.meta.url);

/**
 * The source hook a child is started under, as a **file URL**.
 *
 * `--import` takes a module specifier, and an absolute Windows path is one with the scheme `c:` —
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME`, measured on `windows-latest` on 2026-09-08. `new URL(…,
 * import.meta.url).href` is a `file:` URL on every platform, so this is one spelling rather than a
 * Windows branch. {@link SELF} stays a path: an entry file is resolved, not parsed as a specifier.
 */
const HOOK = new URL("../../daemon/testing/ts-source-hook.ts", import.meta.url).href;
const CHILD_SERVE_JOB = fileURLToPath(
  new URL("../../daemon/testing/child-serve-job.ts", import.meta.url),
);

/**
 * How long the job the daemon is holding stays alive.
 *
 * Long enough that every restart below happens **during** it. The fake worker never reaches a
 * checkpoint, so each drain spends ADR 0024's whole 20-second budget on step 2 before step 3 kills
 * the process group — which is the shipped behaviour and the reason this proof takes minutes.
 */
const JOB_LIFE_MS = 600_000;

/** How long to watch for a supervisor bringing an exit `0` back. Above every retry interval here. */
const NOT_RESTARTED_WINDOW_MS = 6_000;

let failures = 0;

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Record one expectation, and say what it was. */
function check(what: string, ok: boolean, detail = ""): void {
  if (!ok) {
    failures += 1;
  }
  say(`  ${ok ? "check" : "FAIL "}  ${what}${detail === "" ? "" : ` — ${detail}`}`);
}

/** What one spawned command answered. */
type Ran = { status: number | null; stdout: string; stderr: string };

/** Run a command and print what it said, so the transcript carries the evidence. */
function shell(program: string, argv: readonly string[], timeoutMs = 120_000): Ran {
  const answer = spawnSync(program, [...argv], { encoding: "utf8", timeout: timeoutMs });
  const ran: Ran = {
    status: answer.status,
    stdout: String(answer.stdout ?? ""),
    stderr: String(answer.stderr ?? ""),
  };
  say(`  $ ${program} ${argv.join(" ")}   -> ${String(ran.status)}`);
  for (const stream of [ran.stdout, ran.stderr]) {
    for (const line of stream.split("\n")) {
      if (line.trim() !== "") {
        say(`      ${line}`);
      }
    }
  }
  return ran;
}

/** Wait for a predicate, or give up and say so. */
async function waitFor(
  what: string,
  predicate: () => boolean,
  timeoutMs = 60_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await sleep(100);
  }
  say(`  timed out waiting for ${what}`);
  return false;
}

/** Everything one platform's half needs, and the record `daemon restart` reads it back from. */
type Bed = {
  root: string;
  stateDir: string;
  socket: string;
  target: RegistrationTarget;
  /** The shipped command with the product's identity swapped for the throwaway one. */
  run: (command: ProbeCommand) => ReturnType<typeof runProbe>;
};

/**
 * The account and the directories the three renderers build their paths from.
 *
 * On macOS and Linux the job is registered for the account this proof already runs as, and every
 * path it renders points inside a scratch home. **Windows needs two more fields and neither is
 * optional**: `schtasks.ts` builds the XML mirror and the log path from `%LOCALAPPDATA%` and
 * refuses a blank one, and both the task's name and its S4U principal come from the qualified
 * account — a fixture name would be a principal Task Scheduler cannot register a task for. So the
 * `win32` form is this process's own environment with the scratch home kept, which is the account
 * the runner is logged in as. Measured on `windows-latest` on 2026-09-08, before this existed:
 * "SupervisorArtefactError: the task-scheduler artefact needs environment.localAppData, and it is
 * the empty string".
 */
function proofEnvironment(home: string): SupervisorEnvironment {
  return process.platform === "win32"
    ? { ...currentSupervisorEnvironment(), home }
    : { home, account: LINUX_USER };
}

/**
 * A state directory, a launch contract naming the real `serve`, and this platform's artefact.
 *
 * The state directory is deliberately short: the socket underneath it has to fit
 * `sockaddr_un.sun_path`, which is 103 bytes on macOS and mostly spent by `/var/folders/…/T/`
 * before this proof adds anything.
 */
function prepareBed(kind: "launchd" | "systemd" | "task-scheduler", uid: number): Bed {
  const root = mkdtempSync(join(tmpdir(), "xr13-"));
  const home = join(root, "h");
  const stateDir = join(root, "s");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(join(home, "Library", "Logs", "xplainer"), { recursive: true });
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });

  const socket = resolveIpcPath(stateDir);
  const tokenFile = join(stateDir, "token");

  // A supervisor artefact carries no per-run environment, so the job's configuration travels in the
  // program itself: two lines that set it and then start the real `serve` entry.
  const shim = join(root, "entry.mjs");
  writeFileSync(
    shim,
    `process.env.XPLAINER_TEST_WORKER = ${JSON.stringify(
      JSON.stringify({ lines: 3, lifeMs: JOB_LIFE_MS, grandchild: true }),
    )};\n` + `await import(${JSON.stringify(pathToFileURL(CHILD_SERVE_JOB).href)});\n`,
    { mode: 0o600 },
  );

  const spec: LaunchSpec = {
    executable: process.execPath,
    argv: [
      "--import",
      HOOK,
      shim,
      "--port",
      "0",
      SETTING_FLAGS.stateDir,
      stateDir,
      SETTING_FLAGS.tokenFile,
      tokenFile,
      SETTING_FLAGS.socket,
      socket,
    ],
    settings: { stateDir, tokenFile, socket },
    cwd: stateDir,
  };
  const environment = proofEnvironment(home);

  let artefactPath: string;
  let identity: string;
  if (kind === "launchd") {
    const rendered = renderLaunchAgentPlist(spec, environment);
    identity = THROWAWAY_LABEL;
    artefactPath = join(home, "Library", "LaunchAgents", `${THROWAWAY_LABEL}.plist`);
    writeFileSync(
      artefactPath,
      rendered.contents.replace(
        `<key>Label</key><string>${rendered.identity}</string>`,
        `<key>Label</key><string>${THROWAWAY_LABEL}</string>`,
      ),
      { mode: rendered.mode },
    );
  } else if (kind === "systemd") {
    const rendered = renderSystemdUnit(spec, environment);
    identity = THROWAWAY_UNIT;
    artefactPath = join(process.env.HOME ?? home, ".config", "systemd", "user", THROWAWAY_UNIT);
    mkdirSync(join(artefactPath, ".."), { recursive: true });
    writeFileSync(artefactPath, rendered.contents, { mode: rendered.mode });
  } else {
    const rendered = renderScheduledTask(spec, environment);
    identity = THROWAWAY_TASK;
    artefactPath = join(root, "task.xml");
    writeFileSync(artefactPath, rendered.contents, { mode: rendered.mode });
  }

  // The record every verb reads. `installDaemon` writes exactly these fields; this proof writes
  // them by hand because the job it registers carries a throwaway identity.
  updateDaemonState(stateDir, {
    supervisor_kind: kind,
    supervisor_artefact: artefactPath,
    launch_spec: spec,
    token_file: tokenFile,
    socket_path: socket,
    log_sink: join(home, "Library", "Logs", "xplainer", "daemon.log"),
  });

  const target: RegistrationTarget = { kind, identity, artefact: artefactPath, uid };
  const product =
    kind === "launchd"
      ? "video.xplainer.daemon"
      : kind === "systemd"
        ? "xplainer.service"
        : "\\xplainer\\";
  return {
    root,
    stateDir,
    socket,
    target,
    // The shipped builders address the identity the adapter names, and this proof registered a
    // different one. Rewriting the word they produced — rather than hand-writing the command — is
    // what keeps the thing being measured the shipped command.
    run: (command) =>
      runProbe({
        ...command,
        argv: command.argv.map((word) =>
          word.replaceAll(product, kind === "task-scheduler" ? "\\xplainer\\" : identity),
        ),
      }),
  };
}

/**
 * The job this run of the daemon is holding, once it is really running.
 *
 * Every start enqueues one, so the id goes up with each restart and the question is "which job is
 * running **now**" rather than "job 1". A drained job is `error`, so there is never more than one.
 */
async function runningJob(stateDir: string): Promise<{ jobId: number; workerPid: number } | null> {
  const store = createJobStore(stateDir);
  const current = (): { jobId: number; workerPid: number } | null => {
    for (const record of store.load().records) {
      const worker = record.workers[0];
      if (record.status === "running" && worker !== undefined) {
        return { jobId: record.job_id, workerPid: worker.pid };
      }
    }
    return null;
  };
  const ok = await waitFor("a running job", () => current() !== null);
  return ok ? current() : null;
}

/** This run's pid, from the `runtime.json` the daemon writes at readiness. */
function runningPid(stateDir: string): number | null {
  const record = readRuntimeState(stateDir);
  return typeof record?.pid === "number" ? record.pid : null;
}

/** Bring a bed up under its supervisor, and report the pid and the job it is holding. */
async function boot(bed: Bed): Promise<{ pid: number; jobId: number; workerPid: number } | null> {
  for (const step of registerCommands(bed.target)) {
    const answer = shell(step.command.program, [...step.command.argv]);
    check(
      `${step.title}${step.tolerated === true ? " (tolerated)" : ""}`,
      step.tolerated === true || answer.status === 0,
      `exit ${String(answer.status)}`,
    );
  }
  const up = await waitFor("runtime.json", () => runningPid(bed.stateDir) !== null);
  const job = up ? await runningJob(bed.stateDir) : null;
  const pid = runningPid(bed.stateDir);
  check(
    "the supervisor started the daemon, and it is holding a running job",
    job !== null && pid !== null,
  );
  return job === null || pid === null ? null : { pid, ...job };
}

/** The evidence that a drain ran rather than a process being killed: the job record's own words. */
function drainedJob(stateDir: string, jobId: number): { status: string; code: string } {
  const record = createJobStore(stateDir).read(jobId);
  return { status: record?.status ?? "<absent>", code: record?.error_code ?? "<none>" };
}

// ── the three questions, written once and asked on each platform ─────────────────────────────

/** 1. The supervisor's own restart, with a job running under the daemon. */
async function proveSupervisorRestart(bed: Bed, command: ProbeCommand): Promise<void> {
  const before = await boot(bed);
  if (before === null) {
    return;
  }
  say(`\n1. the supervisor's own restart, during job ${String(before.jobId)}:`);
  const startedAt = Date.now();
  const answer = bed.run({ ...command, timeoutMs: 120_000 });
  say(
    `  $ ${command.program} ${command.argv.join(" ")}   -> ${String(answer.status)} after ${String(Date.now() - startedAt)} ms`,
  );
  for (const line of `${answer.stdout}${answer.stderr}`.split("\n")) {
    if (line.trim() !== "") {
      say(`      ${line}`);
    }
  }
  check(
    "the restart command was accepted",
    answer.started && answer.status === 0,
    `exit ${String(answer.status)}`,
  );

  const drained = drainedJob(bed.stateDir, before.jobId);
  check(
    "the job the daemon was holding ends as the drain's own record, not as a killed process",
    drained.status === "error" && drained.code === "daemon_shutdown",
    `${drained.status}/${drained.code}`,
  );
  check("the worker's process group is gone", !isAlive(before.workerPid));
  const back = await waitFor(
    "the replacement to announce itself",
    () => {
      const pid = runningPid(bed.stateDir);
      return pid !== null && pid !== before.pid && isAlive(pid);
    },
    60_000,
  );
  check(
    "the supervisor brought the daemon back on the other side of the drain",
    back,
    `was pid ${String(before.pid)}, now pid ${String(runningPid(bed.stateDir) ?? 0)}`,
  );
}

/** 2. The real route, and the supervisor declining to restart the exit `0` it produces. */
async function proveRouteAndExitZero(bed: Bed, startAgain: ProbeCommand): Promise<void> {
  const job = await runningJob(bed.stateDir);
  const pid = runningPid(bed.stateDir);
  if (job === null || pid === null) {
    check("a daemon to drain over the socket", false);
    return;
  }
  say(`\n2. POST ${DRAIN_PATH} over ${bed.socket}, and what the supervisor does with exit 0:`);
  const asked = await requestDrain({ socketPath: bed.socket });
  check("the route answered", asked.ok, asked.ok ? "202" : `${asked.reason}: ${asked.detail}`);
  if (!asked.ok) {
    return;
  }
  say(
    `  acknowledged: pid ${String(asked.acknowledgement.pid)}, cap ${String(asked.acknowledgement.timeout_ms)} ms`,
  );
  check("it named the process that is actually serving", asked.acknowledgement.pid === pid);

  const stopped = await awaitStopped({ stateDir: bed.stateDir, pid, timeoutMs: 40_000 });
  check(
    "the daemon went away inside the budget",
    stopped.stopped,
    `${String(stopped.elapsedMs)} ms`,
  );
  check("and step 6 removed runtime.json", stopped.runtimeRecordRemoved);
  const drained = drainedJob(bed.stateDir, job.jobId);
  check(
    "the job it was holding is the drain's record again",
    drained.status === "error" && drained.code === "daemon_shutdown",
    `${drained.status}/${drained.code}`,
  );

  // The negative that makes exit `0` mean something: nothing brings it back on its own.
  await sleep(NOT_RESTARTED_WINDOW_MS);
  check(
    `nothing restarted it in ${String(NOT_RESTARTED_WINDOW_MS / 1000)} s, which is what exit 0 buys`,
    runningPid(bed.stateDir) === null,
    `runtime.json ${runningPid(bed.stateDir) === null ? "absent" : "back"}`,
  );

  const answer = bed.run({ ...startAgain, timeoutMs: 120_000 });
  say(`  $ ${startAgain.program} ${startAgain.argv.join(" ")}   -> ${String(answer.status)}`);
  check("the adapter's start command was accepted", answer.started && answer.status === 0);
  const back = await waitFor("the daemon to answer again", () => runningPid(bed.stateDir) !== null);
  check("and the daemon is back, from the adapter's own start command", back);
}

/** 3. The shipped `xplainer daemon restart`, end to end against the real manager. */
async function proveShippedRestart(
  bed: Bed,
  uid: number,
  platform: NodeJS.Platform,
): Promise<void> {
  const job = await runningJob(bed.stateDir);
  const pid = runningPid(bed.stateDir);
  if (job === null || pid === null) {
    check("a daemon for `xplainer daemon restart` to restart", false);
    return;
  }
  say("\n3. the shipped `xplainer daemon restart`, with a latch set before it runs:");
  updateDaemonState(bed.stateDir, {
    stalled: { at: new Date().toISOString(), reason: "latched by the T13 proof" },
  });

  const home = join(bed.root, "h");
  const attempt = await restartDaemon({
    stateDir: bed.stateDir,
    platform,
    environment: proofEnvironment(home),
    uid,
    run: bed.run,
  }).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (!attempt.ok) {
    check(
      "`daemon restart` completed",
      false,
      attempt.error instanceof Error ? attempt.error.message : String(attempt.error),
    );
    return;
  }
  const outcome = attempt.value;
  for (const command of outcome.commands) {
    say(`  ran: ${command}`);
  }
  say(`  latch:      ${outcome.cleared.stalled?.reason ?? "<none>"}`);
  say(`  supervisor: ${outcome.supervisorLatch}`);
  say(`  stop:       ${outcome.stop}`);
  say(`  exit:       ${outcome.exit}`);
  check("the latch a stalled daemon carries was cleared first", outcome.cleared.stalled !== null);
  check("`daemon.json` no longer carries it", readDaemonState(bed.stateDir).stalled === null);
  check(
    "the drain went over the socket, not through a signal",
    outcome.commands.includes(`POST ${DRAIN_PATH} over ${bed.socket}`),
    outcome.commands.join(" | "),
  );
  check("the daemon that was serving is gone", !isAlive(pid));
  check(
    "the job it was holding is the drain's record",
    drainedJob(bed.stateDir, job.jobId).code === "daemon_shutdown",
  );
  check(
    "a new daemon answered an authenticated /healthz",
    outcome.port !== null,
    `port ${String(outcome.port)}`,
  );
  check("and it is a different process", runningPid(bed.stateDir) !== pid);
}

// ── macOS ────────────────────────────────────────────────────────────────────────────────────

async function proveLaunchd(): Promise<void> {
  const uid = process.getuid?.() ?? 0;
  const bed = prepareBed("launchd", uid);
  const service = guiService(bed.target);
  try {
    say(`\nlaunchd, ${service}, with the shipped plist under a throwaway label:`);
    // `kickstart -k` is the macOS counterpart of `systemctl --user restart`, and ADR 0024's note of
    // 2026-09-08 measured it as graceful: it sends `SIGTERM`, waits for the drain, and only then
    // starts the replacement. That was measured against the spike's fixture; this is the real one.
    await proveSupervisorRestart(bed, {
      program: "launchctl",
      argv: ["kickstart", "-k", service],
    });
    await proveRouteAndExitZero(bed, { program: "launchctl", argv: ["kickstart", service] });
    await proveShippedRestart(bed, uid, "darwin");
  } finally {
    say("\ntearing the throwaway job down, and leaving its disable record as it was found:");
    for (const step of deregisterCommands(bed.target)) {
      shell(step.command.program, [...step.command.argv]);
    }
    shell("launchctl", ["enable", service]);
    rmSync(bed.root, { recursive: true, force: true });
  }
}

// ── Linux ────────────────────────────────────────────────────────────────────────────────────

async function proveSystemd(): Promise<void> {
  const uid = process.getuid?.() ?? 0;
  const bed = prepareBed("systemd", uid);
  try {
    say(`\nsystemd --user, ${THROWAWAY_UNIT}, with the shipped unit under a throwaway name:`);
    shell("systemctl", ["--user", "daemon-reload"]);
    await proveSupervisorRestart(bed, {
      program: "systemctl",
      argv: ["--user", "restart", THROWAWAY_UNIT],
    });
    await proveRouteAndExitZero(bed, {
      program: "systemctl",
      argv: ["--user", "start", THROWAWAY_UNIT],
    });
    // What the manager itself says about the run the route ended, which is the one platform that
    // offers a documented query for it and the one `exitStatusQuery` reads.
    say("\nwhat systemd recorded about the drained run:");
    shell("systemctl", [
      "--user",
      "show",
      "-p",
      "Result",
      "-p",
      "ExecMainStatus",
      "-p",
      "NRestarts",
      "--value",
      THROWAWAY_UNIT,
    ]);
    await proveShippedRestart(bed, uid, "linux");
  } finally {
    say("\ntearing the throwaway unit down:");
    for (const step of deregisterCommands(bed.target)) {
      shell(step.command.program, [...step.command.argv]);
    }
    rmSync(bed.target.artefact, { force: true });
    shell("systemctl", ["--user", "daemon-reload"]);
    rmSync(bed.root, { recursive: true, force: true });
  }
}

// ── Windows ──────────────────────────────────────────────────────────────────────────────────

/**
 * Task Scheduler, which has no restart verb at all.
 *
 * That absence is the platform's answer rather than a gap in this proof: a task is stopped and
 * started, and the graceful half of the pair is the route over the **named pipe** — Node maps
 * `SIGTERM` to `TerminateProcess` on Windows, so a signal there is not a drain and never can be.
 * `Stop-ScheduledTask` is therefore measured for what it is — a terminate — and the route is
 * measured for what it does instead.
 */
async function proveTaskScheduler(): Promise<void> {
  const bed = prepareBed("task-scheduler", 0);
  try {
    say(`\nTask Scheduler, ${THROWAWAY_TASK}, with the shipped XML under a throwaway name:`);
    await proveRouteAndExitZero(bed, {
      program: "powershell.exe",
      argv: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Start-ScheduledTask -TaskName '${THROWAWAY_TASK}'`,
      ],
    });
    await proveShippedRestart(bed, 0, "win32");
  } finally {
    say("\nunregistering the throwaway task:");
    for (const step of deregisterCommands(bed.target)) {
      shell(step.command.program, [...step.command.argv]);
    }
    rmSync(bed.root, { recursive: true, force: true });
  }
}

// ── the entry point ──────────────────────────────────────────────────────────────────────────

/** Re-enter as the unprivileged user, which is what a per-user manager needs. */
function asUser(): number {
  const answer = spawnSync(
    "runuser",
    ["-u", LINUX_USER, "--", process.execPath, "--import", HOOK, SELF, "--here"],
    {
      encoding: "utf8",
      stdio: "inherit",
      timeout: 900_000,
      env: {
        ...process.env,
        HOME: `/home/${LINUX_USER}`,
        XDG_RUNTIME_DIR: `/run/user/${String(LINUX_UID)}`,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${String(LINUX_UID)}/bus`,
      },
    },
  );
  return answer.status ?? 1;
}

say(`T13 restart proof — ${process.platform}, node ${process.version}`);
if (
  process.platform === "linux" &&
  (process.getuid?.() ?? 0) === 0 &&
  !process.argv.includes("--here")
) {
  // A container has no login session, so the target user has no manager until lingering starts one
  // — `systemctl --user` answers "Failed to connect to bus" until `/run/user/<uid>` exists. This is
  // the container's own arrangement and not part of what is being proved, which is why the runner
  // form (`--here`) leaves it to the workflow step that does the same thing with `sudo`.
  say(`enabling lingering for ${LINUX_USER}, so that account has a manager to talk to:`);
  shell("loginctl", ["enable-linger", LINUX_USER]);
  await waitFor("the per-user manager's runtime directory", () =>
    existsSync(`/run/user/${String(LINUX_UID)}`),
  );
  shell("loginctl", ["show-user", LINUX_USER, "-p", "Linger", "-p", "RuntimePath", "-p", "State"]);
  say(`\nre-entering as ${LINUX_USER}, because a per-user manager belongs to a user:`);
  process.exitCode = asUser();
} else {
  if (process.platform === "darwin") {
    await proveLaunchd();
  } else if (process.platform === "linux") {
    await proveSystemd();
  } else if (process.platform === "win32") {
    await proveTaskScheduler();
  } else {
    say(`nothing to prove on ${process.platform}`);
  }
  say(`\n${failures === 0 ? "PASSED" : `FAILED: ${String(failures)} expectation(s)`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}
