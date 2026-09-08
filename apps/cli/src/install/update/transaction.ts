/**
 * The update transaction: ADR 0025's six steps, promoted from a call sequence to something that
 * survives its own updater dying.
 *
 * ADR 0025 §Part one states the sequence — install, **stage**, **drain**, **switch**, **restart and
 * wait for readiness**, and **on failure stop the replacement, switch back, restart and verify** —
 * and every one of those verbs is here. What the record could not state, because it was writing
 * about a package manager's post-install hook rather than about a command, is what happens when the
 * process running the sequence stops existing halfway through. An ordered sequence has no answer to
 * that. A transaction does, and the answer has three parts:
 *
 * 1. **An operation lock** (`lock.ts`), so two updaters — or an updater and an installer — cannot
 *    interleave. It is deliberately **not** `owner.lock`: that one belongs to the running daemon,
 *    which this transaction drains on purpose.
 * 2. **A durable journal** (`journal.ts`) naming the last completed transition and the retained
 *    previous runtime, written temp → `fsync` → `rename` at each boundary.
 * 3. **A commanded recovery** (`recover.ts`). `daemon status` *reports*; `xplainer daemon recover`
 *    *acts*. Nothing here watches or retries by itself.
 *
 * **Why the recovery is commanded rather than automatic, stated with its cost.** Automatic
 * restoration needs a component that notices the daemon is gone and puts the previous runtime back —
 * a supervisor for the supervisor, with its own lifetime, its own failure modes and its own trigger
 * semantics at every boundary — and ADR 0025's driver, "the daemon must not become an updater",
 * points the same way. The cost is not hidden: **on Linux and macOS, an updater that dies between
 * the drain and the restart leaves nothing running until somebody runs the named command**, because
 * the daemon exited `0` and `0` is the portable "do not restart" signal in both `Restart=on-failure`
 * and `KeepAlive{SuccessfulExit:false}`. Windows' `PT5M` repetition does restart the task without a
 * command — but it starts **whatever the task is currently registered to run**, so it restores the
 * old runtime only at boundaries *before* the switch has rewritten the task, and after the switch it
 * invokes the new runtime, which is the one that may not start. What the design guarantees at every
 * boundary is what this file provides: the previous runtime is intact on disk, the journal names the
 * interrupted transition, and one command restores service.
 *
 * **Resuming repeats; it never repairs.** Every step between two boundaries is idempotent — staging
 * is content-addressed, the switch is three rewrites and a reload, the start is a supervisor verb —
 * so a recovery re-runs the step after the recorded transition without inspecting how far the last
 * attempt got. That is why the forward path and the recovery path are the same function
 * ({@link runFromTransition}) entered at different points, rather than a second implementation that
 * only ever runs when something has already gone wrong.
 *
 * **Readiness is bound to the launch, not to a port answering.** The wait is `install/health.ts`'s
 * authenticated `GET /healthz` — a `401` proves a bind and nothing about readiness — over a
 * `runtime.json` newer than the moment the start was asked for, and this file adds two identity
 * checks on top: the run this answer came from is **not** the run the transaction drained — its
 * `run_id`, journalled before the drain, because a daemon that was killed rather than drained
 * leaves its own `runtime.json` behind — and the release it reports is the one that was launched. The third identity, the advertised
 * `runtime_digest`, is T17's: it is what tells two runtimes apart that share a `CLI_VERSION`, and it
 * does not exist on `/healthz` yet.
 */

import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import process from "node:process";
import { awaitStopped, requestDrain } from "../../daemon/control.js";
import type { DaemonState, ProgramSource, SupervisorKind } from "../../daemon/daemon-state.js";
import { readDaemonState, readRuntimeState } from "../../daemon/daemon-state.js";
import {
  DAEMON_UNHEALTHY_EXIT_CODE,
  PRECONDITION_UNMET_EXIT_CODE,
} from "../../daemon/exit-codes.js";
import { resolveIpcPath } from "../../daemon/ipc.js";
import { resolveTokenPath } from "../../daemon/token.js";
import { buildLaunchSpec, type LaunchSpec, PORT_FLAG } from "../../runtime/launch-spec.js";
import { type RuntimeManifest, readRuntimeManifest } from "../../runtime/manifest.js";
import { resolveWorkspaceRoot } from "../../workspace-root.js";
import { awaitHealthy, type HealthAnswer, HealthTimeout, type HealthTransport } from "../health.js";
import { DEFAULT_INSTALL_PORT } from "../install.js";
import {
  LIFECYCLE_COMMAND_TIMEOUT_MS,
  STOP_TEARDOWN_ALLOWANCE_MS,
  startCommand,
  stopDaemon,
} from "../lifecycle.js";
import {
  currentSupervisorEnvironment,
  firstNonEmptyLine,
  type ProbeRunner,
  runProbe,
  spell,
} from "../preflight.js";
import { type ResolvedProgram, resolveProgram } from "../program.js";
import type { RegistrationTarget } from "../register.js";
import { rootPackageOf } from "../stage.js";
import type { SupervisorEnvironment } from "../supervisors/artefact.js";
import { supervisorAdapter } from "../supervisors/index.js";
import {
  clearUpdateJournal,
  currentUpdater,
  type JournalledRuntime,
  newTransactionId,
  readUpdateJournal,
  recordTransition,
  TRANSITION_MEANING,
  UPDATE_JOURNAL_FORMAT_VERSION,
  UPDATE_TRANSITIONS,
  type UpdateJournal,
  type UpdateTransition,
  updateJournalPath,
} from "./journal.js";
import { type LockedOperation, withOperationLock } from "./lock.js";
import {
  type IncomingSource,
  requireCompatibleUpdate,
  resolveIncomingSource,
  stageIncomingRuntime,
  UpdatePrecondition,
} from "./stage.js";
import { SwitchRefusal, switchRuntime } from "./switch.js";

