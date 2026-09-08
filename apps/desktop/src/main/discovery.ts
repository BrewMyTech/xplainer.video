/**
 * Where this machine's daemon is, in seven answers — and which program the app asks.
 *
 * The app is a **discovery-first client**: it asks before it starts anything, and it spawns a
 * daemon of its own only when nothing is answering (plan §1.4). This module is that ask. It shells
 * out to the CLI's own `status --json` rather than reimplementing any of it, for one reason that
 * decides the whole design: resolving a state directory is `--state-dir` → `XPLAINER_STATE_DIR` →
 * a per-platform default, resolving a port is a configured URL → `daemon.json` → `8787`, and a
 * second implementation of either in this app would be a second implementation that can disagree
 * with the daemon about which machine it is describing.
 *
 * **Which program it shells out to is decision D10, and it has two stages.**
 *
 *   * **Before `install` has run** — `<resources>/xplainer-runtime/bin/node` with the packaged
 *     payload's own `bin.js`. It is always there, because T22 ships the payload as
 *     `extraResources`, so a clean machine can be asked about at all.
 *   * **After `install` has written it** — `<state>/bin/xplainer[.cmd]`, the stable launcher, which
 *     is the one name that survives a daemon update.
 *
 * **And `status --json` is what reports the change.** The state directory in this app is never
 * derived, guessed or defaulted: it arrives in {@link DaemonReport.stateDir}, from the command the
 * payload just ran, and the launcher is looked for in the `bin/` beside it. `daemon install` is the
 * only thing that writes that file, so its presence at the reported path is the report's own
 * account of an install having happened. Routing the *first* call through the launcher instead —
 * which earlier rounds of the plan did — would have made this app depend on a file that
 * `daemon install` creates: unreachable on a clean machine, and permanently unreachable for the
 * user with no supported supervisor, who never installs and whose product is the spawned daemon.
 *
 * **Two commands, because there are two deployments.** For this machine's daemon the question is
 * `xplainer daemon status --json`, which also asks the supervisor whether the service is switched
 * off — the only observable that distinguishes `disabled` from `absent`, since a user turning the
 * service off in Login Items & Extensions changes supervisor state and touches no file of ours.
 * For a daemon somebody else is running the question is `xplainer status --url <origin> --json`,
 * because no supervisor query on this machine says anything about another one, and it is the only
 * form that accepts a URL. Both write the same closed set of condition codes, and
 * {@link classify} maps that set — never prose — onto the seven outcomes below.
 *
 * **What this module does not do.** It holds no token: `bridge.ts` does, and this module reports
 * only the *path* the daemon recorded (R-SEC-6). It makes no HTTP request of its own — the
 * authenticated `/healthz` probe every outcome rests on is the one the CLI made, with the token it
 * read from that file.
 */

import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import process from "node:process";
import { isContractCompatible, MCP_CONTRACT_VERSION } from "@xplainer/protocol";
import { resolveDaemonUrl } from "./daemon";
import {
  currentHost,
  type PayloadHost,
  PayloadRefusal,
  resolvePayloadCommand,
  runProgram,
  startProgram,
} from "./spawn";

/**
 * The subdirectory of the state directory the stable launcher lives in.
 *
 * Must equal `LAUNCHER_DIR` in `apps/cli/src/install/launcher.ts`, and the file's own name must
 * equal `CLI_BIN_NAME` there. Both are duplicated rather than imported for the reason
 * `RUNTIME_MANIFEST_FILE` is duplicated in `paths.ts`: this app decides **which program to run**,
 * and that decision must not be taken by importing from the copy of the CLI inside `app.asar`.
 */
const LAUNCHER_DIR = "bin";

/** The launcher's name, without the Windows extension. `CLI_BIN_NAME` in the launch contract. */
const LAUNCHER_NAME = "xplainer";

/** The command asked about a daemon on this machine. */
export const DAEMON_STATUS_ARGV: readonly string[] = ["daemon", "status", "--json"];

/** The command asked about a daemon somebody else is running. `--url` takes the origin. */
export const REMOTE_STATUS_ARGV: readonly string[] = ["status", "--json", "--url"];

/** The highest `schema_version` this build knows how to read. */
export const SUPPORTED_REPORT_VERSION = 1;

/** How long a discovery command is given before it is killed. */
export const DISCOVERY_TIMEOUT_MS = 20_000;

/** How long a spawned daemon is given to print its ready line. */
export const READY_TIMEOUT_MS = 30_000;

