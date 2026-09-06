/**
 * `xplainer mcp` — serve the tool contract over stdio.
 *
 * Deferred to roadmap phase 1 (spec §Non-Goals). The registration itself is not
 * deferred: `createMcpServer()` already builds the server this command will
 * attach a stdio transport to, so the work left here is transport wiring, not a
 * second tool list.
 */

import type { Command } from "commander";
import type { CliIo } from "../io.js";
import { createStubCommand } from "./stub.js";

export function createMcpCommand(io: CliIo): Command {
  return createStubCommand("mcp", "Serve the MCP tools over stdio", io);
}
