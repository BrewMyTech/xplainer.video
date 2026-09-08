/**
 * The two state files, and the circuit breaker that lives in the durable one.
 *
 * [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md) §Port and discovery gives
 * them opposite lifetimes: **`daemon.json` is durable and must survive reboot**, while
 * **`runtime.json` is ephemeral, written at bind and never trusted without a liveness check**.
 *
 * `recentStarts[]` and the `stalled` flag live in `daemon.json`, and that placement is a
 * correction, not a preference. ADR 0020 §Restart on crash originally put them in `runtime.json`;
 * its own note of 2026-09-06 records why that was wrong — on Linux `runtime.json` sits in systemd's
 * `RuntimeDirectory=`, where "the innermost subdirectories are removed when the unit is stopped",
 * so "the circuit breaker therefore forgets its history on every clean stop, which is not what a
 * breaker is for". [ADR 0024](../../../../docs/adr/0024-durable-jobs-and-boot-reconciliation.md)
 * §Consequences moves crash history to the durable directory alongside the job store, and this file
 * is where that move happens.
 *
 * **How a failed start is recognised, and how one that wrote no epitaph is treated.** ADR 0020
 * words the breaker as "if the last five runs all failed within 30 seconds of starting". Phase 1
 * inferred both halves: a run failed if its entry had no `ready_at`, and it failed *fast* if the
 * **next** run started within {@link FAILED_START_WINDOW_MS} of it. The second inference is the
 * defect this file no longer has. It measured the **supervisor's retry cadence** rather than the
 * run's own life, so a supervisor that spaces its retries wider than the window could never trip
 * the breaker at all — launchd's `ThrottleInterval` is 30 s, which sits exactly on the boundary,
 * and Task Scheduler's `<RestartOnFailure>` has a one-minute schema minimum, which is outside it.
 * What is recorded now is each run's **own** end:
 *
 * - `ready_at` — stamped by {@link markDaemonReady} the moment the listeners are bound. A run that
 *   has one did not fail to start, however it ended afterwards.
 * - `outcome` and `ended_at` — written by {@link recordDaemonEnd} from the run's own orderly end,
 *   which is `daemon/start.ts`'s `close()`: every refusal after ownership was taken and every drain
 *   goes through it. `failed` is a run that ended without ever announcing itself; `stopped` is one
 *   that had announced itself first.
 * - **neither** — the run was `SIGKILL`ed, panicked, or the machine lost power, so it wrote no
 *   epitaph at all. §1.3b D6 governs that case: such a start **counts as a failure only when the
 *   next recorded start began within {@link FAILED_START_WINDOW_MS} of its own `started_at`**,
 *   because the next start is the only sound upper bound on when it died, and it **resets the
 *   streak otherwise**. The identity tuple {@link newDaemonStart} persists beside the record is
 *   what lets a later start establish that the death was real; `runtime.json` cannot corroborate
 *   it, because {@link writeRuntimeState} is reached only from `markReady` and this rule is only
 *   ever about **pre-readiness** deaths.
 *
 * **Every interval is validated before it is used.** `started_at` is wall clock, so a backward NTP
 * correction, a VM resume or an operator can invert or shrink a real one. A negative or non-finite
 * interval is *timing uncertain* and **resets** the streak rather than counting it. The residual,
 * said plainly rather than papered over: a backward adjustment that leaves a finite interval
 * between zero and 30 seconds is indistinguishable from a genuine fast failure and may over-count.
 * A monotonic clock would close that and is not this phase's; the spurious latch it could produce
 * is cleared by `xplainer daemon restart`.
 *
 * {@link isStalled} is a function of the entries and one injected verdict, so every case above is
 * testable without killing anything, and the daemon exits `0` when it trips — the portable "do not
 * restart" signal on all three supervisors.
 *
 * **Two writers, one file, and the split is by field.** `serve` owns what a *run* establishes — the
 * port it bound, the socket it bound, the contract version it speaks, the token file it read, the
 * flush verdict and the breaker's history. `xplainer daemon install` owns what an *installation*
 * establishes — the supervisor kind and artefact, the runtime directory, the launch spec, the
 * program source, whether this install enabled lingering, the log sink and the installing version.
 * Every write here is a read-modify-write that **preserves keys it does not name**, which is what
 * makes that split safe in both directions: a `serve` that rewrote the file from its own narrow
 * view would silently uninstall the daemon it is part of, and an `install` that rewrote it would
 * throw away the crash history the breaker counts.
 *
 * The installer's fields are typed and parsed here even though nothing in this batch writes them,
 * because the alternative is `Record<string, unknown>` at every reader: `status --json` reports
 * them, the consistency check compares them, and `uninstall` acts on `linger_enabled_by_us`. A
 * field that is only preserved is a field nobody can read without casting.
 */

