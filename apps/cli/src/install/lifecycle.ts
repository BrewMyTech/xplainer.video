/**
 * `daemon start`, `daemon stop`, `daemon status` and `daemon logs` — four verbs over one seam.
 *
 * `install.ts` puts the daemon under a supervisor and `uninstall.ts` takes it back off; this is
 * everything in between, and it is written once against {@link SupervisorAdapter}'s three kinds
 * rather than three times against three vocabularies.
 *
 * ## What `daemon status` is built from, and the one surface it never reads
 *
 * [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md) §Degraded paths: "`xplainer
 * daemon status` is the command a support ticket starts with, and it is built from HTTP plus our
 * own state — **never** from a parsed supervisor, because `launchctl`'s own manual says of `print`:
 * 'This output is NOT API in any sense at all.'" The plan's §2.2 narrows that to the rule this file
 * implements, because the blanket version made one of the ADR's **own** required sentences
 * unobservable: whether the user switched the service off appears in no HTTP response and in no
 * file we own — Login Items & Extensions changes supervisor state and touches nothing of ours.
 *
 * | Fact | Query |
 * |---|---|
 * | disabled by the user or by policy | `launchctl print-disabled gui/$UID`; `systemctl --user is-enabled xplainer.service`; `(Get-ScheduledTask …).State` |
 * | loaded configuration (T17) | `systemctl --user show -p ExecStart -p Environment -p WorkingDirectory --value` on Linux; `Get-ScheduledTask` on Windows; **on macOS there is no such query** (§1.3b D7) |
 * | everything else | `/healthz` and our own state files |
 *
 * All three of the first row are documented machine-readable queries with a stable answer:
 * `is-enabled` prints one word and is `systemctl`'s own scripting interface, `Get-ScheduledTask`
 * returns an object with a typed `State`, and `print-disabled`'s one-label-per-line store is read
 * by {@link readDisableRecord}, which matches one line for one label rather than parsing the
 * document. `launchctl print` — the surface the manual disowns — is called nowhere in this package.
 *
 * ## The four sentences are values here, not prose in the command
 *
 * ADR 0020 requires `status` to be able to say four things "in words", and T12's verification is
 * that each is **asserted** against a real installed daemon rather than available in principle.
 * They are therefore built by {@link statusSentences} and carried in
 * {@link DaemonStatusReport.sentences} with a state tag apiece, so the test compares a value with
 * the ADR's own text instead of grepping a transcript, and `commands/daemon.ts` only decides where
 * to print them. `lifecycle.test.ts` reads the four quoted strings **out of the ADR file** and
 * compares them, which is what makes "quoted exactly" a check rather than a claim.
 *
 * Two of the four name a platform's own surface, and there the platform's word is substituted with
 * the reason stated at {@link SWITCHED_OFF_SENTENCES} and
 * {@link NOT_BOOT_PERSISTENT_SENTENCES}: "Login Items & Extensions" is macOS's name for a launchd
 * disable record and means nothing on Linux, and lingering is a systemd concept that does not exist
 * on the other two. The ADR's exact sentence is what the platform it was written for produces.
 *
 * ## Why the read-only preflight is reused rather than five probes reimplemented
 *
 * `preflightInstall()` already answers, without writing anything: is the setup marker complete and
 * do its files still exist; is the recorded port held, and by which pid; is lingering enabled; does
 * this user have a manager at all. Those are exactly the facts three of the four sentences need, and
 * a second implementation of them would be a second set of answers to drift from. `run` is
 * memoised for the duration of one status so that a query both halves ask — `launchctl
 * print-disabled` on macOS — is one subprocess rather than two.
 *
 * ## Logs are asymmetric, and the asymmetry is ADR 0020's
 *
 * journald already does retention, so on Linux `daemon logs` **execs** `journalctl --user -u
 * xplainer` and this project ships no rotator. launchd has no log-rotation key at all and Task
 * Scheduler captures nothing, so on macOS and Windows the daemon's own file is tailed —
 * `~/Library/Logs/xplainer/daemon.log` and `%LOCALAPPDATA%\xplainer\logs\daemon.log`, the two paths
 * ADR 0020's platform table names. What is **not** here is the writer that bounds that file's size:
 * no story in this phase's plan owns it, `install.ts` records the path in `log_sink`, and this verb
 * reads whatever is there. That gap is stated rather than implied by a command that behaves as if
 * the bound existed.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import process from "node:process";
import { resolveDaemonEndpoint } from "../daemon/binding.js";
import {
  awaitStopped,
  type ClearedLatch,
  clearStartLatch,
  requestDrain,
} from "../daemon/control.js";
import {
  type DaemonStart,
  type DaemonState,
  readDaemonState,
  readRuntimeState,
  type SupervisorKind,
} from "../daemon/daemon-state.js";
import { DAEMON_UNHEALTHY_EXIT_CODE, PRECONDITION_UNMET_EXIT_CODE } from "../daemon/exit-codes.js";
import { resolveTokenPath } from "../daemon/token.js";
import { type AclVerdict, aclQuery, readAclVerdict } from "../daemon/windows-acl.js";
import { DEFAULT_PORT, DRAIN_PATH } from "../server.js";
import { awaitHealthy, HealthTimeout, loopbackGet } from "./health.js";
import {
  currentSupervisorEnvironment,
  type InstallPreflight,
  type ProbeCommand,
  type ProbeResult,
  type ProbeRunner,
  preflightInstall,
  readDisableRecord,
  runProbe,
} from "./preflight.js";
import { guiService, POWERSHELL, POWERSHELL_ARGV, type RegistrationTarget } from "./register.js";
import type { SupervisorEnvironment } from "./supervisors/artefact.js";
import {
  checkIdentity,
  type IdentityReport,
  type LoadedIdentity,
  readDesired,
  readLoaded,
  readResponding,
} from "./supervisors/identity.js";
import {
  launchAgentLogPath,
  SYSTEMD_UNIT_NAME,
  supervisorAdapter,
  taskLogPath,
} from "./supervisors/index.js";

/** How long `start` and `stop` wait for the daemon to appear or to go, in milliseconds. */
export const LIFECYCLE_TIMEOUT_MS = 30_000;

/**
 * How long a supervisor's own start or stop command is given.
 *
 * Not {@link PROBE_TIMEOUT_MS}, for the reason `preflight.ts` states about the registration
 * commands: a probe is a `stat` or a one-line query and five seconds is plenty, while
 * `launchctl kickstart` against a job that is still draining blocks until launchd has finished with
 * it — measured against a real LaunchAgent, where a five-second budget reported a working
 * supervisor as a command that could not be run.
 */
export const LIFECYCLE_COMMAND_TIMEOUT_MS = 60_000;

/** How often those two waits ask again. */
export const LIFECYCLE_POLL_INTERVAL_MS = 200;

/**
 * How long after the daemon's own drain cap a drained process is still allowed to be finishing.
 *
 * The cap in the acknowledgement covers steps 1–5; step 6 then closes two listeners, unlinks the
 * socket and removes `runtime.json`. P1-7 gives the whole sequence 25 s against a 20 s cap, and
 * this is that same allowance expressed as the part `restart` waits out on top of whatever cap the
 * daemon reported.
 */
export const STOP_TEARDOWN_ALLOWANCE_MS = 10_000;

/** How long one `/healthz` probe is given before it counts as no answer. */
export const STATUS_PROBE_TIMEOUT_MS = 3_000;

/** How many log lines `daemon logs` shows when the caller names no number. */
export const DEFAULT_LOG_LINES = 200;

/** The version of {@link DaemonStatusReport}'s shape, so a consumer can refuse one it cannot read. */
export const DAEMON_STATUS_REPORT_VERSION = 1;

/**
 * Every condition `daemon status` can report.
 *
 * It is `commands/status.ts`'s {@link STATUS_CONDITIONS} plus the two that need a supervisor query
 * or the setup marker, and the shared members are classified in the same order and mean the same
 * thing — a consumer that already handles `xplainer status --json` handles this by adding two
 * cases rather than by relearning seven.
 *
 * - `disabled` — the supervisor says this service is switched off, and nothing answered. It is the
 *   condition `xplainer status` deliberately cannot reach: Login Items & Extensions, `systemctl
 *   --user disable` and a disabled scheduled task all change supervisor state and touch no file of
 *   ours, so only a supervisor query can see it. Its remedy is a command, not an investigation.
 * - `degraded` — the daemon answered a `200` and the render toolchain the setup marker recorded is
 *   not on this machine, so `explainer_create` works and every render will fail. It exits `0`,
 *   because the daemon *is* running and answering and a script that gates on "is the daemon up"
 *   must not fail over a missing Chrome; the sentence and `toolchain.missing` are how a reader
 *   finds out, and `xplainer setup` is the fix.
 */
