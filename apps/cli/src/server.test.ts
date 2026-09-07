/**
 * What `xplainer serve` actually serves.
 *
 * Every test binds the real server on an ephemeral port and talks to it over the
 * network, because AC-14c and AC-14d are about what a curl and an MCP client
 * see, not about what the app object contains. The tool list is compared against
 * `TOOL_NAMES` from `@xplainer/protocol` — never against `apps/api`'s Python
 * assertion and never against a list written here — so the two language surfaces
 * are pinned to the manifest instead of to each other (plan §5 R20).
 *
 * The backend under the server is the **real** one — `createLocalBackend()` over a temporary
 * workspace and a temporary job store — and not a stub, because two of these tests are about what
 * a backend would have done if it had been reached. A stub that rejects everything makes
 * "the guard ran first" unfalsifiable: every answer looks like a refusal. With the real backend the
 * video exists, `Video.tsx` is on disk with known bytes, and the assertion has teeth in both
 * directions.
 *
 * The last describe is ADR 0020 §Security R-SEC-11, which asks for exactly these
 * negative tests *here*, beside the positive ones: "Without them the guard
 * regresses on the first refactor of `createServer()` and nobody notices,
 * because every legitimate client still works." They go through `node:http`
 * rather than `fetch`, because `fetch` writes the `Host` header itself from the
 * URL and silently drops any override — so a rebinding test written with it
 * would pass no matter what the guard did. The layers themselves are asserted
 * one at a time in `daemon/guard.test.ts`; what these prove is that they are
 * actually mounted on a bound listener, in front of every route.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RenderBackend } from "@xplainer/mcp-server";
import { ENGINE_OWNED_FILES, MCP_CONTRACT_VERSION, TOOL_NAMES } from "@xplainer/protocol";
import { readScaffoldTemplate, videoPaths } from "@xplainer/render-core";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalBackend } from "./backend.js";
import { createLoopbackGuard } from "./daemon/guard.js";
import { createJobStore } from "./daemon/job-store.js";
import { createJobRunner } from "./daemon/runner.js";
import { selfIdentity } from "./daemon/worker-identity.js";
import { type RunningServer, startServer } from "./server.js";
import { CLI_VERSION } from "./version.js";

let running: RunningServer | undefined;
const temporaryDirectories: string[] = [];
/** The workspace the backend under test writes into, so a test can read what a tool did. */
let workspaceRoot = "";

