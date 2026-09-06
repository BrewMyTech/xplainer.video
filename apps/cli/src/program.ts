/**
 * The `xplainer` command surface.
 *
 * Five entries, fixed here and asserted in `program.test.ts`: `serve`, which
 * works; `mcp`, `setup` and `connect`, which report that they are deferred and
 * exit 2; and `daemon`, a group of seven verbs — `install`, `uninstall`,
 * `start`, `stop`, `restart`, `status`, `logs` — that report the same thing and
 * exit the same way (`commands/daemon.ts`).
 *
 * AC-14b was written against the first four and asserts an exact list, so
 * `daemon` is added here deliberately rather than discovered as a red test; the
 * criterion's own wording lives in `docs/acceptance-criteria.md`, which is not
 * this package's file to amend. The assertion stays an exact list either way:
 * its value was never the number four but that the surface is fixed and
 * asserted, and that commander's implicit `help [command]` can never sneak back
 * into it.
 *
 * **`helpCommand(false)` is load-bearing.** Commander adds an implicit
 * `help [command]` subcommand as soon as a program has subcommands, so `--help`
 * would list six entries and AC-14b could never pass on a correct
 * implementation. Disabling it removes the *subcommand* only; `-h` and `--help`
 * are unaffected. The call is `helpCommand(false)` because this package pins
 * commander 15; on commander 12 and earlier it would be `addHelpCommand(false)`.
 * The `daemon` group has subcommands too, so it repeats the call.
 *
 * Output and termination go through `CliIo` rather than straight to the process
 * (see `io.ts`), and commander's own exits are routed the same way with
 * `exitOverride`, so a test can drive the real program and record what a user
 * would have seen. In production `processIo.exit` is `process.exit`, so
 * commander's behaviour is unchanged: it writes help or a usage error and the
 * process ends with the code commander chose. Neither call is inherited by an
 * added subcommand, which is why `createDaemonCommand()` makes both again for
 * the group it owns.
 */

import { Command } from "commander";
import { createConnectCommand } from "./commands/connect.js";
import { createDaemonCommand } from "./commands/daemon.js";
import { createMcpCommand } from "./commands/mcp.js";
import { createServeCommand } from "./commands/serve.js";
import { createSetupCommand } from "./commands/setup.js";
import { type CliIo, processIo } from "./io.js";
import { CLI_VERSION } from "./version.js";

/** Build the `xplainer` program, wired to `io` for output and exit. */
export function createProgram(io: CliIo = processIo): Command {
  const program = new Command();

  program
    .name("xplainer")
    .description("The xplainer local runtime: render and narrate explainer videos on this machine.")
    .version(CLI_VERSION)
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

  program.addCommand(createServeCommand(io));
  program.addCommand(createMcpCommand(io));
  program.addCommand(createSetupCommand(io));
  program.addCommand(createConnectCommand(io));
  program.addCommand(createDaemonCommand(io));

  return program;
}
