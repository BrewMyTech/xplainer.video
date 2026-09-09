/**
 * The one place the eight explainer tools are registered (plan §5 R20,
 * §4 S2.4).
 *
 * Three surfaces serve this contract: the CLI's Streamable HTTP `/mcp`
 * (`apps/cli`), the CLI's stdio transport, and the hosted media-service image,
 * which imports the CLI's server core rather than building its own. All three
 * get their tool list from `createMcpServer()` below, so a tool cannot be
 * gained, lost or renamed on one surface and not the others. The registration
 * loop iterates `TOOL_NAMES` from `@xplainer/protocol` rather than a list
 * written here, so adding a ninth tool to the schemas adds it to every
 * TypeScript surface at once — and, because every name must resolve to both a
 * manifest entry and a `RenderBackend` method, adding one without an
 * implementation fails loudly instead of silently serving nothing.
 *
 * The fourth surface, the hosted API (relocated to a private repository,
 * ADR 0023), is Python and cannot share this code. It is pinned by assertion
 * instead: its pytest and this package's Vitest both compare against
 * `packages/protocol`'s manifest, never against each other.
 *
 * Registration is also where the rules that must hold on every surface live:
 * {@link PRE_DISPATCH_GUARDS} runs before the backend is reached, which is what
 * makes `explainer_put_source`'s refusal of engine-owned files a property of the
 * protocol rather than of whichever backend happens to be serving it.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  MCP_CONTRACT_VERSION as CONTRACT_VERSION,
  TOOL_NAMES,
  type ToolName,
} from "@xplainer/protocol";
import manifest from "@xplainer/protocol/schemas/manifest.json" with { type: "json" };
import { z } from "zod";
import type { RenderBackend } from "./backend.js";
import { assertAgentOwnedPaths, EngineOwnedPathError } from "./put-source-guard.js";

/** Server name reported in the MCP `initialize` handshake. */
export const MCP_SERVER_NAME: string = manifest.name;

/**
 * Version reported in the handshake when the caller does not supply one.
 *
 * This is the contract version, not a release number: a process that has its own
 * version — the CLI, the media-service — passes it through
 * {@link CreateMcpServerOptions}.
 *
 * It is **re-exported from `@xplainer/protocol`**, where it moved when spike
 * P1-S3 settled (ADR 0025 §Note, 2026-09-06). The name stays here because every
 * caller already imports it from this package, but the value now comes from the
 * package that owns the contract — which is what lets the
 * `xplainer mcp --attach` shim read it without depending on the MCP server, and
 * before any MCP session exists.
 */
export const MCP_CONTRACT_VERSION: string = CONTRACT_VERSION;

/** Optional identity overrides for the MCP `initialize` handshake. */
export type CreateMcpServerOptions = {
  /** Server name. Defaults to {@link MCP_SERVER_NAME}. */
  name?: string;
  /** Server version. Defaults to {@link MCP_CONTRACT_VERSION}. */
  version?: string;
};

/** What the manifest tells the registration about one tool. */
type ManifestEntry = {
  name: string;
  title: string;
  description: string;
};

const MANIFEST_ENTRIES: ReadonlyMap<string, ManifestEntry> = new Map(
  manifest.tools.map((tool) => [tool.name, tool]),
);

/**
 * Input schema published for every tool in this phase.
 *
 * The per-tool JSON Schemas in `packages/protocol/schemas/tools/` are the real
 * contract, but they are written with `$ref`s to sibling documents
 * (`../slug.json`, `../narration.json`, `../job-state.json`) which an MCP
 * client receiving a single inlined schema could not resolve. Publishing them
 * verbatim would hand clients broken references, so this phase publishes an
 * open object instead and lets the backend see the arguments unmodified.
 * Dereferencing the schemas into self-contained documents is roadmap phase 1
 * work; until then `tools/list` carries the eight names, titles and
 * descriptions, which is what AC-8 and AC-14d assert against.
 *
 * It must be an open object, not `z.object({})`: a strict object would strip
 * every key on the way through and the backend would be handed `{}`.
 */
const OPEN_TOOL_INPUT = z.looseObject({});

/**
 * A tool method with its argument and result types erased.
 *
 * MCP arguments arrive as unvalidated JSON, and the loop below dispatches over
 * a union of eight differently-typed methods, so the call is made through this
 * erased signature. The type safety that matters is upstream and survives:
 * `backend[name]` still requires `RenderBackend` to declare a method for every
 * name in `TOOL_NAMES`.
 */
type ErasedToolHandler = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;

/**
 * Checks that run at the tool boundary, before the backend is reached.
 *
 * Registered here rather than inside each backend on purpose (ADR 0018, layer
 * 2): the CLI's stdio surface, the CLI's Streamable HTTP surface and the hosted
 * media-service all share this one registration, so a rule added here is a rule
 * on every surface at once and a future backend cannot forget it. A guard
 * refuses by throwing; {@link engineOwnedPathResult} turns the one error class
 * this phase defines into a structured tool error, and anything else propagates
 * to the SDK as an ordinary failure.
 *
 * Deliberately partial: a tool with no entry is dispatched untouched.
 */
const PRE_DISPATCH_GUARDS: Partial<Record<ToolName, (input: Record<string, unknown>) => void>> = {
  explainer_put_source: assertAgentOwnedPaths,
};

/**
 * The refusal an agent receives when it tries to write an engine-owned file.
 *
 * An MCP *tool* error (`isError: true`) rather than a JSON-RPC protocol error,
 * because a tool error is delivered to the model as content it reads and can act
 * on, while a protocol error is the client's problem and the model may never see
 * the message. `written: []` echoes the success shape's field so a client that
 * reads `structuredContent.written` without branching on `isError` sees zero
 * files written rather than an absent key.
 */
function engineOwnedPathResult(error: EngineOwnedPathError): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: error.message }],
    structuredContent: {
      error: {
        code: error.code,
        message: error.message,
        rejected: [...error.rejected],
        engine_owned: [...error.engineOwned],
      },
      written: [],
    },
  };
}

function manifestEntry(name: ToolName): ManifestEntry {
  const entry = MANIFEST_ENTRIES.get(name);
  if (entry === undefined) {
    throw new Error(
      `@xplainer/protocol lists "${name}" in TOOL_NAMES but schemas/manifest.json has no entry for it. Regenerate the protocol bindings.`,
    );
  }
  return entry;
}

/**
 * Build an MCP server that serves the eight explainer tools out of `backend`.
 *
 * The returned server is not connected to anything: the caller attaches the
 * transport it needs (Streamable HTTP in `apps/cli serve`, stdio in the CLI's
 * `mcp` command, an in-memory pair in tests).
 */
export function createMcpServer(
  backend: RenderBackend,
  options: CreateMcpServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: options.name ?? MCP_SERVER_NAME,
    version: options.version ?? MCP_CONTRACT_VERSION,
  });

  for (const name of TOOL_NAMES) {
    const { title, description } = manifestEntry(name);
    const handler = backend[name] as unknown as ErasedToolHandler;

    server.registerTool(
      name,
      { title, description, inputSchema: OPEN_TOOL_INPUT },
      async (args): Promise<CallToolResult> => {
        try {
          PRE_DISPATCH_GUARDS[name]?.(args);
          const result = await handler(args);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (error) {
          // Only the ownership refusal gets a structured answer. Everything else
          // — including a backend rejecting because the work is deferred or the
          // renderer is down — is rethrown, so the SDK reports it exactly as it
          // did before this guard existed.
          if (error instanceof EngineOwnedPathError) {
            return engineOwnedPathResult(error);
          }
          throw error;
        }
      },
    );
  }

  return server;
}