export const DAEMON_STATUS_CONDITIONS = [
  "ready",
  "degraded",
  "stalled",
  "disabled",
  "unauthorized",
  "token_absent",
  "unhealthy",
  "unreachable",
  "absent",
] as const;

/** One of {@link DAEMON_STATUS_CONDITIONS}. */
export type DaemonStatusCondition = (typeof DAEMON_STATUS_CONDITIONS)[number];

/**
 * What the supervisor says about whether this service may run at all.
 *
 * Four values, because "the supervisor has never heard of this service" and "the supervisor knows
 * it and it is switched off" have different next steps — one is `xplainer daemon install`, the
 * other is one `launchctl enable`, `systemctl --user enable` or `Enable-ScheduledTask` — and
 * "nothing answered the query" must not be reported as either.
 */
export type SupervisorSwitch = "on" | "off" | "unregistered" | "unknown";

/** The answer to the disabled-by-user-or-policy query, with the query that produced it. */
export type SwitchFact = {
  /** The command, spelled as it was run, or `null` on a platform with no supervisor. */
  query: string | null;
  /** Whether the query ran to completion. */
  answered: boolean;
  /** What it said. */
  state: SupervisorSwitch;
  /** The word the supervisor used, before it was mapped. */
  raw: string;
  /** What it means, and the one command that undoes it. */
  detail: string;
};

/** The loaded-configuration query (T17's row 2), and why macOS has none. */
export type LoadedConfigurationFact = {
  /** Whether this platform has a documented query for what the supervisor actually loaded. */
  available: boolean;
  /** The command, spelled as it was run, or `null` where there is none. */
  query: string | null;
  /** Whether it ran to completion. */
  answered: boolean;
  /** Its stdout, trimmed, exactly as the supervisor printed it. */
  output: string;
  /**
   * The same answer as the three values a launch spec can be compared against.
   *
   * `supervisors/identity.ts` does the parsing, and it is given this raw output rather than a
   * runner, so every platform's vocabulary is asserted from one machine — the same arrangement
   * {@link readSwitch} has for the same reason.
   */
  identity: LoadedIdentity;
  /** What was asked, or why nothing was. */
  detail: string;
};

/** Which of ADR 0020's four states one sentence is about. */
export type StatusState =
  | "stopped-after-failed-starts"
  | "switched-off"
  | "degraded-toolchain"
  | "not-boot-persistent";

/** One sentence `daemon status` says, tagged with the state it is about. */
export type StatusSentence = {
  state: StatusState;
  text: string;
};

/**
 * ADR 0020's second sentence, per supervisor.
 *
 * launchd's is the ADR's own, word for word: "you or a policy switched this off in Login Items &
 * Extensions". The other two name their own surface, because a Linux user has no Login Items pane
 * and a sentence that told them to look for one would be worse than no sentence at all. The claim
 * — "you or a policy switched this off" — is identical on all three, which is the part that is the
 * ADR's.
 */
export const SWITCHED_OFF_SENTENCES: Readonly<Record<SupervisorKind, string>> = {
  launchd: "you or a policy switched this off in Login Items & Extensions",
  systemd: "you or a policy switched this off with `systemctl --user disable`",
  "task-scheduler": "you or a policy switched this off in Task Scheduler",
};

/** ADR 0020's third sentence. One state, one platform-independent cause, one wording. */
export const DEGRADED_TOOLCHAIN_SENTENCE = "running, degraded: the render toolchain is missing";

/**
 * ADR 0020's fourth sentence, per supervisor.
 *
 * systemd's is the ADR's own: lingering is what makes a user unit survive a reboot with nobody
 * logged in, and its absence is the one boot-persistence failure that is *fixable*. The other two
 * are not failures at all but the stated limitations of their platforms — "macOS gets login, not
 * boot — and this is a stated limitation, not a bug", which the ADR says `install` prints in advance
 * and `status` repeats — and a scheduled task registered on a logon trigger, which is what this
 * project registers because a boot trigger needs an administrator.
 */
export const NOT_BOOT_PERSISTENT_SENTENCES: Readonly<Record<SupervisorKind, string>> = {
  systemd: "running, but not boot-persistent, because lingering is not enabled",
  launchd:
    "running, but not boot-persistent, because a LaunchAgent runs only while you are logged in — " +
    "macOS gets login, not boot",
  "task-scheduler":
    "running, but not boot-persistent, because the task starts at logon rather than at boot — " +
    "`--at-boot` needs an administrator",
};

/** The port and the process holding it, when the recorded port is held by something. */
export type PortHold = {
  port: number;
  /** The holder's pid, or `null` when no tool on this machine would name one. */
  pid: number | null;
  /** How the holder was named, in the preflight's own words. */
  detail: string;
};

/**
 * ADR 0020's first sentence: the breaker, and who has the port.
 *
 * Two clauses, and the second one is conditional because it is a *separate* observation: the
 * breaker latches on this daemon's own start history, and the port being held by somebody else is
 * why the next start would fail too. When nothing holds the port the sentence stops after the first
 * clause rather than inventing a holder, and when a holder exists that no tool would name, the
 * preflight's own words go in place of the pid.
 */
export function stoppedAfterFailedStartsSentence(
  failedStarts: number,
  hold: PortHold | null,
): string {
  const opening = `stopped after ${String(failedStarts)} failed starts`;
  if (hold === null) {
    return opening;
  }
  return hold.pid === null
    ? `${opening}; port ${String(hold.port)} is held ${hold.detail}`
    : `${opening}; port ${String(hold.port)} is held by pid ${String(hold.pid)}, which is not an ` +
        "xplainer daemon";
}

/** What `/healthz` answered, in the shapes that need different sentences. */
export type StatusProbe =
  | { kind: "ok"; body: HealthBody }
  | { kind: "unauthenticated" }
  | { kind: "http"; status: number }
  | { kind: "unreachable"; reason: string };

/** The fields of `/healthz`'s body this command reports. */
export type HealthBody = {
  status?: unknown;
  version?: unknown;
  contract_version?: unknown;
  /** The answering run's ownership nonce (T17's row 3). */
  run_id?: unknown;
  /** The answering run's immutable startup snapshot (T17's row 3). */
  runtime_digest?: unknown;
};

/** The setup marker's answer, reduced to what the degraded sentence needs. */
export type ToolchainFact = {
  /** `<state>/toolchain.json`. */
  path: string;
  /** Whether the marker is there, readable, and every file it names still exists. */
  complete: boolean;
  /** The recorded paths that are gone, in the order the marker names them. */
  missing: readonly string[];
  detail: string;
};

/** Whether this daemon comes back without a human, and by what mechanism. */
export type BootPersistenceFact = {
  /** `null` when nothing is installed, so no mechanism has been chosen. */
  persistent: boolean | null;
  /** The mechanism this platform uses, named. */
  mechanism: string;
  detail: string;
};

/** What `daemon status` establishes. One object, printed as prose or as JSON. */
export type DaemonStatusReport = {
  schema_version: number;
  condition: DaemonStatusCondition;
  /** The code the invocation exits with, so a caller reading the document agrees with `$?`. */
  exit_code: number;
  state_dir: string;
  /** The sentences ADR 0020 requires, each tagged with its state. */
  sentences: readonly StatusSentence[];
  /** `daemon.json`, with `token_file` carrying the path this command actually read. */
  daemon: DaemonState;
  /** `runtime.json` as found, or `null`. A hint: never trusted without the probe. */
  runtime: Record<string, unknown> | null;
  supervisor: {
    kind: SupervisorKind | null;
    /** The unit name, the launchd label or the fully qualified task name. */
    identity: string | null;
    /** The unit, plist or task XML `install` wrote. */
    artefact: string | null;
    /** Whether that artefact is still where the record says it is. */
    artefact_present: boolean;
    /** Whether a **user** manager answered at all, and what it said about itself. */
    manager: { usable: boolean; detail: string };
    /** The disabled-by-user-or-policy query. */
    switch: SwitchFact;
    /** The loaded-configuration query. Unavailable on macOS by §1.3b D7. */
    loaded: LoadedConfigurationFact;
  };
  probe: {
    url: string;
    port: number;
    http_status: number | null;
    error: string | null;
    /** The pid holding the recorded port, when something does and a tool would name it. */
    holder_pid: number | null;
    holder_detail: string | null;
  };
  health: {
    status: string | null;
    version: string | null;
    contract_version: string | null;
    /** The answering run's ownership nonce, or `null` from a daemon that advertises none. */
    run_id: string | null;
    /** The answering run's startup digest, or `null` from a daemon that advertises none. */
    runtime_digest: string | null;
  } | null;
  /**
   * The three-row consistency check: desired, loaded and responding.
   *
   * It is a field of the report rather than a verb of its own because every input it needs is
   * already read here — `daemon.json`, the loaded-configuration query and `/healthz` — and a second
   * command that asked for all three again could disagree with this one about a machine that had
   * changed in between.
   */
  identity: IdentityReport;
  toolchain: ToolchainFact;
  /**
   * The token file's own protection, re-read rather than assumed.
   *
   * ADR 0020 §Security R-SEC-5 asks for both halves — "an explicit ACL applied at creation … and
   * `xplainer daemon status` re-verifies it and warns if inheritance has been restored" — and only
   * this command can do the second one: the mint happens once, and `/inheritance:r` is undone by
   * one `icacls`, a restored backup or an installer that resets a tree, none of which changes
   * anything else about the file.
   */
  token_acl: TokenAclFact;
  boot_persistence: BootPersistenceFact;
  /** How many starts in a row failed before the daemon was ready, newest first. */
  failed_starts: number;
};

