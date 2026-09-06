/**
 * `xplainer connect`, run as a process, against real configuration files.
 *
 * Everything this command does is a side effect on somebody else's file or a spawn of somebody
 * else's binary, so every case here is a **real spawned `xplainer connect`** with a temporary `HOME`
 * and a temporary `PATH`, and the assertions are made against what is on disk afterwards. Nothing is
 * substituted — `apps/cli/AGENTS.md`'s rule that "there is no `vi.mock` anywhere in this package"
 * applies with particular force to a writer whose whole risk is writing the wrong bytes to the wrong
 * path.
 *
 * The one thing that is *not* the real article is `claude` itself: the fake on `PATH` records the
 * argument vector it was handed and exits `0`. That is deliberate and it is the strongest available
 * assertion, because the argv **is** the contract with that CLI — the vendor's own writer is then
 * responsible for the file, and a test that drove the real `claude` would be asserting Claude Code's
 * behaviour on the developer's own machine and mutating their real configuration to do it. The
 * live run against the installed `claude` is recorded in the session's `progress.txt` instead.
 *
 * The Codex half needs no such shim, because there is no vendor writer to delegate to: the file is
 * written here, and it is read back with a **real TOML parser** (`smol-toml`) rather than with the
 * scanner that wrote it, so a round trip that only this module agrees with cannot pass.
 */

import type { ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { STATE_DIR_ENV, stateDirLayout } from "../daemon/state-dir.js";
import { CHILD_CLI, spawnEntry } from "../daemon/testing/spawn-child.js";

const scratch: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporary(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), `xplainer-connect-${prefix}-`));
  scratch.push(directory);
  return directory;
}

/** A state directory whose `daemon.json` records `port`, as a bound `serve` would have left it. */
function stateWithPort(port: number): string {
  const directory = temporary("state");
  writeFileSync(
    stateDirLayout(directory).daemonState,
    `${JSON.stringify({ format_version: 1, port, contract_version: "1" })}\n`,
  );
  return directory;
}

/** A `PATH` directory holding only the shims a case wants found. */
function binWith(shims: Readonly<Record<string, string>>): string {
  const directory = temporary("bin");
  for (const [name, script] of Object.entries(shims)) {
    const path = join(directory, name);
    writeFileSync(path, script);
    chmodSync(path, 0o755);
  }
  return directory;
}

/** A `claude` that writes each argument it was given on its own line, and succeeds. */
function recordingClaude(record: string): string {
  return [
    "#!/bin/sh",
    `: > "${record}"`,
    `for arg in "$@"; do`,
    `  printf '%s\\n' "$arg" >> "${record}"`,
    "done",
    "exit 0",
    "",
  ].join("\n");
}

/** The argument vector the fake `claude` was handed. */
function recordedArgv(record: string): string[] {
  return readFileSync(record, "utf8").split("\n").slice(0, -1);
}

/** A `xplainer` on `PATH`, which is the only thing about it that matters here. */
const FAKE_BINARY = "#!/bin/sh\nexit 0\n";

type Run = {
  code: number | null;
  stdout: string;
  stderr: string;
};

/** Run the real command tree, in a child, with the environment a case set up. */
async function connect(args: readonly string[], env: Record<string, string>): Promise<Run> {
  const child = spawnEntry(CHILD_CLI, ["connect", ...args], env);
  children.push(child.process);
  const exit = await child.waitForExit();
  return { code: exit.code, stdout: child.stdout(), stderr: child.stderr() };
}

/** The claim the entry makes about itself, checked as a grep over whatever was written. */
function carriesNoSecret(text: string, port: number): void {
  expect(text).not.toMatch(/http/i);
  expect(text).not.toMatch(/token/i);
  expect(text).not.toContain(String(port));
}

