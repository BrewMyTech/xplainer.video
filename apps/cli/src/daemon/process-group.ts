/**
 * Signalling a worker and everything it started, as one unit.
 *
 * [ADR 0024](../../../../docs/adr/0024-durable-jobs-and-boot-reconciliation.md) §Scope: every
 * asynchronous job type, and its children is the reason this file exists: "recovering a *record* is
 * not the whole job. The record's orphaned worker processes — Chrome, ffmpeg, a TTS request in
 * flight — race a retry over the same output directory if they are still running." A render is a
 * Remotion process that spawns a browser that spawns renderers; killing the pid the daemon holds
 * leaves the expensive half alive.
 *
 * So every worker is spawned `detached`, which makes it a **process-group leader** whose group id
 * equals its pid, and the group — not the pid — is what gets signalled. That is also the fourth of
 * the portable identity means ADR 0024 §A recorded PID is not an identity lists: "a process group
 * the daemon created and can signal as a unit".
 *
 * `SIGTERM` first, then `SIGKILL` after a grace, because a worker that can flush a partial file is
 * better than one that cannot, and because ADR 0024 §Drain on planned restart words the hard stop
 * that way.
 *
 * **Windows is a documented gap, not a silent one.** `process.kill(-pid)` is a POSIX process-group
 * idiom that Node does not implement there, so on `win32` the pid alone is signalled and any
 * grandchildren are left. Phase 1 does not target Windows (`docs/ROADMAP.md`), and stating the
 * limitation here is cheaper than discovering it as an orphaned `chrome.exe`.
 */

import type { ChildProcess } from "node:child_process";
import process from "node:process";
import { isAlive } from "./worker-identity.js";

/** How long a worker gets to exit on `SIGTERM` before the group is killed outright. */
export const GROUP_TERMINATE_GRACE_MS = 2_000;

/** A process to signal: its pid, and the group it leads if it has one. */
export type GroupTarget = {
  pid: number;
  pgid: number | null;
};

/**
 * The group a spawned child leads.
 *
 * With `detached: true` the child is its own group leader, so the group id is the child's pid. This
 * function exists so that fact is asserted in one place rather than assumed at three call sites.
 */
export function groupOf(child: ChildProcess): GroupTarget | null {
  const { pid } = child;
  if (pid === undefined) {
    return null;
  }
  return { pid, pgid: process.platform === "win32" ? null : pid };
}

/**
 * Send `signal` to the whole group, or to the pid where a group cannot be addressed.
 *
 * Returns whether the signal was delivered. `ESRCH` — nothing there — is the ordinary answer for a
 * worker that has already exited, and is reported as `false` rather than thrown, because a
 * teardown's job is to make the process gone and it already is.
 */
export function signalGroup(target: GroupTarget, signal: NodeJS.Signals): boolean {
  const addressee = target.pgid === null ? target.pid : -target.pgid;
  try {
    process.kill(addressee, signal);
    return true;
  } catch {
    return false;
  }
}

/** How often the wait below asks whether the leader has gone. */
const POLL_INTERVAL_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

/** What a teardown actually did, so a caller can log it rather than guess. */
export type Teardown = {
  /** Whether anything in the group was still there to receive a signal. */
  signalled: boolean;
  /** The strongest signal that reached something. */
  signal: NodeJS.Signals | null;
};

/**
 * Stop a worker and its children: `SIGTERM`, a bounded wait on the leader, then `SIGKILL`.
 *
 * The closing `SIGKILL` is sent to the **group** even once the leader has exited, and that is safe
 * rather than a wrong kill waiting to happen: POSIX keeps a process-group id reserved until the
 * last member leaves the group, so `-pgid` cannot start meaning somebody else's group while any of
 * this job's processes are still in it. It is what makes a Chrome that outlived its Remotion parent
 * reachable at all.
 *
 * The wait polls the *leader* rather than the group, because a group is not a thing that can be
 * waited on portably and the leader is the process whose exit the daemon is about to record.
 */
export async function terminateGroup(
  target: GroupTarget,
  graceMs: number = GROUP_TERMINATE_GRACE_MS,
): Promise<Teardown> {
  const leaderWasAlive = isAlive(target.pid);
  const termed = signalGroup(target, "SIGTERM");

  const deadline = Date.now() + graceMs;
  while (leaderWasAlive && isAlive(target.pid) && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
  }

  const killed = signalGroup(target, "SIGKILL");
  if (killed) {
    return { signalled: true, signal: "SIGKILL" };
  }
  return { signalled: termed, signal: termed ? "SIGTERM" : null };
}