/** Everything `daemon status` reads the outside world through. Every fact is a parameter. */
export type DaemonStatusRequest = {
  stateDir: string;
  platform?: NodeJS.Platform | undefined;
  env?: Readonly<Record<string, string | undefined>> | undefined;
  environment?: SupervisorEnvironment | undefined;
  /** How a supervisor query is run. A parameter, so one machine can exercise all three. */
  run?: ProbeRunner | undefined;
  /** The uid whose `gui/<uid>` domain a LaunchAgent lives in. Defaults to this process's. */
  uid?: number | undefined;
  /** How `/healthz` is asked. Defaults to a real authenticated request over loopback. */
  probe?: ((url: string, token: string | null) => Promise<StatusProbe>) | undefined;
};

/**
 * The daemon is not installed here, so there is nothing to start, stop or read a log from.
 *
 * ADR 0020's `3` — "a precondition this command needs was not met, and it has written nothing" —
 * rather than a new code: `daemon start` on a machine with no registration is the same shape as
 * `daemon install` with no setup marker, and the remedy is one documented command.
 */
export class DaemonNotInstalled extends Error {
  readonly exitCode: number = PRECONDITION_UNMET_EXIT_CODE;

  constructor(message: string) {
    super(message);
    this.name = "DaemonNotInstalled";
  }
}

/** A verb reached the supervisor and the daemon did not end up in the state that was asked for. */
export class LifecycleRefusal extends Error {
  readonly exitCode: number = DAEMON_UNHEALTHY_EXIT_CODE;
  /** Every supervisor command that ran, in order, for the transcript a user is shown. */
  readonly commands: readonly string[];

  constructor(message: string, commands: readonly string[]) {
    super(message);
    this.name = "LifecycleRefusal";
    this.commands = commands;
  }
}

/** What `start` or `stop` did. */
export type LifecycleOutcome = {
  /** The supervisor that was asked. */
  kind: SupervisorKind;
  /** The name it addresses the daemon by. */
  identity: string;
  /** Whether the daemon was already in the asked-for state, so the supervisor changed nothing. */
  alreadyThere: boolean;
  /** Every command that ran, spelled as it was run. */
  commands: readonly string[];
  /** How long the wait for the post-condition took, in milliseconds. */
  elapsedMs: number;
  /** The port that answered, for a `start` that ended in a `200`. */
  port: number | null;
};

/** What `start` and `stop` need. */
export type LifecycleRequest = {
  stateDir: string;
  platform?: NodeJS.Platform | undefined;
  env?: Readonly<Record<string, string | undefined>> | undefined;
  environment?: SupervisorEnvironment | undefined;
  run?: ProbeRunner | undefined;
  uid?: number | undefined;
  /** The whole budget for the wait. Defaults to {@link LIFECYCLE_TIMEOUT_MS}. */
  timeoutMs?: number | undefined;
  /** How often the wait asks again. Defaults to {@link LIFECYCLE_POLL_INTERVAL_MS}. */
  intervalMs?: number | undefined;
  probe?: ((url: string, token: string | null) => Promise<StatusProbe>) | undefined;
  log?: ((line: string) => void) | undefined;
};

/** Where `daemon logs` reads from on this platform. */
export type LogSource =
  | {
      kind: "journal";
      /** `journalctl --user -u xplainer`, plus the line count. */
      command: ProbeCommand;
    }
  | {
      kind: "file";
      path: string;
      /** Whether that file is there yet. */
      present: boolean;
    };

// ── The three documented queries ─────────────────────────────────────────────────────────────

/**
 * The disabled-by-user-or-policy query, per supervisor.
 *
 * macOS asks the domain rather than the label, because `print-disabled` takes a domain and prints
 * its whole store; the label is matched out of the answer by {@link readDisableRecord}, one line
 * for one label. Linux and Windows are asked about the service itself, and both answer with one
 * word.
 */
export function disabledQuery(target: RegistrationTarget): ProbeCommand {
  switch (target.kind) {
    case "launchd":
      return { program: "launchctl", argv: ["print-disabled", `gui/${String(target.uid)}`] };
    case "systemd":
      return { program: "systemctl", argv: ["--user", "is-enabled", target.identity] };
    case "task-scheduler":
      return {
        program: POWERSHELL,
        argv: [...POWERSHELL_ARGV, `(Get-ScheduledTask -TaskName ${quote(target.identity)}).State`],
      };
  }
}

/**
 * The loaded-configuration query, per supervisor, or `null` where there is none.
 *
 * `null` on macOS is §1.3b D7 and is the whole of it: the only launchd surface that would answer is
 * `launchctl print`, whose own manual says "Do NOT rely on the structure … for ANY reason", and the
 * measurement behind the decision found duplicate keys and `state = active` lines interleaved
 * *inside* the `arguments` block. `/healthz` advertising the responding identity is the substitute,
 * and T17 is the story that consumes both.
 */
export function loadedConfigurationQuery(target: RegistrationTarget): ProbeCommand | null {
  switch (target.kind) {
    case "launchd":
      return null;
    case "systemd":
      return {
        program: "systemctl",
        argv: [
          "--user",
          "show",
          "-p",
          "ExecStart",
          "-p",
          "Environment",
          "-p",
          "WorkingDirectory",
          "--value",
          target.identity,
        ],
      };
    case "task-scheduler":
      // Three `Key=value` lines, composed by the script itself rather than by a formatter.
      // `Format-List` wraps a value longer than the console width across lines, and an installed
      // `Arguments` is two absolute paths and six flags long — so a formatted answer would arrive
      // broken in the middle of a path and be compared as a mismatch that is really a line break.
      // String concatenation also turns an absent `WorkingDirectory` into an empty value on its own
      // line rather than into no line at all, which keeps the three keys always present.
      return {
        program: POWERSHELL,
        argv: [
          ...POWERSHELL_ARGV,
          `$action = @((Get-ScheduledTask -TaskName ${quote(target.identity)}).Actions)[0]; ` +
            '"Execute=" + $action.Execute; "Arguments=" + $action.Arguments; ' +
            '"WorkingDirectory=" + $action.WorkingDirectory',
        ],
      };
  }
}

/**
 * What one supervisor's answer to {@link disabledQuery} means.
 *
 * Pure, and given the raw answer rather than a runner, so every platform's vocabulary is asserted
 * from one machine — which is the same reason `preflight.ts` takes `run` as a parameter.
 *
 * - **launchd.** The store's value is the word `disabled` or `enabled`, measured on Darwin 25.5.0
 *   and captured in `__fixtures__/launchctl-print-disabled.txt`. No record at all is `on`: launchd
 *   runs a job it has never been told not to.
 * - **systemd.** `is-enabled` exits non-zero for `disabled` and that is documented behaviour, so
 *   the word is read and the status is not. `masked` is `off` too — a masked unit cannot be started
 *   at all — and `not-found` is `unregistered` rather than `off`.
 * - **Task Scheduler.** `State` is an enum whose members are `Unknown`, `Disabled`, `Queued`,
 *   `Ready` and `Running`; only `Disabled` is off, and a `Get-ScheduledTask` that could not find
 *   the task writes to stderr and prints nothing.
 */
