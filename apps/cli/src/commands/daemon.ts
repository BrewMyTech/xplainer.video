/**
 * `xplainer daemon` — install and manage the always-on local daemon.
 *
 * The names, their order and their exit codes are fixed here and asserted in
 * `program.test.ts`, because the command surface is the part of this that other
 * things depend on: `xplainer connect` points an agent client at a daemon this
 * group installed, and the README, the ADRs and the desktop client all name
 * these verbs.
 *
 * **Why `daemon` and not `service`.** `daemon` is already this repository's word
 * for the thing (ADR 0016: "The daemon has no authentication and binds
 * localhost"; `resolveDaemonUrl()` in `apps/desktop`). On Windows the later
 * implementation registers a Scheduled Task rather than a Windows Service, so
 * `xplainer service install` would send a user to `services.msc` to find
 * nothing.
 *
 * **This group carries its own output routing and `exitOverride`.** Commander's
 * `addCommand()` does not copy either from the parent, and `configureOutput()`
 * replaces the configuration object rather than mutating it, so a child added to
 * an already-configured program still holds the default one. Without the two
 * calls below, `xplainer daemon --help` and a bare `xplainer daemon` would write
 * straight to the process streams and call `process.exit` — invisible to the
 * test that has to prove this group lists exactly nine verbs. Production
 * behaviour is unchanged, because `processIo` is the process streams and
 * `process.exit`.
 *
 * **`helpCommand(false)` is load-bearing here too**, for the reason `program.ts`
 * gives: commander adds an implicit `help [command]` entry to any command that
 * has subcommands, which would make this group list ten.
 *
 * **All nine verbs have arrived.** `install` and `uninstall` are the pair that
 * had to ship together — an install nobody can undo is not something to put on a
 * stranger's machine, and P2-10's "a refused install leaves the machine as it
 * was" is only checkable if there is a command that puts it back. `start`,
 * `stop`, `status` and `logs` came next, over the one supervisor seam in
 * `install/lifecycle.ts`. `restart` was last because it is the one verb that
 * needs the daemon's own drain route: clear the application and supervisor
 * failure latches, `POST /api/daemon/drain` over IPC, wait for the process to
 * go, then start and wait for readiness. `update` and `recover` are the last
 * pair and they arrived together for the same reason `install` and `uninstall`
 * did: an update that can leave a machine with nothing running is not something
 * to put on a stranger's machine unless one named command puts it back. The
 * group's listing in `program.test.ts` grew by exactly those two.
 *
 * **Everything a person reads goes to stdout, and a refusal goes to stderr with
 * its documented exit code.** `install.ts` and `uninstall.ts` decide *what* is
 * true; this file decides only how it is said, which is the split that lets the
 * behaviour be asserted without parsing a transcript.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { Command, InvalidArgumentError } from "commander";
import { readDaemonState } from "../daemon/daemon-state.js";
import { DAEMON_UNHEALTHY_EXIT_CODE, PRECONDITION_UNMET_EXIT_CODE } from "../daemon/exit-codes.js";
import { resolveStateDir } from "../daemon/state-dir.js";
import {
  DEFAULT_INSTALL_PORT,
  type InstallOutcome,
  InstallRefusal,
  installDaemon,
} from "../install/install.js";
import {
  DaemonNotInstalled,
  type DaemonStatusReport,
  DEFAULT_LOG_LINES,
  daemonStatus,
  type LifecycleOutcome,
  LifecycleRefusal,
  logSource,
  type RestartOutcome,
  restartDaemon,
  startDaemon,
  stopDaemon,
  tailFile,
} from "../install/lifecycle.js";
import { currentSupervisorEnvironment } from "../install/preflight.js";
import { type UninstallOutcome, uninstallDaemon } from "../install/uninstall.js";
import { OperationLockRefused, withOperationLock } from "../install/update/lock.js";
import {
  RECOVER_COMMAND,
  readUpdateStatus,
  recoverUpdate,
  type UpdateStatus,
  updateStatusSentences,
} from "../install/update/recover.js";
import {
  requireNoUnfinishedTransaction,
  type UpdateOutcome,
  UpdateRefusal,
  updateDaemon,
} from "../install/update/transaction.js";
import type { CliIo } from "../io.js";

/** The largest port number a `--port` may name. */
const MAX_PORT = 65_535;

