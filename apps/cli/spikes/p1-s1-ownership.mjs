#!/usr/bin/env node
/**
 * Spike P1-S1 — exclusive ownership, storage shape, write durability, process identity.
 *
 * `docs/adr/0024-durable-jobs-and-boot-reconciliation.md` states four binding decisions over four
 * mechanisms it marks *proposed*, and assigns all four mechanisms to this spike because "the four
 * answers constrain one another" (`docs/ROADMAP.md`, P1-S1). This script is the measurement. It is
 * plain Node with no dependencies — it is deliberately **not** part of the build (`tsconfig.json`
 * and `tsconfig.build.json` both `include` only `src`), so it can be run against any checkout
 * without one:
 *
 *     node apps/cli/spikes/p1-s1-ownership.mjs
 *
 * It exits `0` when every ownership expectation held and non-zero when one did not, so it is a
 * check and not a demo. The numbers it prints are machine- and filesystem-specific by nature; the
 * note in ADR 0024 quotes the run that settled the spike and names the machine.
 *
 * WHAT IT MEASURES, IN THE ORDER ADR 0024 ASKS.
 *
 *   1. Ownership (§Exclusive ownership). Six scenarios against a real lock file created with
 *      `O_EXCL`, each in its own temporary state directory, each run in a child process so the
 *      exit code is the real one: a fresh acquire; a second acquirer refused while the holder
 *      lives, with the state directory hashed before and after to prove it wrote nothing; a
 *      takeover after the holder is `SIGKILL`ed; a takeover when the lock names a live pid whose
 *      start time does not match, which is pid reuse; a refusal when the pid *and* the start time
 *      both match; and a takeover of a zero-length lock, which is an acquirer that died between
 *      the `O_EXCL` create and the write.
 *
 *   2. Storage shape (§Durability). 200 job records written four ways — no flush, flush the file,
 *      flush the file and then the containing directory, and `node:sqlite` in WAL mode at
 *      `synchronous = FULL` and at `NORMAL` — plus the cost of the listing `explainer_list` needs,
 *      plus a crash test that `SIGKILL`s a child immediately after it reports each id durable and
 *      then counts what survived. That last one is the only part of this that is about
 *      correctness rather than speed.
 *
 *   3. Write durability (§Durability of the write itself). What `fsync` on a directory descriptor
 *      costs and whether it is even available, measured rather than assumed, because Windows has
 *      no directory handle to sync and the record refuses to assert one behaviour for all three
 *      platforms.
 *
 *   4. Process identity (§A recorded PID is not an identity). The identity tuple this machine can
 *      actually produce, printed verbatim from `ps -o pid=,lstart=`, with its resolution.
 *
 * WHY THE LOCK IS A FILE AND NOT AN ADVISORY LOCK. Node core exposes no `flock(2)` and no
 * `LockFileEx`, so a kernel-released lock — the one primitive that needs no staleness inference at
 * all — is reachable only through a native dependency, and ADR 0020 makes `npx` the supported
 * install path. `O_EXCL` is therefore the exclusion primitive and staleness is inferred from an
 * identity tuple, which is exactly the trade ADR 0024's spike text asks this script to price.
 *
 * WHY A TAKEOVER SETTLES BEFORE IT IS BELIEVED. Two processes can both find the same stale lock,
 * and the guarded unlink below narrows but does not close that window: between one process
 * re-reading the stale bytes and unlinking them, another can have unlinked and recreated. So a
 * process that took over waits, re-reads, and checks that the nonce in the lock is still its own.
 * The loser exits `10` before it has reconciled anything, which is what ADR 0024 requires — the
 * ordering is ownership, then reconciliation, then bind, and only the first step has run.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fdatasyncSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

/** The ownership artefact ADR 0024 §Consequences adds to the state directory. */
const LOCK_NAME = "owner.lock";

/** Every record in this store carries one, per ADR 0024 §An unknown format version is not corruption. */
const LOCK_FORMAT_VERSION = 1;

/** ADR 0020's "another process already holds this machine's runtime", reused by ADR 0024. */
const REFUSED_EXIT_CODE = 10;

