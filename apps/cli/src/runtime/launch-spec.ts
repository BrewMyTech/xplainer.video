/**
 * How the daemon is launched, written down once, and how a package's own `bin` field becomes an
 * interpreter and an entry file.
 *
 * Two things live here and they are the same decision seen from two sides.
 *
 * **The launch contract.** {@link LaunchSpec} is one record — executable, argv, settings, cwd —
 * that every consumer takes and nobody composes. The three supervisor renderers, the Electron main
 * process and the update transaction all render *this*, so there is exactly one place where the
 * daemon's argument vector is decided and exactly one place a mistake in it can be.
 *
 * **`settings` is not an environment map, and that is deliberate.** A shared `env` record makes the
 * *record* complete and says nothing about *emission*: Task Scheduler's `<Exec>` action carries
 * `Command`, `Arguments` and `WorkingDirectory` and has **no per-action environment map**, while
 * `daemon/state-dir.ts` and `daemon/token.ts` read `XPLAINER_STATE_DIR` and `XPLAINER_TOKEN_FILE`
 * from the environment only — so an environment-shaped contract would leave the installed Windows
 * daemon silently on the platform defaults while `daemon.json` recorded something else. The
 * contract therefore carries the three settings as values, {@link buildLaunchSpec} puts every one
 * of them into `argv`, and {@link emitSettings} says what *else* each platform's artefact carries.
 *
 * **Every setting is emitted as argv on every platform, and that is one rule rather than two.**
 * Windows had to use argv anyway; the two POSIX platforms do the same because **there is no
 * `XPLAINER_SOCKET` variable** for an environment emission to use — `--socket` is a flag and
 * `daemon/ipc.ts` reads no variable — so an environment-only emission would leave systemd creating
 * a `RuntimeDirectory=` nothing writes into. `argv` is carried verbatim by `ExecStart=`, by
 * `ProgramArguments` and by `<Arguments>`, so one emission works everywhere. The `Environment=` and
 * `EnvironmentVariables` forms are kept for the state directory and the token file, so a reader of
 * a unit or a plist still sees them where they have always been; every emitted value is a **path**
 * and never the token itself, which is the rule R-SEC-6 states.
 *
 * **Decision D1 — Remotion is spawned through the runtime's own interpreter.**
 * `node_modules/.bin/remotion` is a symlink to `@remotion/cli/remotion-cli.js`, whose first line is
 * `#!/usr/bin/env node`. Spawning that path directly hands it to `/usr/bin/env`, which searches the
 * **child's** `PATH`, and the measurement is unambiguous:
 *
 * ```
 * $ env -i PATH=/usr/bin:/bin HOME=/tmp sh -c 'node_modules/.bin/remotion --version'
 * env: node: No such file or directory
 * EXIT=127
 * ```
 *
 * On the machine this whole design exists for — one with no Node — `--version`, `serve`,
 * `/healthz` and `explainer_create` would all pass while every render exited 127. So
 * {@link resolveNodeEntry} reads a package's own `bin` field to the **real entry file** and returns
 * `{ executable: <interpreter>, argv: [entry, …] }`, which is the pattern the narration worker
 * already uses (`workers.ts`: `command: process.execPath, args: [compiled]`). Going through `bin`
 * rather than through the `.bin` shim is what makes the Windows `.cmd` case need no branch at all:
 * there is no shim to wrap, on any platform.
 *
 * *Rejected:* prepending `<runtime>/bin` to `WorkerSpec.env.PATH`, which is one line smaller and
 * which `runner.ts` already merges. It leaks an interpreter onto the `PATH` of everything the
 * worker starts — Chrome and ffmpeg included — and makes the runtime non-hermetic for the benefit
 * of one call site.
 *
 * Three call sites use it: this module's own executable, and `daemon/workers.ts`'s two Remotion
 * workers.
 *
 * **What this module deliberately does not do.** It does not check that `serve` accepts the flags
 * it emits. The spellings are pinned by {@link SETTING_FLAGS} so that both halves are one edit
 * apart.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { STATE_DIR_ENV } from "../daemon/state-dir.js";
import { TOKEN_FILE_ENV } from "../daemon/token.js";
import { RUNTIME_ROOT_PACKAGE } from "./assemble.js";
import { PAYLOAD_BIN_DIR, PAYLOAD_LIB_DIR } from "./manifest.js";

/** The `bin` name `@xplainer/cli` publishes, and the one the launch contract resolves. */
export const CLI_BIN_NAME = "xplainer";

