/**
 * These tests are about the registration, not about any backend.
 *
 * `createMcpServer()` is the single place the eight tools are named (plan §5
 * R20), so what has to be proved here is that the names it serves come from
 * `packages/protocol` and that a call reaches the backend intact. Everything is
 * asserted through a real MCP client over an in-memory transport rather than by
 * reading the server's internals, because `tools/list` over a transport is what
 * the CLI, the media-service and every agent client actually see.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ENGINE_OWNED_FILES, TOOL_NAMES } from "@xplainer/protocol";
import manifest from "@xplainer/protocol/schemas/manifest.json" with { type: "json" };
import { afterEach, describe, expect, it } from "vitest";
import type { RenderBackend, RenderBackendMethod } from "./backend.js";
import { createMcpServer, MCP_CONTRACT_VERSION, MCP_SERVER_NAME } from "./server.js";

/** One recorded backend invocation, so a test can assert what the tool passed on. */
type RecordedCall = {
  tool: RenderBackendMethod;
  input: unknown;
};

/**
 * A backend that records what it was asked to do and answers with fixed,
 * schema-shaped results. It implements `RenderBackend` in full, which is what
 * makes the "one method per tool" assertion below meaningful.
 */
function createStubBackend(calls: RecordedCall[]): RenderBackend {
  return {
    async explainer_create(input) {
      calls.push({ tool: "explainer_create", input });
      return {
        slug: input.slug,
        created: ["index.ts", "types.ts", "Root.tsx", "Captions.tsx", "Video.tsx", "Scenes.tsx"],
        already_present: [],
        put_media_in: `videos/${input.slug}/media`,
        next: ["Write Scenes.tsx", "Call explainer_narrate"],
      };
    },
    async explainer_put_source(input) {
      calls.push({ tool: "explainer_put_source", input });
      return { slug: input.slug, written: input.files.map((file) => file.path) };
    },
    async explainer_put_media(input) {
      calls.push({ tool: "explainer_put_media", input });
      return { slug: input.slug, name: input.name, bytes: 3 };
    },
    async explainer_narrate(input) {
      calls.push({ tool: "explainer_narrate", input });
      return { job_id: 1, status: "queued", what: "narrate", poll: "explainer_job(job_id=1)" };
    },
    async explainer_still(input) {
      calls.push({ tool: "explainer_still", input });
      return { job_id: 2, status: "queued", what: "still", poll: "explainer_job(job_id=2)" };
    },
    async explainer_render(input) {
      calls.push({ tool: "explainer_render", input });
      return { job_id: 3, status: "queued", what: "render", poll: "explainer_job(job_id=3)" };
    },
    async explainer_job(input) {
      calls.push({ tool: "explainer_job", input });
      return {
        job_id: input.job_id,
        job_type: "explainer_render",
        status: "done",
        exit_code: 0,
        error: null,
        started_at: "2026-09-05T10:00:00+00:00",
        finished_at: "2026-09-05T10:01:00+00:00",
        output: { lines: ["rendered"] },
      };
    },
    async explainer_list(input) {
      calls.push({ tool: "explainer_list", input });
      return { videos: [{ slug: "demo", has_narration: true, rendered: false }] };
    },
  };
}

const openClients: Client[] = [];

/** Connect a real MCP client to a server built over `backend`. */
async function connect(backend: RenderBackend): Promise<Client> {
  const server = createMcpServer(backend);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-server-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  openClients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

describe("createMcpServer", () => {
  it("serves exactly the protocol's eight tool names, in contract order", async () => {
    const client = await connect(createStubBackend([]));

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
  });

  it("takes each tool's title and description from the protocol manifest", async () => {
    const client = await connect(createStubBackend([]));

    const { tools } = await client.listTools();

    for (const tool of tools) {
      const entry = manifest.tools.find((candidate) => candidate.name === tool.name);
      expect(entry, `manifest entry for ${tool.name}`).toBeDefined();
      expect(tool.title).toBe(entry?.title);
      expect(tool.description).toBe(entry?.description);
    }
  });

  it("routes a call to the matching backend method with the caller's arguments", async () => {
    const calls: RecordedCall[] = [];
    const client = await connect(createStubBackend(calls));

    const result = await client.callTool({
      name: "explainer_still",
      arguments: { slug: "demo", frame: 42, scale: 0.5 },
    });

    expect(calls).toEqual([
      { tool: "explainer_still", input: { slug: "demo", frame: 42, scale: 0.5 } },
    ]);
    expect(result.structuredContent).toEqual({
      job_id: 2,
      status: "queued",
      what: "still",
      poll: "explainer_job(job_id=2)",
    });
  });

  it("reports a rejected backend call as a tool error rather than failing the request", async () => {
    const backend = createStubBackend([]);
    backend.explainer_render = async () => {
      throw new Error("render backend unavailable");
    };
    const client = await connect(backend);

    const result = await client.callTool({ name: "explainer_render", arguments: { slug: "demo" } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("render backend unavailable");
  });

  it("announces itself with the protocol manifest's name and contract version", async () => {
    const client = await connect(createStubBackend([]));

    expect(client.getServerVersion()).toMatchObject({
      name: MCP_SERVER_NAME,
      version: MCP_CONTRACT_VERSION,
    });
    expect(MCP_SERVER_NAME).toBe(manifest.name);
    expect(MCP_CONTRACT_VERSION).toBe(manifest.version);
  });
});

/**
 * The registration is where file ownership is enforced (ADR 0018, layer 2).
 *
 * Asserted through a real MCP client rather than by calling the guard directly —
 * `put-source-guard.test.ts` does that — because what matters here is that the
 * refusal reaches an agent as a tool result it can read, and that the backend
 * never saw the call. Every surface that serves this contract shares this
 * registration, so proving it once proves it for the CLI's stdio transport, the
 * CLI's Streamable HTTP endpoint and the hosted media-service alike.
 */
describe("explainer_put_source ownership", () => {
  it("refuses a write to an engine-owned file, and the backend is never reached", async () => {
    const calls: RecordedCall[] = [];
    const client = await connect(createStubBackend(calls));

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
    // All-or-nothing: the agent's legitimate scene file was not written either.
    expect(calls).toEqual([]);
    expect(JSON.stringify(result.content)).toContain("Nothing was written.");
  });

  it("writes the agent's own files, a scene component named Root.tsx included", async () => {
    const calls: RecordedCall[] = [];
    const client = await connect(createStubBackend(calls));

    const result = await client.callTool({
      name: "explainer_put_source",
      arguments: {
        slug: "demo",
        files: [
          { path: "Scenes.tsx", content: "export const scenes = {};" },
          { path: "scenes/Root.tsx", content: "export const Root = () => null;" },
        ],
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      slug: "demo",
      written: ["Scenes.tsx", "scenes/Root.tsx"],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tool).toBe("explainer_put_source");
  });
});

describe("RenderBackend", () => {
  it("declares one method per protocol tool and no others", () => {
    const backend = createStubBackend([]);

    expect(Object.keys(backend).sort()).toEqual([...TOOL_NAMES].sort());
  });
});
