/**
 * The switch: an artefact rewrite, plus the one reload each platform needs to notice it.
 *
 * ADR 0025 §Part one's second closed gap is the whole subject of this file: **step 4 is a
 * supervisor edit, not a state-file edit.** `daemon.json` records "the supervisor kind and artefact
 * path, the resolved program and interpreter", and the artefact is
 * `~/.config/systemd/user/xplainer.service`, the LaunchAgent plist, or the task XML — so rewriting
 * `daemon.json` alone leaves `ExecStart=` pointing at the old copy and the switch is a no-op that
 * reports success. Either the artefact is rewritten and the supervisor reloaded, or `ExecStart`
 * points at a stable indirection that the switch flips; the record leaves that choice to phase 2
 * and §2.2 takes it.
 *
 * **§2.2 chose the rewrite, on a measurement.** The shell idiom for an atomic symlink flip —
 * `ln -sfn new tmp && mv -f tmp current` — **writes into the old runtime directory** when `current`
 * points at a directory, leaving the link untouched; `renameSync` does replace it atomically. So
 * the indirection is reachable on POSIX through exactly one call and the obvious way to write it is
 * wrong. The reason the rewrite wins is the one that survives review: **one mechanism for four
 * artefacts is fewer failure modes than two mechanisms for four**, and `temp → rename` in the
 * target's own directory is the operation three of the four already need — the unit, the launcher
 * and the mirrored task XML.
 *
 * **Every write here is idempotent**, which is what lets `recover.ts` resume by repeating rather
 * than by repairing. Rendering the same spec twice produces the same bytes; a rename over an
 * identical file changes nothing observable; `updateDaemonState` merges. A recovery that finds the
 * journal at `drained` therefore re-runs the whole switch without inspecting how far the last
 * attempt got.
 *
 * ## The reload, per platform, and why it is not the same as a start
 *
 * | Supervisor | After the rewrite | Why |
 * |---|---|---|
 * | systemd | `systemctl --user daemon-reload` | The manager caches unit files; a unit written a moment ago is not the unit the next `start` reads |
 * | launchd | `bootout` then `bootstrap` | `bootstrap` **does not refresh an already-loaded definition**, so a rewritten plist that was never booted out leaves launchd executing the previous one — `register.ts` states the same fact for a re-install |
 * | Task Scheduler | `Register-ScheduledTask -Xml … -Force` | A registered task is a copy Windows holds under `%SystemRoot%\System32\Tasks`; rewriting our own mirror changes nothing until the task is **re-registered**, and `-Force` is what makes that a replacement rather than a name collision |
 *
 * The boot-out on macOS is safe **because the drain has already happened**: the transaction stops
 * the daemon before it switches, so there is no running job for `bootout` to kill. The order is the
 * transaction's, not this module's, and it is the reason this module never has to think about a
 * process.
 */

import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import type { DaemonState, ProgramSource, SupervisorKind } from "../../daemon/daemon-state.js";
import { updateDaemonState } from "../../daemon/daemon-state.js";
import { flushDirectory } from "../../daemon/durable-write.js";
import { STATE_DIR_MODE } from "../../daemon/state-dir.js";
import type { LaunchSpec } from "../../runtime/launch-spec.js";
import { type WrittenLauncher, writeLauncher } from "../launcher.js";
import type { ProbeCommand, ProbeRunner } from "../preflight.js";
import type { ResolvedProgram } from "../program.js";
import {
  guiDomain,
  guiService,
  POWERSHELL,
  POWERSHELL_ARGV,
  REGISTRATION_TIMEOUT_MS,
  type RegistrationStep,
  type RegistrationTarget,
} from "../register.js";
import type { SupervisorArtefact, SupervisorEnvironment } from "../supervisors/artefact.js";
import { supervisorAdapter } from "../supervisors/index.js";

/**
 * The commands that make a supervisor read the artefact that was just rewritten.
 *
 * Not `registerCommands()`: that sequence also **starts** the daemon — `enable --now`, `kickstart`,
 * `Start-ScheduledTask` — and the transaction starts it as a separate, journalled step so that
 * "switched" and "started" are two boundaries a recovery can tell apart. What is left is the reload
 * itself, which on Windows is a re-registration because there is nothing else to reload.
 */