/** The subcommand a supervisor starts. There is no `serve --detach`, by ADR 0020. */
export const SERVE_COMMAND = "serve";

/** The port flag `serve` already carries. */
export const PORT_FLAG = "--port";

/**
 * The flag each setting is emitted as, on every platform.
 *
 * One record rather than three literals, because the golden tests, the renderers and `serve`'s own
 * option list all have to agree and a spelling that lives in one place cannot half-change.
 */
export const SETTING_FLAGS: Readonly<Record<keyof LaunchSettings, string>> = {
  stateDir: "--state-dir",
  tokenFile: "--token-file",
  socket: "--socket",
};

/**
 * The environment variable each setting has, where it has one.
 *
 * `socket` is absent and that absence is the reason every setting travels in argv: `daemon/ipc.ts`
 * derives the socket from the state directory and reads no variable of its own, so there is nothing
 * for an environment emission to set.
 */
export const SETTING_VARIABLES: Readonly<Record<"stateDir" | "tokenFile", string>> = {
  stateDir: STATE_DIR_ENV,
  tokenFile: TOKEN_FILE_ENV,
};

/** A launch contract that cannot be built, or a `bin` field that names nothing runnable. */
export class LaunchContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchContractError";
  }
}

/**
 * The three settings a supervisor must deliver to `serve`.
 *
 * Paths, all of them, and never the token's value: the cost of putting them in an argument vector
 * is that they show up in `systemctl --user show` and `Get-ScheduledTaskInfo`, which is exactly the
 * exposure R-SEC-6 already weighs for `/proc/<pid>/cmdline`.
 */
export type LaunchSettings = {
  /** The durable state directory — `XPLAINER_STATE_DIR`'s value as a flag. */
  stateDir: string;
  /** The token file's path. A path, never the token. */
  tokenFile: string;
  /** The IPC socket, or the named pipe on Windows. */
  socket: string;
};

/** Everything a consumer needs to start the daemon, and nothing it has to assemble itself. */
export type LaunchSpec = {
  /** `<runtime>/bin/node`, or `node.exe` on Windows. */
  executable: string;
  /** `[<entry>, "serve", "--port", …, "--state-dir", …, "--token-file", …, "--socket", …]`. */
  argv: readonly string[];
  /** The same three values the argv carries, as data a renderer and a checker can compare. */
  settings: Readonly<LaunchSettings>;
  /** The working directory the artefact sets. */
  cwd: string;
};

/** The three platforms with a supervisor renderer. */
export type SupervisorPlatform = "linux" | "darwin" | "win32";

/**
 * What one platform's artefact carries **in addition to** {@link LaunchSpec.argv}.
 *
 * Three forms, because the three supervisors spell an environment three different ways and one of
 * them cannot spell it at all:
 *
 * - `systemd` — `Environment=NAME=value` lines in the unit's `[Service]` section.
 * - `launchd` — the plist's `EnvironmentVariables` dictionary.
 * - `task-scheduler` — nothing, because `<Exec>` has no environment map. Its `argv` is the exact
 *   slice `buildLaunchSpec` already put into {@link LaunchSpec.argv}, so a renderer that writes
 *   `argv` verbatim into `<Arguments>` has delivered the settings; naming the slice is what lets a
 *   golden test assert *which* entries carry them rather than that the vector merely got longer.
 */
export type SettingsEmission =
  | { form: "systemd"; environment: readonly string[] }
  | { form: "launchd"; environment: Readonly<Record<string, string>> }
  | { form: "task-scheduler"; argv: readonly string[] };

/** An interpreter and the argv that starts a package's entry file under it. */
export type NodeEntry = {
  /** The interpreter to spawn. Never the entry file itself: that is D1's whole point. */
  executable: string;
  /** `[<entry file>, …arguments]`. */
  argv: readonly string[];
};

