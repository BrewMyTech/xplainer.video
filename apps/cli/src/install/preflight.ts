/**
 * Everything `daemon install` asks **before it writes anything**, and it writes nothing itself.
 *
 * [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md) §Degraded paths states the
 * rule this module is: "**probe before writing; on refusal, write nothing, exit with the documented
 * code, and print the one command that fixes it.** A design that silently needs sudo fails at
 * install time; a design that silently installs half a daemon fails three days later, which is
 * worse." It then lists what is probed — "the setup marker, the supervisor, the executability of
 * the resolved program, the port, lingering, any stale `launchctl disable` record, and the token
 * file — all without root". Those are the seven probes below, in that order.
 *
 * **Read-only is a property of this file, not an aspiration.** The preflight *reads*
 * `test -e /var/lib/systemd/linger/$USER` and never attempts `loginctl enable-linger`, because
 * enabling lingering is a **write** — it creates that marker — inside the phase whose whole
 * contract is that a refusal leaves the machine exactly as it was. An earlier draft had this file
 * enable lingering and then verify the marker, which would have made the detector its own
 * violation. The split that ships: the preflight reports the marker's absence as a *fact*, and the
 * writing phase attempts `loginctl --no-ask-password enable-linger`, records
 * `linger_enabled_by_us` on success, and exits `5` on failure — so pre-existing supervisor
 * configuration is preserved rather than overwritten, and an install that refuses has touched
 * nothing to roll back.
 *
 * The three commands this file *does* run — `systemctl --user is-system-running`,
 * `launchctl print-disabled gui/<uid>`, `schtasks /Query` — are queries. None of them registers,
 * enables, starts or writes; each is the read that answers a question no filesystem check can.
 *
 * **The supervisor is detected by `/run/systemd/system` and never by `command -v systemctl`.**
 * That directory is what `sd_booted(3)` itself checks, and the alternative is wrong on the machines
 * this design exists for: Debian and Ubuntu base images ship the `systemctl` binary without systemd
 * as PID 1, so a `command -v` probe reports a supervisor on exactly the container where installing
 * into one is impossible. Its presence is still not sufficient, which is the second half of the
 * same check: a booted system says nothing about whether **this user** has a manager to register a
 * unit with, and `systemctl --user is-system-running` is the question that does — the same probe
 * spike P2-S4 used to establish that its measurements ran against a per-user instance.
 *
 * **What it refuses with, and what it merely reports.** Four conditions end an install, each with a
 * code the table in `docs/ARCHITECTURE.md` §6 already carries: `3` when `setup` has not run or its
 * recorded paths are gone, and when the resolved program is not executable; `6` when there is no
 * user service manager and when Task Scheduler will not accept a registration, both leading with
 * `xplainer connect claude --spawn`, which needs no supervisor at all; `7` when the port this
 * install would record is already held. Lingering denied and the missing batch-logon right are
 * `5`s that belong to the **writing** phase, because neither can be established without attempting
 * the thing — they are named here so the two halves read as one table and not as two.
 *
 * A stale `launchctl` disable record and the token file are *facts*, not refusals: a disabled label
 * is something the user or a policy switched off and the fix is one command, and a token file is
 * minted by the first `serve` rather than by an install. Reporting them is what lets
 * `daemon status` say, in ADR 0020's own words, "you or a policy switched this off in Login Items
 * & Extensions".
 *
 * Nothing here decides *what* to install: the launch spec and the resolved program are parameters,
 * so this module never spawns a package manager, never stages a payload, and can be run against a
 * machine it is not going to install on.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, userInfo } from "node:os";
import { dirname, join, win32 } from "node:path";
import process from "node:process";
import type { Toolchain, ToolchainComponent } from "@xplainer/protocol";
import type { SupervisorKind } from "../daemon/daemon-state.js";
import {
  INSTALL_CONFLICT_EXIT_CODE,
  NO_SUPERVISOR_EXIT_CODE,
  PRECONDITION_UNMET_EXIT_CODE,
} from "../daemon/exit-codes.js";
import { resolveTokenPath } from "../daemon/token.js";
import type { ResolvedProgram } from "./program.js";
import type { SupervisorEnvironment } from "./supervisors/artefact.js";
import {
  LAUNCH_AGENT_LABEL,
  launchAgentLogPath,
  supervisorAdapter,
  supervisorKindForPlatform,
  TASK_FOLDER,
} from "./supervisors/index.js";

/** The marker `setup` writes, and the first file an install reads. */
export const TOOLCHAIN_MARKER_FILE = "toolchain.json";

/** The shape of {@link TOOLCHAIN_MARKER_FILE} this build knows how to read. */
export const TOOLCHAIN_FORMAT_VERSION = 1;

/** What `sd_booted(3)` checks, and therefore what this does. Never `command -v systemctl`. */
export const SYSTEMD_BOOTED_DIR = "/run/systemd/system";

/** Where systemd records that a user's services may outlive their login session. */
export const LINGER_MARKER_DIR = "/var/lib/systemd/linger";

/**
 * The remediation both `6`s lead with.
 *
 * It is first in those messages because it is the one that works: it needs no supervisor, no
 * administrator and no daemon, and it delivers the tools. What is lost is the warm process, the
 * shared job queue and the desktop client — not the product.
 */
export const SPAWN_REMEDIATION = "xplainer connect claude --spawn";

/** How long a probe command may take before it is treated as no answer at all. */
export const PROBE_TIMEOUT_MS = 5_000;

/** Why the preflight refused. One value per distinguishable condition, never a catch-all. */
export type PreflightConditionCode =
  | "setup-absent"
  | "setup-unreadable"
  | "setup-paths-gone"
  | "no-user-manager"
  | "registration-blocked"
  | "program-not-executable"
  | "port-held";

/** One condition that stops an install, with the code and the sentence it exits on. */
export type PreflightRefusal = {
  /** Which condition. */
  code: PreflightConditionCode;
  /** The documented exit code for it. Nothing here invents one. */
  exitCode: number;
  /** What is wrong, and the one command that fixes it. */
  message: string;
};

