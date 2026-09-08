/**
 * `xplainer daemon uninstall`: deregister, remove everything the install wrote, **delete the token**,
 * and leave lingering exactly where it is.
 *
 * ## Deletion, not rotation
 *
 * Round 2 of the plan said `uninstall` "rotates the token" while P2-9 required "no live token", and
 * the two cannot both hold: rotation mints a new value and leaves it on disk. So `uninstall`
 * **deletes** the file, and `xplainer token rotate` is what a daemon that stays installed uses.
 * Nothing is left to be stolen, and P2-9 is satisfiable as the roadmap words it.
 *
 * ## Lingering is never disabled — not even lingering this project enabled
 *
 * `/var/lib/systemd/linger/$USER` is **per user, not per service**. A user who let an install
 * enable it may since have installed rootless Podman, a syncthing user unit or anything else that
 * depends on their manager surviving logout, and removing the marker would break every one of them
 * silently. `daemon.json` records that we enabled it, and this command *reports* it and prints the
 * one line that undoes it for a user who wants to. This is stronger than ADR 0020's "only then is
 * removal offered". The **rollback of a failed install** is the one case that removes the marker,
 * and it lives in `install.ts` because there the marker is seconds old and nothing has had time to
 * depend on it.
 *
 * ## The launchd record, and what launchctl can honestly be asked to do
 *
 * `install` runs `launchctl enable gui/<uid>/<label>` before it bootstraps, because a disable record
 * survives reboots and would otherwise make the job unloadable for a reason nothing names. That call
 * writes an entry into launchd's disable store — measured on macOS (Darwin 25.5.0) on 2026-09-08,
 * `launchctl print-disabled gui/$(id -u)` prints one line per label as `"<label>" => enabled` or
 * `"<label>" => disabled`.
 *
 * **launchctl has no verb that removes an entry from that store.** `launchctl help` lists `enable`
 * and `disable`, which *set* the value, and nothing that forgets a label; the store itself is
 * `/var/db/com.apple.xpc.launchd/disabled.<uid>.plist`, which is root-owned. So what this command
 * can honestly do, and does, is two things: **clear a `disabled` record for our label** — that is
 * the one that changes behaviour, and `launchctl enable` is its documented undo — and **report** an
 * `enabled` record that our install created and that cannot be removed. An `enabled` entry for a
 * label with no plist anywhere is inert: `enabled` is launchd's own default for an unknown label,
 * and there is no job for it to apply to. Saying that is better than pretending the store was left
 * untouched, and better than `launchctl disable`, which would "clean up" by creating exactly the
 * stale disable record the install preflight exists to warn about.
 *
 * ## What is deliberately kept
 *
 * `toolchain.json` and the workspace. The marker is `xplainer setup`'s and a re-install needs it;
 * `workspace/` holds the user's videos, their sources and their renders. An uninstall that removed
 * either would be a `setup --reset` wearing the wrong name.
 */

import { existsSync, rmdirSync, rmSync, statSync } from "node:fs";
import process from "node:process";
import { readDaemonState, type SupervisorKind } from "../daemon/daemon-state.js";
import { resolveIpcPath } from "../daemon/ipc.js";
import { stateDirLayout } from "../daemon/state-dir.js";
import { resolveTokenPath } from "../daemon/token.js";
import type { InstallCommand } from "./install.js";
import { LAUNCHER_DIR, launcherPath } from "./launcher.js";
import {
  currentSupervisorEnvironment,
  type LaunchdDisableRecord,
  type ProbeRunner,
  readDisableRecord,
  runProbe,
} from "./preflight.js";
import {
  deregisterCommands,
  guiService,
  REGISTRATION_TIMEOUT_MS,
  type RegistrationTarget,
} from "./register.js";
import { stagedRuntimeRoot } from "./stage.js";
import type { SupervisorEnvironment } from "./supervisors/artefact.js";
import {
  LAUNCH_AGENT_LABEL,
  supervisorAdapter,
  supervisorKindForPlatform,
} from "./supervisors/index.js";

/** One path an uninstall was responsible for, and what it found there. */
export type RemovedPath = {
  /** What it is, in the words the report uses. */
  what: string;
  path: string;
  /** Whether anything was there to remove. */
  existed: boolean;
  /** The failure, when something was there and could not be removed. */
  error?: string;
};

/** What happened to the launchd disable store, on the one platform that has one. */
export type LaunchdRecordOutcome = {
  applicable: boolean;
  /** What the store held for our label when this command looked. */
  before: LaunchdDisableRecord;
  /** Whether a `disabled` record was cleared with `launchctl enable`. */
  cleared: boolean;
  /** The sentence the report prints, including the one this command cannot act on. */
  detail: string;
};

