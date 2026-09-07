/**
 * The `xplainer` command surface.
 *
 * Seven entries, fixed here and asserted in `program.test.ts`: `serve`, `status`
 * and `mcp`, which work; `connect`, a group of two verbs — `claude` and `codex` —
 * which write an agent's stdio configuration (`commands/connect.ts`); `setup`,
 * which reports that it is deferred and exits 2; `daemon`, a group of seven
 * verbs — `install`, `uninstall`, `start`, `stop`, `restart`, `status`, `logs` —
 * that report the same thing and exit the same way (`commands/daemon.ts`); and
 * `runtime`, a group of two verbs — `build` and `verify` — that assemble and
 * re-hash the two relocatable payloads (`commands/runtime.ts`).
 *
 * **`runtime` is a build-time command living in the shipped binary on purpose.**
 * `runtime build --workspace` installs the template that ships inside
 * `@xplainer/render-core`, which is exactly the route `setup --workspace` takes
 * on a machine with no Node, so the assembler a runner runs and the assembler a
 * user reaches are one implementation rather than two.
 *
 * AC-14b was written against the first four and asserts an exact list, so both
 * later entries are added here deliberately rather than discovered as a red
 * test, and `docs/acceptance-criteria.md` carries a dated amendment for each:
 * `daemon` (ADR 0020) and `status` (ADR 0020 §Port and discovery, which requires
 * a command that reads the two state files and confirms them with an
 * authenticated `/healthz`). The assertion stays an exact list either way: its
 * value was never the number four but that the surface is fixed and asserted,
 * and that commander's implicit `help [command]` can never sneak back into it.
 *
 * **`status` is a top-level command and `daemon status` is a different one.**
 * This one answers "is the daemon this machine recorded actually up, and where";
 * the group's verb reports on the *installed supervisor artefact* — the unit,
 * the plist, the task — which is phase 2 and still a stub. They are neither an
 * alias nor a duplicate of each other.
 *
 * **`helpCommand(false)` is load-bearing.** Commander adds an implicit
 * `help [command]` subcommand as soon as a program has subcommands, so `--help`
 * would list six entries and AC-14b could never pass on a correct
 * implementation. Disabling it removes the *subcommand* only; `-h` and `--help`
 * are unaffected. The call is `helpCommand(false)` because this package pins
 * commander 15; on commander 12 and earlier it would be `addHelpCommand(false)`.
 * The `connect` and `daemon` groups have subcommands too, so each repeats the
 * call.
 *
 * Output and termination go through `CliIo` rather than straight to the process
 * (see `io.ts`), and commander's own exits are routed the same way with
 * `exitOverride`, so a test can drive the real program and record what a user
 * would have seen. In production `processIo.exit` is `process.exit`, so
 * commander's behaviour is unchanged: it writes help or a usage error and the
 * process ends with the code commander chose. Neither call is inherited by an
 * added subcommand, which is why `createConnectCommand()` and
 * `createDaemonCommand()` each make both again for the group it owns.
 */

import { Command } from "commander";
import { createConnectCommand } from "./commands/connect.js";
import { createDaemonCommand } from "./commands/daemon.js";
import { createMcpCommand } from "./commands/mcp.js";
import { createRuntimeCommand } from "./commands/runtime.js";
import { createServeCommand } from "./commands/serve.js";
import { createSetupCommand } from "./commands/setup.js";
import { createStatusCommand } from "./commands/status.js";
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
  program.addCommand(createStatusCommand(io));
  program.addCommand(createMcpCommand(io));
  program.addCommand(createSetupCommand(io));
  program.addCommand(createConnectCommand(io));
  program.addCommand(createDaemonCommand(io));
  program.addCommand(createRuntimeCommand(io));

  return program;
}
