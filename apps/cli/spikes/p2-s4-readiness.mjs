#!/usr/bin/env node
/**
 * Spike P2-S4 — systemd readiness: `Type=notify` against `Type=exec` with the wait in the caller.
 *
 * `docs/adr/0025-daemon-updates-and-readiness.md` §Part three decides that readiness is
 * **announced, not inferred**, and leaves exactly one mechanism open: what a post-install hook
 * restarting a *supervised* daemon waits on, since it is not the daemon's parent and cannot read
 * the stdout ready line at all. `docs/ROADMAP.md` P2-S4 names the two candidates. This script is
 * the measurement, and it exits `0` only when every expectation below held, so it is a check and
 * not a demo:
 *
 *     node apps/cli/spikes/p2-s4-readiness.mjs
 *
 * **The unit under test launches the B1 artefact.** Every unit that runs the daemon names
 * `<runtime>/bin/node` and `<runtime>/lib/node_modules/@xplainer/cli/dist/bin.js`, where
 * `<runtime>` is a payload assembled by `xplainer runtime build` into a scratch directory outside
 * the checkout; the one unit that does not run the daemon — case 7's stand-in for a process that
 * binds nothing — still runs the payload's own interpreter. The point of the spike is readiness, not packaging — T2 and T3 own that — and a
 * unit pointed at `apps/cli/dist/bin.js` would measure a machine that has a checkout, which is the
 * one machine this product does not target. Case 1 asserts it rather than assuming it.
 *
 * WHAT IT MEASURES.
 *
 *   1. **The artefact is what the unit launches.** `systemctl --user show -p ExecStart` is read
 *      back and required to name the payload and to name nothing inside the checkout.
 *   2. **`Type=exec` as shipped, five starts.** How long `systemctl --user start` takes to return,
 *      what a single **authenticated** `GET /healthz` with no sleep and no retry gets at that
 *      instant, and how much later the bounded poll first sees `200`. This is the gap ADR 0020's
 *      note of 2026-09-06 describes: the unit is active as soon as `execve` succeeds.
 *   3. **`Type=notify` with `NotifyAccess=all`, five starts.** The daemon is launched with an
 *      `--import` hook that spawns `systemd-notify --ready` when it sees the ready line on stdout —
 *      which is a faithful stand-in for the two-line change inside `serve` itself, because the
 *      notifier is a *child* of the daemon in both. The same immediate probe is issued.
 *   4. **The same unit with `NotifyAccess=main`.** Round 1 of the plan permitted a child
 *      `systemd-notify` and then rendered `NotifyAccess=main`. The two are inconsistent, and this
 *      case measures what the inconsistency costs: the manager names the refusal in the journal,
 *      `systemd-notify` exits `0` regardless, and the start fails on the timeout.
 *   5. **`MAINPID=` moves the main process.** A wrapper unit sends `READY=1` with
 *      `--pid=<the daemon it forked>`, and the manager tracks a process it never forked as the
 *      service's main one. That is the measurement behind the claim ADR 0025 withdrew: the unit
 *      type does not enforce the foreground-process invariant, so `serve --detach` staying absent
 *      is a property this project maintains deliberately.
 *   6. **`Type=exec` with the readiness wait in `ExecStartPost=`.** Not one of the two candidates,
 *      and measured because it is what the two candidates' difference turns out to reduce to: a
 *      start job that completes only after an authenticated `200`, with no notification protocol.
 *      Both directions are measured — a poll that succeeds, and a poll that never authenticates.
 *   7. **A daemon that never becomes ready under `Type=exec`.** A stand-in that binds nothing, to
 *      measure what the supervisor reports for it. This is the one thing `Type=notify` buys, and
 *      it is recorded as such rather than argued away.
 *   8. **`401` is not readiness.** The same ready daemon answers `401` without the bearer token and
 *      `200` with it, which is why ADR 0025 requires the probe to be authenticated.
 *   9. **What the two mechanisms would cost to ship.** Whether `systemd-notify(1)` is present on a
 *      systemd host at all, and whether a toolchain that could build a native `sd_notify` addon is.
 *
 * **Why Node cannot write `READY=1` itself, measured rather than quoted.** The `--import` hook runs
 * three probes inside the daemon process, where `$NOTIFY_SOCKET` is set, and their results are
 * printed with the rest: `node:dgram` refuses any socket type but `udp4`/`udp6`, so an `AF_UNIX`
 * datagram socket cannot be opened; `node:net` speaks `SOCK_STREAM` to a unix path and the notify
 * socket is `SOCK_DGRAM`, so connecting to it fails; and a `udp4` socket cannot be pointed at a
 * filesystem path. There is no native-free writer in Node — not "no convenient one".
 *
 * WHERE IT RUNS. On a Linux host whose user manager is reachable (`systemctl --user`), it measures
 * directly — that is what the `workflow_dispatch` job on `ubuntu-latest` runs. Anywhere else it
 * builds `infra/e2e/Dockerfile.systemd`, boots real systemd as PID 1 in a privileged container,
 * enables lingering for an unprivileged user so that a per-user manager exists, and re-executes
 * *itself* inside as that user. The two paths run the identical measurement function; the container
 * is only how a macOS or Windows developer gets a systemd to measure.
 *
 * Environment it reads: `XPLAINER_DOCKER` (default `docker`) and `XPLAINER_P2S4_KEEP` (any
 * non-empty value leaves the container running for inspection). Nothing else — every port, token,
 * state directory and unit file is created by the run and removed by it.
 *
 * Exit codes: `0` every expectation held; `1` one did not, or the host could offer neither a user
 * manager nor a container to boot one in, with the reason named on the last line.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/** This file, and the checkout three directories above it. */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");

