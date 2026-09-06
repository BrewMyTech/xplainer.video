/**
 * The backend the scaffold serves its tools from.
 *
 * `createMcpServer()` needs a `RenderBackend` to register the eight tools
 * against, and this phase has no renderer, no TTS and no job store (spec
 * §Non-Goals). Rather than register a reduced tool set — which would make
 * `tools/list` disagree with the protocol manifest and break AC-14d — every
 * tool is registered and every implementation reports that it is deferred.
 *
 * Failure is reported by rejecting, which is the contract `RenderBackend`
 * documents: `createMcpServer()` lets the MCP SDK turn the rejection into a
 * tool result with `isError` set and the message as its text. That is a real
 * protocol answer, not a silent no-op, and it carries the same wording as the
 * deferred CLI commands.
 */

import type { RenderBackend } from "@xplainer/mcp-server";
import type { ToolName } from "@xplainer/protocol";
import { NOT_IMPLEMENTED_MESSAGE } from "./not-implemented.js";

function deferred<T>(tool: ToolName): Promise<T> {
  return Promise.reject(new Error(`${tool}: ${NOT_IMPLEMENTED_MESSAGE}`));
}

/**
 * A `RenderBackend` that implements all eight tools by reporting that the work
 * lands in a later phase.
 */
export function createStubBackend(): RenderBackend {
  return {
    explainer_create: () => deferred("explainer_create"),
    explainer_put_source: () => deferred("explainer_put_source"),
    explainer_put_media: () => deferred("explainer_put_media"),
    explainer_narrate: () => deferred("explainer_narrate"),
    explainer_still: () => deferred("explainer_still"),
    explainer_render: () => deferred("explainer_render"),
    explainer_job: () => deferred("explainer_job"),
    explainer_list: () => deferred("explainer_list"),
  };
}
