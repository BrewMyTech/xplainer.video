/**
 * `xplainer connect codex` — one `[mcp_servers.xplainer]` table in `~/.codex/config.toml`.
 *
 * **Codex CLI's own writer is preferred, exactly as on the Claude path.** `codex mcp add <NAME> --
 * <COMMAND>…` exists (codex-cli 0.153.4) and is the right thing to delegate to when `codex` is on
 * `PATH`: it appends the same three-line `[mcp_servers.<name>]` table this module renders, and
 * running it twice updates that table in place rather than duplicating it, so it is already
 * idempotent in the sense this command needs. Delegating means the entry keeps being written the way
 * that CLI writes entries when its own layout moves.
 *
 * It is not byte-preserving, and the honest version of that is worth writing down: measured against
 * 0.153.4, it rewrites the `mcp_servers` subtree and **drops comments attached to or inside an
 * `[mcp_servers.*]` table**, while a comment at the top of the file, before any other table, on a
 * key, or after everything survives untouched. That is the vendor's own file and the vendor's own
 * trade, and it is a narrower loss than the one this module exists to avoid — but a user who wants
 * their `[mcp_servers.*]` comments kept exactly has `--config`, which reaches the writer below.
 *
 * **The direct writer below is the fallback, and it is still load-bearing.** Two cases reach it:
 * `codex` is not installed on this machine, and `--config <path>` names a file that CLI has no flag
 * to be pointed at (`-c key=value` overrides *values*, not the file). Both are real — a Codex plugin
 * bundle installs on machines with no `codex` binary, and `--config` is how this repository's own
 * tests write somewhere that is not a developer's `~/.codex`. So this remains the one place in the
 * repository that edits somebody else's configuration format directly, and two rules follow from
 * that:
 *
 * **The file is edited, never rewritten.** `config.toml` holds the user's model, their approval
 * policy, a `[projects."…"]` table per trusted directory and every other MCP server they use, with
 * their comments between. Reading it into a data structure and serialising it back would return a
 * file that means the same thing and looks nothing like the one they wrote. So the table's own lines
 * are located (`connect/toml-tables.ts`) and only those lines are replaced; a file with no such
 * table gets the block appended after a blank line, and nothing else in it moves by one byte.
 *
 * **Running it twice leaves one entry.** That is what "idempotent" has to mean for a file the user
 * may also have edited by hand: not "the second run is a no-op" — the entry may legitimately need
 * updating, from an `npx` command line to an installed binary — but "the second run leaves exactly
 * one `[mcp_servers.xplainer]`, saying what this version of `connect` writes".
 *
 * The entry is `connect/entry.ts`'s stdio command line: `command` and `args`, with no `url`, no
 * `bearer_token_env_var` and no `oauth_resource`. [ADR 0013](../../../../docs/adr/0013-one-skill-two-plugin-bundles-claude-and-codex.md)
 * §Note, 2026-09-06 records why the OAuth key is absent even from the shipped plugin bundle — "a
 * loopback daemon has no authorization server, and leaving the key makes the client fire a discovery
 * request at a host that will not answer" — and that reasoning applies here twice over, since this
 * entry attaches to a unix socket.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { PRECONDITION_UNMET_EXIT_CODE } from "../daemon/exit-codes.js";
import { writeFileAtomically } from "./atomic-write.js";
import { type PathEnvironment, SERVER_NAME, type StdioEntry } from "./entry.js";
import { ConnectRefusal } from "./refusal.js";
import { findConflictingDefinition, findTableSpan } from "./toml-tables.js";
import { runVendorCli, type VendorCliResult } from "./vendor-cli.js";

/** The vendor CLI this command prefers to delegate to. */
export const CODEX_CLI = "codex";

/** Codex's configuration directory, relative to the home directory. */
export const CODEX_CONFIG_DIR = ".codex";

/** The file inside it that `--config` overrides. */
export const CODEX_CONFIG_FILE = "config.toml";

/** The table every Codex MCP server lives under. */
export const CODEX_SERVERS_TABLE = "mcp_servers";

/** This server's table, as the path `connect/toml-tables.ts` looks for. */
export const CODEX_TABLE_PATH: readonly string[] = [CODEX_SERVERS_TABLE, SERVER_NAME];

/** `~/.codex/config.toml`, or the same file under a home directory a test supplied. */
export function codexConfigPath(home: string = homedir()): string {
  return join(home, CODEX_CONFIG_DIR, CODEX_CONFIG_FILE);
}

