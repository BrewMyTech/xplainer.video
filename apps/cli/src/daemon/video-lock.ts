/**
 * One writer per video directory, across processes.
 *
 * [ADR 0024](../../../../docs/adr/0024-durable-jobs-and-boot-reconciliation.md) §Scope names the
 * hazard in one sentence — "Two writers to one video directory is a corrupted output that neither
 * process reports" — and prices §Exclusive ownership against it. That lock is enough while the
 * daemon is the only thing that runs jobs. It stopped being enough when `xplainer mcp` was given
 * the real worker registry: a stdio session deliberately does **not** take the state directory's
 * lock (`mcp/stdio-server.ts` records why — a bundle entry that refused to start because a daemon
 * was running would defeat its own purpose), while it resolves the *same* workspace root, so a
 * daemon and two `npx -y @xplainer/cli mcp` sessions can each spawn Remotion against one
 * `out/<slug>/explainer.mp4` or one `public/<slug>/timings.json`. Ownership of the *store* says
 * nothing about that: the job ids are private to each store and the files are not.
 *
 * So the exclusion this module adds is keyed by what is actually shared — the **video**, not the
 * process. `<root>/locks/<slug>.lock` is taken when a job leaves the queue and released the moment
 * its record reaches a terminal state, by `daemon/runner.ts`; a second process that wants the same
 * video while it is held fails that job with {@link VideoBusyError} naming the holder, which is a
 * retryable answer an agent can poll to. Different videos never contend, which is the granularity
 * that matters: two agents working on two explainers is the normal case.
 *
 * **The mechanism is `daemon/lock.ts`'s, deliberately reused rather than re-derived.**
 * {@link readLock} and {@link classifyHolder} are the same two functions, so a stale video lock is
 * classified by exactly the tuple — pid, start token, zero length — that `spikes/p1-s1-ownership.mjs`
 * measures, and the two locks cannot drift into two different notions of "alive".
 *
 * **One deliberate difference: no settle wait.** `acquireOwnership` sleeps `SETTLE_MS` (100 ms)
 * after taking over a stale lock, because the loser of that race must not go on to
 * reconcile another daemon's records. Here the acquire runs inside a synchronous worker factory and
 * the stakes are the other way round: the loser of a takeover race fails **one job** with a message
 * that says to retry, and no record belonging to anyone else is touched. The read-back after the
 * create is kept — it is what makes at most one process believe it holds the lock — and the price
 * of the residual window is a spurious retry, not a wrong kill.
 */

import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { JobType } from "@xplainer/protocol";
import { removeIfPresent } from "./durable-write.js";
import { classifyHolder, type OwnershipRecord, readLock } from "./lock.js";
import { STATE_DIR_MODE, STATE_FILE_MODE } from "./state-dir.js";
import { selfIdentity } from "./worker-identity.js";

/** The directory under the workspace root that holds one lock file per video being written. */
export const VIDEO_LOCKS_DIR = "locks";

/** Every record in this store carries one (ADR 0024 §An unknown format version is not corruption). */
export const VIDEO_LOCK_FORMAT_VERSION = 1;

/**
 * What a video lock file holds.
 *
 * The identity half is `daemon/lock.ts`'s {@link OwnershipRecord}, unchanged, so one classifier
 * reads both files. The rest is for the human who runs `cat` on it while wondering what is holding
 * their render.
 */
export type VideoLockRecord = OwnershipRecord & {
  slug: string;
  job_type: JobType;
  job_id: number;
};

/** A held video lock, and the only way to give it back. */
export type VideoWriteLock = {
  path: string;
  record: VideoLockRecord;
  /** Idempotent, and a no-op once another process has legitimately taken the lock over. */
  release(): void;
};

/** Another process is writing this video, so this job cannot start. */
export class VideoBusyError extends Error {
  readonly slug: string;

  constructor(slug: string, detail: string) {
    super(
      `video ${JSON.stringify(slug)} is being written by another process (${detail}), and two ` +
        "writers to one video directory is a corrupted output. Wait for that run to finish and " +
        "call this again.",
    );
    this.name = "VideoBusyError";
    this.slug = slug;
  }
}

/** What {@link acquireVideoWriteLock} needs. */
export type AcquireVideoWriteLockOptions = {
  /** The shared Remotion workspace root the lock lives under. */
  root: string;
  slug: string;
  jobType: JobType;
  jobId: number;
};

/** The file that names the process writing `slug`, while one is. */
export function videoLockPath(root: string, slug: string): string {
  return join(root, VIDEO_LOCKS_DIR, `${slug}.lock`);
}

/** Create the lock with `O_EXCL`, so two processes cannot both believe they made it. */
function tryCreate(path: string, record: VideoLockRecord): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", STATE_FILE_MODE);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
  try {
    writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Take the write lock on one video, or refuse.
 *
 * @throws VideoBusyError when a live process holds it, or when a takeover of a stale one is lost
 */
export function acquireVideoWriteLock(options: AcquireVideoWriteLockOptions): VideoWriteLock {
  const { root, slug, jobType, jobId } = options;
  const path = videoLockPath(root, slug);
  mkdirSync(join(root, VIDEO_LOCKS_DIR), { recursive: true, mode: STATE_DIR_MODE });

  const mine: VideoLockRecord = {
    format_version: VIDEO_LOCK_FORMAT_VERSION,
    ...selfIdentity(),
    boot_nonce: randomUUID(),
    hostname: hostname(),
    acquired_at: new Date().toISOString(),
    slug,
    job_type: jobType,
    job_id: jobId,
  };

  const held = (): VideoWriteLock => ({
    path,
    record: mine,
    release(): void {
      // The nonce check is what stops a late release from deleting a *successor's* lock: a process
      // declared stale and taken over must not unlink the new holder's file on its way out.
      const current = readLock(path);
      if (current.record === null || current.record.boot_nonce !== mine.boot_nonce) {
        return;
      }
      removeIfPresent(path);
    },
  });

  if (tryCreate(path, mine)) {
    return held();
  }

  const found = readLock(path);
  const verdict = classifyHolder(found);
  if (verdict.live) {
    throw new VideoBusyError(slug, verdict.reason);
  }

  // Stale. Re-read before unlinking: a holder that changed between the two reads is a taker that
  // got there first, and unlinking then would be deleting *its* fresh lock.
  const again = readLock(path);
  if (again.raw !== found.raw) {
    throw new VideoBusyError(slug, "a stale lock was taken over by another process mid-check");
  }
  removeIfPresent(path);
  if (!tryCreate(path, mine)) {
    throw new VideoBusyError(slug, "another process won the takeover of a stale lock");
  }
  const settled = readLock(path);
  if (settled.record === null || settled.record.boot_nonce !== mine.boot_nonce) {
    throw new VideoBusyError(slug, "another process replaced the lock immediately after takeover");
  }
  return held();
}