/** The verbs the group offers, in the order `xplainer daemon --help` lists them. */
const DAEMON_VERBS = [
  ["install", "Install the daemon so it starts on boot or login"],
  ["uninstall", "Remove the installed daemon and its supervisor registration"],
  ["update", "Switch the installed daemon to another runtime, and roll back if it will not start"],
  ["recover", "Finish or undo an update that was interrupted"],
  ["start", "Start the installed daemon and wait for it to answer"],
  ["stop", "Stop the running daemon"],
  ["restart", "Restart the daemon, clearing a latched start failure"],
  ["status", "Report whether the daemon is installed, running and healthy"],
  ["logs", "Show the daemon's log output"],
] as const satisfies readonly (readonly [name: string, description: string])[];

/** One of {@link DAEMON_VERBS}' names. */
type DaemonVerb = (typeof DAEMON_VERBS)[number][0];

/**
 * How each verb is built, by name.
 *
 * A record rather than nine `addCommand` calls, because the group's listing order is the order
 * commands are added and `program.test.ts` asserts that listing with `toEqual`: building every verb
 * inside the one loop over {@link DAEMON_VERBS} is what keeps the documented order and the
 * registered order the same object rather than two things to remember. Keying it on
 * {@link DaemonVerb} is what makes "every listed verb is built" a compile error rather than a
 * `--help` entry that exits 2 when somebody runs it.
 */
const IMPLEMENTED: Readonly<Record<DaemonVerb, (io: CliIo) => Command>> = {
  install: createInstallCommand,
  uninstall: createUninstallCommand,
  update: createUpdateCommand,
  recover: createRecoverCommand,
  start: createStartCommand,
  stop: createStopCommand,
  restart: createRestartCommand,
  status: createStatusCommand,
  logs: createLogsCommand,
};

/** What commander parses out of `daemon install`. */
type InstallOptions = {
  runtime?: string;
  port?: number;
};

export function createDaemonCommand(io: CliIo): Command {
  const daemon = new Command("daemon")
    .description("Install and manage the always-on local daemon")
    .helpCommand(false)
    .configureOutput({
      writeOut: (text) => {
        io.writeOut(text);
      },
      writeErr: (text) => {
        io.writeErr(text);
      },
    })
    .exitOverride((error) => io.exit(error.exitCode));

  for (const [name] of DAEMON_VERBS) {
    daemon.addCommand(IMPLEMENTED[name](io));
  }

  return daemon;
}

function createInstallCommand(io: CliIo): Command {
  return new Command("install")
    .description("Install the daemon so it starts on boot or login")
    .option(
      "--runtime <dir>",
      "a payload-1 directory from `xplainer runtime build --out` to stage; omit it to use " +
        "whichever runtime is already staged",
    )
    .option(
      "-p, --port <port>",
      `port the installed daemon binds; defaults to ${String(DEFAULT_INSTALL_PORT)}`,
      parsePort,
    )
    .action(async (options: InstallOptions) => {
      const stateDir = resolveStateDir();
      let outcome: InstallOutcome;
      try {
        outcome = await underOperationLock(stateDir, "install", async () =>
          installDaemon({
            stateDir,
            ...(options.runtime === undefined ? {} : { payloadDir: options.runtime }),
            ...(options.port === undefined ? {} : { port: options.port }),
            log: (line) => {
              io.writeOut(`xplainer daemon install: ${line}\n`);
            },
          }),
        );
      } catch (error) {
        const refused = reportOperationRefusal(io, "install", error);
        if (refused !== null) {
          return io.exit(refused);
        }
        if (error instanceof InstallRefusal) {
          io.writeErr(`xplainer daemon install: ${error.message}\n`);
          for (const undone of error.undone) {
            io.writeErr(`  rolled back: ${undone}\n`);
          }
          return io.exit(error.exitCode);
        }
        throw error;
      }
      io.writeOut(describeInstall(outcome));
    });
}

/** What commander parses out of `daemon update`. */
type UpdateOptions = {
  from?: string;
  build?: boolean;
  recover?: boolean;
};

