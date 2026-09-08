/**
 * The operation lock: one installer or updater at a time, and it is **not** `owner.lock`.
 *
 * `owner.lock` belongs to the **running daemon** — ADR 0024 §Exclusive ownership makes it the thing
 * a `serve` holds for its whole life, because reconciliation rewrites other processes' records. An
 * updater is not a daemon: it drains the holder of that lock on purpose, and a transaction that
 * took `owner.lock` could never run at all while the daemon it is replacing is up. So the two
 * questions are two files. `update.lock` answers "is another update or install in progress", and it
 * is held for seconds by a process that owns no state directory.
 *
 * **The mechanism is `daemon/lock.ts`'s, deliberately.** The three steps are the ones ADR 0024's
 * note of 2026-09-06 §Ownership settles — `O_EXCL` create, classify an existing holder by the
 * **tuple** rather than the pid, and settle-then-read-back after a takeover — and
 * {@link classifyHolder} and {@link readLock} are imported rather than re-derived so the two locks
 * cannot drift into two different opinions about what "stale" means. What is *not* shared is the
 * path and the record's `operation` field, which is the whole difference.
 *
 * **A stale lock must be takeable, or recovery could never run.** The failure this story is built
 * around is an updater that dies mid-transaction, and such an updater leaves its lock behind. If
 * that file were permanent, `xplainer daemon recover` — the one command the design promises will
 * restore service — would refuse for ever. So a lock whose holder is provably gone is taken over,
 * with the same 100 ms settle and nonce read-back that keeps two simultaneous takers from both
 * believing they won.
 *
 * **The refusal is exit `10`, and it is not a new code.** ADR 0020 gives `10` to "the recorded port
 * is taken" and ADR 0024 §Exclusive ownership reuses it for a refused lock — "ownership failure is
 * the same condition detected earlier, and reuses the code rather than adding an eleventh one for a
 * user-visible situation that is identical". A second updater is exactly that situation.
 */

import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  ensureStateDirectory,
  flushDirectory,
  removeIfPresent,
} from "../../daemon/durable-write.js";
import { OWNERSHIP_REFUSED_EXIT_CODE } from "../../daemon/exit-codes.js";
import { classifyHolder, type HeldLock, readLock, SETTLE_MS } from "../../daemon/lock.js";
import { STATE_FILE_MODE } from "../../daemon/state-dir.js";
import { selfIdentity } from "../../daemon/worker-identity.js";

/** The operation lock's file name inside the state directory. Never `owner.lock`. */
export const OPERATION_LOCK_FILE = "update.lock";

/** Every record in this store carries one (ADR 0024 §An unknown format version is not corruption). */
export const OPERATION_LOCK_FORMAT_VERSION = 1;

/** Which operation is holding it. Recorded so a refusal can say what it is waiting for. */
export type LockedOperation = "install" | "update" | "recover" | "uninstall";

/** What the lock file holds: the identity tuple, the operation, and enough to debug it with `cat`. */
export type OperationLockRecord = {
  format_version: number;
  operation: LockedOperation;
  pid: number;
  start_time: string | null;
  /** Unique to this acquisition, and the value a takeover reads back to confirm it won. */
  boot_nonce: string;
  hostname: string;
  acquired_at: string;
};

/** A held operation lock, and what it took to get it. */
export type OperationLock = {
  path: string;
  record: OperationLockRecord;
  /** What the acquisition did, in order, for a transcript. */
  steps: readonly string[];
};

/** Another operation holds the lock, and this one has written nothing. */
export class OperationLockRefused extends Error {
  /** ADR 0020's `10`, reused per ADR 0024 §Exclusive ownership rather than invented. */
  readonly exitCode: number = OWNERSHIP_REFUSED_EXIT_CODE;
  /** The lock as it was found, so a caller can name the holder. */
  readonly held: HeldLock;
  readonly steps: readonly string[];

  constructor(message: string, held: HeldLock, steps: readonly string[]) {
    super(message);
    this.name = "OperationLockRefused";
    this.held = held;
    this.steps = steps;
  }
}

/** `<state>/update.lock`. */
export function operationLockPath(stateDir: string): string {
  return join(stateDir, OPERATION_LOCK_FILE);
}

