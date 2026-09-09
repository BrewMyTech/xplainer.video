/**
 * Removing a proof's scratch root, on a platform that does not let go of a file the moment the
 * process holding it is asked to stop.
 *
 * Every proof under `install/testing/` and `install/update/testing/` ends by deleting the directory
 * it installed a real daemon into, and on POSIX that is `rm -rf`: a deleted file with an open
 * descriptor simply loses its name. Windows has no such rule — an open handle blocks the unlink —
 * and the deregistration that precedes the removal returns before the process it stopped has
 * exited. `Stop-ScheduledTask` asks Task Scheduler to terminate the instance; the handles that
 * instance held are released when it actually goes, which is milliseconds later and sometimes
 * more. The first `rmSync` therefore answers `EPERM` on a directory that is about to be free.
 *
 * Measured on `windows-latest`, 2026-09-09: the T17 identity proof (run 34304155063) and the T16
 * failure-injection proof (run 34304152961) each printed `PROOF PASSED` and then exited `1` on
 * `Error: EPERM, Permission denied` removing their own root — a green proof reported as a red one.
 *
 * `maxRetries` is Node's own remedy and is documented for exactly this: `fs.rm` retries `EBUSY`,
 * `EMFILE`, `ENFILE`, `ENOTEMPTY` and `EPERM` with a linear backoff. It costs nothing on the two
 * platforms that never need it, which is why this is one helper rather than a `win32` branch.
 *
 * It is **not** a way to tolerate a daemon that was never stopped: the retries add up to a few
 * seconds, so a process still serving out of the directory still fails the removal, and loudly.
 */

import { rmSync } from "node:fs";

/** How many times the removal is re-attempted before it is a failure. */
export const SCRATCH_REMOVE_RETRIES = 20;

/** The backoff between attempts, in milliseconds. Node multiplies it by the attempt number. */
export const SCRATCH_REMOVE_RETRY_DELAY_MS = 250;

/**
 * Remove a proof's scratch directory, tolerating a Windows handle that has not been released yet.
 *
 * @throws whatever `fs.rmSync` throws once the retries are exhausted, because a root that cannot be
 * removed is a process this proof failed to stop.
 */
export function removeScratchRoot(path: string): void {
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: SCRATCH_REMOVE_RETRIES,
    retryDelay: SCRATCH_REMOVE_RETRY_DELAY_MS,
  });
}