/**
 * Run an install or an update under the operation lock, refusing an unfinished transaction first.
 *
 * Two guards, and they answer two different questions. The **lock** is about *now*: two updaters,
 * or an updater and an installer, would stage a runtime the other is switching away from. The
 * **journal** is about the past: a second transaction opened over an unfinished one would record a
 * new previous runtime over the one the first is still holding, which is the single thing that
 * turns a recoverable interruption into an unrecoverable one.
 *
 * **The lock is taken only when the state directory already exists**, and that is deliberate rather
 * than lazy. Creating the directory to hold a lock file would make `daemon install` write on a
 * machine where it is about to refuse for want of a setup marker, and P2-10's obligation is that a
 * refused install leaves the machine as it found it. Nothing is given up: an updater requires an
 * *installed* daemon, so on a machine with no state directory there is no update to interleave with.
 */
async function underOperationLock<T>(
  stateDir: string,
  verb: "install" | "update",
  act: () => Promise<T>,
): Promise<T> {
  if (!existsSync(stateDir)) {
    return act();
  }
  return withOperationLock(stateDir, verb, async () => {
    requireNoUnfinishedTransaction({ stateDir, steps: [] }, verb);
    return act();
  });
}

/** Print a refused lock or a refused journal, and answer with its exit code, or `null` if neither. */
function reportOperationRefusal(io: CliIo, verb: string, error: unknown): number | null {
  if (error instanceof OperationLockRefused) {
    io.writeErr(`xplainer daemon ${verb}: ${error.message}\n`);
    return error.exitCode;
  }
  if (error instanceof UpdateRefusal) {
    io.writeErr(`xplainer daemon ${verb}: ${error.message}\n`);
    for (const step of error.steps) {
      io.writeErr(`  did: ${step}\n`);
    }
    // Named here rather than woven into every message: a refusal that left the journal behind is
    // one command away from a running daemon, and that command is the same one in every case.
    if (error.recoverable) {
      io.writeErr(`  an unfinished transaction is on disk; \`${RECOVER_COMMAND}\` finishes it.\n`);
    }
    return error.exitCode;
  }
  return null;
}

/**
 * `daemon update` — stage the named runtime, drain, switch, start, and put the old one back if the
 * new one does not become ready.
 *
 * The source is **explicit** and there is no default: `--from` names a payload
 * `xplainer runtime build --out` produced, `--build` assembles a fresh one from this program's own
 * checkout, and "whatever is on `PATH`" is the answer ADR 0025 §Part one measured as wrong — a
 * package manager replaces the *global* CLI and leaves the pinned copy the supervisor executes
 * exactly where it was, which is the fact this command exists for.
 *
 * `--recover` is the second spelling of `daemon recover`, for the user who reaches for `update`
 * again after one was interrupted: a plain `update` refuses to start a second transaction and names
 * the command, and this flag is that command without a second thing to type.
 */
function createUpdateCommand(io: CliIo): Command {
  return new Command("update")
    .description(
      "Switch the installed daemon to another runtime, and roll back if it will not start",
    )
    .option(
      "--from <dir>",
      "a payload-1 directory from `xplainer runtime build --out` to update to",
    )
    .option("--build", "assemble a fresh payload from this program's own checkout and update to it")
    .option(
      "--recover",
      `finish or undo an interrupted update, exactly as \`${RECOVER_COMMAND}\` does`,
    )
    .action(async (options: UpdateOptions) => {
      const stateDir = resolveStateDir();
      if (options.recover === true) {
        await runRecovery(io, "update", stateDir);
        return;
      }
      let outcome: UpdateOutcome;
      try {
        outcome = await updateDaemon({
          stateDir,
          ...(options.from === undefined ? {} : { from: options.from }),
          ...(options.build === undefined ? {} : { build: options.build }),
          log: (line) => {
            io.writeOut(`xplainer daemon update: ${line}\n`);
          },
        });
      } catch (error) {
        const refused = reportOperationRefusal(io, "update", error);
        if (refused !== null) {
          return io.exit(refused);
        }
        throw error;
      }
      io.writeOut(describeUpdate("update", outcome));
    });
}

