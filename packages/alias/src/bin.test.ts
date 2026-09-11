/**
 * The hand-over, as a real process.
 *
 * Every case here spawns `node src/bin.ts …` — this package's *source*, which
 * Node runs directly: `@xplainer/config`'s preset sets `erasableSyntaxOnly`, so
 * type stripping is all that is needed, and this package's own two compiler
 * options (`allowImportingTsExtensions`, `rewriteRelativeImportExtensions`) are
 * what let `bin.ts` say `./forward.ts` in source and `./forward.js` in `dist/`.
 * Spawning `dist/` instead would make the suite depend on a build `turbo.json`
 * does not give it — `test` depends on `^build`, the *dependencies'* builds —
 * and a stale `dist/` is a green test over code that is not the code.
 *
 * The dependency's build is a different matter and is the one this suite needs:
 * the forwarded-to file is `@xplainer/cli`'s `dist/bin.js`, and `^build` is
 * exactly the guarantee that it is there and current.
 *
 * **The assertion that matters most is the stdio one.** `xplainer mcp` is what
 * an agent is configured with, so this command's stdout is a JSON-RPC stream;
 * a forwarder that wrote one line of its own to stdout would corrupt an agent's
 * session rather than fail loudly. Two tests cover it from both ends: the first
 * byte of a raw `mcp` session's stdout is the protocol, and a real MCP client
 * completes a handshake and lists the tools through it.
 */

import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

/** This package's own entry, as source. */
const ENTRY = fileURLToPath(new URL("./bin.ts", import.meta.url));

/**
 * The version both this package and the one it forwards to carry, **read rather than pinned**.
 *
 * It was the literal `"0.0.1"`, which made every release break this suite: `changeset version`
 * bumps the manifests and the assertion still expected the version before the bump, so the first
 * thing a release did was turn the gate red on correct code. Measured on the `0.0.2` bump —
 * `expected '0.0.2\n' to be '0.0.1\n'`, twice.
 *
 * Reading it from this package's own manifest is also the stronger assertion, because the property
 * is *agreement* rather than any particular number: `packages/alias` is one pinned dependency on
 * `@xplainer/cli`, and what these cases check is that the forwarder announces the version of the
 * CLI it actually resolved. A literal cannot tell a matching pair from a stale expectation.
 */
const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

const scratch: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close().catch(() => {
      // Already down, which is the state this loop asks for.
    });
  }
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A throwaway state directory, so no test touches the developer's own. */
function stateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "xplainer-alias-"));
  scratch.push(directory);
  return directory;
}

function runAlias(args: readonly string[], extraArgv: readonly string[] = []) {
  return spawnSync(process.execPath, [...extraArgv, ENTRY, ...args], {
    encoding: "utf8",
    env: { ...process.env, XPLAINER_STATE_DIR: stateDirectory() },
  });
}

describe("the unscoped xplainer command", () => {
  it("prints the forwarded-to CLI's version, and nothing else, on stdout", () => {
    const result = runAlias(["--version"]);

    expect(result.status).toBe(0);
    // Exactly the version: a forwarder that announced itself would show up here.
    expect(result.stdout).toBe(`${VERSION}\n`);
  });

  it("lists the real command surface under the name `xplainer`", () => {
    const result = runAlias(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: xplainer");
    for (const command of [
      "serve",
      "status",
      "mcp",
      "setup",
      "connect",
      "daemon",
      "runtime",
      "token",
    ]) {
      expect(result.stdout).toContain(command);
    }
  });

  it("passes the CLI's own exit code back to the shell", () => {
    // commander's code for a rejected argument, which the CLI documents as its
    // usage exit code. The forwarder neither sets nor translates it.
    const result = runAlias(["nosuchcommand"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown command");
  });

  it("hands over with `process.argv[1]` naming the CLI's entry, not its own", () => {
    // The daemon's responding identity is frozen from `process.argv[1]` and
    // compared against the launch spec the supervisor holds, so an alias left
    // in that slot would report drift on a correct install. A preloaded module
    // reads the value back at exit, which is after the rewrite.
    const probe =
      'data:text/javascript,process.on("exit",()=>process.stderr.write("entry="+process.argv[1]+"\\n"))';
    const result = runAlias(["--version"], ["--import", probe]);

    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/entry=.*@xplainer[/\\]cli[/\\]dist[/\\]bin\.js$/m);
    expect(result.stderr).not.toContain(ENTRY);
  });

  it("leaves the MCP stream untouched: the first thing on stdout is the protocol", async () => {
    const child = spawn(process.execPath, [ENTRY, "mcp"], {
      env: { ...process.env, XPLAINER_STATE_DIR: stateDirectory() },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);

    const firstLine = new Promise<string>((resolve, reject) => {
      let buffered = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffered += chunk;
        const newline = buffered.indexOf("\n");
        if (newline !== -1) {
          resolve(buffered.slice(0, newline));
        }
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        reject(new Error(`the shim exited with ${String(code)} before answering`));
      });
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "xplainer-alias-test", version: VERSION },
        },
      })}\n`,
    );

    const line = await firstLine;
    // Parsed rather than matched: a leading banner, a warning or a progress dot
    // would make this throw, which is the whole assertion.
    const message: unknown = JSON.parse(line);
    expect(message).toMatchObject({ jsonrpc: "2.0", id: 1 });
    expect(Reflect.get(Object(message), "result")).toBeDefined();
  }, 30_000);

  it("carries a real MCP client's handshake and tool listing", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY, "mcp"],
      env: { ...process.env, XPLAINER_STATE_DIR: stateDirectory() } as Record<string, string>,
      stderr: "pipe",
    });
    const client = new Client({ name: "xplainer-alias-test", version: VERSION });
    clients.push(client);

    await client.connect(transport);
    transport.stderr?.on("data", () => {
      // Drained: an unread pipe blocks the child once the narrative is long enough.
    });

    expect(client.getServerVersion()?.version).toBe(VERSION);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^explainer_/);
    }
  }, 30_000);
});
