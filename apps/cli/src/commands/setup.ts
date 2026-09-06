/**
 * `xplainer setup` — prepare the local render and TTS toolchain.
 *
 * Deferred to roadmap phase 1 (spec §Non-Goals). Nothing in this phase downloads
 * a browser, a model or a binary — AC-1d greps for exactly that — so the command
 * that will one day do it starts life saying so.
 */

import type { Command } from "commander";
import type { CliIo } from "../io.js";
import { createStubCommand } from "./stub.js";

export function createSetupCommand(io: CliIo): Command {
  return createStubCommand("setup", "Prepare the local render and TTS toolchain", io);
}