/** How long the replacement is given to answer an authenticated `/healthz` before it is rolled back. */
export const REPLACEMENT_READY_TIMEOUT_MS = 60_000;

/** Which step of the transaction a refusal stopped in. */
export type UpdatePhase =
  | "installed"
  | "journal"
  | "source"
  | "precondition"
  | "stage"
  | "drain"
  | "switch"
  | "start"
  | "ready"
  | "rollback";

/** The update refused, and the transcript says what it had done by then. */
export class UpdateRefusal extends Error {
  /** The documented exit code for this condition. Nothing here invents one. */
  readonly exitCode: number;
  /** Which step it stopped in. */
  readonly phase: UpdatePhase;
  /** Everything the transaction had done, in order. */
  readonly steps: readonly string[];
  /** Whether the journal was left behind for a commanded recovery. */
  readonly recoverable: boolean;

  constructor(
    phase: UpdatePhase,
    exitCode: number,
    message: string,
    steps: readonly string[] = [],
    recoverable = false,
  ) {
    super(message);
    this.name = "UpdateRefusal";
    this.phase = phase;
    this.exitCode = exitCode;
    this.steps = steps;
    this.recoverable = recoverable;
  }
}

/** What an update or a recovery did, complete enough to be printed and to be asserted on. */
export type UpdateOutcome = {
  stateDir: string;
  transactionId: string;
  supervisor: { kind: SupervisorKind; identity: string; artefact: string };
  /** The runtime that was installed when the transaction opened — the rollback target. */
  previous: JournalledRuntime;
  /** The runtime the transaction was switching to. */
  incoming: JournalledRuntime;
  /** Whether the transaction ended by putting {@link UpdateOutcome.previous} back. */
  rolledBack: boolean;
  /** The runtime that is running now. */
  running: JournalledRuntime;
  /** The `200` that ended the wait. */
  health: HealthAnswer;
  /** The run that answered, from `runtime.json` — never the run that was drained. */
  runId: string | null;
  /** Every step, in order, as the transcript prints it. */
  steps: readonly string[];
  /** Every supervisor command that ran, spelled as it was run. */
  commands: readonly string[];
  /** Where version B came from, or `null` for a recovery, which resumes rather than resolves one. */
  source: IncomingSource | null;
};

/** What {@link updateDaemon} needs. Every outside fact is a parameter. */
export type UpdateRequest = {
  /** The durable state directory the installed daemon records into. */
  stateDir: string;
  /** `--from <dir>`: the payload-1 directory to update to. */
  from?: string | undefined;
  /** `--build`: assemble a fresh payload from this program's own checkout instead. */
  build?: boolean | undefined;
  /** The platform whose supervisor is addressed. Defaults to this process's. */
  platform?: NodeJS.Platform | undefined;
  /** The environment the token path and the artefact paths are read from. */
  env?: Readonly<Record<string, string | undefined>> | undefined;
  /** The account and directories the artefact paths are built from. */
  environment?: SupervisorEnvironment | undefined;
  /** How supervisor commands are run. A parameter, so one machine can exercise all three. */
  run?: ProbeRunner | undefined;
  /** The uid whose `gui/<uid>` domain a LaunchAgent lives in. Defaults to this process's. */
  uid?: number | undefined;
  /** How long the replacement is given to answer. Defaults to {@link REPLACEMENT_READY_TIMEOUT_MS}. */
  healthTimeoutMs?: number | undefined;
  /** How the readiness poll reaches the daemon. Defaults to a real loopback request. */
  health?: HealthTransport | undefined;
  /** The workspace root the precondition verifies. Defaults to `resolveWorkspaceRoot()`. */
  workspaceRoot?: string | undefined;
  /** Told what each step is doing, as it happens. */
  log?: ((line: string) => void) | undefined;
};

/** Everything the steps below share, resolved once from the record and the request. */
type UpdateContext = {
  request: UpdateRequest;
  stateDir: string;
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  environment: SupervisorEnvironment;
  run: ProbeRunner;
  uid: number;
  kind: SupervisorKind;
  target: RegistrationTarget;
  port: number;
  steps: string[];
  commands: string[];
  log: (line: string) => void;
};

/**
 * Update the installed daemon to the runtime `--from` or `--build` names.
 *
 * @throws {UpdateRefusal} carrying the documented exit code, and `recoverable` when the journal was
 * left behind for `xplainer daemon recover`.
 */