export function readSwitch(
  kind: SupervisorKind,
  identity: string,
  answer: ProbeResult,
): { state: SupervisorSwitch; raw: string } {
  const raw = (answer.stdout.trim() || answer.stderr.trim()).split("\n")[0]?.trim() ?? "";
  if (!answer.started) {
    return { state: "unknown", raw };
  }
  if (kind === "launchd") {
    if (answer.status !== 0) {
      return { state: "unknown", raw };
    }
    const record = readDisableRecord(answer.stdout, identity);
    return { state: record === "disabled" ? "off" : "on", raw: record };
  }
  if (kind === "systemd") {
    const word = answer.stdout.trim().split("\n")[0]?.trim() ?? "";
    if (word === "disabled" || word === "masked" || word === "masked-runtime") {
      return { state: "off", raw: word };
    }
    if (word.startsWith("enabled") || word === "static" || word === "indirect") {
      return { state: "on", raw: word };
    }
    if (word === "not-found" || word === "") {
      return { state: "unregistered", raw: word === "" ? raw : word };
    }
    return { state: "unknown", raw: word };
  }
  const word = answer.stdout.trim().split("\n")[0]?.trim() ?? "";
  if (answer.status !== 0 || word === "") {
    return {
      state: /cannot find|does not exist|no mapping/i.test(raw) ? "unregistered" : "unknown",
      raw,
    };
  }
  return { state: word.toLowerCase() === "disabled" ? "off" : "on", raw: word };
}

// ── status ───────────────────────────────────────────────────────────────────────────────────

/**
 * Everything the support ticket needs, from HTTP, our own state and the two documented queries.
 *
 * Read-only from end to end: the preflight writes nothing by construction, the queries are reads,
 * and the probe is one `GET`.
 */
export async function daemonStatus(request: DaemonStatusRequest): Promise<DaemonStatusReport> {
  const platform = request.platform ?? process.platform;
  const env = request.env ?? process.env;
  const run = memoiseProbes(request.run ?? runProbe);
  const uid = request.uid ?? process.getuid?.() ?? 0;
  const environment = request.environment ?? currentSupervisorEnvironment(env, homedir(), platform);
  const probe = request.probe ?? loopbackProbe;

  const daemon = readDaemonState(request.stateDir);
  const runtime = readRuntimeState(request.stateDir);
  const endpoint = resolveDaemonEndpoint({
    configuredUrl: null,
    recordedPort: daemon.port,
    fallbackPort: DEFAULT_PORT,
  });
  // `resolveDaemonEndpoint` refuses only a configured URL it cannot parse, and none was configured:
  // `daemon status` is about **this machine's** installed daemon, which is what makes the supervisor
  // queries below meaningful at all. `xplainer status --url` is the command for somebody else's.
  const url = endpoint.ok ? endpoint.url : `http://127.0.0.1:${String(DEFAULT_PORT)}`;
  const port = endpoint.ok ? endpoint.port : DEFAULT_PORT;

  const preflight = await preflightInstall({
    stateDir: request.stateDir,
    port,
    platform,
    env,
    environment,
    run,
  });

  const kind = daemon.supervisor_kind ?? preflight.supervisor.kind;
  // The identity is the adapter's, built from **this** account's environment, which is the same
  // thing `install` handed the supervisor: the name is derived from the account and the home, and a
  // record of it in `daemon.json` would be a second copy to disagree with the first.
  const identity =
    kind === null ? null : (preflight.supervisor.identity ?? adapterIdentity(kind, environment));
  // The queries are asked about a **registration this machine recorded**, never about the name an
  // install *would* use: `launchctl print-disabled` answers for a label nothing has ever
  // bootstrapped, and reporting that as "switched on" would be an answer about a service that does
  // not exist. `daemon.json`'s `supervisor_kind` is what `install` writes and `uninstall` clears.
  const target: RegistrationTarget | null =
    daemon.supervisor_kind === null || kind === null || identity === null
      ? null
      : { kind, identity, artefact: daemon.supervisor_artefact ?? "", uid };

  const switchFact = askSwitch(target, run);
  const loaded = askLoadedConfiguration(target, run);

  const tokenPath = daemon.token_file ?? resolveTokenPath(request.stateDir, env);
  const token = readTokenQuietly(tokenPath);
  const answer = await probe(url, token);

  const failedStarts = countTrailingFailures(daemon.recentStarts);
  const hold: PortHold | null = preflight.port.held
    ? { port: preflight.port.port, pid: preflight.port.holder, detail: preflight.port.holderDetail }
    : null;
  const toolchain: ToolchainFact = {
    path: preflight.toolchain.path,
    complete: preflight.toolchain.marker !== null && preflight.toolchain.missing.length === 0,
    missing: preflight.toolchain.missing,
    detail: describeToolchain(preflight),
  };
  const boot = bootPersistence(kind, preflight, daemon);
  const tokenAcl = askTokenAcl(tokenPath, platform, run);

  const condition = classify({
    probe: answer,
    token,
    stalled: daemon.stalled !== null,
    switchedOff: switchFact.state === "off",
    toolchainComplete: toolchain.complete,
    recordedPort: daemon.port,
    runtimePresent: runtime !== null,
  });
  const exitCode =
    condition === "ready" || condition === "degraded" ? 0 : DAEMON_UNHEALTHY_EXIT_CODE;

  return {
    schema_version: DAEMON_STATUS_REPORT_VERSION,
    condition,
    exit_code: exitCode,
    state_dir: request.stateDir,
    sentences: statusSentences({
      kind,
      answering: answer.kind === "ok",
      stalled: daemon.stalled !== null,
      failedStarts,
      hold,
      switchedOff: switchFact.state === "off",
      toolchainComplete: toolchain.complete,
      bootPersistent: boot.persistent,
    }),
    daemon: { ...daemon, token_file: tokenPath },
    runtime,
    supervisor: {
      kind,
      identity,
      artefact: daemon.supervisor_artefact,
      artefact_present:
        daemon.supervisor_artefact !== null && existsSync(daemon.supervisor_artefact),
      manager: { usable: preflight.supervisor.usable, detail: preflight.supervisor.detail },
      switch: switchFact,
      loaded,
    },
    probe: {
      url,
      port,
      http_status: probeHttpStatus(answer),
      error: answer.kind === "unreachable" ? answer.reason : null,
      holder_pid: hold?.pid ?? null,
      holder_detail: hold?.detail ?? null,
    },
    health:
      answer.kind === "ok"
        ? {
            status: reportedString(answer.body.status),
            version: reportedString(answer.body.version),
            contract_version: reportedString(answer.body.contract_version),
            run_id: reportedString(answer.body.run_id),
            runtime_digest: reportedString(answer.body.runtime_digest),
          }
        : null,
    identity: checkIdentity({
      kind: daemon.supervisor_kind,
      // The record already read above, rather than a second read of the same file: a `daemon.json`
      // edited between the two would make the report disagree with itself.
      desired: readDesired({ stateDir: request.stateDir, state: daemon }),
      loaded: loaded.identity,
      // `answer.body` is only a body when something answered `200`; anything else advertises
      // nothing, and `readResponding` says so rather than inventing an absence.
      responding: readResponding(answer.kind === "ok" ? answer.body : {}),
      recordedRunId: typeof runtime?.run_id === "string" ? runtime.run_id : null,
    }),
    toolchain,
    token_acl: tokenAcl,
    boot_persistence: boot,
    failed_starts: failedStarts,
  };
}

/** The token file's protection, as `daemon status` reports it. */
export type TokenAclFact = {
  /** The file the entry was read off, which is the one this report says the daemon reads. */
  path: string;
  /** The `icacls` that was run, or `null` where the platform has no entry to re-verify. */
  query: string | null;
  /** `not-applicable` off Windows, `owner-only` when it still is, `widened` or `unknown`. */
  state: AclVerdict["state"];
  /** The sentence, which on `widened` names what it found and the command that narrows it again. */
  detail: string;
};

/**
 * Re-read the token file's access-control entry, on the platform that has one.
 *
 * The command goes through the same {@link ProbeRunner} the supervisor queries use, so a test
 * drives it with a recorded answer on any machine and the one real `icacls` on `windows-latest` is
 * the same code path. It is a **query**: `icacls <path>` with no `/grant` and no `/inheritance`,
 * which is as read-only as `launchctl print-disabled` beside it — `daemon status` reports, and the
 * mint and `token rotate` are the two places that write an entry.
 */
