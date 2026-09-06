/**
 * `xplainer connect` — point an agent client at this daemon.
 *
 * Two verbs, one entry. `claude` and `codex` differ only in *where* a configuration lives and *who*
 * is allowed to write it; what gets written is the same stdio command line for both, produced by
 * `connect/entry.ts` and never by either writer
 * ([ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md) §The agent path is IPC, not
 * TCP: "No URL and no token enter any agent configuration file").
 *
 * **Every run starts by proving there is a daemon.** ADR 0020 §Ordering — "`connect` refuses to
 * write an agent configuration pointing at a daemon that has never answered (`--force` overrides). A
 * working-looking config for a daemon that is not running is the single most likely first-run
 * support ticket" — and the proof is `daemon.json`'s recorded port, read through
 * `connect/preflight.ts`. The port is *not* written anywhere; it is read so that this command cannot
 * be assuming `8787`, and printed so that a user on a machine with two daemons can see which one
 * they just connected to.
 *
 * **The exit codes are the table's** (`docs/ARCHITECTURE.md` §6): `3` for a precondition that is not
 * met, with nothing written — no daemon has ever bound here, or the file to edit cannot be
 * understood; `1` for a usage error, such as a scope this command cannot write without the vendor's
 * own CLI; `11` for a `daemon.json` that exists and cannot be read; and `70` for anything else,
 * including a `claude mcp add` that failed for its own reasons.
 *
 * **This is not an agent-facing entry**, so unlike `commands/mcp.ts` it writes its summary to
 * stdout. Nothing spawns `connect` and reads its stdout as a protocol.
 */

import { Command } from "commander";
import {
  CLAUDE_CLI,
  CLAUDE_DEFAULT_SCOPE,
  CLAUDE_SCOPES,
  CLAUDE_SERVERS_KEY,
  claudeAddArgv,
  claudeUserConfigPath,
  runClaudeAdd,
  writeClaudeUserConfig,
} from "../connect/claude.js";
import { CODEX_TABLE_PATH, codexConfigPath, writeCodexConfig } from "../connect/codex.js";
import { describeEntry, findOnPath, resolveStdioEntry, type StdioEntry } from "../connect/entry.js";
import { type PreflightResult, preflightDaemon } from "../connect/preflight.js";
import { ConnectRefusal } from "../connect/refusal.js";
import { StateFileUnreadableError } from "../daemon/daemon-state.js";
import { DAEMON_INTERNAL_EXIT_CODE, PRECONDITION_UNMET_EXIT_CODE } from "../daemon/exit-codes.js";
import { resolveStateDir } from "../daemon/state-dir.js";
import type { CliIo } from "../io.js";

/** The exit code commander itself uses for a usage error, and the one a refused flag gets. */
const USAGE_EXIT_CODE = 1;

/** The flags both verbs share. */
type CommonOptions = {
  force?: boolean;
};

/** What `xplainer connect claude` parses. */
type ClaudeOptions = CommonOptions & {
  scope: string;
};

/** What `xplainer connect codex` parses. */
type CodexOptions = CommonOptions & {
  config?: string;
};

/** The daemon this run found, and the command line an agent will be given for it. */
type Preparation = {
  entry: StdioEntry;
  /** The summary line naming which daemon, and where its port came from. */
  daemonLine: string;
};

/**
 * Read `daemon.json`, refuse if no daemon has ever bound, and resolve the entry to write.
 *
 * Everything that can stop a run before a byte is written happens here, so that both verbs refuse in
 * the same words and with the same code.
 */
function prepare(io: CliIo, verb: string, options: CommonOptions): Preparation {
  const stateDir = resolveStateDir();
  let daemon: PreflightResult;
  try {
    daemon = preflightDaemon({ stateDir, force: options.force === true });
  } catch (error) {
    if (error instanceof StateFileUnreadableError) {
      io.writeErr(`xplainer connect ${verb}: ${error.message}\n`);
      io.exit(error.exitCode);
    }
    throw error;
  }
  if (!daemon.ok) {
    io.writeErr(`xplainer connect ${verb}: ${daemon.message}\n`);
    io.exit(PRECONDITION_UNMET_EXIT_CODE);
  }
  return {
    entry: resolveStdioEntry(),
    daemonLine:
      `  daemon:  port ${daemon.port}, from ${daemon.source} — the entry carries no URL, ` +
      "no port and no token",
  };
}

/** Turn whatever a writer raised into the documented exit for its condition. */
function refuse(io: CliIo, verb: string, error: unknown): never {
  if (error instanceof ConnectRefusal) {
    io.writeErr(`xplainer connect ${verb}: ${error.message}\n`);
    return io.exit(error.exitCode);
  }
  const detail = error instanceof Error ? error.message : String(error);
  io.writeErr(`xplainer connect ${verb}: ${detail}\n`);
  return io.exit(DAEMON_INTERNAL_EXIT_CODE);
}

/** Run one writer, and end the process with the documented code if it refuses. */
function attempt<T>(io: CliIo, verb: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    return refuse(io, verb, error);
  }
}

