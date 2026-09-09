/**
 * The four forms `--spawn` chooses between, against real files with real modes.
 *
 * `commands/connect.test.ts` proves the two that matter end to end — a launcher and a staged
 * runtime, through a spawned `xplainer connect --spawn`, asserted on the configuration file
 * afterwards. What is left to this file is the ordering itself, including the `PATH` step that a
 * machine with nothing under its state directory falls to, and the one thing no configuration file
 * can show: that the arguments are `mcp` **without** `--attach`, derived from the attach form
 * rather than written out beside it.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launcherPath } from "../install/launcher.js";
import { resolveProgram } from "../install/program.js";
import { stageRuntime } from "../install/stage.js";
import { buildFixturePayload } from "../install/testing/payload.js";
import { ATTACH_ARGS, CLI_PACKAGE, describeEntry, SERVER_NAME } from "./entry.js";
import { resolveSpawnEntry, SPAWN_ARGS } from "./spawn.js";

const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporary(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), `xplainer-spawn-${prefix}-`));
  scratch.push(directory);
  return directory;
}

/** A state directory with nothing in it. */
function stateDirectory(): string {
  const stateDir = join(temporary("state"), "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  return stateDir;
}

/** An executable file at `path`, which is all `installedLauncher` asks about. */
function executable(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o700);
  return path;
}

describe("SPAWN_ARGS", () => {
  it("is the attach form without its flag, so the verb cannot be renamed in one place only", () => {
    expect(SPAWN_ARGS).toEqual(["mcp"]);
    expect(ATTACH_ARGS).toEqual(["mcp", "--attach"]);
  });
});

describe("resolveSpawnEntry", () => {
  it("prefers the launcher an install wrote, over everything else on the machine", () => {
    const stateDir = stateDirectory();
    const launcher = executable(launcherPath(stateDir, "darwin"));
    const payload = buildFixturePayload({
      outDir: join(temporary("payload"), "payload"),
      version: "1.0.0",
      marker: "spawn",
      runnable: false,
    });
    stageRuntime({ payloadDir: payload.outDir, stateDir });
    const bin = temporary("bin");
    executable(join(bin, SERVER_NAME));

    const entry = resolveSpawnEntry({ stateDir, env: { PATH: bin }, platform: "darwin" });

    expect(entry).toEqual({ command: launcher, args: ["mcp"], source: "launcher" });
    expect(describeEntry(entry)).not.toContain("--attach");
  });

  it("names the staged runtime's interpreter and entry when no launcher was written", () => {
    const stateDir = stateDirectory();
    const payload = buildFixturePayload({
      outDir: join(temporary("payload"), "payload"),
      version: "2.0.0",
      marker: "spawn",
      runnable: false,
    });
    const staged = stageRuntime({ payloadDir: payload.outDir, stateDir });
    const program = resolveProgram({ stateDir, runtimeDir: staged.path });
    const bin = temporary("bin");
    executable(join(bin, SERVER_NAME));

    const entry = resolveSpawnEntry({ stateDir, env: { PATH: bin }, platform: "darwin" });

    expect(entry).toEqual({
      command: program.executable,
      args: [program.entry, "mcp"],
      source: "runtime",
    });
  });

  /**
   * Two staged runtimes are a question only a human can settle, and `install/program.ts` refuses
   * rather than guessing. Here that refusal is not a failure — it means "there is no runtime to
   * name", and the resolution keeps going rather than reporting an install's problem to an agent.
   */
  it("keeps looking when the state directory holds no runtime it can name", () => {
    const stateDir = stateDirectory();
    for (const [version, marker] of [
      ["1.0.0", "alpha"],
      ["1.0.1", "beta"],
    ]) {
      const payload = buildFixturePayload({
        outDir: join(temporary("payload"), "payload"),
        version: version ?? "",
        marker: marker ?? "",
        runnable: false,
      });
      stageRuntime({ payloadDir: payload.outDir, stateDir });
    }
    const bin = temporary("bin");
    const onPath = executable(join(bin, SERVER_NAME));

    const entry = resolveSpawnEntry({ stateDir, env: { PATH: bin }, platform: "darwin" });

    expect(entry).toEqual({ command: SERVER_NAME, args: ["mcp"], source: "path" });
    expect(onPath).toContain(SERVER_NAME);
  });

  it("falls back to the published form on a machine with nothing installed", () => {
    const entry = resolveSpawnEntry({
      stateDir: stateDirectory(),
      env: { PATH: temporary("bin") },
      platform: "linux",
    });

    expect(entry).toEqual({
      command: "npx",
      args: ["-y", CLI_PACKAGE, "mcp"],
      source: "npx",
    });
    expect(describeEntry(entry)).toBe("npx -y @xplainer/cli mcp");
  });
});