/** What {@link resolveNodeEntry} may be told beyond the package and the `bin` name. */
export type NodeEntryOptions = {
  /**
   * The interpreter to run the entry under. Defaults to `process.execPath`, which is what the
   * daemon's own workers want: a daemon started from a payload is *already* running
   * `<runtime>/bin/node`, so its children inherit the right interpreter by construction.
   */
  interpreter?: string | undefined;
  /** Arguments to place after the entry file. */
  args?: readonly string[] | undefined;
};

/** What {@link buildLaunchSpec} needs. */
export type LaunchSpecOptions = {
  /** The payload-1 directory the daemon runs out of. */
  runtimeDir: string;
  /** The port `serve` binds. `0` is a value — an ephemeral port — and not an omission. */
  port: number;
  /** All three settings. None has a default: a defaulted setting is a dropped setting. */
  settings: LaunchSettings;
  /** The working directory. Defaults to the state directory. */
  cwd?: string | undefined;
  /** The platform whose artefact is being written. Defaults to this process's. */
  platform?: NodeJS.Platform | undefined;
};

/**
 * Resolve a package's `bin` entry to the real file, and say what runs it.
 *
 * The `bin` field rather than `node_modules/.bin`: the shim is a symlink on POSIX and a generated
 * `.cmd` on Windows, and both exist to be found on a `PATH` that the machine this runtime targets
 * does not have. Reading `bin` gives the file itself, which an explicit interpreter can run on
 * every platform with no branch.
 *
 * A `bin` that is a plain string names one executable, and npm gives that executable the package's
 * own unscoped name; asking for any other name against a string `bin` is a caller's mistake and is
 * refused rather than silently answered with the only entry there is.
 */
export function resolveNodeEntry(
  packageDir: string,
  binName: string,
  options: NodeEntryOptions = {},
): NodeEntry {
  const manifestFile = join(packageDir, "package.json");
  const manifest = readPackageManifest(manifestFile);
  const target = binTarget(manifest, binName, manifestFile);
  const entry = resolve(packageDir, target);
  const inside = relative(resolve(packageDir), entry);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    throw new LaunchContractError(
      `${manifestFile} points \`bin.${binName}\` at ${target}, which lands outside the package ` +
        `at ${entry}. A launch contract names a file the payload carries, so a \`bin\` that ` +
        `escapes its own directory is refused rather than followed.`,
    );
  }
  if (!existsSync(entry)) {
    throw new LaunchContractError(
      `${manifestFile} names \`bin.${binName}\` as ${target}, and ${entry} does not exist. The ` +
        `package is present but its entry is not, so nothing could be spawned for it.`,
    );
  }
  return {
    executable: options.interpreter ?? process.execPath,
    argv: [entry, ...(options.args ?? [])],
  };
}

/**
 * The directory an installed package occupies at or above `root`, or `null`.
 *
 * Node's own resolution order, walked explicitly: a workspace installed in place and one nested
 * inside an already-installed tree both answer, and `null` — rather than a guessed path — is what
 * lets a caller name the command that fixes it instead of failing later inside `spawn`.
 */