/** One command a probe runs, named rather than assembled at the call site. */
export type ProbeCommand = {
  program: string;
  argv: readonly string[];
  /**
   * How long it may take, when {@link PROBE_TIMEOUT_MS} is not enough.
   *
   * Every probe in this file is a `stat`, a read or a one-line query and fits the default. The
   * registration commands in `register.ts` go through the same runner and do not: `systemctl --user
   * enable --now` starts the daemon and returns when it is up, and `launchctl bootstrap` loads a
   * job. Five seconds there would report a working install as an unanswered command.
   */
  timeoutMs?: number | undefined;
};

/** What running one produced. A command that could not start is an answer, not an error. */
export type ProbeResult = {
  /**
   * Whether the program ran to completion.
   *
   * `false` covers both "there is no such program here" and "it did not answer inside
   * {@link PROBE_TIMEOUT_MS}", because the sentence a user is shown is the same either way: this
   * preflight could not get the supervisor to say anything about itself.
   */
  started: boolean;
  /** Its exit status, or `null` when a signal ended it or it never started. */
  status: number | null;
  stdout: string;
  stderr: string;
};

/** How a probe reaches the outside world. A parameter, so all three platforms are testable here. */
export type ProbeRunner = (command: ProbeCommand) => ProbeResult;

/**
 * Run a probe, and treat "there is no such program" as a result.
 *
 * `connect/vendor-cli.ts` spawns somebody else's CLI and **throws** when it cannot start, because
 * there the caller looked the binary up on `PATH` first and its disappearance is a surprise. Here
 * the absence of `systemctl`, `launchctl` or `schtasks` is one of the answers being asked for, so a
 * failed spawn is reported rather than raised. Both streams are captured, because the sentence a
 * supervisor refuses with is the sentence a user has to be shown.
 */
export function runProbe(command: ProbeCommand): ProbeResult {
  const result = spawnSync(command.program, [...command.argv], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: command.timeoutMs ?? PROBE_TIMEOUT_MS,
  });
  return {
    started: result.error === undefined,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** The setup marker, and whether what it recorded is still on this machine. */
export type ToolchainProbe = {
  /** `<state>/toolchain.json`. */
  path: string;
  /** The marker, when it is present and this build can read it. */
  marker: Toolchain | null;
  /** Its `format_version`, even when that is one this build does not know. */
  formatVersion: number | null;
  /** Whether the marker was written by a newer build. A rollback signal, never corruption. */
  newerFormat: boolean;
  /** The recorded paths that are no longer there, in the order the marker names them. */
  missing: readonly string[];
  refusal: PreflightRefusal | null;
};

/** Whether this machine has a supervisor **this user** can register a daemon with. */
export type SupervisorProbe = {
  /** The kind this platform uses, or `null` on a platform with no renderer. */
  kind: SupervisorKind | null;
  /** Whether the supervisor itself is running here — for Linux, `sd_booted(3)`'s own check. */
  present: boolean;
  /** Whether a **user** manager answered. Presence does not imply this, which is the point. */
  usable: boolean;
  /** What was probed and what it said, for the message and for `daemon status`. */
  detail: string;
  /** The artefact path an install would write, so a caller can hash it and prove nothing moved. */
  artefact: string | null;
  /** The directory that artefact lives in — `~/Library/LaunchAgents`, and its two counterparts. */
  artefactDir: string | null;
  /**
   * The supervisor's **own** registry, where it has one this install can reach.
   *
   * `%SystemRoot%\System32\Tasks\xplainer` on Windows, where `Register-ScheduledTask` puts the
   * task document it keeps; `null` on the other two, where the artefact *is* the registration and
   * there is no second copy. It is here so a refusal check can hash the place a registration would
   * appear rather than only the file this process would write.
   */
  store: string | null;
  /** Where the job's output goes, when it is a directory rather than a journal. */
  logDir: string | null;
  /** The name this supervisor's own tooling would address the daemon by. */
  identity: string | null;
  refusal: PreflightRefusal | null;
};

/** Whether the program the supervisor would be given can actually be run. */
export type ProgramProbe = {
  /** The interpreter, from the launch spec, or `null` when no spec was offered. */
  executable: string | null;
  /** The entry file it is given, or `null` when the executable is the CLI itself. */
  entry: string | null;
  /** Whether {@link ProgramProbe.executable} exists and this user may execute it. */
  executableOk: boolean;
  /** Whether {@link ProgramProbe.entry} exists and this user may read it. */
  entryOk: boolean;
  refusal: PreflightRefusal | null;
};

/** Whether the port this install would record can be bound. */
export type PortProbe = {
  /** The port that would be recorded. `0` is an ephemeral-port request and is never held. */
  port: number;
  /** Whether something is already listening there. */
  held: boolean;
  /** The pid holding it, when this machine has a tool that names one. */
  holder: number | null;
  /** The holder in words — its pid and command, or why neither could be established. */
  holderDetail: string;
  refusal: PreflightRefusal | null;
};

/** systemd lingering, read and never written. */
export type LingerProbe = {
  /** `false` on every platform but Linux, where the concept does not exist. */
  applicable: boolean;
  /** The account the marker would be named after. */
  user: string;
  /** `/var/lib/systemd/linger/<user>`. */
  marker: string;
  /** Whether that file is there. Absent is not yet a failure: it is what the writing phase acts on. */
  enabled: boolean;
};

/**
 * What the launchd disable store holds for one label.
 *
 * Three values rather than a boolean, because `install` and `uninstall` need to tell "there is no
 * record" from "there is a record and it says enabled": `launchctl enable` **creates** an entry
 * where there was none, and only an install that knows which of the two it met can say afterwards
 * what it changed.
 */
export type LaunchdDisableRecord = "disabled" | "enabled" | "absent";

/** A `launchctl` disable record, which persists across reboots and is otherwise invisible. */
export type DisabledProbe = {
  /** `false` on every platform but macOS. */
  applicable: boolean;
  /** Whether `launchctl print-disabled` answered at all. */
  probed: boolean;
  /** Whether **our** label is recorded as disabled. */
  disabled: boolean;
  /** What the store holds for our label. `absent` when the probe did not answer. */
  record: LaunchdDisableRecord;
  /** What was found, and the one command that undoes it. */
  detail: string;
};

/** The bearer token file: a fact, because `serve` mints one and an install does not. */
export type TokenProbe = {
  /** Where it lives, after `XPLAINER_TOKEN_FILE` and the state directory have had their say. */
  path: string;
  /** Whether it is already there. */
  present: boolean;
  /** Whether this user can read it, when it is. */
  readable: boolean;
  detail: string;
};

/** Everything the preflight established, and the refusals in the order they were found. */
export type InstallPreflight = {
  platform: NodeJS.Platform;
  stateDir: string;
  /** The account and directories every artefact path above was built from. */
  environment: SupervisorEnvironment;
  toolchain: ToolchainProbe;
  supervisor: SupervisorProbe;
  program: ProgramProbe;
  port: PortProbe;
  linger: LingerProbe;
  disabled: DisabledProbe;
  token: TokenProbe;
  /** Every refusal, in probe order. The first one is what an install exits with. */
  refusals: readonly PreflightRefusal[];
  /** Whether an install may proceed to its writing phase. */
  ok: boolean;
};

/** What {@link preflightInstall} weighs. Every outside fact is a parameter. */
export type PreflightRequest = {
  /** The durable state directory this install would use. */
  stateDir: string;
  /** The port it would record. */
  port: number;
  /**
   * The program the launch contract would name, when one has been resolved.
   *
   * The *program* rather than the `LaunchSpec` because they are the same two files —
   * `buildLaunchSpec` puts `ResolvedProgram.executable` in `executable` and `ResolvedProgram.entry`
   * at `argv[0]` — and only the program says which of them is an interpreter and which is a file to
   * read. A spec whose `argv[0]` was a subcommand rather than a path would otherwise be probed for
   * readability and fail for being a word.
   */
  program?: ResolvedProgram | null | undefined;
  /** The platform whose supervisor is asked about. Defaults to this process's. */
  platform?: NodeJS.Platform | undefined;
  /** The environment `XPLAINER_TOKEN_FILE` and the artefact paths are read from. */
  env?: Readonly<Record<string, string | undefined>> | undefined;
  /** The account and directories the artefact paths are built from. */
  environment?: SupervisorEnvironment | undefined;
  /** How probe commands are run. A parameter so one machine can exercise all three platforms. */
  run?: ProbeRunner | undefined;
  /** The address the port is probed on. Loopback, which is where the daemon binds. */
  host?: string | undefined;
};

/** The account and directories this process would install for. */
export function currentSupervisorEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): SupervisorEnvironment {
  return {
    home,
    account: accountName(env, platform),
    configHome: env.XDG_CONFIG_HOME,
    localAppData: env.LOCALAPPDATA,
    systemRoot: env.SystemRoot ?? env.SYSTEMROOT,
  };
}