/** The summary both verbs print: a headline, then the facts, indented. */
function report(io: CliIo, agent: string, lines: readonly string[]): void {
  io.writeOut(
    `xplainer connect ${agent}: registered the MCP server "xplainer" with ${
      agent === "claude" ? "Claude Code" : "Codex CLI"
    }.\n${lines.join("\n")}\n`,
  );
}

function createClaudeCommand(io: CliIo): Command {
  return new Command("claude")
    .description("Register this daemon's stdio entry with Claude Code")
    .option(
      "--scope <scope>",
      `configuration scope for \`${CLAUDE_CLI} mcp add\` (${CLAUDE_SCOPES.join(", ")})`,
      CLAUDE_DEFAULT_SCOPE,
    )
    .option("--force", "write the entry even though no daemon has bound on this machine")
    .action((options: ClaudeOptions) => {
      if (!CLAUDE_SCOPES.includes(options.scope)) {
        io.writeErr(
          `xplainer connect claude: --scope ${options.scope} is not one of ` +
            `${CLAUDE_SCOPES.join(", ")}.\n`,
        );
        io.exit(USAGE_EXIT_CODE);
      }

      const { entry, daemonLine } = prepare(io, "claude", options);
      const lines = [`  runs:    ${describeEntry(entry)}`, daemonLine];
      const claude = findOnPath(CLAUDE_CLI);

      if (claude !== null) {
        const argv = claudeAddArgv(entry, options.scope);
        const result = attempt(io, "claude", () => runClaudeAdd(claude, argv));
        if (result.status !== 0) {
          if (result.stderr.trim() !== "") {
            io.writeErr(`${result.stderr.trimEnd()}\n`);
          }
          io.writeErr(
            `xplainer connect claude: \`${CLAUDE_CLI} ${argv.join(" ")}\` exited ` +
              `${String(result.status)}, so nothing was registered.\n`,
          );
          io.exit(DAEMON_INTERNAL_EXIT_CODE);
        }
        lines.push(`  via:     ${claude} mcp add, at ${options.scope} scope`);
        report(io, "claude", lines);
        return;
      }

      // No vendor CLI on PATH. The user-scope file is the only one this command writes itself:
      // `local` and `project` name a file that belongs to a *directory*, and guessing which
      // directory a user meant is how a `.mcp.json` ends up committed (ADR 0020 §Security R-SEC-8).
      if (options.scope !== CLAUDE_DEFAULT_SCOPE) {
        io.writeErr(
          `xplainer connect claude: \`${CLAUDE_CLI}\` is not on PATH, and --scope ` +
            `${options.scope} names a file that CLI owns rather than one this command writes. ` +
            `Install the Claude Code CLI, or use --scope ${CLAUDE_DEFAULT_SCOPE}, whose file ` +
            "this command can write directly.\n",
        );
        io.exit(USAGE_EXIT_CODE);
      }

      const path = claudeUserConfigPath();
      const written = attempt(io, "claude", () => writeClaudeUserConfig(path, entry));
      lines.push(
        `  wrote:   ${path} (${CLAUDE_SERVERS_KEY}.xplainer, ` +
          `${written.replaced ? "replacing the entry that was there" : "a new entry"})`,
        `  note:    \`${CLAUDE_CLI}\` is not on PATH, so the ${CLAUDE_DEFAULT_SCOPE}-scope file ` +
          "was written directly.",
      );
      report(io, "claude", lines);
    });
}

function createCodexCommand(io: CliIo): Command {
  return new Command("codex")
    .description("Register this daemon's stdio entry with Codex CLI")
    .option("--config <path>", "config.toml to edit (default: ~/.codex/config.toml)")
    .option("--force", "write the entry even though no daemon has bound on this machine")
    .action((options: CodexOptions) => {
      const { entry, daemonLine } = prepare(io, "codex", options);
      const path = options.config ?? codexConfigPath();
      const written = attempt(io, "codex", () => writeCodexConfig(path, entry));
      report(io, "codex", [
        `  runs:    ${describeEntry(entry)}`,
        daemonLine,
        `  wrote:   ${path} ([${CODEX_TABLE_PATH.join(".")}], ` +
          `${written.replaced ? "replacing the table that was there" : "a new table"})`,
      ]);
    });
}

/**
 * The group, with its own output routing for the reason `commands/daemon.ts` gives: commander's
 * `addCommand()` copies neither `configureOutput()` nor `exitOverride()` from the parent, so a group
 * added to an already-configured program still holds the default one and would write straight to the
 * process streams. `helpCommand(false)` is load-bearing for the same reason it is there: an implicit
 * `help [command]` would make this group list three verbs.
 */
export function createConnectCommand(io: CliIo): Command {
  const connect = new Command("connect")
    .description("Point an agent client at this daemon")
    .helpCommand(false)
    .configureOutput({
      writeOut: (text) => {
        io.writeOut(text);
      },
      writeErr: (text) => {
        io.writeErr(text);
      },
    })
    .exitOverride((error) => io.exit(error.exitCode));

  connect.addCommand(createClaudeCommand(io));
  connect.addCommand(createCodexCommand(io));

  return connect;
}