/** How long a process that took over a stale lock waits before believing it won the race. */
const SETTLE_MS = 100;

/** Enough records that a per-record cost is visible over the noise, and still a second or two. */
const RECORD_COUNT = 200;

/** Records the crash child writes before it kills itself. */
const CRASH_COUNT = 20;

/** The holder's keep-alive tick, and the number of ticks after which it gives up on its own. */
const HOLD_TICK_MS = 250;
const HOLD_MAX_TICKS = 240;

const SELF = fileURLToPath(import.meta.url);

function out(line) {
  process.stdout.write(`${line}\n`);
}

function codeOf(error) {
  return error instanceof Error && "code" in error ? String(error.code) : "";
}

function describe(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function sleep(ms) {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

/**
 * The half of the identity tuple that is not the pid.
 *
 * macOS has no `/proc`, so the portable-enough answer without a native module is `ps`. Linux has
 * the better one — field 22 of `/proc/<pid>/stat` is the start time in clock ticks since boot, so
 * it is both finer-grained and immune to a locale-formatted date. Windows is neither and is not
 * reachable from here; ADR 0024's note records what it would use.
 */
function processStartToken(pid) {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return `starttime=${fields[19]}`;
    } catch {
      return null;
    }
  }
  const ps = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  if (ps.status !== 0 || typeof ps.stdout !== "string") {
    return null;
  }
  const token = ps.stdout.trim();
  return token === "" ? null : token;
}

/**
 * Liveness only — never identity. `EPERM` means the pid exists and belongs to another user, which
 * is still "alive"; anything else means it does not exist.
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codeOf(error) === "EPERM";
  }
}

/**
 * Memoised, because `ps` is a process spawn and costs milliseconds. Measured before this cache
 * existed, calling it once per record made every storage-shape number 4.5 ms per record and hid
 * the thing being measured entirely — a reminder that the identity probe is not free and the job
 * store must read it once per acquisition, never once per write.
 */
let cachedStartToken;

function selfStartToken() {
  if (cachedStartToken === undefined) {
    cachedStartToken = processStartToken(process.pid);
  }
  return cachedStartToken;
}

function selfRecord() {
  return {
    format_version: LOCK_FORMAT_VERSION,
    pid: process.pid,
    start_time: selfStartToken(),
    boot_nonce: randomUUID(),
    hostname: hostname(),
    acquired_at: new Date().toISOString(),
  };
}

/**
 * Flush the directory entry a rename created, and report what happened rather than throwing.
 *
 * This is the measurement ADR 0024 §Durability of the write itself asks for: the record requires
 * the flush and refuses to assert one behaviour for all three platforms, so the script reports the
 * platform's answer instead of assuming it. On Windows `openSync` on a directory fails, and that
 * failure is the finding.
 */
function flushDirectory(dir) {
  let fd;
  try {
    fd = openSync(dir, "r");
  } catch (error) {
    return `unavailable (${describe(error)})`;
  }
  try {
    fsyncSync(fd);
    return "ok";
  } catch (error) {
    return `refused (${describe(error)})`;
  } finally {
    closeSync(fd);
  }
}

function writeLock(path, record) {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readLock(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { state: "absent", raw: null, record: null };
  }
  if (raw.trim() === "") {
    return { state: "empty", raw, record: null };
  }
  try {
    return { state: "parsed", raw, record: JSON.parse(raw) };
  } catch {
    return { state: "unparseable", raw, record: null };
  }
}

/**
 * Is the lock held by a process that is still the one that wrote it?
 *
 * Three of the five answers are "no, take it over" and two are "yes, refuse". An unparseable but
 * non-empty lock refuses, because nothing about it can be proven and ADR 0024's driver is that a
 * wrong kill is worse than a leaked process. A zero-length one is different in kind: `O_EXCL`
 * create and the write are two steps, so a zero-length lock is an acquirer that died between them
 * and it names nobody at all.
 */