/** How long a spawned daemon is given to drain after `SIGTERM` before it is killed. */
export const STOP_TIMEOUT_MS = 25_000;

/** The exit code a `serve` uses when something else already owns the state directory or the port. */
export const OWNERSHIP_REFUSED_EXIT_CODE = 10;

/** Why the app could not ask at all. Every value is a condition, never a stack trace. */
export type DiscoveryRefusalReason =
  /** The packaged payload is missing or unusable — `spawn.ts` said so, and by name. */
  | "payload-unavailable"
  /** The program ran and wrote something that is not one JSON object. */
  | "report-unreadable"
  /** The report is a document a newer build writes; nothing here may guess at its meaning. */
  | "report-too-new"
  /** The program could not be started, or was killed before it answered. */
  | "command-failed";

/**
 * The app could not find out where the daemon is — which is not the same as there not being one.
 *
 * Named for the same reason {@link PayloadRefusal} is: every one of these has a different next
 * step, and a caller that received a bare `Error` would have to read a sentence to tell an
 * unpacked development build from a daemon speaking a contract this app is too old for.
 */
export class DiscoveryRefusal extends Error {
  readonly reason: DiscoveryRefusalReason;

  constructor(reason: DiscoveryRefusalReason, message: string) {
    super(message);
    this.name = "DiscoveryRefusal";
    this.reason = reason;
  }
}

/** Which of D10's two stages resolved, and what it runs. */
export type CliProgram = {
  /** `payload` before an install, `launcher` after one. */
  kind: "payload" | "launcher";
  /** The executable spawned. Never a `PATH` lookup, and never a bare `xplainer`. */
  executable: string;
  /** What goes in front of every argv — the payload's entry, or nothing for the launcher. */
  leadingArgs: readonly string[];
  /** The working directory the command runs in. */
  cwd: string;
};

/** `<state>/bin/xplainer`, or `<state>/bin/xplainer.cmd` on Windows. */
export function launcherPath(
  stateDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const paths = platform === "win32" ? win32 : posix;
  const name = platform === "win32" ? `${LAUNCHER_NAME}.cmd` : LAUNCHER_NAME;
  return paths.join(stateDir, LAUNCHER_DIR, name);
}

/** What {@link resolveCliProgram} needs to decide between D10's two stages. */
export type ProgramRequest = {
  /** Electron's own `process.resourcesPath`. */
  resourcesPath: string;
  /**
   * The state directory `status --json` last reported, or nothing on the first ask.
   *
   * Never resolved here. The app has no business knowing what `XPLAINER_STATE_DIR` is set to or
   * what this platform's default is; it knows what the CLI answered.
   */
  stateDir?: string | null | undefined;
  host?: PayloadHost | undefined;
};

/**
 * Resolve the program the next command runs as, by D10's rule.
 *
 * @throws DiscoveryRefusal `payload-unavailable` when there is no launcher **and** no usable
 *   payload — a development run out of a checkout, or a packaged build whose payload was assembled
 *   for another architecture. The payload's own named refusal travels in the message.
 */
export function resolveCliProgram(request: ProgramRequest): CliProgram {
  const host = request.host ?? currentHost();
  const stateDir = request.stateDir ?? null;
  if (stateDir !== null) {
    const launcher = launcherPath(stateDir, host.platform);
    if (existsSync(launcher)) {
      // The launcher carries the interpreter and the entry inside itself, which is the whole point
      // of it: it is the one name that keeps working across an update that moves the runtime
      // directory out from under a version-scoped path.
      return { kind: "launcher", executable: launcher, leadingArgs: [], cwd: stateDir };
    }
  }
  try {
    const command = resolvePayloadCommand(request.resourcesPath, host);
    return {
      kind: "payload",
      executable: command.executable,
      leadingArgs: [command.entry],
      cwd: command.root,
    };
  } catch (error) {
    if (error instanceof PayloadRefusal) {
      throw new DiscoveryRefusal(
        "payload-unavailable",
        `this app cannot run its own CLI: ${error.message}`,
      );
    }
    throw error;
  }
}

/** What {@link runCli} may be told beyond the program and its arguments. */
export type RunCliOptions = {
  env?: NodeJS.ProcessEnv | undefined;
  timeoutMs?: number | undefined;
};

