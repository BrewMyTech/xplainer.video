/**
 * What the binary does, driven through the real commander program.
 *
 * The things asserted here — the version it prints, the commands it offers, the
 * verbs its one command group offers, and what a deferred command does — are
 * AC-14a, AC-14b and S2.4b's fifth test. All of them are observable only through
 * stdout, stderr and an exit code, so the program is built with a recording
 * `CliIo` (see `io.ts`) and everything else is real: the real command
 * registrations, the real help generation, the real exit codes commander and the
 * stubs choose.
 */

import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import type { CliIo } from "./io.js";
import { createProgram } from "./program.js";

/** Thrown in place of `process.exit`, carrying the code the CLI asked for. */
class ExitSignal extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`exit ${code}`);
    this.name = "ExitSignal";
    this.code = code;
  }
}

/** What a single CLI invocation produced. */
type Invocation = {
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
};

/**
 * Pin help rendering on `command` and every command beneath it.
 *
 * Colours off and 80 columns, so the assertions below read the same text on a
 * narrow terminal, a wide one and a CI pipe. It recurses because commander's
 * `configureOutput()` replaces the configuration object rather than mutating it
 * and `addCommand()` copies nothing from the parent — so the `daemon` group,
 * whose help this file also asserts, holds a configuration of its own.
 */
function pinHelpRendering(command: Command): void {
  command.configureOutput({
    getOutHasColors: () => false,
    getErrHasColors: () => false,
    getOutHelpWidth: () => 80,
    getErrHelpWidth: () => 80,
  });
  for (const child of command.commands) {
    pinHelpRendering(child);
  }
}

/** Run the program over `argv` and collect everything a user would have seen. */
async function run(argv: string[]): Promise<Invocation> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    writeOut(text) {
      out.push(text);
    },
    writeErr(text) {
      err.push(text);
    },
    exit(code): never {
      throw new ExitSignal(code);
    },
  };

  const program = createProgram(io);
  pinHelpRendering(program);

  let exitCode: number | undefined;
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (!(error instanceof ExitSignal)) {
      throw error;
    }
    exitCode = error.code;
  }

  return { exitCode, stdout: out.join(""), stderr: err.join("") };
}

/**
 * The command names commander listed, read out of the help text itself.
 *
 * Reading the rendered help rather than `program.commands` is the point: the
 * implicit `help [command]` entry AC-14b guards against is created during help
 * generation and never appears in `program.commands`, so only the text can
 * prove it is gone — at the top level and inside the `daemon` group alike.
 */
function listedCommands(help: string): string[] {
  const lines = help.split("\n");
  const heading = lines.indexOf("Commands:");
  if (heading < 0) {
    throw new Error(`--help output has no "Commands:" section:\n${help}`);
  }

  const names: string[] = [];
  for (const line of lines.slice(heading + 1)) {
    if (line.trim() === "") {
      break;
    }
    // Entries start at two spaces; wrapped descriptions are indented far deeper.
    const match = /^ {2}(\S+)/.exec(line);
    if (match) {
      const [, name] = match;
      if (name === undefined) {
        throw new Error(`--help line matched the command pattern but captured no name: ${line}`);
      }
      names.push(name);
    }
  }
  return names;
}