export function reloadCommands(target: RegistrationTarget): readonly RegistrationStep[] {
  switch (target.kind) {
    case "systemd":
      return [
        {
          title: "reload the user manager so it reads the unit just rewritten",
          command: { program: "systemctl", argv: ["--user", "daemon-reload"] },
        },
      ];
    case "launchd":
      return [
        {
          title: "bootout the loaded definition, because bootstrap does not refresh one",
          command: { program: "launchctl", argv: ["bootout", guiService(target)] },
          tolerated: true,
        },
        {
          title: "bootstrap the rewritten plist into this user's GUI domain",
          command: {
            program: "launchctl",
            argv: ["bootstrap", guiDomain(target.uid), target.artefact],
          },
        },
      ];
    case "task-scheduler":
      return [
        {
          title: "re-register the task from the rewritten XML, replacing the registered copy",
          command: {
            program: POWERSHELL,
            argv: [
              ...POWERSHELL_ARGV,
              // `-Encoding UTF8` for `register.ts`'s reason: the file is UTF-8 and the document
              // declares `UTF-16`, because the parser is handed the decoded string.
              `Register-ScheduledTask -Xml (Get-Content -Path ${quote(target.artefact)} -Raw ` +
                `-Encoding UTF8) -TaskName ${quote(target.identity)} -Force`,
            ],
          },
        },
      ];
  }
}

/**
 * Write a rendered artefact without ever publishing half of one.
 *
 * The temporary file is created in the artefact's **own** directory, because `rename` is atomic
 * only within a filesystem, and it carries this pid so two operations cannot collide on it. The
 * mode is set on the temporary file rather than after the rename, for `launcher.ts`'s reason: a
 * rename that published an unreadable unit and fixed it on the next line would give the supervisor
 * a window in which the file exists and cannot be used.
 */