export async function updateDaemon(request: UpdateRequest): Promise<UpdateOutcome> {
  return withOperationLock(request.stateDir, "update", async () => {
    const context = updateContext(request);
    requireNoUnfinishedTransaction(context, "update");

    let source: IncomingSource;
    try {
      source = resolveIncomingSource(request);
    } catch (error) {
      throw asRefusal("source", error, context.steps);
    }

    try {
      const journal = openTransaction(context, source);
      const outcome = await runFromTransition(context, journal);
      return { ...outcome, source };
    } finally {
      // The assembled payload is a build directory, not the installed artefact: what survives is
      // the content-addressed copy under `<state>/runtime/`, which the stager made.
      if (source.temporary !== null) {
        rmSync(source.temporary, { recursive: true, force: true });
      }
    }
  });
}

/**
 * Finish, or roll back, a transaction an earlier updater left behind.
 *
 * This is the commanded recovery. It takes the same operation lock — a recovery racing a second
 * updater is the condition the lock exists for — and it resumes from the recorded transition rather
 * than starting a transaction of its own.
 *
 * @throws {UpdateRefusal} when there is nothing to recover, or when the resume itself refused.
 */
export async function recoverTransaction(
  request: UpdateRequest,
  operation: LockedOperation = "recover",
): Promise<UpdateOutcome> {
  return withOperationLock(request.stateDir, operation, async () => {
    // The journal first, and before anything else is resolved: this command's subject is the
    // record, so "there is nothing to recover" must be the answer on a machine where nothing is
    // installed either, rather than a sentence about an install the caller did not ask about.
    const read = readUpdateJournal(request.stateDir);
    if (read.state === "absent") {
      throw new UpdateRefusal(
        "journal",
        PRECONDITION_UNMET_EXIT_CODE,
        `there is no unfinished update to recover: ${updateJournalPath(request.stateDir)} does ` +
          `not exist. \`xplainer daemon status\` reports an interrupted transaction whenever ` +
          `there is one, and this state directory has none.`,
      );
    }
    if (read.state !== "present") {
      throw unreadableJournalRefusal({ stateDir: request.stateDir, steps: [] }, read);
    }
    const context = updateContext(request);
    context.steps.push(
      `resuming transaction ${read.journal.transaction_id} from "${read.journal.transition}": ` +
        `${TRANSITION_MEANING[read.journal.transition]}`,
    );
    return { ...(await runFromTransition(context, read.journal)), source: null };
  });
}

/**
 * The one engine both entry points drive, entered at the transition that was last completed.
 *
 * The steps are listed once and skipped by ordinal rather than repeated per entry point, because
 * "the forward path and the recovery path do the same things in the same order" is the property
 * that makes a resume safe, and it should be visible in the code rather than asserted about it.
 */
async function runFromTransition(
  context: UpdateContext,
  opened: UpdateJournal,
): Promise<Omit<UpdateOutcome, "source">> {
  let journal = opened;
  const done = (transition: UpdateTransition): boolean =>
    UPDATE_TRANSITIONS.indexOf(journal.transition) >= UPDATE_TRANSITIONS.indexOf(transition);

  if (journal.transition === "rolling-back") {
    return rollBack(
      context,
      journal,
      journal.rollback_reason ?? "an earlier updater turned around",
    );
  }

  if (!done("drained")) {
    await drainRunningDaemon(context, journal);
    journal = recordTransition(context.stateDir, journal, "drained");
  }

  if (!done("switched")) {
    switchTo(context, journal, journal.incoming, "the incoming");
    journal = recordTransition(context.stateDir, journal, "switched");
  }

  if (!done("started")) {
    startSupervised(context, journal.incoming);
    journal = recordTransition(context.stateDir, journal, "started");
  }

  let health: HealthAnswer;
  try {
    // The floor is the transaction's **own opening**, not "now": the drain removed the record of
    // the run that was replaced, and on macOS the switch's `bootstrap` starts the job itself
    // through `RunAtLoad` — so a floor taken after the switch would exclude the very record the
    // wait is looking for, and a resumed transaction would exclude one written minutes ago by the
    // updater that died.
    health = await awaitLaunched(context, journal.incoming, openedAt(journal), journal);
  } catch (error) {
    return rollBack(context, journal, error instanceof Error ? error.message : String(error));
  }

  clearUpdateJournal(context.stateDir);
  context.steps.push(
    `the journal at ${updateJournalPath(context.stateDir)} was removed: the transaction is complete`,
  );
  return {
    stateDir: context.stateDir,
    transactionId: journal.transaction_id,
    supervisor: {
      kind: context.kind,
      identity: context.target.identity,
      artefact: context.target.artefact,
    },
    previous: journal.previous,
    incoming: journal.incoming,
    rolledBack: false,
    running: journal.incoming,
    health,
    runId: currentRunId(context.stateDir),
    steps: context.steps,
    commands: context.commands,
  };
}

