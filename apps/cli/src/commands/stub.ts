/**
 * The shape every deferred command takes.
 *
 * A command that is registered, appears in `--help`, names itself on stderr and
 * exits with a defined code is behaviour, not a placeholder — which is why the
 * plan (§4 S2.4b) scoped `mcp`, `setup` and `connect` this way rather than
 * leaving them out of the binary until their phase arrives, and why the
 * `daemon` group's verbs are scoped the same way. Registering them now also
 * fixes the command surface AC-14b asserts, so adding the implementations later
 * changes what a command does without changing what the CLI offers.
 */

import { Command } from "commander";
import type { CliIo } from "../io.js";
import { NOT_IMPLEMENTED_EXIT_CODE, notImplementedLine } from "../not-implemented.js";

/**
 * The name a command reports itself by: its own, behind its ancestors'.
 *
 * A stub inside a group has to name the whole path or `xplainer daemon install`
 * would report itself as `xplainer install`, which is not a command anyone can
 * run. Walking `parent` — commander's own public `Command | null` — stops at the
 * root program, whose `parent` is `null` and whose name is already the `xplainer`
 * prefix `notImplementedLine()` adds, so the top-level stubs still report exactly
 * their own name.
 */
function commandPath(command: Command): string {
  const names: string[] = [];
  let current: Command | null = command;
  while (current?.parent) {
    names.unshift(current.name());
    current = current.parent;
  }
  return names.join(" ");
}

/**
 * Build a command that reports itself as deferred and exits
 * {@link NOT_IMPLEMENTED_EXIT_CODE}.
 *
 * The command commander hands the action handler is the one that ran, which is
 * how the message stays correct wherever the stub is registered.
 */
export function createStubCommand(name: string, description: string, io: CliIo): Command {
  return new Command(name).description(description).action((_options, command: Command) => {
    io.writeErr(`${notImplementedLine(commandPath(command))}\n`);
    io.exit(NOT_IMPLEMENTED_EXIT_CODE);
  });
}