function classifyHolder(held) {
  if (held.state === "empty") {
    return {
      live: false,
      reason: "zero-length lock: an acquirer died between O_EXCL and the write",
    };
  }
  if (held.state !== "parsed" || held.record === null) {
    return { live: true, reason: `lock is ${held.state}; refusing rather than guessing` };
  }
  const pid = held.record.pid;
  const recorded = held.record.start_time;
  if (typeof pid !== "number") {
    return { live: true, reason: "lock carries no pid; refusing rather than guessing" };
  }
  if (!isAlive(pid)) {
    return { live: false, reason: `pid ${pid} is not alive` };
  }
  const observed = processStartToken(pid);
  if (recorded !== null && observed !== null && observed !== recorded) {
    return {
      live: false,
      reason: `pid ${pid} is alive but started "${observed}", not "${recorded}" — the number was reused`,
    };
  }
  return { live: true, reason: `pid ${pid} is alive and started "${observed}"` };
}

/**
 * ADR 0024 §Exclusive ownership, as code: acquire, or return without having written anything.
 *
 * Every early return on the refusal path leaves the directory exactly as it was found. That is the
 * property scenario 2 below hashes, because it is the whole reason ownership precedes
 * reconciliation: a second `serve` that reconciled first would rewrite a live daemon's job records
 * before discovering it was not allowed to.
 */
async function acquire(stateDir) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lockPath = join(stateDir, LOCK_NAME);
  const mine = selfRecord();
  const steps = [];

  try {
    writeLock(lockPath, mine);
    steps.push(`O_EXCL create succeeded; directory flush after it: ${flushDirectory(stateDir)}`);
    return { ok: true, record: mine, steps };
  } catch (error) {
    if (codeOf(error) !== "EEXIST") {
      throw error;
    }
    steps.push("O_EXCL create refused with EEXIST — inspecting the holder");
  }

  const held = readLock(lockPath);
  const verdict = classifyHolder(held);
  steps.push(`holder: ${verdict.reason}`);
  if (verdict.live) {
    steps.push(`refusing with exit ${REFUSED_EXIT_CODE}, having written nothing`);
    return { ok: false, record: null, steps };
  }

  const again = readLock(lockPath);
  if (again.raw !== held.raw) {
    steps.push("the stale lock changed while it was being read — another taker won; refusing");
    return { ok: false, record: null, steps };
  }
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (codeOf(error) !== "ENOENT") {
      throw error;
    }
  }
  try {
    writeLock(lockPath, mine);
  } catch (error) {
    if (codeOf(error) !== "EEXIST") {
      throw error;
    }
    steps.push("lost the takeover race at the second O_EXCL create; refusing");
    return { ok: false, record: null, steps };
  }
  steps.push(`took over the stale lock; directory flush after it: ${flushDirectory(stateDir)}`);

  await sleep(SETTLE_MS);
  const settled = readLock(lockPath);
  if (settled.record === null || settled.record.boot_nonce !== mine.boot_nonce) {
    steps.push(`read-back after ${SETTLE_MS} ms found another owner; refusing`);
    return { ok: false, record: null, steps };
  }
  steps.push(`read-back after ${SETTLE_MS} ms confirms the lock is ours`);
  return { ok: true, record: mine, steps };
}

/** A content hash of every file in a directory: the evidence that a refusal wrote nothing. */
function snapshot(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(dir, entry.name);
      const stat = statSync(path);
      const digest = createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
      return `${entry.name} size=${stat.size} mtimeMs=${stat.mtimeMs} sha256:${digest}`;
    })
    .sort()
    .join(" | ");
}

/** A job record of the shape ADR 0008 fixed, at a realistic size, used by every benchmark. */
function sampleJobRecord(index) {
  return {
    format_version: LOCK_FORMAT_VERSION,
    job_id: `job_${String(index).padStart(6, "0")}`,
    kind: "render",
    status: "queued",
    video_id: "how-dns-works",
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    exit_code: null,
    error: null,
    error_code: null,
    workers_uncertain: false,
    owner: { pid: process.pid, start_time: selfStartToken() },
    output: { lines: Array.from({ length: 8 }, (_, i) => `[worker] line ${i} of a bounded tail`) },
  };
}

