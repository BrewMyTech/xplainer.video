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
import {
  ENGINE_OWNED_FILES,
  TOOL_INPUT_SCHEMAS,
  TOOL_NAMES,
  type ToolName,
} from "@xplainer/protocol";
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
        error_code: null,
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

/**
 * The defect this suite exists to keep fixed.
 *
 * Every tool was registered with one open object, so `tools/list` published
 * `{"type":"object","properties":{}}` for all eight and a client was told
 * nothing about any argument. It was reported from a real session on
 * 2026-09-11: the agent passed `narration` as a JSON string, because nothing
 * had said it was an object, and the backend rejected every call. The operator
 * stopped using the tool and drove the daemon from a hand-written script.
 *
 * These cases assert the published schema rather than the validation alone,
 * because the published schema is the half that failed — a client that is told
 * the shape does not guess it wrong in the first place.
 */
/** A JSON Schema's `properties`, narrowed without an assertion so the suite typechecks strictly. */
function propertiesOf(schema: unknown): Record<string, unknown> {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    return {};
  }
  return schema.properties;
}

describe("published input schemas", () => {
  it("publishes each tool's real arguments, not an open object", async () => {
    const client = await connect(createStubBackend([]));

    const { tools } = await client.listTools();

    for (const tool of tools) {
      const published = Object.keys(tool.inputSchema.properties ?? {});
      // Compared against the protocol's own bundled document rather than a list written here, so a
      // tool that gains an argument does not need this test edited to keep covering it.
      const contract = Object.keys(propertiesOf(TOOL_INPUT_SCHEMAS[tool.name as ToolName]));
      expect(published, `${tool.name} publishes its contract's arguments`).toEqual(contract);
      expect(tool.inputSchema.required ?? [], `${tool.name} publishes what is required`).toEqual(
        TOOL_INPUT_SCHEMAS[tool.name as ToolName].required ?? [],
      );
    }

    // And the whole point: at least one tool has arguments, so an all-empty publish — the defect —
    // cannot satisfy the loop above by matching an equally empty contract.
    const narrate = tools.find((tool) => tool.name === "explainer_narrate");
    expect(Object.keys(narrate?.inputSchema.properties ?? {}).length).toBeGreaterThan(0);
  });

  it("tells a client that narration is an object, with its fields", async () => {
    const client = await connect(createStubBackend([]));

    const { tools } = await client.listTools();
    const narrate = tools.find((tool) => tool.name === "explainer_narrate");
    const narration = propertiesOf(narrate?.inputSchema).narration;

    expect(narrate?.inputSchema.required).toEqual(["slug", "narration"]);
    expect(narration).toMatchObject({ type: "object" });
    expect(Object.keys(propertiesOf(narration))).toContain("segments");
  });

  it("carries no unresolvable cross-file reference into a client", async () => {
    // The reason the schemas were withheld in the first place: they are written
    // with `$ref`s to sibling documents, and a client holding one schema has no
    // base URI to resolve `../narration.json` against. Bundling is what made
    // publishing them safe, so a surviving relative ref is the regression.
    const client = await connect(createStubBackend([]));

    const { tools } = await client.listTools();

    for (const tool of tools) {
      const refs = [...JSON.stringify(tool.inputSchema).matchAll(/"\$ref":"([^"]+)"/g)]
        .map((match) => match[1])
        .filter((ref) => ref !== undefined);
      expect(
        refs.filter((ref) => !ref.startsWith("#")),
        `${tool.name} has only internal refs`,
      ).toEqual([]);
    }
  });

  it("refuses narration passed as a string, naming the argument", async () => {
    const client = await connect(createStubBackend([]));

    const result = await client.callTool({
      name: "explainer_narrate",
      arguments: { slug: "demo", narration: JSON.stringify({ segments: [] }) },
    });

    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("narration");
  });

  it("accepts a well-formed narration object", async () => {
    const client = await connect(createStubBackend([]));

    const result = await client.callTool({
      name: "explainer_narrate",
      arguments: {
        slug: "demo",
        narration: { fps: 30, segments: [{ id: "one", text: "A sentence." }] },
      },
    });

    expect(result.isError).toBeFalsy();
  });
});
