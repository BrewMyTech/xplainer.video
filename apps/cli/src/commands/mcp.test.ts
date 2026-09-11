/**
 * `xplainer mcp`, as the two things an agent's configuration can point at.
 *
 * Every test here drives a **real MCP client over a real spawned process**, because that is what
 * both entries are: `@modelcontextprotocol/sdk`'s `Client` over a `StdioClientTransport` that
 * spawns the command line `xplainer connect` would write. Nothing is substituted — not the
 * transport, not the backend, not the daemon — for the reason `apps/cli/AGENTS.md` gives: "a guard,
 * a probe or a drain asserted against a double asserts nothing", and a shim is entirely made of
 * probes and pumps.
 *
 * The children run this package's *sources* through `daemon/testing/ts-source-hook.ts`, since
 * `turbo.json` gives `test` no dependency on this package's own build.
 *
 * **The one substitution, and why it is on the other side.** P1-13 asks for the skew check to be
 * proved with an injected daemon version, and the daemon's `contract_version` comes from one
 * generated constant. Rather than put a `--contract-version` seam into the shipped `serve` whose
 * only caller would be this file, `daemon/testing/child-fake-daemon.ts` binds the real socket and
 * answers `/healthz` from the environment while serving `/mcp` from the shipped `createServer()`.
 * The shim under test is the shipped one, unmodified, and it is talking to something that really is
 * on the socket.
 */

import type { ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MCP_CONTRACT_VERSION, TOOL_NAMES } from "@xplainer/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { CONTRACT_SKEW_EXIT_CODE } from "../daemon/exit-codes.js";
import { resolveIpcPath } from "../daemon/ipc.js";
import { waitForReadyLine } from "../daemon/ready.js";
import {
  CHILD_CLI,
  CHILD_FAKE_DAEMON,
  CHILD_SERVE,
  type SpawnedChild,
  spawnEntry,
  TS_SOURCE_HOOK,
} from "../daemon/testing/spawn-child.js";
import { launcherPath } from "../install/launcher.js";
import { MCP_SESSIONS_DIR } from "../mcp/stdio-server.js";
import { CLI_VERSION } from "../version.js";

const scratch: string[] = [];
const children: ChildProcess[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    // Closing the client is what stops the process it spawned, so it comes before the kills below.
    await client.close().catch(() => {
      // The transport is already down, which is the state this loop is asking for.
    });
  }
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function stateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "xplainer-mcp-"));
  scratch.push(directory);
  return directory;
}

/**
 * An MCP client over `xplainer <args>`, spawned exactly as an agent would spawn it.
 *
 * The environment is passed through whole rather than filtered, because `XPLAINER_STATE_DIR` is how
 * every test in this repository keeps a child off the developer's own state directory and the SDK's
 * default environment would drop it.
 */
async function connectTo(args: readonly string[], stateDir: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", TS_SOURCE_HOOK, CHILD_CLI, ...args],
    env: { ...process.env, XPLAINER_STATE_DIR: stateDir } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "xplainer-cli-test", version: CLI_VERSION });
  clients.push(client);
  await client.connect(transport);
  // An unread `pipe` fills and blocks the child once its narrative is long enough, so it is drained
  // rather than asserted on: the tests that read a shim's stderr spawn it directly instead.
  transport.stderr?.on("data", () => {
    // Discarded on purpose.
  });
  return client;
}

function run(entry: string, args: readonly string[], env: Record<string, string>): SpawnedChild {
  const child = spawnEntry(entry, args, env);
  children.push(child.process);
  return child;
}

/** A real `xplainer serve` on a temporary state directory, up to and including its ready line. */
async function daemonOn(stateDir: string, args: readonly string[] = []): Promise<SpawnedChild> {
  const child = run(CHILD_SERVE, ["--port", "0", ...args], { XPLAINER_STATE_DIR: stateDir });
  await waitForReadyLine(child.process, { timeoutMs: 20_000 });
  return child;
}

/** The fake daemon, with the `/healthz` body this test needs, up to its own ready line. */
async function fakeDaemonOn(
  stateDir: string,
  health: { version: string; contract_version: string },
): Promise<SpawnedChild> {
  const child = run(CHILD_FAKE_DAEMON, [], {
    XPLAINER_STATE_DIR: stateDir,
    XPLAINER_TEST_HEALTHZ: JSON.stringify(health),
  });
  await child.waitForLine('"event":"fake-daemon"');
  return child;
}

async function toolNames(client: Client): Promise<string[]> {
  const { tools } = await client.listTools();
  return tools.map((tool) => tool.name).sort();
}