/**
 * `daemon recover` — the commanded half of the recovery decision.
 *
 * `daemon status` reports an interrupted transaction and names this command; this command is the
 * only thing that acts on one. It resumes the transaction from the transition the journal recorded
 * — completing it when the incoming runtime becomes ready, and putting the retained previous one
 * back when it does not — because both outcomes end with a daemon that is running and answering,
 * which is the whole point of retaining the previous runtime in the first place.
 */
function createRecoverCommand(io: CliIo): Command {
  return new Command("recover")
    .description("Finish or undo an update that was interrupted")
    .action(async () => {
      await runRecovery(io, "recover", resolveStateDir());
    });
}

/** Run the recovery and say what it did, or print the refusal and exit with its code. */
async function runRecovery(io: CliIo, verb: string, stateDir: string): Promise<void> {
  let outcome: UpdateOutcome;
  try {
    outcome = await recoverUpdate({
      stateDir,
      log: (line) => {
        io.writeOut(`xplainer daemon ${verb}: ${line}\n`);
      },
    });
  } catch (error) {
    const refused = reportOperationRefusal(io, verb, error);
    if (refused !== null) {
      return io.exit(refused);
    }
    throw error;
  }
  io.writeOut(describeUpdate(verb, outcome));
}

/** What an update or a recovery did, in the order it did it. */
function describeUpdate(verb: string, outcome: UpdateOutcome): string {
  const lines = [
    `xplainer daemon ${verb}: ${outcome.supervisor.identity} runs ${outcome.running.slot} and is ` +
      "answering.",
    `  transaction: ${outcome.transactionId}`,
    `  runtime:     ${outcome.running.runtime_dir}`,
    `  previous:    ${outcome.previous.slot} — retained at ${outcome.previous.runtime_dir}`,
    `  artefact:    ${outcome.supervisor.artefact}`,
    `  health:      ${outcome.health.url} answered in ${String(outcome.health.elapsedMs)} ms, ` +
      `release ${outcome.health.version}, tool contract ${outcome.health.contractVersion}`,
    `  run:         ${outcome.runId ?? "unrecorded"} — the run that answered, not the one drained`,
  ];
  if (outcome.source !== null) {
    lines.push(`  source:      ${outcome.source.detail}`);
  }
  for (const step of outcome.steps) {
    lines.push(`  did: ${step}`);
  }
  for (const command of outcome.commands) {
    lines.push(`  ran: ${command}`);
  }
  return `${lines.join("\n")}\n`;
}

function createUninstallCommand(io: CliIo): Command {
  return new Command("uninstall")
    .description("Remove the installed daemon and its supervisor registration")
    .action(() => {
      const outcome = uninstallDaemon({
        stateDir: resolveStateDir(),
        log: (line) => {
          io.writeOut(`xplainer daemon uninstall: ${line}\n`);
        },
      });
      io.writeOut(describeUninstall(outcome));
    });
}