/**
 * ADR 0025's step 6, in its own order: **stop the timed-out replacement before starting anything.**
 *
 * The record states the reason and it is not tidiness: rolling back without first stopping the
 * replacement risks two daemons contending for the exclusive ownership ADR 0024 requires, "and the
 * rollback would be the process that loses". State the newer version wrote is **preserved rather
 * than deleted** for the same record's rule — a `format_version` newer than the reader understands
 * is a rollback signal and not corruption — so nothing here removes a job record, a lock or a
 * journal that a newer build wrote.
 */
async function rollBack(
  context: UpdateContext,
  opened: UpdateJournal,
  reason: string,
): Promise<Omit<UpdateOutcome, "source">> {
  let journal = opened;
  context.steps.push(`rolling back: ${reason}`);

  // First, and before the journal turns around: a rollback that could not stop the replacement must
  // not switch the artefact underneath a running daemon.
  try {
    const stopped = await stopDaemon({
      stateDir: context.stateDir,
      platform: context.platform,
      env: context.env,
      environment: context.environment,
      run: context.run,
      uid: context.uid,
    });
    context.commands.push(...stopped.commands);
    context.steps.push(
      stopped.alreadyThere
        ? "the replacement was not answering; the supervisor was asked to stop it anyway"
        : `the replacement stopped answering after ${String(stopped.elapsedMs)} ms`,
    );
  } catch (error) {
    throw new UpdateRefusal(
      "rollback",
      DAEMON_UNHEALTHY_EXIT_CODE,
      `${reason}\n\nThe replacement could not be stopped, so the rollback did not run: ` +
        `${error instanceof Error ? error.message : String(error)}. Switching the artefact back ` +
        `while that process is still running would leave two daemons contending for the state ` +
        `directory, and the rollback is the one that would lose. The journal at ` +
        `${updateJournalPath(context.stateDir)} still names the retained runtime; run ` +
        `\`xplainer daemon recover\` once that process is gone.`,
      context.steps,
      true,
    );
  }

  journal = recordTransition(context.stateDir, journal, "rolling-back", reason);
  // Taken before the switch, and not from the journal: the replacement may have bound and written
  // a record of its own, and the wait below must not accept that one as evidence about the
  // runtime being put back.
  const rollingBackFrom = Date.now();
  switchTo(context, journal, journal.previous, "the retained previous");
  startSupervised(context, journal.previous);

  let health: HealthAnswer;
  try {
    health = await awaitLaunched(context, journal.previous, rollingBackFrom, journal);
  } catch (error) {
    throw new UpdateRefusal(
      "rollback",
      DAEMON_UNHEALTHY_EXIT_CODE,
      `${reason}\n\nThe previous runtime ${journal.previous.slot} was put back and it did not ` +
        `answer either: ${error instanceof Error ? error.message : String(error)}. The journal ` +
        `at ${updateJournalPath(context.stateDir)} is still there and still names the retained ` +
        `runtime, so \`xplainer daemon recover\` can be run again; ` +
        `\`xplainer daemon logs\` is where that process's own account of it is.`,
      context.steps,
      true,
    );
  }

  clearUpdateJournal(context.stateDir);
  context.steps.push(
    `the journal at ${updateJournalPath(context.stateDir)} was removed: the rollback is complete`,
  );
  // ADR 0020's `4` — "installed and not answering" — read about the **replacement**, which is the
  // condition that was detected and the reason this command failed. It is not a new code, and it is
  // not a claim about the machine now: the sentence below says which runtime is installed and that
  // it is answering. A code for "the operation failed and was undone" is not in the table, and the
  // rule is that a new one is added to the table and to ADR 0020's successor, never at a call site.
  throw new UpdateRefusal(
    "ready",
    DAEMON_UNHEALTHY_EXIT_CODE,
    `${reason}\n\nThe previous runtime ${journal.previous.slot} is installed and answering ` +
      `${health.url} again, release ${health.version}. Nothing of the incoming runtime is ` +
      `registered; it is still staged at ${journal.incoming.runtime_dir}, and removing it is a ` +
      `decision this command leaves to you.`,
    context.steps,
    false,
  );
}

// ── the steps ────────────────────────────────────────────────────────────────────────────────

/**
 * ADR 0025's step 3, over ADR 0024's own handler.
 *
 * The drain route is asked **first** and the supervisor's stop is the fallback, in that order and
 * not the other way round: `POST /api/daemon/drain` runs the daemon's six steps — in-flight jobs
 * reach a checkpoint or are marked `error` with `error_code: "daemon_shutdown"`, and nothing is
 * left `running` — while a supervisor stop is a `SIGTERM` on two platforms and a **terminate** on
 * Windows, where no handler runs at all. A daemon that is answering but whose socket cannot be
 * asked is either older than this route or bound somewhere `daemon.json` does not record, and
 * refusing to update it would make the command useless in exactly the case it is most wanted: the
 * upgrade away from the release that has no route.
 */