describe("xplainer mcp", () => {
  /**
   * The plugin-bundle path: `npx -y xplainer mcp`, on a machine where nothing is installed and
   * no daemon is running. The tool list is compared against `TOOL_NAMES` from `@xplainer/protocol`
   * rather than a list written here, so this surface is pinned to the manifest like every other.
   */
  it("serves the eight tools over stdio, in its own process, with no daemon anywhere", async () => {
    const stateDir = stateDirectory();

    const client = await connectTo(["mcp"], stateDir);

    expect(await toolNames(client)).toEqual([...TOOL_NAMES].sort());
    const listed = await client.callTool({ name: "explainer_list", arguments: {} });
    expect(listed.isError).toBeFalsy();
    expect(listed.structuredContent).toEqual({ videos: [] });

    const created = await client.callTool({
      name: "explainer_create",
      arguments: { slug: "in-process" },
    });
    expect(created.isError).toBeFalsy();
    // It answers from the workspace on disk, which is the one thing it *does* share with a daemon.
    expect(await client.callTool({ name: "explainer_list", arguments: {} })).toMatchObject({
      structuredContent: { videos: [{ slug: "in-process", has_narration: false }] },
    });
    expect(readdirSync(join(stateDir, "workspace", "videos"))).toEqual(["in-process"]);
  }, 60_000);

  /**
   * The documented consequence, asserted rather than only written down: this process does not take
   * the daemon's job store, because a job store is single-writer and two processes allocating
   * `job_id`s against one directory hand out the same number twice (ADR 0024 §Exclusive ownership).
   * It gets a session directory under `<state dir>/mcp/` instead, and gives it back when it ends.
   */
  it("keeps its jobs out of the daemon's store, in a session directory it removes on exit", async () => {
    const stateDir = stateDirectory();

    const client = await connectTo(["mcp"], stateDir);
    await client.callTool({ name: "explainer_list", arguments: {} });
    const sessions = readdirSync(join(stateDir, MCP_SESSIONS_DIR));

    expect(sessions).toHaveLength(1);
    expect(existsSync(join(stateDir, "jobs"))).toBe(false);
    expect(existsSync(join(stateDir, "owner.lock"))).toBe(false);

    await client.close();
    await waitFor(() => readdirSync(join(stateDir, MCP_SESSIONS_DIR)).length === 0);
    expect(readdirSync(join(stateDir, MCP_SESSIONS_DIR))).toEqual([]);
  }, 60_000);
});

