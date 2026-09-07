#!/usr/bin/env node
/**
 * Spike P2-S5 — the drain adapters: one application-level drain, three supervisors.
 *
 * `docs/adr/0024-durable-jobs-and-boot-reconciliation.md` §Drain on planned restart decides the
 * drain's behaviour and its 20-second cap, and leaves open "how each supervisor is persuaded to
 * allow it". `docs/ROADMAP.md` P2-S5 names the three things nobody had measured: whether a kill
 * strategy that signals only the main process exists on Linux, whether `launchctl kickstart -k` is
 * graceful — the manual documents it only as kill-and-restart — and what the Windows equivalent
 * is on a platform where Node cannot receive a `SIGTERM` at all. This script is the measurement,
 * and it exits `0` only when every expectation below held, so it is a check and not a demo:
 *
 *     node apps/cli/spikes/p2-s5-drain.mjs
 *
 * **THE HARNESS CARRIES ITS OWN LISTENER, AND THAT IS THE POINT.** The drain route this spike
 * asks for — `POST /api/daemon/drain` — is built by **T13, two batches later**. Measuring the
 * supervisors through a route that does not exist yet would have meant either deferring the spike
 * or measuring only the one platform with a signal fallback, which is the platform the question is
 * least about. So the harness binds **its own** listener — a unix socket on Linux and macOS, a
 * named pipe on Windows — with a fixture route that runs a **fake** drain: sleep, kill the child,
 * exit `0`. Every question here is about the *supervisor*, and none of them needs the production
 * route. The fixture is `STUB_SOURCE` below, it is written into a scratch directory at run time,
 * and it never ships. T13 later proves the same three adapters against the real route.
 *
 * WHAT IT MEASURES.
 *
 *   Linux (systemd, per-user manager), all six against a unit whose `ExecStart` is the fixture:
 *     1. **`KillMode=mixed`** — `systemctl --user restart` signals the main process, the drain
 *        runs to completion inside the restart, and the daemon's child (the stand-in for Chrome
 *        and ffmpeg) is **never signalled by the manager**.
 *     2. **`KillMode=control-group`, the default** — the same restart signals the child at the
 *        same instant as the daemon, which is ADR 0024's stated reason for the key, measured
 *        rather than asserted.
 *     3. **The drain over the socket** — the fixture route, then `Restart=on-failure` declining to
 *        restart an exit `0`, then `systemctl --user start` as the adapter's restart command.
 *     4. **`SIGTERM` to the main process** — the row's other half, reaching the same drain.
 *     5. **`TimeoutStopSec` is escalation, not a drain** — a stop whose budget is shorter than the
 *        drain ends in `SIGKILL` with the drain unfinished.
 *     6. **A non-zero exit is restarted** — without this contrast, "exit `0` is not restarted"
 *        would be a claim about a supervisor that never restarts anything.
 *
 *   macOS (launchd, `gui/<uid>`), against a **throwaway** LaunchAgent removed in a `finally`:
 *     7. **`kickstart` on a running job is a no-op**, which is why `-k` exists.
 *     8. **`SIGTERM` reaches the process**, so case 10's answer is about launchd and not about a
 *        process that cannot be signalled.
 *     9. **The drain over the socket**, then `KeepAlive{SuccessfulExit:false}` declining to
 *        restart an exit `0`, then `launchctl kickstart` as the adapter's restart command.
 *    10. **`launchctl kickstart -k` — the measurement ADR 0024 asks for.** Whether it signals or
 *        kills, whether the command waits for the drain, and what bounds the wait.
 *    11. **The bound, measured** — the same `-k` against a drain longer than `ExitTimeOut`, and,
 *        on the way there, that **`bootout` returns before the job it drained has gone**, which is
 *        what a reinstall has to wait out.
 *    12. **A non-zero exit is restarted**, the contrast that makes case 9's negative mean
 *        something.
 *
 *   Windows (Task Scheduler) — **written from the documentation and the plan, and never yet run**
 *   as of the ADR note this spike carries. It is the `[runner]` half: `windows-latest` is where it
 *   executes, and the note says so rather than implying a measurement nobody made. It registers a
 *   throwaway task under `\xplainer\`, runs it, asks the same fixture route over a **named pipe**,
 *   requires the task to end on exit `0` and `schtasks /Run` to start it again, and separately
 *   requires that a `SIGTERM` sent to the process is **not** catchable there — which is the whole
 *   reason the drain is a route rather than a signal.
 *
 * WHERE IT RUNS. On macOS it measures launchd directly and then boots
 * `infra/e2e/Dockerfile.systemd` — the image spike P2-S4 already builds, reused rather than
 * duplicated under a second tag — and re-executes *itself* inside it as an unprivileged user with
 * a per-user systemd manager. On a Linux host whose user manager is reachable it measures systemd
 * directly, which is what the `workflow_dispatch` job on `ubuntu-latest` runs. On Windows it runs
 * the Task Scheduler half.
 *
 * Environment it reads: `XPLAINER_DOCKER` (default `docker`) and `XPLAINER_P2S5_KEEP` (any
 * non-empty value leaves the container running for inspection). Nothing else — every socket, unit
 * file, LaunchAgent, scheduled task and scratch directory is created by the run and removed by it.
 *
 * Exit codes: `0` every expectation held; `1` one did not, or a platform the run needs could not
 * be reached, with the reason named on the last line.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/** This file, and the checkout three directories above it. */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");

/**
 * The image P2-S4 builds, reused rather than rebuilt under a second tag.
 *
 * Both spikes need the same thing — a booted systemd with a per-user manager — and a second
 * Dockerfile would be a second thing to keep correct. The container name is this spike's own, so
 * the two can be run side by side.
 */
const IMAGE = "xplainer-p2s4-systemd";
const DOCKERFILE = join(REPO, "infra", "e2e", "Dockerfile.systemd");
const CONTAINER = "xplainer-p2s5";

/** Where the outer half mounts the checkout, and who runs the inner half there. */
const CONTAINER_REPO = "/repo";
const CONTAINER_USER = "xplainer";
const CONTAINER_UID = 1000;

/** Set on the inner half so it measures rather than recursing into another container. */
const INSIDE_ENV = "XPLAINER_P2S5_INSIDE";

/** The Docker CLI. Overridable only so a machine with a differently named client can run this. */
const DOCKER = (process.env.XPLAINER_DOCKER ?? "").trim() || "docker";

/** Every unit, label and task this script creates starts with one of these, so cleanup is total. */
const UNIT_PREFIX = "p2s5-";
const LABEL_PREFIX = "video.xplainer.p2s5-";
const TASK_PREFIX = "\\xplainer\\p2s5-";

/**
 * The fake drain's duration, and the one long enough to outlast a stop budget.
 *
 * The real drain's cap is 20 s (ADR 0024). Nothing here needs to be that slow: what is being
 * measured is whether the supervisor *waits*, and 1.2 s is far enough above the millisecond noise
 * to answer that while keeping a full run under a minute.
 */
const DRAIN_MS = 1200;
const LONG_DRAIN_MS = 8000;

/** The stop budget cases 5 and 11 give a drain that will not fit inside it. */
const SHORT_STOP_SEC = 2;
const SHORT_EXIT_TIMEOUT_SEC = 3;

/** How long a poll waits for a listener, an exit or a restart, and how often it looks. */
const WAIT_MS = 15_000;
const POLL_INTERVAL_MS = 25;

/**
 * How long "it did not come back" is observed for.
 *
 * It has to exceed every restart delay in play — systemd's `RestartSec=2`, and the probe
 * LaunchAgent's `ThrottleInterval`, which this spike sets to 1 for exactly this reason (see
 * `PLIST_THROTTLE`).
 */
const NO_RESTART_WINDOW_MS = 5000;