function askTokenAcl(path: string, platform: string, run: ProbeRunner): TokenAclFact {
  if (platform !== "win32") {
    const verdict = readAclVerdict(
      path,
      { started: false, status: null, stdout: "", stderr: "" },
      undefined,
      platform,
    );
    return { path, query: null, state: verdict.state, detail: verdict.detail };
  }
  const command = aclQuery(path);
  const answer = run(command);
  const verdict = readAclVerdict(path, answer, undefined, platform);
  return { path, query: spell(command), state: verdict.state, detail: verdict.detail };
}

/**
 * ADR 0020's four sentences, and which of them this machine is entitled to say.
 *
 * Pure, and separate from {@link daemonStatus}, so the four states can be asserted as values —
 * which is T12's verification — rather than by arranging four machines and reading four
 * transcripts. Order is the ADR's own.
 */
export function statusSentences(facts: {
  kind: SupervisorKind | null;
  answering: boolean;
  stalled: boolean;
  failedStarts: number;
  hold: PortHold | null;
  switchedOff: boolean;
  toolchainComplete: boolean;
  bootPersistent: boolean | null;
}): readonly StatusSentence[] {
  const sentences: StatusSentence[] = [];
  if (facts.stalled) {
    sentences.push({
      state: "stopped-after-failed-starts",
      text: stoppedAfterFailedStartsSentence(
        facts.failedStarts,
        // The holder clause belongs to the sentence only while the port is held by something that
        // is *not* answering our authenticated `/healthz`. A daemon that is up holds its own port,
        // and "which is not an xplainer daemon" would then be false.
        facts.answering ? null : facts.hold,
      ),
    });
  }
  if (facts.switchedOff && facts.kind !== null) {
    sentences.push({ state: "switched-off", text: SWITCHED_OFF_SENTENCES[facts.kind] });
  }
  if (facts.answering && !facts.toolchainComplete) {
    sentences.push({ state: "degraded-toolchain", text: DEGRADED_TOOLCHAIN_SENTENCE });
  }
  if (facts.answering && facts.bootPersistent === false && facts.kind !== null) {
    sentences.push({
      state: "not-boot-persistent",
      text: NOT_BOOT_PERSISTENT_SENTENCES[facts.kind],
    });
  }
  return sentences;
}

// ── start and stop ───────────────────────────────────────────────────────────────────────────

/** The command that asks the supervisor to start the daemon it already holds. */
export function startCommand(target: RegistrationTarget): ProbeCommand {
  switch (target.kind) {
    case "systemd":
      return { program: "systemctl", argv: ["--user", "start", target.identity] };
    case "launchd":
      // `kickstart` rather than `launchctl start`, which is the legacy verb: the job is already
      // bootstrapped by `install`, and `kickstart` is what starts a loaded job in a domain.
      return { program: "launchctl", argv: ["kickstart", guiService(target)] };
    case "task-scheduler":
      return {
        program: POWERSHELL,
        argv: [...POWERSHELL_ARGV, `Start-ScheduledTask -TaskName ${quote(target.identity)}`],
      };
  }
}

/**
 * The command that asks the supervisor to stop it, leaving the registration in place.
 *
 * **macOS sends a signal rather than booting the job out.** `launchctl bootout` would unload the
 * definition, and a `daemon stop` that also deregistered would be an uninstall with another name.
 * `launchctl kill SIGTERM` stops the process and leaves the job loaded, and the plist's
 * `KeepAlive` is `{SuccessfulExit: false}` — so a daemon that shuts down cleanly and exits `0` is
 * not restarted, which is what makes this a stop at all.
 *
 * **Windows terminates rather than signals, and that is the platform.** `Stop-ScheduledTask` ends
 * the task's process; Windows has no `SIGTERM` to send it. The graceful route is the drain over the
 * named pipe, which is T13's, and this verb is what remains when there is no daemon to ask.
 */
export function stopCommand(target: RegistrationTarget): ProbeCommand {
  switch (target.kind) {
    case "systemd":
      return { program: "systemctl", argv: ["--user", "stop", target.identity] };
    case "launchd":
      return { program: "launchctl", argv: ["kill", "SIGTERM", guiService(target)] };
    case "task-scheduler":
      return {
        program: POWERSHELL,
        argv: [...POWERSHELL_ARGV, `Stop-ScheduledTask -TaskName ${quote(target.identity)}`],
      };
  }
}

/**
 * The command that clears the **supervisor's** own failure latch, or `null` where there is none.
 *
 * systemd is the one platform that latches. A unit that has failed sits in `failed` until something
 * resets it, and `StartLimitBurst` refuses a start outright once the rate limit is hit — "Start
 * request repeated too quickly" — so a `restart` that did not run `reset-failed` first would ask a
 * manager that has already decided the answer is no. `systemctl --user reset-failed <unit>` is that
 * reset and it is documented as such.
 *
 * The other two have nothing to clear, and saying so is the point of a `null` rather than an
 * omission: launchd throttles a job with `ThrottleInterval` and forgets it — `kickstart` starts a
 * job whatever its last exit was — and Task Scheduler records `LastTaskResult` for a reader without
 * ever refusing the next `Start-ScheduledTask` because of it. A task that is *disabled* is a
 * different fact with a different remedy, and `daemon status` is where that one is reported.
 */
export function resetFailedCommand(target: RegistrationTarget): ProbeCommand | null {
  switch (target.kind) {
    case "systemd":
      return { program: "systemctl", argv: ["--user", "reset-failed", target.identity] };
    case "launchd":
    case "task-scheduler":
      return null;
  }
}

/** Why nothing was run against a supervisor that keeps no failure latch. */
const NO_SUPERVISOR_LATCH: Readonly<Record<SupervisorKind, string>> = {
  systemd: "",
  launchd:
    "launchd keeps no failure latch to clear: it throttles a job with ThrottleInterval and starts " +
    "it again whatever its last exit was",
  "task-scheduler":
    "Task Scheduler keeps no failure latch to clear: LastTaskResult is a record for a reader and " +
    "never a refusal of the next start",
};

/**
 * The documented query for how the last run **ended**, or `null` where a platform has none.
 *
 * Only systemd offers one: `Result` is the manager's own verdict on the unit's last stop and
 * `ExecMainStatus` is the main process's exit status, both from `systemctl show`, which is
 * systemd's scripting interface. macOS has nothing usable — `launchctl print`'s manual says "This
 * output is NOT API in any sense at all", and this package calls it nowhere — and Windows'
 * `LastTaskResult` is left out deliberately rather than guessed at, because nothing in this project
 * has measured what it reports for a process that exited during a `Stop`.
 *
 * Where it is `null`, {@link restartDaemon}'s evidence is what an outside observer can always have:
 * the drained pid is gone and step 6 removed `runtime.json`.
 */
export function exitStatusQuery(target: RegistrationTarget): ProbeCommand | null {
  if (target.kind !== "systemd") {
    return null;
  }
  return {
    program: "systemctl",
    argv: ["--user", "show", "-p", "Result", "-p", "ExecMainStatus", "--value", target.identity],
  };
}

/**
 * Ask the supervisor to start the daemon, and wait for it to answer.
 *
 * The post-condition is an **authenticated `200`**, never the start command's exit status: ADR 0025
 * §Part three is explicit that a `401` proves a bind and nothing about readiness, and every one of
 * these three commands returns as soon as the supervisor has accepted the request rather than when
 * the process is up.
 *
 * **The wait is `awaitHealthy`, which is `install`'s, and the port comes from the daemon rather
 * than from the record.** A daemon installed with `--port 0` binds a different port at every start,
 * and a wait that polled the port `daemon.json` held a moment ago would be polling the *previous*
 * run's. `awaitHealthy` reads the port out of the `runtime.json` this start wrote — and requires
 * that record to be newer than the moment the start command was issued, so an earlier run's file
 * cannot pass the check for a process that never came up.
 *
 * @throws {DaemonNotInstalled} when nothing is registered here.
 * @throws {LifecycleRefusal} when the supervisor refused, or nothing answered inside the budget.
 */
