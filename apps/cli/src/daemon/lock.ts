/**
 * Exclusive ownership of the state directory, acquired before anything else happens.
 *
 * [ADR 0024](../../../../docs/adr/0024-durable-jobs-and-boot-reconciliation.md) §Exclusive
 * ownership makes the ordering an invariant — **ownership, then reconciliation, then bind** — for a
 * reason that is not about tidiness: reconciliation is the step that *rewrites other processes'
 * records*. A second `serve` started by hand while the supervised daemon is mid-render would mark
 * the live daemon's jobs `error` on paper, and kill its children in fact, and only afterwards
 * discover the port was taken. So a process that cannot acquire ownership exits
 * {@link OWNERSHIP_REFUSED_EXIT_CODE} **having touched nothing**.
 *
 * The mechanism is the one that record's note of 2026-09-06 §Ownership settles, and this file is
 * that note's `acquire()` in TypeScript. `apps/cli/spikes/p1-s1-ownership.mjs` remains the
 * measurement — it is a check, not a demo, and it exits non-zero if an expectation the note quotes
 * stops holding — and the logic is deliberately the same shape here so the two cannot drift into
 * two different locks.
 *
 * The three steps, and why each one is there:
 *
 * 1. **`O_EXCL` create.** Success is ownership, and it is the only path with no inference in it.
 * 2. **`EEXIST` → classify the holder by the tuple, never by the pid alone.** Three conditions are
 *    stale: not alive; alive but with a different start time, which is pid reuse; and zero-length,
 *    which is an acquirer that died between the `O_EXCL` and the write. A zero-length lock is a
 *    real state rather than corruption, and an unparseable non-empty one refuses, because nothing
 *    about it can be proven and ADR 0024's driver is that a wrong kill is worse than a leaked
 *    process.
 * 3. **Takeover settles before it is believed.** Two processes can both find the same stale lock,
 *    and the guarded unlink narrows but does not close that window. So a process that took over
 *    waits {@link SETTLE_MS}, re-reads, and checks the nonce is still its own; the loser exits `10`
 *    before it has reconciled anything.
 *
 * **Why a lock file and not an advisory lock.** A kernel-released `flock`/`LockFileEx` needs no
 * staleness inference at all, and would be better — but Node core exposes neither, so it is
 * reachable only through a native dependency, and ADR 0020 makes `npx` the supported install path.
 * The price of inference is step 3's 100 ms settle, paid only on the crash-recovery path.
 *
 * **Not measured, and therefore not claimed:** `O_EXCL` on a network or container-shared home
 * directory. The ADR note leaves that open and so does this file; the store treats the state
 * directory as local storage.
 */

import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { ensureStateDirectory, flushDirectory } from "./durable-write.js";
import { OWNERSHIP_REFUSED_EXIT_CODE } from "./exit-codes.js";
import { STATE_FILE_MODE, stateDirLayout } from "./state-dir.js";
import { isAlive, processStartToken, selfIdentity } from "./worker-identity.js";

/** Every record in this store carries one (ADR 0024 §An unknown format version is not corruption). */
export const LOCK_FORMAT_VERSION = 1;

/** How long a process that took over a stale lock waits before believing it won the race. */
export const SETTLE_MS = 100;

/** What the lock file holds: the identity tuple, plus enough context to debug it with `cat`. */
export type OwnershipRecord = {
  format_version: number;
  /** The owning process. */
  pid: number;
  /** Its start token, which is the half of the identity that a pid alone cannot give. */
  start_time: string | null;
  /** The machine boot this daemon belongs to. */
  boot_id: string | null;
  /** Unique to this acquisition, and the value a takeover reads back to confirm it won. */
  boot_nonce: string;
  hostname: string;
  acquired_at: string;
};

/** The outcome of an acquisition attempt, with the steps it took, for the log. */
export type Acquisition =
  | { ok: true; record: OwnershipRecord; steps: string[] }
  | { ok: false; record: null; steps: string[] };

/** A lock file as it was found on disk: four states, kept apart because they mean four things. */
export type HeldLock = {
  state: "absent" | "empty" | "parsed" | "unparseable";
  raw: string | null;
  record: Partial<OwnershipRecord> | null;
};