async function drainRunningDaemon(context: UpdateContext, journal: UpdateJournal): Promise<void> {
  const socketPath = readDaemonState(context.stateDir).socket_path;
  const fallback = async (why: string): Promise<void> => {
    const stopped = await stopDaemon({
      stateDir: context.stateDir,
      platform: context.platform,
      env: context.env,
      environment: context.environment,
      run: context.run,
      uid: context.uid,
    });
    context.commands.push(...stopped.commands);
    context.steps.push(`${why}; stopped it through ${context.kind} instead`);
  };

  if (socketPath === null) {
    await fallback("daemon.json records no socket path, so the drain route could not be asked");
    return;
  }
  const asked = await requestDrain({ socketPath });
  context.commands.push(`POST /api/daemon/drain over ${socketPath}`);
  if (!asked.ok) {
    await fallback(asked.detail);
    return;
  }

  const acknowledgement = asked.acknowledgement;
  const budget = acknowledgement.timeout_ms + STOP_TEARDOWN_ALLOWANCE_MS;
  const gone = await awaitStopped({
    stateDir: context.stateDir,
    pid: acknowledgement.pid,
    timeoutMs: budget,
  });
  if (!gone.stopped) {
    throw new UpdateRefusal(
      "drain",
      DAEMON_UNHEALTHY_EXIT_CODE,
      `${context.target.identity} accepted the drain and pid ${String(acknowledgement.pid)} was ` +
        `still running ${String(budget / 1000)} s later. Nothing has been switched: the ` +
        `supervisor still names ${journal.previous.runtime_dir}. \`xplainer daemon logs\` is ` +
        `where that process's own account of the drain is.`,
      context.steps,
      true,
    );
  }
  context.steps.push(
    `pid ${String(acknowledgement.pid)} drained${
      acknowledgement.already_draining ? " (a drain was already running)" : ""
    } and was gone after ${String(gone.elapsedMs)} ms; runtime.json ` +
      `${gone.runtimeRecordRemoved ? "was removed with it" : "is still there"}`,
  );
}

/** ADR 0025's step 4, in both directions. */
function switchTo(
  context: UpdateContext,
  journal: UpdateJournal,
  side: JournalledRuntime,
  what: string,
): void {
  let program: ResolvedProgram;
  try {
    program = resolveProgram({ stateDir: context.stateDir, runtimeDir: side.runtime_dir });
  } catch (error) {
    throw new UpdateRefusal(
      "switch",
      PRECONDITION_UNMET_EXIT_CODE,
      `${what} runtime at ${side.runtime_dir} cannot be launched: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      context.steps,
      true,
    );
  }
  try {
    const outcome = switchRuntime({
      stateDir: context.stateDir,
      kind: context.kind,
      spec: side.launch_spec,
      program,
      runtimeDir: side.runtime_dir,
      programSource: side.program_source,
      installedVersion: side.installed_version,
      port: journal.port,
      environment: context.environment,
      platform: context.platform,
      uid: context.uid,
      run: context.run,
      log: (line) => {
        context.log(line);
      },
    });
    context.commands.push(...outcome.commands.map((command) => command.command));
    context.steps.push(
      `${context.kind} now names ${what} runtime ${side.slot}: ${outcome.artefact.path} was ` +
        `rewritten, ${outcome.launcher.path} with it, and the supervisor reloaded`,
    );
  } catch (error) {
    if (error instanceof SwitchRefusal) {
      context.commands.push(...error.commands.map((command) => command.command));
    }
    throw new UpdateRefusal(
      "switch",
      DAEMON_UNHEALTHY_EXIT_CODE,
      `${error instanceof Error ? error.message : String(error)}`,
      context.steps,
      true,
    );
  }
}

/** ADR 0025's step 5, first half: ask the supervisor, and never treat its exit status as readiness. */
function startSupervised(context: UpdateContext, side: JournalledRuntime): void {
  const command = startCommand(context.target);
  const answer = context.run({ ...command, timeoutMs: LIFECYCLE_COMMAND_TIMEOUT_MS });
  context.commands.push(spell(command));
  if (!answer.started || answer.status !== 0) {
    throw new UpdateRefusal(
      "start",
      DAEMON_UNHEALTHY_EXIT_CODE,
      `${spell(command)} ${answer.started ? `exited ${String(answer.status)}` : "could not be run"}` +
        `: ${firstNonEmptyLine([answer.stderr, answer.stdout]) || "it said nothing"}. The ` +
        `supervisor names ${side.runtime_dir} and would not start it.`,
      context.steps,
      true,
    );
  }
  context.steps.push(`${spell(command)} asked ${context.kind} to start ${side.slot}`);
}

/**
 * ADR 0025's step 5, second half: **wait for readiness, not for the supervisor's idea of started.**
 *
 * Three things have to be true, and each of them rules out a failure the others let through:
 *
 * - an **authenticated** `GET /healthz` answers `200`, over a `runtime.json` written after this
 *   start was asked for — `install/health.ts`'s wait, unchanged;
 * - the run that answered is **not** the run that was drained, so a supervisor that never restarted
 *   anything cannot pass on a stale record;
 * - the release it reports is the one that was launched, so a switch the supervisor did not read is
 *   a failure here rather than a success that installs the old runtime under the new one's name.
 *
 * The version is a **necessary** identity and not a sufficient one — two runtimes can share a
 * `CLI_VERSION` and differ in argv, settings or content — and closing that gap is T17's
 * `runtime_digest`, which `/healthz` does not advertise yet.
 */
async function awaitLaunched(
  context: UpdateContext,
  side: JournalledRuntime,
  since: number,
  journal: UpdateJournal,
): Promise<HealthAnswer> {
  const timeoutMs = context.request.healthTimeoutMs ?? REPLACEMENT_READY_TIMEOUT_MS;
  let health: HealthAnswer;
  try {
    health = await awaitHealthy({
      stateDir: context.stateDir,
      // A second's grace, because `runtime.json` carries `started_at` from the daemon's own clock
      // and a filesystem timestamp is not what is being compared.
      since: since - 1_000,
      timeoutMs,
      env: context.env,
      ...(context.request.health === undefined ? {} : { transport: context.request.health }),
    });
  } catch (error) {
    throw new Error(
      `${side.slot} was started and nothing answered an authenticated GET /healthz within ` +
        `${String(timeoutMs / 1000)} s: ${error instanceof HealthTimeout ? error.detail : String(error)}`,
    );
  }
  const runId = currentRunId(context.stateDir);
  if (runId !== null && runId === journal.previous_run_id) {
    throw new Error(
      `${side.slot} was started and the record that answered names run ${runId}, which is the run ` +
        `this transaction drained. A daemon that was killed rather than drained leaves its own ` +
        `runtime.json behind, so this is the previous process's record and not evidence about ` +
        `the one that was launched`,
    );
  }
  if (health.version !== side.version) {
    throw new Error(
      `${side.slot} was started and the daemon that answered ${health.url} reports release ` +
        `${health.version}, not ${side.version}. The supervisor is running a runtime other than ` +
        `the one the artefact names, which is a switch it did not read`,
    );
  }
  context.steps.push(
    `${health.url} answered 200 in ${String(health.elapsedMs)} ms: release ${health.version}, ` +
      `tool contract ${health.contractVersion}, run ${runId ?? "unrecorded"}`,
  );
  return health;
}

