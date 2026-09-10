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
 * The one thing that is *not* the real article is the vendor CLI itself: the fake on `PATH` records
 * the argument vector it was handed and exits `0`. That is deliberate and it is the strongest
 * available assertion, because the argv **is** the contract with that CLI — the vendor's own writer
 * is then responsible for the file, and a test that drove the real `claude` or the real `codex`
 * would be asserting their behaviour on the developer's own machine and mutating their real
 * configuration to do it. The live runs against both installed CLIs are recorded in the session's
 * `progress.txt` instead.
 *
 * One shim is more than a recorder: `alreadyRegisteredClaude` keeps a file for "an entry of this
 * name exists", refuses an `add` while it is there exactly as `claude mcp add` does — exit `1`,
 * `already exists` on stderr — and honours a `remove`. It is the only way to assert the thing a
 * recorder cannot: that running `xplainer connect claude` **twice** succeeds twice.
 *
 * Where a file *is* written here — the `--config` path, and any machine with no `codex` on `PATH` —
 * it is read back with a **real TOML parser** (`smol-toml`) rather than with the scanner that wrote
 * it, so a round trip that only this module agrees with cannot pass.
 */

import type { ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { STATE_DIR_ENV, stateDirLayout } from "../daemon/state-dir.js";
import { CHILD_CLI, spawnEntry } from "../daemon/testing/spawn-child.js";
import { launcherPath, writeLauncher } from "../install/launcher.js";
import { resolveProgram } from "../install/program.js";
import { stageRuntime } from "../install/stage.js";
import { buildFixturePayload } from "../install/testing/payload.js";

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

/** A vendor CLI that writes each argument it was given on its own line, and succeeds. */
function recordingShim(record: string): string {
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

/** The argument vector the fake vendor CLI was handed. */
function recordedArgv(record: string): string[] {
  return readFileSync(record, "utf8").split("\n").slice(0, -1);
}

/** What `alreadyRegisteredClaude` writes into its marker while an entry is registered. */
const REGISTERED = "registered";

/**
 * A `claude` that keeps one entry, and refuses a second `add` for it the way the real one does.
 *
 * `claude mcp add` over a name a scope already holds writes `already exists` to stderr and exits
 * `1` (2.1.263, checked live); `claude mcp remove` gives the name back and exits `0`. `marker` is
 * the whole of its state — **non-empty** means registered, rather than *present* means registered,
 * because a case's `PATH` holds nothing but these shims and `rm` is not a shell builtin. Everything
 * this script runs is: `printf`, `[` and a redirection.
 */
function alreadyRegisteredClaude(record: string, marker: string): string {
  return [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> "${record}"`,
    'case "$2" in',
    "  add)",
    `    if [ -s "${marker}" ]; then`,
    "      printf 'MCP server xplainer already exists in user config\\n' >&2",
    "      exit 1",
    "    fi",
    `    printf '%s\\n' '${REGISTERED}' > "${marker}"`,
    "    printf 'Added stdio MCP server xplainer to user config\\n'",
    "    exit 0",
    "    ;;",
    "  remove)",
    `    if [ -s "${marker}" ]; then`,
    `      : > "${marker}"`,
    "      printf 'Removed MCP server xplainer from user config\\n'",
    "      exit 0",
    "    fi",
    "    printf 'No MCP server named \"xplainer\" in user scope\\n' >&2",
    "    exit 1",
    "    ;;",
    "esac",
    "printf 'unexpected verb: %s\\n' \"$*\" >&2",
    "exit 1",
    "",
  ].join("\n");
}

/** One line per run of that shim: the argument vector, space-joined. */
function invocations(record: string): string[] {
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
    const bin = binWith({ claude: recordingShim(record), xplainer: FAKE_BINARY });

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
    const bin = binWith({ claude: recordingShim(record), xplainer: FAKE_BINARY });

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

  /**
   * The most ordinary thing a user can do to this command is run it again — after an upgrade, after
   * moving off `npx`, or because they forgot they had. `claude mcp add` answers a name its scope
   * already holds with exit `1`, which used to come out of here as exit `70` and a vendor sentence
   * about a state that was perfectly fine. There is no `claude mcp update` to reach for, so the
   * entry is removed and added back, and the run that matters is the **second** one.
   */
  it("is re-runnable: the second run replaces the entry `claude mcp add` refuses to", async () => {
    const home = temporary("home");
    const record = join(home, "invocations.txt");
    const marker = join(home, "registered");
    const bin = binWith({
      claude: alreadyRegisteredClaude(record, marker),
      xplainer: FAKE_BINARY,
    });
    const environment = { HOME: home, PATH: bin, [STATE_DIR_ENV]: stateWithPort(8800) };

    const first = await connect(["claude"], environment);
    const second = await connect(["claude"], environment);

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    const add = "mcp add --transport stdio --scope user xplainer -- xplainer mcp --attach";
    expect(invocations(record)).toEqual([
      add,
      // The second run: refused, the name given back, then the same vector again.
      add,
      "mcp remove xplainer --scope user",
      add,
    ]);
    expect(first.stdout).not.toContain("replacing");
    expect(second.stdout).toContain("replacing the entry that was there");
    // An entry is registered at the end, not merely un-refused.
    expect(readFileSync(marker, "utf8").trim()).toBe(REGISTERED);
  }, 30_000);

  /**
   * The remove-then-add pair is not atomic, so the one case where this command could leave a user
   * worse off than it found them says so in words. A `claude` that gives the name back and then
   * refuses the second add is that case.
   */
  it("says so when the re-add fails after the old entry was already removed", async () => {
    const home = temporary("home");
    const bin = binWith({
      claude: [
        "#!/bin/sh",
        'case "$2" in',
        "  add) printf 'MCP server xplainer already exists in user config\\n' >&2; exit 1 ;;",
        "  remove) printf 'Removed MCP server xplainer from user config\\n'; exit 0 ;;",
        "esac",
        "exit 1",
        "",
      ].join("\n"),
      xplainer: FAKE_BINARY,
    });

    const run = await connect(["claude"], {
      HOME: home,
      PATH: bin,
      [STATE_DIR_ENV]: stateWithPort(8801),
    });

    expect(run.code).toBe(70);
    expect(run.stderr).toContain("already exists");
    expect(run.stderr).toContain("this scope now holds none");
    expect(run.stdout).toBe("");
  }, 30_000);
});

describe("xplainer connect codex", () => {
  /**
   * `codex mcp add <NAME> -- <COMMAND>…` exists (codex-cli 0.153.4) and is the vendor's own writer,
   * so it is preferred for the same reason `claude mcp add` is. The argv is the whole contract with
   * it, and `--` is the load-bearing part: without it `--attach` is a flag `codex` would read.
   */
  it("delegates to `codex mcp add` when that CLI is on PATH, writing no file itself", async () => {
    const home = temporary("home");
    const record = join(home, "argv.txt");
    const bin = binWith({ codex: recordingShim(record), xplainer: FAKE_BINARY });

    const run = await connect(["codex"], {
      HOME: home,
      PATH: bin,
      [STATE_DIR_ENV]: stateWithPort(8802),
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
    expect(run.stdout).toContain("mcp add");
    carriesNoSecret(recordedArgv(record).join(" "), 8802);
    // The vendor's CLI owns the file on this path, so this command wrote nothing of its own.
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
  }, 30_000);

  /**
   * `codex mcp add` has no flag that names a different file — its own `-c key=value` overrides
   * *values* — so asking for `--config` is asking for the writer below it, whatever is on `PATH`.
   */
  it("keeps the direct writer for --config, which that CLI cannot be pointed at", async () => {
    const home = temporary("home");
    const record = join(home, "argv.txt");
    const config = join(home, "elsewhere.toml");
    const bin = binWith({ codex: recordingShim(record), xplainer: FAKE_BINARY });

    const run = await connect(["codex", "--config", config], {
      HOME: home,
      PATH: bin,
      [STATE_DIR_ENV]: stateWithPort(8803),
    });

    expect(run.code).toBe(0);
    expect(existsSync(record)).toBe(false);
    expect(run.stdout).toContain(`wrote:   ${config}`);
    expect(parseToml(readFileSync(config, "utf8"))).toEqual({
      mcp_servers: { xplainer: { command: "xplainer", args: ["mcp", "--attach"] } },
    });
  }, 30_000);

  it("reports a failing `codex mcp add` and exits 70", async () => {
    const home = temporary("home");
    const bin = binWith({
      codex: "#!/bin/sh\nprintf 'config.toml is not valid TOML\\n' >&2\nexit 2\n",
      xplainer: FAKE_BINARY,
    });

    const run = await connect(["codex"], {
      HOME: home,
      PATH: bin,
      [STATE_DIR_ENV]: stateWithPort(8804),
    });

    expect(run.code).toBe(70);
    expect(run.stderr).toContain("config.toml is not valid TOML");
    expect(run.stderr).toContain("exited 2");
    expect(run.stdout).toBe("");
  }, 30_000);

  /** The file is the user's; the entry is ours. Both facts are asserted against a real parse. */
  it("adds [mcp_servers.xplainer] to ~/.codex/config.toml and leaves the rest byte for byte", async () => {
    const home = temporary("home");
    const config = join(home, ".codex", "config.toml");
    mkdirSync(join(home, ".codex"));
    const before = [
      'model = "gpt-6-astra"',
      "",
      "# the servers I already had",
      '[projects."/Users/me/projects/acme"]',
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
    expect(document.projects["/Users/me/projects/acme"]).toEqual({ trust_level: "trusted" });
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

/**
 * What an installed machine gets, and what a machine where the install was *refused* gets.
 *
 * Both halves are about the same defect: before T10, a runtime-directory install left `xplainer`
 * off `PATH` — the runtime lives under the state directory — so `connect` fell through to
 * `npx -y @xplainer/cli`, an entry pointing at a package this phase does not publish. The first
 * test is the fix, and the rest are `--spawn`, which is the remediation ADR 0020 prints first when
 * there is no supervisor at all.
 */
describe("the entry connect writes on a machine with a runtime", () => {
  /** A state directory holding a staged payload-1 artefact, as `runtime build` + an install leave it. */
  function stateWithRuntime(port?: number): { stateDir: string; runtime: string } {
    const stateDir = port === undefined ? temporary("state") : stateWithPort(port);
    const payload = buildFixturePayload({
      outDir: join(temporary("payload"), "payload"),
      version: "3.1.4",
      marker: "connect",
      runnable: false,
    });
    return { stateDir, runtime: stageRuntime({ payloadDir: payload.outDir, stateDir }).path };
  }

  /** The entry `~/.claude.json` holds, written by this command's own writer. */
  function writtenEntry(home: string): { command: string; args: string[] } {
    const document = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as {
      mcpServers: { xplainer: { command: string; args: string[] } };
    };
    return document.mcpServers.xplainer;
  }

  it("writes the stable launcher, never npx and never the version-scoped directory", async () => {
    const home = temporary("home");
    const { stateDir, runtime } = stateWithRuntime(8801);
    const launcher = writeLauncher({
      stateDir,
      program: resolveProgram({ stateDir, runtimeDir: runtime }),
    });

    // Nothing on PATH: this is the machine the runtime-directory install produces.
    const run = await connect(["claude"], {
      HOME: home,
      PATH: binWith({}),
      [STATE_DIR_ENV]: stateDir,
    });

    expect(run.code).toBe(0);
    expect(writtenEntry(home)).toEqual({
      type: "stdio",
      command: launcher.path,
      args: ["mcp", "--attach"],
    });
    expect(launcher.path).toBe(launcherPath(stateDir));
    expect(writtenEntry(home).command).not.toContain("npx");
    expect(writtenEntry(home).command).not.toContain(runtime);
    expect(run.stdout).toContain(`runs:    ${launcher.path} mcp --attach`);
  }, 30_000);

  /**
   * The bypass, stated as the difference between two runs of the same command in the same state
   * directory: without `--spawn` this exits `3` for want of a daemon, and with it exits `0`. That
   * is the property ADR 0020 needs — the remediation for "there is no daemon" cannot itself refuse
   * for want of one.
   */
  it("bypasses the daemon preflight under --spawn, and writes `mcp` without --attach", async () => {
    const home = temporary("home");
    const { stateDir, runtime } = stateWithRuntime();
    const launcher = writeLauncher({
      stateDir,
      program: resolveProgram({ stateDir, runtimeDir: runtime }),
    });
    const environment = { HOME: home, PATH: binWith({}), [STATE_DIR_ENV]: stateDir };

    const refused = await connect(["claude"], environment);
    expect(refused.code).toBe(3);
    expect(refused.stderr).toContain("no daemon has ever bound in");

    const spawned = await connect(["claude", "--spawn"], environment);

    expect(spawned.code).toBe(0);
    expect(writtenEntry(home)).toEqual({
      type: "stdio",
      command: launcher.path,
      args: ["mcp"],
    });
    expect(spawned.stdout).toContain("daemon:  none");
  }, 30_000);

  /**
   * After a *refused* install there is no launcher, because writing one is part of the writing
   * phase a preflight refusal never reaches — so the entry names the runtime that was staged.
   */
  it("names the staged runtime under --spawn when no install has written a launcher", async () => {
    const home = temporary("home");
    const { stateDir, runtime } = stateWithRuntime();
    const program = resolveProgram({ stateDir, runtimeDir: runtime });

    const run = await connect(["claude", "--spawn"], {
      HOME: home,
      PATH: binWith({}),
      [STATE_DIR_ENV]: stateDir,
    });

    expect(run.code).toBe(0);
    expect(existsSync(launcherPath(stateDir))).toBe(false);
    expect(writtenEntry(home)).toEqual({
      type: "stdio",
      command: program.executable,
      args: [program.entry, "mcp"],
    });
  }, 30_000);

  /** Nothing staged and nothing installed is still an answer, and it is the plugin bundles' form. */
  it("falls back to the published form under --spawn on a machine with nothing at all", async () => {
    const home = temporary("home");

    const run = await connect(["codex", "--spawn"], {
      HOME: home,
      PATH: binWith({}),
      [STATE_DIR_ENV]: temporary("state"),
    });

    expect(run.code).toBe(0);
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain(
      'args = ["-y", "@xplainer/cli", "mcp"]',
    );
  }, 30_000);
});
