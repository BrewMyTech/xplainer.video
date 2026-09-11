/**
 * `xplainer daemon install`: preflight → stage → render → register → **verify**, with a rollback
 * that undoes every write in the reverse of the order that made it.
 *
 * ADR 0020 §Degraded paths gives the rule the first half obeys — "probe before writing; on refusal,
 * write nothing, exit with the documented code, and print the one command that fixes it" — and
 * `preflight.ts` is that half in full. This module is the other half, and its own rule is the one
 * P2-10 states: **an install that fails leaves the machine as it found it.** Every step that
 * changes something pushes an undo beside it, so the failure of step six removes what steps one to
 * five wrote rather than leaving a daemon registered against a launcher that was rolled back.
 *
 * **Verification is a start, not a registration.** A supervisor that accepted a unit has said
 * nothing about whether the daemon runs: `install` starts it and polls an **authenticated**
 * `GET /healthz` with a bounded timeout (`health.ts`), which is the wait ADR 0025's note of
 * 2026-09-08 assigns to the caller when it rejects `Type=notify`. On Windows that check is the only
 * thing that catches `SCHED_S_BATCH_LOGON_PROBLEM`, the success-with-warning a task registered for a
 * principal without the "Log on as a batch job" right returns.
 *
 * ## The order, and why each platform's is what it is
 *
 * **Linux — lingering first.** `loginctl enable-linger` is the one step that can be refused
 * outright, and it is refused by policy rather than by anything this process can see beforehand. It
 * therefore runs before anything is staged or registered, so its refusal is an exit `5` with an
 * untouched machine rather than an exit `5` on top of 150 MB of staged runtime. The check that
 * follows is `test -e /var/lib/systemd/linger/$USER` — the marker itself, not `loginctl`'s exit
 * status — because `loginctl` is a client of `logind` and reports what it was told, and it is run
 * **without `sudo`**: the whole point of a per-user daemon is that installing it needs no root, so
 * an install that quietly escalated would be answering a different question. Only then
 * `daemon-reload` and `enable --now`.
 *
 * **macOS — `enable` before `bootstrap`.** `man launchctl` says a disabled service "cannot be
 * loaded in the specified domain until it is once again enabled", and that state persists across
 * boots — so bootstrapping into a domain holding a stale disable record fails for a reason nothing
 * in the output names. Round 1 of the plan had bootstrap first, which fails its own stale-disable
 * case. `bootstrap` also does not refresh an already-loaded definition, so a re-install boots out
 * first; `kickstart` last, because `RunAtLoad` covers the fresh case and `kickstart` covers the one
 * where the domain already had the job.
 *
 * **Windows — register, start, then read `LastTaskResult` only if the health check failed.**
 * `Register-ScheduledTask -Xml … -Force` makes a re-install an update rather than a name collision.
 * The claim that `Register-ScheduledTask` is the *only* call that surfaces
 * `SCHED_S_BATCH_LOGON_PROBLEM` is **unverified** — `.github/workflows/daemon-windows.yml` is what
 * settles it — and a health timeout does not uniquely diagnose a missing right, so the failure
 * message names the candidates rather than asserting one.
 *
 * ## What is recorded, and what is deliberately not
 *
 * **There is no `--program` and no `--from-binary` on this verb, and that is a decision.**
 * `program.ts` knows four sources, and two of them already refuse this phase by name. The fourth,
 * `explicit`, cannot be *launched* by anything here: `runtime/launch-spec.ts` builds the one launch
 * contract every consumer takes, it builds it from a staged payload's own `bin` entry, and that
 * record is deliberately something "nobody composes". A flag that recorded `program_source:
 * explicit` while the artefact still named `<runtime>/bin/node` would be a lie in the one field
 * whose job is to say where the program came from. So this verb offers `--runtime`, which is the
 * source §2.1 gives the phase-2 default install, and the other three arrive with the story that can
 * express them in a launch contract.
 *
 * `daemon.json` gains the installer's fields (`supervisor_kind`, `supervisor_artefact`,
 * `runtime_dir`, `launch_spec`, `program_source`, `log_sink`, `installed_version`, the port), plus
 * the two three-valued facts an `uninstall` needs and cannot re-derive: `linger_enabled_by_us` and
 * `launchd_enable_record_created`. The **token is never written here**: the daemon mints it on its
 * first start, and an installer that minted one would put the value in a second place for no gain
 * (R-SEC-5).
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import {
  type DaemonState,
  type ProgramSource,
  type SupervisorKind,
  updateDaemonState,
} from "../daemon/daemon-state.js";
import {
  ADMIN_REQUIRED_EXIT_CODE,
  DAEMON_UNHEALTHY_EXIT_CODE,
  PRECONDITION_UNMET_EXIT_CODE,
} from "../daemon/exit-codes.js";
import { resolveIpcPath } from "../daemon/ipc.js";
import { STATE_DIR_MODE, stateDirLayout } from "../daemon/state-dir.js";
import { resolveTokenPath } from "../daemon/token.js";
import { buildLaunchSpec, type LaunchSpec } from "../runtime/launch-spec.js";
import { CLI_VERSION } from "../version.js";
import {
  awaitHealthy,
  HEALTH_TIMEOUT_MS,
  type HealthAnswer,
  HealthTimeout,
  type HealthTransport,
} from "./health.js";
import { LAUNCHER_DIR, launcherPath, type WrittenLauncher, writeLauncher } from "./launcher.js";
import {
  firstNonEmptyLine,
  type InstallPreflight,
  type LaunchdDisableRecord,
  type ProbeResult,
  type ProbeRunner,
  preflightInstall,
  runProbe,
} from "./preflight.js";
import { type ResolvedProgram, resolveProgram } from "./program.js";
import {
  deregisterCommands,
  REGISTRATION_TIMEOUT_MS,
  type RegistrationStep,
  type RegistrationTarget,
  registerCommands,
  taskInfoCommand,
} from "./register.js";
import { type StagedRuntime, stagedRuntimeRoot, stageRuntime } from "./stage.js";
import type { SupervisorEnvironment } from "./supervisors/artefact.js";
import { launchAgentLogPath, supervisorAdapter, taskLogPath } from "./supervisors/index.js";

/** The port an install records when the caller names none (`server.ts`'s own default). */
export const DEFAULT_INSTALL_PORT = 8787;