describe("xplainer", () => {
  it("prints the version from apps/cli/package.json for --version", async () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    const { stdout, stderr, exitCode } = await run(["--version"]);

    expect(stdout).toBe(`${manifest.version}\n`);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  it("lists exactly serve, status, mcp, setup, connect, daemon and runtime under --help", async () => {
    const { stdout, exitCode } = await run(["--help"]);

    expect(listedCommands(stdout)).toEqual([
      "serve",
      "status",
      "mcp",
      "setup",
      "connect",
      "daemon",
      "runtime",
    ]);
    expect(exitCode).toBe(0);
  });

  it("lists exactly claude and codex under `connect --help`", async () => {
    const { stdout, exitCode } = await run(["connect", "--help"]);

    expect(listedCommands(stdout)).toEqual(["claude", "codex"]);
    expect(exitCode).toBe(0);
  });

  it("lists exactly the seven lifecycle verbs under `daemon --help`", async () => {
    const { stdout, exitCode } = await run(["daemon", "--help"]);

    expect(listedCommands(stdout)).toEqual([
      "install",
      "uninstall",
      "start",
      "stop",
      "restart",
      "status",
      "logs",
    ]);
    expect(exitCode).toBe(0);
  });

  it("lists exactly build and verify under `runtime --help`", async () => {
    const { stdout, exitCode } = await run(["runtime", "--help"]);

    expect(listedCommands(stdout)).toEqual(["build", "verify"]);
    expect(exitCode).toBe(0);
  });

  it("prints the connect group's help on stderr and exits 1 when no verb is given", async () => {
    const { stdout, stderr, exitCode } = await run(["connect"]);

    expect(stdout).toBe("");
    expect(listedCommands(stderr)).toEqual(["claude", "codex"]);
    expect(exitCode).toBe(1);
  });

  it("prints the daemon group's help on stderr and exits 1 when no verb is given", async () => {
    const { stdout, stderr, exitCode } = await run(["daemon"]);

    expect(stdout).toBe("");
    expect(listedCommands(stderr)).toContain("install");
    expect(exitCode).toBe(1);
  });

  it("prints the runtime group's help on stderr and exits 1 when no verb is given", async () => {
    const { stdout, stderr, exitCode } = await run(["runtime"]);

    expect(stdout).toBe("");
    expect(listedCommands(stderr)).toEqual(["build", "verify"]);
    expect(exitCode).toBe(1);
  });

  /**
   * `mcp` left the deferred list below when it gained an implementation, and this is what keeps
   * that visible here: it is registered with the one flag that chooses between running the tools in
   * this process and proxying them to the daemon's socket
   * ([ADR 0020](../../../docs/adr/0020-always-running-local-daemon.md) §The agent path is IPC, not
   * TCP). What the two paths then *do* is asserted against real spawned processes in
   * `commands/mcp.test.ts`; this is only the surface.
   *
   * Read off the command rather than out of rendered help, because a **subcommand's** `--help` is
   * not routed through `CliIo`: `exitOverride()` and `configureOutput()` are not inherited by an
   * added subcommand (see `program.ts`), so asking for it here would call the real `process.exit`.
   */
  it("offers mcp --attach, which is the entry `xplainer connect` writes for an agent", () => {
    const mcp = createProgram().commands.find((command) => command.name() === "mcp");

    expect(mcp?.options.map((option) => option.long)).toContain("--attach");
    expect(mcp?.options.find((option) => option.long === "--attach")?.description).toContain(
      "IPC socket",
    );
  });

  /**
   * `--spawn` is the leading remediation in ADR 0020's two no-supervisor degraded paths, so it has
   * to be a flag that exists on both verbs rather than a sentence in a message. What it *writes* is
   * asserted against real configuration files in `commands/connect.test.ts`; this is the surface,
   * read off the commands for the same reason `mcp --attach` is above.
   */
  it("offers connect claude --spawn and connect codex --spawn, which two refusals print", () => {
    const connect = createProgram().commands.find((command) => command.name() === "connect");

    for (const verb of ["claude", "codex"]) {
      const command = connect?.commands.find((entry) => entry.name() === verb);
      expect(command?.options.map((option) => option.long)).toContain("--spawn");
      expect(command?.options.find((option) => option.long === "--spawn")?.description).toContain(
        "no service manager",
      );
    }
  });

  it("registers every deferred command as a stub that names itself on stderr and exits 2", async () => {
    const deferred = [["setup"]];

    for (const argv of deferred) {
      const { stdout, stderr, exitCode } = await run(argv);

      // The whole path, not the leaf: `xplainer install` is not a command.
      expect(stderr).toBe(`xplainer ${argv.join(" ")}: not implemented in this phase\n`);
      expect(stdout).toBe("");
      expect(exitCode).toBe(2);
    }
  });
});
