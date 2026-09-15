/**
 * `xplainer connect copilot` — register the stdio entry with GitHub Copilot CLI.
 *
 * Copilot CLI has both a vendor writer (`copilot mcp add`) and a documented user configuration
 * file at `<COPILOT_HOME>/mcp-config.json` (default `~/.copilot/mcp-config.json`). The vendor writer
 * wins when `copilot` is on PATH; the JSON writer below is the fallback for a machine where the
 * client is installed another way, and it also gives this package a testable representation of the
 * configuration it expects.
 *
 * **`connect` must be re-runnable.** If Copilot refuses `mcp add` because the name already exists,
 * the existing user entry is removed and the same add is tried once more. This mirrors the Claude
 * path: nothing is removed for an unrelated vendor failure, and a failure after removal is reported
 * distinctly so the caller never claims an old entry is still there when this run removed it.
 *
 * The skill is installed separately by `connect/skill.ts`, into the same Copilot home under
 * `skills/xplainer/SKILL.md`. `COPILOT_HOME` therefore moves both halves together.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { PRECONDITION_UNMET_EXIT_CODE } from "../daemon/exit-codes.js";
import { writeFileAtomically } from "./atomic-write.js";
import { type PathEnvironment, SERVER_NAME, type StdioEntry } from "./entry.js";
import { ConnectRefusal } from "./refusal.js";
import { runVendorCli, type VendorCliResult } from "./vendor-cli.js";

/** The vendor CLI this command prefers to delegate to. */
export const COPILOT_CLI = "copilot";

/** Copilot's configuration directory when `COPILOT_HOME` is not set. */
export const COPILOT_CONFIG_DIR = ".copilot";

/** The environment variable Copilot CLI itself uses to move its configuration directory. */
export const COPILOT_HOME_ENV = "COPILOT_HOME";

/** The file holding user-level MCP servers. */
export const COPILOT_CONFIG_FILE = "mcp-config.json";

/** The top-level object containing user MCP servers. */
export const COPILOT_SERVERS_KEY = "mcpServers";

/** The local stdio entry as Copilot's documented JSON shape records it. */
export type CopilotServerEntry = {
  type: "local";
  command: string;
  args: string[];
  tools: ["*"];
};

/** Copilot's configuration home, respecting the same override the client itself reads. */
export function copilotHome(home: string = homedir(), env: PathEnvironment = process.env): string {
  const configured = env[COPILOT_HOME_ENV]?.trim();
  return configured === undefined || configured === ""
    ? join(home, COPILOT_CONFIG_DIR)
    : configured;
}

/** `<copilot home>/mcp-config.json`. */
export function copilotConfigPath(
  home: string = homedir(),
  env: PathEnvironment = process.env,
): string {
  return join(copilotHome(home, env), COPILOT_CONFIG_FILE);
}

/** The argument vector GitHub documents for adding a local stdio MCP server. */
export function copilotAddArgv(entry: StdioEntry): string[] {
  return ["mcp", "add", SERVER_NAME, "--", entry.command, ...entry.args];
}

/** The vendor command that gives this user-level name back before a replacement add. */
export function copilotRemoveArgv(): string[] {
  return ["mcp", "remove", SERVER_NAME];
}

/**
 * Whether a failed add says the user-level name is already taken.
 *
 * As on the Claude path, the match is deliberately only the vendor's semantic phrase. If Copilot
 * changes that wording, the command degrades to reporting the vendor failure and removes nothing.
 */
export function isCopilotAlreadyRegistered(result: VendorCliResult): boolean {
  return /already exists/i.test(`${result.stderr}\n${result.stdout}`);
}

/** What asking Copilot CLI to record this entry came to. */
export type CopilotRegistration =
  | { ok: true; replaced: boolean }
  | { ok: false; argv: string[]; result: VendorCliResult; removed: boolean };

/** Register the entry through `copilot mcp add`, replacing the same user-level name when needed. */
export function registerWithCopilotCli(
  program: string,
  entry: StdioEntry,
  env: PathEnvironment = process.env,
): CopilotRegistration {
  const addArgv = copilotAddArgv(entry);
  const added = runVendorCli(program, addArgv, env);
  if (added.status === 0) {
    return { ok: true, replaced: false };
  }
  if (!isCopilotAlreadyRegistered(added)) {
    return { ok: false, argv: addArgv, result: added, removed: false };
  }

  const removed = runVendorCli(program, copilotRemoveArgv(), env);
  if (removed.status !== 0) {
    return { ok: false, argv: addArgv, result: added, removed: false };
  }

  const readded = runVendorCli(program, addArgv, env);
  if (readded.status !== 0) {
    return { ok: false, argv: addArgv, result: readded, removed: true };
  }
  return { ok: true, replaced: true };
}

/** The entry written to `mcp-config.json`. */
export function copilotServerEntry(entry: StdioEntry): CopilotServerEntry {
  return {
    type: "local",
    command: entry.command,
    args: [...entry.args],
    tools: ["*"],
  };
}

/** What the fallback writer did to Copilot's configuration. */
export type CopilotWriteResult = {
  merged: boolean;
  replaced: boolean;
};

/**
 * Upsert `mcpServers.xplainer`, preserving every other key and server in Copilot's user config.
 * Invalid JSON is a refusal rather than an overwrite: a broken config should stay inspectable.
 */
export function writeCopilotConfig(path: string, entry: StdioEntry): CopilotWriteResult {
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
        `${path} exists and is not JSON (${String(cause)}), so this command will not rewrite it.`,
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

  const existingServers = document[COPILOT_SERVERS_KEY];
  const servers: Record<string, unknown> =
    typeof existingServers === "object" &&
    existingServers !== null &&
    !Array.isArray(existingServers)
      ? { ...(existingServers as Record<string, unknown>) }
      : {};
  const replaced = Object.hasOwn(servers, SERVER_NAME);
  servers[SERVER_NAME] = copilotServerEntry(entry);
  document[COPILOT_SERVERS_KEY] = servers;

  writeFileAtomically(path, `${JSON.stringify(document, null, 2)}\n`);
  return { merged: raw !== null, replaced };
}