export function findInstalledPackage(root: string, packageName: string): string | null {
  const segments = packageName.split("/");
  let directory = resolve(root);
  for (;;) {
    const candidate = join(directory, "node_modules", ...segments);
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

/**
 * Build the one record every consumer of the daemon takes.
 *
 * Every setting is validated before anything is composed, so a caller that forgot one is told which
 * one by name at the moment it builds the spec — rather than by a daemon that came up on the
 * platform defaults and wrote its state somewhere nobody is looking.
 */
export function buildLaunchSpec(options: LaunchSpecOptions): LaunchSpec {
  const platform = options.platform ?? process.platform;
  requirePath(options.runtimeDir, "runtimeDir");
  requirePort(options.port);
  const settings: LaunchSettings = {
    stateDir: requirePath(options.settings.stateDir, "settings.stateDir"),
    tokenFile: requirePath(options.settings.tokenFile, "settings.tokenFile"),
    socket: requirePath(options.settings.socket, "settings.socket"),
  };

  const interpreter = join(
    options.runtimeDir,
    PAYLOAD_BIN_DIR,
    platform === "win32" ? "node.exe" : "node",
  );
  const packageDir = join(
    options.runtimeDir,
    ...PAYLOAD_LIB_DIR.split("/"),
    ...RUNTIME_ROOT_PACKAGE.split("/"),
  );
  const entry = resolveNodeEntry(packageDir, CLI_BIN_NAME, {
    interpreter,
    args: [SERVE_COMMAND, PORT_FLAG, String(options.port), ...settingsArgv(settings)],
  });

  return {
    executable: entry.executable,
    argv: entry.argv,
    settings,
    cwd: options.cwd ?? settings.stateDir,
  };
}

/**
 * What this platform's supervisor artefact carries beside the argv.
 *
 * The renderers call this rather than reaching into `spec.settings` themselves, which is the seam
 * that makes a dropped setting a **test failure** instead of a silent fall back to the platform
 * default.
 */
export function emitSettings(spec: LaunchSpec, platform: SupervisorPlatform): SettingsEmission {
  switch (platform) {
    case "linux":
      return {
        form: "systemd",
        environment: [
          `${SETTING_VARIABLES.stateDir}=${spec.settings.stateDir}`,
          `${SETTING_VARIABLES.tokenFile}=${spec.settings.tokenFile}`,
        ],
      };
    case "darwin":
      return {
        form: "launchd",
        environment: {
          [SETTING_VARIABLES.stateDir]: spec.settings.stateDir,
          [SETTING_VARIABLES.tokenFile]: spec.settings.tokenFile,
        },
      };
    case "win32":
      return { form: "task-scheduler", argv: settingsArgv(spec.settings) };
  }
}

/** `["--state-dir", …, "--token-file", …, "--socket", …]`, in one fixed order. */
function settingsArgv(settings: LaunchSettings): string[] {
  return [
    SETTING_FLAGS.stateDir,
    settings.stateDir,
    SETTING_FLAGS.tokenFile,
    settings.tokenFile,
    SETTING_FLAGS.socket,
    settings.socket,
  ];
}

/** A setting that is present and is not the empty string, or a refusal naming the field. */
function requirePath(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LaunchContractError(
      `the launch contract needs ${field}, and it is ${JSON.stringify(value)}. Every value in a ` +
        `launch spec is emitted, so an absent one would install a daemon running on the platform ` +
        `default while the record said otherwise.`,
    );
  }
  return value;
}

/** A port `serve` could bind. `0` is allowed: it is the ephemeral-port request. */
function requirePort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new LaunchContractError(
      `the launch contract needs a port between 0 and 65535, and it is ${JSON.stringify(port)}.`,
    );
  }
}

/** A package manifest read as data, with the failure naming the file rather than the parser. */
function readPackageManifest(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new LaunchContractError(
      `${file} cannot be read: ${error instanceof Error ? error.message : String(error)}. A ` +
        `launch contract is resolved from a package's own manifest, so there is nothing to read ` +
        `a \`bin\` field out of.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new LaunchContractError(
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new LaunchContractError(`${file} is not an object.`);
  }
  return parsed as Record<string, unknown>;
}

/** The path a manifest's `bin` field gives `binName`, or a refusal saying what it does give. */
function binTarget(
  manifest: Record<string, unknown>,
  binName: string,
  manifestFile: string,
): string {
  const bin = manifest.bin;
  if (typeof bin === "string") {
    const name = typeof manifest.name === "string" ? manifest.name : "";
    const unscoped = name.startsWith("@") ? (name.split("/")[1] ?? name) : name;
    if (unscoped !== binName) {
      throw new LaunchContractError(
        `${manifestFile} declares \`bin\` as the single entry ${JSON.stringify(bin)}, which npm ` +
          `installs under the package's own name ${JSON.stringify(unscoped)} — not ` +
          `${JSON.stringify(binName)}.`,
      );
    }
    return bin;
  }
  if (typeof bin === "object" && bin !== null && !Array.isArray(bin)) {
    const target = (bin as Record<string, unknown>)[binName];
    if (typeof target === "string") {
      return target;
    }
    throw new LaunchContractError(
      `${manifestFile} declares no \`bin.${binName}\`; it declares ` +
        `${JSON.stringify(Object.keys(bin as Record<string, unknown>))}.`,
    );
  }
  throw new LaunchContractError(
    `${manifestFile} declares no \`bin\` field, so there is no entry file to run and a launch ` +
      `contract cannot guess one.`,
  );
}