export function writeArtefactAtomically(artefact: SupervisorArtefact): void {
  const directory = dirname(artefact.path);
  mkdirSync(directory, { recursive: true, mode: STATE_DIR_MODE });
  const temporary = join(directory, `.${basename(artefact.path)}.${String(process.pid)}.tmp`);
  try {
    writeFileSync(temporary, artefact.contents, { mode: artefact.mode });
    chmodSync(temporary, artefact.mode);
    renameSync(temporary, artefact.path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  flushDirectory(directory);
}

/** One command a switch ran, and what it answered. */
export type SwitchCommand = {
  title: string;
  command: string;
  status: number | null;
  tolerated: boolean;
};

/** A supervisor command refused, and the switch stopped where it was. */
export class SwitchRefusal extends Error {
  /** Every command that had run, in order, for the transcript a user is shown. */
  readonly commands: readonly SwitchCommand[];

  constructor(message: string, commands: readonly SwitchCommand[]) {
    super(message);
    this.name = "SwitchRefusal";
    this.commands = commands;
  }
}

/** What {@link switchRuntime} needs. Every outside fact is a parameter. */
export type SwitchRequest = {
  stateDir: string;
  /** Which supervisor holds the registration. */
  kind: SupervisorKind;
  /** The launch contract for the runtime being switched **to**. */
  spec: LaunchSpec;
  /** The program that contract names, for the stable launcher. */
  program: ResolvedProgram;
  /** The staged runtime directory being switched to. */
  runtimeDir: string;
  /** What `daemon.json`'s `program_source` should say afterwards. */
  programSource: ProgramSource;
  /** What `daemon.json`'s `installed_version` should say afterwards. */
  installedVersion: string | null;
  /** The port the artefact records. */
  port: number;
  /** The account and directories the artefact paths are built from. */
  environment: SupervisorEnvironment;
  /** The platform whose launcher form is written. Defaults to this process's. */
  platform?: NodeJS.Platform | undefined;
  /** The uid whose `gui/<uid>` domain a LaunchAgent lives in. */
  uid: number;
  /** How supervisor commands are run. A parameter, so one machine can exercise all three. */
  run: ProbeRunner;
  /** Told what each step is doing, as it happens. */
  log?: ((line: string) => void) | undefined;
};

/** What one switch did. */
export type SwitchOutcome = {
  /** The artefact that was written, with the exact bytes. */
  artefact: SupervisorArtefact;
  /** The stable launcher that was rewritten with it. */
  launcher: WrittenLauncher;
  /** The registration the reload addressed. */
  target: RegistrationTarget;
  /** Every reload command that ran, in order. */
  commands: readonly SwitchCommand[];
  /** The record as it stands after the switch. */
  daemon: DaemonState;
};

/**
 * Point the supervisor, the launcher and the record at one runtime, and make the supervisor read it.
 *
 * Used in both directions: the forward switch to the incoming runtime and the rollback to the
 * retained one are the same operation with a different launch contract, which is what keeps a
 * rollback from being a second implementation that is exercised only when something has already
 * gone wrong.
 *
 * @throws {SwitchRefusal} when a reload command could not be run or refused.
 */
export function switchRuntime(request: SwitchRequest): SwitchOutcome {
  const log = request.log ?? (() => undefined);
  const adapter = supervisorAdapter(request.kind);
  const artefact = adapter.render(request.spec, request.environment);

  log(`rewriting the ${request.kind} artefact at ${artefact.path}`);
  writeArtefactAtomically(artefact);

  log("rewriting the stable launcher");
  const launcher = writeLauncher({
    stateDir: request.stateDir,
    program: request.program,
    ...(request.platform === undefined ? {} : { platform: request.platform }),
  });

  // The record last of the three writes, and merged rather than replaced: `daemon.json` carries
  // fields this switch has no opinion about — the port a run really bound, the token file, the
  // linger and launchd bookkeeping an install decided — and an update that rewrote the document
  // would silently drop what `uninstall` reads.
  const daemon = updateDaemonState(request.stateDir, {
    supervisor_kind: request.kind,
    supervisor_artefact: artefact.path,
    runtime_dir: request.runtimeDir,
    launch_spec: request.spec,
    program_source: request.programSource,
    installed_version: request.installedVersion,
    port: request.port,
    token_file: request.spec.settings.tokenFile,
    socket_path: request.spec.settings.socket,
  });

  const target: RegistrationTarget = {
    kind: request.kind,
    identity: artefact.identity,
    artefact: artefact.path,
    uid: request.uid,
  };
  const commands: SwitchCommand[] = [];
  for (const entry of reloadCommands(target)) {
    log(`  ${entry.title}`);
    const answer = request.run({ ...entry.command, timeoutMs: REGISTRATION_TIMEOUT_MS });
    commands.push({
      title: entry.title,
      command: spell(entry.command),
      status: answer.status,
      tolerated: entry.tolerated === true && answer.status !== 0,
    });
    if (!answer.started || (answer.status !== 0 && entry.tolerated !== true)) {
      throw new SwitchRefusal(
        `${spell(entry.command)} ${
          answer.started ? `exited ${String(answer.status)}` : "could not be run"
        }: ${firstNonEmptyLine([answer.stderr, answer.stdout]) || "it said nothing"}. The ` +
          `artefact at ${artefact.path} has been rewritten and the supervisor has not read it, ` +
          `so the registration and the file on disk disagree.`,
        commands,
      );
    }
  }

  return { artefact, launcher, target, commands, daemon };
}

/** One command as a single line, which is how a transcript names it. */
function spell(command: ProbeCommand): string {
  return `${command.program} ${command.argv.join(" ")}`;
}

/** The first line with anything in it, out of the streams a command answered on. */
function firstNonEmptyLine(streams: readonly string[]): string {
  for (const stream of streams) {
    for (const line of stream.split("\n")) {
      if (line.trim() !== "") {
        return line.trim();
      }
    }
  }
  return "";
}

/**
 * A PowerShell single-quoted literal.
 *
 * The same escaping `register.ts` documents: a task name is `\xplainer\<user>-daemon`, PowerShell
 * expands nothing inside single quotes, and the one character to handle is the quote itself, which
 * it escapes by doubling.
 */
function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