import { readFileSync, unlinkSync } from "node:fs";
import type { LaunchSpec } from "../runtime/launch-spec.js";
import { flushDirectory, writeJsonDurably } from "./durable-write.js";
import { STATE_UNREADABLE_EXIT_CODE } from "./exit-codes.js";
import { stateDirLayout } from "./state-dir.js";
import {
  classifyWorker,
  machineBootId,
  type ProcessIdentity,
  selfIdentity,
} from "./worker-identity.js";

/** The version this daemon writes into both files. */
export const STATE_FORMAT_VERSION = 1;

/**
 * A run that ended this long after starting, without ever announcing itself, failed fast.
 *
 * The value and its meaning are ADR 0020's and unchanged: what changed is that the end it is
 * measured against is now the run's **own**, and the next start's `started_at` is the bound only
 * for a run that recorded no end at all.
 */
export const FAILED_START_WINDOW_MS = 30_000;

/** How many consecutive fast failures trip the breaker (ADR 0020 §Restart on crash). */
export const STALL_AFTER_FAILED_STARTS = 5;

/** How much start history is kept. Enough to decide, and short enough to read with `cat`. */
export const RECENT_STARTS_KEPT = 10;

/**
 * How a run ended, as the run itself recorded it.
 *
 * Two values and not three: `unknown` is the **absence** of a record and not a word anything
 * writes, because a run that can still write is a run that knows which of these two it was.
 */
export type StartOutcome = "failed" | "stopped";

/** Every {@link StartOutcome}, for a caller validating one it read off disk. */
export const START_OUTCOMES: readonly StartOutcome[] = ["failed", "stopped"];

/** One entry in `recentStarts[]`. */
export type DaemonStart = {
  started_at: string;
  pid: number;
  /** The acquisition's `boot_nonce`, so two runs with the same pid are told apart. */
  run_id: string;
  /** When the daemon announced itself, or `null` if it never did. */
  ready_at: string | null;
  /**
   * How this run ended, recorded by the run itself.
   *
   * `null` for a run that is still going — every daemon writes its own start record before it
   * binds anything — and for one that died without the chance to say, which is the case §1.3b D6's
   * rule exists for.
   */
  outcome: StartOutcome | null;
  /** When it ended, by its own clock, or `null` in the same two cases. */
  ended_at: string | null;
  /**
   * The second member of this run's identity tuple: its process start token.
   *
   * Persisted **with the start record** because the case that needs it — a death before readiness —
   * is exactly the case that writes no `runtime.json` (§7.21). `pid` above is the first member and
   * {@link DaemonStart.boot_id} is the third; {@link startIdentity} puts the three back together.
   */
  start_time: string | null;
  /** The machine boot this run belonged to, or `null` on a platform that cannot say. */
  boot_id: string | null;
};

/** The latched stall the breaker writes, in words a `status` command can print. */
export type StallRecord = {
  at: string;
  reason: string;
};

/**
 * Which supervisor holds the daemon on this machine.
 *
 * The three names are the three renderers, and they are the same spellings `SettingsEmission` in
 * `../runtime/launch-spec.ts` uses for the forms those supervisors accept, so a reader never has to
 * map one vocabulary onto the other.
 */
export type SupervisorKind = "systemd" | "launchd" | "task-scheduler";

/** Every {@link SupervisorKind}, for a caller validating one it read off disk. */
export const SUPERVISOR_KINDS: readonly SupervisorKind[] = ["systemd", "launchd", "task-scheduler"];