/** `<state>/toolchain.json`. */
export function toolchainMarkerPath(stateDir: string): string {
  return join(stateDir, TOOLCHAIN_MARKER_FILE);
}

/**
 * Ask every question, in ADR 0020's order, and answer without touching anything.
 *
 * It is `async` for one reason: establishing whether a port is free means trying to bind it, and
 * there is no synchronous way to do that in Node. Every other probe is a `stat`, a read or a query.
 */
export async function preflightInstall(request: PreflightRequest): Promise<InstallPreflight> {
  const platform = request.platform ?? process.platform;
  const env = request.env ?? process.env;
  const run = request.run ?? runProbe;
  const environment = request.environment ?? currentSupervisorEnvironment(env, homedir(), platform);
  const bootedDir = environment.systemdBooted ?? SYSTEMD_BOOTED_DIR;
  const lingerDir = environment.lingerDir ?? LINGER_MARKER_DIR;

  // One `launchctl print-disabled` for both macOS questions. Whether a GUI domain exists at all
  // and whether it holds a disable record for our label are two readings of one answer, and asking
  // twice would be two subprocesses saying the same thing.
  const domain = platform === "darwin" ? probeLaunchdDomain(run) : null;

  const toolchain = probeToolchain(request.stateDir);
  // Lingering is read before the supervisor, not after it, because it is half of the *supervisor's*
  // answer on Linux: a user with no session and no linger marker has no per-user manager at all,
  // and the remediation for that is `loginctl enable-linger` rather than "this machine has none".
  // Measured in `infra/e2e/Dockerfile.systemd` on 2026-09-08: with lingering off and no login,
  // `systemctl --user is-system-running` answers "Failed to connect to bus".
  const linger = probeLinger(platform, environment.account, lingerDir);
  const supervisor = probeSupervisor(platform, environment, run, domain, bootedDir, linger);
  const program = probeProgram(request.program ?? null);
  const port = await probePort(request.port, request.host ?? "127.0.0.1", platform, run);
  const disabled = probeDisabled(platform, domain);
  const token = probeToken(request.stateDir, env);

  const refusals = [toolchain.refusal, supervisor.refusal, program.refusal, port.refusal].filter(
    (refusal): refusal is PreflightRefusal => refusal !== null,
  );

  return {
    platform,
    stateDir: request.stateDir,
    environment,
    toolchain,
    supervisor,
    program,
    port,
    linger,
    disabled,
    token,
    refusals,
    ok: refusals.length === 0,
  };
}

/**
 * Every path an install could write to, so a caller can hash them and prove a refusal did not.
 *
 * P2-10's obligation is that a refused install leaves the machine as it was, and "as it was" is
 * checkable only against a list of the places it could have changed. Six kinds of place, and the
 * list is deliberately wider than the files this process writes:
 *
 * - the **state directory**, which holds the staged runtime, the launcher and every state file;
 * - the supervisor's **artefact** — the unit, the plist or the task XML;
 * - the **directory that artefact lives in**, so a file created beside it is caught too:
 *   `~/Library/LaunchAgents` is the one T11's own criterion names;
 * - the **task store**, `%SystemRoot%\System32\Tasks\xplainer`, which is where a Windows
 *   *registration* actually appears and is written by Task Scheduler rather than by this process;
 * - the **linger marker**, `/var/lib/systemd/linger/$USER`, the one write the round-1 design
 *   smuggled into the read-only phase;
 * - the **log directory**, `~/Library/Logs/xplainer`, which launchd creates for `StandardOutPath`
 *   the moment a job is loaded — so a plist that was bootstrapped and then rolled back leaves a
 *   trace there and nowhere else.
 *
 * Ordered from this project's own paths outwards, and de-duplicated, because a hash map keyed by
 * path would otherwise report one directory twice on a machine where two of them coincide.
 */
