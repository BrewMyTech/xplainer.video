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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RenderBackend } from "@xplainer/mcp-server";
import { ENGINE_OWNED_FILES, MCP_CONTRACT_VERSION, TOOL_NAMES } from "@xplainer/protocol";
import { readScaffoldTemplate, videoPaths } from "@xplainer/render-core";
import { afterEach, describe, expect, it } from "vitest";
import { openBody, openSse } from "./api/testing/harness.js";
import { createWorkspaceLibrary } from "./api/videos.js";
import { createLocalBackend } from "./backend.js";
import { createLoopbackGuard } from "./daemon/guard.js";
import { createJobStore } from "./daemon/job-store.js";
import { createJobRunner, type JobRunner, type WorkerRegistry } from "./daemon/runner.js";
import { fakeWorkerRegistry } from "./daemon/testing/fake-worker.js";
import { testIpcEndpoint } from "./daemon/testing/platform.js";
import { selfIdentity } from "./daemon/worker-identity.js";
import {
  DRAIN_PATH,
  type DrainSeam,
  LISTENER_CLOSE_GRACE_MS,
  type RunningServer,
  startServer,
} from "./server.js";
import { CLI_VERSION } from "./version.js";

let running: RunningServer | undefined;
const temporaryDirectories: string[] = [];
const runners: JobRunner[] = [];
/** The workspace the backend under test writes into, so a test can read what a tool did. */
let workspaceRoot = "";

