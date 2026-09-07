/**
 * The command line `xplainer connect` writes into an agent's configuration, and how it is chosen.
 *
 * [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md) §The agent path is IPC, not
 * TCP settles *what* is written: "`xplainer connect claude|codex` therefore writes a **stdio** entry
 * by default, pointing at `xplainer mcp --attach`, which proxies stdio to that socket. No URL and no
 * token enter any agent configuration file." Everything in this file exists to produce that one
 * command line, so that neither writer invents its own.
 *
 * **Why the entry is a *name* and not a path.** `xplainer` is written bare so the configuration
 * keeps working after an upgrade moves the binary — an agent configuration is a durable file, and
 * an absolute path into a version-scoped npm directory is exactly the kind of value that rots. When
 * the binary is *not* on `PATH` the fallback is `npx -y @xplainer/cli mcp --attach`, which is the
 * form [ADR 0013](../../../../docs/adr/0013-one-skill-two-plugin-bundles-claude-and-codex.md)
 * already ships in both plugin bundles (`npx -y @xplainer/cli mcp`, without `--attach`, because a
 * bundle installs on a machine that has no daemon).
 *
 * **The lookup is a real `PATH` walk and never a spawn.** Asking the operating system by running
 * `xplainer --version` would mean starting a Node process to answer a question about a directory
 * listing, and — worse — a machine with a *broken* `xplainer` on `PATH` would answer "no" and get an
 * `npx` entry pointing at a package the broken install is already a copy of. `X_OK` on the file is
 * the question actually being asked.
 */

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import process from "node:process";

/** The name both agents know this server by, in their configuration and in their UI. */
export const SERVER_NAME = "xplainer";

/** The published package `npx` fetches when the binary is not installed. */
export const CLI_PACKAGE = "@xplainer/cli";

/** The verb and flag that proxy an agent's stdio to the daemon's socket (`commands/mcp.ts`). */
export const ATTACH_ARGS: readonly string[] = ["mcp", "--attach"];

/** Which of the two forms {@link resolveStdioEntry} chose, so the caller can say which and why. */
export type EntrySource = "path" | "npx";

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

/** What {@link resolveStdioEntry} is allowed to consult. */
export type EntryRequest = {
  env?: PathEnvironment;
  platform?: string;
};

/** The command line an agent will spawn: the binary if it is installed, else `npx`. */
export function resolveStdioEntry(request: EntryRequest = {}): StdioEntry {
  const env = request.env ?? process.env;
  const platform = request.platform ?? process.platform;
  if (findOnPath(SERVER_NAME, env, platform) !== null) {
    return { command: SERVER_NAME, args: [...ATTACH_ARGS], source: "path" };
  }
  return { command: "npx", args: ["-y", CLI_PACKAGE, ...ATTACH_ARGS], source: "npx" };
}

/** The entry as one shell-ish line, for the sentence `connect` prints when it is done. */
export function describeEntry(entry: StdioEntry): string {
  return [entry.command, ...entry.args].join(" ");
}