export function preflightWriteLocations(preflight: InstallPreflight): readonly string[] {
  const locations = [preflight.stateDir];
  if (preflight.supervisor.artefact !== null) {
    locations.push(preflight.supervisor.artefact);
  }
  if (preflight.supervisor.artefactDir !== null) {
    locations.push(preflight.supervisor.artefactDir);
  }
  if (preflight.supervisor.store !== null) {
    locations.push(preflight.supervisor.store);
  }
  if (preflight.linger.applicable) {
    locations.push(preflight.linger.marker);
  }
  if (preflight.supervisor.logDir !== null) {
    locations.push(preflight.supervisor.logDir);
  }
  return [...new Set(locations)];
}

/**
 * The directory a rendered artefact lives in, in the path grammar the artefact was composed in.
 *
 * `dirname` from `node:path` is the **host's**, and the Task Scheduler renderer answers with a
 * `win32.join`ed path: on macOS or Linux that string carries no `/` at all, so the host's `dirname`
 * answers `"."` — the current working directory — and `preflightWriteLocations` then reports the
 * checkout as a place an install writes to. `install.test.ts` hashes every one of those locations
 * either side of a refusal, so it was hashing this repository, and under `turbo` — which writes
 * `apps/cli/.turbo/turbo-*.log` while the suite runs — the two hashes differed and the case failed
 * for a reason that had nothing to do with the install. The two POSIX renderers compose with the
 * host's `join`, so the host's `dirname` is the right one for them.
 */
function artefactDirectory(platform: NodeJS.Platform, artefact: string): string {
  return platform === "win32" ? win32.dirname(artefact) : dirname(artefact);
}

/** The setup marker: present, readable, complete, and still describing files that exist. */
function probeToolchain(stateDir: string): ToolchainProbe {
  const path = toolchainMarkerPath(stateDir);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const absent = error instanceof Error && "code" in error && error.code === "ENOENT";
    return {
      path,
      marker: null,
      formatVersion: null,
      newerFormat: false,
      missing: [],
      refusal: {
        code: absent ? "setup-absent" : "setup-unreadable",
        exitCode: PRECONDITION_UNMET_EXIT_CODE,
        message: absent
          ? `no toolchain marker at ${path}, so \`xplainer setup\` has not run on this machine. ` +
            "Neither this command nor the daemon ever downloads — a several-hundred-megabyte " +
            "fetch is an explicit, interruptible step and not something a background service " +
            "does on someone's tethered connection — so an install here would register a daemon " +
            "that answers /healthz and fails every render. Nothing was written. Run:\n\n" +
            "  xplainer setup\n"
          : `${path} exists and cannot be read (` +
            `${error instanceof Error ? error.message : String(error)}). It is the record of what ` +
            "`xplainer setup` acquired, and an install that could not read it would be " +
            "registering a daemon whose render toolchain is unknown. Nothing was written. Fix " +
            "the file's permissions, or run:\n\n  xplainer setup\n",
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      path,
      marker: null,
      formatVersion: null,
      newerFormat: false,
      missing: [],
      refusal: {
        code: "setup-unreadable",
        exitCode: PRECONDITION_UNMET_EXIT_CODE,
        message:
          `${path} is not valid JSON (` +
          `${error instanceof Error ? error.message : String(error)}), so what \`xplainer setup\` ` +
          "left behind cannot be established. Nothing was written. Run:\n\n  xplainer setup\n",
      },
    };
  }

  const formatVersion = readFormatVersion(parsed);
  const marker = readMarker(parsed);
  if (marker === null) {
    return {
      path,
      marker: null,
      formatVersion,
      newerFormat: formatVersion !== null && formatVersion > TOOLCHAIN_FORMAT_VERSION,
      missing: [],
      refusal: {
        code: "setup-unreadable",
        exitCode: PRECONDITION_UNMET_EXIT_CODE,
        message:
          `${path} does not record a complete toolchain: it is missing, or holds a value of the ` +
          "wrong shape for, one of `chrome`, `speech` or `workspace` — each of which needs a " +
          "version, an absolute path, a sha256 and the provider that acquired it. An install " +
          "reads this to know the render toolchain is really here. Nothing was written. Run:" +
          "\n\n  xplainer setup\n",
      },
    };
  }

  const missing = [marker.chrome.path, marker.speech.path].filter((entry) => !existsSync(entry));
  return {
    path,
    marker,
    formatVersion,
    newerFormat: formatVersion !== null && formatVersion > TOOLCHAIN_FORMAT_VERSION,
    missing,
    refusal:
      missing.length === 0
        ? null
        : {
            code: "setup-paths-gone",
            exitCode: PRECONDITION_UNMET_EXIT_CODE,
            message:
              `${path} records a toolchain whose files are no longer on this machine: ` +
              `${missing.join(", ")}. The marker says setup ran; the paths say what it produced ` +
              "has since been moved or cleaned away, and a daemon installed now would fail every " +
              "render with a missing binary. Nothing was written. Run:\n\n  xplainer setup\n",
          },
  };
}