function codeOf(error: unknown): string {
  return error instanceof Error && "code" in error ? String(error.code) : "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

function selfRecord(): OwnershipRecord {
  const self = selfIdentity();
  return {
    format_version: LOCK_FORMAT_VERSION,
    pid: self.pid,
    start_time: self.start_time,
    boot_id: self.boot_id,
    boot_nonce: randomUUID(),
    hostname: hostname(),
    acquired_at: new Date().toISOString(),
  };
}

/** Create the lock with `O_EXCL`, so two processes cannot both believe they made it. */
function writeLock(path: string, record: OwnershipRecord): void {
  const fd = openSync(path, "wx", STATE_FILE_MODE);
  try {
    writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Read the lock file, telling absent, empty, parsed and unparseable apart. */
export function readLock(path: string): HeldLock {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { state: "absent", raw: null, record: null };
  }
  if (raw.trim() === "") {
    return { state: "empty", raw, record: null };
  }
  try {
    return { state: "parsed", raw, record: JSON.parse(raw) as Partial<OwnershipRecord> };
  } catch {
    return { state: "unparseable", raw, record: null };
  }
}

/**
 * Is the lock held by a process that is still the one that wrote it?
 *
 * Three of the five answers are "no, take it over" and two are "yes, refuse". The pair that matters
 * is a live pid whose token **differs** (pid reuse, take over) against a live pid whose token
 * **matches** (refuse) — scenarios `[D]` and `[E]` in ADR 0024's note, which are the same live pid
 * with opposite verdicts.
 */
export function classifyHolder(held: HeldLock): { live: boolean; reason: string } {
  if (held.state === "empty") {
    return {
      live: false,
      reason: "zero-length lock: an acquirer died between O_EXCL and the write",
    };
  }
  if (held.state !== "parsed" || held.record === null) {
    return { live: true, reason: `lock is ${held.state}; refusing rather than guessing` };
  }
  const { pid, start_time: recorded } = held.record;
  if (typeof pid !== "number") {
    return { live: true, reason: "lock carries no pid; refusing rather than guessing" };
  }
  if (!isAlive(pid)) {
    return { live: false, reason: `pid ${pid} is not alive` };
  }
  const observed = processStartToken(pid);
  if (recorded !== undefined && recorded !== null && observed !== null && observed !== recorded) {
    return {
      live: false,
      reason: `pid ${pid} is alive but started "${observed}", not "${recorded}" — the number was reused`,
    };
  }
  return { live: true, reason: `pid ${pid} is alive and started "${observed}"` };
}

/**
 * Acquire the state directory, or return having written nothing.
 *
 * Every early return on the refusal path leaves the directory exactly as it was found — the
 * property `start.test.ts` hashes, because it is the whole reason ownership precedes
 * reconciliation. Creating the state directory itself is the one write that precedes the lock, and
 * it happens only when the directory does not exist, in which case there was nothing in it to
 * disturb.
 */
export async function acquireOwnership(stateDir: string): Promise<Acquisition> {
  ensureStateDirectory(stateDir);
  const { lock } = stateDirLayout(stateDir);
  const mine = selfRecord();
  const steps: string[] = [];

  try {
    writeLock(lock, mine);
    steps.push(`O_EXCL create succeeded; directory flush after it: ${flushDirectory(stateDir)}`);
    return { ok: true, record: mine, steps };
  } catch (error) {
    if (codeOf(error) !== "EEXIST") {
      throw error;
    }
    steps.push("O_EXCL create refused with EEXIST — inspecting the holder");
  }

  const held = readLock(lock);
  const verdict = classifyHolder(held);
  steps.push(`holder: ${verdict.reason}`);
  if (verdict.live) {
    steps.push(`refusing with exit ${OWNERSHIP_REFUSED_EXIT_CODE}, having written nothing`);
    return { ok: false, record: null, steps };
  }

  const again = readLock(lock);
  if (again.raw !== held.raw) {
    steps.push("the stale lock changed while it was being read — another taker won; refusing");
    return { ok: false, record: null, steps };
  }
  try {
    unlinkSync(lock);
  } catch (error) {
    if (codeOf(error) !== "ENOENT") {
      throw error;
    }
  }
  try {
    writeLock(lock, mine);
  } catch (error) {
    if (codeOf(error) !== "EEXIST") {
      throw error;
    }
    steps.push("lost the takeover race at the second O_EXCL create; refusing");
    return { ok: false, record: null, steps };
  }
  steps.push(`took over the stale lock; directory flush after it: ${flushDirectory(stateDir)}`);

  await sleep(SETTLE_MS);
  const settled = readLock(lock);
  if (settled.record === null || settled.record.boot_nonce !== mine.boot_nonce) {
    steps.push(`read-back after ${SETTLE_MS} ms found another owner; refusing`);
    return { ok: false, record: null, steps };
  }
  steps.push(`read-back after ${SETTLE_MS} ms confirms the lock is ours`);
  return { ok: true, record: mine, steps };
}

/**
 * Give the directory back, but only if the lock is still the one this process wrote.
 *
 * The nonce check is what stops a late `close()` from deleting a *successor's* lock: a daemon that
 * was declared stale and taken over must not unlink the new owner's file on its way out.
 */
export function releaseOwnership(stateDir: string, record: OwnershipRecord): boolean {
  const { lock } = stateDirLayout(stateDir);
  const held = readLock(lock);
  if (held.record === null || held.record.boot_nonce !== record.boot_nonce) {
    return false;
  }
  try {
    unlinkSync(lock);
  } catch (error) {
    if (codeOf(error) !== "ENOENT") {
      throw error;
    }
  }
  flushDirectory(stateDir);
  return true;
}