/** One CLI command, run through whichever of D10's two stages {@link resolveCliProgram} chose. */
export async function runCli(
  program: CliProgram,
  args: readonly string[],
  options: RunCliOptions = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const run = await runProgram(program.executable, [...program.leadingArgs, ...args], {
    cwd: program.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    timeoutMs: options.timeoutMs ?? DISCOVERY_TIMEOUT_MS,
  });
  return { code: run.code, stdout: run.stdout, stderr: run.stderr };
}

/**
 * What the supervisor says about whether the service may run at all.
 *
 * The CLI's `SupervisorSwitch`, carried through unchanged: `off` is the only value that means
 * switched off, and `unknown` — a query that did not answer — must never be reported as one.
 */
export type SupervisorSwitchState = "on" | "off" | "unregistered" | "unknown";

/** The `status --json` document, read down to the facts the seven outcomes rest on. */
export type DaemonReport = {
  /** The document's own version, refused above {@link SUPPORTED_REPORT_VERSION}. */
  schemaVersion: number;
  /** The CLI's condition code, from its own closed set. Carried verbatim for the screens. */
  condition: string;
  /** The code the command exited with, as the document itself records it. */
  exitCode: number;
  /** Where the CLI looked. The only place this app learns a state directory from. */
  stateDir: string;
  /** The port `daemon.json` records, or `null` where no run has bound here. */
  recordedPort: number | null;
  /** The file holding the bearer token — a path, never the token itself (R-SEC-6). */
  tokenFile: string | null;
  /** Whether an install registered this daemon with a supervisor. */
  registered: boolean;
  /** What the CLI probed, and what came back. */
  probe: {
    url: string;
    port: number;
    httpStatus: number | null;
    error: string | null;
    /** The pid holding the port, when something does and a tool on this machine would name it. */
    holderPid: number | null;
    holderDetail: string | null;
  };
  /** `/healthz`'s body, present only for a `200`. */
  health: {
    /** `ok`, or `degraded` — which is the `200`-with-a-reason the outcome table names. */
    status: string | null;
    version: string | null;
    contractVersion: string | null;
  } | null;
  /** The name the supervisor addresses this daemon by — the label, unit or task the CLI derived. */
  supervisorIdentity: string | null;
  /** The supervisor's answer to the disabled-by-user-or-policy query. */
  switchState: SupervisorSwitchState;
  /** The command that produced {@link DaemonReport.switchState}, or `null` where none was asked. */
  switchQuery: string | null;
  /** The supervisor's own words about the switch, for the sentence a user is shown. */
  switchDetail: string | null;
  /** The pid `runtime.json` records for the last run that bound, or `null`. */
  runtimePid: number | null;
  /** The sentences the CLI is entitled to say about this machine, in its order. */
  sentences: readonly string[];
  /** What the CLI says about the render toolchain, or `null` from the command that has no opinion. */
  toolchainDetail: string | null;
};

/**
 * Every answer discovery can give, and the whole set a caller has to handle.
 *
 * | Outcome | Observable |
 * |---|---|
 * | `ready` | authenticated `GET /healthz` answered `200` |
 * | `degraded` | `200` with a reason — the daemon is up and cannot render |
 * | `incompatible` | its `contract_version` fails `isContractCompatible` against this app's |
 * | `unauthorized` | `401` — something is on our port that is not our daemon |
 * | `occupied` | the port is held and `status` names a foreign pid (exit `10`'s condition) |
 * | `disabled` | the supervisor query says the service is switched off |
 * | `absent` | nothing answered, and nothing above identified why |
 */
export const DISCOVERY_OUTCOMES = [
  "ready",
  "degraded",
  "incompatible",
  "unauthorized",
  "occupied",
  "disabled",
  "absent",
] as const;

/** One of {@link DISCOVERY_OUTCOMES}. */
export type DiscoveryOutcome = (typeof DISCOVERY_OUTCOMES)[number];

/**
 * The one thing a user can do about each outcome.
 *
 * A sentence per outcome, held here rather than in a renderer, because the outcome and its remedy
 * are one decision: an outcome that arrived at a screen with no defined action would be a screen
 * inventing one.
 */