/** The supervisor, and whether **this user** has a manager to register with. */
function probeSupervisor(
  platform: NodeJS.Platform,
  environment: SupervisorEnvironment,
  run: ProbeRunner,
  domain: LaunchdDomain | null,
  bootedDir: string,
  linger: LingerProbe,
): SupervisorProbe {
  const kind = supervisorKindForPlatform(platform);
  if (kind === null) {
    return {
      kind: null,
      present: false,
      usable: false,
      detail: `${platform} has none of the three supervisors this daemon can be installed into`,
      artefact: null,
      artefactDir: null,
      store: null,
      logDir: null,
      identity: null,
      refusal: noSupervisorRefusal(
        `this is ${platform}, and an always-running daemon is arranged here through a systemd ` +
          "user unit, a LaunchAgent or a Windows Scheduled Task — none of which this platform has.",
        null,
      ),
    };
  }

  const adapter = supervisorAdapter(kind);
  // A renderer refuses an environment it cannot compose a path from — a blank account, a Windows
  // machine with no `%LOCALAPPDATA%` — and a preflight that let that refusal escape would report an
  // exception where it owes a sentence. Both are answers here, and `null` is one of them.
  const artefact = attemptPath(() => adapter.artefactPath(environment));
  const identity = attemptPath(() => adapter.identity(environment));
  const state = supervisorState(platform, run, domain, bootedDir, linger);
  return {
    kind,
    present: state.present,
    usable: state.usable,
    detail: state.detail,
    artefact,
    artefactDir: artefact === null ? null : artefactDirectory(platform, artefact),
    store: taskStorePath(kind, environment),
    logDir: kind === "launchd" ? attemptPath(() => dirname(launchAgentLogPath(environment))) : null,
    identity,
    refusal: state.usable
      ? null
      : state.blocked
        ? {
            code: "registration-blocked",
            exitCode: NO_SUPERVISOR_EXIT_CODE,
            message:
              `Task Scheduler will not accept a registration from this session: ${state.detail}. ` +
              "That is the one supervisor Windows offers a per-user daemon, so there is nothing " +
              "to install into and nothing was written.\n\n" +
              `  ${SPAWN_REMEDIATION}\n\n` +
              "writes a stdio entry that starts `xplainer mcp` inside each agent session, needs " +
              "no supervisor at all, and delivers the tools; what it costs is the warm process, " +
              "the shared job queue and the desktop client.",
          }
        : noSupervisorRefusal(state.detail, state.lingerFirst === true ? linger : null),
  };
}

/** The `6` both no-supervisor conditions end with, worded once. */
function noSupervisorRefusal(detail: string, linger: LingerProbe | null): PreflightRefusal {
  // The one case where `--spawn` is *not* the leading remediation: systemd is here, the manager is
  // only absent because nothing has started one, and one command brings it back for good.
  if (linger !== null) {
    return {
      code: "no-user-manager",
      exitCode: NO_SUPERVISOR_EXIT_CODE,
      message:
        `no user service manager is running here: ${detail}. On this machine that is a ` +
        `consequence rather than a limitation — ${linger.marker} does not exist, so this user's ` +
        "manager is not started at boot and stops with their last session. Enabling lingering is " +
        "what starts one and what makes the daemon survive a reboot with nobody logged in, and it " +
        "is the one step of an install that needs an administrator. Nothing was written. Run:\n\n" +
        `  sudo loginctl enable-linger ${linger.user}\n\n` +
        "and install again. If lingering is not something this machine will allow, " +
        `\`${SPAWN_REMEDIATION}\` writes a stdio entry that starts \`xplainer mcp\` inside each ` +
        "agent session and needs no supervisor at all.",
    };
  }
  return {
    code: "no-user-manager",
    exitCode: NO_SUPERVISOR_EXIT_CODE,
    message:
      `no user service manager is available here: ${detail}. An always-running daemon cannot be ` +
      "arranged by this command on this machine, and nothing was written.\n\n" +
      `  ${SPAWN_REMEDIATION}\n\n` +
      "writes a stdio entry that starts `xplainer mcp` inside each agent session, needs no " +
      "supervisor at all, and delivers the tools; what it costs is the warm process, the shared " +
      "job queue and the desktop client, not the tools themselves. `docs/daemon.md` carries the " +
      "self-supervision recipes — Docker `--restart unless-stopped`, OpenRC `supervise-daemon` — " +
      "for a machine that wants one anyway.",
  };
}

/** What one platform's supervisor says about itself, as three answers rather than one. */
type SupervisorState = {
  present: boolean;
  usable: boolean;
  /**
   * Whether the manager is absent *because* lingering is, which changes the remediation entirely.
   *
   * Linux only, and only when systemd booted the machine, the user manager did not answer, and
   * `/var/lib/systemd/linger/$USER` is not there. Then "there is no supervisor here" is wrong:
   * there is one, nothing has started it for this user, and `loginctl enable-linger` is the fix.
   */
  lingerFirst?: boolean;
  /** Windows only: the supervisor is here and refused, which is a different sentence. */
  blocked: boolean;
  detail: string;
};

/** The systemd states that mean a manager is there to talk to. `offline` is the one that is not. */
const LIVE_SYSTEMD_STATES: readonly string[] = [
  "initializing",
  "starting",
  "running",
  "degraded",
  "maintenance",
];

function supervisorState(
  platform: NodeJS.Platform,
  run: ProbeRunner,
  domain: LaunchdDomain | null,
  bootedDir: string,
  linger: LingerProbe,
): SupervisorState {
  if (platform === "linux") {
    if (!existsSync(bootedDir)) {
      return {
        present: false,
        usable: false,
        blocked: false,
        detail:
          `${bootedDir} does not exist, which is what sd_booted(3) checks, so systemd ` +
          "is not this machine's init — a container, WSL1, OpenRC or a chroot. The `systemctl` " +
          "binary being present would not change that, which is why it is not what was asked",
      };
    }
    const answer = run({ program: "systemctl", argv: ["--user", "is-system-running"] });
    const state = answer.stdout.trim() || answer.stderr.trim();
    if (!answer.started) {
      return {
        present: true,
        usable: false,
        blocked: false,
        detail:
          `${bootedDir} is there, so systemd booted this machine, but \`systemctl\` ` +
          "could not be run to ask whether this user has a manager of their own",
      };
    }
    if (!LIVE_SYSTEMD_STATES.includes(answer.stdout.trim())) {
      return {
        present: true,
        usable: false,
        blocked: false,
        lingerFirst: !linger.enabled,
        detail:
          `systemd booted this machine, and \`systemctl --user is-system-running\` answered ` +
          `${JSON.stringify(state)} — so there is no per-user manager to register a unit with. ` +
          "A booted system and a user manager are two different facts, and the unit this daemon " +
          "installs lives in the second one",
      };
    }
    return {
      present: true,
      usable: true,
      blocked: false,
      detail: `systemd is PID 1 and \`systemctl --user is-system-running\` answered ${state}`,
    };
  }

  if (platform === "darwin") {
    const { uid, answer } = domain ?? probeLaunchdDomain(run);
    if (!answer.started) {
      return {
        present: false,
        usable: false,
        blocked: false,
        detail: "`launchctl` could not be run, so there is no way to reach a launchd domain",
      };
    }
    if (answer.status !== 0) {
      return {
        present: true,
        usable: false,
        blocked: false,
        detail:
          `launchd has no GUI domain for uid ${uid} (\`launchctl print-disabled gui/${uid}\` ` +
          `exited ${String(answer.status)}). A LaunchAgent runs only while its user is logged ` +
          "in, and with no login session there is no domain to bootstrap ~/Library/LaunchAgents " +
          "into — which a shell cannot conjure. This is a stated limitation of the macOS route, " +
          "not a fault",
      };
    }
    return {
      present: true,
      usable: true,
      blocked: false,
      detail: `launchd answered for the GUI domain of uid ${uid}`,
    };
  }

  const answer = run({ program: "schtasks", argv: ["/Query", "/FO", "LIST"] });
  if (!answer.started) {
    return {
      present: false,
      usable: false,
      blocked: false,
      detail: "`schtasks` could not be run, so Task Scheduler cannot be reached from this session",
    };
  }
  if (answer.status !== 0 && isTaskSchedulerBlocked(answer)) {
    return {
      present: true,
      usable: false,
      blocked: true,
      detail:
        `\`schtasks /Query\` exited ${String(answer.status)}: ` +
        `${firstLine(answer.stderr) || firstLine(answer.stdout) || "no output"}`,
    };
  }
  return {
    present: true,
    usable: true,
    blocked: false,
    detail: "Task Scheduler answered a query, so a registration can be attempted",
  };
}