/** `journald`, the value `log_sink` takes where the supervisor keeps a journal rather than a file. */
const JOURNALD_SINK = "journald";

/**
 * Where this platform's daemon output goes, as the one value `log_sink` records.
 *
 * systemd has a journal and this project ships no rotator for it; launchd captures both streams
 * into the file `StandardOutPath` names; Task Scheduler captures nothing, so the path recorded there
 * is the one the daemon's own writer uses and `daemon logs` reads. Recorded rather than recomputed
 * at read time, because a daemon installed under a different home has a log that is not where this
 * process's home would put it.
 */
function supervisorLogSink(kind: SupervisorKind, environment: SupervisorEnvironment): string {
  switch (kind) {
    case "systemd":
      return JOURNALD_SINK;
    case "launchd":
      return launchAgentLogPath(environment);
    case "task-scheduler":
      return taskLogPath(environment);
  }
}

/** Which phase an install stopped in. `preflight` is the one that has written nothing by design. */
export type InstallPhase =
  | "preflight"
  | "linger"
  | "stage"
  | "program"
  | "launcher"
  | "artefact"
  | "record"
  | "register"
  | "verify";

/** The install refused, and everything it had written has been undone. */
export class InstallRefusal extends Error {
  /** The documented exit code for this condition. Nothing here invents one. */
  readonly exitCode: number;
  /** Which phase it stopped in. */
  readonly phase: InstallPhase;
  /** What the rollback undid, newest first, for the transcript a user is shown. */
  readonly undone: readonly string[];

  constructor(phase: InstallPhase, exitCode: number, message: string, undone: readonly string[]) {
    super(message);
    this.name = "InstallRefusal";
    this.phase = phase;
    this.exitCode = exitCode;
    this.undone = undone;
  }
}

/** One command the install ran, and what it answered. The whole transcript, in order. */
export type InstallCommand = {
  /** Why it was run. */
  title: string;
  /** How it was spelled, as one line. */
  command: string;
  /** Its exit status, or `null` when it never started. */
  status: number | null;
  /** Whether a non-zero status was one this step tolerates. */
  tolerated: boolean;
};