/**
 * Where `install` got the program it registered.
 *
 * `runtime-dir` is the phase-2 default and the only one a machine with nothing published can reach
 * by itself; `explicit` is `install --program`; `sea-binary` is accepted and unused this phase; and
 * `package-manager` is the branch a publish adds, which changes this value and nothing else,
 * because the assembler, the launch contract, the renderers and the update transaction never ask
 * where the payload came from.
 */
export type ProgramSource = "runtime-dir" | "explicit" | "sea-binary" | "package-manager";

/** Every {@link ProgramSource}, for a caller validating one it read off disk. */
export const PROGRAM_SOURCES: readonly ProgramSource[] = [
  "runtime-dir",
  "explicit",
  "sea-binary",
  "package-manager",
];

/**
 * The launch contract `install` rendered into the supervisor artefact, exactly as it was written.
 *
 * It is `LaunchSpec` itself rather than a second declaration of the same four fields, so a field
 * added to the contract is a field this file records without an edit and a field renamed there
 * cannot quietly keep its old name here. Recorded rather than recomputed, because the question a
 * consistency check asks is "is what the supervisor loaded still what we wrote", and a value
 * derived at read time answers a different question — it would agree with itself after a settings
 * change nobody ever delivered.
 */
export type RecordedLaunchSpec = LaunchSpec;

/** The fields of `daemon.json` this daemon reads and writes. Others are preserved untouched. */
export type DaemonState = {
  format_version: number;
  /** The port the last successful bind used. */
  port: number | null;
  /** The contract version this daemon speaks, so `status` can report it without an HTTP call. */
  contract_version: string | null;
  /**
   * Where the bearer token lives, so `status` and `connect` read a path rather than guess one.
   *
   * ADR 0020 §Port and discovery lists the token file among `daemon.json`'s durable fields, and
   * R-SEC-6 is why it is a *path*: `/proc/<pid>/cmdline` is world-readable and
   * `systemctl --user show` prints `Environment=`, so the value never appears anywhere but the file.
   */
  token_file: string | null;
  /**
   * The IPC socket this run bound — the unix socket, or the named pipe on Windows.
   *
   * Durable, unlike `runtime.json`'s `socket`, and for a different reader: this is the path a
   * consumer needs when the daemon is *not* running, and the one `serve --socket` moved. `serve`
   * writes it at the same moment it writes the port, so it always describes the process that
   * actually bound rather than what an installer intended.
   */
  socket_path: string | null;
  /** What a directory flush did on this platform, recorded once rather than thrown. */
  directory_flush: string | null;
  /** Which supervisor `install` registered the daemon with, or `null` on a machine with none. */
  supervisor_kind: SupervisorKind | null;
  /** The unit, plist or task XML `install` wrote, by path — the file `uninstall` removes. */
  supervisor_artefact: string | null;
  /** The staged payload-1 directory this daemon runs out of, `<state>/runtime/<version>-<digest>/`. */
  runtime_dir: string | null;
  /** The launch contract that was rendered into {@link DaemonState.supervisor_artefact}. */
  launch_spec: RecordedLaunchSpec | null;
  /** Where `install` got the program it registered. */
  program_source: ProgramSource | null;
  /**
   * Whether **this install** created `/var/lib/systemd/linger/$USER`.
   *
   * Three-valued on purpose: `true` means uninstall must remove the marker, `false` means the
   * marker was already there and is somebody else's, and `null` means nothing has decided —
   * which is not the same as `false` and must not roll back a setting this daemon never made.
   */
  linger_enabled_by_us: boolean | null;
  /**
   * Whether **this install**'s `launchctl enable` created a record where the store held none.
   *
   * macOS only, and three-valued for the same reason {@link DaemonState.linger_enabled_by_us} is:
   * `true` means the disable store gained an entry for our label because we put it there, `false`
   * means an entry was already there, and `null` means nothing has decided — this is not macOS, or
   * the store could not be read. `uninstall` reports it, because launchctl offers no verb that
   * removes an entry from that store: `enable` and `disable` set its value and there is no third
   * one, so what an uninstall can honestly say is which of the two states it left behind.
   */
  launchd_enable_record_created: boolean | null;
  /** Where the supervisor sends this daemon's output: a log file's path, or `journald`. */
  log_sink: string | null;
  /** The release that wrote this record, so a skew between it and `/healthz` is readable. */
  installed_version: string | null;
  recentStarts: DaemonStart[];
  stalled: StallRecord | null;
};