describe("xplainer connect claude", () => {
  it("delegates to `claude mcp add` at user scope, with an argv holding no URL, port or token", async () => {
    const home = temporary("home");
    const record = join(home, "argv.txt");
    const bin = binWith({ claude: recordingClaude(record), xplainer: FAKE_BINARY });

    const run = await connect(["claude"], {
      HOME: home,
      PATH: bin,
      [STATE_DIR_ENV]: stateWithPort(8787),
    });

    expect(run.code).toBe(0);
    expect(recordedArgv(record)).toEqual([
      "mcp",
      "add",
      "--transport",
      "stdio",
      "--scope",
      "user",
      "xplainer",
      "--",
      "xplainer",
      "mcp",
      "--attach",
    ]);
    // The port was read from daemon.json — and did not end up in what was written.
    expect(run.stdout).toContain("port 8787, from daemon.json");
    expect(run.stdout).toContain("runs:    xplainer mcp --attach");
    carriesNoSecret(recordedArgv(record).join(" "), 8787);
  }, 30_000);

  it("passes --scope through to that CLI", async () => {
    const home = temporary("home");
    const record = join(home, "argv.txt");
    const bin = binWith({ claude: recordingClaude(record), xplainer: FAKE_BINARY });

    const run = await connect(["claude", "--scope", "local"], {
      HOME: home,
      PATH: bin,
      [STATE_DIR_ENV]: stateWithPort(8790),
    });

    expect(run.code).toBe(0);
    expect(recordedArgv(record)).toContain("local");
    expect(recordedArgv(record)).not.toContain("user");
    expect(run.stdout).toContain("at local scope");
  }, 30_000);

  /**
   * The documented JSON location, written directly. `~/.claude.json` is Claude Code's whole
   * per-user state, so the assertion that matters as much as the new entry is that everything else
   * in that file survived.
   */
  it("writes ~/.claude.json itself when the vendor CLI is not installed, merging into it", async () => {
    const home = temporary("home");
    const config = join(home, ".claude.json");
    writeFileSync(
      config,
      `${JSON.stringify({
        numStartups: 3,
        mcpServers: { other: { type: "stdio", command: "other", args: [] } },
      })}\n`,
    );
    const bin = binWith({ xplainer: FAKE_BINARY });
    const environment = { HOME: home, PATH: bin, [STATE_DIR_ENV]: stateWithPort(8791) };

    const first = await connect(["claude"], environment);
    const second = await connect(["claude"], environment);

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    const written = readFileSync(config, "utf8");
    const document = JSON.parse(written) as {
      numStartups: number;
      mcpServers: Record<string, unknown>;
    };
    expect(document.numStartups).toBe(3);
    expect(Object.keys(document.mcpServers).sort()).toEqual(["other", "xplainer"]);
    expect(document.mcpServers.xplainer).toEqual({
      type: "stdio",
      command: "xplainer",
      args: ["mcp", "--attach"],
    });
    carriesNoSecret(written, 8791);
    expect(first.stdout).toContain("a new entry");
    expect(second.stdout).toContain("replacing the entry that was there");
  }, 30_000);

  it("names npx when neither the vendor CLI nor the binary is installed", async () => {
    const home = temporary("home");

    const run = await connect(["claude"], {
      HOME: home,
      PATH: binWith({}),
      [STATE_DIR_ENV]: stateWithPort(8792),
    });

    expect(run.code).toBe(0);
    const document = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as {
      mcpServers: { xplainer: { command: string; args: string[] } };
    };
    expect(document.mcpServers.xplainer).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@xplainer/cli", "mcp", "--attach"],
    });
  }, 30_000);

  /** Guessing which directory a `local` or `project` scope meant is how a config gets committed. */
  it("refuses a scope only the vendor CLI can write, and an unknown one, without writing", async () => {
    const home = temporary("home");
    const environment = { HOME: home, PATH: binWith({}), [STATE_DIR_ENV]: stateWithPort(8793) };

    const unsupported = await connect(["claude", "--scope", "project"], environment);
    const unknown = await connect(["claude", "--scope", "everywhere"], environment);

    expect(unsupported.code).toBe(1);
    expect(unsupported.stderr).toContain("is not on PATH");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("not one of local, user, project");
    expect(() => readFileSync(join(home, ".claude.json"), "utf8")).toThrow();
  }, 30_000);

  it("reports a failing `claude mcp add` and exits 70", async () => {
    const home = temporary("home");
    const bin = binWith({
      claude: "#!/bin/sh\nprintf 'that scope needs a project\\n' >&2\nexit 7\n",
      xplainer: FAKE_BINARY,
    });

    const run = await connect(["claude"], {
      HOME: home,
      PATH: bin,
      [STATE_DIR_ENV]: stateWithPort(8794),
    });

    expect(run.code).toBe(70);
    expect(run.stderr).toContain("that scope needs a project");
    expect(run.stderr).toContain("exited 7");
    expect(run.stdout).toBe("");
  }, 30_000);
});

