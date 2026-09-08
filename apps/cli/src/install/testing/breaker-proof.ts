/**
 * The circuit breaker, latched by a **real** supervisor's own natural retries.
 *
 * `daemon-state.test.ts` proves the rule: five starts that each recorded their own failure inside
 * 30 s latch the breaker however far apart they were spaced, an unrecorded death is bounded by the
 * next start's `started_at`, and a negative interval resets. What a unit test cannot prove is that
 * a real service manager produces that history at all — that launchd really does re-launch a job
 * that exits `10`, that it really does space those launches by its own `ThrottleInterval`, and that
 * the exit `0` the breaker produces really does stop the loop. P2-11 asks for the latch "on all
 * three platforms", and this is where that sentence becomes a measurement.
 *
 * Nothing here shortens a retry interval or fakes a failure. The daemon under the supervisor is the
 * shipped `serve`; the failure is a **real bind refusal** — this process holds the port recorded in
 * `daemon.json`, so every start resolves that port, fails `EADDRINUSE`, records its own end and
 * exits `10` — and the cadence between attempts is the supervisor's own: `RestartSec=2` under
 * systemd, `ThrottleInterval` 30 s under launchd, and the three `PT1M` retries then the `PT5M`
 * repetition under Task Scheduler. That is why this script takes minutes on Linux and the better
 * part of a quarter of an hour on Windows.
 *
 * ```sh
 * # macOS, on this machine, under a throwaway label removed in a `finally`:
 * node --import apps/cli/src/daemon/testing/ts-source-hook.ts \
 *   apps/cli/src/install/testing/breaker-proof.ts
 *
 * # Linux, inside the systemd container, as root, which re-enters as the unprivileged user:
 * docker build -f infra/e2e/Dockerfile.systemd -t xplainer-p2s4-systemd "$(mktemp -d)"
 * docker run -d --name xplainer-t14 --privileged --cgroupns=host \
 *   -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
 *   -v "$PWD:/repo:ro" xplainer-p2s4-systemd
 * # `debian:bookworm-slim` has neither `lsof` nor `ss`, and `install/preflight.ts` names a port's
 * # holder with one of them — without either, the sentence this proof asserts degrades to "a
 * # process this preflight could not name". Hosted runners have both; this image is what needs the
 * # line, and it is the image's business rather than the product's:
 * docker exec xplainer-t14 sh -c 'apt-get update >/dev/null && apt-get install -y iproute2 >/dev/null'
 * docker exec xplainer-t14 node --import /repo/apps/cli/src/daemon/testing/ts-source-hook.ts \
 *   /repo/apps/cli/src/install/testing/breaker-proof.ts
 *
 * # ubuntu-latest, macos-latest and windows-latest, where the account the job runs as is the account:
 * node --import apps/cli/src/daemon/testing/ts-source-hook.ts \
 *   apps/cli/src/install/testing/breaker-proof.ts --here
 * ```
 *
 * ## What is asserted, in the order it happens
 *
 * 1. **Five failed starts, each recording its own end.** Every entry in `recentStarts[]` carries an
 *    `outcome` of `failed` and an `ended_at` within {@link FAILED_START_WINDOW_MS} of its own
 *    `started_at` — and the transcript prints the **spacing between starts** beside it, which is the
 *    number the old inference used and which exceeds the window on two of the three platforms.
 * 2. **The latch, and exit `0`.** `daemon.json` gains a `stalled` record, and the supervisor stops:
 *    on systemd the manager's own `Result`/`ExecMainStatus` query says `success`/`0`, on Windows
 *    `Get-ScheduledTaskInfo`'s `LastTaskResult` says `0`, and on macOS — where `launchctl print` is
 *    not API and there is no other query — the evidence is that nothing came back for longer than
 *    the throttle interval.
 * 3. **`daemon status` says so, in words, naming the pid.** The condition is `stalled` and ADR
 *    0020's first sentence names this process as the one holding the port.
 * 4. **Windows only: the `PT5M` repetition re-reads the flag and exits `0` again.** The logon
 *    trigger's repetition keeps starting the task after the restart count is spent, and each of
 *    those runs must read the latch and exit `0` without adding a start record.
 * 5. **`xplainer daemon restart` clears it**, and a daemon comes back and answers — which is only
 *    possible because the port is released first, in the step before.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  type DaemonStart,
  FAILED_START_WINDOW_MS,
  readDaemonState,
  readRuntimeState,
  STALL_AFTER_FAILED_STARTS,
  startIsProvablyGone,
  updateDaemonState,
} from "../../daemon/daemon-state.js";
import { resolveIpcPath } from "../../daemon/ipc.js";
import type { LaunchSpec } from "../../runtime/launch-spec.js";
import { SETTING_FLAGS } from "../../runtime/launch-spec.js";
import { daemonStatus, restartDaemon } from "../lifecycle.js";
import { type ProbeCommand, runProbe } from "../preflight.js";
import {
  deregisterCommands,
  guiService,
  type RegistrationTarget,
  registerCommands,
} from "../register.js";
import { renderLaunchAgentPlist } from "../supervisors/launchd.js";
import { renderScheduledTask } from "../supervisors/schtasks.js";
import { renderSystemdUnit } from "../supervisors/systemd.js";

/** The launchd label this proof registers under. Never the product's, and re-enabled in a `finally`. */
export const THROWAWAY_LABEL = "video.xplainer.t14-proof";