/** The fields of `runtime.json` this story writes. */
export type RuntimeState = {
  format_version: number;
  pid: number;
  /** The daemon run, matching the `run_id` in `recentStarts[]` and in every job record's owner. */
  run_id: string;
  boot_id: string | null;
  port: number;
  /**
   * Every address this run is actually reachable on, as origins.
   *
   * The port alone stopped being enough once `--bind` existed: a daemon bound to one interface and
   * a `status` that assumes `127.0.0.1` disagree silently, and the disagreement looks like a dead
   * daemon. ADR 0020 §Port and discovery lists the bound addresses among `runtime.json`'s fields
   * for that reason.
   */
  addresses: string[];
  /**
   * The IPC socket path — the unix socket, or the named pipe on Windows — or `null` for a
   * TCP-only binding.
   *
   * `daemon/ipc.ts` puts it inside a `0700` directory, and whatever is here is removed on clean
   * shutdown along with this file: a socket file that outlives its daemon is a path
   * `xplainer mcp --attach` would dial and find nothing behind.
   */
  socket: string | null;
  started_at: string;
};

/** A state file exists and cannot be read. Carries ADR 0020's exit code for that condition. */
export class StateFileUnreadableError extends Error {
  readonly exitCode: number = STATE_UNREADABLE_EXIT_CODE;
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(`xplainer serve: ${path} exists but cannot be read as JSON (${String(cause)})`);
    this.name = "StateFileUnreadableError";
    this.path = path;
  }
}

