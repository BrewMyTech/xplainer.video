/**
 * Where the daemon's durable state lives, and what it is called.
 *
 * [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md) §Port and discovery names
 * one directory per platform and two files inside it with opposite lifetimes;
 * [ADR 0024](../../../../docs/adr/0024-durable-jobs-and-boot-reconciliation.md) §Consequences adds
 * the `jobs/` subdirectory, its `corrupt/` quarantine and the ownership artefact. Every other
 * module in `daemon/` takes a resolved state directory as an argument rather than reading the
 * environment itself, so this file is the only place that knows the platform rules and the only
 * place a test has to override.
 *
 * `XPLAINER_STATE_DIR` is the override, and it exists for the tests: every process in a test runs
 * against a temporary directory, so a suite can `SIGKILL` a daemon without touching the developer's
 * own state. It is read here and nowhere else.
 *
 * **`serve --state-dir` is the second override, and it is above the variable.** Task Scheduler's
 * `<Exec>` action carries a command, a working directory and arguments and has **no per-action
 * environment map**, so on Windows a supervisor cannot deliver `XPLAINER_STATE_DIR` at all — an
 * installed daemon would take the platform default while `daemon.json` recorded something else.
 * {@link resolveStateDirSetting} is therefore the whole precedence, **flag → variable → platform
 * default**, in one place, and {@link resolveStateDir} is the same answer for the callers that have
 * no flag to offer. The source travels back with the path because the daemon says on start-up which
 * of the three decided it, and "the setting I meant was not the setting that arrived" is otherwise
 * invisible until a render writes into the wrong directory.
 *
 * The directory is created `0700` and the files inside it `0600`, which is ADR 0020's R-SEC-5 rule
 * for the token applied to the whole directory: on a shared Linux VM — the machine class ADR 0016
 * exists for — another local user can otherwise read a job record naming the paths on this user's
 * disk. Windows is the honest exception ADR 0020 already records: a mode there is not protection.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

/** The environment variable that relocates the whole state directory. */
export const STATE_DIR_ENV = "XPLAINER_STATE_DIR";

/** Mode for the state directory itself: nobody but the owner. */
export const STATE_DIR_MODE = 0o700;

/** Mode for every file the daemon writes into it. */
export const STATE_FILE_MODE = 0o600;

/** The ownership artefact, created `O_EXCL` (ADR 0024 §Note, 2026-09-06: Ownership). */
export const OWNER_LOCK_FILE = "owner.lock";

/** Durable state: the port, the contract version, `recentStarts[]` and `stalled`. */
export const DAEMON_STATE_FILE = "daemon.json";

/** Ephemeral state: this run's pid and bound port. Never trusted without a liveness check. */
export const RUNTIME_STATE_FILE = "runtime.json";

/** One JSON file per job lives here (ADR 0024 §Storage shape). */
export const JOBS_DIR = "jobs";

/** Unparseable records are moved here rather than deleted, so one bad file cannot stop a boot. */
export const CORRUPT_DIR = "corrupt";

/** The environment this module reads, narrowed to what it uses. */
export type StateDirEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Which of the three precedence steps produced a setting.
 *
 * Shared by the state directory, the token file and the IPC socket, because all three are settled
 * the same way and a reader of a start-up line should not have to learn three vocabularies.
 * `"default"` covers both a platform default and a path derived from the state directory: what it
 * means in every case is "nobody asked for this one".
 */
export type SettingSource = "flag" | "environment" | "default";

/** A resolved path, and which precedence step produced it. */
export type SettingDecision = {
  path: string;
  source: SettingSource;
};

/** A flag value that is present and is not blank, or `undefined`. */
export function settingFlag(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

/** What {@link resolveStateDirSetting} weighs, in precedence order. */
export type StateDirRequest = {
  /** `serve --state-dir`, which wins over the variable and the platform default. */
  flag?: string | undefined;
  env?: StateDirEnvironment;
  platform?: string;
  home?: string;
};

/**
 * The whole precedence: `--state-dir` → `XPLAINER_STATE_DIR` → the platform default.
 *
 * A blank flag and a blank variable are both ignored rather than resolving to nothing, which is the
 * rule an empty `Environment=XPLAINER_STATE_DIR=` in a hand-edited unit needs.
 */
export function resolveStateDirSetting(request: StateDirRequest = {}): SettingDecision {
  const flag = settingFlag(request.flag);
  if (flag !== undefined) {
    return { path: flag, source: "flag" };
  }
  const env = request.env ?? process.env;
  const override = settingFlag(env[STATE_DIR_ENV]);
  if (override !== undefined) {
    return { path: override, source: "environment" };
  }
  return {
    path: platformStateDir(env, request.platform ?? process.platform, request.home ?? homedir()),
    source: "default",
  };
}

/** Every path `daemon/` writes, derived from one directory. */
export type StateDirLayout = {
  /** The durable state directory itself. */
  root: string;
  /** `owner.lock`. */
  lock: string;
  /** `daemon.json`. */
  daemonState: string;
  /** `runtime.json`. */
  runtimeState: string;
  /** `jobs/`. */
  jobs: string;
  /** `jobs/corrupt/`. */
  corrupt: string;
};

/**
 * The platform default from ADR 0020 §Port and discovery, and nothing above it.
 *
 * `env`, `platform` and `home` are parameters rather than reads of `process` so that the platform
 * rules are testable on one machine: the three defaults below are asserted from macOS in
 * `state-dir.test.ts`, which is the only way this repository can check the Linux and Windows
 * branches at all.
 */
function platformStateDir(env: StateDirEnvironment, platform: string, home: string): string {
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "video.xplainer");
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    const base =
      localAppData !== undefined && localAppData !== ""
        ? localAppData
        : join(home, "AppData", "Local");
    return join(base, "xplainer", "state");
  }
  const xdg = env.XDG_STATE_HOME;
  const base = xdg !== undefined && xdg !== "" ? xdg : join(home, ".local", "state");
  return join(base, "xplainer");
}

/**
 * The state directory for a caller with no flag to offer: `XPLAINER_STATE_DIR`, else the platform
 * default.
 *
 * This is {@link resolveStateDirSetting} with the flag omitted, and it stays because most callers
 * genuinely have no flag — `status`, `connect`, the in-process `mcp` server — and a request object
 * with one field would say nothing they do not already say by calling this.
 */
export function resolveStateDir(
  env: StateDirEnvironment = process.env,
  platform: string = process.platform,
  home: string = homedir(),
): string {
  return resolveStateDirSetting({ env, platform, home }).path;
}

/** Expand a resolved state directory into the five paths the daemon writes. */
export function stateDirLayout(stateDir: string): StateDirLayout {
  return {
    root: stateDir,
    lock: join(stateDir, OWNER_LOCK_FILE),
    daemonState: join(stateDir, DAEMON_STATE_FILE),
    runtimeState: join(stateDir, RUNTIME_STATE_FILE),
    jobs: join(stateDir, JOBS_DIR),
    corrupt: join(stateDir, JOBS_DIR, CORRUPT_DIR),
  };
}