export async function startDaemon(request: LifecycleRequest): Promise<LifecycleOutcome> {
  const context = lifecycleContext(request);
  const started = Date.now();
  if ((await context.probeOnce()).kind === "ok") {
    return {
      kind: context.target.kind,
      identity: context.target.identity,
      alreadyThere: true,
      commands: [],
      elapsedMs: Date.now() - started,
      port: context.port,
    };
  }

  const command = startCommand(context.target);
  const since = Date.now();
  const answer = context.run({ ...command, timeoutMs: LIFECYCLE_COMMAND_TIMEOUT_MS });
  const commands = [spell(command)];
  if (!answer.started || answer.status !== 0) {
    throw new LifecycleRefusal(
      `${spell(command)} ${answer.started ? `exited ${String(answer.status)}` : "could not be run"}` +
        `: ${firstLine(answer) || "it said nothing"}. The daemon was not started.`,
      commands,
    );
  }

  try {
    const health = await awaitHealthy({
      stateDir: request.stateDir,
      since,
      timeoutMs: context.timeoutMs,
      env: request.env ?? process.env,
      intervalMs: request.intervalMs ?? LIFECYCLE_POLL_INTERVAL_MS,
    });
    return {
      kind: context.target.kind,
      identity: context.target.identity,
      alreadyThere: false,
      commands,
      elapsedMs: Date.now() - started,
      port: health.port,
    };
  } catch (error) {
    if (error instanceof HealthTimeout) {
      throw new LifecycleRefusal(
        `${context.identityLine} was started and nothing answered an authenticated GET ` +
          `/healthz within ${String(context.timeoutMs / 1000)} s: ${error.detail}. ` +
          "`xplainer daemon status` says what the supervisor and this machine's state files " +
          "think, and `xplainer daemon logs` is where the process's own account of it is.",
        commands,
      );
    }
    throw error;
  }
}

/**
 * Ask the supervisor to stop it, and wait until nothing answers.
 *
 * A non-zero status from the stop command is **tolerated**, and the post-condition is what decides:
 * all three supervisors report an error when asked to stop something that is not running, and the
 * caller's question — "is it stopped" — is already answered yes in that case.
 *
 * @throws {DaemonNotInstalled} when nothing is registered here.
 * @throws {LifecycleRefusal} when something is still answering after the budget.
 */
export async function stopDaemon(request: LifecycleRequest): Promise<LifecycleOutcome> {
  const context = lifecycleContext(request);
  const started = Date.now();
  const alreadyStopped = (await context.probeOnce()).kind !== "ok";

  const command = stopCommand(context.target);
  const answer = context.run({ ...command, timeoutMs: LIFECYCLE_COMMAND_TIMEOUT_MS });
  const commands = [spell(command)];
  if (!answer.started) {
    throw new LifecycleRefusal(
      `${spell(command)} could not be run: ${firstLine(answer) || "it said nothing"}.`,
      commands,
    );
  }

  const gone = await context.waitFor(async () => (await context.probeOnce()).kind !== "ok");
  if (!gone) {
    throw new LifecycleRefusal(
      `${context.identityLine} was asked to stop and is still answering ${context.url}/healthz ` +
        `after ${String(context.timeoutMs / 1000)} s.` +
        (answer.status === 0 ? "" : ` The supervisor said: ${firstLine(answer)}`),
      commands,
    );
  }
  return {
    kind: context.target.kind,
    identity: context.target.identity,
    alreadyThere: alreadyStopped,
    commands,
    elapsedMs: Date.now() - started,
    port: null,
  };
}

// ── restart ──────────────────────────────────────────────────────────────────────────────────

/** What a `restart` did, beyond what a `start` reports. */
export type RestartOutcome = LifecycleOutcome & {
  /** The application latch that was cleared before anything else was asked. */
  cleared: ClearedLatch;
  /** What was done about the supervisor's own latch, or why nothing was. */
  supervisorLatch: string;
  /** How the running daemon was stopped, in the words the transcript prints. */
  stop: string;
  /** The supervisor's verdict on the exit, where the platform has a documented query for one. */
  exit: string;
};

/**
 * `daemon restart` — clear both latches, drain what is running, and start it again.
 *
 * The order is the story's and every step of it is load-bearing:
 *
 * 1. **Clear the application latch first** (`daemon/control.ts`). `serve` refuses to start at all
 *    while `daemon.json` carries a `stalled` record — ADR 0020 gives exactly this command the job
 *    of clearing it — so a restart that asked the supervisor first would start a process that
 *    exits `0` before it binds, and then wait 30 s for a daemon that decided not to be one.
 * 2. **Clear the supervisor's latch** ({@link resetFailedCommand}), for the same reason one step
 *    earlier: systemd refuses a start it has rate-limited, and the refusal is not this command's to
 *    discover at the end.
 * 3. **Drain over the socket**, which is the daemon's own six steps and the only graceful stop
 *    Windows has at all — `SIGTERM` there is `TerminateProcess` and no handler runs. **An
 *    already-stopped daemon is a success**, not a refusal: `restart` is asked for by people whose
 *    daemon is not running, and the end state they want is a running one.
 * 4. **Wait for it to be gone within budget**, then **ask the adapter to start**, and **wait for
 *    readiness by T5's mechanism** — an authenticated `GET /healthz` against the `runtime.json`
 *    this start wrote, which is {@link startDaemon} and is reused rather than rewritten.
 *
 * @throws {DaemonNotInstalled} when nothing is registered here.
 * @throws {LifecycleRefusal} when the daemon would not stop, or would not come back.
 */
export async function restartDaemon(request: LifecycleRequest): Promise<RestartOutcome> {
  const context = lifecycleContext(request);
  const startedAt = Date.now();
  const commands: string[] = [];

  const cleared = clearStartLatch(request.stateDir);
  const reset = resetFailedCommand(context.target);
  let supervisorLatch = NO_SUPERVISOR_LATCH[context.target.kind];
  if (reset !== null) {
    const answer = context.run({ ...reset, timeoutMs: LIFECYCLE_COMMAND_TIMEOUT_MS });
    commands.push(spell(reset));
    // A non-zero here is tolerated and reported: `reset-failed` against a unit that has nothing to
    // reset is not an error this command should turn into a refusal, and the only thing that would
    // be lost by stopping is the restart the user asked for.
    supervisorLatch =
      answer.started && answer.status === 0
        ? `${spell(reset)} cleared the unit's failed state and its start-rate limit`
        : `${spell(reset)} ${
            answer.started ? `exited ${String(answer.status)}` : "could not be run"
          }: ${firstLine(answer) || "it said nothing"} — continued anyway`;
  }

  const stopped = await drainOrStop(context, request, commands);
  const exit = await readExitVerdict(context, stopped.drained);

  // The start half, and the readiness wait with it. `startDaemon` probes first, so a supervisor
  // that brought the daemon back by itself — the case a non-zero exit produces on Linux and macOS —
  // is reported as "was already answering" rather than raced with a second start.
  const started = await startDaemon(request);
  return {
    kind: started.kind,
    identity: started.identity,
    alreadyThere: started.alreadyThere,
    commands: [...commands, ...started.commands],
    elapsedMs: Date.now() - startedAt,
    port: started.port,
    cleared,
    supervisorLatch,
    stop: stopped.detail,
    exit,
  };
}

/**
 * Step 3 and 4: the drain over the socket, and the two cases where there is no drain to be had.
 *
 * The fallback to {@link stopDaemon} is deliberate and narrow. A daemon that is answering but whose
 * socket cannot be asked is either older than this route or bound somewhere `daemon.json` does not
 * record, and refusing to restart it would make this command useless in exactly the situation it is
 * most wanted — the upgrade from the release that has no route. The supervisor's stop is a
 * `SIGTERM` on Linux and macOS, which reaches the same six steps; on Windows it is a terminate, and
 * the transcript says so rather than describing it as a drain.
 */
async function drainOrStop(
  context: LifecycleContext,
  request: LifecycleRequest,
  commands: string[],
): Promise<{ drained: boolean; detail: string }> {
  if ((await context.probeOnce()).kind !== "ok") {
    return {
      drained: false,
      detail: `nothing was answering ${context.url}/healthz, so there was nothing to drain`,
    };
  }

  const socketPath = readDaemonState(request.stateDir).socket_path;
  const fallback = async (why: string): Promise<{ drained: false; detail: string }> => {
    const outcome = await stopDaemon(request);
    commands.push(...outcome.commands);
    return { drained: false, detail: `${why}; stopped it through ${context.target.kind} instead` };
  };
  if (socketPath === null) {
    return fallback("daemon.json records no socket path, so the drain route could not be asked");
  }

  const asked = await requestDrain({ socketPath });
  commands.push(`POST ${DRAIN_PATH} over ${socketPath}`);
  if (!asked.ok) {
    if (asked.reason === "not-listening") {
      return fallback(`${asked.detail}, though something answered /healthz a moment earlier`);
    }
    return fallback(asked.detail);
  }

  const acknowledgement = asked.acknowledgement;
  // The daemon's own cap plus this command's teardown allowance, so the budget follows the daemon
  // that answered rather than a number this release compiled in.
  const budget = acknowledgement.timeout_ms + STOP_TEARDOWN_ALLOWANCE_MS;
  const gone = await awaitStopped({
    stateDir: request.stateDir,
    pid: acknowledgement.pid,
    timeoutMs: budget,
    ...(request.intervalMs === undefined ? {} : { intervalMs: request.intervalMs }),
  });
  if (!gone.stopped) {
    throw new LifecycleRefusal(
      `${context.identityLine} accepted the drain and pid ${String(acknowledgement.pid)} was ` +
        `still running ${String(budget / 1000)} s later. \`xplainer daemon logs\` is where that ` +
        "process's own account of the drain is.",
      commands,
    );
  }
  return {
    drained: true,
    detail:
      `pid ${String(acknowledgement.pid)} drained${
        acknowledgement.already_draining ? " (a drain was already running)" : ""
      } and was gone after ${String(gone.elapsedMs)} ms; ` +
      `runtime.json ${gone.runtimeRecordRemoved ? "was removed with it" : "is still there"}`,
  };
}