function benchJsonWrites(dir, flush) {
  mkdirSync(dir, { recursive: true });
  const started = performance.now();
  for (let i = 0; i < RECORD_COUNT; i += 1) {
    const payload = JSON.stringify(sampleJobRecord(i));
    const tmp = join(dir, `.job-${i}.tmp`);
    const final = join(dir, `job-${i}.json`);
    const fd = openSync(tmp, "w", 0o600);
    writeSync(fd, payload);
    if (flush === "fdatasync") {
      fdatasyncSync(fd);
    } else if (flush !== "none") {
      fsyncSync(fd);
    }
    closeSync(fd);
    renameSync(tmp, final);
    if (flush === "file+dir") {
      flushDirectory(dir);
    }
  }
  return performance.now() - started;
}

/**
 * SQLite's `fullfsync` pragma is the whole reason the two shapes can be compared at all.
 *
 * Node's `fs.fsyncSync` on macOS is `fcntl(F_FULLFSYNC)` (libuv `uv__fs_fsync`), but SQLite's own
 * unix VFS calls plain `fsync(2)` unless `PRAGMA fullfsync` is on — and Apple's `fsync(2)` man
 * page says in as many words that the drive "may not physically write the data to the platters for
 * quite some time". So a default `node:sqlite` insert and a `writeFileSync` + `fsyncSync` are not
 * the same durability, and timing them against each other without this flag would compare a strong
 * flush with a weak one and call the weak one fast.
 */
function openJobDatabase(path, synchronous, fullfsync) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`PRAGMA synchronous = ${synchronous}`);
  db.exec(`PRAGMA fullfsync = ${fullfsync ? "ON" : "OFF"}`);
  db.exec(
    "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, record TEXT NOT NULL)",
  );
  return db;
}

function benchSqliteWrites(dir, synchronous, fullfsync) {
  mkdirSync(dir, { recursive: true });
  const db = openJobDatabase(join(dir, "jobs.db"), synchronous, fullfsync);
  const mode = db.prepare("PRAGMA journal_mode").get();
  const effective = db.prepare("PRAGMA fullfsync").get();
  const insert = db.prepare("INSERT INTO jobs (id, status, record) VALUES (?, ?, ?)");
  const started = performance.now();
  for (let i = 0; i < RECORD_COUNT; i += 1) {
    insert.run(`job_${i}`, "queued", JSON.stringify(sampleJobRecord(i)));
  }
  const elapsed = performance.now() - started;
  db.close();
  return { elapsed, mode: String(mode.journal_mode), fullfsync: Number(effective.fullfsync) };
}

function benchJsonList(dir) {
  const started = performance.now();
  let queued = 0;
  const names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  for (const name of names) {
    if (JSON.parse(readFileSync(join(dir, name), "utf8")).status === "queued") {
      queued += 1;
    }
  }
  return { elapsed: performance.now() - started, matched: queued, scanned: names.length };
}

function benchSqliteList(dir) {
  const db = new DatabaseSync(join(dir, "jobs.db"));
  const started = performance.now();
  const rows = db.prepare("SELECT id, status FROM jobs WHERE status = ?").all("queued");
  const elapsed = performance.now() - started;
  db.close();
  return { elapsed, matched: rows.length };
}

