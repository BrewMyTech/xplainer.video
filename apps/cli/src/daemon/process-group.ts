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
 * ## Windows has no process group, so the worker is put in a Job Object instead
 *
 * `process.kill(-pid)` is a POSIX idiom Node does not implement on `win32`: the pid alone is
 * signalled and any grandchildren are left. That was a documented gap while phase 1 did not target
 * Windows; this phase does, and the gap's shape there is an orphaned `chrome.exe` after every
 * logoff. Windows' own answer to "these processes are one unit" is a **Job Object** with
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`: every process in the job dies when the last handle to it
 * closes, and a process created by one already in the job joins it automatically.
 *
 * **Node cannot create one.** There is no Job Object API in `node:child_process` or anywhere else
 * in the runtime, and this project ships no native addon, so the handle has to be held by another
 * process. {@link jobKeeperCommand} is that process: `powershell.exe -EncodedCommand`, which
 * `Add-Type`s the four `kernel32` entry points, creates the job with kill-on-close, assigns the
 * worker to it, sweeps up any descendant that already existed, and then does nothing but wait for
 * the worker to exit. Killing the keeper closes the job's last handle and takes the whole tree with
 * it; the keeper outliving a killed worker closes it a moment later and takes the survivors.
 *
 * Three properties of that arrangement, stated rather than assumed:
 *
 * - **The window before the assignment is real.** `AssignProcessToJobObject` does not reach back to
 *   children a process made before it was assigned, and the keeper takes a few hundred milliseconds
 *   to start. That is why it sweeps: it walks `Win32_Process` for descendants and assigns each one
 *   too, twice, so anything born in the window is captured. A grandchild born *after* the
 *   assignment needs no sweep — it inherits the job from its parent.
 * - **A process already in a job can still be assigned to ours**, because Windows 8 and Server 2012
 *   made jobs nestable, and a hosted runner or a Scheduled Task puts everything it starts in one.
 * - **`-EncodedCommand` rather than `-Command`**, because the script is multi-line and contains
 *   quotes, and a command line assembled around those is a quoting bug waiting to be written. The
 *   argument is one base64 token of UTF-16LE, which is Microsoft's own documented answer to it.
 *
 * **This is `[runner]` evidence, not local evidence.** Nothing on macOS or Linux executes the
 * keeper: it is asserted here as a command (`process-group.test.ts` decodes it) and executed by
 * `.github/workflows/daemon-windows.yml`, which runs this file's own suite on `windows-latest`.
 * Until that workflow has been dispatched and has reported, the Windows half is a design.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { isAlive } from "./worker-identity.js";

/** How long a worker gets to exit on `SIGTERM` before the group is killed outright. */
export const GROUP_TERMINATE_GRACE_MS = 2_000;

/** A process to signal: its pid, the group it leads if it has one, and its Job Object's keeper. */
export type GroupTarget = {
  pid: number;
  pgid: number | null;
  /**
   * The pid of the process holding this worker's kill-on-close Job Object, on Windows.
   *
   * Absent everywhere else, and absent on Windows when the keeper could not be started — a machine
   * with no `powershell.exe` on `PATH` is the case that produces it, and {@link terminateGroup}
   * falls back to `taskkill /T` there. Optional rather than `number | null` because
   * `reconciler.ts` rebuilds a target out of a job record, which carries the pid and the group id
   * and never saw a keeper.
   */
  jobKeeper?: number | undefined;
};

/** `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, the one limit this job sets. */
export const KILL_ON_JOB_CLOSE = "0x2000";

/**
 * The keeper's script: create the job, assign the worker and its existing descendants, then wait.
 *
 * It is a template with one hole rather than an interpolation of arbitrary text: the only value
 * that reaches it is a pid {@link jobKeeperCommand} has already checked is a positive integer.
 */