/** The CLI the payload is assembled from. Built by `pnpm build`; refused by name when it is not. */
const CLI_ENTRY = join(REPO, "apps", "cli", "dist", "bin.js");

/** The image, its Dockerfile, and the container the outer half boots. */
const IMAGE = "xplainer-p2s4-systemd";
const DOCKERFILE = join(REPO, "infra", "e2e", "Dockerfile.systemd");
const CONTAINER = "xplainer-p2s4";

/** Where the outer half mounts the checkout, and who runs the inner half there. */
const CONTAINER_REPO = "/repo";
const CONTAINER_USER = "xplainer";
const CONTAINER_UID = 1000;

/** Set on the inner half so it measures rather than recursing into another container. */
const INSIDE_ENV = "XPLAINER_P2S4_INSIDE";

/** The Docker CLI. Overridable only so a machine with a differently named client can run this. */
const DOCKER = (process.env.XPLAINER_DOCKER ?? "").trim() || "docker";

/** Every unit this script installs starts with this, so cleanup can be exhaustive. */
const UNIT_PREFIX = "p2s4-";

/** How many times cases 2 and 3 are repeated. A single start proves nothing about a race. */
const REPEATS = 5;

/** The bounded timeout ADR 0025 requires of the caller's readiness wait. */
const READY_TIMEOUT_MS = 15_000;

/** How often that wait polls. Small enough that the number it reports is a measurement. */
const POLL_INTERVAL_MS = 20;

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

function which(command) {
  return run("/bin/sh", ["-c", `command -v ${command} || true`]).stdout.trim();
}

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        resolvePort(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
  });
}

/**
 * One `GET /healthz`, resolved rather than thrown.
 *
 * `Host` is `127.0.0.1:<port>`, which is what `daemon/guard.ts` allows; the bearer token is
 * omitted only where the point of the probe is what its absence gets. A connection error is a
 * result here — "nothing is listening yet" is the answer half these cases are asking for.
 */