/** What an install did, complete enough to be printed and to be asserted on. */
export type InstallOutcome = {
  stateDir: string;
  platform: NodeJS.Platform;
  supervisor: SupervisorKind;
  /** The unit name, the launchd label, or the fully qualified task name. */
  identity: string;
  /** The unit, plist or task XML that was written. */
  artefact: string;
  /** The staged payload-1 directory the daemon runs out of. */
  runtimeDir: string;
  /** `<state>/bin/xplainer[.cmd]`, the one path a consumer may hold across an update. */
  launcher: string;
  /** The launch contract that was rendered into the artefact. */
  spec: LaunchSpec;
  /** Where this install's program came from. */
  program: ResolvedProgram;
  /** Whether the staged runtime was already there, so nothing was copied. */
  reusedRuntime: boolean;
  /** Lingering, on the one platform that has it. */
  linger: { applicable: boolean; marker: string; enabledByUs: boolean };
  /** What the launchd disable store held for our label **before** this install's `enable`. */
  launchdRecordBefore: LaunchdDisableRecord;
  /** The `200` that made this an install rather than a registration. */
  health: HealthAnswer;
  /** Every supervisor command that ran, in order. */
  commands: readonly InstallCommand[];
  /** The preflight this install proceeded from. */
  preflight: InstallPreflight;
};

/** What {@link installDaemon} needs. Every outside fact is a parameter. */
export type InstallRequest = {
  /** The durable state directory this install writes into. */
  stateDir: string;
  /**
   * A payload-1 directory to stage, exactly as `xplainer runtime build --out` produced it.
   *
   * Omitted, the install uses whichever runtime is already staged under `<state>/runtime/` — which
   * is what a re-install and `daemon update`'s own re-registration do.
   *
   * **A function is how a caller that has to *build* one gets the preflight first.** `--runtime`
   * names a directory that already exists, so it arrives as a string; the argument-free install
   * assembles ~146 MB, and passing a thunk means phase 3 calls it — after phase 1 has read the
   * setup marker, found a supervisor and checked the port, and inside the operation lock. Built
   * eagerly at the call site it was 1.3 s and 146 MB spent for an install about to exit 3, twice
   * over for two concurrent installers, and a comment in `commands/daemon.ts` claimed the opposite
   * of what the code did until a review executed the order.
   */
  payloadDir?: string | (() => string) | undefined;
  /**
   * The `program_source` to record, when the caller already knows it.
   *
   * `commands/daemon.ts` sets `package-manager` after it has materialised a payload out of an
   * installed package, because that is the one fact the payload directory cannot carry: both
   * sources end in a staged, content-addressed directory that every downstream reader treats
   * identically, so a resolver looking at the result would answer `runtime-dir` for both. This is
   * also what replaced carrying a resolution forward between phases — the source is now an input
   * rather than something re-derived from an output.
   */
  source?: ProgramSource | undefined;
  /** The port the artefact records. Defaults to {@link DEFAULT_INSTALL_PORT}. */
  port?: number | undefined;
  /** The platform whose supervisor is registered with. Defaults to this process's. */
  platform?: NodeJS.Platform | undefined;
  /** The environment the token path and the artefact paths are read from. */
  env?: Readonly<Record<string, string | undefined>> | undefined;
  /** The account and directories the artefact paths are built from. */
  environment?: SupervisorEnvironment | undefined;
  /** How supervisor commands are run. A parameter, so one machine can exercise all three. */
  run?: ProbeRunner | undefined;
  /** The uid whose `gui/<uid>` domain a LaunchAgent is bootstrapped into. Defaults to this one. */
  uid?: number | undefined;
  /** How long the verify step waits for a `200`. Defaults to {@link HEALTH_TIMEOUT_MS}. */
  healthTimeoutMs?: number | undefined;
  /** How the health poll reaches the daemon. Defaults to a real loopback request. */
  health?: HealthTransport | undefined;
  /** Told what each step is doing, as it happens. */
  log?: ((line: string) => void) | undefined;
};

/** One reversible write, with the sentence the rollback prints when it undoes it. */
type Undo = { what: string; undo: () => void };

/**
 * Install the daemon, or leave the machine exactly as it was.
 *
 * @throws {InstallRefusal} carrying the documented exit code and what the rollback undid.
 */