afterEach(async () => {
  await running?.close();
  running = undefined;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  workspaceRoot = "";
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * The real backend, over a temporary workspace and a temporary job store.
 *
 * The runner is the real one too — a real store, a real owner, a real queue — because
 * `explainer_job` *is* `runner.get()` and a double there would make the tool's answers this test's
 * invention. No worker registry is passed: nothing here enqueues, and a job kind with no worker
 * fails as a job rather than as a tool call, which is the runner's own documented behaviour.
 */
function localBackend(): RenderBackend {
  workspaceRoot = temporaryDirectory("xplainer-serve-workspace-");
  const store = createJobStore(temporaryDirectory("xplainer-serve-state-"));
  const runner = createJobRunner({
    store,
    owner: { ...selfIdentity(), run_id: "server-test" },
  });
  return createLocalBackend({ runner, root: workspaceRoot });
}

/** Bind the server on a port the OS picks, so the tests never collide. */
async function serveOnEphemeralPort(): Promise<RunningServer> {
  running = await startServer({ backend: localBackend(), port: 0 });
  return running;
}

/**
 * The SDK's own client transport does not satisfy the SDK's own `Transport`
 * interface under `exactOptionalPropertyTypes`: `Transport` declares
 * `sessionId?: string` while `StreamableHTTPClientTransport` declares
 * `sessionId: string | undefined` (@modelcontextprotocol/sdk 1.30.0,
 * `shared/transport.d.ts:83` against `client/streamableHttp.d.ts`). Both spell
 * the same fact — no session id until the server issues one, and this server is
 * stateless so it never does — but only one of the two spellings is assignable.
 *
 * `satisfies` cannot repair assignability at a call site, and a delegating
 * adapter would hit the identical mismatch on every optional callback member, so
 * the widening is stated once, here, in test code. Drop this when the SDK's
 * declaration is fixed.
 */
function clientTransport(url: URL): Transport {
  return new StreamableHTTPClientTransport(url) as Transport;
}

describe("xplainer serve", () => {
  it("answers GET /healthz with status and version", async () => {
    const server = await serveOnEphemeralPort();

    const response = await fetch(`${server.url}/healthz`);
    const body = (await response.json()) as { status: unknown; version: unknown };

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.version).toBe(CLI_VERSION);
  });

  /**
   * The contract-version advertisement spike P1-S3 chose (ADR 0025 §Note,
   * 2026-09-06). `xplainer mcp --attach` reads it here, before it opens an MCP
   * session, so it cannot come from the `initialize` handshake — and it must not
   * be the release version, which is the separate `version` field above and is
   * what `serverInfo.version` reports.
   */
  it("advertises the contract version on /healthz, separately from the release version", async () => {
    const server = await serveOnEphemeralPort();

    const response = await fetch(`${server.url}/healthz`);
    const body = (await response.json()) as { version: unknown; contract_version: unknown };

    expect(response.status).toBe(200);
    expect(body.contract_version).toBe(MCP_CONTRACT_VERSION);
    expect(body.version).toBe(CLI_VERSION);
  });

  it("keeps the advertised contract version independent of the release version it reports", async () => {
    running = await startServer({
      backend: localBackend(),
      port: 0,
      version: "9.9.9-a-release-version-that-is-not-the-contract",
    });

    const response = await fetch(`${running.url}/healthz`);
    const body = (await response.json()) as { version: unknown; contract_version: unknown };

    expect(body.version).toBe("9.9.9-a-release-version-that-is-not-the-contract");
    expect(body.contract_version).toBe(MCP_CONTRACT_VERSION);
  });

  /**
   * The ownership refusal is registered in `@xplainer/mcp-server`, not here, and
   * this test is what proves the local daemon inherits it rather than needing
   * its own copy (ADR 0018, layer 2).
   *
   * The video is created first, so `Video.tsx` really is on disk with the template's bytes when
   * the refused call is made. That is what gives the assertion teeth: the guard is credited only
   * because the file is byte-identical to the template afterwards, and a guard that had let the
   * call through would have left the agent's line there instead.
   */
  it("refuses a /mcp write to an engine-owned file before the backend is reached", async () => {
    const server = await serveOnEphemeralPort();

    const client = new Client({ name: "xplainer-cli-test", version: CLI_VERSION });
    await client.connect(clientTransport(new URL(`${server.url}/mcp`)));

    try {
      await client.callTool({ name: "explainer_create", arguments: { slug: "demo" } });
      const shell = join(videoPaths(workspaceRoot, "demo").source, "Video.tsx");
      expect(readFileSync(shell, "utf8")).toContain("ENGINE-OWNED");

      const result = await client.callTool({
        name: "explainer_put_source",
        arguments: {
          slug: "demo",
          files: [
            { path: "scenes/Intro.tsx", content: "export const Intro = () => null;" },
            { path: "Video.tsx", content: "// the shell an agent must not own" },
          ],
        },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: {
          code: "ENGINE_OWNED_PATH",
          message: expect.stringContaining("engine-owned"),
          rejected: ["Video.tsx"],
          engine_owned: [...ENGINE_OWNED_FILES],
        },
        written: [],
      });
      // Nothing was written: not the refused shell, and not the legitimate scene beside it.
      expect(readFileSync(shell)).toEqual(readScaffoldTemplate("Video.tsx"));
      expect(existsSync(join(videoPaths(workspaceRoot, "demo").source, "scenes"))).toBe(false);
    } finally {
      await client.close();
    }
  });

  /**
   * The tools do real work now, and this is the shortest end-to-end proof of it over the wire:
   * two videos created through `/mcp`, then listed through `/mcp`, with the answer coming from
   * what is actually on disk in the workspace rather than from a fixed result.
   */
  it("serves a real explainer_list built from the workspace the tools wrote", async () => {
    const server = await serveOnEphemeralPort();

    const client = new Client({ name: "xplainer-cli-test", version: CLI_VERSION });
    await client.connect(clientTransport(new URL(`${server.url}/mcp`)));

    try {
      const created = await client.callTool({
        name: "explainer_create",
        arguments: { slug: "second" },
      });
      await client.callTool({ name: "explainer_create", arguments: { slug: "first" } });

      expect(created.structuredContent).toMatchObject({
        slug: "second",
        created: ["index.ts", "types.ts", "Root.tsx", "Captions.tsx", "Video.tsx", "Scenes.tsx"],
        already_present: [],
        write_source_to: videoPaths(workspaceRoot, "second").source,
        put_media_in: videoPaths(workspaceRoot, "second").media,
      });

      const listed = await client.callTool({ name: "explainer_list", arguments: {} });

      expect(listed.isError).toBeFalsy();
      expect(listed.structuredContent).toEqual({
        videos: [
          { slug: "first", has_narration: false, rendered: false },
          { slug: "second", has_narration: false, rendered: false },
        ],
      });
    } finally {
      await client.close();
    }
  });

  it("serves a /mcp tools/list equal to the protocol manifest", async () => {
    const server = await serveOnEphemeralPort();

    const client = new Client({ name: "xplainer-cli-test", version: CLI_VERSION });
    await client.connect(clientTransport(new URL(`${server.url}/mcp`)));

    try {
      const { tools } = await client.listTools();
      const served = tools.map((tool) => tool.name).sort();

      expect(served).toEqual([...TOOL_NAMES].sort());
    } finally {
      await client.close();
    }
  });
});

/** The token these tests hand the guard. A real one is 32 random bytes; the length is all that matters here. */
const TEST_TOKEN = "a-test-token-of-thirty-two-chars";

/** One request with exactly the headers given, because `fetch` refuses to send a `Host`. */
function send(
  port: number,
  path: string,
  options: { headers?: Record<string, string>; method?: string; body?: string } = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const call = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body });
        });
      },
    );
    call.on("error", reject);
    call.end(options.body);
  });
}