/**
 * What the supervisor says about how that run ended, where it says anything at all.
 *
 * Reported rather than enforced. On Linux a `Result=success ExecMainStatus=0` is the exit `0` this
 * command asked for; anything else means the drain finished badly and `Restart=on-failure` has
 * probably already brought the daemon back — which the `start` below reports as "was already
 * answering". Turning that into a refusal would fail a command whose end state was reached, so the
 * evidence goes into the transcript instead.
 */
async function readExitVerdict(context: LifecycleContext, drained: boolean): Promise<string> {
  if (!drained) {
    return "not asked: this restart did not drain a running daemon";
  }
  const query = exitStatusQuery(context.target);
  if (query === null) {
    return (
      `${context.target.kind} offers no documented query for a stopped run's exit status, so the ` +
      "evidence is the drained process being gone and step 6 having removed runtime.json"
    );
  }
  const answer = context.run(query);
  if (!answer.started || answer.status !== 0) {
    return `${spell(query)} did not answer: ${firstLine(answer) || "it said nothing"}`;
  }
  const [result = "", status = ""] = answer.stdout
    .trim()
    .split("\n")
    .map((line) => line.trim());
  return status === "0"
    ? `${spell(query)} says Result=${result} ExecMainStatus=${status} — the drain ended in exit 0`
    : `${spell(query)} says Result=${result} ExecMainStatus=${status}, which is NOT the exit 0 a ` +
        "completed drain ends in";
}

// ── logs ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Where this platform's log lines are, and how to get them.
 *
 * Linux is a journal and the command is ADR 0020's own, `journalctl --user -u xplainer`; the unit
 * sets `SyslogIdentifier=xplainer`, so the unit's name and the identifier agree. macOS and Windows
 * are a file, and the path is the one `install` recorded in `log_sink` where it recorded a path —
 * a record rather than a recomputation, because a daemon installed under a different home is one
 * whose log is not where this process's home would put it.
 */
export function logSource(
  daemon: DaemonState,
  environment: SupervisorEnvironment,
  lines: number,
): LogSource {
  const kind = daemon.supervisor_kind;
  if (kind === "systemd") {
    return {
      kind: "journal",
      command: {
        program: "journalctl",
        argv: ["--user", "-u", SYSTEMD_UNIT_NAME, "-n", String(lines)],
      },
    };
  }
  const recorded = daemon.log_sink;
  const path =
    recorded !== null && recorded !== "journald"
      ? recorded
      : kind === "task-scheduler"
        ? taskLogPath(environment)
        : launchAgentLogPath(environment);
  return { kind: "file", path, present: existsSync(path) };
}

/**
 * The last `lines` lines of a file, read from the end.
 *
 * A log is the one file this CLI reads that has no bound on its size — the writer that would bound
 * it is not in this phase — so it is read backwards in blocks rather than loaded whole: a `logs`
 * verb that allocated a gigabyte to print two hundred lines would be its own incident.
 */
export function tailFile(path: string, lines: number, blockSize: number = 64 * 1024): string[] {
  const size = statSync(path).size;
  const handle = openSync(path, "r");
  try {
    let position = size;
    let text = "";
    while (position > 0) {
      const length = Math.min(blockSize, position);
      position -= length;
      const block = Buffer.alloc(length);
      readSync(handle, block, 0, length, position);
      text = block.toString("utf8") + text;
      // One more than asked for: the first element of a split is a partial line unless the read
      // began at the start of the file, and dropping it is what keeps a half-line out of the output.
      if (text.split("\n").length > lines + 1) {
        break;
      }
    }
    const all = text.split("\n");
    if (all[all.length - 1] === "") {
      all.pop();
    }
    return all.slice(-lines);
  } finally {
    closeSync(handle);
  }
}

// ── the parts the three verbs share ──────────────────────────────────────────────────────────

/** What one start or stop resolved before it did anything. */
type LifecycleContext = {
  target: RegistrationTarget;
  run: ProbeRunner;
  url: string;
  port: number;
  timeoutMs: number;
  identityLine: string;
  probeOnce: () => Promise<StatusProbe>;
  waitFor: (predicate: () => Promise<boolean>) => Promise<boolean>;
};

function lifecycleContext(request: LifecycleRequest): LifecycleContext {
  const platform = request.platform ?? process.platform;
  const env = request.env ?? process.env;
  const run = request.run ?? runProbe;
  const uid = request.uid ?? process.getuid?.() ?? 0;
  const environment = request.environment ?? currentSupervisorEnvironment(env, homedir(), platform);
  const timeoutMs = request.timeoutMs ?? LIFECYCLE_TIMEOUT_MS;
  const intervalMs = request.intervalMs ?? LIFECYCLE_POLL_INTERVAL_MS;
  const probe = request.probe ?? loopbackProbe;

  const daemon = readDaemonState(request.stateDir);
  const kind = daemon.supervisor_kind;
  if (kind === null) {
    throw new DaemonNotInstalled(
      `nothing is installed in ${request.stateDir}: daemon.json records no supervisor, so there ` +
        "is no unit, job or task to address. Install with `xplainer daemon install`.",
    );
  }
  const identity = supervisorAdapter(kind).identity(environment);
  const endpoint = resolveDaemonEndpoint({
    configuredUrl: null,
    recordedPort: daemon.port,
    fallbackPort: DEFAULT_PORT,
  });
  const port = endpoint.ok ? endpoint.port : DEFAULT_PORT;
  const url = endpoint.ok ? endpoint.url : `http://127.0.0.1:${String(port)}`;
  const tokenPath = daemon.token_file ?? resolveTokenPath(request.stateDir, env);

  return {
    target: { kind, identity, artefact: daemon.supervisor_artefact ?? "", uid },
    run,
    url,
    port,
    timeoutMs,
    identityLine: `${identity} (${kind})`,
    probeOnce: () => probe(url, readTokenQuietly(tokenPath)),
    waitFor: async (predicate) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (await predicate()) {
          return true;
        }
        if (Date.now() >= deadline) {
          return false;
        }
        await sleep(intervalMs);
      }
    },
  };
}

/** Ask the disabled query, or say why it was not asked. */
function askSwitch(target: RegistrationTarget | null, run: ProbeRunner): SwitchFact {
  if (target === null) {
    return {
      query: null,
      answered: false,
      state: "unregistered",
      raw: "",
      detail:
        "nothing is registered with a supervisor here, so there is no service to ask about being " +
        "switched off",
    };
  }
  const command = disabledQuery(target);
  const answer = run(command);
  const read = readSwitch(target.kind, target.identity, answer);
  return {
    query: spell(command),
    answered: answer.started,
    state: read.state,
    raw: read.raw,
    detail: describeSwitch(target, read.state, read.raw),
  };
}

/** What the switch's four values mean here, with the one command that changes each. */
function describeSwitch(target: RegistrationTarget, state: SupervisorSwitch, raw: string): string {
  switch (state) {
    case "on":
      return `${target.identity} is switched on (${JSON.stringify(raw)})`;
    case "off":
      return (
        `${target.identity} is switched off (${JSON.stringify(raw)}). ` +
        `Undo it with \`${spell(enableCommand(target))}\``
      );
    case "unregistered":
      return `${target.identity} is not registered with this machine's supervisor`;
    case "unknown":
      return `the supervisor did not say whether ${target.identity} is switched off: ${JSON.stringify(raw)}`;
  }
}