/** The systemd unit and the scheduled task, named the same way and for the same reason. */
export const THROWAWAY_UNIT = "xplainer-t14-proof.service";
export const THROWAWAY_TASK = "\\xplainer\\t14-proof";

/** The account and uid the container's unprivileged half runs as, matching the sibling proofs. */
const LINUX_USER = "xplainer";
const LINUX_UID = 1000;

/** This file, and the source hook a child needs to run TypeScript. */
const SELF = fileURLToPath(import.meta.url);
const HOOK = fileURLToPath(new URL("../../daemon/testing/ts-source-hook.ts", import.meta.url));
const CHILD_SERVE = fileURLToPath(new URL("../../daemon/testing/child-serve.ts", import.meta.url));

/**
 * The port this proof holds and records, so every supervised start fails to bind it.
 *
 * Fixed rather than ephemeral because the value has to be in `daemon.json` before the first start,
 * and high enough to be outside anything a hosted runner is likely to be using.
 */
const HELD_PORT = 18_790;

/**
 * How long each platform's five failures are allowed to take, at that platform's own cadence.
 *
 * `RestartSec=2` under systemd, a 30-second `ThrottleInterval` under launchd, and under Task
 * Scheduler three `PT1M` retries followed by a `PT5M` repetition that has to fire twice — which is
 * why the Windows budget is a quarter of an hour and is not a sign that anything is stuck.
 */
function historyBudgetMs(platform: NodeJS.Platform): number {
  if (platform === "linux") {
    return 180_000;
  }
  if (platform === "darwin") {
    return 420_000;
  }
  if (platform === "win32") {
    return 900_000;
  }
  return 300_000;
}

/** How long to watch for a supervisor bringing an exit `0` back, above every retry interval here. */
const NOT_RESTARTED_WINDOW_MS = 45_000;

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
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await sleep(500);
  }
  say(`  timed out after ${String(timeoutMs / 1000)} s waiting for ${what}`);
  return false;
}

/** Everything one platform's half needs, and the record the shipped verbs read it back from. */
type Bed = {
  root: string;
  home: string;
  stateDir: string;
  target: RegistrationTarget;
  /** The shipped command with the product's identity swapped for the throwaway one. */
  run: (command: ProbeCommand) => ReturnType<typeof runProbe>;
};

/**
 * A state directory whose recorded port is the one this process is holding, and this platform's
 * artefact around the real `serve`.
 *
 * **The launch contract deliberately carries no `--port`**, because the port the daemon binds has
 * to come from `daemon.json` — that is what "hold the **recorded** port" means, and a `--port` in
 * the argv would resolve ahead of it and prove something else.
 */