export const OUTCOME_ACTIONS: Readonly<Record<DiscoveryOutcome, string>> = {
  ready: "Nothing to do — the daemon is running and answering.",
  degraded:
    "The daemon is running and cannot render yet. Run setup to acquire the render toolchain.",
  incompatible:
    "This app and that daemon speak different contract versions. Update whichever is older; " +
    "nothing else will make them talk.",
  unauthorized:
    "Something is listening on this daemon's port that will not accept its token. Stop it, or " +
    "point this app at another daemon.",
  occupied:
    "Another process holds this daemon's port, so starting one here would refuse with exit 10. " +
    "Stop that process, or attach to the daemon that is already running.",
  disabled:
    "The service is switched off. Switch it back on with the command the report names, or start " +
    "the daemon from this app.",
  absent: "No daemon is answering here. Start one from this app, or install it to start at login.",
};

/**
 * The two conditions whose remedy the outcome alone does not carry.
 *
 * Both land on `absent` — nothing is answering and nothing above identified why — and both would
 * otherwise be offered "start one", which is exactly what a user must not be told here: a `serve`
 * started while the breaker is latched exits `0` without binding, and a daemon that is installed
 * and stopped is the supervisor's to start rather than this app's to duplicate. The outcome set
 * stays the seven; what changes is the sentence beside it.
 */
const CONDITION_ACTIONS: Readonly<Record<string, string>> = {
  stalled:
    "The daemon stopped after repeated failed starts, and no supervisor will try again until the " +
    "latch is cleared. `xplainer daemon restart` clears it.",
  unreachable:
    "A daemon is installed here and is not running. Start it — from this app, or with " +
    "`xplainer daemon start`.",
};

/** Where the daemon is, what it is doing, and what the app may do next. */
export type Discovery = {
  outcome: DiscoveryOutcome;
  /** The one thing a user can do about it — {@link OUTCOME_ACTIONS}. */
  action: string;
  /** Why this outcome, in the CLI's own words where it had any. */
  detail: string;
  /**
   * The origin the app talks to, from {@link resolveDaemonUrl}'s unchanged precedence:
   * configured remote URL → recorded port → `DEFAULT_DAEMON_PORT`.
   */
  url: string;
  /** The token file the daemon recorded, which is what `bridge.ts` reads. Never the token. */
  tokenFile: string | null;
  /** The state directory the report named. Feed it back in as {@link ProgramRequest.stateDir}. */
  stateDir: string;
  /** Which of D10's two stages answered this question. */
  program: CliProgram;
  /** Everything the CLI reported, for the screens that show more than an outcome. */
  report: DaemonReport;
};

/** What {@link discover} needs. Every fact about the outside world is a parameter. */
export type DiscoverOptions = {
  /** Electron's own `process.resourcesPath`. */
  resourcesPath: string;
  /** The state directory the last report named, so an installed machine uses its launcher. */
  stateDir?: string | null | undefined;
  /** A daemon somebody else is running. Wins over the recorded port, as it does in the CLI. */
  remoteUrl?: string | null | undefined;
  /** This app's own contract version. Defaults to the one it was built against. */
  contractVersion?: string | undefined;
  host?: PayloadHost | undefined;
  /** The environment the CLI child runs with. Defaults to this process's. */
  env?: NodeJS.ProcessEnv | undefined;
  timeoutMs?: number | undefined;
};

/**
 * Ask where the daemon is, and answer with one of seven outcomes.
 *
 * @throws DiscoveryRefusal when the app could not ask at all — see {@link DiscoveryRefusalReason}.
 *   Every other condition, including "there is no daemon", is a value.
 */