function out(line = "") {
  process.stdout.write(`${line}\n`);
}

function section(title) {
  out();
  out(`── ${title} ${"─".repeat(Math.max(0, 94 - title.length))}`);
}

/** Every expectation the run made, in order, with the evidence that settled it. */
const checks = [];

function check(ok, label, detail) {
  checks.push({ ok, label, detail });
  out(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (detail !== undefined && detail !== "") {
    out(`        ${detail}`);
  }
}

function describe(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error !== undefined) {
    return { status: null, stdout: "", stderr: describe(result.error), failed: true };
  }
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    failed: result.status !== 0,
  };
}

/** The same, timed, because half the questions here are "did the command wait?". */
function timed(command, args, options = {}) {
  const started = process.hrtime.bigint();
  const result = run(command, args, options);
  return { ...result, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

function which(command) {
  if (process.platform === "win32") {
    return run("where", [command]).stdout.split("\n")[0]?.trim() ?? "";
  }
  return run("/bin/sh", ["-c", `command -v ${command} || true`]).stdout.trim();
}

function fixed(value, digits = 0) {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function unique(suffix) {
  return `${randomBytes(4).toString("hex")}-${suffix}`;
}

/**
 * THE FIXTURE (decision D5). A stand-in daemon, written into the scratch directory at run time.
 *
 * It is the smallest thing that makes the supervisor questions answerable: it binds one listener,
 * it answers one route by running a fake drain, it runs the same drain on `SIGTERM` where a
 * `SIGTERM` exists, and it writes a timestamped transcript so that "was it signalled?" and "did it
 * finish?" are read out of a file rather than inferred from timing. It also spawns one child that
 * ignores nothing and exits on nothing, which is what makes case 1's answer — the manager never
 * touched it — a measurement rather than an absence of evidence.
 *
 * `--listen` is a unix socket path on Linux and macOS and a `\\.\pipe\…` name on Windows; the two
 * are the same call in Node, which is why one fixture covers all three platforms.
 */
const STUB_SOURCE = `
import { spawn } from 'node:child_process';
import { appendFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1];
};

const transcript = option('--transcript');
const listen = option('--listen');
const drainMs = Number(option('--drain-ms') ?? '1200');
const childScript = option('--child');
const childTranscript = option('--child-transcript');
const isPipe = listen.startsWith('\\\\\\\\');

function note(event, detail = {}) {
  appendFileSync(
    transcript,
    JSON.stringify({ t: Date.now(), pid: process.pid, event, ...detail }) + '\\n',
  );
}

let child = null;
if (childScript !== null) {
  child = spawn(process.execPath, [childScript, childTranscript], { stdio: 'ignore' });
  note('child_spawned', { child_pid: child.pid });
}

let draining = false;
async function drain(cause) {
  if (draining) {
    return;
  }
  draining = true;
  note('drain_started', { cause });
  await new Promise((done) => setTimeout(done, drainMs));
  if (child !== null) {
    let killed = true;
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      killed = false;
    }
    note('child_killed', { killed });
  }
  if (!isPipe) {
    rmSync(listen, { force: true });
  }
  note('drain_completed', { cause });
  note('exit', { code: 0 });
  process.exit(0);
}

const server = createServer((req, res) => {
  if (req.url === '/api/daemon/drain') {
    res.writeHead(202).end('draining');
    void drain('route');
    return;
  }
  if (req.url === '/api/daemon/crash') {
    res.writeHead(202).end('crashing');
    note('exit', { code: 7 });
    setTimeout(() => process.exit(7), 20);
    return;
  }
  res.writeHead(200).end(JSON.stringify({ pid: process.pid }));
});

process.on('SIGTERM', () => {
  note('signal', { signal: 'SIGTERM' });
  void drain('sigterm');
});

if (!isPipe) {
  rmSync(listen, { force: true });
}
server.listen(listen, () => note('bound', { listen }));
`;

/**
 * The child: a stand-in for Chrome and ffmpeg, and the whole instrument of case 1 and case 2.
 *
 * It records every signal it receives and then exits, so that a supervisor which signals the whole
 * cgroup leaves a mark and one which signals only the main process leaves none. Exiting on the
 * signal rather than ignoring it keeps a stop job from waiting out its own timeout on a process
 * that is only here to be observed.
 */
const CHILD_SOURCE = `
import { appendFileSync } from 'node:fs';

const transcript = process.argv[2];
function note(event, detail = {}) {
  appendFileSync(
    transcript,
    JSON.stringify({ t: Date.now(), pid: process.pid, event, ...detail }) + '\\n',
  );
}

note('started');
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    note('signal', { signal });
    setTimeout(() => process.exit(0), 50);
  });
}
setInterval(() => {}, 1000);
`;

/** One request to the fixture over its own listener, resolved rather than thrown. */
async function ask(listen, path, method = "POST") {
  return await new Promise((done) => {
    const req = request({ socketPath: listen, path, method, timeout: 3000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => done({ status: res.statusCode ?? 0, body: body.trim() }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) => done({ status: 0, body: "", error: error.code ?? error.message }));
    req.end();
  });
}

/** Wait until the fixture answers on its listener, or give up and say what the last answer was. */
async function waitForListener(listen, timeoutMs = WAIT_MS) {
  const started = process.hrtime.bigint();
  for (;;) {
    const probe = await ask(listen, "/healthz", "GET");
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    if (probe.status === 200) {
      return { ok: true, ms: elapsedMs, probe };
    }
    if (elapsedMs > timeoutMs) {
      return { ok: false, ms: elapsedMs, probe };
    }
    await delay(POLL_INTERVAL_MS);
  }
}

/** The transcript as records, oldest first. A missing file is an empty run, not a crash. */
function transcriptOf(path) {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/** The pids that got as far as binding, in order — which is how "did it restart?" is answered. */
function instances(path) {
  return transcriptOf(path)
    .filter((record) => record.event === "bound")
    .map((record) => record.pid);
}

function eventsFor(path, pid) {
  return transcriptOf(path).filter((record) => record.pid === pid);
}

function hasEvent(records, event) {
  return records.some((record) => record.event === event);
}

function timeOf(records, event) {
  return records.find((record) => record.event === event)?.t ?? null;
}

/** Wait for a new listener to appear beyond the ones already seen. */
async function waitForInstance(path, known, timeoutMs = WAIT_MS) {
  const started = process.hrtime.bigint();
  for (;;) {
    const seen = instances(path);
    const fresh = seen.filter((pid) => !known.includes(pid));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    if (fresh.length > 0) {
      return { ok: true, pid: fresh[0], ms: elapsedMs };
    }
    if (elapsedMs > timeoutMs) {
      return { ok: false, pid: null, ms: elapsedMs };
    }
    await delay(POLL_INTERVAL_MS);
  }
}

/** Wait for a pid's transcript to record its own exit. */
async function waitForExit(path, pid, timeoutMs = WAIT_MS) {
  const started = process.hrtime.bigint();
  for (;;) {
    const records = eventsFor(path, pid);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    if (hasEvent(records, "exit")) {
      return { ok: true, ms: elapsedMs, records };
    }
    if (elapsedMs > timeoutMs) {
      return { ok: false, ms: elapsedMs, records };
    }
    await delay(POLL_INTERVAL_MS);
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// ── the fixture's files, and the scratch that holds them ─────────────────────────────────────

function writeFixtures(scratch) {
  const stub = join(scratch, "drain-stub.mjs");
  const child = join(scratch, "child-stand-in.mjs");
  writeFileSync(stub, STUB_SOURCE);
  writeFileSync(child, CHILD_SOURCE);
  return { stub, child };
}

/**
 * The paths one case needs: a listener, a transcript, and the child's transcript.
 *
 * The listener lives directly under the system temporary directory rather than under the scratch:
 * a unix socket path is capped at ~104 bytes on macOS, and a nested scratch path spends most of
 * that budget before the name is reached. Measured — a long path fails the bind with `EINVAL`,
 * which looks like a broken fixture and is not one.
 */
const listeners = [];

function caseFiles(scratch, label) {
  const listen =
    process.platform === "win32"
      ? `\\\\.\\pipe\\xplainer-${label}`
      : join(tmpdir(), `xp-${label}.sock`);
  listeners.push(listen);
  return {
    listen,
    transcript: join(scratch, `${label}.jsonl`),
    childTranscript: join(scratch, `${label}-child.jsonl`),
  };
}

function stubArgs(files, fixtures, drainMs, withChild) {
  const args = [
    fixtures.stub,
    "--listen",
    files.listen,
    "--transcript",
    files.transcript,
    "--drain-ms",
    String(drainMs),
  ];
  if (withChild) {
    args.push("--child", fixtures.child, "--child-transcript", files.childTranscript);
  }
  return args;
}

// ── Linux ────────────────────────────────────────────────────────────────────────────────────

function systemctl(...args) {
  return run("systemctl", ["--user", ...args]);
}

function unitDirectory() {
  const home = process.env.HOME;
  if (home === undefined || home === "") {
    throw new Error("HOME is unset, so there is no per-user unit directory to write to");
  }
  return join(home, ".config", "systemd", "user");
}

/** A unit file carrying the shipped keys, with only what a case varies passed in. */
function installUnit(name, options) {
  const lines = [
    "[Unit]",
    `Description=xplainer P2-S5 ${options.description}`,
    "",
    "[Service]",
    "Type=exec",
    `ExecStart=${options.execStart}`,
    `KillMode=${options.killMode}`,
    "KillSignal=SIGTERM",
    `TimeoutStopSec=${options.timeoutStopSec ?? 25}s`,
    "Restart=on-failure",
    "RestartSec=2",
    "",
  ];
  const directory = unitDirectory();
  run("mkdir", ["-p", directory]);
  writeFileSync(join(directory, `${name}.service`), `${lines.join("\n")}\n`, { mode: 0o644 });
  systemctl("daemon-reload");
}

function showUnit(name, properties) {
  const result = systemctl("show", `${name}.service`, ...properties.map((p) => `-p${p}`));
  const shown = {};
  for (const line of result.stdout.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) {
      shown[line.slice(0, index)] = line.slice(index + 1);
    }
  }
  return shown;
}

function stopUnit(name) {
  systemctl("stop", `${name}.service`);
  systemctl("reset-failed", `${name}.service`);
}

function removeUnits() {
  let directory = "";
  try {
    directory = unitDirectory();
  } catch {
    return;
  }
  if (!existsSync(directory)) {
    return;
  }
  for (const file of readdirSync(directory)) {
    if (file.startsWith(UNIT_PREFIX) && file.endsWith(".service")) {
      const name = file.replace(/\.service$/, "");
      stopUnit(name);
      rmSync(join(directory, file), { force: true });
    }
  }
  systemctl("daemon-reload");
}

/** Start a unit and wait for the fixture behind it to answer. */
async function startAndWait(name, files) {
  const started = timed("systemctl", ["--user", "start", `${name}.service`]);
  const ready = await waitForListener(files.listen);
  return { started, ready };
}

/**
 * Wait until the daemon's child has run far enough to be observable.
 *
 * The daemon answers `/healthz` a few milliseconds after it spawns the child, and the child needs
 * a Node start-up before it has written anything or installed a signal handler. Restarting the
 * unit in that window measures the race and not the kill mode — which is exactly what it did on
 * one run of this spike, leaving a case-2 child with no record of the SIGTERM it was too young to
 * catch. Both cases 1 and 2 wait here, so "the child recorded no signal" and "the child recorded
 * one" are statements about `KillMode` in both directions.
 */
async function waitForChild(files, daemonPid, timeoutMs = WAIT_MS) {
  const spawned = eventsFor(files.transcript, daemonPid).find(
    (record) => record.event === "child_spawned",
  );
  if (spawned === undefined) {
    return { ok: false, pid: null };
  }
  const started = process.hrtime.bigint();
  for (;;) {
    const seen = transcriptOf(files.childTranscript).some(
      (record) => record.pid === spawned.child_pid && record.event === "started",
    );
    if (seen) {
      return { ok: true, pid: spawned.child_pid };
    }
    if (Number(process.hrtime.bigint() - started) / 1e6 > timeoutMs) {
      return { ok: false, pid: spawned.child_pid };
    }
    await delay(POLL_INTERVAL_MS);
  }
}

/** The six systemd cases. */
async function measureSystemd(scratch) {
  section("host");
  out(`  ${run("systemctl", ["--version"]).stdout.split("\n")[0] ?? ""}`);
  out(
    `  manager: --user, uid ${process.getuid?.() ?? "?"}, XDG_RUNTIME_DIR=${
      process.env.XDG_RUNTIME_DIR ?? "<unset>"
    }`,
  );
  out(`  node:    ${process.version} on ${process.platform}/${process.arch}`);

  const state = systemctl("is-system-running").stdout.trim();
  out(`  systemctl --user is-system-running: ${state}`);
  if (state !== "running" && state !== "degraded" && state !== "starting") {
    out("REFUSED: no per-user systemd manager is reachable, so there is nothing to measure.");
    return 1;
  }

  const fixtures = writeFixtures(scratch);
  const node = process.execPath;

  // ── 1 ──────────────────────────────────────────────────────────────────────────────────────
  section("case 1 — KillMode=mixed: the restart drains, and the child is never signalled");
  const mixedName = `${UNIT_PREFIX}mixed`;
  const mixed = caseFiles(scratch, unique("mixed"));
  installUnit(mixedName, {
    description: "KillMode=mixed, as T9 renders it",
    killMode: "mixed",
    execStart: `${node} ${stubArgs(mixed, fixtures, DRAIN_MS, true).join(" ")}`,
  });
  const mixedStart = await startAndWait(mixedName, mixed);
  const mixedFirst = instances(mixed.transcript)[0] ?? 0;
  const mixedChildPid = await waitForChild(mixed, mixedFirst);
  out(
    `  started: pid ${mixedFirst} with child ${String(mixedChildPid.pid)}, answering after ` +
      `${fixed(mixedStart.ready.ms)} ms`,
  );
  const mixedRestart = timed("systemctl", ["--user", "restart", `${mixedName}.service`]);
  const mixedDrained = await waitForExit(mixed.transcript, mixedFirst);
  const mixedBack = await waitForInstance(mixed.transcript, [mixedFirst]);
  const mixedRecords = eventsFor(mixed.transcript, mixedFirst);
  const mixedChild = eventsFor(mixed.childTranscript, mixedChildPid.pid);
  out(`  systemctl --user restart returned after ${fixed(mixedRestart.ms)} ms`);
  out(`  the daemon's own record: ${mixedRecords.map((r) => r.event).join(" → ")}`);
  out(
    `  the child's record:      ${
      mixedChild.length === 0
        ? "<nothing>"
        : mixedChild
            .map((r) => `${r.event}${r.signal === undefined ? "" : `(${r.signal})`}`)
            .join(" → ")
    }`,
  );
  check(
    hasEvent(mixedRecords, "signal") &&
      hasEvent(mixedRecords, "drain_completed") &&
      mixedDrained.ok,
    "a supervisor-initiated restart reaches the drain, and the drain finishes",
    `SIGTERM → drain → exit 0, inside a restart that took ${fixed(mixedRestart.ms)} ms`,
  );
  check(
    mixedRestart.ms >= DRAIN_MS,
    "and the restart waited for it rather than racing it",
    `${fixed(mixedRestart.ms)} ms against a ${DRAIN_MS} ms drain`,
  );
  check(
    mixedChildPid.ok && !mixedChild.some((record) => record.event === "signal"),
    "KillMode=mixed signalled only the main process: the child recorded no signal at all",
    "the child had already started and installed its handlers before the restart, so this is an " +
      "absence and not a race — the daemon stays responsible for killing Chrome and ffmpeg",
  );
  check(
    mixedBack.ok,
    "and the unit came back up behind the same restart",
    `new pid ${String(mixedBack.pid)} after ${fixed(mixedBack.ms)} ms`,
  );
  stopUnit(mixedName);

  // ── 2 ──────────────────────────────────────────────────────────────────────────────────────
  section(
    "case 2 — the default KillMode=control-group: the child is signalled at the same instant",
  );
  const groupName = `${UNIT_PREFIX}control-group`;
  const group = caseFiles(scratch, unique("cgroup"));
  installUnit(groupName, {
    description: "KillMode=control-group, the systemd default",
    killMode: "control-group",
    execStart: `${node} ${stubArgs(group, fixtures, DRAIN_MS, true).join(" ")}`,
  });
  await startAndWait(groupName, group);
  const groupFirst = instances(group.transcript)[0] ?? 0;
  const groupChildPid = await waitForChild(group, groupFirst);
  timed("systemctl", ["--user", "restart", `${groupName}.service`]);
  await waitForExit(group.transcript, groupFirst);
  const groupRecords = eventsFor(group.transcript, groupFirst);
  const groupChild = eventsFor(group.childTranscript, groupChildPid.pid);
  const daemonSignal = timeOf(groupRecords, "signal");
  const childSignal = groupChild.find((record) => record.event === "signal")?.t ?? null;
  const skew = daemonSignal === null || childSignal === null ? null : childSignal - daemonSignal;
  out(
    `  the child's record: ${
      groupChild
        .map((r) => `${r.event}${r.signal === undefined ? "" : `(${r.signal})`}`)
        .join(" → ") || "<nothing>"
    }`,
  );
  out(`  daemon SIGTERM at ${String(daemonSignal)}, child SIGTERM at ${String(childSignal)}`);
  check(
    groupChildPid.ok && childSignal !== null && skew !== null && Math.abs(skew) <= 250,
    "the default signals Chrome and ffmpeg at the same instant as the daemon",
    `skew ${skew === null ? "n/a" : `${String(skew)} ms`} — ADR 0024's "simultaneous execution ` +
      `with a longer countdown", measured`,
  );
  stopUnit(groupName);

  // ── 3 ──────────────────────────────────────────────────────────────────────────────────────
  section("case 3 — the drain over the socket, and what does not happen after exit 0");
  const routeName = `${UNIT_PREFIX}route`;
  const route = caseFiles(scratch, unique("route"));
  installUnit(routeName, {
    description: "the application-level drain over the IPC listener",
    killMode: "mixed",
    execStart: `${node} ${stubArgs(route, fixtures, DRAIN_MS, false).join(" ")}`,
  });
  await startAndWait(routeName, route);
  const routeFirst = instances(route.transcript)[0] ?? 0;
  const asked = await ask(route.listen, "/api/daemon/drain");
  const routeExit = await waitForExit(route.transcript, routeFirst);
  out(`  POST /api/daemon/drain over ${route.listen} → ${String(asked.status)} ${asked.body}`);
  check(
    asked.status === 202 && routeExit.ok && hasEvent(routeExit.records, "drain_completed"),
    "the fixture route runs the drain and the daemon exits 0",
    "no signal involved, which is the shape Windows needs and the other two share",
  );
  await delay(NO_RESTART_WINDOW_MS);
  const routeAfter = showUnit(routeName, ["ActiveState", "Result", "MainPID", "NRestarts"]);
  out(
    `  after ${NO_RESTART_WINDOW_MS} ms: ActiveState=${routeAfter.ActiveState} ` +
      `Result=${routeAfter.Result} MainPID=${routeAfter.MainPID} NRestarts=${routeAfter.NRestarts}`,
  );
  check(
    routeAfter.ActiveState === "inactive" &&
      routeAfter.Result === "success" &&
      instances(route.transcript).length === 1,
    "Restart=on-failure does not restart an exit 0, so the drain is the daemon's own decision",
    `observed for ${NO_RESTART_WINDOW_MS} ms, which is above RestartSec=2`,
  );
  const restartCommand = timed("systemctl", ["--user", "start", `${routeName}.service`]);
  const routeBack = await waitForInstance(route.transcript, [routeFirst]);
  const routeProbe = await waitForListener(route.listen);
  out(`  systemctl --user start returned after ${fixed(restartCommand.ms)} ms`);
  check(
    restartCommand.status === 0 && routeBack.ok && routeProbe.ok,
    "`systemctl --user start` is the Linux restart adapter, and the daemon answers again",
    `new pid ${String(routeBack.pid)}, answering ${routeProbe.probe.body}`,
  );

  // ── 4 ──────────────────────────────────────────────────────────────────────────────────────
  section("case 4 — SIGTERM to the main process reaches the same drain");
  const signalPid = Number(showUnit(routeName, ["MainPID"]).MainPID ?? "0");
  process.kill(signalPid, "SIGTERM");
  const signalExit = await waitForExit(route.transcript, signalPid);
  await delay(NO_RESTART_WINDOW_MS);
  const signalAfter = showUnit(routeName, ["ActiveState", "Result"]);
  out(`  the daemon's record: ${signalExit.records.map((r) => r.event).join(" → ")}`);
  out(`  ActiveState=${signalAfter.ActiveState} Result=${signalAfter.Result}`);
  check(
    signalExit.ok &&
      hasEvent(signalExit.records, "signal") &&
      hasEvent(signalExit.records, "drain_completed") &&
      signalAfter.ActiveState === "inactive",
    "the Linux row's second half — a plain SIGTERM — reaches the drain and is not restarted",
    "which is the fallback that exists on this platform and on neither of the others",
  );
  stopUnit(routeName);

  // ── 5 ──────────────────────────────────────────────────────────────────────────────────────
  section("case 5 — TimeoutStopSec supplies escalation, not a drain");
  const timeoutName = `${UNIT_PREFIX}timeout`;
  const timeoutFiles = caseFiles(scratch, unique("timeout"));
  installUnit(timeoutName, {
    description: "a stop budget shorter than the drain",
    killMode: "mixed",
    timeoutStopSec: SHORT_STOP_SEC,
    execStart: `${node} ${stubArgs(timeoutFiles, fixtures, LONG_DRAIN_MS, false).join(" ")}`,
  });
  await startAndWait(timeoutName, timeoutFiles);
  const timeoutPid = instances(timeoutFiles.transcript)[0] ?? 0;
  const stopped = timed("systemctl", ["--user", "stop", `${timeoutName}.service`]);
  const timeoutRecords = eventsFor(timeoutFiles.transcript, timeoutPid);
  const timeoutShown = showUnit(timeoutName, ["ActiveState", "Result"]);
  out(`  systemctl --user stop returned after ${fixed(stopped.ms)} ms`);
  out(`  the daemon's record: ${timeoutRecords.map((r) => r.event).join(" → ")}`);
  out(`  ActiveState=${timeoutShown.ActiveState} Result=${timeoutShown.Result}`);
  check(
    hasEvent(timeoutRecords, "drain_started") &&
      !hasEvent(timeoutRecords, "drain_completed") &&
      !alive(timeoutPid),
    `TimeoutStopSec=${SHORT_STOP_SEC}s against a ${LONG_DRAIN_MS} ms drain kills it mid-drain`,
    `stop returned in ${fixed(stopped.ms)} ms with Result=${timeoutShown.Result}; the shipped ` +
      "45 s is what has to exceed the 20 s drain, and it is the escalation and never the mechanism",
  );
  stopUnit(timeoutName);

  // ── 6 ──────────────────────────────────────────────────────────────────────────────────────
  section("case 6 — the contrast: a non-zero exit IS restarted");
  const crashName = `${UNIT_PREFIX}crash`;
  const crash = caseFiles(scratch, unique("crash"));
  installUnit(crashName, {
    description: "Restart=on-failure against a non-zero exit",
    killMode: "mixed",
    execStart: `${node} ${stubArgs(crash, fixtures, DRAIN_MS, false).join(" ")}`,
  });
  await startAndWait(crashName, crash);
  const crashFirst = instances(crash.transcript)[0] ?? 0;
  await ask(crash.listen, "/api/daemon/crash");
  const crashBack = await waitForInstance(crash.transcript, [crashFirst]);
  const crashShown = showUnit(crashName, ["NRestarts", "ActiveState"]);
  out(
    `  exit 7 → new pid ${String(crashBack.pid)} after ${fixed(crashBack.ms)} ms, ` +
      `NRestarts=${crashShown.NRestarts}`,
  );
  check(
    crashBack.ok && Number(crashShown.NRestarts ?? "0") >= 1,
    "Restart=on-failure restarts a crash, so case 3's negative discriminates",
    "the unit distinguishes a drain from a death; it is not a unit that never restarts anything",
  );
  stopUnit(crashName);

  return 0;
}

// ── macOS ────────────────────────────────────────────────────────────────────────────────────

/**
 * The probe LaunchAgent's throttle, and why it is not the shipped 30.
 *
 * `ThrottleInterval` bounds how soon launchd will start a job again. The shipped plist sets 30,
 * and this spike's negative — "an exit 0 was not restarted" — is only as strong as the window it
 * was observed for. Setting 1 makes a restart, if one were coming, arrive inside a five-second
 * window; case 12 shows one arriving. Observing the shipped 30 would mean a 30-second wait to
 * reach a weaker conclusion.
 */
const PLIST_THROTTLE = 1;

function launchctl(...args) {
  return run("launchctl", args);
}

function agentDirectory() {
  return join(homedir(), "Library", "LaunchAgents");
}

function plistPathFor(label) {
  return join(agentDirectory(), `${label}.plist`);
}

function plistBody(label, argv, options) {
  const args = argv.map((value) => `    <string>${value}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>${PLIST_THROTTLE}</integer>
  <key>ExitTimeOut</key><integer>${options.exitTimeout}</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${options.log}</string>
  <key>StandardErrorPath</key><string>${options.log}</string>
</dict>
</plist>
`;
}

/** `launchctl print gui/<uid>/<label>`, reduced to the three lines a case reads. */
function printJob(uid, label) {
  const result = launchctl("print", `gui/${uid}/${label}`);
  const shown = { present: !result.failed, state: "", pid: null, lastExit: "" };
  for (const line of result.stdout.split("\n")) {
    const text = line.trim();
    if (text.startsWith("state = ") && shown.state === "") {
      shown.state = text.slice("state = ".length);
    }
    if (text.startsWith("pid = ") && shown.pid === null) {
      shown.pid = Number(text.slice("pid = ".length));
    }
    if (text.startsWith("last exit code = ") && shown.lastExit === "") {
      shown.lastExit = text.slice("last exit code = ".length);
    }
  }
  return shown;
}

/**
 * Wait for a label to leave its domain.
 *
 * `bootout` returns before the job has exited — case 11 measures that — and it matters: a
 * `bootstrap` issued in that gap fails with "Bootstrap failed: 5: Input/output error", which reads
 * like a malformed plist and is not one. Everything that re-bootstraps in this file waits here.
 */
async function waitForAbsence(uid, label, timeoutMs = WAIT_MS) {
  const started = process.hrtime.bigint();
  for (;;) {
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    if (!printJob(uid, label).present) {
      return { ok: true, ms: elapsedMs };
    }
    if (elapsedMs > timeoutMs) {
      return { ok: false, ms: elapsedMs };
    }
    await delay(POLL_INTERVAL_MS);
  }
}

async function bootout(uid, label, timeoutMs = WAIT_MS) {
  launchctl("bootout", `gui/${uid}/${label}`);
  return (await waitForAbsence(uid, label, timeoutMs)).ok;
}

/** Remove every LaunchAgent this spike — or a crashed earlier run of it — left behind. */
async function removeAgents(uid) {
  const directory = agentDirectory();
  if (!existsSync(directory)) {
    return;
  }
  for (const file of readdirSync(directory)) {
    if (file.startsWith(LABEL_PREFIX) && file.endsWith(".plist")) {
      const label = file.replace(/\.plist$/, "");
      await bootout(uid, label, 5000);
      rmSync(join(directory, file), { force: true });
    }
  }
}

/** The six launchd cases, against one throwaway label. */
async function measureLaunchd(scratch) {
  const uid = process.getuid?.() ?? 0;
  section("host");
  out(
    `  ${run("sw_vers", ["-productName"]).stdout.trim()} ${run("sw_vers", ["-productVersion"]).stdout.trim()}`,
  );
  out(`  domain:  gui/${uid}`);
  out(`  node:    ${process.version} on ${process.platform}/${process.arch}`);

  const fixtures = writeFixtures(scratch);
  const label = `${LABEL_PREFIX}${randomBytes(4).toString("hex")}`;
  const files = caseFiles(scratch, unique("launchd"));
  const log = join(scratch, "launchd.log");
  const plist = plistPathFor(label);
  out(`  label:   ${label} (throwaway; booted out and deleted by this run)`);

  run("mkdir", ["-p", agentDirectory()]);
  writeFileSync(
    plist,
    plistBody(label, [process.execPath, ...stubArgs(files, fixtures, DRAIN_MS, false)], {
      exitTimeout: 45,
      log,
    }),
    { mode: 0o600 },
  );

  // ── 7 ──────────────────────────────────────────────────────────────────────────────────────
  section("case 7 — bootstrap, and `kickstart` on a job that is already running");
  const bootstrapped = launchctl("bootstrap", `gui/${uid}`, plist);
  const ready = await waitForListener(files.listen);
  if (!ready.ok) {
    out(`  ${readFileSync(log, "utf8").trim() || "<no output>"}`);
    check(false, "the probe LaunchAgent starts", `bootstrap rc=${String(bootstrapped.status)}`);
    return 1;
  }
  const firstPid = instances(files.transcript)[0] ?? 0;
  out(
    `  bootstrap rc=${String(bootstrapped.status)}, pid ${firstPid} answering after ${fixed(ready.ms)} ms`,
  );
  const plainKickstart = timed("launchctl", ["kickstart", `gui/${uid}/${label}`]);
  await delay(1000);
  check(
    plainKickstart.status === 0 && instances(files.transcript).length === 1,
    "`launchctl kickstart` on a running job is a no-op: it starts, it does not restart",
    `returned 0 after ${fixed(plainKickstart.ms)} ms and the same pid is still serving — which is ` +
      "why the adapter's restart command is only the restart half of the pair",
  );

  // ── 8 ──────────────────────────────────────────────────────────────────────────────────────
  section("case 8 — a plain SIGTERM reaches the drain (the control for case 10)");
  process.kill(firstPid, "SIGTERM");
  const signalled = await waitForExit(files.transcript, firstPid);
  out(`  the daemon's record: ${signalled.records.map((r) => r.event).join(" → ")}`);
  check(
    signalled.ok &&
      hasEvent(signalled.records, "signal") &&
      hasEvent(signalled.records, "drain_completed"),
    "this process does receive and act on a SIGTERM on macOS",
    "so an absence of one under `kickstart -k` would be launchd's behaviour and not the fixture's",
  );
  launchctl("kickstart", `gui/${uid}/${label}`);
  const afterSignal = await waitForInstance(files.transcript, [firstPid]);
  check(
    afterSignal.ok,
    "and the job starts again on demand, which is how the next case gets an instance",
    `new pid ${String(afterSignal.pid)} after ${fixed(afterSignal.ms)} ms — note that the signal ` +
      "did not bring it back: the drain's exit 0 is a successful exit, which is case 9",
  );

  // ── 9 ──────────────────────────────────────────────────────────────────────────────────────
  section("case 9 — the drain over the socket, and KeepAlive{SuccessfulExit:false} after exit 0");
  const running = instances(files.transcript);
  const routePid = running[running.length - 1] ?? 0;
  await waitForListener(files.listen);
  const asked = await ask(files.listen, "/api/daemon/drain");
  const drained = await waitForExit(files.transcript, routePid);
  out(`  POST /api/daemon/drain over ${files.listen} → ${String(asked.status)} ${asked.body}`);
  check(
    asked.status === 202 && drained.ok && hasEvent(drained.records, "drain_completed"),
    "the same fixture route runs the same drain on macOS",
    "one application-level operation, which is the whole shape of the adapter table",
  );
  await delay(NO_RESTART_WINDOW_MS);
  const stoppedJob = printJob(uid, label);
  out(
    `  after ${NO_RESTART_WINDOW_MS} ms: state = ${stoppedJob.state}, last exit code = ${stoppedJob.lastExit}`,
  );
  check(
    instances(files.transcript).length === running.length && stoppedJob.pid === null,
    "KeepAlive{SuccessfulExit:false} does not restart an exit 0",
    `observed for ${NO_RESTART_WINDOW_MS} ms against ThrottleInterval=${PLIST_THROTTLE}`,
  );
  const kickstart = timed("launchctl", ["kickstart", `gui/${uid}/${label}`]);
  const restarted = await waitForInstance(files.transcript, running);
  const probe = await waitForListener(files.listen);
  check(
    kickstart.status === 0 && restarted.ok && probe.ok,
    `\`launchctl kickstart gui/${uid}/<label>\` is the macOS restart adapter`,
    `returned 0 after ${fixed(kickstart.ms)} ms; new pid ${String(restarted.pid)} answering ${probe.probe.body}`,
  );

  // ── 10 ─────────────────────────────────────────────────────────────────────────────────────
  section("case 10 — what `launchctl kickstart -k` actually does (ADR 0024 asks for this one)");
  const before = instances(files.transcript);
  const killPid = before[before.length - 1] ?? 0;
  const kicked = timed("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`]);
  const kickedRecords = eventsFor(files.transcript, killPid);
  const kickedBack = await waitForInstance(files.transcript, before);
  out(`  launchctl kickstart -k returned after ${fixed(kicked.ms)} ms`);
  out(
    `  the old instance's record: ${kickedRecords.map((r) => r.event).join(" → ") || "<nothing>"}`,
  );
  const graceful = hasEvent(kickedRecords, "signal") && hasEvent(kickedRecords, "drain_completed");
  check(
    graceful,
    "`kickstart -k` sends SIGTERM first: the old instance drained and exited 0",
    "the manual documents it only as kill-and-restart; this is the behaviour, measured",
  );
  check(
    kicked.ms >= DRAIN_MS,
    "and the command itself waits for the drain rather than returning over it",
    `${fixed(kicked.ms)} ms against a ${DRAIN_MS} ms drain`,
  );
  check(
    kickedBack.ok,
    "then the same command starts the replacement",
    `new pid ${String(kickedBack.pid)} after ${fixed(kickedBack.ms)} ms`,
  );

  // ── 11 ─────────────────────────────────────────────────────────────────────────────────────
  section(
    `case 11 — the bound on that grace: ExitTimeOut=${SHORT_EXIT_TIMEOUT_SEC} against a ${LONG_DRAIN_MS} ms drain`,
  );
  const booted = timed("launchctl", ["bootout", `gui/${uid}/${label}`]);
  const stillThere = printJob(uid, label).present;
  const left = await waitForAbsence(uid, label);
  out(
    `  launchctl bootout returned after ${fixed(booted.ms)} ms; the label left the domain after ` +
      `${fixed(left.ms)} ms`,
  );
  check(
    booted.ms < DRAIN_MS && stillThere && left.ok,
    "`launchctl bootout` returns before the job it is draining has gone",
    "a bootstrap issued in that gap fails with `Bootstrap failed: 5: Input/output error`, which " +
      "reads like a malformed plist — T12's uninstall and reinstall paths have to wait this out",
  );
  const slowFiles = caseFiles(scratch, unique("launchd-slow"));
  writeFileSync(
    plist,
    plistBody(label, [process.execPath, ...stubArgs(slowFiles, fixtures, LONG_DRAIN_MS, false)], {
      exitTimeout: SHORT_EXIT_TIMEOUT_SEC,
      log,
    }),
    { mode: 0o600 },
  );
  const reBootstrapped = launchctl("bootstrap", `gui/${uid}`, plist);
  const slowReady = await waitForListener(slowFiles.listen);
  if (!slowReady.ok) {
    out(`  ${readFileSync(log, "utf8").trim() || "<no output>"}`);
    check(
      false,
      "the slow-drain LaunchAgent starts",
      `bootstrap rc=${String(reBootstrapped.status)}`,
    );
    return 1;
  }
  const slowPid = instances(slowFiles.transcript)[0] ?? 0;
  const slowKick = timed("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`]);
  const slowRecords = eventsFor(slowFiles.transcript, slowPid);
  const slowBack = await waitForInstance(slowFiles.transcript, [slowPid]);
  out(`  launchctl kickstart -k returned after ${fixed(slowKick.ms)} ms`);
  out(`  the old instance's record: ${slowRecords.map((r) => r.event).join(" → ") || "<nothing>"}`);
  check(
    hasEvent(slowRecords, "signal") &&
      !hasEvent(slowRecords, "drain_completed") &&
      slowKick.ms < LONG_DRAIN_MS,
    `the grace is bounded by ExitTimeOut: at ${SHORT_EXIT_TIMEOUT_SEC}s the drain is killed mid-way`,
    `returned in ${fixed(slowKick.ms)} ms — so the shipped ExitTimeOut=45 is what has to exceed ` +
      "ADR 0024's 20 s drain, exactly as TimeoutStopSec=45s does on Linux",
  );
  check(
    slowBack.ok,
    "and the replacement starts either way",
    `new pid ${String(slowBack.pid)} after ${fixed(slowBack.ms)} ms`,
  );

  // ── 12 ─────────────────────────────────────────────────────────────────────────────────────
  section("case 12 — the contrast: a non-zero exit IS restarted");
  const beforeCrash = instances(slowFiles.transcript);
  await waitForListener(slowFiles.listen);
  await ask(slowFiles.listen, "/api/daemon/crash");
  const crashBack = await waitForInstance(slowFiles.transcript, beforeCrash);
  check(
    crashBack.ok,
    "KeepAlive{SuccessfulExit:false} restarts an exit 7, so case 9's negative discriminates",
    `new pid ${String(crashBack.pid)} after ${fixed(crashBack.ms)} ms`,
  );

  return 0;
}

// ── Windows ──────────────────────────────────────────────────────────────────────────────────

/**
 * The Task Scheduler half.
 *
 * **Never yet run.** No Windows host was reachable from the session that wrote this, so unlike
 * every other case in this file it is derived from `schtasks` documentation and the plan's adapter
 * table rather than from a measurement. `windows-latest` is where it becomes evidence; ADR 0024's
 * note says so in as many words rather than presenting the row as settled.
 *
 * What it asserts is the same shape as the other two platforms — the fixture route runs the drain,
 * the supervisor does not bring an exit `0` back on its own, and one named command starts it
 * again — plus the fact that gives Windows a drain at all: a `SIGTERM` there is a
 * `TerminateProcess`, so the process dies with no handler run and no drain, which is why the route
 * over the named pipe is the mechanism and not a fallback.
 */
async function measureWindows(scratch) {
  section("host");
  out(`  node:    ${process.version} on ${process.platform}/${process.arch}`);
  out(`  ${run("cmd", ["/c", "ver"]).stdout.trim()}`);
  out("  NOTE: this arm is the [runner] half — written from the documentation, proven here.");

  if (which("schtasks") === "") {
    out("REFUSED: schtasks is not on PATH, so there is no Task Scheduler to measure.");
    return 1;
  }

  const fixtures = writeFixtures(scratch);
  const task = `${TASK_PREFIX}${randomBytes(4).toString("hex")}`;
  const files = caseFiles(scratch, unique("schtasks"));

  // The action is a .cmd shim rather than a bare command line: `/TR` is capped at 261 characters
  // and every path here is absolute, so the argv would not reliably fit.
  const shim = join(scratch, "run-stub.cmd");
  writeFileSync(
    shim,
    `@echo off\r\n"${process.execPath}" ${stubArgs(files, fixtures, DRAIN_MS, false)
      .map((value) => `"${value}"`)
      .join(" ")}\r\n`,
  );

  try {
    // ── 13 ───────────────────────────────────────────────────────────────────────────────────
    section("case 13 — register a throwaway task, run it, and reach the fixture over the pipe");
    const created = run("schtasks", [
      "/Create",
      "/TN",
      task,
      "/TR",
      shim,
      "/SC",
      "ONCE",
      "/ST",
      "23:59",
      "/F",
    ]);
    if (created.failed) {
      out(`  ${(created.stderr || created.stdout).trim()}`);
      check(
        false,
        "the throwaway task registers",
        `schtasks /Create exited ${String(created.status)}`,
      );
      return 1;
    }
    const first = run("schtasks", ["/Run", "/TN", task]);
    const ready = await waitForListener(files.listen);
    const firstPid = instances(files.transcript)[0] ?? 0;
    out(
      `  schtasks /Run rc=${String(first.status)}; pid ${firstPid} answering after ${fixed(ready.ms)} ms`,
    );
    check(
      first.status === 0 && ready.ok,
      "the task starts the fixture and it binds its named pipe",
      files.listen,
    );

    // ── 14 ───────────────────────────────────────────────────────────────────────────────────
    section("case 14 — a SIGTERM on Windows is not catchable, which is why the route exists");
    const beforeSignal = transcriptOf(files.transcript).length;
    try {
      process.kill(firstPid, "SIGTERM");
    } catch {
      // A pid that has already gone is answered by the checks below, not by this call.
    }
    await delay(1000);
    const signalRecords = eventsFor(files.transcript, firstPid);
    out(`  the daemon's record: ${signalRecords.map((r) => r.event).join(" → ")}`);
    check(
      !alive(firstPid) &&
        !hasEvent(signalRecords, "signal") &&
        !hasEvent(signalRecords, "drain_completed"),
      "the process is terminated with no handler run and no drain",
      `${String(transcriptOf(files.transcript).length - beforeSignal)} new records — Node maps ` +
        "SIGTERM to TerminateProcess there, so a signal is a kill and never a drain",
    );

    // ── 15 ───────────────────────────────────────────────────────────────────────────────────
    section("case 15 — the drain over the named pipe, the task ending, and /Run as the adapter");
    const second = run("schtasks", ["/Run", "/TN", task]);
    const back = await waitForInstance(files.transcript, [firstPid]);
    await waitForListener(files.listen);
    check(
      second.status === 0 && back.ok,
      `\`schtasks /Run /TN "${task}"\` is the Windows restart adapter`,
      `new pid ${String(back.pid)} after ${fixed(back.ms)} ms`,
    );
    const drainPid = back.pid ?? 0;
    const asked = await ask(files.listen, "/api/daemon/drain");
    const drained = await waitForExit(files.transcript, drainPid);
    out(`  POST /api/daemon/drain over the pipe → ${String(asked.status)} ${asked.body}`);
    check(
      asked.status === 202 && drained.ok && hasEvent(drained.records, "drain_completed"),
      "the same fixture route runs the same drain over a named pipe",
      "one application-level operation on all three platforms, which is ADR 0024's decision",
    );
    await delay(NO_RESTART_WINDOW_MS);
    const status = run("schtasks", ["/Query", "/TN", task, "/FO", "LIST"]).stdout;
    const statusLine = status
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("Status:"));
    out(`  ${statusLine ?? "<no Status line>"}`);
    check(
      instances(files.transcript).length === 2,
      "the task ends on exit 0 and nothing brings it back on its own",
      `observed for ${NO_RESTART_WINDOW_MS} ms; ${statusLine ?? "no Status line"}`,
    );
    return 0;
  } finally {
    run("schtasks", ["/End", "/TN", task]);
    run("schtasks", ["/Delete", "/TN", task, "/F"]);
  }
}

// ── the table, the decision, and the exit code ───────────────────────────────────────────────

function adapterTable() {
  section("the adapter table, with its three restart commands");
  const rows = [
    ["", "ask for the drain", "response to exit 0", "restart command"],
    [
      "Linux",
      "POST /api/daemon/drain over the",
      "Restart=on-failure does not",
      "systemctl --user start xplainer",
    ],
    ["", "socket, or SIGTERM to the main process", "restart", ""],
    [
      "macOS",
      "the same route over the same socket",
      "KeepAlive{SuccessfulExit:false}",
      "launchctl kickstart gui/$(id -u)/",
    ],
    ["", "", "does not restart", "video.xplainer.daemon"],
    [
      "Windows",
      "the same route over the named pipe",
      "the task ends",
      'schtasks /Run /TN "\\xplainer\\',
    ],
    ["", "", "", '<user>-daemon"'],
  ];
  for (const row of rows) {
    out(`  ${row[0].padEnd(9)}${row[1].padEnd(41)}${row[2].padEnd(34)}${row[3]}`);
  }
}

function decision() {
  section("decision");
  for (const line of [
    "One application-level drain, reached through the IPC listener, and three adapters that differ",
    "only in how the supervisor is asked to start again. ADR 0024's §Drain keeps its behaviour and",
    "its 20-second cap; what this spike settles is the mechanics under it.",
    "",
    "  * Linux: KillMode=mixed is REQUIRED, and the reason is measured rather than argued. Under",
    "    the default control-group the child was signalled in the same millisecond as the daemon;",
    "    under mixed it was never signalled at all. TimeoutStopSec is escalation — a budget shorter",
    "    than the drain ends in SIGKILL with the drain unfinished — so the shipped 45s is what has",
    "    to exceed the 20 s cap, and `systemctl --user start` is the restart command because",
    "    Restart=on-failure declines an exit 0.",
    "  * macOS: `launchctl kickstart -k` IS graceful. It sends SIGTERM, waits for the process, and",
    "    the command itself blocks for the drain's duration; the wait is bounded by ExitTimeOut,",
    "    measured by shortening it. So the shipped ExitTimeOut=45 is the macOS counterpart of",
    "    TimeoutStopSec=45s. `kickstart` WITHOUT -k is a no-op on a running job, which is what",
    "    makes it the clean restart half after a drain the daemon has already taken.",
    "  * Windows: the route over the named pipe is the mechanism, and there is no fallback: a",
    "    SIGTERM there is a TerminateProcess, so a signal is a kill. `schtasks /Run` is the restart.",
    "",
    "The drain is asked for over the listener on all three, and the restart is the only difference —",
    "which is what gives Windows a drain at all.",
  ]) {
    out(`  ${line}`);
  }
}

function summarise() {
  section("checks");
  const failed = checks.filter((entry) => entry.ok === false);
  out(`  ${checks.length - failed.length}/${checks.length} expectations held`);
  for (const entry of failed) {
    out(`  FAILED: ${entry.label}`);
  }
  out();
  out(
    failed.length === 0 ? "P2-S5: every expectation held." : "P2-S5: an expectation did not hold.",
  );
  return failed.length === 0 ? 0 : 1;
}

// ── the container, for a macOS or Windows developer who has no systemd ───────────────────────

function docker(args, label) {
  const result = run(DOCKER, args);
  if (result.failed) {
    out(`  ${DOCKER} ${args.slice(0, 3).join(" ")} …`);
    out(`  ${(result.stderr || result.stdout).trim()}`);
    throw new Error(`${label} failed`);
  }
  return result;
}

function dockerQuietly(args) {
  run(DOCKER, args);
}

/** Run the inner half in the container, forwarding its transcript through this process. */
async function execInside() {
  return await new Promise((done) => {
    const child = spawn(
      DOCKER,
      [
        "exec",
        "--user",
        CONTAINER_USER,
        "--env",
        "HOME=/home/xplainer",
        "--env",
        `XDG_RUNTIME_DIR=/run/user/${CONTAINER_UID}`,
        "--env",
        `${INSIDE_ENV}=1`,
        CONTAINER,
        "/usr/local/bin/node",
        `${CONTAINER_REPO}/apps/cli/spikes/p2-s5-drain.mjs`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("close", (code, signal) => done(code ?? (signal ? 1 : 1)));
    child.on("error", () => done(1));
  });
}

/**
 * Boot the systemd P2-S4 already builds an image for, and re-execute this file inside it.
 *
 * The image COPYs nothing, so it is built against an empty context: sending the repository as a
 * build context would cost more than the whole measurement.
 */
async function viaContainer() {
  section("the Linux half — booting the systemd this host does not have");
  if (which(DOCKER) === "") {
    out(`REFUSED: neither a systemd user manager nor ${DOCKER} is available on this host.`);
    return 1;
  }
  out(
    `  ${run(DOCKER, ["version", "--format", "{{.Server.Os}}/{{.Server.Arch}} {{.Server.Version}}"]).stdout.trim()}`,
  );

  const context = mkdtempSync(join(tmpdir(), "p2s5-ctx-"));
  const keep = (process.env.XPLAINER_P2S5_KEEP ?? "") !== "";
  try {
    docker(["build", "--file", DOCKERFILE, "--tag", IMAGE, context], "image build");
    out(`  built ${IMAGE} from ${DOCKERFILE}`);
    dockerQuietly(["rm", "--force", CONTAINER]);
    docker(
      [
        "run",
        "--detach",
        "--name",
        CONTAINER,
        "--privileged",
        "--cgroupns=host",
        "--volume",
        "/sys/fs/cgroup:/sys/fs/cgroup:rw",
        "--tmpfs",
        "/run",
        "--tmpfs",
        "/run/lock",
        "--volume",
        `${REPO}:${CONTAINER_REPO}:ro`,
        IMAGE,
      ],
      "container start",
    );

    let systemState = "";
    for (let attempt = 0; attempt < 60; attempt += 1) {
      systemState = run(DOCKER, [
        "exec",
        CONTAINER,
        "systemctl",
        "is-system-running",
      ]).stdout.trim();
      if (systemState === "running" || systemState === "degraded") {
        break;
      }
      await delay(500);
    }
    if (systemState !== "running" && systemState !== "degraded") {
      out(
        `REFUSED: systemd never finished booting in the container (${systemState || "no answer"}).`,
      );
      return 1;
    }
    out(`  systemd is ${systemState} as PID 1`);

    dockerQuietly(["exec", CONTAINER, "loginctl", "enable-linger", CONTAINER_USER]);
    let userState = "";
    for (let attempt = 0; attempt < 40; attempt += 1) {
      userState = run(DOCKER, [
        "exec",
        CONTAINER,
        "systemctl",
        "is-active",
        `user@${CONTAINER_UID}.service`,
      ]).stdout.trim();
      if (userState === "active") {
        break;
      }
      await delay(500);
    }
    if (userState !== "active") {
      out(
        run(DOCKER, [
          "exec",
          CONTAINER,
          "journalctl",
          "-u",
          `user@${CONTAINER_UID}.service`,
          "--no-pager",
          "-n",
          "20",
        ]).stdout.trimEnd(),
      );
      out(
        "REFUSED: this container could not host a `systemctl --user` instance, so the Linux half " +
          "has to come from a real Linux host — the `workflow_dispatch` job on `ubuntu-latest`.",
      );
      return 1;
    }
    out(`  user@${CONTAINER_UID}.service is active, so \`systemctl --user\` has a manager`);

    return await execInside();
  } finally {
    rmSync(context, { recursive: true, force: true });
    if (keep) {
      out(`\nkept for inspection: ${DOCKER} exec -it ${CONTAINER} bash`);
    } else {
      dockerQuietly(["rm", "--force", CONTAINER]);
    }
  }
}

// ── entry ────────────────────────────────────────────────────────────────────────────────────

function hasUserManager() {
  if (process.platform !== "linux" || which("systemctl") === "") {
    return false;
  }
  const state = run("systemctl", ["--user", "is-system-running"]).stdout.trim();
  return state === "running" || state === "degraded" || state === "starting";
}

/**
 * Everything this run created is removed here, whatever happened above — the units, the throwaway
 * LaunchAgent, the sockets and the scratch. A spike that leaves a `gui/<uid>` job behind has
 * changed the machine it was measuring.
 */
async function withScratch(measurement) {
  const scratch = mkdtempSync(join(tmpdir(), "p2s5-"));
  try {
    return await measurement(scratch);
  } finally {
    if (process.platform === "darwin") {
      await removeAgents(process.getuid?.() ?? 0);
    }
    if (process.platform === "linux") {
      removeUnits();
    }
    for (const listen of listeners) {
      if (process.platform !== "win32") {
        rmSync(listen, { force: true });
      }
    }
    if ((process.env.XPLAINER_P2S5_KEEP ?? "") === "") {
      rmSync(scratch, { recursive: true, force: true });
    } else {
      out(`\nkept for inspection: ${scratch}`);
    }
  }
}

async function main() {
  const inside = process.env[INSIDE_ENV] === "1";
  if (inside || hasUserManager()) {
    const code = await withScratch(measureSystemd);
    return code === 0 ? summarise() : code;
  }
  if (process.platform === "win32") {
    const code = await withScratch(measureWindows);
    const summary = code === 0 ? summarise() : code;
    adapterTable();
    decision();
    return summary;
  }
  if (process.platform === "darwin") {
    const local = await withScratch(measureLaunchd);
    const localSummary = local === 0 ? summarise() : local;
    const container = await viaContainer();
    adapterTable();
    decision();
    section("where this run measured");
    out(
      `  macOS, gui/${process.getuid?.() ?? "?"}: ${localSummary === 0 ? "every expectation held" : "an expectation did not hold"}`,
    );
    out(
      `  Linux, in the container:  ${container === 0 ? "every expectation held" : "an expectation did not hold"}`,
    );
    out("  Windows:                  [runner] — windows-latest, never run locally");
    out();
    out(
      localSummary === 0 && container === 0
        ? "P2-S5: every expectation held on both platforms this host can reach."
        : "P2-S5: an expectation did not hold.",
    );
    return localSummary === 0 && container === 0 ? 0 : 1;
  }
  return await viaContainer();
}

process.exit(await main());