/**
 * Whether Task Scheduler refused the *query* for a reason a registration would meet too.
 *
 * An empty folder and "the system cannot find the file specified" are ordinary answers on a machine
 * nothing has registered on; access being denied, the service being unavailable or an RPC failure
 * are the conditions that make a registration impossible before it is attempted, and those are the
 * ones worth refusing on. The match is on the message because `schtasks` uses `1` for all of them.
 */
function isTaskSchedulerBlocked(answer: ProbeResult): boolean {
  const text = `${answer.stdout} ${answer.stderr}`.toLowerCase();
  return (
    text.includes("access is denied") ||
    text.includes("service is not available") ||
    text.includes("service is not running") ||
    text.includes("rpc server is unavailable") ||
    text.includes("disabled by")
  );
}

/** Whether the program a supervisor would be handed can be run and read. */
function probeProgram(program: ResolvedProgram | null): ProgramProbe {
  if (program === null) {
    return {
      executable: null,
      entry: null,
      executableOk: false,
      entryOk: false,
      refusal: null,
    };
  }
  const executable = program.executable;
  const entry = program.entry;
  const executableOk = isAccessible(executable, constants.X_OK);
  const entryOk = entry === null || isAccessible(entry, constants.R_OK);
  if (executableOk && entryOk) {
    return { executable, entry, executableOk, entryOk, refusal: null };
  }
  const broken = executableOk ? `its entry file ${String(entry)}` : `its interpreter ${executable}`;
  return {
    executable,
    entry,
    executableOk,
    entryOk,
    refusal: {
      code: "program-not-executable",
      exitCode: PRECONDITION_UNMET_EXIT_CODE,
      message:
        `the program this install would register cannot be run: ${broken} is missing, or this ` +
        "user may not " +
        `${executableOk ? "read" : "execute"} it. A supervisor artefact naming it would install ` +
        "a daemon that fails at exec time with nothing to read, so nothing was written. Rebuild " +
        "the runtime with `xplainer runtime build --out <dir>` and install from it.",
    },
  };
}

/** Whether the port an install would record can be bound, and by whom it is held when it cannot. */
async function probePort(
  port: number,
  host: string,
  platform: NodeJS.Platform,
  run: ProbeRunner,
): Promise<PortProbe> {
  if (!Number.isInteger(port) || port <= 0) {
    return {
      port,
      held: false,
      holder: null,
      holderDetail:
        "port 0 is a request for whatever the kernel has free at bind time, so there is nothing " +
        "to hold",
      refusal: null,
    };
  }

  const bind = await probeBind(port, host);
  if (bind.code !== "EADDRINUSE") {
    return {
      port,
      held: false,
      holder: null,
      holderDetail:
        bind.code === null
          ? `nothing is listening on ${host}:${port}`
          : // Anything other than `EADDRINUSE` is not this row. ADR 0020 words `7` as a port or
            // label *conflict*, and a bind that failed for another reason — a privileged port, an
            // address this machine does not have — is a condition `serve` already classifies with
            // its own documented code the first time it starts. Inventing a seventh condition here
            // would give the same failure two codes depending on which command met it first.
            `${host}:${port} could not be bound by this probe (${bind.code}); \`serve\` reports ` +
            "what that means when it starts",
      refusal: null,
    };
  }

  const holder = namePortHolder(port, platform, run);
  return {
    port,
    held: true,
    holder: holder.pid,
    holderDetail: holder.detail,
    refusal: {
      code: "port-held",
      exitCode: INSTALL_CONFLICT_EXIT_CODE,
      message:
        `port ${port} on ${host} is already held, ${holder.detail}. The port is decided once, at ` +
        "install, and every consumer afterwards reads the recorded number rather than guessing " +
        "it — so recording one that is taken would install a daemon that fails at every start " +
        "for a reason no restart can change. Nothing is registered and nothing is recorded. " +
        "Stop that process, or install on another port with `--port`.",
    },
  };
}

/**
 * Try to bind, and put it back. The only question that answers "could an install record this".
 *
 * A connect would answer a different question — whether something *accepts* a connection there —
 * and a port held by a listener that is not accepting is still a port this daemon cannot have. The
 * listener is closed before the promise settles, so the probe leaves nothing bound.
 */
function probeBind(port: number, host: string): Promise<{ code: string | null }> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      resolve({ code: error.code ?? "unknown" });
    });
    probe.listen({ port, host, exclusive: true }, () => {
      probe.close(() => {
        resolve({ code: null });
      });
    });
  });
}