function jobKeeperScript(pid: number): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$target = ${String(pid)}`,
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class XplainerJobObject {",
    '  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
    "  private static extern IntPtr CreateJobObjectW(IntPtr security, string name);",
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    "  private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);",
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    "  private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);",
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    "  private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);",
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    "  private static extern bool CloseHandle(IntPtr handle);",
    "  [StructLayout(LayoutKind.Sequential)]",
    "  private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {",
    "    public long PerProcessUserTimeLimit;",
    "    public long PerJobUserTimeLimit;",
    "    public uint LimitFlags;",
    "    public UIntPtr MinimumWorkingSetSize;",
    "    public UIntPtr MaximumWorkingSetSize;",
    "    public uint ActiveProcessLimit;",
    "    public UIntPtr Affinity;",
    "    public uint PriorityClass;",
    "    public uint SchedulingClass;",
    "  }",
    "  [StructLayout(LayoutKind.Sequential)]",
    "  private struct IO_COUNTERS {",
    "    public ulong ReadOperationCount;",
    "    public ulong WriteOperationCount;",
    "    public ulong OtherOperationCount;",
    "    public ulong ReadTransferCount;",
    "    public ulong WriteTransferCount;",
    "    public ulong OtherTransferCount;",
    "  }",
    "  [StructLayout(LayoutKind.Sequential)]",
    "  private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {",
    "    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;",
    "    public IO_COUNTERS IoInfo;",
    "    public UIntPtr ProcessMemoryLimit;",
    "    public UIntPtr JobMemoryLimit;",
    "    public UIntPtr PeakProcessMemoryUsed;",
    "    public UIntPtr PeakJobMemoryUsed;",
    "  }",
    "  private const int ExtendedLimitInformation = 9;",
    `  private const uint KillOnJobClose = ${KILL_ON_JOB_CLOSE};`,
    "  private const uint ProcessSetQuota = 0x0100;",
    "  private const uint ProcessTerminate = 0x0001;",
    "  private static IntPtr held = IntPtr.Zero;",
    "  public static void Create() {",
    "    held = CreateJobObjectW(IntPtr.Zero, null);",
    '    if (held == IntPtr.Zero) { throw new Exception("CreateJobObject failed with " + Marshal.GetLastWin32Error()); }',
    "    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();",
    "    limits.BasicLimitInformation.LimitFlags = KillOnJobClose;",
    "    int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));",
    "    IntPtr buffer = Marshal.AllocHGlobal(size);",
    "    Marshal.StructureToPtr(limits, buffer, false);",
    "    bool ok = SetInformationJobObject(held, ExtendedLimitInformation, buffer, (uint)size);",
    "    int error = Marshal.GetLastWin32Error();",
    "    Marshal.FreeHGlobal(buffer);",
    '    if (!ok) { throw new Exception("SetInformationJobObject failed with " + error); }',
    "  }",
    "  public static bool Assign(int pid) {",
    "    IntPtr handle = OpenProcess(ProcessSetQuota | ProcessTerminate, false, pid);",
    "    if (handle == IntPtr.Zero) { return false; }",
    "    bool assigned = AssignProcessToJobObject(held, handle);",
    "    CloseHandle(handle);",
    "    return assigned;",
    "  }",
    "}",
    "'@",
    "function Get-XplainerDescendants([int] $root) {",
    "  $table = @{}",
    "  foreach ($row in Get-CimInstance Win32_Process) {",
    "    $parent = [int] $row.ParentProcessId",
    "    if (-not $table.ContainsKey($parent)) { $table[$parent] = New-Object System.Collections.ArrayList }",
    "    [void] $table[$parent].Add([int] $row.ProcessId)",
    "  }",
    "  $found = New-Object System.Collections.ArrayList",
    "  $frontier = New-Object System.Collections.ArrayList",
    "  [void] $frontier.Add($root)",
    "  while ($frontier.Count -gt 0) {",
    "    $current = $frontier[0]",
    "    $frontier.RemoveAt(0)",
    "    if (-not $table.ContainsKey($current)) { continue }",
    "    foreach ($child in $table[$current]) {",
    "      if ($child -ne $current -and -not $found.Contains($child)) {",
    "        [void] $found.Add($child)",
    "        [void] $frontier.Add($child)",
    "      }",
    "    }",
    "  }",
    "  return $found",
    "}",
    "[XplainerJobObject]::Create()",
    "if (-not [XplainerJobObject]::Assign($target)) {",
    "  Write-Error ('could not assign ' + $target + ' to the job object')",
    "  exit 3",
    "}",
    "Write-Output ('contained ' + $target)",
    // Two sweeps rather than one: the first catches everything the worker made before the keeper
    // was ready, the second catches anything born while the first was walking the table.
    "for ($sweep = 0; $sweep -lt 2; $sweep++) {",
    "  foreach ($descendant in (Get-XplainerDescendants $target)) {",
    "    [void] [XplainerJobObject]::Assign($descendant)",
    "  }",
    "  Start-Sleep -Milliseconds 150",
    "}",
    "$process = Get-Process -Id $target -ErrorAction SilentlyContinue",
    "if ($null -ne $process) { $process.WaitForExit() }",
  ].join("\n");
}

/**
 * The command that holds one worker's Job Object open for as long as the worker runs.
 *
 * Exported so the script can be asserted from a platform that cannot run it: the test decodes the
 * `-EncodedCommand` argument and reads the flag, the pid and the calls back out.
 *
 * @throws {RangeError} for a pid that is not a positive integer, which would otherwise be
 * interpolated into a script.
 */
export function jobKeeperCommand(pid: number): { program: string; argv: string[] } {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new RangeError(`a Job Object keeper needs a real pid, not ${String(pid)}`);
  }
  return {
    program: "powershell.exe",
    argv: [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(jobKeeperScript(pid), "utf16le").toString("base64"),
    ],
  };
}

/**
 * `taskkill /PID <pid> /T /F`, the fallback for a Windows machine with no keeper.
 *
 * It is weaker than the job and that is why it is second: `/T` walks the parent chain at kill time,
 * so a grandchild whose parent has already exited is no longer reachable from the root. It is
 * documented, it is present on every Windows, and it is better than signalling one pid.
 */
export function treeKillCommand(pid: number): { program: string; argv: string[] } {
  return { program: "taskkill", argv: ["/PID", String(pid), "/T", "/F"] };
}

/**
 * Start the keeper for a freshly spawned worker, and report its pid.
 *
 * `null` when the keeper could not be started at all. It is detached from the daemon's streams and
 * unref'd, so it holds neither a pipe nor the event loop; its standard error is inherited, because
 * a keeper that failed to compile its `Add-Type` should say so in the daemon's own log rather than
 * into a pipe nobody reads.
 */
function containInJobObject(pid: number): number | undefined {
  const { program, argv } = jobKeeperCommand(pid);
  try {
    const keeper = spawn(program, argv, {
      stdio: ["ignore", "ignore", "inherit"],
      windowsHide: true,
    });
    keeper.unref();
    keeper.on("error", () => {
      // A `powershell.exe` that is not on `PATH` arrives here rather than as a throw, and the
      // answer is the same as for one that never started: the target keeps `jobKeeper: undefined`
      // and `terminateGroup` uses `taskkill /T`.
    });
    return keeper.pid;
  } catch {
    return undefined;
  }
}

/**
 * The group a spawned child leads, and on Windows the Job Object it was just put in.
 *
 * With `detached: true` the child is its own group leader, so the group id is the child's pid. This
 * function exists so that fact is asserted in one place rather than assumed at three call sites —
 * and it is where containment happens for the same reason: it is the one call every spawn site
 * already makes with the child still fresh, so the keeper starts as early as it can.
 */
export function groupOf(child: ChildProcess): GroupTarget | null {
  const { pid } = child;
  if (pid === undefined) {
    return null;
  }
  if (process.platform !== "win32") {
    return { pid, pgid: pid };
  }
  return { pid, pgid: null, jobKeeper: containInJobObject(pid) };
}

/** Send one signal to one pid, and say whether anything was there to receive it. */
function signalPid(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Send `signal` to the whole group, or to the pid where a group cannot be addressed.
 *
 * Returns whether the signal was delivered. `ESRCH` — nothing there — is the ordinary answer for a
 * worker that has already exited, and is reported as `false` rather than thrown, because a
 * teardown's job is to make the process gone and it already is.
 *
 * **`SIGKILL` also closes the Job Object**, on the platform that has one. Killing the keeper is
 * what makes "and everything it started" true on Windows, and it is deliberately not done for
 * `SIGTERM`: the grace exists so a worker can flush, and a job that closes takes that away.
 *
 * The keeper's death is **not** reported as delivery, though, because the keeper is not a member of
 * the group — it is the handle the group hangs from. "Was anything there to receive this" stays a
 * question about the worker and its children, so a teardown of a group that has already gone
 * answers `false` on every platform rather than `true` on one of them.
 */
export function signalGroup(target: GroupTarget, signal: NodeJS.Signals): boolean {
  const addressee = target.pgid === null ? target.pid : -target.pgid;
  const delivered = signalPid(addressee, signal);
  if (signal === "SIGKILL" && target.jobKeeper !== undefined) {
    signalPid(target.jobKeeper, "SIGKILL");
  }
  return delivered;
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
 * On Windows the same `SIGKILL` closes the Job Object, which is the platform's version of that
 * sentence: the keeper dies, the job's last handle goes with it, and every process in the job is
 * terminated by the kernel. A target with no keeper — a machine with no `powershell.exe`, or a
 * record `reconciler.ts` rebuilt from disk, which never saw one — falls back to `taskkill /T`,
 * which is weaker and documented as such where it is built.
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
  // Asked even when the `SIGKILL` above reached nothing: the leader being gone is precisely the
  // case where a grandchild is still running with nobody left to signal it.
  const swept = sweepWindowsTree(target);
  if (killed || swept) {
    return { signalled: true, signal: "SIGKILL" };
  }
  return { signalled: termed, signal: termed ? "SIGTERM" : null };
}

/**
 * The Windows fallback: ask `taskkill` to walk the tree, when no Job Object was holding it.
 *
 * Runs only on `win32`, only for a target with no keeper, and only after the `SIGKILL` above — so
 * on every other platform, and on every worker this daemon started itself, it is not reached at
 * all. `spawnSync` because a teardown is already a place that waits, and the process it waits for
 * exits in tens of milliseconds.
 */
function sweepWindowsTree(target: GroupTarget): boolean {
  if (process.platform !== "win32" || target.jobKeeper !== undefined) {
    return false;
  }
  const { program, argv } = treeKillCommand(target.pid);
  const answer = spawnSync(program, argv, { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  return answer.status === 0;
}