export async function installDaemon(request: InstallRequest): Promise<InstallOutcome> {
  const platform = request.platform ?? process.platform;
  const env = request.env ?? process.env;
  const run = request.run ?? runProbe;
  const uid = request.uid ?? process.getuid?.() ?? 0;
  const port = request.port ?? DEFAULT_INSTALL_PORT;
  const log = request.log ?? (() => undefined);
  const journal: Undo[] = [];
  const commands: InstallCommand[] = [];

  const preflightRequest = {
    stateDir: request.stateDir,
    port,
    platform,
    env,
    run,
    ...(request.environment === undefined ? {} : { environment: request.environment }),
  };

  // Phase 1, read-only. Everything below this line writes, and everything below this line is undone
  // by `rollback` if any later step refuses.
  let preflight = await preflightInstall(preflightRequest);
  const firstRefusal = preflight.refusals[0];
  if (firstRefusal !== undefined) {
    throw new InstallRefusal("preflight", firstRefusal.exitCode, firstRefusal.message, []);
  }
  const kind = preflight.supervisor.kind;
  if (kind === null) {
    throw new InstallRefusal(
      "preflight",
      PRECONDITION_UNMET_EXIT_CODE,
      `the preflight found no supervisor on ${platform} and did not refuse, which is a contradiction`,
      [],
    );
  }
  const environment = preflight.environment;

  /** Undo everything the journal holds, newest first, and say what was undone. */
  const rollback = (): string[] => {
    const undone: string[] = [];
    for (const entry of [...journal].reverse()) {
      try {
        entry.undo();
        undone.push(entry.what);
      } catch (error) {
        undone.push(
          `${entry.what} — could NOT be undone: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    journal.length = 0;
    return undone;
  };

  // Annotated on the declaration, not only on the arrow: TypeScript applies its "this call never
  // returns" analysis to a `const` whose *type* says so, which is what lets a `catch` that only
  // calls this satisfy definite assignment for the value the `try` was producing.
  const refuse: (phase: InstallPhase, exitCode: number, message: string) => never = (
    phase,
    exitCode,
    message,
  ) => {
    const undone = rollback();
    throw new InstallRefusal(phase, exitCode, message, undone);
  };

  /** Run one supervisor command, record it, and refuse on a status this step does not tolerate. */
  const step = (phase: InstallPhase, entry: RegistrationStep): ProbeResult => {
    log(`  ${entry.title}`);
    const answer = run({ ...entry.command, timeoutMs: REGISTRATION_TIMEOUT_MS });
    commands.push({
      title: entry.title,
      command: `${entry.command.program} ${entry.command.argv.join(" ")}`,
      status: answer.status,
      tolerated: entry.tolerated === true && answer.status !== 0,
    });
    if (!answer.started || (answer.status !== 0 && entry.tolerated !== true)) {
      refuse(
        phase,
        ADMIN_REQUIRED_EXIT_CODE,
        `${entry.command.program} ${entry.command.argv.join(" ")} ` +
          `${answer.started ? `exited ${String(answer.status)}` : "could not be run"}: ` +
          `${firstNonEmptyLine([answer.stderr, answer.stdout]) || "it said nothing"}. The ` +
          "supervisor is here and refused, so this is not a missing service manager — and the " +
          "line it printed above is the reason, which this install is in no position to improve " +
          "on. Everything it had written has been undone.",
      );
    }
    return answer;
  };

  // ── Phase 2: lingering, first, because it is the step that can be refused outright ────────────
  let lingerEnabledByUs = false;
  if (preflight.linger.applicable && !preflight.linger.enabled) {
    log(`lingering: ${preflight.linger.marker} is absent, asking logind for it`);
    // No `sudo`, deliberately: a per-user daemon that needed root to install would be answering a
    // different question, and `--no-ask-password` keeps a polkit prompt from hanging a
    // non-interactive install instead of refusing it.
    const answer = run({
      program: "loginctl",
      argv: ["--no-ask-password", "enable-linger", preflight.linger.user],
      timeoutMs: REGISTRATION_TIMEOUT_MS,
    });
    commands.push({
      title: "enable lingering, so this user's manager starts at boot with no login",
      command: `loginctl --no-ask-password enable-linger ${preflight.linger.user}`,
      status: answer.status,
      tolerated: false,
    });
    // The marker, not `loginctl`'s status: `loginctl` is a client of `logind` and reports what it
    // was told, and the file is the thing systemd itself reads at boot.
    if (!existsSync(preflight.linger.marker)) {
      throw new InstallRefusal(
        "linger",
        ADMIN_REQUIRED_EXIT_CODE,
        `lingering could not be enabled for ${preflight.linger.user}: ` +
          `${firstNonEmptyLine([answer.stderr, answer.stdout]) || "loginctl said nothing"}, and ` +
          `${preflight.linger.marker} is still absent. Without it this user's systemd manager ` +
          "stops when the last session ends and starts again only at the next login, so a daemon " +
          "installed now would not survive a reboot. Nothing was written. Ask an administrator " +
          `for:\n\n  sudo loginctl enable-linger ${preflight.linger.user}\n`,
        [],
      );
    }
    lingerEnabledByUs = true;
    journal.push({
      what: `disabled lingering for ${preflight.linger.user}, which this install had just enabled`,
      undo: () => {
        run({
          program: "loginctl",
          argv: ["--no-ask-password", "disable-linger", preflight.linger.user],
          timeoutMs: REGISTRATION_TIMEOUT_MS,
        });
      },
    });
  }

  // ── Phase 3: the payload ─────────────────────────────────────────────────────────────────────
  //
  // **A payload arrives here already built, whoever built it, and that is deliberate.** An
  // argument-free `xplainer daemon install` on a machine that installed from npm builds one out of
  // that install — but `commands/daemon.ts` does the building and passes the result as an ordinary
  // `payloadDir`, so it lands in the branch below rather than in a branch of its own.
  //
  // The alternative was tried and was wrong in three ways at once. Making the *resolver* materialise
  // a payload meant `resolveProgram` wrote a payload's worth of bytes, breaking its own contract ("Nothing here
  // writes") and cost `connect/spawn.ts` — a command that resolves a program only in order to write
  // one line into an agent's config — a full assemble as a side effect. It also meant the payload
  // arrived through the `payloadDir === undefined` branch, which pushes **no** journal undo, so a
  // failure in phases 5-9 left the payload staged while the refusal at the end of this function told
  // the user everything had been undone. And it reported `reused: true` for bytes just copied.
  //
  // Routing it through `payloadDir` fixes all three by construction: the undo below is pushed for
  // whatever was staged, `reused` comes from the real `StageOutcome`, and the resolver goes back to
  // being a pure question. `request.source` carries the one fact the directory cannot — that the
  // bytes came from a registry rather than somebody's working copy.
  //
  // **And a payload that has to be *built* is built here, not at the call site.** A thunk is called
  // at this line, which is below phase 1 and inside the caller's operation lock, so the read-only
  // refusals — no setup marker, no supervisor, a held port — all happen before anything assembles.
  // A refusal from the thunk itself propagates: nothing has been written at this point, and the
  // materialiser reclaims its own temp directory before it throws.
  let staged: StagedRuntime & { reused: boolean };
  if (request.payloadDir === undefined) {
    staged = { ...describeStagedRuntime(request.stateDir, refuse), reused: true };
  } else {
    const payloadDir =
      typeof request.payloadDir === "string" ? request.payloadDir : request.payloadDir();
    log(`staging ${payloadDir} under ${request.stateDir}`);
    const stageRootCreated = missingAncestors(stagedRuntimeRoot(request.stateDir));
    try {
      const outcome = stageRuntime({ payloadDir, stateDir: request.stateDir });
      staged = outcome;
      if (!outcome.reused) {
        journal.push({
          what: `removed the runtime staged at ${outcome.path}`,
          undo: () => {
            rmSync(outcome.path, { recursive: true, force: true });
            removeCreatedDirectories(stageRootCreated);
          },
        });
      }
    } catch (error) {
      return refuse(
        "stage",
        exitCodeOf(error, PRECONDITION_UNMET_EXIT_CODE),
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // ── Phase 4: the program and the launch contract ──────────────────────────────────────────────
  let program: ResolvedProgram;
  let spec: LaunchSpec;
  try {
    program = resolveProgram({
      stateDir: request.stateDir,
      runtimeDir: staged.path,
      ...(request.source === undefined ? {} : { source: request.source }),
    });
    spec = buildLaunchSpec({
      runtimeDir: staged.path,
      port,
      platform,
      settings: {
        stateDir: request.stateDir,
        tokenFile: resolveTokenPath(request.stateDir, env),
        socket: resolveIpcPath(request.stateDir, platform),
      },
    });
  } catch (error) {
    return refuse(
      "program",
      exitCodeOf(error, PRECONDITION_UNMET_EXIT_CODE),
      error instanceof Error ? error.message : String(error),
    );
  }

  // The second read, now that there is a program to ask about. The first pass could not check it:
  // on a machine with nothing staged the interpreter it names did not exist until phase 3.
  preflight = await preflightInstall({ ...preflightRequest, program });
  const programRefusal = preflight.refusals[0];
  if (programRefusal !== undefined) {
    refuse("program", programRefusal.exitCode, programRefusal.message);
  }

  // ── Phase 5: the launcher ─────────────────────────────────────────────────────────────────────
  log("writing the stable launcher");
  let launcher: WrittenLauncher;
  const launcherBefore = captureFile(launcherPath(request.stateDir, platform));
  const launcherDirCreated = missingAncestors(join(request.stateDir, LAUNCHER_DIR));
  try {
    launcher = writeLauncher({ stateDir: request.stateDir, program, platform });
  } catch (error) {
    return refuse(
      "launcher",
      exitCodeOf(error, PRECONDITION_UNMET_EXIT_CODE),
      error instanceof Error ? error.message : String(error),
    );
  }
  journal.push({
    what: `${launcherBefore === null ? "removed" : "restored"} ${launcher.path}`,
    undo: () => {
      restoreFile(launcher.path, launcherBefore);
      removeCreatedDirectories(launcherDirCreated);
    },
  });

  // ── Phase 6: the supervisor artefact ─────────────────────────────────────────────────────────
  const adapter = supervisorAdapter(kind);
  const artefact = adapter.render(spec, environment);
  log(`writing the ${kind} artefact at ${artefact.path}`);
  const artefactBefore = captureFile(artefact.path);
  const artefactDirCreated = missingAncestors(dirname(artefact.path));
  // Pushed before the write, not after it: a `writeFileSync` that failed halfway has still changed
  // the file, and an undo registered only on success would leave that behind.
  journal.push({
    what: `${artefactBefore === null ? "removed" : "restored"} ${artefact.path}`,
    undo: () => {
      restoreFile(artefact.path, artefactBefore);
      removeCreatedDirectories(artefactDirCreated);
    },
  });
  try {
    mkdirSync(dirname(artefact.path), { recursive: true, mode: STATE_DIR_MODE });
    writeFileSync(artefact.path, artefact.contents, { mode: artefact.mode });
    // `writeFileSync`'s mode applies only when it creates the file, so an artefact left behind by
    // an earlier release keeps its own mode without this.
    chmodSync(artefact.path, artefact.mode);
  } catch (error) {
    return refuse(
      "artefact",
      PRECONDITION_UNMET_EXIT_CODE,
      `the ${kind} artefact could not be written at ${artefact.path}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // ── Phase 7: the record ──────────────────────────────────────────────────────────────────────
  const stateFile = stateDirLayout(request.stateDir).daemonState;
  const stateBefore = captureFile(stateFile);
  const recorded: Partial<DaemonState> = {
    port,
    supervisor_kind: kind,
    supervisor_artefact: artefact.path,
    runtime_dir: staged.path,
    launch_spec: spec,
    program_source: program.source,
    linger_enabled_by_us: preflight.linger.applicable ? lingerEnabledByUs : null,
    launchd_enable_record_created:
      kind === "launchd" && preflight.disabled.probed
        ? preflight.disabled.record === "absent"
        : null,
    // journald is systemd's, and only systemd's. Task Scheduler captures nothing at all — a task's
    // `<Exec>` has no output redirection — so Windows records the file ADR 0020's platform table
    // names, which is where `daemon logs` looks and where the daemon's own writer will write.
    log_sink: supervisorLogSink(kind, environment),
    installed_version: CLI_VERSION,
    token_file: spec.settings.tokenFile,
    socket_path: spec.settings.socket,
  };
  // Pushed before the write for the reason the artefact's is: `updateDaemonState` reads, merges and
  // writes durably, and a failure inside it has still touched the file.
  journal.push({
    what: `${stateBefore === null ? "removed" : "restored"} ${stateFile}`,
    undo: () => {
      restoreFile(stateFile, stateBefore);
    },
  });
  try {
    updateDaemonState(request.stateDir, recorded);
  } catch (error) {
    return refuse(
      "record",
      exitCodeOf(error, PRECONDITION_UNMET_EXIT_CODE),
      `the install could not record itself in ${stateFile}: ` +
        `${error instanceof Error ? error.message : String(error)}. Nothing was registered, ` +
        "because a registration nothing recorded is a daemon no `uninstall` could find.",
    );
  }

  // ── Phase 8: registration ────────────────────────────────────────────────────────────────────
  const target: RegistrationTarget = {
    kind,
    identity: artefact.identity,
    artefact: artefact.path,
    uid,
  };
  log(`registering with ${kind} as ${artefact.identity}`);
  const registeredAt = Date.now();
  journal.push({
    what: `deregistered ${artefact.identity} from ${kind}`,
    undo: () => {
      for (const entry of deregisterCommands(target)) {
        run({ ...entry.command, timeoutMs: REGISTRATION_TIMEOUT_MS });
      }
    },
  });
  for (const entry of registerCommands(target)) {
    step("register", entry);
  }

  // ── Phase 9: verification ────────────────────────────────────────────────────────────────────
  log("waiting for an authenticated GET /healthz");
  let health: HealthAnswer;
  try {
    health = await awaitHealthy({
      stateDir: request.stateDir,
      // A second's grace, because `runtime.json` carries `started_at` from the daemon's own clock
      // and a filesystem timestamp is not what is being compared.
      since: registeredAt - 1_000,
      timeoutMs: request.healthTimeoutMs ?? HEALTH_TIMEOUT_MS,
      env,
      ...(request.health === undefined ? {} : { transport: request.health }),
    });
  } catch (error) {
    const detail = error instanceof HealthTimeout ? error.detail : String(error);
    if (kind === "task-scheduler") {
      // Read only now: `LastTaskResult` a second after `Start-ScheduledTask` is `267011`
      // (SCHED_S_TASK_HAS_NOT_RUN) on a perfectly healthy task, so it says nothing on its own.
      // A second value is ordinary here and is not a diagnosis either: `0x80070420`
      // (`2147946720`, "an instance of the service is already running") is what
      // `Start-ScheduledTask` records when the document's `<RegistrationTrigger>` has already
      // started the task and `MultipleInstancesPolicy: IgnoreNew` refused the second request —
      // measured on `windows-latest`, 2026-09-09, on a *successful* install. It means the task
      // is running and this daemon is not answering, which is what the sentence below already
      // says; the code `0x0004131C` names is the only one this refusal interprets, and the whole
      // of the query's output is printed rather than summarised for exactly this reason.
      const probe = taskInfoCommand(target);
      const info = run({ ...probe, timeoutMs: REGISTRATION_TIMEOUT_MS });
      commands.push({
        title: "ask Task Scheduler why the task did not answer",
        // The script `taskInfoCommand` built, rather than a second spelling of it written here: a
        // task is addressed by folder and leaf (`register.ts`'s `scheduledTaskSelector`), and a
        // transcript that showed `Get-ScheduledTaskInfo \xplainer\<user>-daemon` would be printing
        // a command nothing ran and that would not have worked if anything had.
        command: `${probe.program} ${probe.argv[probe.argv.length - 1] ?? ""}`,
        status: info.status,
        tolerated: false,
      });
      return refuse(
        "verify",
        ADMIN_REQUIRED_EXIT_CODE,
        `the task ${target.identity} was registered and started, and no daemon answered: ` +
          `${detail}.\n\nTask Scheduler reports:\n${indent(info.stdout || info.stderr)}\n\n` +
          "A `LastTaskResult` of 0x0004131C (SCHED_S_BATCH_LOGON_PROBLEM, 267036) means the " +
          'principal lacks the "Log on as a batch job" right, which is the candidate this ' +
          "install cannot grant for you. It is a candidate and not a diagnosis: a task that " +
          "started and then exited, a program the principal cannot read, and a port held by " +
          "something else produce the same silence. The task has been unregistered and " +
          "everything this install wrote has been undone. Grant the right with:\n\n" +
          "  secpol.msc → Local Policies → User Rights Assignment → Log on as a batch job\n",
      );
    }
    return refuse(
      "verify",
      DAEMON_UNHEALTHY_EXIT_CODE,
      `${artefact.identity} was registered with ${kind} and started, and no daemon answered an ` +
        `authenticated GET /healthz: ${detail}. Everything this install wrote has been undone, ` +
        `including the registration.${
          kind === "launchd"
            ? ` The job's own output is at ${launchAgentLogPath(environment)}.`
            : ""
        }`,
    );
  }

  log(`healthy on port ${String(health.port)} after ${String(health.elapsedMs)} ms`);
  return {
    stateDir: request.stateDir,
    platform,
    supervisor: kind,
    identity: artefact.identity,
    artefact: artefact.path,
    runtimeDir: staged.path,
    launcher: launcher.path,
    spec,
    program,
    reusedRuntime: staged.reused,
    linger: {
      applicable: preflight.linger.applicable,
      marker: preflight.linger.marker,
      enabledByUs: lingerEnabledByUs,
    },
    launchdRecordBefore: preflight.disabled.record,
    health,
    commands,
    preflight,
  };
}

/** The already-staged runtime, or a refusal naming the command that produces one. */
function describeStagedRuntime(
  stateDir: string,
  refuse: (phase: InstallPhase, exitCode: number, message: string) => never,
): StagedRuntime {
  try {
    const program = resolveProgram({ stateDir });
    if (program.runtimeDir === null || program.manifest === null) {
      throw new Error("the resolved program is not a staged runtime");
    }
    return {
      slot: basename(program.runtimeDir),
      path: program.runtimeDir,
      manifest: program.manifest,
    };
  } catch (error) {
    return refuse(
      "stage",
      exitCodeOf(error, PRECONDITION_UNMET_EXIT_CODE),
      `${error instanceof Error ? error.message : String(error)}\n\nBuild one first:\n\n` +
        "  xplainer runtime build --out <dir>\n  xplainer daemon install --runtime <dir>\n",
    );
  }
}

/**
 * The directories a `mkdir -p` of `path` would have to create, outermost first.
 *
 * A rollback that put every file back and left three new empty directories behind would still have
 * changed the machine — and one of them is `~/.config/systemd/user`, which is the *user's* tree and
 * not this project's. So each write records what its own `mkdir` invented, and the undo takes them
 * away again.
 */
function missingAncestors(path: string): string[] {
  const created: string[] = [];
  let current = path;
  while (!existsSync(current)) {
    created.unshift(current);
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return created;
}

/**
 * Remove directories this install created, innermost first, and only while they are empty.
 *
 * A directory somebody else has since put something in is not this install's to remove, which is
 * why the emptiness is a condition rather than a `recursive: true`.
 */
function removeCreatedDirectories(created: readonly string[]): void {
  for (const directory of [...created].reverse()) {
    try {
      rmdirSync(directory);
    } catch {
      // Not empty, or already gone. Either way it is not this rollback's to force.
    }
  }
}

/** A file's bytes and mode, or `null` when it is not there — enough to put either state back. */
function captureFile(path: string): { contents: Buffer; mode: number } | null {
  try {
    return { contents: readFileSync(path), mode: statSync(path).mode & 0o777 };
  } catch {
    return null;
  }
}

/** Put a file back the way {@link captureFile} found it, absence included. */
function restoreFile(path: string, before: { contents: Buffer; mode: number } | null): void {
  if (before === null) {
    rmSync(path, { force: true });
    return;
  }
  writeFileSync(path, before.contents);
  chmodSync(path, before.mode);
}

/** The exit code an error carries, or the caller's default. */
function exitCodeOf(error: unknown, fallback: number): number {
  if (typeof error !== "object" || error === null || !("exitCode" in error)) {
    return fallback;
  }
  const code = (error as { exitCode: unknown }).exitCode;
  return typeof code === "number" ? code : fallback;
}

/** Somebody else's output, indented so it reads as a quotation rather than as our own sentence. */
function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")
    .trimEnd();
}