/** The report an install ends with: what is installed, where, and what answered. */
function describeInstall(outcome: InstallOutcome): string {
  const lines = [
    `xplainer daemon install: ${outcome.identity} is installed with ${outcome.supervisor} and ` +
      "answering.",
    `  artefact:   ${outcome.artefact}`,
    `  runtime:    ${outcome.runtimeDir}${outcome.reusedRuntime ? " (already staged)" : ""}`,
    `  launcher:   ${outcome.launcher}`,
    `  health:     ${outcome.health.url} answered in ${String(outcome.health.elapsedMs)} ms, ` +
      `release ${outcome.health.version}, tool contract ${outcome.health.contractVersion}`,
    `  token file: ${outcome.health.tokenFile} — the daemon minted it, and no artefact carries ` +
      "its value",
  ];
  if (outcome.linger.applicable && outcome.linger.enabledByUs) {
    lines.push(
      `  lingering:  enabled for this user (${outcome.linger.marker}), so the daemon starts at ` +
        "boot with no login. `xplainer daemon uninstall` will not remove it.",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** The report an uninstall ends with: what went, what stayed, and what could not be removed. */
function describeUninstall(outcome: UninstallOutcome): string {
  const lines = [
    outcome.wasInstalled
      ? `xplainer daemon uninstall: ${outcome.identity ?? "the daemon"} is no longer installed.`
      : "xplainer daemon uninstall: nothing was installed here; every path below was checked anyway.",
  ];
  for (const entry of outcome.removed) {
    lines.push(
      `  ${entry.existed ? "removed" : "absent "} ${entry.what}: ${entry.path}` +
        `${entry.error === undefined ? "" : ` — FAILED: ${entry.error}`}`,
    );
  }
  lines.push(
    `  the bearer token was ${outcome.token.deleted ? "deleted" : "NOT deleted"}, not rotated: ` +
      "an uninstalled daemon leaves no live token behind.",
  );
  lines.push("  kept: toolchain.json and the workspace — your videos and what `setup` acquired.");
  if (outcome.linger.applicable) {
    lines.push(`  lingering: ${outcome.linger.detail}`);
  }
  if (outcome.launchdRecord.applicable) {
    lines.push(`  launchd:   ${outcome.launchdRecord.detail}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * A `--port` commander will not accept unless it is a port.
 *
 * The same range `serve` takes, `0` included and meaning the same thing: an ephemeral port, chosen
 * by the OS at each start and read back out of `runtime.json`. A supervised daemon usually wants a
 * fixed one — that is what makes the recorded port a contract — but the two halves of the same
 * setting must not disagree about what is a legal value.
 */
function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > MAX_PORT) {
    throw new InvalidArgumentError(`Port must be a whole number between 0 and ${MAX_PORT}.`);
  }
  return port;
}

/**
 * `daemon start` — ask the supervisor for the daemon, and wait until it answers.
 *
 * The wait is the command: all three supervisors return as soon as they have accepted the request,
 * so a `start` that reported success on the exit status would report success for a daemon that
 * never bound. `install/lifecycle.ts` decides what is true and this decides only how it is said.
 */
function createStartCommand(io: CliIo): Command {
  return new Command("start")
    .description("Start the installed daemon and wait for it to answer")
    .action(async () => {
      await lifecycleVerb(io, "start", () => startDaemon({ stateDir: resolveStateDir() }));
    });
}

/** `daemon stop` — ask the supervisor to stop it, and wait until nothing answers. */
function createStopCommand(io: CliIo): Command {
  return new Command("stop").description("Stop the running daemon").action(async () => {
    await lifecycleVerb(io, "stop", () => stopDaemon({ stateDir: resolveStateDir() }));
  });
}

/**
 * `daemon restart` — clear both failure latches, drain what is running, and start it again.
 *
 * The one verb that is not a supervisor command with a wait around it. A supervisor's own restart
 * would signal the daemon and, on Windows, terminate it outright; this asks the daemon for
 * ADR 0024's six steps over the IPC socket first, and clears the latches **before** it asks for
 * anything, because a `serve` that starts while `daemon.json` says `stalled` exits `0` without
 * binding and a systemd unit that has been rate-limited refuses the start. `install/lifecycle.ts`
 * decides what is true and this decides only how it is said.
 */
function createRestartCommand(io: CliIo): Command {
  return new Command("restart")
    .description("Restart the daemon, clearing a latched start failure")
    .action(async () => {
      const stateDir = resolveStateDir();
      // An interrupted update is finished **before** anything is restarted, and this is the
      // "or a later `daemon restart`" half of the recovery decision. A restart into an unfinished
      // transaction would drain and start whatever the artefact currently names — which after the
      // switch is the runtime that may not come up, and before it is a runtime the journal is
      // still holding a rollback target for. The recovery ends with a daemon that is running, so
      // the restart below is then a restart of something rather than a guess.
      if (readUpdateStatus(stateDir).state === "interrupted") {
        io.writeOut(
          "xplainer daemon restart: an update of this daemon was interrupted; finishing or " +
            "undoing it first.\n",
        );
        await runRecovery(io, "restart", stateDir);
      }
      await lifecycleVerb(io, "restart", () => restartDaemon({ stateDir }));
    });
}

/**
 * `daemon status` — the command a support ticket starts with.
 *
 * `--json` is ADR 0020's machine surface, and its answer is a condition code rather than a
 * sentence: `apps/desktop`'s discovery and a provisioning script both need a closed set to branch
 * on, and prose is what they must not have to parse. The prose form carries the same facts and, at
 * the end, the sentences the ADR requires this command to be able to say.
 */
function createStatusCommand(io: CliIo): Command {
  return new Command("status")
    .description("Report whether the daemon is installed, running and healthy")
    .option("--json", "write one JSON object with a stable condition code instead of prose")
    .action(async (options: { json?: boolean }) => {
      const stateDir = resolveStateDir();
      const report = await daemonStatus({ stateDir });
      // Read, never repaired: `readUpdateStatus` opens one file and asks whether a pid is alive,
      // and that is the whole of what this verb is allowed to do about an interrupted update.
      const update = readUpdateStatus(stateDir);
      io.writeOut(
        options.json === true
          ? `${JSON.stringify({ ...report, update })}\n`
          : describeStatus(report, update),
      );
      if (report.exit_code !== 0) {
        io.exit(report.exit_code);
      }
    });
}

/**
 * `daemon logs` — the journal on Linux, our own file on macOS and Windows.
 *
 * ADR 0020's asymmetry, and it is stated there rather than decided here: journald already does
 * retention, so on Linux this **execs `journalctl --user -u xplainer`** and this project ships no
 * rotator; launchd has no log-rotation key and Task Scheduler captures nothing, so the other two
 * read the file `install` recorded. Node has no `execve`, so the journal path is a child with the
 * three streams inherited whose exit status becomes this command's — which is what `exec` buys and
 * all of what this verb needs from it.
 */
function createLogsCommand(io: CliIo): Command {
  return new Command("logs")
    .description("Show the daemon's log output")
    .option(
      "-n, --lines <count>",
      `how many lines to show; defaults to ${String(DEFAULT_LOG_LINES)}`,
      parseLineCount,
    )
    .action((options: { lines?: number }) => {
      const stateDir = resolveStateDir();
      const lines = options.lines ?? DEFAULT_LOG_LINES;
      const daemon = readDaemonState(stateDir);
      // Nothing registered has no log, and naming the path an install *would* have used would send
      // a reader looking for a file no daemon was ever going to write. Same code and same sentence
      // as `start` and `stop`, which is the point.
      if (daemon.supervisor_kind === null) {
        io.writeErr(
          `xplainer daemon logs: nothing is installed in ${stateDir}: daemon.json records no ` +
            "supervisor, so no daemon has run here and there is no log to read. Install with " +
            "`xplainer daemon install`.\n",
        );
        return io.exit(PRECONDITION_UNMET_EXIT_CODE);
      }
      const source = logSource(daemon, currentSupervisorEnvironment(), lines);
      if (source.kind === "journal") {
        const answer = spawnSync(source.command.program, [...source.command.argv], {
          stdio: "inherit",
        });
        if (answer.error !== undefined) {
          io.writeErr(
            `xplainer daemon logs: ${source.command.program} could not be run ` +
              `(${answer.error.message}). The unit's output is in this user's journal, and ` +
              `\`${source.command.program} ${source.command.argv.join(" ")}\` is the command that ` +
              "reads it.\n",
          );
          return io.exit(PRECONDITION_UNMET_EXIT_CODE);
        }
        if (answer.status !== 0) {
          return io.exit(answer.status ?? DAEMON_UNHEALTHY_EXIT_CODE);
        }
        return;
      }
      if (!source.present) {
        io.writeErr(
          `xplainer daemon logs: ${source.path} does not exist, so nothing has written to this ` +
            "daemon's log yet. It appears the first time the supervisor starts it.\n",
        );
        return io.exit(PRECONDITION_UNMET_EXIT_CODE);
      }
      io.writeOut(`${tailFile(source.path, lines).join("\n")}\n`);
    });
}