function readObject(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    // Absent is the ordinary state of a directory no daemon has used yet. Anything else — a mode
    // that forbids the read, a directory where a file should be — is a state file that exists and
    // cannot be read, which ADR 0020 gives its own exit code rather than silently overwriting.
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw new StateFileUnreadableError(path, error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new StateFileUnreadableError(path, error);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new StateFileUnreadableError(path, "the file does not hold a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * The start history off disk, with every field a decision needs present on every entry.
 *
 * A record written by a release older than this one carries no `outcome`, no `ended_at` and no
 * identity tuple, and filling those with `null` is what puts it under D6's unknown rule rather than
 * under a `undefined` nothing dares branch on. Two fields are still required, because an entry
 * without them cannot be placed in time at all.
 */
function asStarts(value: unknown): DaemonStart[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const starts: DaemonStart[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const candidate = entry as Partial<DaemonStart>;
    if (typeof candidate.started_at !== "string" || typeof candidate.pid !== "number") {
      continue;
    }
    starts.push({
      started_at: candidate.started_at,
      pid: candidate.pid,
      run_id: typeof candidate.run_id === "string" ? candidate.run_id : "",
      ready_at: asNullableString(candidate.ready_at),
      outcome: asMember(candidate.outcome, START_OUTCOMES),
      ended_at: asNullableString(candidate.ended_at),
      start_time: asNullableString(candidate.start_time),
      boot_id: asNullableString(candidate.boot_id),
    });
  }
  return starts;
}

function asStall(value: unknown): StallRecord | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Partial<StallRecord>;
  return typeof candidate.at === "string" && typeof candidate.reason === "string"
    ? { at: candidate.at, reason: candidate.reason }
    : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** One of a closed set, or `null` — never a string this daemon would then branch on blindly. */
function asMember<T extends string>(value: unknown, members: readonly T[]): T | null {
  return typeof value === "string" && (members as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function asStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...(value as string[])]
    : null;
}

/**
 * A launch spec off disk, or `null` for anything that is not one.
 *
 * All four fields are required together, because a half-read spec is worse than none: a consistency
 * check that compared a recorded `argv` against a loaded one while the settings were missing would
 * report agreement it never established. `daemon.json` is a file a person can edit, so this is a
 * parse and not a cast.
 */
function asLaunchSpec(value: unknown): RecordedLaunchSpec | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const argv = asStringArray(candidate.argv);
  const executable = asNullableString(candidate.executable);
  const cwd = asNullableString(candidate.cwd);
  const settings = candidate.settings;
  if (argv === null || executable === null || cwd === null) {
    return null;
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    return null;
  }
  const { stateDir, tokenFile, socket } = settings as Record<string, unknown>;
  if (typeof stateDir !== "string" || typeof tokenFile !== "string" || typeof socket !== "string") {
    return null;
  }
  return { executable, argv, settings: { stateDir, tokenFile, socket }, cwd };
}

/** Read `daemon.json`, filling in the defaults of a directory that has never held one. */
export function readDaemonState(stateDir: string): DaemonState {
  const raw = readObject(stateDirLayout(stateDir).daemonState);
  return {
    format_version:
      typeof raw.format_version === "number" ? raw.format_version : STATE_FORMAT_VERSION,
    port: typeof raw.port === "number" ? raw.port : null,
    contract_version: asNullableString(raw.contract_version),
    token_file: asNullableString(raw.token_file),
    socket_path: asNullableString(raw.socket_path),
    directory_flush: asNullableString(raw.directory_flush),
    supervisor_kind: asMember(raw.supervisor_kind, SUPERVISOR_KINDS),
    supervisor_artefact: asNullableString(raw.supervisor_artefact),
    runtime_dir: asNullableString(raw.runtime_dir),
    launch_spec: asLaunchSpec(raw.launch_spec),
    program_source: asMember(raw.program_source, PROGRAM_SOURCES),
    linger_enabled_by_us: asNullableBoolean(raw.linger_enabled_by_us),
    launchd_enable_record_created: asNullableBoolean(raw.launchd_enable_record_created),
    log_sink: asNullableString(raw.log_sink),
    installed_version: asNullableString(raw.installed_version),
    recentStarts: asStarts(raw.recentStarts),
    stalled: asStall(raw.stalled),
  };
}

/**
 * Merge `changes` into `daemon.json` and write it durably, keeping every other key.
 *
 * The read is what preserves an installer's fields; the durable write is what makes the breaker's
 * history survive the crash it is counting.
 */
export function updateDaemonState(stateDir: string, changes: Partial<DaemonState>): DaemonState {
  const path = stateDirLayout(stateDir).daemonState;
  const raw = readObject(path);
  const next = { ...raw, format_version: STATE_FORMAT_VERSION, ...changes };
  writeJsonDurably(path, next);
  return readDaemonState(stateDir);
}

/** The three members of a recorded run's identity, back in the shape `worker-identity.ts` takes. */
export function startIdentity(start: DaemonStart): ProcessIdentity {
  return { pid: start.pid, start_time: start.start_time, boot_id: start.boot_id };
}

/**
 * Is the process this record names **provably** not running any more?
 *
 * D6 applies its unknown-outcome rule only to a start whose process is provably gone, and this is
 * that test. `gone` is the plain answer — nothing at that pid, or a different machine boot —  and
 * `stranger` is the other one: the pid is alive and positively identified as somebody else, which
 * establishes that the *recorded* run is not running just as firmly. `ours` and `uncertain` are
 * both refusals to say, and a refusal resets the streak rather than counting it.
 *
 * In practice a previous run that is still alive cannot be reached from here at all — it would be
 * holding `owner.lock`, and this start would have exited `10` long before the breaker was asked —
 * but the rule is written to be true rather than to be unreachable.
 *
 * **What it costs, and where that sits.** Each call may read a process start token, which on macOS
 * is a `ps` spawn at about 4.5 ms (ADR 0024's note of 2026-09-06 §Process identity). At most
 * {@link STALL_AFTER_FAILED_STARTS} entries are ever asked, only entries that recorded no end at
 * all are asked at all, and the whole thing happens once per start — which is the "once per
 * acquisition or reconciliation, never per write" rule that note sets, not an exception to it.
 */
export function startIsProvablyGone(start: DaemonStart): boolean {
  const verdict = classifyWorker(startIdentity(start), machineBootId());
  return verdict === "gone" || verdict === "stranger";
}

/**
 * Did a run that began at `startedMs` end by `endMs`, quickly, on a clock worth believing?
 *
 * The boundary is inclusive and measured rather than assumed: 30,000 ms is fast and 30,001 ms is
 * not, which is why launchd's 30-second `ThrottleInterval` sits exactly on it. A negative or
 * non-finite difference is *timing uncertain* — a backward clock step, an unparseable timestamp —
 * and answers `false`, which resets the streak instead of counting a failure nobody can time.
 */
function failedFast(startedMs: number, endMs: number): boolean {
  const interval = endMs - startedMs;
  return Number.isFinite(interval) && interval >= 0 && interval <= FAILED_START_WINDOW_MS;
}

/**
 * Has this daemon failed to start {@link STALL_AFTER_FAILED_STARTS} times in a row, fast?
 *
 * `starts` is the history *before* the run being decided is appended, so the newest entry's bound
 * is `nowMs` — which is that next start's `started_at` and exactly the upper bound D6 names.
 *
 * Each entry is decided by what it recorded, in this order:
 *
 * 1. `ready_at` set — the run announced itself, so it did not fail to start. The streak resets
 *    outright, however the run ended afterwards, which keeps a daemon that ran for a week and was
 *    killed at the end of it out of the breaker's history.
 * 2. `ended_at` set — the run recorded its own end, and the window is measured against **that**.
 *    This is the whole of the fix: five starts a minute apart, each dying two seconds in, latch.
 * 3. neither — D6's unknown case. It counts only if the process is provably gone **and** the next
 *    start began inside the window; anything else resets.
 *
 * `provablyGone` is a parameter so the third case is testable without arranging a corpse; the
 * default is the real probe over the identity tuple the record carries.
 */
export function isStalled(
  starts: readonly DaemonStart[],
  nowMs: number,
  provablyGone: (start: DaemonStart) => boolean = startIsProvablyGone,
): StallRecord | null {
  if (starts.length < STALL_AFTER_FAILED_STARTS) {
    return null;
  }
  const recent = starts.slice(-STALL_AFTER_FAILED_STARTS);
  for (const [index, start] of recent.entries()) {
    if (start.ready_at !== null) {
      return null;
    }
    const startedMs = Date.parse(start.started_at);
    if (start.ended_at !== null) {
      if (!failedFast(startedMs, Date.parse(start.ended_at))) {
        return null;
      }
      continue;
    }
    if (!provablyGone(start)) {
      return null;
    }
    const next = recent[index + 1];
    const bound = next === undefined ? nowMs : Date.parse(next.started_at);
    if (!failedFast(startedMs, bound)) {
      return null;
    }
  }
  const first = recent[0];
  return {
    at: new Date(nowMs).toISOString(),
    reason:
      `the last ${STALL_AFTER_FAILED_STARTS} starts each failed before the daemon was ready, ` +
      `and each within ${FAILED_START_WINDOW_MS / 1000} s of its own start — the supervisor's ` +
      `retry delays excluded (first at ${first?.started_at ?? "unknown"}). ` +
      "Exiting 0 so the supervisor stops restarting; `xplainer daemon restart` clears this.",
  };
}

/** Add this run to `recentStarts[]`, trimming the history to what a decision needs. */
export function recordDaemonStart(
  stateDir: string,
  start: DaemonStart,
  extra: Partial<DaemonState> = {},
): DaemonState {
  const history = readDaemonState(stateDir).recentStarts;
  const recentStarts = [...history, start].slice(-RECENT_STARTS_KEPT);
  return updateDaemonState(stateDir, { recentStarts, ...extra });
}

/** Stamp `ready_at` on this run's entry, which is what makes it a *successful* start. */
export function markDaemonReady(stateDir: string, runId: string, readyAt: string): DaemonState {
  const recentStarts = readDaemonState(stateDir).recentStarts.map((entry) =>
    entry.run_id === runId ? { ...entry, ready_at: readyAt } : entry,
  );
  return updateDaemonState(stateDir, { recentStarts });
}

/**
 * Record this run's own end on its own entry: when it ended, and which way.
 *
 * The outcome is not a second thing to get wrong — it follows from whether this run ever announced
 * itself, which is a fact the same entry already carries — but it is *recorded* rather than
 * inferred later, and that is the difference the breaker needed: an end time written by the run
 * that reached it is evidence, while the next start's timestamp is a guess about a supervisor.
 *
 * Only the run's **first** end is kept: `close()` is reachable twice on a path where a drain throws
 * and the caller tears down again, and the first end is the one that happened.
 */
export function recordDaemonEnd(stateDir: string, runId: string, endedAt: string): DaemonState {
  const recentStarts = readDaemonState(stateDir).recentStarts.map((entry) => {
    if (entry.run_id !== runId || entry.ended_at !== null) {
      return entry;
    }
    const outcome: StartOutcome = entry.ready_at === null ? "failed" : "stopped";
    return { ...entry, ended_at: endedAt, outcome };
  });
  return updateDaemonState(stateDir, { recentStarts });
}

/** Latch the breaker, in words `xplainer daemon status` can print verbatim. */
export function recordStall(stateDir: string, stall: StallRecord): DaemonState {
  return updateDaemonState(stateDir, { stalled: stall });
}

/**
 * Write `runtime.json` after the listeners are bound.
 *
 * It carries this run's pid, its run and boot ids, the bound port, every address it answers on and
 * the IPC socket path — `null` until that listener exists. {@link removeRuntimeState} deletes it on
 * a clean shutdown, which is what makes its presence meaningful. Nothing reads this file without a
 * liveness check even so, which is why a stale one left by a `SIGKILL` is a hint rather than a lie.
 */
export function writeRuntimeState(
  stateDir: string,
  state: Omit<RuntimeState, "format_version">,
): RuntimeState {
  const record: RuntimeState = { format_version: STATE_FORMAT_VERSION, ...state };
  writeJsonDurably(stateDirLayout(stateDir).runtimeState, record);
  return record;
}

/**
 * Delete `runtime.json`, and report whether there was one.
 *
 * This is step 6 of ADR 0024 §Drain on planned restart — "remove `runtime.json` and the socket,
 * exit `0`" — and the reason the file means anything at all: a descriptor that is only ever written
 * is a descriptor every stale copy of which looks live. The directory is flushed afterwards for the
 * same reason a write flushes it: on Linux and macOS the *removal* of the entry is not durable
 * until it is, and a daemon that is stopped and whose machine loses power immediately afterwards
 * would otherwise come back to a runtime file describing a run that never resumed.
 */
export function removeRuntimeState(stateDir: string): boolean {
  const path = stateDirLayout(stateDir).runtimeState;
  try {
    unlinkSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  flushDirectory(stateDir);
  return true;
}

/** Read `runtime.json`, or `null` where none has been written. */
export function readRuntimeState(stateDir: string): Record<string, unknown> | null {
  const raw = readObject(stateDirLayout(stateDir).runtimeState);
  return Object.keys(raw).length === 0 ? null : raw;
}

/**
 * This process's own start entry, before it is known whether the start succeeded.
 *
 * It carries the run's **identity tuple** — pid, process start token, machine boot id — and not the
 * pid alone, because the record has to outlive a process that never got as far as writing
 * `runtime.json`: {@link writeRuntimeState} is called from `markReady` and nowhere else, so a death
 * before readiness leaves this entry as the only durable description of the run. A later start
 * needs the tuple to establish that the process really is gone rather than that its number is
 * unused, which is ADR 0024 §A recorded PID is not an identity's whole point.
 *
 * `selfIdentity()` is memoised for the life of the process, so the `ps` spawn it costs on macOS is
 * paid once per daemon rather than once per write.
 */
export function newDaemonStart(runId: string, startedAt: string): DaemonStart {
  const identity = selfIdentity();
  return {
    started_at: startedAt,
    pid: identity.pid,
    run_id: runId,
    ready_at: null,
    outcome: null,
    ended_at: null,
    start_time: identity.start_time,
    boot_id: identity.boot_id,
  };
}
