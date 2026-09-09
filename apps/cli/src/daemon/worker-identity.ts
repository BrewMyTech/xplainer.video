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
 * - **Reading the start token is a process spawn and costs about 4.5 ms** on macOS — and about
 *   330 ms on Windows, where it is a `powershell.exe` (see below). An earlier revision of the spike
 *   called it
 *   once per record and made every storage-shape number 4.5 ms per record, hiding the thing being
 *   measured. So {@link selfIdentity} is memoised for the life of the process, and
 *   {@link classifyWorker} is called once per worker at reconciliation — never per write.
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
 * safe. Linux exposes `/proc/sys/kernel/random/boot_id`, macOS `sysctl -n kern.boottime` and
 * Windows `Win32_OperatingSystem.LastBootUpTime`; anywhere else it is `null`, which this module
 * treats as *unknown* and never as *differs* — the asymmetry matters, because "differs" is the one
 * answer that suppresses uncertainty.
 *
 * **Windows, and why it had neither half of the tuple until 2026-09-09.** The start-token probe was
 * `ps -o lstart=` on every platform that is not Linux, and Windows has no `ps`; the boot id
 * answered `null` outside Linux and macOS. So `selfIdentity()` there was `(pid, null, null)`, every
 * live pid classified `uncertain`, and ADR 0024's decision — the one that says a kill needs a
 * positive tuple match — was silently unimplemented on the platform: reconciliation could never
 * take a positive decision, and `startIsProvablyGone` answered `false` for any recorded pid Windows
 * had since handed to somebody else. T14's Windows leg caught it as a flake, because whether it
 * fails at all depends on whether the machine happened to reuse one of the five recorded pids —
 * green on run `34319237168` and red on run `34333162332`, same code, `windows-latest`, 2026-09-09.
 *
 * Both halves are now read from CIM, in one `powershell.exe`: the process creation time from
 * `Win32_Process.CreationDate` and the last boot from `Win32_OperatingSystem.LastBootUpTime`, each
 * rendered as a Windows **file time in UTC** — a 64-bit count of 100 ns intervals, which is an
 * exact integer rather than a formatted date, so two readers on one machine cannot disagree about
 * it and neither a locale nor a time zone enters the comparison. `wmic` would have been the cheaper
 * spawn and is deliberately not used: it is deprecated and absent from current Windows images, so a
 * probe built on it would answer `null` — "uncertain" — on exactly the machines this is for.
 *
 * That spawn is a PowerShell start, and it costs **about 330 ms warm and 2.9 s cold** against the
 * macOS `ps`'s 4.5 ms — measured on `windows-latest`, 2026-09-09, runs `34338721332` and
 * `34339968171`, by `testing/identity-cost.ts`, which `daemon-windows.yml`'s `identity` job runs and
 * whose whole reading is in ADR 0024's note of that date. A `powershell.exe` that only prints one
 * line costs 173 ms of it, so the spawn is more than half the number and no cheaper query can reach
 * the larger half; the only thing that would is a native addon, which ADR 0020 rules out. Seventy
 * times the number the cost discipline above was written around, so that discipline is
 * load-bearing here rather than tidy: {@link selfIdentity}
 * pays the spawn **once** for the life of the process and gets both halves out of the one
 * invocation, {@link machineBootId} is memoised from the same reading, and {@link classifyWorker}
 * reaches the probe only for a recorded pid that is still alive — a dead one is decided by
 * `isAlive` and a record from another boot by the boot id, both without spawning anything. A probe
 * that cannot run at all — no `powershell.exe`, a WMI service that will not answer, output that did
 * not survive whatever it was written through — answers `null`, which is `uncertain`, and never a
 * guess.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { POWERSHELL, POWERSHELL_ARGV } from "../install/register.js";

/**
 * A process, as much as this platform can say about it.
 *
 * `start_time` is a formatted date on macOS (one-second resolution, from `ps -o lstart=`), clock
 * ticks since boot on Linux (1/100 s at the usual `USER_HZ`, from field 22 of `/proc/<pid>/stat`)
 * and a Windows file time on Windows (100 ns, from `Win32_Process.CreationDate`). The three are
 * never compared with each other — only with a token read the same way on the same machine — so
 * the difference in shape costs nothing.
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

/** How long the Windows probe is given before it is treated as unanswered. */
export const WINDOWS_IDENTITY_TIMEOUT_MS = 20_000;

/**
 * The prefix every line of the Windows probe's output carries.
 *
 * The probe writes with `[Console]::Out.WriteLine`, so nothing it emits passes through PowerShell's
 * output formatter and nothing is wrapped at that formatter's 80 columns. The prefix is what makes
 * that checkable from the reader's side rather than assumed: a line {@link readWindowsIdentity}
 * accepts has to begin with it *and* end in digits, so a banner, a warning or a wrapped value is
 * discarded rather than read as half a token.
 */
export const WINDOWS_IDENTITY_PREFIX = "xplainer-identity";

/** What one Windows probe read. Either half may be `null`, and `null` always means "cannot say". */
export type WindowsIdentity = {
  /** `CreationDate=<file time>` for the pid that was asked about, if one was and it is running. */
  start_time: string | null;
  /** `LastBootUpTime=<file time>` for this machine. */
  boot_id: string | null;
};