/**
 * Name the process holding a port, in words, or say why it could not be named.
 *
 * `daemon/binding.ts` deliberately does not do this at `serve` time — "finding it portably means
 * spawning `lsof` or its Windows equivalent" — and this is the place that was pointed at: an
 * install-time preflight is allowed to spend a subprocess to turn "the port is taken" into "the
 * port is taken by pid 9932, which is not an xplainer daemon". When no tool on the machine can say,
 * the message says *that* rather than implying the port is held by nothing.
 */
function namePortHolder(
  port: number,
  platform: NodeJS.Platform,
  run: ProbeRunner,
): { pid: number | null; detail: string } {
  if (platform === "win32") {
    const answer = run({ program: "netstat", argv: ["-ano", "-p", "tcp"] });
    const pid = firstWindowsListenerPid(answer.stdout, port);
    return pid === null
      ? { pid: null, detail: "by a process `netstat -ano` did not name" }
      : { pid, detail: `by pid ${pid}, as \`netstat -ano\` reports it` };
  }

  const lsof = run({
    program: "lsof",
    argv: ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "pc"],
  });
  if (lsof.started && lsof.status === 0) {
    const pid = matchField(lsof.stdout, "p");
    const command = matchField(lsof.stdout, "c");
    if (pid !== null) {
      return {
        pid: Number(pid),
        detail:
          command === null
            ? `by pid ${pid}, as \`lsof\` reports it`
            : `by pid ${pid} (${command}), as \`lsof\` reports it`,
      };
    }
  }

  const ss = run({ program: "ss", argv: ["-Hltnp", `sport = :${port}`] });
  if (ss.started && ss.status === 0) {
    const match = /pid=(\d+)/.exec(ss.stdout);
    if (match?.[1] !== undefined) {
      return { pid: Number(match[1]), detail: `by pid ${match[1]}, as \`ss -ltnp\` reports it` };
    }
  }

  return {
    pid: null,
    detail:
      "by a process this preflight could not name — neither `lsof` nor `ss` answered on this " +
      "machine",
  };
}

/** One `lsof -F` field's value from its first record. */
function matchField(output: string, field: string): string | null {
  for (const line of output.split("\n")) {
    if (line.startsWith(field) && line.length > 1) {
      return line.slice(1).trim();
    }
  }
  return null;
}

/** The pid in the first `netstat -ano` row that is LISTENING on `port`. */
function firstWindowsListenerPid(output: string, port: number): number | null {
  for (const line of output.split("\n")) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || columns[3]?.toUpperCase() !== "LISTENING") {
      continue;
    }
    const local = columns[1] ?? "";
    if (!local.endsWith(`:${port}`)) {
      continue;
    }
    const pid = Number(columns[4]);
    return Number.isInteger(pid) ? pid : null;
  }
  return null;
}

/**
 * Whether this user's services may outlive their login session.
 *
 * One `existsSync`, and that is the entire interaction this phase has with lingering. Absent is a
 * fact and not a failure: the writing phase is what attempts `loginctl --no-ask-password
 * enable-linger`, records whether **it** created the marker, and exits `5` when the attempt is
 * denied — which is also why `uninstall` can remove a marker it made and leave one it did not.
 */
function probeLinger(platform: NodeJS.Platform, account: string, lingerDir: string): LingerProbe {
  const marker = `${lingerDir}/${account}`;
  if (platform !== "linux") {
    return { applicable: false, user: account, marker, enabled: false };
  }
  return { applicable: true, user: account, marker, enabled: existsSync(marker) };
}

/** A macOS disable record, which survives reboots and is invisible everywhere else. */
function probeDisabled(platform: NodeJS.Platform, domain: LaunchdDomain | null): DisabledProbe {
  if (platform !== "darwin" || domain === null) {
    return {
      applicable: false,
      probed: false,
      disabled: false,
      record: "absent",
      detail: "launchctl disable records exist only on macOS",
    };
  }
  if (!domain.answer.started || domain.answer.status !== 0) {
    return {
      applicable: true,
      probed: false,
      disabled: false,
      record: "absent",
      detail: `\`launchctl print-disabled ${domain.name}\` did not answer, so no record could be read`,
    };
  }
  const record = readDisableRecord(domain.answer.stdout, LAUNCH_AGENT_LABEL);
  return {
    applicable: true,
    probed: true,
    disabled: record === "disabled",
    record,
    detail:
      record === "disabled"
        ? `${LAUNCH_AGENT_LABEL} is recorded as disabled in ${domain.name} — this is what System ` +
          "Settings › General › Login Items & Extensions switches off, and it persists across " +
          "reboots. A job installed now would be registered and never loaded. Undo it with " +
          `\`launchctl enable ${domain.name}/${LAUNCH_AGENT_LABEL}\``
        : record === "enabled"
          ? `${LAUNCH_AGENT_LABEL} already has a record in ${domain.name} and it says enabled, so ` +
            "an install's `launchctl enable` will change nothing"
          : `no record for ${LAUNCH_AGENT_LABEL} in ${domain.name} at all`,
  };
}

/** One `launchctl print-disabled gui/<uid>`, and the two questions it answers. */
type LaunchdDomain = {
  uid: number;
  /** `gui/<uid>`, the domain a LaunchAgent is bootstrapped into. */
  name: string;
  answer: ProbeResult;
};

/** Ask launchd about this user's GUI domain, once. */
function probeLaunchdDomain(run: ProbeRunner): LaunchdDomain {
  const uid = process.getuid?.() ?? 0;
  const name = `gui/${uid}`;
  return { uid, name, answer: run({ program: "launchctl", argv: ["print-disabled", name] }) };
}

/**
 * `%SystemRoot%\System32\Tasks\xplainer`, the folder Task Scheduler keeps its own copy in.
 *
 * A registration writes two things: the XML this project renders under `%LOCALAPPDATA%`, and the
 * task document Task Scheduler stores for itself. Only the second one *is* the registration, so a
 * refusal check that hashed only the first would miss a task that got registered anyway. `null`
 * everywhere but Windows, where the other two supervisors keep no second copy: a systemd user unit
 * and a LaunchAgent plist are the registration.
 */