async function healthz(port, token) {
  return await new Promise((resolveProbe) => {
    const headers = token === null ? {} : { authorization: `Bearer ${token}` };
    const req = request(
      { host: "127.0.0.1", port, path: "/healthz", method: "GET", headers, timeout: 2000 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolveProbe({ status: res.statusCode ?? 0, body: body.trim() });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (error) => {
      resolveProbe({ status: 0, body: "", error: error.code ?? error.message });
    });
    req.end();
  });
}

/** The caller-side readiness wait ADR 0025 describes: authenticated, bounded, and counted. */
async function waitForHealthz(port, token, timeoutMs = READY_TIMEOUT_MS) {
  const started = process.hrtime.bigint();
  let polls = 0;
  for (;;) {
    polls += 1;
    const probe = await healthz(port, token);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    if (probe.status === 200) {
      return { ok: true, polls, ms: elapsedMs, last: probe };
    }
    if (elapsedMs > timeoutMs) {
      return { ok: false, polls, ms: elapsedMs, last: probe };
    }
    await delay(POLL_INTERVAL_MS);
  }
}

/** Where a per-user manager reads unit files from. */
function unitDirectory() {
  const home = process.env.HOME;
  if (home === undefined || home === "") {
    throw new Error("HOME is unset, so there is no per-user unit directory to write to");
  }
  return join(home, ".config", "systemd", "user");
}

function systemctl(...args) {
  return run("systemctl", ["--user", ...args]);
}

function installUnit(name, body) {
  const directory = unitDirectory();
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.service`), body, { mode: 0o644 });
  systemctl("daemon-reload");
}

/** `systemctl show` as an object, so a property is read by name rather than by regular expression. */
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

function journalFor(name) {
  return run("journalctl", ["--user", "-u", `${name}.service`, "--no-pager", "-n", "60"]).stdout;
}

/** Start a unit and time what `systemctl start` itself took, which is the whole question here. */
function startUnit(name) {
  const started = process.hrtime.bigint();
  const result = systemctl("start", `${name}.service`);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { ...result, ms };
}

function stopUnit(name) {
  systemctl("stop", `${name}.service`);
  systemctl("reset-failed", `${name}.service`);
}

/** Remove every unit this run installed, whatever happened to it. */
function removeUnits() {
  const directory = unitDirectory();
  if (!existsSync(directory)) {
    return;
  }
  const listed = run("/bin/sh", ["-c", `ls ${directory} 2>/dev/null || true`]).stdout.split("\n");
  for (const file of listed) {
    const name = file.trim().replace(/\.service$/, "");
    if (name.startsWith(UNIT_PREFIX)) {
      stopUnit(name);
      rmSync(join(directory, `${name}.service`), { force: true });
    }
  }
  systemctl("daemon-reload");
}

/**
 * The `--import` hook: the stand-in for the change `Type=notify` would need inside `serve`.
 *
 * It is deliberately written the way the shipped version would be — spawn `systemd-notify --ready`
 * once, from the daemon process, at the instant the ready line is produced — so the thing being
 * measured is the mechanism and not the harness. It also runs, inside the daemon and with
 * `$NOTIFY_SOCKET` set, the three probes that settle whether Node could write `READY=1` itself.
 *
 * Written into the scratch directory rather than into the payload: `runtime verify` re-hashes the
 * payload against `runtime.manifest.json`, and a spike that added a file to it would be measuring
 * an artefact that no longer verifies.
 */
const HOOK_SOURCE = `
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import dgram from 'node:dgram';
import net from 'node:net';

const report = process.env.P2S4_REPORT;
const socket = process.env.NOTIFY_SOCKET ?? null;
const record = { notify_socket: socket, probes: {}, notify: null };

function attempt(label, fn) {
  try {
    record.probes[label] = { ok: true, detail: String(fn()) };
  } catch (error) {
    const code = error && error.code ? error.code : error && error.name ? error.name : 'Error';
    record.probes[label] = { ok: false, detail: code + ': ' + String(error && error.message) };
  }
}

function save() {
  if (report) {
    writeFileSync(report, JSON.stringify(record, null, 2));
  }
}

attempt('dgram.createSocket("unix_dgram")', () => {
  const s = dgram.createSocket('unix_dgram');
  s.close();
  return 'opened a unix datagram socket';
});

attempt('dgram udp4 send to the socket path', () => {
  const s = dgram.createSocket('udp4');
  try {
    s.send(Buffer.from('READY=1'), 0, socket ?? '/nonexistent');
    return 'accepted a filesystem path as a udp destination';
  } finally {
    s.close();
  }
});

await new Promise((done) => {
  if (!socket) {
    record.probes['net.connect(NOTIFY_SOCKET)'] = { ok: false, detail: 'NOTIFY_SOCKET is unset' };
    done();
    return;
  }
  const path = socket.startsWith('@') ? '\\u0000' + socket.slice(1) : socket;
  const c = net.connect(path);
  const finish = (ok, detail) => {
    record.probes['net.connect(NOTIFY_SOCKET)'] = { ok, detail };
    c.destroy();
    done();
  };
  c.on('connect', () => finish(true, 'a SOCK_STREAM connect to the notify socket succeeded'));
  c.on('error', (error) => finish(false, (error.code ?? 'Error') + ': ' + error.message));
});

save();

const write = process.stdout.write.bind(process.stdout);
let notified = false;
process.stdout.write = (chunk, ...rest) => {
  const text = typeof chunk === 'string' ? chunk : String(chunk);
  if (!notified && text.includes('"event":"ready"')) {
    notified = true;
    const result = spawnSync('systemd-notify', ['--ready'], { encoding: 'utf8' });
    record.notify = {
      status: result.status,
      stderr: (result.stderr ?? '').trim(),
      error: result.error ? String(result.error.message) : null,
    };
    save();
  }
  return write(chunk, ...rest);
};
`;

/**
 * The wrapper unit's `ExecStart`: a parent that starts the daemon and then hands the manager its
 * child's pid. This is the shape a forking daemon would have, and case 5 exists to measure what
 * the manager does with it.
 */
const WRAPPER_SOURCE = `
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const report = process.env.P2S4_REPORT;
const [command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'] });
const record = { wrapper_pid: process.pid, child_pid: child.pid, notify: null };
let buffered = '';
let notified = false;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffered += chunk;
  let index = buffered.indexOf('\\n');
  while (index >= 0) {
    const line = buffered.slice(0, index);
    buffered = buffered.slice(index + 1);
    process.stdout.write(line + '\\n');
    if (!notified && line.includes('"event":"ready"')) {
      notified = true;
      const result = spawnSync('systemd-notify', ['--ready', '--pid=' + String(child.pid)], {
        encoding: 'utf8',
      });
      record.notify = { status: result.status, stderr: (result.stderr ?? '').trim() };
      if (report) {
        writeFileSync(report, JSON.stringify(record, null, 2));
      }
    }
    index = buffered.indexOf('\\n');
  }
});

process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
`;

/**
 * The `ExecStartPost=` readiness wait of case 6, and the same code the installer would run.
 *
 * Authenticated, bounded, and it exits non-zero when the window closes without a `200` — which is
 * what turns "the daemon never became ready" into a failed start job rather than a unit the
 * manager reports as active forever.
 */
const POLLER_SOURCE = `
import { readFileSync } from 'node:fs';
import { request } from 'node:http';

const [port, tokenPath, budget] = process.argv.slice(2);
const token = readFileSync(tokenPath, 'utf8').trim();
const deadline = Date.now() + Number(budget);

function probe() {
  return new Promise((done) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: Number(port),
        path: '/healthz',
        method: 'GET',
        headers: { authorization: 'Bearer ' + token },
        timeout: 1000,
      },
      (res) => {
        res.resume();
        done(res.statusCode ?? 0);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => done(0));
    req.end();
  });
}

let polls = 0;
for (;;) {
  polls += 1;
  const status = await probe();
  if (status === 200) {
    process.stdout.write('ready after ' + String(polls) + ' polls\\n');
    process.exit(0);
  }
  if (Date.now() > deadline) {
    process.stderr.write('not ready within the budget; last status ' + String(status) + '\\n');
    process.exit(1);
  }
  await new Promise((done) => setTimeout(done, 20));
}
`;

/** A `serve` state directory with the bearer token already minted, as an installer would know it. */
function makeState(scratch, label) {
  const dir = join(scratch, `state-${label}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  const tokenPath = join(dir, "token");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  return { dir, token, tokenPath };
}