// ── opening a transaction ────────────────────────────────────────────────────────────────────

/** Resolve everything the steps share, or refuse because nothing is installed here. */
function updateContext(request: UpdateRequest): UpdateContext {
  const stateDir = request.stateDir;
  const platform = request.platform ?? process.platform;
  const env = request.env ?? process.env;
  const environment = request.environment ?? currentSupervisorEnvironment(env, homedir(), platform);
  const daemon = readDaemonState(stateDir);
  const kind = daemon.supervisor_kind;
  if (kind === null) {
    throw new UpdateRefusal(
      "installed",
      PRECONDITION_UNMET_EXIT_CODE,
      `nothing is installed in ${stateDir}: daemon.json records no supervisor, so there is no ` +
        "daemon to update. Install one with `xplainer daemon install`.",
    );
  }
  // The identity is the adapter's, built from **this** account's environment, exactly as `install`
  // built it: the name is derived from the account and the home, and a second copy in `daemon.json`
  // would be one more thing to disagree with the first.
  const identity = supervisorAdapter(kind).identity(environment);
  return {
    request,
    stateDir,
    platform,
    env,
    environment,
    run: request.run ?? runProbe,
    uid: request.uid ?? process.getuid?.() ?? 0,
    kind,
    target: {
      kind,
      identity,
      artefact: daemon.supervisor_artefact ?? supervisorAdapter(kind).artefactPath(environment),
      uid: request.uid ?? process.getuid?.() ?? 0,
    },
    port: recordedPort(daemon),
    steps: [],
    commands: [],
    log: request.log ?? (() => undefined),
  };
}

/**
 * The port the installed artefact records, read from the launch contract and not from the last bind.
 *
 * `daemon.json`'s `port` is documented as "the port the last successful bind used", which for an
 * install made with `--port 0` is an ephemeral number some earlier run happened to be given.
 * Re-rendering the artefact from that would quietly turn "choose a port at every start" into
 * "always this one" — a change to the installed contract that an update has no business making. The
 * spec's own argv carries `--port <value>` verbatim, because `runtime/launch-spec.ts` puts every
 * setting there, so that is the value an update carries forward.
 */
function recordedPort(daemon: DaemonState): number {
  const argv = daemon.launch_spec?.argv ?? [];
  const at = argv.indexOf(PORT_FLAG);
  const recorded = at < 0 ? Number.NaN : Number(argv[at + 1]);
  if (Number.isInteger(recorded) && recorded >= 0) {
    return recorded;
  }
  return daemon.port ?? DEFAULT_INSTALL_PORT;
}

/**
 * `install` and `update` both refuse to start a second transaction while one is unfinished.
 *
 * A second transaction would journal a *new* previous runtime over the one the first is still
 * holding, which is the one thing that turns a recoverable interruption into an unrecoverable one.
 */