describe("xplainer mcp --attach", () => {
  /**
   * The whole of P1-9's agent path in one test: an MCP client that knows only a command line, a
   * shim that knows only a socket path, and a daemon that owns the state directory. "The call
   * reaches the daemon" is asserted where it can only be true if it did — in the *daemon's*
   * workspace on disk, which the shim's own process never writes to.
   */
  it("proxies one session to the running daemon, and a tool call lands in the daemon's workspace", async () => {
    const stateDir = stateDirectory();
    await daemonOn(stateDir);

    const client = await connectTo(["mcp", "--attach"], stateDir);

    expect(await toolNames(client)).toEqual([...TOOL_NAMES].sort());
    const created = await client.callTool({
      name: "explainer_create",
      arguments: { slug: "through-the-socket" },
    });

    expect(created.isError).toBeFalsy();
    expect(created.structuredContent).toMatchObject({ slug: "through-the-socket" });
    // Written by the daemon, into the daemon's workspace, from a shim that has no backend at all.
    expect(readdirSync(join(stateDir, "workspace", "videos"))).toEqual(["through-the-socket"]);
    expect(
      readFileSync(
        join(stateDir, "workspace", "videos", "through-the-socket", "Video.tsx"),
        "utf8",
      ),
    ).toContain("ENGINE-OWNED");
    // The session survives more than one call, which is what "a single MCP session" means here.
    expect(await client.callTool({ name: "explainer_list", arguments: {} })).toMatchObject({
      structuredContent: { videos: [{ slug: "through-the-socket" }] },
    });
  }, 60_000);

  /**
   * The socket the daemon really bound, rather than the one this shim would derive.
   *
   * `serve --socket` is a shipped flag, the launch contract emits it on all three platforms, and an
   * installed daemon runs with whatever the artefact was rendered with — so a shim that derives
   * `<state>/ipc/xplainer.sock` and dials only that reports a daemon it could have reached as
   * unreachable. The daemon here binds a socket in a directory the derived path is not even inside,
   * and the assertion that it was reached is where it can only be true if it was: a video created
   * through the shim appearing in the **daemon's** workspace, from a shim process that has no
   * backend at all.
   */
  it("dials the socket daemon.json recorded, not the one derived from the state directory", async () => {
    const stateDir = stateDirectory();
    const elsewhere = stateDirectory();
    const socket = join(elsewhere, "moved.sock");
    await daemonOn(stateDir, ["--socket", socket]);

    // The premise: the derived path holds nothing, so a shim that guessed it would find no daemon.
    expect(existsSync(socket)).toBe(true);
    expect(existsSync(resolveIpcPath(stateDir))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(stateDir, "daemon.json"), "utf8")) as { socket_path: string },
    ).toMatchObject({ socket_path: socket });

    const client = await connectTo(["mcp", "--attach"], stateDir);
    const created = await client.callTool({
      name: "explainer_create",
      arguments: { slug: "through-the-moved-socket" },
    });

    expect(created.isError).toBeFalsy();
    expect(readdirSync(join(stateDir, "workspace", "videos"))).toEqual([
      "through-the-moved-socket",
    ]);
  }, 60_000);

  /**
   * ADR 0025 §Part two, exactly: an incompatible pair "exits with a new code **`8`** and a message
   * naming both versions and a command that fixes it". The command has to be one that exists *now*,
   * and that is what changed in T10: it printed `npm i -g @xplainer/cli@<version>`, which no
   * machine in this phase can run, because nothing is published and the phase-2 install runs the
   * daemon out of a payload staged under the state directory. What it names instead is the stable
   * launcher — here, absent, because this state directory holds no install — and the command that
   * would create it.
   */
  it("exits 8 naming both contract versions and a remediation this machine can run", async () => {
    const stateDir = stateDirectory();
    await fakeDaemonOn(stateDir, { version: "9.9.9-daemon", contract_version: "2" });

    const shim = run(CHILD_CLI, ["mcp", "--attach"], { XPLAINER_STATE_DIR: stateDir });
    const exit = await shim.waitForExit();

    expect(exit.code).toBe(CONTRACT_SKEW_EXIT_CODE);
    expect(shim.stderr()).toContain("tool contract 2");
    expect(shim.stderr()).toContain(`this shim speaks ${MCP_CONTRACT_VERSION}`);
    expect(shim.stderr()).toContain("release 9.9.9-daemon");
    expect(shim.stderr()).toContain(launcherPath(stateDir));
    expect(shim.stderr()).toContain("xplainer daemon install");
    expect(shim.stderr()).not.toContain("npm i -g");
    // Nothing was proxied: the refusal is a gate, and stdout is the JSON-RPC stream.
    expect(shim.stdout()).toBe("");
  }, 60_000);

  /**
   * The other half of the same message: with an install's launcher present, the remediation is a
   * path that exists, and running the session through it is the fix. That path is the one name a
   * shim and a daemon share across an update, which is why it is what an agent's configuration
   * holds.
   */
  it("names the installed launcher when there is one, as the shim to run instead", async () => {
    const stateDir = stateDirectory();
    await fakeDaemonOn(stateDir, { version: "9.9.9-daemon", contract_version: "2" });
    const launcher = launcherPath(stateDir);
    mkdirSync(dirname(launcher), { recursive: true });
    writeFileSync(launcher, "#!/bin/sh\nexit 0\n");
    chmodSync(launcher, 0o700);

    const shim = run(CHILD_CLI, ["mcp", "--attach"], { XPLAINER_STATE_DIR: stateDir });
    const exit = await shim.waitForExit();

    expect(exit.code).toBe(CONTRACT_SKEW_EXIT_CODE);
    expect(shim.stderr()).toContain(`${launcher} mcp --attach`);
    expect(shim.stderr()).toContain("xplainer daemon update");
    expect(shim.stderr()).not.toContain("npm i -g");
  }, 60_000);

  /**
   * The other half of the predicate, and the reason it is major-compatible rather than exact: "Two
   * releases that serve the same contract must attach cleanly, or every patch release breaks every
   * agent session that outlives it."
   */
  it("attaches to a daemon whose release version differs but whose contract does not", async () => {
    const stateDir = stateDirectory();
    await fakeDaemonOn(stateDir, {
      version: "9.9.9-a-release-this-shim-is-not",
      contract_version: MCP_CONTRACT_VERSION,
    });

    const client = await connectTo(["mcp", "--attach"], stateDir);

    expect(await toolNames(client)).toEqual([...TOOL_NAMES].sort());
  }, 60_000);
});

/** Poll until `condition` holds, so a cleanup that happens on process exit can be waited for. */
async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise<void>((done) => {
      setTimeout(done, 20);
    });
  }
  throw new Error("timed out waiting for the condition");
}
