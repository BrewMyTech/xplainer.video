/**
 * Who is still running out of a directory when a transaction is over.
 *
 * Two of T16's six assertions are claims about **processes** and nothing else can settle them:
 * "exactly one process holds the state directory" and "no Chrome or ffmpeg survives". A file cannot
 * answer either — `owner.lock` says who *took* it, not who is alive now, and a browser a killed
 * updater orphaned leaves no record at all — so this module reads the real process table and
 * filters it by the one string every process of a case has in its argv: the scratch root the daemon
 * was launched out of.
 *
 * **It polls, because a signalled process dies on the kernel's schedule and not on an assertion's.**
 * `untilProcessesNaming()` is `daemon/testing/spawn-child.ts`'s `untilGone()` generalised to a
 * count: it returns as soon as the table settles to what was expected, and returns the last reading
 * it took when it does not, so the failure names the processes rather than a number.
 *
 * **What the Chrome-and-ffmpeg half can and cannot show today.** A render worker carries the
 * runtime's own interpreter path in its argv, so a surviving one appears in exactly this listing.
 * The fixture daemon spawns no workers and B5's proof runs no render — that needs the browser and
 * the workspace T19 and T33 supply — so B6's rerun of every rollback case is where this assertion
 * gets its teeth. It is here now because the *shape* of the evidence should not change when it does.
 *
 * Nothing here ships: `tsconfig.build.json` excludes `src/**\/testing/**`.
 */

import { spawnSync } from "node:child_process";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

/** How long {@link untilProcessesNaming} waits for a signalled process to actually go. */
export const SURVIVOR_TIMEOUT_MS = 15_000;

/** How often it asks again. */
const POLL_INTERVAL_MS = 100;

/** The processes a browser or an encoder would be, by the names they run under. */
const RENDERERS = /chrom|ffmpeg/i;

/**
 * Every process whose command line names `path`, as `<pid> <command line>` rows.
 *
 * `ps -A -ww` rather than a narrower selection: `-ww` is what stops both BSD and GNU `ps` from
 * truncating an argument list to the terminal width, and a truncated argument list is a process
 * this filter would miss. Windows has no `ps`, so the same question is asked of `Win32_Process`,
 * which is the CIM class Task Scheduler's own tooling reads.
 */
function processesNaming(path: string): string[] {
  const listing =
    process.platform === "win32"
      ? spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }',
          ],
          { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
        )
      : spawnSync("ps", ["-A", "-ww", "-o", "pid=,args="], {
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
        });
  if (listing.status !== 0) {
    throw new Error(
      `the process table could not be read: ${
        listing.stderr || listing.error?.message || "it said nothing"
      }`,
    );
  }
  return listing.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(path));
}

/**
 * Poll {@link processesNaming} until it holds `expected` rows, then return them.
 *
 * @returns the rows as they were when the count matched, or the last reading taken at the deadline
 * — so a caller asserts on the listing and reports what was still running rather than a timeout.
 */
export async function untilProcessesNaming(
  path: string,
  expected: number,
  timeoutMs = SURVIVOR_TIMEOUT_MS,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let rows = processesNaming(path);
  while (rows.length !== expected && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    rows = processesNaming(path);
  }
  return rows;
}

/** The rows of a listing that are a browser or an encoder. */
export function renderersAmong(rows: readonly string[]): string[] {
  return rows.filter((row) => RENDERERS.test(row));
}
