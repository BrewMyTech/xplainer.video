/**
 * Who a recorded process actually is.
 *
 * [ADR 0024](../../../../docs/adr/0024-durable-jobs-and-boot-reconciliation.md) §A recorded PID is
 * not an identity refuses to let a number license a kill: "on a laptop that rebooted overnight, the
 * pid that was ffmpeg at 03:12 is somebody's editor at 09:00". Its note of 2026-09-06 §Process
 * identity settles the mechanism — **the identity of a recorded process is the triple (pid, process
 * start time, machine boot id)** — and this module is that triple, its probe, and the classifier
 * that turns two of them into one of four verdicts.
 *
 * Three measured constraints from that note shape the code:
 *
 * - **Reading the start token is a process spawn and costs about 4.5 ms.** An earlier revision of
 *   the spike called it once per record and made every storage-shape number 4.5 ms per record,
 *   hiding the thing being measured. So {@link selfIdentity} is memoised for the life of the
 *   process, and {@link classifyWorker} is called once per worker at reconciliation — never per
 *   write.
 * - **An exited pid yields `isAlive=false` and `token=null`**, so a null token is indistinguishable
 *   from "gone" and must never on its own license a kill. That is why `null` maps to
 *   {@link WorkerVerdict} `uncertain` rather than to `ours`.
 * - **The same "no identity recorded" input has opposite safe defaults** in the two places it is
 *   used, and the note says so explicitly: for the *lock* it means take over, because a lock nobody
 *   can prove is held would block the daemon for ever; for a *worker* it means do not kill and set
 *   `workers_uncertain`, because a process nobody can prove is ours is a stranger. `lock.ts` holds
 *   the first rule; this file holds the second.
 *
 * The machine boot id is read exactly, not inferred from `os.uptime()`: an inferred one has to be
 * compared with a tolerance, and a tolerance in this decision is a guess about whether a kill is
 * safe. Linux exposes `/proc/sys/kernel/random/boot_id` and macOS `sysctl -n kern.boottime`;
 * anywhere else it is `null`, which this module treats as *unknown* and never as *differs* — the
 * asymmetry matters, because "differs" is the one answer that suppresses uncertainty.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

/**
 * A process, as much as this platform can say about it.
 *
 * `start_time` is a formatted date on macOS (one-second resolution, from `ps -o lstart=`) and clock
 * ticks since boot on Linux (1/100 s at the usual `USER_HZ`, from field 22 of `/proc/<pid>/stat`).
 * The two are never compared with each other — only with a token read the same way on the same
 * machine — so the difference in shape costs nothing.
 */
export type ProcessIdentity = {
  /** The number, which is the least of it. */
  pid: number;
  /** The process start time as this platform spells it, or `null` if it could not be read. */
  start_time: string | null;
  /** The machine boot this process belongs to, or `null` on a platform that cannot say. */
  boot_id: string | null;
};

/**
 * What reconciliation may do about one recorded worker.
 *
 * - `ours` — the tuple matches: kill it.
 * - `stranger` — alive, but positively identified as something else (pid reuse). Leave it, and be
 *   certain: ADR 0024's note lists this as a case that does **not** set `workers_uncertain`.
 * - `gone` — not alive, or recorded on a different machine boot, so nothing recorded can still be
 *   running.
 * - `uncertain` — alive, and the daemon can decide neither "mine" nor "stranger". Sets
 *   `workers_uncertain` and quarantines the output directory. Never a kill.
 */
export type WorkerVerdict = "ours" | "stranger" | "gone" | "uncertain";

/** Read the start token this platform can produce for `pid`, or `null` if it cannot. */
export function processStartToken(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const startTime = fields[19];
      return startTime === undefined ? null : `starttime=${startTime}`;
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
 * Liveness only — never identity.
 *
 * `EPERM` means the pid exists and belongs to another user, which is still "alive"; anything else
 * means it does not exist. Signal `0` performs the permission and existence checks and sends
 * nothing.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

let cachedBootId: string | null | undefined;

/**
 * This machine's boot, read exactly where the platform offers it.
 *
 * Memoised: on macOS it is a `sysctl` spawn, and ADR 0024's note is explicit that an identity probe
 * belongs once per acquisition or reconciliation and never per write.
 */
export function machineBootId(): string | null {
  if (cachedBootId === undefined) {
    cachedBootId = readMachineBootId();
  }
  return cachedBootId;
}

function readMachineBootId(): string | null {
  if (process.platform === "linux") {
    try {
      const raw = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return raw === "" ? null : `boot_id=${raw}`;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    const sysctl = spawnSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" });
    if (sysctl.status !== 0 || typeof sysctl.stdout !== "string") {
      return null;
    }
    // `{ sec = 1757155642, usec = 123456 } Sun Sep  6 19:07:22 2026`. The seconds field is the
    // stable half: the trailing date is locale-formatted and the microseconds are not reproduced
    // identically by every reader of this sysctl.
    const seconds = /sec\s*=\s*(\d+)/.exec(sysctl.stdout);
    return seconds?.[1] === undefined ? null : `kern.boottime=${seconds[1]}`;
  }
  return null;
}

let cachedSelf: ProcessIdentity | undefined;

/** This process's own triple, probed once and then remembered. */
export function selfIdentity(): ProcessIdentity {
  if (cachedSelf === undefined) {
    cachedSelf = {
      pid: process.pid,
      start_time: processStartToken(process.pid),
      boot_id: machineBootId(),
    };
  }
  return cachedSelf;
}

/** The triple for a process this daemon has just spawned, probed once at spawn time. */
export function identify(pid: number): ProcessIdentity {
  return { pid, start_time: processStartToken(pid), boot_id: machineBootId() };
}

/**
 * Decide what may be done about one recorded worker, in the order ADR 0024's note fixes.
 *
 * The boot check comes first and is the only one that can answer without touching the process
 * table: if the record names a different machine boot, nothing recorded can still be running, "and
 * there is nothing to be uncertain about". It fires only when **both** ids are known, so a platform
 * that cannot read one falls through to the pid and token checks rather than guessing.
 */
export function classifyWorker(
  recorded: ProcessIdentity,
  currentBootId: string | null,
): WorkerVerdict {
  if (recorded.boot_id !== null && currentBootId !== null && recorded.boot_id !== currentBootId) {
    return "gone";
  }
  if (!isAlive(recorded.pid)) {
    return "gone";
  }
  if (recorded.start_time === null) {
    return "uncertain";
  }
  const observed = processStartToken(recorded.pid);
  if (observed === null) {
    return "uncertain";
  }
  return observed === recorded.start_time ? "ours" : "stranger";
}