/** What an uninstall did, complete enough to print and to assert on. */
export type UninstallOutcome = {
  stateDir: string;
  platform: NodeJS.Platform;
  /** The supervisor `daemon.json` recorded, or the platform's own when nothing was recorded. */
  supervisor: SupervisorKind | null;
  /** The name the supervisor addressed it by. */
  identity: string | null;
  /** Whether `daemon.json` described an install at all. */
  wasInstalled: boolean;
  /** Every deregistration command that ran, in order. */
  commands: readonly InstallCommand[];
  /** Every path this command was responsible for. */
  removed: readonly RemovedPath[];
  /** The token file: where it was, and whether it is gone. */
  token: { path: string; deleted: boolean };
  /** Lingering — reported, never removed. */
  linger: { applicable: boolean; marker: string; enabledByUs: boolean; detail: string };
  launchdRecord: LaunchdRecordOutcome;
};

/** What {@link uninstallDaemon} needs. Every outside fact is a parameter. */
export type UninstallRequest = {
  stateDir: string;
  platform?: NodeJS.Platform | undefined;
  env?: Readonly<Record<string, string | undefined>> | undefined;
  environment?: SupervisorEnvironment | undefined;
  run?: ProbeRunner | undefined;
  uid?: number | undefined;
  log?: ((line: string) => void) | undefined;
};

/**
 * Take the daemon back off this machine.
 *
 * Idempotent by construction: every removal reports whether anything was there, and a state
 * directory that was never installed into produces a report of absences and exits `0`. There is no
 * refusal path, because "it is already not installed" is the state this command is asked for.
 */