describe("xplainer connect codex", () => {
  /** The file is the user's; the entry is ours. Both facts are asserted against a real parse. */
  it("adds [mcp_servers.xplainer] to ~/.codex/config.toml and leaves the rest byte for byte", async () => {
    const home = temporary("home");
    const config = join(home, ".codex", "config.toml");
    mkdirSync(join(home, ".codex"));
    const before = [
      'model = "gpt-6-astra"',
      "",
      "# the servers I already had",
      '[projects."/Users/me/projects/max"]',
      'trust_level = "trusted"',
      "",
      "[mcp_servers.other]",
      'command = "other"',
      'args = ["serve"]',
      "",
    ].join("\n");
    writeFileSync(config, before);

    const run = await connect(["codex"], {
      HOME: home,
      PATH: binWith({ xplainer: FAKE_BINARY }),
      [STATE_DIR_ENV]: stateWithPort(8795),
    });

    expect(run.code).toBe(0);
    const written = readFileSync(config, "utf8");
    expect(written.startsWith(before)).toBe(true);
    expect(written).toContain("# the servers I already had");

    const document = parseToml(written) as {
      model: string;
      projects: Record<string, unknown>;
      mcp_servers: Record<string, { command: string; args: string[] }>;
    };
    expect(document.model).toBe("gpt-6-astra");
    expect(document.projects["/Users/me/projects/max"]).toEqual({ trust_level: "trusted" });
    expect(document.mcp_servers.other).toEqual({ command: "other", args: ["serve"] });
    expect(document.mcp_servers.xplainer).toEqual({
      command: "xplainer",
      args: ["mcp", "--attach"],
    });
    carriesNoSecret(written.slice(before.length), 8795);
  }, 30_000);

  /**
   * Idempotent means "one entry afterwards", not "the second run changes nothing": between these
   * two runs the binary appears on `PATH`, and the entry must be *updated* in place rather than
   * appended beside itself.
   */
  it("leaves exactly one entry when run twice, updating the one that is there", async () => {
    const home = temporary("home");
    const config = join(home, ".codex", "config.toml");
    const stateDir = stateWithPort(8796);

    const first = await connect(["codex"], {
      HOME: home,
      PATH: binWith({}),
      [STATE_DIR_ENV]: stateDir,
    });
    const second = await connect(["codex"], {
      HOME: home,
      PATH: binWith({ xplainer: FAKE_BINARY }),
      [STATE_DIR_ENV]: stateDir,
    });

    expect(first.code).toBe(0);
    expect(first.stdout).toContain("a new table");
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("replacing the table that was there");

    const written = readFileSync(config, "utf8");
    expect(written.split("[mcp_servers.xplainer]").length - 1).toBe(1);
    const document = parseToml(written) as {
      mcp_servers: { xplainer: { command: string; args: string[] } };
    };
    expect(document.mcp_servers.xplainer).toEqual({
      command: "xplainer",
      args: ["mcp", "--attach"],
    });
  }, 30_000);

  it("replaces an entry that carries a sub-table, without disturbing its neighbours", async () => {
    const home = temporary("home");
    const config = join(home, "elsewhere.toml");
    writeFileSync(
      config,
      [
        "[mcp_servers.xplainer]",
        'command = "old"',
        'args = ["stale"]',
        "",
        "[mcp_servers.xplainer.env]",
        'XPLAINER_STATE_DIR = "/somewhere/else"',
        "",
        "[mcp_servers.other]",
        'command = "other"',
        "",
      ].join("\n"),
    );

    const run = await connect(["codex", "--config", config], {
      HOME: home,
      PATH: binWith({ xplainer: FAKE_BINARY }),
      [STATE_DIR_ENV]: stateWithPort(8797),
    });

    expect(run.code).toBe(0);
    const written = readFileSync(config, "utf8");
    expect(written).not.toContain("/somewhere/else");
    expect(written).not.toContain("stale");
    const document = parseToml(written) as {
      mcp_servers: { xplainer: Record<string, unknown>; other: Record<string, unknown> };
    };
    expect(document.mcp_servers.xplainer).toEqual({
      command: "xplainer",
      args: ["mcp", "--attach"],
    });
    expect(document.mcp_servers.other).toEqual({ command: "other" });
  }, 30_000);

  it("creates the file, and its directory, when there is none", async () => {
    const home = temporary("home");

    const run = await connect(["codex"], {
      HOME: home,
      PATH: binWith({ xplainer: FAKE_BINARY }),
      [STATE_DIR_ENV]: stateWithPort(8798),
    });

    expect(run.code).toBe(0);
    const written = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(parseToml(written)).toEqual({
      mcp_servers: { xplainer: { command: "xplainer", args: ["mcp", "--attach"] } },
    });
  }, 30_000);

  /** A duplicate key does not load *at all*, so this refusal protects the whole file. */
  it("refuses a configuration that already declares the server another way, and writes nothing", async () => {
    const home = temporary("home");
    const config = join(home, "dotted.toml");
    const before = 'mcp_servers.xplainer = { command = "somewhere-else" }\n';
    writeFileSync(config, before);

    const run = await connect(["codex", "--config", config], {
      HOME: home,
      PATH: binWith({ xplainer: FAKE_BINARY }),
      [STATE_DIR_ENV]: stateWithPort(8799),
    });

    expect(run.code).toBe(3);
    expect(run.stderr).toContain("as a key rather than a table");
    expect(run.stderr).toContain("duplicate key");
    expect(readFileSync(config, "utf8")).toBe(before);
  }, 30_000);
});

