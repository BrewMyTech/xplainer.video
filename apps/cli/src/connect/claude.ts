/**
 * `xplainer connect claude` — hand the entry to Claude Code's own CLI, or write the file it writes.
 *
 * **The CLI is preferred, and the reason is not convenience.** `claude mcp add` is the vendor's own
 * writer: it knows which file each scope lives in, it merges rather than replaces, and it keeps
 * working when that layout changes. A configuration writer that reimplements another program's file
 * format is a configuration writer that is one release behind for ever. So when `claude` is on
 * `PATH` this module *runs* it:
 *
 * ```
 * claude mcp add --transport stdio --scope user xplainer -- xplainer mcp --attach
 * ```
 *
 * **The fallback exists because a plugin bundle is not a CLI install.** Claude Code can be present
 * as a desktop application with no `claude` on this shell's `PATH`, and refusing there would leave
 * the user with nothing but a manual copy-paste. So `connect` writes the **user-scope** file itself:
 * `~/.claude.json`, whose top-level `mcpServers` object is exactly what `--scope user` maintains,
 * with every other key in that file left untouched.
 *
 * **User scope, never project scope** — [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md)
 * §Security R-SEC-8: "Claude Code at **user** scope … never `--scope project`, which writes a
 * `.mcp.json` the docs describe as shared through version control, i.e. a committed token". A
 * `--scope` flag is still offered because the vendor's CLI offers one and a user who asks for
 * `local` on purpose should get it — but the *default* is `user`, and the fallback writer implements
 * that one scope only. Writing a `.mcp.json` into whatever directory `connect` happened to be run
 * from, without the vendor's own confirmation, is not a thing this command will do behind a user's
 * back.
 *
 * The entry itself carries no URL, no port and no token; it is `connect/entry.ts`'s, not this
 * file's.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { PRECONDITION_UNMET_EXIT_CODE } from "../daemon/exit-codes.js";
import { writeFileAtomically } from "./atomic-write.js";
import { type PathEnvironment, SERVER_NAME, type StdioEntry } from "./entry.js";
import { ConnectRefusal } from "./refusal.js";

/** The vendor CLI this command prefers to delegate to. */
export const CLAUDE_CLI = "claude";

/** The user-scope configuration file, relative to the home directory. */
export const CLAUDE_USER_CONFIG_FILE = ".claude.json";

/** The key inside it that holds one entry per configured server. */
export const CLAUDE_SERVERS_KEY = "mcpServers";

/** The scopes `claude mcp add` accepts, in the order its own `--help` lists them. */
export const CLAUDE_SCOPES: readonly string[] = ["local", "user", "project"];

/** The one this command defaults to (R-SEC-8). */
export const CLAUDE_DEFAULT_SCOPE = "user";

/** The stdio entry as Claude Code records it. */
export type ClaudeServerEntry = {
  type: "stdio";
  command: string;
  args: string[];
};

/** `~/.claude.json`, or the same file under a home directory a test supplied. */
export function claudeUserConfigPath(home: string = homedir()): string {
  return join(home, CLAUDE_USER_CONFIG_FILE);
}

/** The argument vector that asks Claude Code's own CLI to record this entry. */
export function claudeAddArgv(entry: StdioEntry, scope: string): string[] {
  return [
    "mcp",
    "add",
    "--transport",
    "stdio",
    "--scope",
    scope,
    SERVER_NAME,
    "--",
    entry.command,
    ...entry.args,
  ];
}

/** The entry as it appears in the file — the shape `claude mcp add --transport stdio` writes. */
export function claudeServerEntry(entry: StdioEntry): ClaudeServerEntry {
  return { type: "stdio", command: entry.command, args: [...entry.args] };
}

/** What running the vendor CLI produced, in the three parts a caller has to report. */
export type ClaudeCliResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

/**
 * Run `claude mcp add`, and report what it did.
 *
 * The resolved absolute path is spawned rather than the bare name: this command has already looked
 * `claude` up on `PATH` to decide which branch to take, and spawning the name again would let the
 * two lookups disagree.
 */
export function runClaudeAdd(
  program: string,
  argv: readonly string[],
  env: PathEnvironment = process.env,
): ClaudeCliResult {
  const result = spawnSync(program, [...argv], {
    encoding: "utf8",
    env: env as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** What the fallback writer did to the file. */
export type ClaudeWriteResult = {
  /** `true` when the file was already there and was merged into. */
  merged: boolean;
  /** `true` when an entry of this name was already recorded and has been replaced. */
  replaced: boolean;
};

/**
 * Record the entry in `~/.claude.json`'s `mcpServers`, keeping every other key in that file.
 *
 * That file is Claude Code's whole per-user state — hundreds of kilobytes of project history,
 * onboarding flags and caches — so it is read, one key is set, and it is written back atomically. A
 * file that exists and is not JSON is a **refusal**, never an overwrite: replacing it would delete
 * everything a user's client knows about them, which is a far worse outcome than "connect failed".
 */
export function writeClaudeUserConfig(path: string, entry: StdioEntry): ClaudeWriteResult {
  let raw: string | null;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      raw = null;
    } else {
      throw error;
    }
  }

  let document: Record<string, unknown> = {};
  if (raw !== null && raw.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new ConnectRefusal(
        PRECONDITION_UNMET_EXIT_CODE,
        `${path} exists and is not JSON (${String(cause)}), so this command will not rewrite it — ` +
          "it holds Claude Code's whole per-user state. Repair or move that file, or install the " +
          "`claude` CLI and let it do the write.",
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ConnectRefusal(
        PRECONDITION_UNMET_EXIT_CODE,
        `${path} exists and does not hold a JSON object, so this command will not rewrite it.`,
      );
    }
    document = parsed as Record<string, unknown>;
  }

  const existingServers = document[CLAUDE_SERVERS_KEY];
  const servers: Record<string, unknown> =
    typeof existingServers === "object" &&
    existingServers !== null &&
    !Array.isArray(existingServers)
      ? { ...(existingServers as Record<string, unknown>) }
      : {};
  const replaced = Object.hasOwn(servers, SERVER_NAME);
  servers[SERVER_NAME] = claudeServerEntry(entry);
  document[CLAUDE_SERVERS_KEY] = servers;

  writeFileAtomically(path, `${JSON.stringify(document, null, 2)}\n`);
  return { merged: raw !== null, replaced };
}