/** A unit file, assembled from the handful of settings this spike varies. */
function unitBody(options) {
  const lines = [
    "[Unit]",
    `Description=xplainer P2-S4 ${options.description}`,
    "",
    "[Service]",
    `Type=${options.type}`,
    `TimeoutStartSec=${options.timeoutStartSec ?? 30}`,
    "TimeoutStopSec=25",
  ];
  if (options.notifyAccess !== undefined) {
    lines.push(`NotifyAccess=${options.notifyAccess}`);
  }
  for (const entry of options.environment ?? []) {
    lines.push(`Environment=${entry}`);
  }
  lines.push(`ExecStart=${options.execStart}`);
  if (options.execStartPost !== undefined) {
    lines.push(`ExecStartPost=${options.execStartPost}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

/** `/proc/<pid>/cmdline`, NUL-separated, as a readable string — or `null` if the pid is gone. */
function cmdlineOf(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
  } catch {
    return null;
  }
}

function readJsonIfPresent(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function fixed(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

/**
 * The measurement itself, on a host whose per-user systemd manager is reachable.
 *
 * Everything it creates lives in one scratch directory and one set of `p2s4-` units, and both are
 * removed by the `finally`, whatever happened. The return value is the exit code.
 */
async function measure() {
  section("host");
  const version = run("systemctl", ["--version"]).stdout.split("\n")[0] ?? "";
  out(`  ${version}`);
  out(
    `  manager: --user, uid ${process.getuid?.() ?? "?"}, XDG_RUNTIME_DIR=${
      process.env.XDG_RUNTIME_DIR ?? "<unset>"
    }`,
  );
  out(`  node:    ${process.version} on ${process.platform}/${process.arch}`);
  out(`  checkout: ${REPO}`);

  const running = systemctl("is-system-running");
  const state = running.stdout.trim();
  if (running.failed && state !== "degraded") {
    out(`  systemctl --user is-system-running: ${state || running.stderr.trim()}`);
    out("REFUSED: no per-user systemd manager is reachable, so there is nothing to measure.");
    return 1;
  }
  out(`  systemctl --user is-system-running: ${state}`);

  if (!existsSync(CLI_ENTRY)) {
    out(`REFUSED: ${CLI_ENTRY} does not exist. Run \`pnpm build\` first.`);
    return 1;
  }

  const scratch = mkdtempSync(join(tmpdir(), "p2s4-"));
  try {
    return await measureIn(scratch);
  } finally {
    removeUnits();
    if (process.env.XPLAINER_P2S4_KEEP === undefined || process.env.XPLAINER_P2S4_KEEP === "") {
      rmSync(scratch, { recursive: true, force: true });
    } else {
      out(`\nkept for inspection: ${scratch}`);
    }
  }
}