/** The one command that switches the service back on, named rather than described. */
function enableCommand(target: RegistrationTarget): ProbeCommand {
  switch (target.kind) {
    case "launchd":
      return { program: "launchctl", argv: ["enable", guiService(target)] };
    case "systemd":
      return { program: "systemctl", argv: ["--user", "enable", target.identity] };
    case "task-scheduler":
      return {
        program: POWERSHELL,
        argv: [...POWERSHELL_ARGV, `Enable-ScheduledTask -TaskName ${quote(target.identity)}`],
      };
  }
}

/** Ask the loaded-configuration query, or record that this platform has none. */
function askLoadedConfiguration(
  target: RegistrationTarget | null,
  run: ProbeRunner,
): LoadedConfigurationFact {
  if (target === null) {
    return {
      available: false,
      query: null,
      answered: false,
      output: "",
      identity: {
        available: false,
        answered: false,
        command: null,
        environment: null,
        cwd: null,
        detail: "nothing is registered here",
      },
      detail: "nothing is registered here, so there is no loaded configuration to read",
    };
  }
  const command = loadedConfigurationQuery(target);
  if (command === null) {
    const identity = readLoaded(target.kind, target.identity, {
      started: false,
      status: null,
      stdout: "",
      stderr: "",
    });
    return {
      available: false,
      query: null,
      answered: false,
      output: "",
      identity,
      detail:
        "launchd has no documented query for what it loaded — `launchctl print`'s own manual says " +
        '"This output is NOT API in any sense at all" — so on macOS the responding identity in ' +
        "`/healthz` is the detector instead (ADR 0025, §1.3b D7)",
    };
  }
  const answer = run(command);
  return {
    available: true,
    query: spell(command),
    answered: answer.started && answer.status === 0,
    output: answer.stdout.trim(),
    identity: readLoaded(target.kind, target.identity, answer),
    detail:
      answer.started && answer.status === 0
        ? `read from ${target.identity}`
        : `the query did not answer: ${firstLine(answer) || "it said nothing"}`,
  };
}

/** Which condition the facts add up to. Ordered as the classifier tries them. */
function classify(facts: {
  probe: StatusProbe;
  token: string | null;
  stalled: boolean;
  switchedOff: boolean;
  toolchainComplete: boolean;
  recordedPort: number | null;
  runtimePresent: boolean;
}): DaemonStatusCondition {
  if (facts.probe.kind === "ok") {
    return facts.toolchainComplete ? "ready" : "degraded";
  }
  // `stalled` before `disabled` for the reason `commands/status.ts` puts it first: it is a latch
  // this daemon wrote about itself, and the two conditions' remedies compose — `daemon restart`
  // clears the latch whether or not the service is also switched off, and the switched-off sentence
  // is reported alongside it either way.
  if (facts.stalled) {
    return "stalled";
  }
  if (facts.switchedOff) {
    return "disabled";
  }
  if (facts.probe.kind === "unauthenticated") {
    return facts.token === null ? "token_absent" : "unauthorized";
  }
  if (facts.probe.kind === "http") {
    return "unhealthy";
  }
  return facts.recordedPort === null && !facts.runtimePresent ? "absent" : "unreachable";
}

/** Whether this daemon comes back with nobody logged in, and by what mechanism. */
function bootPersistence(
  kind: SupervisorKind | null,
  preflight: InstallPreflight,
  daemon: DaemonState,
): BootPersistenceFact {
  if (kind === null || daemon.supervisor_kind === null) {
    return {
      persistent: null,
      mechanism: "none — nothing is installed here",
      detail: "no supervisor holds this daemon, so nothing starts it but you",
    };
  }
  if (kind === "systemd") {
    return {
      persistent: preflight.linger.enabled,
      mechanism: `systemd user unit, boot-persistent through ${preflight.linger.marker}`,
      detail: preflight.linger.enabled
        ? `${preflight.linger.marker} exists, so this user's manager starts at boot and the unit ` +
          "with it"
        : `${preflight.linger.marker} does not exist, so this user's manager stops with their ` +
          `last session. \`sudo loginctl enable-linger ${preflight.linger.user}\` is the one ` +
          "command that changes it, and it needs an administrator once",
    };
  }
  if (kind === "launchd") {
    return {
      persistent: false,
      mechanism: "LaunchAgent in this user's GUI domain, started at login",
      detail:
        "a user agent runs only while that user is logged in; with no login session there is no " +
        "GUI domain to bootstrap into. This is a stated limitation of the macOS route, not a " +
        "fault, and `--system` is the announced-sudo escape for a headless Mac",
    };
  }
  return {
    persistent: false,
    mechanism: "Scheduled Task on a logon trigger",
    detail:
      "the task runs when this user logs on; a boot trigger needs an administrator, which is why " +
      "the shipped registration does not ask for one",
  };
}

/** The setup marker, in the words the degraded sentence is short for. */
function describeToolchain(preflight: InstallPreflight): string {
  if (preflight.toolchain.marker === null) {
    return `${preflight.toolchain.path} is missing or unreadable — \`xplainer setup\` writes it`;
  }
  if (preflight.toolchain.missing.length === 0) {
    return `${preflight.toolchain.path} is complete and every path it records still exists`;
  }
  return (
    `${preflight.toolchain.path} records ${String(preflight.toolchain.missing.length)} path(s) ` +
    `that are no longer there: ${preflight.toolchain.missing.join(", ")} — \`xplainer setup\` ` +
    "acquires them again"
  );
}

/** How many starts in a row failed before the daemon was ready, counting back from the newest. */
export function countTrailingFailures(starts: readonly DaemonStart[]): number {
  let count = 0;
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    if (starts[index]?.ready_at !== null) {
      break;
    }
    count += 1;
  }
  return count;
}

/**
 * One authenticated `GET /healthz`, in the four shapes that need different sentences.
 *
 * Over `node:http` and not the platform's `fetch`, for the reason {@link loopbackGet} records: a
 * status report is asked for repeatedly against one origin, `fetch` answers the second and later
 * asks on a pooled socket, and resuming a pooled socket the daemon has torn down raises
 * `setTypeOfService EINVAL` as an **uncaught exception** rather than a rejected promise — past the
 * `catch` below, and fatal to the whole process that was only asking how the daemon is.
 */
async function loopbackProbe(url: string, token: string | null): Promise<StatusProbe> {
  try {
    const response = await loopbackGet({
      url: `${url}/healthz`,
      token,
      timeoutMs: STATUS_PROBE_TIMEOUT_MS,
    });
    if (response.status === 401) {
      return { kind: "unauthenticated" };
    }
    if (response.status < 200 || response.status > 299) {
      return { kind: "http", status: response.status };
    }
    return { kind: "ok", body: JSON.parse(response.body) as HealthBody };
  } catch (error) {
    return { kind: "unreachable", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The status the probe saw, or `null` when nothing answered at all. */
function probeHttpStatus(result: StatusProbe): number | null {
  if (result.kind === "ok") {
    return 200;
  }
  if (result.kind === "unauthenticated") {
    return 401;
  }
  return result.kind === "http" ? result.status : null;
}

/**
 * Run each distinct command once for the life of one call.
 *
 * `daemon status` asks `launchctl print-disabled gui/<uid>` twice — the preflight asks it to find
 * out whether a GUI domain exists at all, and {@link askSwitch} asks it about our label — and they
 * are the same subprocess with the same answer. Memoising the runner is what makes reusing the
 * preflight cost one process rather than two, without either caller knowing about the other.
 */
function memoiseProbes(run: ProbeRunner): ProbeRunner {
  const answers = new Map<string, ProbeResult>();
  return (command) => {
    const key = spell(command);
    const seen = answers.get(key);
    if (seen !== undefined) {
      return seen;
    }
    const answer = run(command);
    answers.set(key, answer);
    return answer;
  };
}

/** Read the token file for the probe. A missing one is a fact to report, not a failure to raise. */
function readTokenQuietly(path: string): string | null {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

/** The adapter's own name for the daemon, or `null` on an environment it cannot compose one from. */
function adapterIdentity(kind: SupervisorKind, environment: SupervisorEnvironment): string | null {
  try {
    return supervisorAdapter(kind).identity(environment);
  } catch {
    return null;
  }
}

/** One command, as one line. */
function spell(command: ProbeCommand): string {
  return `${command.program} ${command.argv.join(" ")}`;
}

/** The first non-empty line either stream produced. */
function firstLine(answer: ProbeResult): string {
  for (const stream of [answer.stderr, answer.stdout]) {
    for (const line of stream.split("\n")) {
      if (line.trim() !== "") {
        return line.trim();
      }
    }
  }
  return "";
}

function reportedString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** A PowerShell single-quoted literal. The one character to handle is the quote, doubled. */
function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}