export async function discover(options: DiscoverOptions): Promise<Discovery> {
  const remoteUrl = options.remoteUrl?.trim() ?? "";
  const program = resolveCliProgram({
    resourcesPath: options.resourcesPath,
    stateDir: options.stateDir ?? null,
    ...(options.host === undefined ? {} : { host: options.host }),
  });
  const argv = remoteUrl.length > 0 ? [...REMOTE_STATUS_ARGV, remoteUrl] : [...DAEMON_STATUS_ARGV];

  let run: { code: number | null; stdout: string; stderr: string };
  try {
    run = await runCli(program, argv, {
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  } catch (error) {
    throw new DiscoveryRefusal(
      "command-failed",
      `${program.executable} would not run: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (run.stdout.trim() === "") {
    // A refusal that happens *before* a report can exist — an unreadable state file, a `--url`
    // that is not an endpoint — writes a sentence to stderr and nothing to stdout, and that
    // sentence is the only thing worth showing.
    throw new DiscoveryRefusal(
      "command-failed",
      `\`${describeCommand(program, argv)}\` exited ${String(run.code)} without writing a report: ` +
        `${firstLine(run.stderr)}`,
    );
  }

  const report = parseDaemonReport(run.stdout, describeCommand(program, argv));
  const classified = classify(report, options.contractVersion ?? MCP_CONTRACT_VERSION);
  return {
    outcome: classified.outcome,
    action: actionFor(classified.outcome, report),
    detail: classified.detail,
    url: resolveDaemonUrl({
      ...(remoteUrl.length > 0 ? { remoteUrl } : {}),
      ...(report.recordedPort === null ? {} : { port: report.recordedPort }),
    }),
    tokenFile: report.tokenFile,
    stateDir: report.stateDir,
    program,
    report,
  };
}

/**
 * The one thing a user can do about this answer.
 *
 * The outcome's own sentence, unless the report named a condition whose remedy is a different
 * command — see {@link CONDITION_ACTIONS}.
 */
function actionFor(outcome: DiscoveryOutcome, report: DaemonReport): string {
  if (outcome === "absent") {
    const specific = conditionAction(report);
    if (specific !== null) {
      return specific;
    }
  }
  return OUTCOME_ACTIONS[outcome];
}

/**
 * The remedy this report's condition carries, when it has one the outcome does not.
 *
 * `unreachable` from a machine that never registered anything is not "a daemon is installed and
 * stopped" — it is the ordinary "nothing is there", so it keeps the outcome's own sentence.
 */
function conditionAction(report: DaemonReport): string | null {
  const specific = CONDITION_ACTIONS[report.condition];
  if (specific === undefined) {
    return null;
  }
  return report.condition !== "unreachable" || report.registered ? specific : null;
}

/**
 * Whether this app may start a daemon of its own in answer to this discovery.
 *
 * **`absent` is not by itself permission to spawn.** It means "nothing answered and nothing above
 * identified why", and two conditions land on it that a `serve` of this app's own cannot repair —
 * the same two {@link CONDITION_ACTIONS} names, and for the same reason:
 *
 * - `stalled` — the breaker is latched, so a `serve` started now exits `0` **without binding**.
 *   Spawning would produce no daemon, no error a window could show, and a second discovery that
 *   says exactly what the first one said.
 * - `unreachable` on a machine that registered one — a daemon is installed and stopped, which is
 *   its supervisor's to start. A duplicate over the same state directory is the exit `10` the
 *   spawn-to-install handoff exists to avoid, and the user would be told this app failed when the
 *   truth is that the service is switched off or was never started.
 *
 * This is the same decision as the sentence beside the outcome: an answer whose remedy is a command
 * the user runs is not an answer this app acts on by itself.
 */
export function mayStartDaemon(discovery: Discovery): boolean {
  return discovery.outcome === "absent" && conditionAction(discovery.report) === null;
}

/**
 * Which outcome the report's facts add up to.
 *
 * Deliberately not exported, and for the reason `commands/status.ts` gives about its own
 * classifier: a mapping a test could reach directly is a mapping a test could agree with while
 * `discover` did something else. Every branch below is asserted against a real daemon driven into
 * that state in `discovery.test.ts`.
 *
 * The order is the order of certainty. An answered `200` settles everything about liveness, so the
 * three answers that need a body come first; a `401` is the next most specific; a foreign process
 * on the port comes before the supervisor's switch, because re-enabling a service that cannot bind
 * would send a user round a loop; and `absent` is what is left when nothing has been identified.
 */
function classify(
  report: DaemonReport,
  contractVersion: string,
): { outcome: DiscoveryOutcome; detail: string } {
  if (report.probe.httpStatus === 200) {
    const advertised = report.health?.contractVersion ?? null;
    if (advertised === null || !isContractCompatible(advertised, contractVersion)) {
      return {
        outcome: "incompatible",
        detail:
          `the daemon at ${report.probe.url} advertises contract ` +
          `${advertised === null ? "nothing" : advertised} and this app speaks ${contractVersion}.`,
      };
    }
    // `200` with a reason is the degraded case: the daemon is up, holding the queue, and something
    // only `xplainer setup` can supply is missing. Both halves of the CLI say so — `/healthz`'s own
    // `status` field and the condition code — and either is enough.
    if (report.health?.status !== "ok" || report.condition === "degraded") {
      return {
        outcome: "degraded",
        detail:
          report.toolchainDetail ??
          report.sentences[0] ??
          `the daemon at ${report.probe.url} answered 200 and reported itself degraded.`,
      };
    }
    return {
      outcome: "ready",
      detail: `the daemon at ${report.probe.url} answered an authenticated /healthz with 200.`,
    };
  }

  if (report.probe.httpStatus === 401) {
    return {
      outcome: "unauthorized",
      detail:
        report.condition === "token_absent"
          ? `something is listening at ${report.probe.url} and this machine has no token to ` +
            `present: ${report.tokenFile ?? "the token file"} is absent or empty.`
          : `something at ${report.probe.url} refused the token in ` +
            `${report.tokenFile ?? "this machine's token file"} with 401, so it is not this ` +
            "daemon.",
    };
  }

  // Nothing answered. The port being held by a process that is not the daemon we were probing for
  // is exit 10's condition, and it is the difference between "start one" and "you cannot".
  if (
    report.probe.holderPid !== null &&
    (report.runtimePid === null || report.probe.holderPid !== report.runtimePid)
  ) {
    return {
      outcome: "occupied",
      detail:
        `port ${String(report.probe.port)} is held ` +
        `${report.probe.holderDetail ?? `by pid ${String(report.probe.holderPid)}`}, and it is ` +
        "not answering as this daemon.",
    };
  }

  if (report.switchState === "off") {
    return {
      outcome: "disabled",
      detail:
        report.switchDetail ??
        `${report.switchQuery ?? "the supervisor"} says this service is switched off.`,
    };
  }

  return {
    outcome: "absent",
    detail:
      report.sentences[0] ??
      (report.registered
        ? `nothing is answering at ${report.probe.url}, and the daemon registered here is not ` +
          `running: ${report.probe.error ?? "no answer"}.`
        : `nothing is answering at ${report.probe.url} and no daemon is installed here.`),
  };
}

/**
 * Read one `status --json` document into {@link DaemonReport}.
 *
 * Every field is checked rather than cast: this is a document that arrived from a child process's
 * stdout, and the two commands that write it carry different halves — `daemon status` asks the
 * supervisor and reads the toolchain marker, `status --url` does neither — so the fields only one
 * of them has are absences to record rather than shapes to demand.
 *
 * @throws DiscoveryRefusal `report-unreadable` or `report-too-new`.
 */
export function parseDaemonReport(stdout: string, command: string): DaemonReport {
  let document: unknown;
  try {
    document = JSON.parse(lastLine(stdout));
  } catch (error) {
    throw new DiscoveryRefusal(
      "report-unreadable",
      `\`${command}\` did not write one JSON object: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const record = asRecord(document);
  if (record === null) {
    throw new DiscoveryRefusal(
      "report-unreadable",
      `\`${command}\` wrote a document, not a report.`,
    );
  }
  const schemaVersion = record.schema_version;
  if (typeof schemaVersion !== "number") {
    throw new DiscoveryRefusal(
      "report-unreadable",
      `\`${command}\` wrote a report with no numeric schema_version.`,
    );
  }
  if (schemaVersion > SUPPORTED_REPORT_VERSION) {
    throw new DiscoveryRefusal(
      "report-too-new",
      `\`${command}\` writes schema_version ${String(schemaVersion)} and this app reads ` +
        `${String(SUPPORTED_REPORT_VERSION)}. The CLI beside this app is newer than the app; ` +
        "nothing here may guess at what it means.",
    );
  }
  const condition = record.condition;
  const stateDir = record.state_dir;
  if (typeof condition !== "string" || typeof stateDir !== "string") {
    throw new DiscoveryRefusal(
      "report-unreadable",
      `\`${command}\` wrote a report with no condition or no state directory.`,
    );
  }

  const daemon = asRecord(record.daemon) ?? {};
  const probe = asRecord(record.probe) ?? {};
  const health = asRecord(record.health);
  const supervisor = asRecord(record.supervisor);
  const supervisorSwitch = supervisor === null ? null : asRecord(supervisor.switch);
  const runtime = asRecord(record.runtime);
  const toolchain = asRecord(record.toolchain);

  return {
    schemaVersion,
    condition,
    exitCode: typeof record.exit_code === "number" ? record.exit_code : 0,
    stateDir,
    recordedPort: asNumber(daemon.port),
    tokenFile: asString(daemon.token_file),
    registered: asString(daemon.supervisor_kind) !== null,
    probe: {
      url: asString(probe.url) ?? "",
      port: asNumber(probe.port) ?? 0,
      httpStatus: asNumber(probe.http_status),
      error: asString(probe.error),
      holderPid: asNumber(probe.holder_pid),
      holderDetail: asString(probe.holder_detail),
    },
    health:
      health === null
        ? null
        : {
            status: asString(health.status),
            version: asString(health.version),
            contractVersion: asString(health.contract_version),
          },
    supervisorIdentity: supervisor === null ? null : asString(supervisor.identity),
    switchState: asSwitchState(supervisorSwitch?.state),
    switchQuery: supervisorSwitch === null ? null : asString(supervisorSwitch.query),
    switchDetail: supervisorSwitch === null ? null : asString(supervisorSwitch.detail),
    runtimePid: runtime === null ? null : asNumber(runtime.pid),
    sentences: asSentences(record.sentences),
    toolchainDetail: toolchain === null ? null : asString(toolchain.detail),
  };
}

// ── The spawned daemon ───────────────────────────────────────────────────────────────────────

/** A daemon this app started, and everything a caller may do with it. */
export type SpawnedDaemon = {
  /** The child's pid, or `undefined` if it never started. */
  readonly pid: number | undefined;
  /** The port it bound, from its own ready line. */
  readonly port: number;
  /** The IPC socket it bound, from the same line. */
  readonly socket: string | null;
  /** The contract version it announced. */
  readonly contractVersion: string;
  /** Resolves when the child is gone, however it went. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /**
   * Stop it and wait for it to be gone.
   *
   * This is the **spawn-to-install handoff** and the **app-exit rule**, and they are one call
   * because they are one requirement: a daemon this app spawned is supervised by nothing else, so
   * it must not outlive the app that started it, and it must be gone *before* an installed one
   * starts. Two daemons over one state directory is not a race this app is allowed to enter — the
   * second would refuse with exit 10 having written nothing, and the user would be told the
   * install failed when it was this app that was in the way.
   */
  stop(timeoutMs?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

/** What starting a daemon of our own produced. */
export type SpawnDaemonResult =
  /** It bound, and announced itself. */
  | { kind: "spawned"; daemon: SpawnedDaemon }
  /**
   * Exit `10`: something already owns the state directory or the port, and it wrote nothing.
   *
   * This is **reattachment**, not a failure. A daemon is already there — an installed one that
   * started first, or one from an earlier run of this app — so the app asks again rather than
   * trying to start a second, and the discovery it then gets is the one that matters.
   */
  | { kind: "reattach"; exitCode: number; message: string }
  /** It exited for any other reason, or never printed a ready line inside the budget. */
  | { kind: "refused"; exitCode: number | null; message: string };

/** What {@link spawnDaemon} needs. */
export type SpawnDaemonOptions = {
  program: CliProgram;
  /** Extra arguments after `serve` — the app passes none, so the daemon uses its own precedence. */
  args?: readonly string[] | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** How long to wait for the ready line. */
  readyTimeoutMs?: number | undefined;
};

/**
 * Start a daemon of this app's own, and wait for it to say it is listening.
 *
 * The app spawns only when discovery answered `absent` — never over an `occupied` port, and never
 * beside a daemon that is already answering. `serve` prints one JSON ready line on stdout when its
 * listeners are bound, and that line, not a sleep and not a port scan, is what this waits for.
 */
export function spawnDaemon(options: SpawnDaemonOptions): Promise<SpawnDaemonResult> {
  const { program } = options;
  const argv = [...program.leadingArgs, "serve", ...(options.args ?? [])];
  return new Promise((resolve) => {
    const child = startProgram(program.executable, argv, {
      cwd: program.cwd,
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
      child.on("close", (code, signal) => {
        exit = { code, signal };
        done(exit);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(
            code === OWNERSHIP_REFUSED_EXIT_CODE
              ? {
                  kind: "reattach",
                  exitCode: code,
                  message:
                    "another daemon already owns this machine's state directory or port, so this " +
                    `app started none: ${firstLine(stderr) || firstLine(stdout)}`,
                }
              : {
                  kind: "refused",
                  exitCode: code,
                  message: `\`serve\` exited ${String(code)}: ${firstLine(stderr) || firstLine(stdout)}`,
                },
          );
        }
      });
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        resolve({
          kind: "refused",
          exitCode: null,
          message: `\`serve\` did not announce itself within ${String(
            options.readyTimeoutMs ?? READY_TIMEOUT_MS,
          )} ms and was killed: ${firstLine(stderr)}`,
        });
      }
    }, options.readyTimeoutMs ?? READY_TIMEOUT_MS);
    timer.unref();

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (settled) {
        return;
      }
      const ready = readReadyLine(stdout);
      if (ready !== null) {
        settled = true;
        clearTimeout(timer);
        resolve({
          kind: "spawned",
          daemon: {
            pid: child.pid,
            port: ready.port,
            socket: ready.socket,
            contractVersion: ready.contractVersion,
            exited,
            stop: (timeoutMs?: number) =>
              stopChild(child, exited, () => exit, timeoutMs ?? STOP_TIMEOUT_MS),
          },
        });
      }
    });

    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ kind: "refused", exitCode: null, message: error.message });
      }
    });
  });
}

