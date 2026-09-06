/**
 * `xplainer connect` — point an agent client at this daemon.
 *
 * Deferred to roadmap phase 1 (spec §Non-Goals): writing a client's MCP
 * configuration is a change to a file outside the repository, and this phase
 * writes none.
 */

import type { Command } from "commander";
import type { CliIo } from "../io.js";
import { createStubCommand } from "./stub.js";

export function createConnectCommand(io: CliIo): Command {
  return createStubCommand("connect", "Point an agent client at this daemon", io);
}
