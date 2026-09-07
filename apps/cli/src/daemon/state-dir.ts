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
 * The platform default from ADR 0020 §Port and discovery, with `XPLAINER_STATE_DIR` taking
 * precedence over all of it.
 *
 * `env`, `platform` and `home` are parameters rather than reads of `process` so that the platform
 * rules are testable on one machine: the three defaults below are asserted from macOS in
 * `state-dir.test.ts`, which is the only way this repository can check the Linux and Windows
 * branches at all.
 */
export function resolveStateDir(
  env: StateDirEnvironment = process.env,
  platform: string = process.platform,
  home: string = homedir(),
): string {
  const override = env[STATE_DIR_ENV];
  if (override !== undefined && override.trim() !== "") {
    return override;
  }
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