/** Run this script again, in a child process, so an exit code is a real exit code. */
function runSpike(args) {
  const result = spawnSync(process.execPath, [SELF, ...args], { encoding: "utf8" });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

let failures = 0;

function expect(label, actual, wanted) {
  const ok = actual === wanted;
  if (!ok) {
    failures += 1;
  }
  out(
    `    ${ok ? "PASS" : "FAIL"}  ${label}: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`,
  );
}

function quote(text) {
  return text
    .trimEnd()
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n");
}

async function modeTry(stateDir) {
  const result = await acquire(stateDir);
  for (const step of result.steps) {
    out(`[try ${process.pid}] ${step}`);
  }
  out(`[try ${process.pid}] outcome=${result.ok ? "acquired" : "refused"}`);
  process.exitCode = result.ok ? 0 : REFUSED_EXIT_CODE;
}

async function modeHold(stateDir) {
  const result = await acquire(stateDir);
  if (!result.ok) {
    out(`[hold ${process.pid}] could not acquire`);
    process.exitCode = REFUSED_EXIT_CODE;
    return;
  }
  out(`[hold ${process.pid}] READY`);
  // A registered signal handler is not enough to hold the event loop open here: Node exits with
  // code 13 and "Detected unsettled top-level await" the moment the loop drains, which measured
  // meant the holder died on its own and scenario [C] proved nothing. An interval is a real
  // handle. It is bounded so a stray holder can never outlive the run that spawned it.
  let ticks = 0;
  const heartbeat = setInterval(() => {
    ticks += 1;
    if (ticks >= HOLD_MAX_TICKS) {
      clearInterval(heartbeat);
    }
  }, HOLD_TICK_MS);
  await new Promise((keepAlive) => {
    process.once("SIGTERM", () => {
      clearInterval(heartbeat);
      keepAlive("terminated");
    });
  });
}

/**
 * Write records the way the store would, announce each id only once it is durable, then die the
 * way an OOM kill does. Whatever this printed must be on disk afterwards; that is the property
 * ADR 0024 §Durability of the write itself exists to buy.
 */
function modeCrashJson(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let i = 0; i < CRASH_COUNT; i += 1) {
    const record = sampleJobRecord(i);
    const tmp = join(dir, `.${record.job_id}.tmp`);
    const final = join(dir, `${record.job_id}.json`);
    const fd = openSync(tmp, "w", 0o600);
    writeSync(fd, JSON.stringify(record));
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, final);
    flushDirectory(dir);
    out(`durable ${record.job_id}`);
  }
  process.kill(process.pid, "SIGKILL");
}

function modeCrashSqlite(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = openJobDatabase(join(dir, "jobs.db"), "FULL", true);
  const insert = db.prepare("INSERT INTO jobs (id, status, record) VALUES (?, ?, ?)");
  for (let i = 0; i < CRASH_COUNT; i += 1) {
    const record = sampleJobRecord(i);
    insert.run(record.job_id, record.status, JSON.stringify(record));
    out(`durable ${record.job_id}`);
  }
  process.kill(process.pid, "SIGKILL");
}

function announcedIds(stdout) {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("durable "))
    .map((line) => line.slice("durable ".length).trim());
}

async function scenarioOwnership(root) {
  out("");
  out("=== 1. Ownership (ADR 0024 §Exclusive ownership) ===");

  out("");
  out("  [A] a fresh state directory: O_EXCL creates the lock");
  const dirA = join(root, "a-fresh");
  const a = runSpike(["try", dirA]);
  out(quote(a.stdout));
  expect("exit code", a.status, 0);
  out("      lock file:");
  out(quote(readFileSync(join(dirA, LOCK_NAME), "utf8")));

  out("");
  out("  [B] a second acquirer while the holder is alive: refused, and it wrote nothing");
  const dirB = join(root, "b-contended");
  const holder = spawn(process.execPath, [SELF, "hold", dirB], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const ready = await new Promise((resolve, reject) => {
    let buffered = "";
    holder.stdout.setEncoding("utf8");
    holder.stdout.on("data", (chunk) => {
      buffered += chunk;
      if (buffered.includes("READY")) {
        resolve(buffered);
      }
    });
    holder.on("error", reject);
    holder.on("exit", () => reject(new Error("the holder exited before it was ready")));
  });
  out(quote(ready));
  const before = snapshot(dirB);
  const b = runSpike(["try", dirB]);
  const after = snapshot(dirB);
  out(quote(b.stdout));
  expect("exit code", b.status, REFUSED_EXIT_CODE);
  expect("state directory unchanged", after, before);
  expect("the holder was still alive throughout", holder.exitCode, null);
  out(`      directory before: ${before}`);
  out(`      directory after:  ${after}`);

  out("");
  out("  [C] the same directory after the holder is SIGKILLed: taken over");
  holder.kill("SIGKILL");
  const holderExit = await new Promise((resolve) => {
    holder.on("exit", (code, signal) => resolve({ code, signal }));
  });
  out(`      holder exit: code=${holderExit.code} signal=${holderExit.signal}`);
  expect("the holder died by SIGKILL, not on its own", holderExit.signal, "SIGKILL");
  const c = runSpike(["try", dirB]);
  out(quote(c.stdout));
  expect("exit code", c.status, 0);

  out("");
  out("  [D] a lock naming a live pid whose start time does not match: pid reuse, taken over");
  const dirD = join(root, "d-pid-reuse");
  mkdirSync(dirD, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dirD, LOCK_NAME),
    `${JSON.stringify(
      { ...selfRecord(), start_time: "Thu Jan  1 00:00:00 1970", pid: process.pid },
      null,
      2,
    )}\n`,
  );
  const d = runSpike(["try", dirD]);
  out(quote(d.stdout));
  expect("exit code", d.status, 0);

  out("");
  out("  [E] a lock naming the same live pid AND its real start time: refused (control for D)");
  const dirE = join(root, "e-live-tuple");
  mkdirSync(dirE, { recursive: true, mode: 0o700 });
  writeFileSync(join(dirE, LOCK_NAME), `${JSON.stringify(selfRecord(), null, 2)}\n`);
  const e = runSpike(["try", dirE]);
  out(quote(e.stdout));
  expect("exit code", e.status, REFUSED_EXIT_CODE);

  out("");
  out("  [F] a zero-length lock — an acquirer that died between O_EXCL and the write: taken over");
  const dirF = join(root, "f-torn");
  mkdirSync(dirF, { recursive: true, mode: 0o700 });
  writeFileSync(join(dirF, LOCK_NAME), "");
  const f = runSpike(["try", dirF]);
  out(quote(f.stdout));
  expect("exit code", f.status, 0);
}