/**
 * The argument vector that asks Codex CLI's own writer to record this entry.
 *
 * `--` is not optional decoration: `codex mcp add` reads everything after it as the command line to
 * launch, which is what keeps `--attach` an argument of `xplainer mcp` rather than a flag `codex`
 * would try to interpret.
 */
export function codexAddArgv(entry: StdioEntry): string[] {
  return ["mcp", "add", SERVER_NAME, "--", entry.command, ...entry.args];
}

/** What asking Codex CLI to record this entry came to. */
export type CodexRegistration =
  | { ok: true }
  | {
      ok: false;
      /** The vector that failed, so the caller can print the command a user could run. */
      argv: string[];
      /** What that run said and how it ended. */
      result: VendorCliResult;
    };

/**
 * Register the entry through `codex mcp add`.
 *
 * There is no remove-then-add dance here, and that is not an oversight: `codex mcp add` run twice
 * over the same name updates the table it finds and exits `0` both times, so the vendor already
 * gives this command the idempotence `claude mcp add` has to be given by hand.
 */
export function registerWithCodexCli(
  program: string,
  entry: StdioEntry,
  env: PathEnvironment = process.env,
): CodexRegistration {
  const argv = codexAddArgv(entry);
  const result = runVendorCli(program, argv, env);
  return result.status === 0 ? { ok: true } : { ok: false, argv, result };
}

/** A TOML basic string. The values here are this command's own, and quoting them is still cheaper
 * than reasoning about whether they need it. */
function tomlString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/** The three lines this command owns, without a trailing newline. */
export function renderCodexTable(entry: StdioEntry): string {
  const args = entry.args.map(tomlString).join(", ");
  return [
    `[${CODEX_TABLE_PATH.join(".")}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${args}]`,
  ].join("\n");
}

/** What {@link upsertCodexTable} did to the document it was given. */
export type CodexUpsert = {
  /** The whole file, as it should now be written. */
  text: string;
  /** `true` when an existing table was replaced, `false` when the block was appended. */
  replaced: boolean;
};

/**
 * Return `source` with exactly one `[mcp_servers.xplainer]` table, saying what `entry` says.
 *
 * Pure, so the interesting half of this command is testable without a home directory: what goes in
 * is a document and what comes out is a document.
 */
export function upsertCodexTable(source: string, entry: StdioEntry): CodexUpsert {
  const conflict = findConflictingDefinition(source.split(/\r?\n/), CODEX_TABLE_PATH);
  if (conflict !== null) {
    throw new ConnectRefusal(
      PRECONDITION_UNMET_EXIT_CODE,
      `this configuration already defines ${CODEX_TABLE_PATH.join(".")} in a form this command ` +
        `will not rewrite: ${conflict}. Adding a [${CODEX_TABLE_PATH.join(".")}] table beside it ` +
        "would be a duplicate key, and Codex would stop reading the whole file. Remove that " +
        "declaration and run this again.",
    );
  }

  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const block = renderCodexTable(entry).split("\n");
  const span = findTableSpan(lines, CODEX_TABLE_PATH);
  if (span !== null) {
    const next = [...lines.slice(0, span.start), ...block, ...lines.slice(span.end)];
    return { text: next.join(eol), replaced: true };
  }

  // Append: trailing blank lines are dropped so the separator below is exactly one blank line,
  // whether the file ended with none, one, or three.
  const body = [...lines];
  while (body.length > 0 && (body[body.length - 1] ?? "").trim() === "") {
    body.pop();
  }
  const next = body.length === 0 ? [...block] : [...body, "", ...block];
  return { text: `${next.join(eol)}${eol}`, replaced: false };
}

/** What writing the file did. */
export type CodexWriteResult = {
  /** `true` when the file was already there and was edited in place. */
  merged: boolean;
  /** `true` when an existing entry of this name was replaced rather than appended. */
  replaced: boolean;
};

/** Read `path`, upsert the table, write it back atomically. */
export function writeCodexConfig(path: string, entry: StdioEntry): CodexWriteResult {
  let source: string | null;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      source = null;
    } else {
      throw error;
    }
  }

  const upsert = upsertCodexTable(source ?? "", entry);
  const text = upsert.text.endsWith("\n") ? upsert.text : `${upsert.text}\n`;
  writeFileAtomically(path, text);
  return { merged: source !== null, replaced: upsert.replaced };
}