export function uninstallDaemon(request: UninstallRequest): UninstallOutcome {
  const platform = request.platform ?? process.platform;
  const env = request.env ?? process.env;
  const run = request.run ?? runProbe;
  const uid = request.uid ?? process.getuid?.() ?? 0;
  const log = request.log ?? (() => undefined);
  const environment = request.environment ?? currentSupervisorEnvironment(env, undefined, platform);
  const layout = stateDirLayout(request.stateDir);
  const state = readDaemonState(request.stateDir);
  const commands: InstallCommand[] = [];

  // The recorded kind first, because it is what this machine was *actually* installed with; the
  // platform's own is the answer for a state directory whose `daemon.json` is gone but whose plist
  // or unit may not be.
  const kind = state.supervisor_kind ?? supervisorKindForPlatform(platform);
  const adapter = kind === null ? null : supervisorAdapter(kind);
  const artefact =
    state.supervisor_artefact ??
    (adapter === null ? null : attempt(() => adapter.artefactPath(environment)));
  const identity = adapter === null ? null : attempt(() => adapter.identity(environment));
  const wasInstalled = state.supervisor_kind !== null || state.runtime_dir !== null;

  // ── Deregister first, so nothing is holding the files that are about to go ───────────────────
  if (kind !== null && identity !== null && artefact !== null) {
    const target: RegistrationTarget = { kind, identity, artefact, uid };
    log(`deregistering ${identity} from ${kind}`);
    for (const entry of deregisterCommands(target)) {
      const answer = run({ ...entry.command, timeoutMs: REGISTRATION_TIMEOUT_MS });
      commands.push({
        title: entry.title,
        command: `${entry.command.program} ${entry.command.argv.join(" ")}`,
        status: answer.status,
        tolerated: entry.tolerated === true && answer.status !== 0,
      });
    }
  }

  // ── Then everything the install put on disk ──────────────────────────────────────────────────
  const removed: RemovedPath[] = [];
  const remove = (what: string, path: string | null): void => {
    if (path === null) {
      return;
    }
    if (removed.some((entry) => entry.path === path)) {
      return;
    }
    const existed = existsSync(path);
    try {
      rmSync(path, { recursive: true, force: true });
      removed.push({ what, path, existed });
    } catch (error) {
      removed.push({
        what,
        path,
        existed,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  remove(`the ${kind ?? "supervisor"} artefact`, artefact);
  remove("this run's ephemeral record", layout.runtimeState);
  remove("the ownership artefact", layout.lock);
  remove("the IPC socket", state.socket_path);
  remove("the IPC socket", resolveIpcPath(request.stateDir, platform));
  remove("every staged runtime", stagedRuntimeRoot(request.stateDir));
  remove("the stable launcher", launcherPath(request.stateDir, platform));
  removeEmptyDirectory(`${request.stateDir}/${LAUNCHER_DIR}`);
  // Last of the state files, because everything above reads it.
  remove("the installer's record", layout.daemonState);

  // ── The token, deleted rather than rotated ───────────────────────────────────────────────────
  const tokenPath = state.token_file ?? resolveTokenPath(request.stateDir, env);
  const tokenExisted = existsSync(tokenPath);
  rmSync(tokenPath, { force: true });
  const token = { path: tokenPath, deleted: !existsSync(tokenPath) };
  removed.push({ what: "the bearer token", path: tokenPath, existed: tokenExisted });

  // ── Lingering: reported, never removed ───────────────────────────────────────────────────────
  const lingerUser = environment.account;
  const lingerMarker = `/var/lib/systemd/linger/${lingerUser}`;
  const lingerApplicable = platform === "linux";
  const lingerEnabledByUs = state.linger_enabled_by_us === true;
  const linger = {
    applicable: lingerApplicable,
    marker: lingerMarker,
    enabledByUs: lingerEnabledByUs,
    detail: !lingerApplicable
      ? "lingering is a systemd concept and does not exist on this platform"
      : lingerEnabledByUs
        ? `this install enabled lingering for ${lingerUser}, and ${lingerMarker} is deliberately ` +
          "left in place: lingering is per user, not per service, and anything else you have " +
          "since arranged to survive logout depends on it. If nothing does, remove it with:\n\n" +
          `  loginctl disable-linger ${lingerUser}\n`
        : `lingering was not enabled by this install, so ${lingerMarker} is left exactly as it was`,
  };

  const launchdRecord = clearLaunchdRecord(platform, uid, run, state.launchd_enable_record_created);

  return {
    stateDir: request.stateDir,
    platform,
    supervisor: kind,
    identity,
    wasInstalled,
    commands,
    removed,
    token,
    linger,
    launchdRecord,
  };
}

/**
 * Clear a `disabled` record for our label, and say what is left that cannot be cleared.
 *
 * See this module's header for the measurement: `launchctl` sets a record's value and never removes
 * the record, so "clear" means the one thing that changes behaviour.
 */
function clearLaunchdRecord(
  platform: NodeJS.Platform,
  uid: number,
  run: ProbeRunner,
  createdByUs: boolean | null,
): LaunchdRecordOutcome {
  if (platform !== "darwin") {
    return {
      applicable: false,
      before: "absent",
      cleared: false,
      detail: "launchd disable records exist only on macOS",
    };
  }
  const domain = `gui/${String(uid)}`;
  const answer = run({ program: "launchctl", argv: ["print-disabled", domain] });
  if (!answer.started || answer.status !== 0) {
    return {
      applicable: true,
      before: "absent",
      cleared: false,
      detail: `\`launchctl print-disabled ${domain}\` did not answer, so no record could be read`,
    };
  }
  const before = readDisableRecord(answer.stdout, LAUNCH_AGENT_LABEL);
  if (before === "disabled") {
    const target: RegistrationTarget = {
      kind: "launchd",
      identity: LAUNCH_AGENT_LABEL,
      artefact: "",
      uid,
    };
    run({ program: "launchctl", argv: ["enable", guiService(target)] });
    return {
      applicable: true,
      before,
      cleared: true,
      detail:
        `${LAUNCH_AGENT_LABEL} was recorded as disabled in ${domain}; that record has been ` +
        "cleared, so a later install is not refused by a switch nobody remembers flipping",
    };
  }
  if (before === "enabled") {
    return {
      applicable: true,
      before,
      cleared: false,
      detail:
        `${domain} still holds an \`enabled\` entry for ${LAUNCH_AGENT_LABEL}` +
        `${createdByUs === true ? ", which this install created" : ""}. launchctl has no verb ` +
        "that removes an entry from the disable store — `enable` and `disable` set its value and " +
        "there is no third one — so it is left. It is inert: `enabled` is launchd's own default " +
        "for a label it knows nothing about, and there is no longer a plist for it to apply to.",
    };
  }
  return {
    applicable: true,
    before,
    cleared: false,
    detail: `${domain} holds no record for ${LAUNCH_AGENT_LABEL} at all`,
  };
}

/** Remove a directory this project made, but only while it is empty. */
function removeEmptyDirectory(path: string): void {
  try {
    if (statSync(path).isDirectory()) {
      rmdirSync(path);
    }
  } catch {
    // Absent, or not empty — a directory somebody else put something in is not this command's.
  }
}

/** A path a renderer can build, or `null` when the environment cannot produce one. */
function attempt(build: () => string): string | null {
  try {
    return build();
  } catch {
    return null;
  }
}