/**
 * The one PowerShell that answers both halves of the tuple.
 *
 * `pid` decides how much of it is asked: a number gets the process clause **and** the boot clause,
 * which is what makes {@link selfIdentity} one spawn rather than two, and `null` gets the boot
 * clause alone.
 *
 * A `pid` that is not a plain positive integer names no process, so its clause is left out
 * altogether and the probe answers `null` for it. This string is pasted into a script, and a value
 * that would reach a WQL filter without being one of the things a pid can be is not a value to
 * paste.
 *
 * `ToFileTimeUtc()` rather than a formatted date, and `-ErrorAction SilentlyContinue` rather than a
 * throw: a machine whose WMI will not answer is a machine that cannot say, which is `null`, which
 * is `uncertain` — the same answer a missing `powershell.exe` gives, reached without a non-zero
 * exit that would then have to be told apart from a real failure.
 */
export function windowsIdentityScript(pid: number | null): string {
  const lines = ["$ErrorActionPreference = 'Stop'"];
  if (pid !== null && Number.isSafeInteger(pid) && pid > 0) {
    lines.push(
      `$p = @(Get-CimInstance Win32_Process -Filter 'ProcessId=${String(pid)}' ` +
        "-ErrorAction SilentlyContinue)[0]",
      "if ($null -ne $p -and $null -ne $p.CreationDate) {",
      `  [Console]::Out.WriteLine('${WINDOWS_IDENTITY_PREFIX} CreationDate=' + ` +
        "$p.CreationDate.ToFileTimeUtc())",
      "}",
    );
  }
  lines.push(
    "$os = @(Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue)[0]",
    "if ($null -ne $os -and $null -ne $os.LastBootUpTime) {",
    `  [Console]::Out.WriteLine('${WINDOWS_IDENTITY_PREFIX} LastBootUpTime=' + ` +
      "$os.LastBootUpTime.ToFileTimeUtc())",
    "}",
  );
  return lines.join("\n");
}

/**
 * The two halves out of the probe's output, or `null` for whichever it did not say.
 *
 * A value is accepted only when it is entirely digits, which is what a file time is. Anything else
 * — a truncated number, a formatter's header, a localised error — is not a token this machine will
 * produce again, and a token that cannot be produced again is worse than none: it would make every
 * later reading of the same process a `stranger`, which is the one verdict certain enough to
 * license leaving a live worker alone without setting `workers_uncertain`.
 */
export function readWindowsIdentity(stdout: string): WindowsIdentity {
  const answer: WindowsIdentity = { start_time: null, boot_id: null };
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${WINDOWS_IDENTITY_PREFIX} `)) {
      continue;
    }
    const value = trimmed.slice(WINDOWS_IDENTITY_PREFIX.length + 1);
    const at = value.indexOf("=");
    if (at < 0 || !/^\d+$/.test(value.slice(at + 1))) {
      continue;
    }
    if (value.slice(0, at) === "CreationDate") {
      answer.start_time = value;
    } else if (value.slice(0, at) === "LastBootUpTime") {
      answer.boot_id = value;
    }
  }
  return answer;
}

/** Run {@link windowsIdentityScript}, and answer `null` for anything it could not say. */
function probeWindowsIdentity(pid: number | null): WindowsIdentity {
  const answer = spawnSync(POWERSHELL, [...POWERSHELL_ARGV, windowsIdentityScript(pid)], {
    encoding: "utf8",
    windowsHide: true,
    timeout: WINDOWS_IDENTITY_TIMEOUT_MS,
  });
  if (answer.error !== undefined || answer.status !== 0 || typeof answer.stdout !== "string") {
    return { start_time: null, boot_id: null };
  }
  return readWindowsIdentity(answer.stdout);
}

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
  if (process.platform === "win32") {
    return probeWindowsIdentity(pid).start_time;
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
 * Memoised: on macOS it is a `sysctl` spawn and on Windows a `powershell.exe` one, and ADR 0024's
 * note is explicit that an identity probe belongs once per acquisition or reconciliation and never
 * per write.
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
  if (process.platform === "win32") {
    return probeWindowsIdentity(null).boot_id;
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
    cachedSelf = process.platform === "win32" ? probeSelfOnWindows() : probeSelf();
  }
  return cachedSelf;
}

function probeSelf(): ProcessIdentity {
  return {
    pid: process.pid,
    start_time: processStartToken(process.pid),
    boot_id: machineBootId(),
  };
}

/**
 * Both halves of this process's own tuple out of one `powershell.exe`.
 *
 * The two readings are independent facts and the spawn is what either of them costs, so asking for
 * them separately would pay it twice for no extra certainty. The boot id is handed to
 * {@link machineBootId}'s memo on the way through, which is what makes every later caller of it
 * free — and the memo is consulted rather than overwritten, so a boot id read before this call is
 * still the one answer this process ever gives.
 */
function probeSelfOnWindows(): ProcessIdentity {
  const probed = probeWindowsIdentity(process.pid);
  if (cachedBootId === undefined) {
    cachedBootId = probed.boot_id;
  }
  return { pid: process.pid, start_time: probed.start_time, boot_id: machineBootId() };
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
 *
 * That order is also what keeps the probe rare: a record from another boot and a pid that is not
 * alive are both decided before {@link processStartToken} is reached, so the only recorded worker
 * that costs a spawn is one whose number something on this machine is still using.
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