function taskStorePath(kind: SupervisorKind, environment: SupervisorEnvironment): string | null {
  if (kind !== "task-scheduler") {
    return null;
  }
  const root = environment.systemRoot;
  if (root === undefined || root.trim() === "") {
    return null;
  }
  return win32.join(root, "System32", "Tasks", TASK_FOLDER.replace(/^\\/, ""));
}

/** A renderer's path, or `null` when the environment it needs is not complete enough to build one. */
function attemptPath(build: () => string): string | null {
  try {
    return build();
  } catch {
    return null;
  }
}

/**
 * What `launchctl print-disabled` says about one label, read off its own line.
 *
 * `launchctl`'s manual says of `print` that "This output is NOT API in any sense at all", and that
 * warning is honoured by reading one line for one label rather than by parsing the document:
 * everything outside the line whose quoted label matches is ignored.
 *
 * **The value is a word, not a boolean, and this is measured rather than assumed.** Round 1 of
 * this file matched `/=>\s*true/`, which is what launchctl printed years ago. Captured verbatim
 * from `launchctl print-disabled gui/$(id -u)` on macOS (Darwin 25.5.0, arm64) on 2026-09-08 —
 * `__fixtures__/launchctl-print-disabled.txt` in this directory is that capture:
 *
 * ```
 * 	disabled services = {
 * 		"com.apple.Siri.agent" => disabled
 * 		"video.xplainer.daemon" => enabled
 * 	}
 * ```
 *
 * There is no `true` anywhere in it, so the old predicate answered "not disabled" for **every**
 * label on every modern macOS — including one a user had switched off in System Settings, which is
 * the single condition this probe exists to catch. Both spellings are accepted here, because the
 * older one costs one word and a machine that still prints it is not one this project can test on.
 *
 * `absent` is a third answer rather than a synonym for "enabled": `launchctl enable` creates a
 * record where there was none, and `install` records which of the two it met so `uninstall` can
 * say what it changed.
 */
export function readDisableRecord(output: string, label: string): LaunchdDisableRecord {
  for (const line of output.split("\n")) {
    if (!line.includes(`"${label}"`)) {
      continue;
    }
    const value = /=>\s*([A-Za-z]+)/.exec(line)?.[1]?.toLowerCase();
    if (value === "disabled" || value === "true") {
      return "disabled";
    }
    if (value === "enabled" || value === "false") {
      return "enabled";
    }
  }
  return "absent";
}

/** The token file: where it is, and whether this user could read one that is already there. */
function probeToken(
  stateDir: string,
  env: Readonly<Record<string, string | undefined>>,
): TokenProbe {
  const path = resolveTokenPath(stateDir, env);
  if (!existsSync(path)) {
    return {
      path,
      present: false,
      readable: false,
      detail:
        `no token file at ${path} yet; the daemon's first start mints one, 32 random bytes at ` +
        "0600, and the artefact carries its path and never its value",
    };
  }
  const readable = isAccessible(path, constants.R_OK);
  return {
    path,
    present: true,
    readable,
    detail: readable
      ? `a token file is already at ${path}, and the installed daemon will reuse it`
      : `a token file is at ${path} and this user cannot read it, so a daemon started from the ` +
        "artefact would refuse to serve rather than run unauthenticated",
  };
}

/** Whether a path exists and this user holds `mode` on it. */
function isAccessible(path: string, mode: number): boolean {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

/**
 * The account name, from the environment first so a test can state one.
 *
 * Qualified as `DOMAIN\user` on Windows, which is what a Scheduled Task's `<UserId>` and `<Principal>`
 * take: `taskName()` reads the user part back off it, so the qualified form is the one that is both
 * a legal principal and a legal task name, and a bare `USERNAME` would be a principal a domain
 * machine resolves against the wrong authority.
 */
function accountName(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): string {
  const named = env.USER ?? env.USERNAME ?? env.LOGNAME ?? safeUsername();
  if (platform !== "win32" || named === "" || named.includes("\\")) {
    return named;
  }
  const domain = env.USERDOMAIN ?? env.COMPUTERNAME ?? "";
  return domain === "" ? named : `${domain}\\${named}`;
}

/** This process's user name, or the empty string on a platform that will not say. */
function safeUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
}

/** The first non-empty line of a stream, for a message that quotes a tool's own refusal. */
function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    if (line.trim() !== "") {
      return line.trim();
    }
  }
  return "";
}

/** `format_version` as a number, even when it is one this build does not know. */
function readFormatVersion(parsed: unknown): number | null {
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const value = (parsed as Record<string, unknown>).format_version;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * The marker, when every field this build reads is there and is the right shape.
 *
 * A structural check rather than a schema validation, because `packages/protocol` ships Ajv as a
 * *dev* dependency: the schema is the contract's source of truth and its generated type is what
 * this file holds, while the runtime check is the same shape `daemon/daemon-state.ts` applies to
 * every field it reads off disk. A newer `format_version` is not rejected — an unknown version is
 * a rollback signal rather than corruption — so long as the fields this build needs are present.
 */
function readMarker(parsed: unknown): Toolchain | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const raw = parsed as Record<string, unknown>;
  const formatVersion = readFormatVersion(parsed);
  const createdAt = raw.created_at;
  const chrome = readComponent(raw.chrome);
  const speech = readComponent(raw.speech);
  const workspace = readWorkspace(raw.workspace);
  if (
    formatVersion === null ||
    typeof createdAt !== "string" ||
    chrome === null ||
    speech === null ||
    workspace === null
  ) {
    return null;
  }
  return { format_version: formatVersion, created_at: createdAt, chrome, speech, workspace };
}

/** One acquired binary's record, or `null` when it is not one. */
function readComponent(value: unknown): ToolchainComponent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const { version, path, sha256, provider } = raw;
  if (
    typeof version !== "string" ||
    typeof path !== "string" ||
    typeof sha256 !== "string" ||
    typeof provider !== "string" ||
    version === "" ||
    path === "" ||
    provider === ""
  ) {
    return null;
  }
  return { version, path, sha256, provider };
}

/** The workspace payload's identity, or `null` when it is not recorded. */
function readWorkspace(value: unknown): Toolchain["workspace"] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const { platform, version } = raw;
  if (typeof platform !== "string" || typeof version !== "string" || platform === "") {
    return null;
  }
  return { platform, version };
}