function scenarioIdentity() {
  out("");
  out("=== 4. Process identity (ADR 0024 §A recorded PID is not an identity) ===");
  out("");
  const ps = spawnSync("ps", ["-o", "pid=,lstart=", "-p", String(process.pid)], {
    encoding: "utf8",
  });
  out(`  $ ps -o pid=,lstart= -p $$        (this process, pid ${process.pid})`);
  out(quote(typeof ps.stdout === "string" && ps.stdout.trim() !== "" ? ps.stdout : "<no output>"));
  out(`  ps exit status: ${ps.status}`);
  out(`  identity token this platform yields: ${JSON.stringify(processStartToken(process.pid))}`);
  out(`  platform: ${process.platform}  node: ${process.version}  libuv: ${process.versions.uv}`);
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  });
  const deadPid = Number(child.stdout);
  out(
    `  a child that has already exited (pid ${deadPid}): isAlive=${isAlive(deadPid)}, token=${JSON.stringify(processStartToken(deadPid))}`,
  );
}

async function scenarioDurability(root) {
  out("");
  out("=== 3. Write durability (ADR 0024 §Durability of the write itself) ===");
  out("");
  const probe = join(root, "flush-probe");
  mkdirSync(probe, { recursive: true });
  out(`  fsync on a directory descriptor: ${flushDirectory(probe)}`);
  const flushStart = performance.now();
  for (let i = 0; i < RECORD_COUNT; i += 1) {
    flushDirectory(probe);
  }
  const perFlush = (performance.now() - flushStart) / RECORD_COUNT;
  out(`  ${RECORD_COUNT} bare directory flushes: ${perFlush.toFixed(3)} ms each`);
  out("  Node's fs.fsyncSync on macOS is fcntl(F_FULLFSYNC), not fsync(2) — libuv src/unix/fs.c");
  out(
    "  uv__fs_fsync tries F_FULLFSYNC, then F_BARRIERFSYNC, then fsync (libuv " +
      `${process.versions.uv}).`,
  );

  out("");
  out("=== 2. Storage shape (ADR 0024 §Durability) ===");
  out("");
  for (const flush of ["none", "fdatasync", "file", "file+dir"]) {
    const elapsed = benchJsonWrites(join(root, `json-${flush.replace("+", "-")}`), flush);
    out(
      `  ${RECORD_COUNT} JSON records, temp-then-rename, flush=${flush.padEnd(9)}: ` +
        `${elapsed.toFixed(1)} ms total, ${(elapsed / RECORD_COUNT).toFixed(3)} ms per record`,
    );
  }
  const sqliteRuns = [
    { synchronous: "FULL", fullfsync: true },
    { synchronous: "FULL", fullfsync: false },
    { synchronous: "NORMAL", fullfsync: false },
  ];
  for (const run of sqliteRuns) {
    const label = `${run.synchronous.toLowerCase()}-${run.fullfsync ? "on" : "off"}`;
    const result = benchSqliteWrites(join(root, `sqlite-${label}`), run.synchronous, run.fullfsync);
    out(
      `  ${RECORD_COUNT} node:sqlite inserts, journal_mode=${result.mode}, ` +
        `synchronous=${run.synchronous.padEnd(6)} fullfsync=${result.fullfsync}: ` +
        `${result.elapsed.toFixed(1)} ms total, ` +
        `${(result.elapsed / RECORD_COUNT).toFixed(3)} ms per record`,
    );
  }

  out("");
  const jsonList = benchJsonList(join(root, "json-file-dir"));
  out(
    `  explainer_list over ${jsonList.scanned} JSON files (readdir + read + parse): ` +
      `${jsonList.elapsed.toFixed(1)} ms, ${jsonList.matched} queued`,
  );
  const sqliteList = benchSqliteList(join(root, "sqlite-full-on"));
  out(
    `  explainer_list as one indexed SELECT over the same ${RECORD_COUNT} rows: ` +
      `${sqliteList.elapsed.toFixed(1)} ms, ${sqliteList.matched} queued`,
  );

  out("");
  out("  crash consistency: SIGKILL immediately after each id is reported durable");
  const crashJsonDir = join(root, "crash-json");
  const crashJson = runSpike(["crash-json", crashJsonDir]);
  const jsonIds = announcedIds(crashJson.stdout);
  const jsonSurvivors = jsonIds.filter((id) => {
    const read = readLock(join(crashJsonDir, `${id}.json`));
    return read.state === "parsed" && read.record.job_id === id;
  });
  out(
    `      one-JSON-file-per-job: announced ${jsonIds.length}, recovered ${jsonSurvivors.length}`,
  );
  expect("JSON records announced are all recoverable", jsonSurvivors.length, jsonIds.length);

  const crashSqliteDir = join(root, "crash-sqlite");
  const crashSqlite = runSpike(["crash-sqlite", crashSqliteDir]);
  const sqliteIds = announcedIds(crashSqlite.stdout);
  const reopened = new DatabaseSync(join(crashSqliteDir, "jobs.db"));
  const recovered = reopened
    .prepare("SELECT id FROM jobs")
    .all()
    .map((row) => String(row.id));
  reopened.close();
  out(`      node:sqlite WAL: announced ${sqliteIds.length}, recovered ${recovered.length}`);
  expect(
    "WAL rows announced are all recoverable",
    sqliteIds.every((id) => recovered.includes(id)),
    true,
  );
}

async function runAll() {
  const root = mkdtempSync(join(tmpdir(), "p1-s1-"));
  out(`P1-S1 ownership spike — ${new Date().toISOString()}`);
  out(`node ${process.version} on ${process.platform}/${process.arch}, scratch root ${root}`);
  try {
    await scenarioOwnership(root);
    await scenarioDurability(root);
    scenarioIdentity();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  out("");
  out(failures === 0 ? "ALL OWNERSHIP EXPECTATIONS HELD" : `${failures} EXPECTATION(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

const [mode, argument] = process.argv.slice(2);
if (mode === undefined || mode === "all") {
  await runAll();
} else if (mode === "try" && argument !== undefined) {
  await modeTry(argument);
} else if (mode === "hold" && argument !== undefined) {
  await modeHold(argument);
} else if (mode === "crash-json" && argument !== undefined) {
  modeCrashJson(argument);
} else if (mode === "crash-sqlite" && argument !== undefined) {
  modeCrashSqlite(argument);
} else {
  process.stderr.write(
    "usage: node apps/cli/spikes/p1-s1-ownership.mjs [all | try <dir> | hold <dir> | " +
      "crash-json <dir> | crash-sqlite <dir>]\n",
  );
  process.exitCode = 2;
}