/**
 * The three steps an install has to happen between, in the order it has to happen in.
 *
 * Injected rather than imported for one reason: `controls.ts` — which owns `daemon install` — is
 * built on this module, so the orchestration cannot reach back for it without a cycle. What is
 * left here is the *order*, which is the part that is a rule rather than an Electron call.
 */
export type InstallHandoff<T> = {
  /** Stop the daemon this app spawned, if it started one — {@link SpawnedDaemon.stop}. */
  stopSpawned: () => Promise<void>;
  /** Run `daemon install`. Its answer is {@link handOffToInstall}'s answer. */
  install: () => Promise<T>;
  /** Ask again, so the app points at the daemon the install started rather than the one that went. */
  rediscover: () => Promise<void>;
};

/**
 * Install the daemon, having first got this app's own out of the way.
 *
 * **This is the spawn-to-install handoff**, and it is a rule about ordering rather than a
 * convenience. A daemon this app spawned binds `serve`'s default port, which is `8787` — the same
 * port `daemon install` records and probes before it writes anything. Installing beside it means
 * the installer finds that port held, refuses with exit `7`, and reports a port conflict that this
 * app is itself the whole of: the user is told the install failed by the process that made it fail.
 * The same collision over the state directory is exit `10`. So the spawned daemon is stopped and
 * *waited for* first, and the discovery afterwards is what repoints the app at the installed one —
 * on its own port, under its own supervisor, with its own token file.
 */