/** The same server the daemon binds, with the same guard in front of it. */
async function serveGuarded(): Promise<RunningServer> {
  running = await startServer({
    backend: localBackend(),
    port: 0,
    guard: (port) => createLoopbackGuard({ token: TEST_TOKEN, port: () => port }),
  });
  return running;
}

/** The headers a legitimate local client sends: the real authority, and the token. */
function authorized(port: number): Record<string, string> {
  return { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${TEST_TOKEN}` };
}

/** A minimal, well-formed MCP request, so a 200 here means the transport really answered. */
const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "xplainer-cli-test", version: CLI_VERSION },
  },
});

const MCP_POST = {
  method: "POST",
  body: INITIALIZE,
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  },
};

describe("the loopback guard on a bound listener", () => {
  it("answers /healthz with 200 for a request carrying the token and a loopback Host", async () => {
    const server = await serveGuarded();

    const response = await send(server.port, "/healthz", { headers: authorized(server.port) });
    const body = JSON.parse(response.body) as { status: unknown; contract_version: unknown };

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.contract_version).toBe(MCP_CONTRACT_VERSION);
  });

  it("answers /mcp with 200 for the same request", async () => {
    const server = await serveGuarded();

    const response = await send(server.port, "/mcp", {
      ...MCP_POST,
      headers: { ...MCP_POST.headers, ...authorized(server.port) },
    });

    expect(response.status).toBe(200);
    expect(response.body).toContain("serverInfo");
  });

  /**
   * R-SEC-4 authenticates `/healthz` too, and that is load-bearing twice: an unauthenticated
   * `{status, version}` tells a web page which xplainer to attack, and a `401` against *our* token
   * is what lets `status` say "something is on our port that is not our daemon".
   */
  it.each([
    ["/healthz", {}],
    ["/mcp", MCP_POST],
  ])("answers 401 with a Bearer challenge for %s without a token", async (path, extra) => {
    const server = await serveGuarded();

    const response = await send(server.port, path, {
      ...extra,
      headers: { ...("headers" in extra ? extra.headers : {}), Host: `127.0.0.1:${server.port}` },
    });

    expect(response.status).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(response.body).toContain("UNAUTHORIZED");
  });

  it.each([
    ["/healthz", {}],
    ["/mcp", MCP_POST],
  ])("answers 403 for %s with Host: evil.com:8787", async (path, extra) => {
    const server = await serveGuarded();

    const response = await send(server.port, path, {
      ...extra,
      headers: {
        ...("headers" in extra ? extra.headers : {}),
        ...authorized(server.port),
        Host: "evil.com:8787",
      },
    });

    expect(response.status).toBe(403);
    expect(response.body).toContain("FORBIDDEN_HOST");
  });

  it.each([
    ["/healthz", {}],
    ["/mcp", MCP_POST],
  ])("answers 403 for %s with Origin: http://evil.com", async (path, extra) => {
    const server = await serveGuarded();

    const response = await send(server.port, path, {
      ...extra,
      headers: {
        ...("headers" in extra ? extra.headers : {}),
        ...authorized(server.port),
        Origin: "http://evil.com",
      },
    });

    expect(response.status).toBe(403);
    expect(response.body).toContain("FORBIDDEN_ORIGIN");
  });

  /**
   * The guard is mounted before any route, so a route that answers something other than a body —
   * `GET /mcp` is the transport method stateless mode cannot serve, and answers `405` — is behind it
   * too. A `405` here would mean the route ran first, which is how a new route ships unguarded.
   */
  it("answers 401 rather than 405 for an unauthenticated GET /mcp", async () => {
    const server = await serveGuarded();

    const refused = await send(server.port, "/mcp", {
      headers: { Host: `127.0.0.1:${server.port}` },
    });
    const allowed = await send(server.port, "/mcp", { headers: authorized(server.port) });

    expect(refused.status).toBe(401);
    expect(allowed.status).toBe(405);
  });

  /**
   * The guard is a parameter, not a mode: the IPC listener and `services/media-service` pass their
   * own, and a server given none is the one every other test in this file binds.
   */
  it("does not authenticate a server that was given no guard", async () => {
    running = await startServer({ backend: localBackend(), port: 0 });

    expect((await send(running.port, "/healthz")).status).toBe(200);
  });
});
