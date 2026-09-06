/**
 * `xplainer serve` — the local daemon.
 *
 * This is the one command in the scaffold that does its whole job: it binds the
 * server core from `../server.js`, which answers `GET /healthz` and serves the
 * eight tools over Streamable HTTP at `/mcp` (AC-14c, AC-14d). What it serves
 * them from is the stub backend, because rendering and narration land in later
 * phases — the transport, the tool list and the port are real now so that the
 * work left is the work below `RenderBackend`.
 */

import { Command, InvalidArgumentError } from "commander";
import { createStubBackend } from "../backend.js";
import type { CliIo } from "../io.js";
import { DEFAULT_PORT, startServer } from "../server.js";

/** The highest port a TCP listener can bind. */
const MAX_PORT = 65535;

/**
 * Reject a port the OS could never bind before the server is built, so the
 * failure names the argument rather than surfacing as a bind error later.
 * `0` is allowed and means "any free port".
 */
function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > MAX_PORT) {
    throw new InvalidArgumentError(`Port must be a whole number between 0 and ${MAX_PORT}.`);
  }
  return port;
}

export function createServeCommand(io: CliIo): Command {
  return new Command("serve")
    .description("Serve /healthz and the MCP endpoint over HTTP")
    .option("-p, --port <port>", "port to listen on", parsePort, DEFAULT_PORT)
    .action(async (options: { port: number }) => {
      const running = await startServer({ backend: createStubBackend(), port: options.port });
      io.writeOut(`xplainer serve: listening on ${running.url} (MCP at ${running.url}/mcp)\n`);
    });
}