export async function handOffToInstall<T>(handoff: InstallHandoff<T>): Promise<T> {
  await handoff.stopSpawned();
  const installed = await handoff.install();
  await handoff.rediscover();
  return installed;
}

/** The ready line's fields, or `null` while the daemon has not written one. */
function readReadyLine(
  stdout: string,
): { port: number; socket: string | null; contractVersion: string } | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || !trimmed.startsWith("{")) {
      continue;
    }
    let document: unknown;
    try {
      document = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = asRecord(document);
    if (record === null || record.event !== "ready") {
      continue;
    }
    const port = asNumber(record.port);
    if (port === null) {
      continue;
    }
    return {
      port,
      socket: asString(record.socket),
      contractVersion: asString(record.contract_version) ?? "",
    };
  }
  return null;
}

/**
 * Ask the child to drain, and kill it if it will not.
 *
 * `SIGTERM` is the daemon's own drain signal on POSIX and it is given the whole budget ADR 0024
 * allows a drain, because a job in flight is a user's work. Windows has no `SIGTERM` to send: the
 * `kill()` there is a termination, which is the platform and not a choice — the graceful route on
 * Windows is the drain over the named pipe, which is the CLI's own and not this app's.
 */
function stopChild(
  child: { kill(signal?: NodeJS.Signals): boolean },
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  read: () => { code: number | null; signal: NodeJS.Signals | null } | null,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const already = read();
  if (already !== null) {
    return Promise.resolve(already);
  }
  child.kill("SIGTERM");
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
    void exited.then((outcome) => {
      clearTimeout(timer);
      resolve(outcome);
    });
  });
}

// ── Reading values that arrived from another process ─────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asSwitchState(value: unknown): SupervisorSwitchState {
  return value === "on" || value === "off" || value === "unregistered" ? value : "unknown";
}

function asSentences(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const sentences: string[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const text = record === null ? null : asString(record.text);
    if (text !== null) {
      sentences.push(text);
    }
  }
  return sentences;
}

/** The last non-empty line, which is the report: the CLI writes prose to stderr, never to stdout. */
function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines[lines.length - 1] ?? "";
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  );
}

/** The command as it was run, for a message that names what failed rather than describing it. */
function describeCommand(program: CliProgram, args: readonly string[]): string {
  return [program.executable, ...program.leadingArgs, ...args].join(" ");
}