afterEach(async () => {
  await running?.close();
  running = undefined;
  for (const runner of runners.splice(0)) {
    await runner.drain(0);
  }
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
function localBackend(workers?: WorkerRegistry): RenderBackend {
  workspaceRoot = temporaryDirectory("xplainer-serve-workspace-");
  const store = createJobStore(temporaryDirectory("xplainer-serve-state-"));
  const runner = createJobRunner({
    store,
    owner: { ...selfIdentity(), run_id: "server-test" },
    ...(workers === undefined ? {} : { workers }),
  });
  // Kept so `afterEach` can drain it: the one test that passes a registry starts a real child, and
  // a worker still running when the temporary directories go would write into a directory that no
  // longer exists.
  runners.push(runner);
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

  /**
   * The identity row, and the one caller that has none.
   *
   * A server built with no identity is `services/media-service`: it takes no state directory and
   * holds no ownership, so there is nothing for it to advertise. Both fields are then `null` rather
   * than absent, which is what keeps the body one shape — a reader never has to tell "this release
   * does not have the field" apart from "this server is not a daemon".
   */
  it("advertises the identity it was given on /healthz, and nulls where it was given none", async () => {
    running = await startServer({
      backend: localBackend(),
      port: 0,
      identity: {
        run_id: "0d5f1d4a-1e2b-4c3d-8e9f-0a1b2c3d4e5f",
        runtime_digest: "0123456789abcdef",
      },
    });
    const advertised = (await (await fetch(`${running.url}/healthz`)).json()) as {
      run_id: unknown;
      runtime_digest: unknown;
    };
    expect(advertised.run_id).toBe("0d5f1d4a-1e2b-4c3d-8e9f-0a1b2c3d4e5f");
    expect(advertised.runtime_digest).toBe("0123456789abcdef");
    await running.close();

    running = await startServer({ backend: localBackend(), port: 0 });
    const bare = (await (await fetch(`${running.url}/healthz`)).json()) as {
      status: unknown;
      run_id: unknown;
      runtime_digest: unknown;
    };
    expect(bare.status).toBe("ok");
    expect(bare.run_id).toBeNull();
    expect(bare.runtime_digest).toBeNull();
  });

  /**
   * ADR 0020 §Degraded paths: a daemon whose render toolchain is absent must **report** it, not
   * answer `ok` and fail every render. Nothing produced that report before this story — `/healthz`
   * said `ok` for a machine with no browser, no speech provider and no installed workspace.
   *
   * It stays a `200` deliberately. The daemon is up, answering and holding the queue; what is
   * missing is something only `xplainer setup` can supply, and a `503` would make every liveness
   * probe and every supervisor treat a working daemon as a failed one.
   */
  it("reports a degraded toolchain with its reason, and stays a 200", async () => {
    running = await startServer({
      backend: localBackend(),
      port: 0,
      toolchain: () => ({ ok: false, reason: "toolchain_missing" }),
    });

    const response = await fetch(`${running.url}/healthz`);
    const body = (await response.json()) as { status: unknown; reason: unknown };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "degraded", reason: "toolchain_missing" });
  });

  /**
   * The seam is a function and not a value, because the condition changes **under a running
   * daemon**: `xplainer setup` is a separate process, and a workspace can be deleted while this one
   * is up. A snapshot taken at bind would answer for a machine that no longer exists.
   */
  it("asks the toolchain again on every request rather than once at bind", async () => {
    let healthy = true;
    running = await startServer({
      backend: localBackend(),
      port: 0,
      toolchain: () =>
        healthy ? { ok: true, reason: null } : { ok: false, reason: "toolchain_stale" },
    });

    const before = (await (await fetch(`${running.url}/healthz`)).json()) as { status: unknown };
    healthy = false;
    const after = (await (await fetch(`${running.url}/healthz`)).json()) as {
      status: unknown;
      reason: unknown;
    };

    expect(before.status).toBe("ok");
    expect(after).toMatchObject({ status: "degraded", reason: "toolchain_stale" });
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

/** The same request, sent to a unix socket instead of a port. `fetch` cannot name a socket path. */
function sendOverSocket(
  socketPath: string,
  path: string,
  options: { headers?: Record<string, string>; method?: string; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const call = request(
      {
        socketPath,
        path,
        method: options.method ?? "GET",
        headers: { host: "xplainer.ipc", ...options.headers },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, body });
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
    guard: (port) => createLoopbackGuard({ tokens: () => [TEST_TOKEN], port: () => port }),
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

/**
 * `POST /api/daemon/drain`: the one route that is not the same on both listeners.
 *
 * The seam is `CreateServerOptions.isOverIpc`, and everything here is about what it decides.
 * `startServer()` passes a predicate over the `WeakSet<Request>` its socket adaptor fills in, so
 * "this arrived over IPC" is a fact about the listener that accepted the connection — which is why
 * the negative below is worth having: a request that is *identical* except for where it was sent
 * gets a `404`, with a valid bearer token, from a daemon that answers the same request `202` on the
 * socket. Nothing a client can put in a header, a path or a body moves it across that line.
 *
 * The drain itself is `daemon/shutdown.ts`'s and is asserted against a real spawned `serve` in
 * `commands/serve.test.ts`; what these tests own is the route, the seam, and the ordering promise
 * that the acknowledgement is written before the listeners go.
 */
describe("the drain route", () => {
  /** A seam that records what the route asked for, and a promise for when it asked. */
  function recordingDrain(begin?: (reason: string) => void): {
    seam: DrainSeam;
    reasons: string[];
    began: Promise<string>;
  } {
    const reasons: string[] = [];
    let announce: (reason: string) => void = () => {};
    const began = new Promise<string>((resolve) => {
      announce = resolve;
    });
    return {
      reasons,
      began,
      seam: {
        timeoutMs: 20_000,
        pid: process.pid,
        begin: (reason) => {
          reasons.push(reason);
          begin?.(reason);
          announce(reason);
        },
      },
    };
  }

  /** The two listeners a daemon binds, with the guard on the TCP one, as `serve` binds them. */
  async function serveWithDrain(seam?: DrainSeam): Promise<RunningServer & { socketPath: string }> {
    const socketPath = testIpcEndpoint(temporaryDirectory("xplainer-drain-ipc-"));
    running = await startServer({
      backend: localBackend(),
      port: 0,
      ipc: { path: socketPath },
      guard: (port) => createLoopbackGuard({ tokens: () => [TEST_TOKEN], port: () => port }),
      ...(seam === undefined ? {} : { drain: seam }),
    });
    return Object.assign(running, { socketPath });
  }

  it("runs the drain for a POST over the socket, and answers with the daemon's own numbers", async () => {
    const drain = recordingDrain();
    const server = await serveWithDrain(drain.seam);

    const response = await sendOverSocket(server.socketPath, DRAIN_PATH, { method: "POST" });

    expect(response.status).toBe(202);
    expect(JSON.parse(response.body)).toEqual({
      event: "draining",
      timeout_ms: 20_000,
      pid: process.pid,
      already_draining: false,
    });
    expect(await drain.began).toBe(`POST ${DRAIN_PATH}`);
    expect(drain.reasons).toEqual([`POST ${DRAIN_PATH}`]);
  });

  /**
   * The negative R11 asks for. A token that lets a caller render must not also let it stop this
   * machine's daemon, and the answer is the one a route that does not exist gives — there is
   * nothing here to discover by asking.
   */
  it("answers 404 over TCP with a valid bearer token, exactly as it does for no such route", async () => {
    const drain = recordingDrain();
    const server = await serveWithDrain(drain.seam);

    const refused = await send(server.port, DRAIN_PATH, {
      method: "POST",
      headers: authorized(server.port),
    });
    const noSuchRoute = await send(server.port, "/api/daemon/no-such-route", {
      method: "POST",
      headers: authorized(server.port),
    });

    expect(refused.status).toBe(404);
    expect(refused.body).toBe(noSuchRoute.body);
    expect(drain.reasons).toEqual([]);
    // And the same daemon is still there to serve the request that is allowed.
    expect((await send(server.port, "/healthz", { headers: authorized(server.port) })).status).toBe(
      200,
    );
  });

  /** The guard is still mounted in front of it, so an unauthenticated TCP caller never reaches the route. */
  it("answers 401 over TCP without a token", async () => {
    const drain = recordingDrain();
    const server = await serveWithDrain(drain.seam);

    const response = await send(server.port, DRAIN_PATH, {
      method: "POST",
      headers: { Host: `127.0.0.1:${server.port}` },
    });

    expect(response.status).toBe(401);
    expect(drain.reasons).toEqual([]);
  });

  /** A server with no drain to run has no such route at all — not one that answers on one listener. */
  it("is absent from a server that was given no drain", async () => {
    const server = await serveWithDrain();

    const response = await sendOverSocket(server.socketPath, DRAIN_PATH, { method: "POST" });

    expect(response.status).toBe(404);
  });

  /** A second ask is answered rather than refused, and starts nothing: one drain per process. */
  it("answers a second POST without beginning a second drain", async () => {
    const drain = recordingDrain();
    const server = await serveWithDrain(drain.seam);

    const first = await sendOverSocket(server.socketPath, DRAIN_PATH, { method: "POST" });
    const second = await sendOverSocket(server.socketPath, DRAIN_PATH, { method: "POST" });

    expect(JSON.parse(first.body)).toMatchObject({ already_draining: false });
    expect(JSON.parse(second.body)).toMatchObject({ already_draining: true, pid: process.pid });
    await drain.began;
    expect(drain.reasons).toEqual([`POST ${DRAIN_PATH}`]);
  });

  /**
   * The ordering promise, with the case that makes it hard: a request that never ends.
   *
   * The long-lived response here is a tool call the backend never answers, which holds a TCP
   * connection open with no `/api/*` surface involved at all — the property belongs to the drain
   * and to `closer()`, not to any one route. The test below it is the same promise against the two
   * real long-lived responses T21 added, an open SSE stream and a media body mid-transfer. Two
   * things have to be true at once, and each one alone is
   * cheap to satisfy by breaking the other: the drain's own acknowledgement is **complete** — a
   * `202` with its whole body, not a reset connection — and closing the listeners afterwards
   * **finishes**, because `server.close()` on its own waits for a connection that will never go
   * idle and the daemon would hang holding its socket file and its state directory.
   */
  it("answers in full and still closes, with a request open that never ends", async () => {
    let release: () => void = () => {};
    const held = new Promise<never>((_resolve, reject) => {
      release = () => {
        reject(new Error("the test released the held tool call"));
      };
    });
    const socketPath = testIpcEndpoint(temporaryDirectory("xplainer-drain-ipc-"));
    let closed: Promise<void> | null = null;
    const drain = recordingDrain(() => {
      closed = running?.close() ?? Promise.resolve();
    });

    running = await startServer({
      backend: { ...localBackend(), explainer_list: () => held },
      port: 0,
      ipc: { path: socketPath },
      drain: drain.seam,
      guard: (port) => createLoopbackGuard({ tokens: () => [TEST_TOKEN], port: () => port }),
    });

    try {
      // A request that will not answer, on the TCP listener, before anything is drained.
      const hanging = send(running.port, "/mcp", {
        ...MCP_POST,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "explainer_list", arguments: {} },
        }),
        headers: { ...MCP_POST.headers, ...authorized(running.port) },
      }).catch((error: unknown) => ({ status: 0, headers: {}, body: String(error) }));
      // It is in flight before the drain: the daemon answered a second request while it was open.
      expect(
        (await send(running.port, "/healthz", { headers: authorized(running.port) })).status,
      ).toBe(200);

      const startedAt = Date.now();
      const acknowledgement = await sendOverSocket(socketPath, DRAIN_PATH, { method: "POST" });

      expect(acknowledgement.status).toBe(202);
      expect(JSON.parse(acknowledgement.body)).toMatchObject({ event: "draining" });
      await drain.began;
      await closed;
      const elapsed = Date.now() - startedAt;

      // Both listeners are gone, inside the grace rather than never.
      expect(elapsed).toBeLessThan(LISTENER_CLOSE_GRACE_MS + 5_000);
      await expect(
        send(running.port, "/healthz", { headers: authorized(running.port) }),
      ).rejects.toThrow();
      await expect(sendOverSocket(socketPath, "/healthz")).rejects.toThrow();
      // And the request that never ends was taken away rather than waited for: it ends as a
      // destroyed connection, which is what `closeAllConnections()` does to it and what
      // `server.close()` on its own would never have done.
      const abandoned = await hanging;
      expect(abandoned.status).toBe(0);
      expect(drain.reasons).toEqual([`POST ${DRAIN_PATH}`]);
      running = undefined;
    } finally {
      release();
    }
  }, 30_000);

  /**
   * The same promise against the two long-lived responses the daemon actually serves.
   *
   * T13 specified this case and could not exercise it: `/api/*` did not exist, so the only
   * long-lived response available was a tool call left unanswered. Now there are two real ones —
   * an **SSE subscriber** watching a running job, and a **media body mid-transfer** — and they fail
   * differently from a stalled tool call. The stream is a response the daemon is *still writing to*
   * on a timer; the media body is a file read the daemon is blocked on because the client stopped
   * reading, which is exactly what a player scrubbing an MP4 leaves behind. Both are in flight when
   * the drain is asked for, and the two things that must be true are the two ADR 0024 step 6
   * depends on: the acknowledgement is **complete** — a `202` with its whole body, over the socket,
   * before anything is torn down — and closing the listeners afterwards **finishes**, because
   * `server.close()` waits for connections that would never go idle on their own.
   *
   * The film is deliberately larger than any socket buffer can swallow, and the client reads 64 KB
   * of it and then stops: a body that has delivered bytes and is now blocked is a transfer the
   * daemon has begun, rather than one that has merely never been consumed.
   */
  it("answers in full and still closes, with an SSE stream and a media body in flight", async () => {
    const socketPath = testIpcEndpoint(temporaryDirectory("xplainer-drain-ipc-"));
    let closed: Promise<void> | null = null;
    const drain = recordingDrain(() => {
      closed = running?.close() ?? Promise.resolve();
    });
    // A worker that keeps running, so the job the stream is watching does not finish first.
    const backend = localBackend(fakeWorkerRegistry({ lines: 1, lifeMs: 30_000 }));

    running = await startServer({
      backend,
      port: 0,
      ipc: { path: socketPath },
      drain: drain.seam,
      guard: (port) => createLoopbackGuard({ tokens: () => [TEST_TOKEN], port: () => port }),
      api: { library: createWorkspaceLibrary({ root: workspaceRoot }), pollIntervalMs: 20 },
    });
    const port = running.port;

    await backend.explainer_create({ slug: "drained" });
    const film = videoPaths(workspaceRoot, "drained").mp4;
    mkdirSync(dirname(film), { recursive: true });
    const bytes = 64 * 1024 * 1024;
    writeFileSync(film, Buffer.alloc(bytes, 7));
    const queued = await backend.explainer_narrate({
      slug: "drained",
      narration: { segments: [{ id: "one", text: "Something worth watching." }] },
    });

    // One SSE subscriber, with a frame already delivered.
    const stream = await openSse({ port }, `/api/jobs/${queued.job_id}/events`, {
      headers: authorized(port),
    });
    const first = await stream.waitFor("job");
    // One media body, 64 KB in and blocked on a client that stopped reading.
    const body = await openBody({ port }, "/api/videos/drained/artefacts/explainer.mp4", {
      headers: authorized(port),
      pauseAfter: 64 * 1024,
    });
    await body.waitForBytes(64 * 1024);

    expect(stream.status).toBe(200);
    expect(JSON.parse(first.data)).toMatchObject({ job_id: queued.job_id });
    expect(body.status).toBe(200);
    expect(body.headers["content-length"]).toBe(String(bytes));
    expect(body.received()).toBeGreaterThanOrEqual(64 * 1024);
    expect(body.isComplete()).toBe(false);
    // Both are open, and the daemon is still answering everything else.
    expect((await send(port, "/healthz", { headers: authorized(port) })).status).toBe(200);

    const startedAt = Date.now();
    const acknowledgement = await sendOverSocket(socketPath, DRAIN_PATH, { method: "POST" });

    // The drain answered its own request, in full, before the listeners went.
    expect(acknowledgement.status).toBe(202);
    expect(JSON.parse(acknowledgement.body)).toEqual({
      event: "draining",
      timeout_ms: 20_000,
      pid: process.pid,
      already_draining: false,
    });
    await drain.began;
    await closed;
    const elapsed = Date.now() - startedAt;

    // Inside the grace rather than never, with both listeners gone.
    expect(elapsed).toBeLessThan(LISTENER_CLOSE_GRACE_MS + 5_000);
    await expect(send(port, "/healthz", { headers: authorized(port) })).rejects.toThrow();
    await expect(sendOverSocket(socketPath, "/healthz")).rejects.toThrow();
    // And both long-lived responses were taken away rather than waited for: the stream ended
    // without its `end` event, and the film never finished sending.
    await stream.ended;
    await body.finish();
    expect(stream.frames.some((frame) => frame.event === "end")).toBe(false);
    expect(body.isComplete()).toBe(false);
    expect(body.received()).toBeLessThan(bytes);
    expect(drain.reasons).toEqual([`POST ${DRAIN_PATH}`]);
    running = undefined;
  }, 30_000);
});
