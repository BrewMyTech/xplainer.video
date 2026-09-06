/**
 * `xplainer mcp` — serve the tool contract over stdio, in this process or through the daemon.
 *
 * Two entries with one name, because an agent's configuration names a *command* and the answer to
 * "where do the tools actually run" is a property of the machine rather than of the agent:
 *
 * - **`xplainer mcp`** runs the eight tools here, in this process, over the shared workspace and a
 *   job store private to the session (`../mcp/stdio-server.ts`). It needs nothing installed, which
 *   is why it is what the plugin bundles' `npx -y @xplainer/cli mcp` points at, and it is the MCP
 *   specification's own first-choice mitigation for a local server — "Use the `stdio` transport to
 *   limit access to just the MCP client", quoted in
 *   [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md) §The agent path is IPC,
 *   not TCP.
 * - **`xplainer mcp --attach`** proxies the same stdio to a running daemon's unix socket
 *   (`../mcp/attach.ts`), so the tools run in the supervised process that owns the state directory
 *   and the job store — which is what `xplainer connect` writes once a daemon is installed, and
 *   what makes an agent's configuration file hold no URL and no secret.
 *
 * **Stdout belongs to JSON-RPC.** Both paths write every human-readable line to stderr, and this
 * command never calls `io.writeOut`: one stray line on stdout is a parse error inside the agent,
 * with no message the user will ever see. That is the same rule `serve` follows for its ready line
 * ([ADR 0025](../../../../docs/adr/0025-daemon-updates-and-readiness.md) §Part three), pointed the
 * other way.
 *
 * The exit codes are the documented ones and no new ones: **`8`** for a contract-incompatible
 * daemon (ADR 0025 §Part two, and `../mcp/attach.ts` is where both versions are named), **`4`** for
 * a daemon that is not answering on its socket, and **`70`** for anything this command cannot
 * classify.
 */

import { Command } from "commander";
import { DAEMON_INTERNAL_EXIT_CODE } from "../daemon/exit-codes.js";
import { resolveIpcPath } from "../daemon/ipc.js";
import { resolveStateDir } from "../daemon/state-dir.js";
import type { CliIo } from "../io.js";
import {
  assertContractCompatible,
  ContractSkewError,
  DaemonUnreachableError,
  probeDaemonHealth,
  proxyStdioToDaemon,
} from "../mcp/attach.js";
import { serveStdioMcp } from "../mcp/stdio-server.js";

/** What commander parses out of the command line. */
type McpOptions = {
  attach?: boolean;
};

/** Report a failure this command can name, or fall back to `70`. */
function refuse(io: CliIo, error: unknown): never {
  if (error instanceof ContractSkewError || error instanceof DaemonUnreachableError) {
    io.writeErr(`${error.message}\n`);
    return io.exit(error.exitCode);
  }
  const detail = error instanceof Error ? error.message : String(error);
  io.writeErr(`xplainer mcp: could not start: ${detail}\n`);
  return io.exit(DAEMON_INTERNAL_EXIT_CODE);
}

export function createMcpCommand(io: CliIo): Command {
  return new Command("mcp")
    .description("Serve the MCP tools over stdio")
    .option(
      "--attach",
      "proxy this stdio session to the running daemon's IPC socket instead of running the tools " +
        "in this process",
    )
    .action(async (options: McpOptions) => {
      const log = (line: string): void => {
        io.writeErr(`${line}\n`);
      };

      if (options.attach !== true) {
        const session = await serveStdioMcp({ log }).catch((error: unknown) => refuse(io, error));
        await session.closed;
        return;
      }

      const socketPath = resolveIpcPath(resolveStateDir());
      // The gate, before a session exists: read the daemon's advertised contract version and
      // refuse an incompatible pair with exit `8` rather than proxying into an illegible failure
      // three calls later (ADR 0025 §Part two).
      const health = await probeDaemonHealth(socketPath).catch((error: unknown) =>
        refuse(io, error),
      );
      try {
        assertContractCompatible(health);
      } catch (error) {
        refuse(io, error);
      }
      log(
        `xplainer mcp --attach: proxying this session to ${socketPath}; the daemon there runs ` +
          `release ${health.version} and speaks tool contract ${health.contractVersion}.`,
      );

      const attached = await proxyStdioToDaemon({ socketPath, log }).catch((error: unknown) =>
        refuse(io, error),
      );
      await attached.closed;
      // The proxy ends when the agent closes stdin, and there is nothing left to serve; exiting
      // explicitly keeps a lingering socket handle from holding the process open after that.
      io.exit(0);
    });
}