export function requireNoUnfinishedTransaction(
  context: { stateDir: string; steps: string[] },
  verb: string,
): void {
  const read = readUpdateJournal(context.stateDir);
  if (read.state === "absent") {
    return;
  }
  if (read.state !== "present") {
    throw unreadableJournalRefusal(context, read);
  }
  throw new UpdateRefusal(
    "journal",
    PRECONDITION_UNMET_EXIT_CODE,
    `an update of this daemon is unfinished and \`daemon ${verb}\` will not start a second one. ` +
      `Transaction ${read.journal.transaction_id} stopped at "${read.journal.transition}": ` +
      `${TRANSITION_MEANING[read.journal.transition]}. The previous runtime ` +
      `${read.journal.previous.slot} is intact at ${read.journal.previous.runtime_dir}. ` +
      `Nothing was staged and nothing was drained. Finish or undo it first:\n\n` +
      `  xplainer daemon recover\n`,
    context.steps,
    true,
  );
}

/** The two journal states nothing may act on, in one refusal each. */
function unreadableJournalRefusal(
  context: { stateDir: string; steps: string[] },
  read: { state: "newer"; formatVersion: number } | { state: "unreadable"; detail: string },
): UpdateRefusal {
  if (read.state === "newer") {
    return new UpdateRefusal(
      "journal",
      PRECONDITION_UNMET_EXIT_CODE,
      `${updateJournalPath(context.stateDir)} records format_version ` +
        `${String(read.formatVersion)} and this build understands ` +
        `${String(UPDATE_JOURNAL_FORMAT_VERSION)}. A newer format version is a rollback signal ` +
        `and never corruption, so the document is left exactly as it is: it was written by a ` +
        `newer release than the one running now, and that release is the one that can finish its ` +
        `own transaction.`,
      context.steps,
      true,
    );
  }
  return new UpdateRefusal(
    "journal",
    PRECONDITION_UNMET_EXIT_CODE,
    `${updateJournalPath(context.stateDir)} exists and cannot be read: ${read.detail}. It is the ` +
      `only record of which runtime an interrupted update retained, so it is left in place rather ` +
      `than removed. \`xplainer daemon status\` shows what is installed and what is answering.`,
    context.steps,
    true,
  );
}

/** Run the pre-drain checks, stage the incoming runtime, and open the journal at `staged`. */
function openTransaction(context: UpdateContext, source: IncomingSource): UpdateJournal {
  const daemon = readDaemonState(context.stateDir);
  const previous = installedSide(context, daemon);
  const incomingManifest = readIncomingManifest(context, source.payloadDir);

  // The precondition, in full, and **before** anything is staged or drained.
  try {
    const verdict = requireCompatibleUpdate({
      installedRuntimeDir: previous.runtime_dir,
      incomingRuntimeDir: source.payloadDir,
      incomingManifest,
      workspaceRoot:
        context.request.workspaceRoot ?? resolveWorkspaceRoot(context.stateDir, context.env),
      incomingProgram: incomingProgramLine(source.payloadDir, incomingManifest),
    });
    context.steps.push(
      `the incoming and installed template pins are identical (${String(
        Object.keys(verdict.pins).length,
      )} packages) and the workspace satisfies both: ` +
        `${String(verdict.workspaceFilesChecked)} files re-hashed`,
    );
  } catch (error) {
    throw asRefusal("precondition", error, context.steps);
  }

  let staged: { path: string; slot: string; reused: boolean };
  try {
    staged = stageIncomingRuntime(context.stateDir, source.payloadDir);
  } catch (error) {
    throw asRefusal("stage", error, context.steps);
  }
  context.steps.push(
    `${source.detail} is staged at ${staged.path}${staged.reused ? " (already staged)" : ""}`,
  );

  if (staged.path === previous.runtime_dir) {
    throw new UpdateRefusal(
      "stage",
      PRECONDITION_UNMET_EXIT_CODE,
      `${source.detail} is byte-for-byte the runtime that is already installed — both are ` +
        `${staged.slot}, and a staged runtime is named after its own contents. There is nothing ` +
        `to update to. Nothing was drained.`,
      context.steps,
    );
  }

  const incoming: JournalledRuntime = {
    runtime_dir: staged.path,
    slot: staged.slot,
    version: rootPackageOf(incomingManifest).version,
    program_source: previous.program_source,
    launch_spec: buildLaunchSpec({
      runtimeDir: staged.path,
      port: context.port,
      platform: context.platform,
      settings: previous.launch_spec.settings,
    }),
    installed_version: rootPackageOf(incomingManifest).version,
  };

  const now = new Date().toISOString();
  const journal: UpdateJournal = {
    format_version: UPDATE_JOURNAL_FORMAT_VERSION,
    transaction_id: newTransactionId(),
    started_at: now,
    updated_at: now,
    transition: "staged",
    updater: currentUpdater(),
    supervisor: {
      kind: context.kind,
      identity: context.target.identity,
      artefact: context.target.artefact,
    },
    previous,
    incoming,
    port: context.port,
    previous_run_id: currentRunId(context.stateDir),
    rollback_reason: null,
  };
  return recordTransition(context.stateDir, journal, "staged");
}