function prepareBed(kind: "launchd" | "systemd" | "task-scheduler", uid: number): Bed {
  const root = mkdtempSync(join(tmpdir(), "xr14-"));
  const home = join(root, "h");
  const stateDir = join(root, "s");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(join(home, "Library", "Logs", "xplainer"), { recursive: true });
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });

  const socket = resolveIpcPath(stateDir);
  const tokenFile = join(stateDir, "token");
  const spec: LaunchSpec = {
    executable: process.execPath,
    argv: [
      "--import",
      HOOK,
      CHILD_SERVE,
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
  const environment = { home, account: LINUX_USER };

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

  // The record every verb reads, and the recorded port the daemon will fail to bind.
  updateDaemonState(stateDir, {
    port: HELD_PORT,
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
    home,
    stateDir,
    target,
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
 * Hold {@link HELD_PORT} on loopback, in this process, so its pid is the one `status` names.
 *
 * **Every connection is destroyed the moment it arrives**, and both halves of that are deliberate.
 * A squatter that accepted and held a connection would be one that `daemon status`'s own `/healthz`
 * probe could leave open in a keep-alive pool — and then `server.close()` waits for a connection
 * that never goes idle, which is a proof that hangs in its teardown rather than releasing the port
 * for the `restart` it is about to assert. Destroying also gives the probe the answer it should
 * have: nothing here is a daemon, and `unreachable` is the truth.
 */
function holdPort(): Promise<Server> {
  const server = createServer((socket) => {
    socket.destroy();
  });
  return new Promise((held, failed) => {
    server.once("error", failed);
    server.listen(HELD_PORT, "127.0.0.1", () => {
      held(server);
    });
  });
}

/** How long the release below waits before deciding the port is as free as it is going to get. */
const RELEASE_TIMEOUT_MS = 2_000;

/**
 * Give the port back, and never let the giving back be what fails.
 *
 * `close()` resolves when the last connection has gone, so it is raced with a timer: the timer is
 * also a live handle, which is what stops Node deciding the loop is empty and exiting the process
 * out from under the `finally` that removes this proof's throwaway registration. `net.Server` has
 * no `closeAllConnections()` — that one belongs to `http.Server` — which is why the connection
 * handler above destroys each socket as it arrives instead.
 */
async function releasePort(server: Server): Promise<void> {
  await Promise.race([
    new Promise<void>((closed) => {
      server.close(() => {
        closed();
      });
    }),
    sleep(RELEASE_TIMEOUT_MS),
  ]);
}

/** The history, printed the way the breaker reads it: each run's own life, and the spacing beside it. */
function describeHistory(starts: readonly DaemonStart[]): void {
  let previous: number | null = null;
  for (const [index, start] of starts.entries()) {
    const startedMs = Date.parse(start.started_at);
    const lived = start.ended_at === null ? null : Date.parse(start.ended_at) - startedMs;
    const spacing = previous === null ? null : startedMs - previous;
    previous = startedMs;
    say(
      `  start ${String(index + 1)}: ${start.started_at}  outcome ${start.outcome ?? "<none>"}` +
        `  lived ${lived === null ? "<unrecorded>" : `${String(lived)} ms`}` +
        `  ${spacing === null ? "" : `(${String(spacing)} ms after the previous start)`}`,
    );
    say(
      `           identity: pid ${String(start.pid)}, start_time ${start.start_time ?? "<none>"}, ` +
        `boot ${start.boot_id ?? "<none>"}`,
    );
  }
}

/** 1 and 2: the five failures the supervisor drives, and the latch they produce. */
async function proveTheLatch(bed: Bed): Promise<void> {
  say(`\n1. the supervisor's own retries, against a port pid ${String(process.pid)} is holding:`);
  for (const step of registerCommands(bed.target)) {
    const answer = shell(step.command.program, [...step.command.argv]);
    check(
      `${step.title}${step.tolerated === true ? " (tolerated)" : ""}`,
      step.tolerated === true || answer.status === 0,
      `exit ${String(answer.status)}`,
    );
  }

  const budget = historyBudgetMs(process.platform);
  const enough = await waitFor(
    `${String(STALL_AFTER_FAILED_STARTS)} failed starts`,
    () => readDaemonState(bed.stateDir).recentStarts.length >= STALL_AFTER_FAILED_STARTS,
    budget,
  );
  const history = readDaemonState(bed.stateDir).recentStarts;
  describeHistory(history);
  check(
    `the supervisor produced ${String(STALL_AFTER_FAILED_STARTS)} starts by itself`,
    enough,
    `${String(history.length)} recorded`,
  );
  check(
    "every one of them recorded its own outcome and its own end",
    history.length > 0 && history.every((s) => s.outcome === "failed" && s.ended_at !== null),
  );
  check(
    `each died within ${String(FAILED_START_WINDOW_MS / 1000)} s of its own start`,
    history.every(
      (s) =>
        s.ended_at !== null &&
        Date.parse(s.ended_at) - Date.parse(s.started_at) <= FAILED_START_WINDOW_MS,
    ),
  );
  // The tuple is not decoration: it is what lets a later start decide "provably gone" for a run
  // that died before readiness and so wrote no `runtime.json` at all.
  check(
    "and each carries an identity tuple a later start can decide `provably gone` from",
    history.length > 0 && history.every((s) => s.pid > 0 && startIsProvablyGone(s)),
  );

  say("\n2. the latch, and the exit 0 that stops the loop:");
  const latched = await waitFor(
    "the breaker to latch",
    () => readDaemonState(bed.stateDir).stalled !== null,
    budget,
  );
  const stall = readDaemonState(bed.stateDir).stalled;
  check("`daemon.json` carries a stalled record", latched, stall?.reason ?? "<none>");
  check("it is not still serving", readRuntimeState(bed.stateDir) === null);
}

/** 3: the four-sentence report, and the one this state is entitled to. */
async function proveTheSentence(bed: Bed, platform: NodeJS.Platform, uid: number): Promise<void> {
  say("\n3. `xplainer daemon status`, in ADR 0020's own words:");
  const report = await daemonStatus({
    stateDir: bed.stateDir,
    platform,
    environment: { home: bed.home, account: LINUX_USER },
    uid,
    run: bed.run,
  });
  for (const sentence of report.sentences) {
    say(`  ${sentence.state}: ${sentence.text}`);
  }
  check("the condition is `stalled`", report.condition === "stalled", report.condition);
  check(
    "it counted the failed starts",
    report.failed_starts >= STALL_AFTER_FAILED_STARTS,
    String(report.failed_starts),
  );
  const stopped = report.sentences.find((s) => s.state === "stopped-after-failed-starts");
  check("it says it stopped after failed starts", stopped !== undefined);
  check(
    "and it names the pid holding the port, in words",
    stopped?.text.includes(`pid ${String(process.pid)}`) === true,
    stopped?.text ?? "<no sentence>",
  );
}

/** 5: the shipped `daemon restart`, once the port it needs is free again. */
async function proveRestartClearsIt(
  bed: Bed,
  platform: NodeJS.Platform,
  uid: number,
  squatter: Server,
): Promise<void> {
  say("\n5. releasing the port, then `xplainer daemon restart`:");
  await releasePort(squatter);
  const before = readDaemonState(bed.stateDir);

  const attempt = await restartDaemon({
    stateDir: bed.stateDir,
    platform,
    environment: { home: bed.home, account: LINUX_USER },
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
  // The shipped builders' own spelling, which names the **product's** unit, label or task: `bed.run`
  // substitutes the throwaway identity on the way to the process, so what ran is this line with the
  // registration this proof made in place of the one it would install on a real machine.
  say("  the shipped commands, before this proof swapped its throwaway identity in:");
  for (const command of attempt.value.commands) {
    say(`  ran: ${command}`);
  }
  say(`  latch:      ${attempt.value.cleared.stalled?.reason ?? "<none>"}`);
  say(`  supervisor: ${attempt.value.supervisorLatch}`);
  const after = readDaemonState(bed.stateDir);
  check(
    "the latch it cleared is the one the breaker wrote",
    attempt.value.cleared.stalled !== null,
  );
  check(
    "the spent history went with it, so the next start does not re-latch",
    after.stalled === null && after.recentStarts.length <= 1,
    `${String(before.recentStarts.length)} -> ${String(after.recentStarts.length)}`,
  );
  check(
    "a daemon answered an authenticated /healthz on the port it could not bind before",
    attempt.value.port !== null,
    `port ${String(attempt.value.port)}`,
  );
}

// ── macOS ────────────────────────────────────────────────────────────────────────────────────

async function proveLaunchd(squatter: Server): Promise<void> {
  const uid = process.getuid?.() ?? 0;
  const bed = prepareBed("launchd", uid);
  const service = guiService(bed.target);
  try {
    say(`\nlaunchd, ${service}, with the shipped plist under a throwaway label:`);
    await proveTheLatch(bed);
    // launchd has no documented machine-readable exit query — `launchctl print`'s own manual says
    // its output "is NOT API in any sense at all" — so the evidence that exit `0` was honoured is
    // that nothing came back for longer than the 30-second `ThrottleInterval`.
    const before = readDaemonState(bed.stateDir).recentStarts.length;
    say(`\n  watching for ${String(NOT_RESTARTED_WINDOW_MS / 1000)} s: nothing should come back.`);
    await sleep(NOT_RESTARTED_WINDOW_MS);
    check(
      "no start followed the latched one, which is what exit 0 buys under KeepAlive{SuccessfulExit:false}",
      readDaemonState(bed.stateDir).recentStarts.length === before,
    );
    await proveTheSentence(bed, "darwin", uid);
    await proveRestartClearsIt(bed, "darwin", uid, squatter);
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

async function proveSystemd(squatter: Server): Promise<void> {
  const uid = process.getuid?.() ?? 0;
  const bed = prepareBed("systemd", uid);
  try {
    say(`\nsystemd --user, ${THROWAWAY_UNIT}, with the shipped unit under a throwaway name:`);
    shell("systemctl", ["--user", "daemon-reload"]);
    await proveTheLatch(bed);
    // The one platform with a documented query for the exit status of the run that just ended.
    // Named rather than `--value`: `systemctl show` prints properties in its own order, not the
    // order they were asked for, so three bare values are three numbers nobody can attribute.
    say("\n  what the manager recorded about the latched run:");
    const shown = shell("systemctl", [
      "--user",
      "show",
      "-p",
      "Result",
      "-p",
      "ExecMainStatus",
      "-p",
      "NRestarts",
      THROWAWAY_UNIT,
    ]);
    const properties = shown.stdout.split("\n").map((line) => line.trim());
    check(
      "systemd says the last run exited 0 and the unit did not fail",
      properties.includes("Result=success") && properties.includes("ExecMainStatus=0"),
      properties.filter((value) => value !== "").join(" | "),
    );
    await proveTheSentence(bed, "linux", uid);
    await proveRestartClearsIt(bed, "linux", uid, squatter);
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

/** `Get-ScheduledTaskInfo`'s two fields, which are the documented machine-readable answer here. */
function taskInfo(): { lastRunTime: string; lastResult: string } {
  const answer = shell("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$info = Get-ScheduledTaskInfo -TaskName '${THROWAWAY_TASK}'; ` +
      "Write-Output $info.LastRunTime.ToString('o'); Write-Output $info.LastTaskResult",
  ]);
  const lines = answer.stdout.split("\n").map((line) => line.trim());
  return { lastRunTime: lines[0] ?? "", lastResult: lines[1] ?? "" };
}

/**
 * Task Scheduler: three `PT1M` retries, then the `PT5M` repetition that keeps knocking.
 *
 * The repetition is the half that only exists here. Once `<RestartOnFailure>`'s count is spent the
 * task stops being restarted, but the logon trigger's `<Repetition>` starts it again every five
 * minutes for ever — so a latched daemon is asked to run again and again, and each of those runs
 * has to read the flag, exit `0`, and leave the latch and the history alone. A run that started
 * over would be a crash loop with a five-minute period.
 */
async function proveTaskScheduler(squatter: Server): Promise<void> {
  const bed = prepareBed("task-scheduler", 0);
  try {
    say(`\nTask Scheduler, ${THROWAWAY_TASK}, with the shipped XML under a throwaway name:`);
    await proveTheLatch(bed);
    const latchedAt = taskInfo();
    check(
      "the run that latched the breaker exited 0",
      latchedAt.lastResult === "0",
      latchedAt.lastResult,
    );

    say("\n4. the PT5M repetition, re-reading the flag:");
    const startsBefore = readDaemonState(bed.stateDir).recentStarts.length;
    const again = await waitFor(
      "the repetition to start the task again",
      () => taskInfo().lastRunTime !== latchedAt.lastRunTime,
      420_000,
    );
    const repeated = taskInfo();
    check(
      "the repetition ran the task again",
      again,
      `${latchedAt.lastRunTime} -> ${repeated.lastRunTime}`,
    );
    check("and that run exited 0 as well", repeated.lastResult === "0", repeated.lastResult);
    check(
      "it read the latch rather than starting over",
      readDaemonState(bed.stateDir).recentStarts.length === startsBefore &&
        readDaemonState(bed.stateDir).stalled !== null,
    );

    await proveTheSentence(bed, "win32", 0);
    await proveRestartClearsIt(bed, "win32", 0, squatter);
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
      timeout: 1_800_000,
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

say(`T14 breaker proof — ${process.platform}, node ${process.version}`);
if (
  process.platform === "linux" &&
  (process.getuid?.() ?? 0) === 0 &&
  !process.argv.includes("--here")
) {
  say(`enabling lingering for ${LINUX_USER}, so that account has a manager to talk to:`);
  shell("loginctl", ["enable-linger", LINUX_USER]);
  await waitFor(
    "the per-user manager's runtime directory",
    () => existsSync(`/run/user/${String(LINUX_UID)}`),
    60_000,
  );
  say(`\nre-entering as ${LINUX_USER}, because a per-user manager belongs to a user:`);
  process.exitCode = asUser();
} else {
  const squatter = await holdPort();
  say(`holding 127.0.0.1:${String(HELD_PORT)} in pid ${String(process.pid)}.`);
  try {
    if (process.platform === "darwin") {
      await proveLaunchd(squatter);
    } else if (process.platform === "linux") {
      await proveSystemd(squatter);
    } else if (process.platform === "win32") {
      await proveTaskScheduler(squatter);
    } else {
      say(`nothing to prove on ${process.platform}`);
    }
  } finally {
    squatter.close();
  }
  say(`\n${failures === 0 ? "PASSED" : `FAILED: ${String(failures)} expectation(s)`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}
