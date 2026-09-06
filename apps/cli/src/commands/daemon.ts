/**
 * `xplainer daemon` — install and manage the always-on local daemon.
 *
 * Deferred to roadmap phase 2, and registered now for the same reason `mcp`,
 * `setup` and `connect` are: the command surface is the part of this that other
 * things depend on. `xplainer connect` will point an agent client at a daemon
 * this group installed, and the README, the ADRs and the desktop client all name
 * these verbs — so the names, their order and their exit code are fixed here and
 * asserted in `program.test.ts`, and the later phase changes what they do rather
 * than what the CLI offers.
 *
 * **Why `daemon` and not `service`.** `daemon` is already this repository's word
 * for the thing (ADR 0016: "The daemon has no authentication and binds
 * localhost"; `resolveDaemonUrl()` in `apps/desktop`). On Windows the later
 * implementation registers a Scheduled Task rather than a Windows Service, so
 * `xplainer service install` would send a user to `services.msc` to find
 * nothing.
 *
 * **This group carries its own output routing and `exitOverride`.** Commander's
 * `addCommand()` does not copy either from the parent, and `configureOutput()`
 * replaces the configuration object rather than mutating it, so a child added to
 * an already-configured program still holds the default one. Without the two
 * calls below, `xplainer daemon --help` and a bare `xplainer daemon` would write
 * straight to the process streams and call `process.exit` — invisible to the
 * test that has to prove this group lists exactly seven verbs. Production
 * behaviour is unchanged, because `processIo` is the process streams and
 * `process.exit`.
 *
 * **`helpCommand(false)` is load-bearing here too**, for the reason `program.ts`
 * gives: commander adds an implicit `help [command]` entry to any command that
 * has subcommands, which would make this group list eight.
 */

import { Command } from "commander";
import type { CliIo } from "../io.js";
import { createStubCommand } from "./stub.js";

/** The verbs the group offers, in the order `xplainer daemon --help` lists them. */
const DAEMON_VERBS: readonly (readonly [name: string, description: string])[] = [
  ["install", "Install the daemon so it starts on boot or login"],
  ["uninstall", "Remove the installed daemon and its supervisor registration"],
  ["start", "Start the installed daemon and wait for it to answer"],
  ["stop", "Stop the running daemon"],
  ["restart", "Restart the daemon, clearing a latched start failure"],
  ["status", "Report whether the daemon is installed, running and healthy"],
  ["logs", "Show the daemon's log output"],
];

export function createDaemonCommand(io: CliIo): Command {
  const daemon = new Command("daemon")
    .description("Install and manage the always-on local daemon")
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

  for (const [name, description] of DAEMON_VERBS) {
    daemon.addCommand(createStubCommand(name, description, io));
  }

  return daemon;
}