/** The installed runtime, as the journal records the side a rollback returns to. */
function installedSide(context: UpdateContext, daemon: DaemonState): JournalledRuntime {
  const runtimeDir = daemon.runtime_dir;
  if (runtimeDir === null || !existsSync(runtimeDir)) {
    throw new UpdateRefusal(
      "installed",
      PRECONDITION_UNMET_EXIT_CODE,
      `daemon.json records ${runtimeDir === null ? "no staged runtime" : `${runtimeDir}, and there is nothing there`}. ` +
        `An update switches one staged runtime for another and retains the first for a rollback, ` +
        `so a machine with no runtime to retain is a reinstall rather than an update: ` +
        `\`xplainer daemon install --runtime <dir>\`.`,
      context.steps,
    );
  }
  const source: ProgramSource = daemon.program_source ?? "runtime-dir";
  if (source !== "runtime-dir") {
    throw new UpdateRefusal(
      "installed",
      PRECONDITION_UNMET_EXIT_CODE,
      `daemon.json records program_source ${JSON.stringify(source)}, and this transaction ` +
        `replaces a staged payload-1 runtime with another. A program the install named itself is ` +
        `not this command's to move; reinstall from the runtime you want with ` +
        `\`xplainer daemon install\`.`,
      context.steps,
    );
  }
  let manifest: RuntimeManifest;
  try {
    manifest = readRuntimeManifest(runtimeDir);
  } catch (error) {
    throw new UpdateRefusal(
      "installed",
      PRECONDITION_UNMET_EXIT_CODE,
      `the installed runtime at ${runtimeDir} cannot be read as a payload: ` +
        `${error instanceof Error ? error.message : String(error)}. It is the rollback target, so ` +
        `an update that could not describe it would be an update with nothing to fall back to.`,
      context.steps,
    );
  }
  const settings = daemon.launch_spec?.settings ?? {
    stateDir: context.stateDir,
    tokenFile: resolveTokenPath(context.stateDir, context.env),
    socket: resolveIpcPath(context.stateDir, context.platform),
  };
  const spec: LaunchSpec =
    daemon.launch_spec ??
    buildLaunchSpec({
      runtimeDir,
      port: context.port,
      platform: context.platform,
      settings,
    });
  return {
    runtime_dir: runtimeDir,
    slot: basename(runtimeDir),
    version: rootPackageOf(manifest).version,
    program_source: source,
    launch_spec: spec,
    installed_version: daemon.installed_version,
  };
}

/** The incoming payload's manifest, or a refusal naming what is wrong with it. */
function readIncomingManifest(context: UpdateContext, payloadDir: string): RuntimeManifest {
  try {
    return readRuntimeManifest(payloadDir);
  } catch (error) {
    throw new UpdateRefusal(
      "source",
      PRECONDITION_UNMET_EXIT_CODE,
      `${payloadDir} is not a payload-1 artefact: ` +
        `${error instanceof Error ? error.message : String(error)}. Build one with ` +
        `\`xplainer runtime build --out <dir>\`.`,
      context.steps,
    );
  }
}

/**
 * How the incoming runtime's own program is spelled, for the reinstall path a refusal names.
 *
 * The interpreter **and** the entry, because a payload's `dist/bin.js` begins
 * `#!/usr/bin/env node` and the machine this design exists for has no Node on its `PATH` — which is
 * the same reason `install/program.ts` answers with two fields rather than one argv.
 */
function incomingProgramLine(payloadDir: string, manifest: RuntimeManifest): string {
  const interpreter = join(payloadDir, ...manifest.launch.interpreter.split("/"));
  const entry = join(payloadDir, ...manifest.launch.entry.split("/"));
  return `${interpreter} ${entry}`;
}

/**
 * When this transaction opened, as the floor a readiness wait compares `runtime.json` against.
 *
 * A record older than the transaction belongs to the run the drain removed, which is exactly what
 * the floor exists to exclude. `Date.now()` is the fallback for a journal whose stamp cannot be
 * parsed, because a wait with no floor at all would accept the previous run's record.
 */
function openedAt(journal: UpdateJournal): number {
  const opened = Date.parse(journal.started_at);
  return Number.isFinite(opened) ? opened : Date.now();
}

/** The run that is recorded now, which is what an identity check compares against. */
function currentRunId(stateDir: string): string | null {
  const runtime = readRuntimeState(stateDir);
  return typeof runtime?.run_id === "string" ? runtime.run_id : null;
}

/** Turn a refusal from a collaborator into this command's, keeping its exit code. */
function asRefusal(phase: UpdatePhase, error: unknown, steps: readonly string[]): UpdateRefusal {
  if (error instanceof UpdateRefusal) {
    return error;
  }
  if (error instanceof UpdatePrecondition) {
    return new UpdateRefusal(phase, error.exitCode, error.message, steps);
  }
  const exitCode =
    typeof error === "object" && error !== null && "exitCode" in error
      ? ((error as { exitCode: unknown }).exitCode ?? PRECONDITION_UNMET_EXIT_CODE)
      : PRECONDITION_UNMET_EXIT_CODE;
  return new UpdateRefusal(
    phase,
    typeof exitCode === "number" ? exitCode : PRECONDITION_UNMET_EXIT_CODE,
    error instanceof Error ? error.message : String(error),
    steps,
  );
}
