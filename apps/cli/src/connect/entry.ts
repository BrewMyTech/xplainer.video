/**
 * The command line `xplainer connect` writes into an agent's configuration, and how it is chosen.
 *
 * [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md) §The agent path is IPC, not
 * TCP settles *what* is written: "`xplainer connect claude|codex` therefore writes a **stdio** entry
 * by default, pointing at `xplainer mcp --attach`, which proxies stdio to that socket. No URL and no
 * token enter any agent configuration file." Everything in this file exists to produce that one
 * command line, so that neither writer invents its own.
 *
 * **What is written is a name that survives an update, and there are three of them.** In order:
 *
 * 1. **`<state>/bin/xplainer`, the stable launcher** an install wrote (`install/launcher.ts`). This
 *    is the one that matters on a machine with a daemon, and it is why the launcher exists: the
 *    phase-2 default install runs the daemon out of `<state>/runtime/<version>-<digest>/`, a
 *    directory the *next* update deletes. An entry naming that directory is a configuration that
 *    works until the first upgrade. An entry naming the launcher is rewritten by the upgrade, in
 *    place, as one more small-file temp → rename.
 * 2. **The bare name `xplainer`**, when it is on `PATH` — a global npm install, or a checkout's
 *    linked binary. A bare name is durable for the same reason: the shim moves, the name does not.
 * 3. **`npx -y @xplainer/cli mcp --attach`**, which is the form
 *    [ADR 0013](../../../../docs/adr/0013-one-skill-two-plugin-bundles-claude-and-codex.md) already
 *    ships in both plugin bundles (`npx -y @xplainer/cli mcp`, without `--attach`, because a bundle
 *    installs on a machine that has no daemon). It is the last resort and not dead code: it is what
 *    a machine with nothing installed gets, once the package is published.
 *
 * **A version-scoped directory is never written, by any of the three.** A runtime directory is not
 * on `PATH` — it is under the state directory — so before the launcher existed, an installed
 * machine fell through to `npx` and pointed an agent at a *published package* that this phase does
 * not have. That is the defect the ordering above closes, and it is why the launcher is checked
 * first rather than last.
 *
 * **The lookup is a real `PATH` walk and never a spawn.** Asking the operating system by running
 * `xplainer --version` would mean starting a Node process to answer a question about a directory
 * listing, and — worse — a machine with a *broken* `xplainer` on `PATH` would answer "no" and get an
 * `npx` entry pointing at a package the broken install is already a copy of. `X_OK` on the file is
 * the question actually being asked, and it is the same question asked of the launcher.
 */

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import process from "node:process";
import { launcherPath } from "../install/launcher.js";

/** The name both agents know this server by, in their configuration and in their UI. */
export const SERVER_NAME = "xplainer";

/** The published package `npx` fetches when the binary is not installed. */
export const CLI_PACKAGE = "@xplainer/cli";

/** The verb and flag that proxy an agent's stdio to the daemon's socket (`commands/mcp.ts`). */
export const ATTACH_ARGS: readonly string[] = ["mcp", "--attach"];

/**
 * Which form was chosen, so the caller can say which and why.
 *
 * `runtime` is not produced here: it is `connect --spawn`'s own fallback (`connect/spawn.ts`), for
 * a machine where an install was *refused* and so wrote no launcher. It is in this union because
 * the two resolvers answer with one type, and a caller printing "runs: …" should not need to know
 * which of them it asked.
 */
export type EntrySource = "launcher" | "runtime" | "path" | "npx";

/** One stdio server entry, in the shape both writers need and neither one decides. */
export type StdioEntry = {
  /** The program an agent spawns. */
  command: string;
  /** Its arguments, ending in `mcp --attach`. */
  args: string[];
  /** `"path"` when the binary was found, `"npx"` for the fallback. */
  source: EntrySource;
};

/** The environment this module reads, narrowed to what it uses. */
export type PathEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * The extensions a bare name may carry on Windows, from `PATHEXT`.
 *
 * On POSIX the answer is "none": a file is executable because of its mode, not its name. On Windows
 * `xplainer` is really `xplainer.cmd` — npm writes a shim — so a lookup that only tried the bare
 * name would always fall back to `npx` there, which is the wrong answer on the one platform where
 * `npx` is slowest.
 */
function executableSuffixes(env: PathEnvironment, platform: string): string[] {
  if (platform !== "win32") {
    return [""];
  }
  const pathext = env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  return pathext
    .split(";")
    .map((extension) => extension.trim())
    .filter((extension) => extension !== "");
}

/**
 * Find `name` on `PATH`, or `null`.
 *
 * `env` and `platform` are parameters rather than reads of `process` for the reason
 * `daemon/state-dir.ts` gives about its own: it is the only way one machine can test the branch it
 * is not running on, and it is what lets a test put a shim on a `PATH` of its own.
 */
export function findOnPath(
  name: string,
  env: PathEnvironment = process.env,
  platform: string = process.platform,
): string | null {
  const search = env.PATH ?? env.Path ?? "";
  const suffixes = executableSuffixes(env, platform);
  for (const directory of search.split(delimiter)) {
    if (directory === "") {
      continue;
    }
    for (const suffix of suffixes) {
      const candidate = join(directory, `${name}${suffix}`);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not there, or not executable by this user. Both mean "keep looking".
      }
    }
  }
  return null;
}

/**
 * The launcher an install wrote, or `null`.
 *
 * `X_OK` rather than `existsSync`, because the property being asked about is "can an agent spawn
 * this", and a launcher left behind by an interrupted install with a mode nobody can run is a path
 * that exists and answers the wrong question. `install/launcher.ts` sets the mode on the temporary
 * file *before* the rename precisely so this check can be the whole of it.
 */
export function installedLauncher(
  stateDir: string,
  platform: string = process.platform,
): string | null {
  const path = launcherPath(stateDir, platform as NodeJS.Platform);
  try {
    accessSync(path, constants.X_OK);
    return path;
  } catch {
    return null;
  }
}

/** What {@link resolveStdioEntry} is allowed to consult. */
export type EntryRequest = {
  env?: PathEnvironment;
  platform?: string;
  /**
   * The state directory whose `bin/xplainer` is the stable name.
   *
   * Omitted, no launcher is considered — which is what a caller with no state directory in hand
   * means, and it keeps this function from reading the environment behind its own parameters.
   */
  stateDir?: string | undefined;
  /** The arguments the entry carries. `mcp --attach` unless a caller says otherwise. */
  args?: readonly string[] | undefined;
};

/** The command line an agent will spawn: the launcher, else the binary on `PATH`, else `npx`. */
export function resolveStdioEntry(request: EntryRequest = {}): StdioEntry {
  const env = request.env ?? process.env;
  const platform = request.platform ?? process.platform;
  const args = [...(request.args ?? ATTACH_ARGS)];
  const launcher =
    request.stateDir === undefined ? null : installedLauncher(request.stateDir, platform);
  if (launcher !== null) {
    return { command: launcher, args, source: "launcher" };
  }
  if (findOnPath(SERVER_NAME, env, platform) !== null) {
    return { command: SERVER_NAME, args, source: "path" };
  }
  return { command: "npx", args: ["-y", CLI_PACKAGE, ...args], source: "npx" };
}

/** The entry as one shell-ish line, for the sentence `connect` prints when it is done. */
export function describeEntry(entry: StdioEntry): string {
  return [entry.command, ...entry.args].join(" ");
}
