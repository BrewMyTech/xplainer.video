/**
 * `xplainer connect` — point an agent client at this daemon.
 *
 * Two verbs, one entry. `claude` and `codex` differ only in *where* a configuration lives and *who*
 * is allowed to write it; what gets written is the same stdio command line for both, produced by
 * `connect/entry.ts` and never by either writer
 * ([ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md) §The agent path is IPC, not
 * TCP: "No URL and no token enter any agent configuration file").
 *
 * **Every run starts by proving there is a daemon — except the one that is offered when there is
 * none.** ADR 0020 §Ordering — "`connect` refuses to write an agent configuration pointing at a
 * daemon that has never answered (`--force` overrides). A working-looking config for a daemon that
 * is not running is the single most likely first-run support ticket" — and the proof is
 * `daemon.json`'s recorded port, read through `connect/preflight.ts`. The port is *not* written
 * anywhere; it is read so that this command cannot be assuming `8787`, and printed so that a user
 * on a machine with two daemons can see which one they just connected to.
 *
 * **`--spawn` writes the other entry, and bypasses that check.** It is what ADR 0020 §Degraded
 * paths prints first in both no-supervisor cases, so it is offered at exactly the moment no daemon
 * exists and `daemon install` has just refused; applying the preflight to it would make the
 * remediation refuse itself. What it writes is `xplainer mcp` **without** `--attach` — the eight
 * tools in the agent's own session, no supervision, no shared queue — and `connect/spawn.ts` is
 * where that entry and its extra fallback are decided. Both verbs carry it: the remediation
 * ADR 0020 prints names `claude` because that is the example it is written around, and a Codex user
 * on the same supervisor-less machine has the same problem and the same answer.
 *
 * **The exit codes are the table's** (`docs/ARCHITECTURE.md` §6): `3` for a precondition that is not
 * met, with nothing written — no daemon has ever bound here, or the file to edit cannot be
 * understood; `1` for a usage error, such as a scope this command cannot write without the vendor's
 * own CLI; `11` for a `daemon.json` that exists and cannot be read; and `70` for anything else,
 * including a vendor's own `mcp add` that failed for its own reasons.
 *
 * **Each verb prefers the vendor's writer and falls back to a file.** `claude mcp add` and
 * `codex mcp add` both exist and both are delegated to when that binary is on `PATH`; the direct
 * writers in `connect/claude.ts` and `connect/codex.ts` are for the machine where it is not, and —
 * on the Codex side — for a `--config <path>` that CLI has no way to be aimed at. Which branch ran
 * is printed either way, because "it worked" and "which file changed" are different questions.
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
  claudeUserConfigPath,
  registerWithClaudeCli,
  writeClaudeUserConfig,
} from "../connect/claude.js";
import {
  CODEX_CLI,
  CODEX_TABLE_PATH,
  codexConfigPath,
  registerWithCodexCli,
  writeCodexConfig,
} from "../connect/codex.js";
import { describeEntry, findOnPath, resolveStdioEntry, type StdioEntry } from "../connect/entry.js";
import { type PreflightResult, preflightDaemon } from "../connect/preflight.js";
import { ConnectRefusal } from "../connect/refusal.js";
import { installSkill, type SkillClient } from "../connect/skill.js";
import { resolveSpawnEntry } from "../connect/spawn.js";
import type { VendorCliResult } from "../connect/vendor-cli.js";
import { StateFileUnreadableError } from "../daemon/daemon-state.js";
import {
  DAEMON_INTERNAL_EXIT_CODE,
  PRECONDITION_UNMET_EXIT_CODE,
  USAGE_EXIT_CODE,
} from "../daemon/exit-codes.js";
import { resolveStateDir } from "../daemon/state-dir.js";
import type { CliIo } from "../io.js";

/** The flags both verbs share. */
type CommonOptions = {
  force?: boolean;
  spawn?: boolean;
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
  if (options.spawn === true) {
    // No preflight, on purpose: this is the entry offered when there is no daemon to prove. See
    // `connect/spawn.ts` for why the check is bypassed rather than overridden with `--force`.
    return {
      entry: resolveSpawnEntry({ stateDir }),
      daemonLine:
        "  daemon:  none — this entry starts the tools inside each agent session and stops with " +
        "it, so there is no warm process, no shared job queue and no desktop client",
    };
  }
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
    entry: resolveStdioEntry({ stateDir }),
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

/**
 * Report a vendor CLI that started and exited non-zero, and end with `70`.
 *
 * Its own message goes out first and unedited: it is the sentence about the actual condition, and
 * paraphrasing somebody else's refusal is how a user ends up searching for a string nothing prints.
 * The line after it names the command that produced it, because "connect failed" without the argv
 * is not something a user can run themselves.
 */
function vendorFailed(
  io: CliIo,
  verb: string,
  cli: string,
  argv: readonly string[],
  result: VendorCliResult,
  consequence: string,
): never {
  if (result.stderr.trim() !== "") {
    io.writeErr(`${result.stderr.trimEnd()}\n`);
  }
  io.writeErr(
    `xplainer connect ${verb}: \`${cli} ${argv.join(" ")}\` exited ` +
      `${String(result.status)}, ${consequence}\n`,
  );
  return io.exit(DAEMON_INTERNAL_EXIT_CODE);
}

/**
 * Install the skill, then print the summary both verbs end with.
 *
 * **The skill is written here because every successful path goes through this function**, and
 * `connect` had shipped for a release writing the transport and not the method: eight tools with no
 * instructions, which an agent then improvises. Four exits reach this point — the vendor CLI and the
 * direct writer, for each of two agents — and putting the write at any one of them would have left
 * the other three half-configured. The name says the side effect for the same reason.
 *
 * A refusal to write the skill is **not** fatal to the registration that already happened: the MCP
 * entry is on disk by now, so this reports the failure and the command still exits `0`. Saying
 * "registered" and then exiting non-zero would be the worse answer — a user would re-run a command
 * whose first half had already succeeded.
 */
function finish(io: CliIo, agent: SkillClient, lines: readonly string[]): void {
  const skill: string[] = [];
  try {
    const installed = installSkill(agent);
    skill.push(`  skill:   ${installed.updated ? "wrote" : "already current"} ${installed.path}`);
  } catch (error) {
    io.writeErr(
      `xplainer connect ${agent}: the MCP server is registered, but the skill was not written: ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  io.writeOut(
    `xplainer connect ${agent}: registered the MCP server "xplainer" with ${
      agent === "claude" ? "Claude Code" : "Codex CLI"
    }.\n${[...lines, ...skill].join("\n")}\n`,
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
    .option(
      "--spawn",
      "write an entry that starts `xplainer mcp` inside each agent session instead of attaching " +
        "to a daemon — the form for a machine with no service manager",
    )
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
        const registration = attempt(io, "claude", () =>
          registerWithClaudeCli(claude, entry, options.scope),
        );
        if (!registration.ok) {
          vendorFailed(
            io,
            "claude",
            CLAUDE_CLI,
            registration.argv,
            registration.result,
            registration.removed
              ? "and the entry that was there had already been removed, so this scope now holds " +
                  "none. Fix what that command reports and run this again."
              : "so nothing was registered.",
          );
        }
        lines.push(
          `  via:     ${claude} mcp add, at ${options.scope} scope` +
            (registration.replaced ? ", replacing the entry that was there" : ""),
        );
        finish(io, "claude", lines);
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
      finish(io, "claude", lines);
    });
}

function createCodexCommand(io: CliIo): Command {
  return new Command("codex")
    .description("Register this daemon's stdio entry with Codex CLI")
    .option("--config <path>", "config.toml to edit (default: ~/.codex/config.toml)")
    .option("--force", "write the entry even though no daemon has bound on this machine")
    .option(
      "--spawn",
      "write an entry that starts `xplainer mcp` inside each agent session instead of attaching " +
        "to a daemon — the form for a machine with no service manager",
    )
    .action((options: CodexOptions) => {
      const { entry, daemonLine } = prepare(io, "codex", options);
      const lines = [`  runs:    ${describeEntry(entry)}`, daemonLine];

      // `--config` names a file `codex mcp add` has no flag to be pointed at, so asking for one is
      // asking for the writer below. Without it, the vendor's own writer wins wherever it exists.
      const codex = options.config === undefined ? findOnPath(CODEX_CLI) : null;
      if (codex !== null) {
        const registration = attempt(io, "codex", () => registerWithCodexCli(codex, entry));
        if (!registration.ok) {
          vendorFailed(
            io,
            "codex",
            CODEX_CLI,
            registration.argv,
            registration.result,
            "so nothing was registered.",
          );
        }
        lines.push(`  via:     ${codex} mcp add`);
        finish(io, "codex", lines);
        return;
      }

      const path = options.config ?? codexConfigPath();
      const written = attempt(io, "codex", () => writeCodexConfig(path, entry));
      lines.push(
        `  wrote:   ${path} ([${CODEX_TABLE_PATH.join(".")}], ` +
          `${written.replaced ? "replacing the table that was there" : "a new table"})`,
      );
      finish(io, "codex", lines);
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
