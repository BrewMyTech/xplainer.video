import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STATE_DIR_ENV, stateDirLayout } from "../daemon/state-dir.js";
import { CHILD_CLI, spawnEntry } from "../daemon/testing/spawn-child.js";

const scratch: string[] = [];
const children: ChildProcess[] = [];

const FAKE_BINARY = "#!/bin/sh\nexit 0\n";

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporary(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), `xplainer-copilot-${prefix}-`));
  scratch.push(directory);
  return directory;
}

function stateWithPort(port: number): string {
  const directory = temporary("state");
  writeFileSync(
    stateDirLayout(directory).daemonState,
    `${JSON.stringify({ format_version: 1, port, contract_version: "1" })}\n`,
  );
  return directory;
}

function binWith(shims: Readonly<Record<string, string>>): string {
  const directory = temporary("bin");
  for (const [name, script] of Object.entries(shims)) {
    const path = join(directory, name);
    writeFileSync(path, script);
    chmodSync(path, 0o755);
  }
  return directory;
}

function recordingShim(record: string): string {
  return [
    "#!/bin/sh",
    `: > "${record}"`,
    'for arg in "$@"; do',
    `  printf '%s\\n' "$arg" >> "${record}"`,
    "done",
    "exit 0",
    "",
  ].join("\n");
}

function recordedArgv(record: string): string[] {
  return readFileSync(record, "utf8").split("\n").slice(0, -1);
}

function carriesNoSecret(text: string, port: number): void {
  expect(text).not.toMatch(/http/i);
  expect(text).not.toMatch(/token/i);
  expect(text).not.toContain(String(port));
}

type Run = {
  code: number | null;
  stdout: string;
  stderr: string;
};

async function connect(args: readonly string[], env: Record<string, string>): Promise<Run> {
  const child = spawnEntry(CHILD_CLI, ["connect", ...args], env);
  children.push(child.process);
  const exit = await child.waitForExit();
  return { code: exit.code, stdout: child.stdout(), stderr: child.stderr() };
}

describe("xplainer connect copilot", () => {
  it("delegates to `copilot mcp add` and installs the skill", async () => {
    const home = temporary("home");
    const record = join(home, "argv.txt");
    const bin = binWith({ copilot: recordingShim(record), xplainer: FAKE_BINARY });

    const run = await connect(["copilot"], {
      HOME: home,
      PATH: bin,
      [STATE_DIR_ENV]: stateWithPort(8810),
    });

    expect(run.code).toBe(0);
    expect(recordedArgv(record)).toEqual([
      "mcp",
      "add",
      "xplainer",
      "--",
      "xplainer",
      "mcp",
      "--attach",
    ]);
    carriesNoSecret(recordedArgv(record).join(" "), 8810);
    expect(run.stdout).toContain('registered the MCP server "xplainer" with GitHub Copilot CLI');
    expect(run.stdout).toContain("port 8810, from daemon.json");
    expect(existsSync(join(home, ".copilot", "skills", "xplainer", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".copilot", "mcp-config.json"))).toBe(false);
  }, 30_000);

  it("writes the documented user config itself when Copilot CLI is not on PATH", async () => {
    const home = temporary("home");
    const environment = {
      HOME: home,
      PATH: binWith({ xplainer: FAKE_BINARY }),
      [STATE_DIR_ENV]: stateWithPort(8811),
    };

    const first = await connect(["copilot"], environment);
    const second = await connect(["copilot"], environment);

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    const config = join(home, ".copilot", "mcp-config.json");
    const written = readFileSync(config, "utf8");
    const document = JSON.parse(written) as {
      mcpServers: { xplainer: Record<string, unknown> };
    };
    expect(document.mcpServers.xplainer).toEqual({
      type: "local",
      command: "xplainer",
      args: ["mcp", "--attach"],
      tools: ["*"],
    });
    carriesNoSecret(written, 8811);
    expect(first.stdout).toContain("a new entry");
    expect(second.stdout).toContain("replacing the entry that was there");
    expect(second.stdout).toContain("skill:   already current");
  }, 30_000);

  it("moves both the MCP config and skill when COPILOT_HOME is set", async () => {
    const home = temporary("home");
    const copilotHome = join(home, "copilot-home");

    const run = await connect(["copilot"], {
      HOME: home,
      COPILOT_HOME: copilotHome,
      PATH: binWith({ xplainer: FAKE_BINARY }),
      [STATE_DIR_ENV]: stateWithPort(8812),
    });

    expect(run.code).toBe(0);
    expect(existsSync(join(copilotHome, "mcp-config.json"))).toBe(true);
    expect(existsSync(join(copilotHome, "skills", "xplainer", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".copilot"))).toBe(false);
  }, 30_000);

  it("supports --spawn without requiring a daemon", async () => {
    const home = temporary("home");
    const record = join(home, "argv.txt");
    const bin = binWith({ copilot: recordingShim(record), xplainer: FAKE_BINARY });

    const run = await connect(["copilot", "--spawn"], {
      HOME: home,
      PATH: bin,
      [STATE_DIR_ENV]: temporary("empty-state"),
    });

    expect(run.code).toBe(0);
    expect(recordedArgv(record)).toEqual(["mcp", "add", "xplainer", "--", "xplainer", "mcp"]);
    expect(run.stdout).toContain("daemon:  none");
  }, 30_000);

  it("refuses without a daemon unless --force is given", async () => {
    const home = temporary("home");
    const stateDir = temporary("empty-state");
    const environment = {
      HOME: home,
      PATH: binWith({ xplainer: FAKE_BINARY }),
      [STATE_DIR_ENV]: stateDir,
    };

    const refused = await connect(["copilot"], environment);
    expect(refused.code).toBe(3);
    expect(refused.stderr).toContain("no daemon has ever bound in");
    expect(refused.stdout).toBe("");
    expect(existsSync(join(home, ".copilot", "mcp-config.json"))).toBe(false);

    const forced = await connect(["copilot", "--force"], environment);
    expect(forced.code).toBe(0);
    expect(forced.stdout).toContain("port 8787, from default");
    const written = readFileSync(join(home, ".copilot", "mcp-config.json"), "utf8");
    const document = JSON.parse(written) as {
      mcpServers: { xplainer: { args: string[] } };
    };
    expect(document.mcpServers.xplainer.args).toEqual(["mcp", "--attach"]);
    carriesNoSecret(written, 8787);
  }, 30_000);

  it("says when a failed replacement has already removed the old Copilot entry", async () => {
    const home = temporary("home");
    const removed = join(home, "removed");
    const bin = binWith({
      copilot: [
        "#!/bin/sh",
        'if [ "$2" = "add" ]; then',
        `  if [ ! -s "${removed}" ]; then`,
        "    printf 'MCP server xplainer already exists\\n' >&2",
        "    exit 1",
        "  fi",
        "  printf 'replacement refused\\n' >&2",
        "  exit 9",
        "fi",
        'if [ "$2" = "remove" ]; then',
        `  printf 'removed\\n' > "${removed}"`,
        "  exit 0",
        "fi",
        "exit 2",
        "",
      ].join("\n"),
      xplainer: FAKE_BINARY,
    });

    const run = await connect(["copilot"], {
      HOME: home,
      PATH: bin,
      [STATE_DIR_ENV]: stateWithPort(8813),
    });

    expect(run.code).toBe(70);
    expect(run.stderr).toContain("replacement refused");
    expect(run.stderr).toContain("had already been removed");
    expect(run.stderr).toContain("now holds none");
    expect(run.stdout).toBe("");
  }, 30_000);
});
