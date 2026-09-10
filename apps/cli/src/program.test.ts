/**
 * What the binary does, driven through the real commander program.
 *
 * The things asserted here — the version it prints, the commands it offers, and
 * the verbs each of its four groups offers — are AC-14a and AC-14b. All of them
 * are observable only through stdout, stderr and an exit code, so the program is
 * built with a recording `CliIo` (see `io.ts`) and everything else is real: the
 * real command registrations, the real help generation, the real exit codes
 * commander chooses.
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

  it("lists exactly serve, status, mcp, setup, connect, daemon, runtime and token under --help", async () => {
    const { stdout, exitCode } = await run(["--help"]);

    expect(listedCommands(stdout)).toEqual([
      "serve",
      "status",
      "mcp",
      "setup",
      "connect",
      "daemon",
      "runtime",
      "token",
    ]);
    expect(exitCode).toBe(0);
  });

  it("lists exactly claude and codex under `connect --help`", async () => {
    const { stdout, exitCode } = await run(["connect", "--help"]);

    expect(listedCommands(stdout)).toEqual(["claude", "codex"]);
    expect(exitCode).toBe(0);
  });

  it("lists exactly the nine lifecycle verbs under `daemon --help`", async () => {
    const { stdout, exitCode } = await run(["daemon", "--help"]);

    expect(listedCommands(stdout)).toEqual([
      "install",
      "uninstall",
      "update",
      "recover",
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

  /**
   * One verb, and the listing is asserted with `toEqual` for the same reason every other group's
   * is: ADR 0020 §Security R-SEC-8 names `token rotate` and nothing else, and a second verb under
   * this group would be a second way to touch the credential.
   */
  it("lists exactly rotate under `token --help`", async () => {
    const { stdout, exitCode } = await run(["token", "--help"]);

    expect(listedCommands(stdout)).toEqual(["rotate"]);
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
   * `mcp` was a deferred stub until it gained an implementation, and this is what keeps that
   * visible here: it is registered with the one flag that chooses between running the tools in
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

  /**
   * `setup` was the last deferred stub, and this is what replaced that assertion.
   *
   * The surface is asserted rather than the behaviour: what each flag *does* is
   * `commands/setup.test.ts`'s subject, and what belongs here is that the options the rest of the
   * phase's proofs and documents name — `--workspace` under a scrubbed `PATH`, `--skip-speech`
   * where a speech acquisition is not wanted in a run, `--tts-url` for a server somebody else runs,
   * `--speech <route>` as `scripts/e2e/toolchain.mjs` passes it to name the provider it proves, and
   * `--state-dir` as `SETTING_FLAGS` spells it — are still on the command a user reaches. The
   * listing is `toEqual` for the same reason every group's is: an option that appeared without
   * anyone deciding about it would ship unnoticed.
   *
   * `--speech` sits beside `--tts-url` in the listing because that is where it belongs in the
   * reading: both name where speech comes from, one by URL and one by route, and neither is part of
   * the `--workspace`/`--skip-*` union rule above them.
   */
  it("offers setup's documented options exactly, now that it is no longer a stub", () => {
    const setup = createProgram().commands.find((command) => command.name() === "setup");

    expect(setup?.options.map((option) => option.long)).toEqual([
      "--workspace",
      "--skip-browser",
      "--skip-speech",
      "--tts-url",
      "--speech",
      "--state-dir",
      "--manifest",
    ]);
  });
});