describe("what xplainer connect checks before it writes", () => {
  it("refuses both agents when no daemon has ever bound here, and writes nothing", async () => {
    const home = temporary("home");
    const environment = {
      HOME: home,
      PATH: binWith({ xplainer: FAKE_BINARY }),
      [STATE_DIR_ENV]: temporary("state"),
    };

    for (const verb of ["claude", "codex"]) {
      const run = await connect([verb], environment);

      expect(run.code).toBe(3);
      expect(run.stderr).toContain("no daemon has ever bound in");
      expect(run.stderr).toContain("Run `xplainer serve` once");
      expect(run.stdout).toBe("");
    }
    expect(() => readFileSync(join(home, ".claude.json"), "utf8")).toThrow();
    expect(() => readFileSync(join(home, ".codex", "config.toml"), "utf8")).toThrow();
  }, 30_000);

  it("writes anyway under --force, and says the port came from the default", async () => {
    const home = temporary("home");

    const run = await connect(["codex", "--force"], {
      HOME: home,
      PATH: binWith({ xplainer: FAKE_BINARY }),
      [STATE_DIR_ENV]: temporary("state"),
    });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("port 8787, from default");
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain(
      "[mcp_servers.xplainer]",
    );
  }, 30_000);

  it("exits 11 when daemon.json exists and cannot be read", async () => {
    const home = temporary("home");
    const stateDir = temporary("state");
    writeFileSync(stateDirLayout(stateDir).daemonState, "{ half a state file");

    const run = await connect(["claude"], {
      HOME: home,
      PATH: binWith({ xplainer: FAKE_BINARY }),
      [STATE_DIR_ENV]: stateDir,
    });

    expect(run.code).toBe(11);
    expect(run.stderr).toContain("cannot be read as JSON");
  }, 30_000);
});
