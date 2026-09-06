/**
 * What `xplainer serve` actually serves.
 *
 * Every test binds the real server on an ephemeral port and talks to it over the
 * network, because AC-14c and AC-14d are about what a curl and an MCP client
 * see, not about what the app object contains. The tool list is compared against
 * `TOOL_NAMES` from `@xplainer/protocol` — never against `apps/api`'s Python
 * assertion and never against a list written here — so the two language surfaces
 * are pinned to the manifest instead of to each other (plan §5 R20).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ENGINE_OWNED_FILES, TOOL_NAMES } from "@xplainer/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createStubBackend } from "./backend.js";
import { NOT_IMPLEMENTED_MESSAGE } from "./not-implemented.js";
import { type RunningServer, startServer } from "./server.js";
import { CLI_VERSION } from "./version.js";

let running: RunningServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

/** Bind the server on a port the OS picks, so the tests never collide. */
async function serveOnEphemeralPort(): Promise<RunningServer> {
  running = await startServer({ backend: createStubBackend(), port: 0 });
  return running;
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
   * The ownership refusal is registered in `@xplainer/mcp-server`, not here, and
   * this test is what proves the local daemon inherits it rather than needing
   * its own copy (ADR 0018, layer 2).
   *
   * The stub backend rejects every tool with "not implemented in this phase", so
   * the assertion has teeth in both directions: an `ENGINE_OWNED_PATH` answer
   * can only mean the guard ran, and a not-implemented answer would mean the
   * call reached the backend — which is exactly the failure the guard exists to
   * prevent, since a real backend would have written the file by then.
   */
  it("refuses a /mcp write to an engine-owned file before the backend is reached", async () => {
    const server = await serveOnEphemeralPort();

    const client = new Client({ name: "xplainer-cli-test", version: CLI_VERSION });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));

    try {
      const result = await client.callTool({
        name: "explainer_put_source",
        arguments: {
          slug: "demo",
          files: [{ path: "Video.tsx", content: "// the shell an agent must not own" }],
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
      expect(JSON.stringify(result.content)).not.toContain(NOT_IMPLEMENTED_MESSAGE);
    } finally {
      await client.close();
    }
  });

  it("serves a /mcp tools/list equal to the protocol manifest", async () => {
    const server = await serveOnEphemeralPort();

    const client = new Client({ name: "xplainer-cli-test", version: CLI_VERSION });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));

    try {
      const { tools } = await client.listTools();
      const served = tools.map((tool) => tool.name).sort();

      expect(served).toEqual([...TOOL_NAMES].sort());
    } finally {
      await client.close();
    }
  });
});
