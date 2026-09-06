/**
 * The four steps that make a file on disk survive the process that wrote it.
 *
 * [ADR 0024](../../../../docs/adr/0024-durable-jobs-and-boot-reconciliation.md) §Durability of the
 * write itself decides them, and its note of 2026-09-06 §Write durability settles the per-platform
 * force: **temp file → `fsync` the file → close → `rename` → `fsync` the containing directory**, on
 * every platform, "with the directory flush attempted and its failure recorded rather than thrown".
 *
 * Two facts from the spike run that ADR note quotes, because they are the reason this file is four
 * calls and not one:
 *
 * - A `rename` is atomic for a reader, but the **directory entry it creates is not durable** until
 *   the directory itself is flushed. Losing that entry loses a record whose `job_id` the caller
 *   already holds, which is precisely the `404` ADR 0024 exists to remove.
 * - On macOS `fs.fsyncSync` is already `fcntl(F_FULLFSYNC)` — libuv's `uv__fs_fsync` tries it first
 *   and Node 24.20.0 bundles libuv 1.52.1 — so Apple's strongest flush costs no native module here.
 *   Measured on the machine in that note: 4.07 ms for the file and 3.27 ms more for the directory.
 *
 * That price is why {@link writeJsonDurably} is called on **state transitions**, never per log line.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { STATE_DIR_MODE, STATE_FILE_MODE } from "./state-dir.js";

/**
 * What a directory flush did, as a string rather than an exception.
 *
 * `ok` on Linux and macOS. On Windows there is no directory handle to sync — `FlushFileBuffers`
 * documents no equivalent — so the open fails and the caller gets `unavailable (…)` to log once at
 * startup as a known platform limitation. ADR 0024 requires exactly this shape: "a platform that
 * refuses is a recorded fact and not a crashed daemon".
 */
export type DirectoryFlush = string;

/** The outcome a successful directory flush reports. */
export const DIRECTORY_FLUSH_OK = "ok";

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * `fsync` a directory descriptor, reporting what happened instead of throwing.
 *
 * Lifted from `apps/cli/spikes/p1-s1-ownership.mjs`'s `flushDirectory`, which is the code the
 * ADR 0024 note's measurements came from, so the product and the spike cannot disagree about what
 * a flush is.
 */
export function flushDirectory(directory: string): DirectoryFlush {
  let fd: number;
  try {
    fd = openSync(directory, "r");
  } catch (error) {
    return `unavailable (${describe(error)})`;
  }
  try {
    fsyncSync(fd);
    return DIRECTORY_FLUSH_OK;
  } catch (error) {
    return `refused (${describe(error)})`;
  } finally {
    closeSync(fd);
  }
}

/** Create a directory `0700` if it is not already there. */
export function ensureStateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: STATE_DIR_MODE });
}

/**
 * Delete a file whose desired state is "gone", tolerating its already being gone.
 *
 * Every artefact this daemon owns — `owner.lock`, the IPC socket, a video's write lock — is removed
 * by a path that has just decided the file must not exist, and for each of them an `ENOENT` is that
 * decision already being true rather than a failure to carry it out: a `SIGKILL`ed predecessor may
 * have left nothing behind, and a takeover races another taker for the same unlink. Any *other*
 * `errno` is a real problem — a directory that cannot be written, a permission the daemon has lost
 * — and is rethrown, because silently continuing past it leaves a socket or a lock in place that
 * the next start will read as a live owner.
 *
 * It lives here, beside {@link writeJsonDurably}, so that the tolerance is spelled once. Five call
 * sites across four modules carried the same six lines, and a rule about which `errno` may be
 * ignored is only worth anything while every copy of it still says the same thing.
 */
export function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

/**
 * Write `value` as JSON to `path` so that a `SIGKILL` on the next line cannot lose it.
 *
 * The temporary file is created in the **same directory** as the target, because `rename` is only
 * atomic within a filesystem and only a same-directory rename needs one directory flush rather than
 * two. Its name carries the writing pid so two processes cannot collide on it — which cannot happen
 * while ownership holds, and costs nothing to make true anyway.
 *
 * Returns the directory flush outcome so a caller that cares — the first write of a daemon's life —
 * can record it.
 */
export function writeJsonDurably(path: string, value: unknown): DirectoryFlush {
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.${process.pid}.tmp`);
  const payload = `${JSON.stringify(value, null, 2)}\n`;

  const fd = openSync(temporary, "w", STATE_FILE_MODE);
  try {
    writeSync(fd, payload);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    removeQuietly(temporary);
    throw error;
  }
  closeSync(fd);
  renameSync(temporary, path);
  return flushDirectory(directory);
}

/**
 * Delete the temporary file, swallowing **every** error. Used only on the failure path above.
 *
 * Deliberately more forgiving than {@link removeIfPresent}: the caller is already holding the error
 * it is about to throw, and a second one raised while tidying up would replace the diagnosis with
 * the clean-up.
 */
function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // The temporary file is this process's own and its absence is the desired state.
  }
}