/** Run one lifecycle verb, and say what it did or why it refused, with the documented code. */
async function lifecycleVerb<T extends LifecycleOutcome>(
  io: CliIo,
  verb: "start" | "stop" | "restart",
  act: () => Promise<T>,
): Promise<void> {
  let outcome: T;
  try {
    outcome = await act();
  } catch (error) {
    if (error instanceof DaemonNotInstalled || error instanceof LifecycleRefusal) {
      io.writeErr(`xplainer daemon ${verb}: ${error.message}\n`);
      if (error instanceof LifecycleRefusal) {
        for (const command of error.commands) {
          io.writeErr(`  ran: ${command}\n`);
        }
      }
      return io.exit(error.exitCode);
    }
    throw error;
  }
  io.writeOut(describeLifecycle(verb, outcome));
}

/** What a `start`, a `stop` or a `restart` ended in, in one line and then its evidence. */
function describeLifecycle(verb: "start" | "stop" | "restart", outcome: LifecycleOutcome): string {
  const lines: string[] = [];
  if (verb === "restart") {
    return describeRestart(outcome as RestartOutcome);
  }
  if (verb === "start") {
    lines.push(
      outcome.alreadyThere
        ? `xplainer daemon start: ${outcome.identity} was already answering on port ` +
            `${String(outcome.port ?? 0)}; nothing was asked of ${outcome.kind}.`
        : `xplainer daemon start: ${outcome.identity} answered an authenticated GET /healthz on ` +
            `port ${String(outcome.port ?? 0)} after ${String(outcome.elapsedMs)} ms.`,
    );
  } else {
    lines.push(
      outcome.alreadyThere
        ? `xplainer daemon stop: ${outcome.identity} was not answering; ${outcome.kind} was asked ` +
            "to stop it anyway, and it is not answering now."
        : `xplainer daemon stop: ${outcome.identity} stopped answering after ` +
            `${String(outcome.elapsedMs)} ms. The registration is untouched — ` +
            "`xplainer daemon uninstall` is what removes it.",
    );
  }
  for (const command of outcome.commands) {
    lines.push(`  ran: ${command}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * What a `restart` did, in the order it did it.
 *
 * Every line is evidence a support ticket needs and cannot get afterwards: which latch was holding
 * the daemon down, whether the running one was drained or stopped some other way, and — where the
 * platform has a documented query — how that run actually ended. A `restart` that printed only
 * "the daemon is running" would hide the two most common reasons it was not.
 */
function describeRestart(outcome: RestartOutcome): string {
  const lines = [
    outcome.alreadyThere
      ? `xplainer daemon restart: ${outcome.identity} is answering on port ` +
        `${String(outcome.port ?? 0)}; it was already back when the start was asked for.`
      : `xplainer daemon restart: ${outcome.identity} answered an authenticated GET /healthz on ` +
        `port ${String(outcome.port ?? 0)} after ${String(outcome.elapsedMs)} ms.`,
    `  latch:     ${
      outcome.cleared.stalled === null
        ? `no stalled record was set${
            outcome.cleared.startsCleared === 0
              ? ""
              : `; ${String(outcome.cleared.startsCleared)} start record(s) were cleared`
          }`
        : `cleared the stall latched at ${outcome.cleared.stalled.at}, and ` +
          `${String(outcome.cleared.startsCleared)} start record(s) with it`
    }`,
  ];
  if (outcome.supervisorLatch !== "") {
    lines.push(`  supervisor: ${outcome.supervisorLatch}`);
  }
  lines.push(`  stop:      ${outcome.stop}`, `  exit:      ${outcome.exit}`);
  for (const command of outcome.commands) {
    lines.push(`  ran: ${command}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The status report as prose: where every fact came from, then the sentences.
 *
 * Each line is labelled with its source — `daemon.json`, `runtime.json`, the supervisor query that
 * was run, the probe — because that labelling is what makes the report usable in a support ticket:
 * "the port came from the record and nothing answered on it" and "the port came from the default
 * because nothing has recorded one" are different problems that would otherwise read the same.
 */
export function describeStatus(report: DaemonStatusReport, update: UpdateStatus): string {
  const supervisor = report.supervisor;
  const lines = [
    `condition:       ${report.condition}`,
    `state directory: ${report.state_dir}`,
    `supervisor:      ${supervisor.kind ?? "none for this platform"}${
      supervisor.identity === null ? "" : ` — ${supervisor.identity}`
    }${report.daemon.supervisor_kind === null ? " (this platform's, and nothing is registered)" : ""}`,
    `  artefact:      ${supervisor.artefact ?? "none recorded"}${
      supervisor.artefact === null ? "" : supervisor.artefact_present ? "" : " — MISSING"
    }`,
    `  manager:       ${supervisor.manager.detail}`,
    `  switched off?  ${supervisor.switch.detail}`,
    `                 (${supervisor.switch.query ?? "no query on this platform"})`,
    `  loaded config: ${supervisor.loaded.detail}`,
    `identity:        ${report.identity.detail}`,
    `daemon.json:     port ${report.daemon.port ?? "unrecorded"}, contract ${
      report.daemon.contract_version ?? "unrecorded"
    }, installed ${report.daemon.installed_version ?? "unrecorded"}`,
    `runtime.json:    ${
      report.runtime === null
        ? "absent — no run has bound, or the last one shut down cleanly"
        : `pid ${String(report.runtime.pid ?? "unknown")} (a hint until the probe below confirms it)`
    }`,
    `  desired:       ${report.identity.desired.digest ?? "none recorded"} — ${
      report.identity.desired.detail
    }`,
    `  responding:    ${report.identity.responding.runtime_digest ?? "not advertised"}${
      report.identity.responding.run_id === null
        ? ""
        : ` (run ${report.identity.responding.run_id})`
    }`,
    `probing:         ${report.probe.url}/healthz`,
    `  answered:      ${
      report.health === null
        ? `${report.probe.http_status === null ? "nothing" : String(report.probe.http_status)}${
            report.probe.error === null ? "" : ` (${report.probe.error})`
          }`
        : `200 — version ${String(report.health.version)}, contract ${String(
            report.health.contract_version,
          )}`
    }`,
  ];
  if (report.probe.holder_detail !== null) {
    lines.push(`  port holder:   ${report.probe.holder_detail}`);
  }
  lines.push(
    `toolchain:       ${report.toolchain.detail}`,
    // R-SEC-5's second half, and it is a *warning* when it fires: the token file is what the guard
    // rests on, and an entry that has been widened underneath a running daemon changes nothing that
    // any other line here would show.
    `token file:      ${report.token_acl.state === "widened" ? "WARNING — " : ""}${
      report.token_acl.detail
    }`,
    `boot-persistent: ${
      report.boot_persistence.persistent === null
        ? "n/a"
        : report.boot_persistence.persistent
          ? "yes"
          : "no"
    } — ${report.boot_persistence.detail}`,
  );
  if (report.failed_starts > 0) {
    lines.push(`failed starts:   ${String(report.failed_starts)} in a row, newest last`);
  }
  // Which detector fired, named. On macOS only one of the two can ever fire — there is no
  // loaded-configuration query there (§1.3b D7) — so saying which one did is the difference between
  // "the identity is wrong" and "the configuration is wrong", and only one of those is knowable on
  // every platform.
  for (const mismatch of report.identity.mismatches) {
    lines.push(
      `MISMATCH:        ${mismatch.detector} — ${mismatch.field}`,
      `  desired:       ${mismatch.desired}`,
      `  found:         ${mismatch.found}`,
      `  ${mismatch.detail}`,
    );
  }
  lines.push(`update:          ${describeUpdateState(update)}`);
  const updateSentences = updateStatusSentences(update);
  if (report.sentences.length > 0 || updateSentences.length > 0) {
    lines.push("says:");
    for (const sentence of report.sentences) {
      lines.push(`  ${sentence.text}`);
    }
    for (const sentence of updateSentences) {
      lines.push(`  ${sentence}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The journal, in the one labelled line the report carries above its sentences. */
function describeUpdateState(update: UpdateStatus): string {
  switch (update.state) {
    case "none":
      return "no transaction is in progress and none was interrupted";
    case "in-flight":
      return (
        `transaction ${update.transaction.transactionId} is in progress at ` +
        `"${update.transaction.transition}" (${update.transaction.updater.detail})`
      );
    case "interrupted":
      return (
        `transaction ${update.transaction.transactionId} was INTERRUPTED at ` +
        `"${update.transaction.transition}" — run \`${RECOVER_COMMAND}\``
      );
    case "newer":
      return `${update.path} was written by a newer release (format_version ${String(update.formatVersion)})`;
    case "unreadable":
      return `${update.path} cannot be read: ${update.detail}`;
  }
}

/** A `--lines` commander will not accept unless it is a positive whole number. */
function parseLineCount(value: string): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count <= 0) {
    throw new InvalidArgumentError("The line count must be a whole number greater than zero.");
  }
  return count;
}