/** The nine cases, in order, inside a scratch directory the caller removes. */
async function measureIn(scratch) {
  section("the artefact under test — payload 1, assembled by `xplainer runtime build`");
  const runtime = join(scratch, "runtime");
  const build = run(process.execPath, [CLI_ENTRY, "runtime", "build", "--out", runtime]);
  out(
    build.stdout
      .trimEnd()
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
  );
  if (build.failed) {
    out(`  ${build.stderr.trim()}`);
    check(false, "payload 1 assembles", `runtime build exited ${String(build.status)}`);
    return 1;
  }
  const nodeBin = join(runtime, "bin", "node");
  const cli = join(runtime, "lib", "node_modules", "@xplainer", "cli", "dist", "bin.js");
  const artefactVersion = run(nodeBin, [cli, "--version"]);
  check(
    existsSync(nodeBin) && existsSync(cli) && !artefactVersion.failed,
    "the payload runs its own interpreter and its own entry",
    `${nodeBin} ${cli} --version → ${artefactVersion.stdout.trim()}`,
  );

  const hook = join(scratch, "notify-hook.mjs");
  const wrapper = join(scratch, "notify-wrapper.mjs");
  const poller = join(scratch, "healthz-poller.mjs");
  const hang = join(scratch, "never-ready.mjs");
  writeFileSync(hook, HOOK_SOURCE);
  writeFileSync(wrapper, WRAPPER_SOURCE);
  writeFileSync(poller, POLLER_SOURCE);
  writeFileSync(hang, "setInterval(() => {}, 1000);\n");

  // ── 1 ──────────────────────────────────────────────────────────────────────────────────────
  section("case 1 — the unit launches the artefact, and names nothing in the checkout");
  const probePort = await freePort();
  const probeState = makeState(scratch, "shape");
  const execName = `${UNIT_PREFIX}exec`;
  installUnit(
    execName,
    unitBody({
      description: "Type=exec, as ADR 0020 ships it",
      type: "exec",
      environment: [`XPLAINER_STATE_DIR=${probeState.dir}`],
      execStart: `${nodeBin} ${cli} serve --port ${probePort}`,
    }),
  );
  const shown = showUnit(execName, ["ExecStart", "Environment"]);
  out(`  ExecStart=${shown.ExecStart ?? "<absent>"}`);
  check(
    (shown.ExecStart ?? "").includes(nodeBin) && (shown.ExecStart ?? "").includes(cli),
    "the manager's own view of ExecStart names the payload's interpreter and entry",
    `both under ${runtime}`,
  );
  check(
    !(shown.ExecStart ?? "").includes(REPO) && !(shown.Environment ?? "").includes(REPO),
    "neither ExecStart nor Environment names the checkout",
    `checkout is ${REPO}`,
  );

  // ── 2 ──────────────────────────────────────────────────────────────────────────────────────
  section(`case 2 — Type=exec, ${REPEATS} starts: what \`systemctl start\` returning means`);
  const execRuns = [];
  for (let attempt = 0; attempt < REPEATS; attempt += 1) {
    const port = attempt === 0 ? probePort : await freePort();
    const runState = attempt === 0 ? probeState : makeState(scratch, `exec-${attempt}`);
    if (attempt > 0) {
      installUnit(
        execName,
        unitBody({
          description: "Type=exec, as ADR 0020 ships it",
          type: "exec",
          environment: [`XPLAINER_STATE_DIR=${runState.dir}`],
          execStart: `${nodeBin} ${cli} serve --port ${port}`,
        }),
      );
    }
    const started = startUnit(execName);
    const immediate = await healthz(port, runState.token);
    const waited = await waitForHealthz(port, runState.token);
    execRuns.push({ startMs: started.ms, rc: started.status, immediate, waited });
    out(
      `  start rc=${String(started.status)} returned after ${fixed(started.ms)} ms; ` +
        `immediate authenticated /healthz → ${
          immediate.status === 0 ? (immediate.error ?? "no answer") : String(immediate.status)
        }; ` +
        `first 200 after ${fixed(waited.ms)} ms (${waited.polls} polls)`,
    );
    stopUnit(execName);
  }
  const execImmediate = execRuns.filter((entry) => entry.immediate.status === 200).length;
  const execReady = execRuns.filter((entry) => entry.waited.ok).length;
  check(
    execRuns.every((entry) => entry.rc === 0),
    "every Type=exec start returned success",
  );
  check(
    execImmediate === 0,
    "no Type=exec start had a usable daemon behind it at the instant it returned",
    `${execImmediate}/${REPEATS} answered 200 with no sleep and no retry`,
  );
  check(
    execReady === REPEATS,
    "the caller-side bounded authenticated wait reached 200 every time",
    `mean start ${fixed(mean(execRuns.map((entry) => entry.startMs)))} ms, mean time-to-ready ` +
      `${fixed(mean(execRuns.map((entry) => entry.waited.ms)))} ms`,
  );

  // ── 3 ──────────────────────────────────────────────────────────────────────────────────────
  section(`case 3 — Type=notify, NotifyAccess=all, ${REPEATS} starts, notifier is a child`);
  const notifyName = `${UNIT_PREFIX}notify`;
  const notifyRuns = [];
  let hookRecord = null;
  for (let attempt = 0; attempt < REPEATS; attempt += 1) {
    const port = await freePort();
    const runState = makeState(scratch, `notify-${attempt}`);
    const report = join(scratch, `hook-${attempt}.json`);
    installUnit(
      notifyName,
      unitBody({
        description: "Type=notify with a systemd-notify child",
        type: "notify",
        notifyAccess: "all",
        timeoutStartSec: 20,
        environment: [`XPLAINER_STATE_DIR=${runState.dir}`, `P2S4_REPORT=${report}`],
        execStart: `${nodeBin} --import file://${hook} ${cli} serve --port ${port}`,
      }),
    );
    const started = startUnit(notifyName);
    const immediate = await healthz(port, runState.token);
    const pids = showUnit(notifyName, ["MainPID", "ExecMainPID", "ActiveState"]);
    notifyRuns.push({ startMs: started.ms, rc: started.status, immediate, pids });
    const record = readJsonIfPresent(report);
    if (record !== null) {
      hookRecord = record;
    }
    out(
      `  start rc=${String(started.status)} returned after ${fixed(started.ms)} ms; ` +
        `immediate authenticated /healthz → ${
          immediate.status === 0 ? (immediate.error ?? "no answer") : String(immediate.status)
        }; ` +
        `MainPID=${pids.MainPID} ExecMainPID=${pids.ExecMainPID}`,
    );
    stopUnit(notifyName);
  }
  const notifyImmediate = notifyRuns.filter((entry) => entry.immediate.status === 200).length;
  check(
    notifyRuns.every((entry) => entry.rc === 0),
    "every Type=notify start returned success",
    `${REPEATS}/${REPEATS}, so the systemd-notify child was never lost to a race`,
  );
  check(
    notifyImmediate === REPEATS,
    "`systemctl start` returned only after the daemon was usable",
    `${notifyImmediate}/${REPEATS} answered 200 with no sleep and no retry; mean start ` +
      `${fixed(mean(notifyRuns.map((entry) => entry.startMs)))} ms`,
  );
  check(
    notifyRuns.every((entry) => entry.pids.MainPID === entry.pids.ExecMainPID),
    "with the notifier a child and no MAINPID=, the main process stays the one systemd forked",
  );

  section("what the daemon process found when it looked for a way to write READY=1 itself");
  if (hookRecord === null) {
    check(false, "the hook recorded its probes", "no report file was written");
  } else {
    out(`  NOTIFY_SOCKET=${hookRecord.notify_socket ?? "<unset>"}`);
    for (const [label, probe] of Object.entries(hookRecord.probes)) {
      out(`  ${probe.ok ? "opened " : "refused"}  ${label}  →  ${probe.detail}`);
    }
    out(`  systemd-notify --ready exited ${String(hookRecord.notify?.status ?? "n/a")}`);
    check(
      Object.values(hookRecord.probes).every((probe) => probe.ok === false),
      "no AF_UNIX datagram write is reachable from Node without a native addon",
      "all three probes refused, so `systemd-notify(1)` as a child is the only native-free route",
    );
  }

  // ── 4 ──────────────────────────────────────────────────────────────────────────────────────
  section("case 4 — the same unit with NotifyAccess=main: the notification is dropped");
  const mainName = `${UNIT_PREFIX}notify-main`;
  const mainPort = await freePort();
  const mainState = makeState(scratch, "notify-main");
  const mainReport = join(scratch, "hook-main.json");
  installUnit(
    mainName,
    unitBody({
      description: "Type=notify with NotifyAccess=main and a systemd-notify child",
      type: "notify",
      notifyAccess: "main",
      timeoutStartSec: 8,
      environment: [`XPLAINER_STATE_DIR=${mainState.dir}`, `P2S4_REPORT=${mainReport}`],
      execStart: `${nodeBin} --import file://${hook} ${cli} serve --port ${mainPort}`,
    }),
  );
  const mainStart = startUnit(mainName);
  const mainShown = showUnit(mainName, ["ActiveState", "Result", "MainPID"]);
  const mainJournal = journalFor(mainName);
  const refusal = mainJournal
    .split("\n")
    .find((line) => line.includes("reception only permitted for main PID"));
  const mainHook = readJsonIfPresent(mainReport);
  out(`  start rc=${String(mainStart.status)} after ${fixed(mainStart.ms)} ms`);
  out(`  ActiveState=${mainShown.ActiveState} Result=${mainShown.Result}`);
  out(`  journal: ${refusal === undefined ? "<no refusal line>" : refusal.replace(/^.*?: /, "")}`);
  out(
    `  the sender's own view: systemd-notify exited ${String(mainHook?.notify?.status ?? "n/a")}`,
  );
  check(
    mainStart.status !== 0 && mainShown.Result === "timeout",
    "a child's READY=1 under NotifyAccess=main fails the start job",
    "so a unit that renders NotifyAccess=main beside a child notifier does not start at all",
  );
  check(refusal !== undefined, "the manager names the refusal in the journal");
  check(
    mainHook?.notify?.status === 0,
    "and `systemd-notify` reports success to the daemon regardless",
    "the drop is invisible on the sending side, which is why NotifyAccess must follow the choice",
  );
  stopUnit(mainName);

  // ── 5 ──────────────────────────────────────────────────────────────────────────────────────
  section("case 5 — MAINPID= moves the main process off the one systemd forked");
  const moveName = `${UNIT_PREFIX}mainpid`;
  const movePort = await freePort();
  const moveState = makeState(scratch, "mainpid");
  const moveReport = join(scratch, "wrapper.json");
  installUnit(
    moveName,
    unitBody({
      description: "Type=notify with a wrapper that hands over its child's pid",
      type: "notify",
      notifyAccess: "all",
      timeoutStartSec: 20,
      environment: [`XPLAINER_STATE_DIR=${moveState.dir}`, `P2S4_REPORT=${moveReport}`],
      execStart: `${nodeBin} ${wrapper} ${nodeBin} ${cli} serve --port ${movePort}`,
    }),
  );
  const moveStart = startUnit(moveName);
  const movePids = showUnit(moveName, ["MainPID", "ExecMainPID", "ActiveState"]);
  const moveImmediate = await healthz(movePort, moveState.token);
  const moveRecord = readJsonIfPresent(moveReport);
  out(`  start rc=${String(moveStart.status)} after ${fixed(moveStart.ms)} ms`);
  out(`  the process systemd forked (the wrapper): ${String(moveRecord?.wrapper_pid ?? "?")}`);
  out(`  the pid the wrapper handed over:          ${String(moveRecord?.child_pid ?? "?")}`);
  out(
    `  the manager's MainPID afterwards:         ${movePids.MainPID} → ${
      cmdlineOf(movePids.MainPID) ?? "<gone>"
    }`,
  );
  check(
    moveStart.status === 0 && moveImmediate.status === 200,
    "a wrapper may announce readiness on behalf of a daemon it forked",
  );
  check(
    moveRecord !== null &&
      movePids.MainPID === String(moveRecord.child_pid) &&
      movePids.MainPID !== String(moveRecord.wrapper_pid) &&
      (cmdlineOf(movePids.MainPID) ?? "").includes("serve --port"),
    "systemd then tracks as the main process one it never forked",
    "`Type=notify` therefore does not forbid forking; the foreground invariant is this project's " +
      "to keep, not the unit type's to enforce",
  );
  stopUnit(moveName);

  // ── 6 ──────────────────────────────────────────────────────────────────────────────────────
  section("case 6 — Type=exec with the same authenticated wait in ExecStartPost=");
  const postName = `${UNIT_PREFIX}exec-post`;
  const postPort = await freePort();
  const postState = makeState(scratch, "exec-post");
  installUnit(
    postName,
    unitBody({
      description: "Type=exec whose start job includes the readiness wait",
      type: "exec",
      environment: [`XPLAINER_STATE_DIR=${postState.dir}`],
      execStart: `${nodeBin} ${cli} serve --port ${postPort}`,
      execStartPost: `${nodeBin} ${poller} ${postPort} ${postState.tokenPath} ${READY_TIMEOUT_MS}`,
    }),
  );
  const postStart = startUnit(postName);
  const postImmediate = await healthz(postPort, postState.token);
  out(`  start rc=${String(postStart.status)} after ${fixed(postStart.ms)} ms`);
  out(
    `  immediate authenticated /healthz → ${
      postImmediate.status === 0
        ? (postImmediate.error ?? "no answer")
        : String(postImmediate.status)
    }`,
  );
  check(
    postStart.status === 0 && postImmediate.status === 200,
    "the start job completes only after an authenticated 200, with no notification protocol",
  );
  stopUnit(postName);

  const failName = `${UNIT_PREFIX}exec-post-fail`;
  const failPort = await freePort();
  const failState = makeState(scratch, "exec-post-fail");
  const wrongToken = join(scratch, "wrong-token");
  writeFileSync(wrongToken, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
  installUnit(
    failName,
    unitBody({
      description: "Type=exec whose readiness wait never authenticates",
      type: "exec",
      timeoutStartSec: 40,
      environment: [`XPLAINER_STATE_DIR=${failState.dir}`],
      execStart: `${nodeBin} ${cli} serve --port ${failPort}`,
      execStartPost: `${nodeBin} ${poller} ${failPort} ${wrongToken} 3000`,
    }),
  );
  const failStart = startUnit(failName);
  const failShown = showUnit(failName, ["ActiveState", "Result", "MainPID"]);
  const failAfter = await healthz(failPort, failState.token);
  out(`  start rc=${String(failStart.status)} after ${fixed(failStart.ms)} ms`);
  out(
    `  ActiveState=${failShown.ActiveState} Result=${failShown.Result} MainPID=${failShown.MainPID}`,
  );
  check(
    failStart.status !== 0 && failShown.ActiveState === "failed",
    "a readiness wait that never authenticates fails the unit rather than leaving it active",
  );
  check(
    failAfter.status !== 200,
    "and the daemon behind it is stopped",
    `a later authenticated probe got ${failAfter.status === 0 ? (failAfter.error ?? "no answer") : String(failAfter.status)}`,
  );
  stopUnit(failName);

  // ── 7 ──────────────────────────────────────────────────────────────────────────────────────
  section("case 7 — what Type=exec reports for a process that never becomes ready");
  const hangName = `${UNIT_PREFIX}never-ready`;
  const hangPort = await freePort();
  installUnit(
    hangName,
    unitBody({
      description: "Type=exec whose process binds nothing",
      type: "exec",
      execStart: `${nodeBin} ${hang}`,
    }),
  );
  const hangStart = startUnit(hangName);
  const hangWait = await waitForHealthz(hangPort, "irrelevant", 1500);
  const hangShown = showUnit(hangName, ["ActiveState", "SubState"]);
  out(`  start rc=${String(hangStart.status)} after ${fixed(hangStart.ms)} ms`);
  out(
    `  after ${fixed(hangWait.ms)} ms of polling: ActiveState=${hangShown.ActiveState} ` +
      `SubState=${hangShown.SubState}`,
  );
  check(
    hangStart.status === 0 && hangShown.ActiveState === "active" && !hangWait.ok,
    "Type=exec reports active for a daemon that will never answer",
    "this is the one thing Type=notify buys: a start that hangs before readiness is the " +
      "supervisor's failure rather than nobody's",
  );
  stopUnit(hangName);

  // ── 8 ──────────────────────────────────────────────────────────────────────────────────────
  section("case 8 — 401 is not readiness, and the ready line goes to the journal");
  const authName = `${UNIT_PREFIX}auth`;
  const authPort = await freePort();
  const authState = makeState(scratch, "auth");
  installUnit(
    authName,
    unitBody({
      description: "Type=exec, for the authentication and stdout observations",
      type: "exec",
      environment: [`XPLAINER_STATE_DIR=${authState.dir}`],
      execStart: `${nodeBin} ${cli} serve --port ${authPort}`,
    }),
  );
  startUnit(authName);
  const authReady = await waitForHealthz(authPort, authState.token);
  const anonymous = await healthz(authPort, null);
  const authenticated = await healthz(authPort, authState.token);
  const authJournal = journalFor(authName);
  const readyLine = authJournal.split("\n").find((line) => line.includes('"event":"ready"'));
  out(`  without the bearer token: ${String(anonymous.status)} ${anonymous.body}`);
  out(`  with it:                  ${String(authenticated.status)} ${authenticated.body}`);
  out(
    `  journal: ${readyLine === undefined ? "<no ready line>" : readyLine.replace(/^.*?: /, "")}`,
  );
  check(
    anonymous.status === 401 && authenticated.status === 200,
    "an unauthenticated probe answers 401 on a daemon that is ready",
    "a poller that accepts any response would call a bound port readiness, which it is not",
  );
  check(
    authReady.ok && readyLine !== undefined,
    "the stdout ready line lands in the supervisor's log sink, not in a pipe the hook could read",
    "which is why the supervised caller needs one of these mechanisms at all",
  );
  stopUnit(authName);

  // ── 9 ──────────────────────────────────────────────────────────────────────────────────────
  section("case 9 — what each mechanism would cost to ship");
  const notifyBinary = which("systemd-notify");
  const compilers = ["cc", "gcc", "c++", "make", "node-gyp"].map((tool) => ({
    tool,
    path: which(tool),
  }));
  const owner = notifyBinary === "" ? "" : run("dpkg", ["-S", notifyBinary]).stdout.trim();
  out(`  systemd-notify: ${notifyBinary === "" ? "<absent>" : notifyBinary}`);
  if (owner !== "") {
    out(`  shipped by:     ${owner}`);
  }
  for (const entry of compilers) {
    out(`  ${entry.tool.padEnd(15)} ${entry.path === "" ? "<absent>" : entry.path}`);
  }
  check(
    notifyBinary !== "",
    "the notify route needs no new npm dependency: systemd-notify ships with systemd itself",
  );
  out(
    `  a native sd_notify addon would need a toolchain on the target or a prebuilt binary per\n` +
      `  target; payload 1 carries neither, and this host has ${
        compilers.filter((entry) => entry.path !== "").length
      }/${compilers.length} of the tools above.\n` +
      "  That is recorded rather than asserted: whether a build host happens to have a compiler\n" +
      "  says nothing about the machine the artefact is installed on, which is the one that\n" +
      "  matters and whose whole premise is that it has no toolchain.",
  );

  return report(execRuns, notifyRuns);
}

function mean(values) {
  return values.length === 0 ? Number.NaN : values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * The comparison, the decision the measurements settle, and the exit code.
 *
 * The decision is stated here rather than only in the ADR note, because a spike whose conclusion
 * lives somewhere else is a spike a later reader has to reconstruct.
 */
function report(execRuns, notifyRuns) {
  section("summary");
  const rows = [
    ["", "Type=exec", "Type=notify"],
    [
      "mean `systemctl start`",
      `${fixed(mean(execRuns.map((entry) => entry.startMs)))} ms`,
      `${fixed(mean(notifyRuns.map((entry) => entry.startMs)))} ms`,
    ],
    [
      "usable at that instant",
      `${execRuns.filter((entry) => entry.immediate.status === 200).length}/${execRuns.length}`,
      `${notifyRuns.filter((entry) => entry.immediate.status === 200).length}/${notifyRuns.length}`,
    ],
    [
      "mean time to an authenticated 200",
      `${fixed(mean(execRuns.map((entry) => entry.waited.ms)))} ms`,
      "included in the start",
    ],
  ];
  for (const row of rows) {
    out(`  ${row[0].padEnd(36)}${row[1].padEnd(22)}${row[2]}`);
  }

  section("decision");
  for (const line of [
    "`Type=exec` is RETAINED, and the readiness wait belongs to the caller: an authenticated",
    "`GET /healthz` polled with a bounded timeout and a named failure. `Type=notify` is rejected.",
    "",
    "Both mechanisms work here, and `Type=notify` is the one that makes `systemctl start` mean",
    '"ready". It is rejected on what it costs rather than on whether it functions:',
    "",
    "  * It needs `NotifyAccess=all`, because Node cannot write `READY=1` and the only native-free",
    "    writer is `systemd-notify(1)` spawned as a CHILD (case 3's probes, case 4). `NotifyAccess`",
    "    is not a free-standing setting: rendering `main` beside a child notifier does not degrade,",
    "    it fails the start job, and the sending side sees exit 0 either way.",
    "  * `NotifyAccess=all` accepts `READY=1` and `MAINPID=` from any process in the cgroup, and",
    "    case 5 measured the manager tracking as main a process it never forked. So `Type=notify`",
    "    does NOT preserve the foreground-process invariant ADR 0020 states; that invariant is a",
    "    property this project keeps deliberately, and `serve --detach` staying absent is the way",
    "    it keeps it.",
    "  * It is Linux-only. macOS and Windows have no equivalent, so the authenticated `/healthz`",
    "    wait has to exist anyway. `Type=notify` would add a second readiness mechanism on one of",
    "    three platforms, and the platform-specific one is the one that would rot.",
    "",
    "What `Type=notify` buys, recorded rather than argued away: case 7 shows the manager reporting",
    "`active` for a daemon that never binds. A caller-side wait catches that at install time only;",
    "on a later boot nobody is waiting. Case 6 recovers exactly that without the protocol —",
    "`Type=exec` with the same authenticated poll as `ExecStartPost=` makes the start job fail and",
    "the daemon stop, at a cost of one line in the unit and one reusable CLI verb.",
  ]) {
    out(`  ${line}`);
  }

  section("checks");
  const failed = checks.filter((entry) => entry.ok === false);
  out(`  ${checks.length - failed.length}/${checks.length} expectations held`);
  for (const entry of failed) {
    out(`  FAILED: ${entry.label}`);
  }
  out();
  out(
    failed.length === 0 ? "P2-S4: every expectation held." : "P2-S4: an expectation did not hold.",
  );
  return failed.length === 0 ? 0 : 1;
}

/** Is there a per-user systemd manager on this machine to measure against? */
function hasUserManager() {
  if (process.platform !== "linux" || which("systemctl") === "") {
    return false;
  }
  const state = run("systemctl", ["--user", "is-system-running"]).stdout.trim();
  return state === "running" || state === "degraded" || state === "starting";
}

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

/**
 * Run the inner half in the container, streaming its transcript through this process.
 *
 * The pipes are copied rather than inherited: an inherited descriptor is whatever the caller's
 * stdout happens to be, and a run whose transcript is redirected to a file lost the container's
 * half of it. Forwarding every chunk here makes the transcript one stream whatever the caller did.
 */
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
        `${CONTAINER_REPO}/apps/cli/spikes/p2-s4-readiness.mjs`,
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
 * Boot a systemd this machine does not have, and re-execute this file inside it.
 *
 * The image COPYs nothing, so it is built against an empty context: sending the repository as a
 * build context would cost more than the whole measurement.
 */
async function viaContainer() {
  section("this host has no systemd user manager — booting one in a container");
  if (which(DOCKER) === "") {
    out(`REFUSED: neither a systemd user manager nor ${DOCKER} is available on this host.`);
    return 1;
  }
  out(
    `  ${run(DOCKER, ["version", "--format", "{{.Server.Os}}/{{.Server.Arch}} {{.Server.Version}}"]).stdout.trim()}`,
  );

  const context = mkdtempSync(join(tmpdir(), "p2s4-ctx-"));
  const keep = (process.env.XPLAINER_P2S4_KEEP ?? "") !== "";
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
      out(`  user@${CONTAINER_UID}.service is ${userState || "unknown"}:`);
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
        "REFUSED: this container could not host a `systemctl --user` instance, so the measurement " +
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

const insideAlready = process.env[INSIDE_ENV] === "1";
process.exit(insideAlready || hasUserManager() ? await measure() : await viaContainer());