/** Create the lock with `O_EXCL`, so two processes cannot both believe they made it. */
function writeLockFile(path: string, record: OperationLockRecord): void {
  const fd = openSync(path, "wx", STATE_FILE_MODE);
  try {
    writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The holder as a sentence, for a refusal that has to name something concrete. */
function describeHolder(held: HeldLock): string {
  const record = held.record as Partial<OperationLockRecord> | null;
  if (record === null) {
    return `the lock file is ${held.state}`;
  }
  const operation = typeof record.operation === "string" ? record.operation : "an operation";
  const pid = typeof record.pid === "number" ? String(record.pid) : "an unrecorded pid";
  const since = typeof record.acquired_at === "string" ? record.acquired_at : "an unrecorded time";
  return `${operation} in pid ${pid}, which took it at ${since}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

/**
 * Take the operation lock, or refuse having written nothing.
 *
 * @throws {OperationLockRefused} when a live holder has it, or when a takeover lost its race.
 */
export async function acquireOperationLock(
  stateDir: string,
  operation: LockedOperation,
): Promise<OperationLock> {
  ensureStateDirectory(stateDir);
  const path = operationLockPath(stateDir);
  const mine: OperationLockRecord = {
    format_version: OPERATION_LOCK_FORMAT_VERSION,
    operation,
    pid: selfIdentity().pid,
    start_time: selfIdentity().start_time,
    boot_nonce: randomUUID(),
    hostname: hostname(),
    acquired_at: new Date().toISOString(),
  };
  const steps: string[] = [];

  try {
    writeLockFile(path, mine);
    steps.push(`O_EXCL create succeeded; directory flush after it: ${flushDirectory(stateDir)}`);
    return { path, record: mine, steps };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
    steps.push("O_EXCL create refused with EEXIST — inspecting the holder");
  }

  const held = readLock(path);
  const verdict = classifyHolder(held);
  steps.push(`holder: ${verdict.reason}`);
  if (verdict.live) {
    throw new OperationLockRefused(
      `${operationLockPath(stateDir)} is held by ${describeHolder(held)}. Two updates, or an ` +
        `update and an install, cannot interleave: one would stage a runtime the other is ` +
        `switching away from. Nothing was written. Wait for it to finish, or — if that process ` +
        `is gone — run \`xplainer daemon status\`, which says whether a transaction is ` +
        `unfinished and names the command that completes it.`,
      held,
      steps,
    );
  }

  // The re-read is the same guard `daemon/lock.ts` uses: a stale lock that changed while it was
  // being classified belongs to a taker that got there first, and unlinking it now would delete
  // that taker's file rather than the dead holder's.
  const again = readLock(path);
  if (again.raw !== held.raw) {
    throw new OperationLockRefused(
      `${operationLockPath(stateDir)} held a stale lock that changed while it was being read — ` +
        `another operation took it over first. Nothing was written.`,
      again,
      [...steps, "the stale lock changed while it was being read; refusing"],
    );
  }
  removeIfPresent(path);
  try {
    writeLockFile(path, mine);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
    throw new OperationLockRefused(
      `${operationLockPath(stateDir)} was taken by another operation between this one removing ` +
        `the stale lock and creating its own. Nothing was written.`,
      readLock(path),
      [...steps, "lost the takeover race at the second O_EXCL create; refusing"],
    );
  }
  steps.push(`took over a stale lock; directory flush after it: ${flushDirectory(stateDir)}`);

  await sleep(SETTLE_MS);
  const settled = readLock(path);
  const settledRecord = settled.record as Partial<OperationLockRecord> | null;
  if (settledRecord === null || settledRecord.boot_nonce !== mine.boot_nonce) {
    throw new OperationLockRefused(
      `${operationLockPath(stateDir)} was read back ${String(SETTLE_MS)} ms after this operation ` +
        `took it over and it is no longer ours — another taker won the race. Nothing was written.`,
      settled,
      [...steps, `read-back after ${String(SETTLE_MS)} ms found another holder; refusing`],
    );
  }
  steps.push(`read-back after ${String(SETTLE_MS)} ms confirms the lock is ours`);
  return { path, record: mine, steps };
}

/**
 * Give the lock back, but only if it is still the one this process wrote.
 *
 * The nonce check stops a late release from deleting a **successor's** lock: an operation that was
 * declared stale and taken over must not unlink the new holder's file on its way out.
 */
export function releaseOperationLock(stateDir: string, lock: OperationLock): boolean {
  const held = readLock(lock.path);
  const record = held.record as Partial<OperationLockRecord> | null;
  if (record === null || record.boot_nonce !== lock.record.boot_nonce) {
    return false;
  }
  removeIfPresent(lock.path);
  flushDirectory(stateDir);
  return true;
}

/** Run `act` while holding the operation lock, and give the lock back whatever happens. */
export async function withOperationLock<T>(
  stateDir: string,
  operation: LockedOperation,
  act: (lock: OperationLock) => Promise<T>,
): Promise<T> {
  const lock = await acquireOperationLock(stateDir, operation);
  try {
    return await act(lock);
  } finally {
    releaseOperationLock(stateDir, lock);
  }
}
