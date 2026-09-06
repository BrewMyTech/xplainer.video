/**
 * The seam between the tool contract and whatever actually does the work
 * (plan §2 P2, §4 S2.4).
 *
 * `RenderBackend` is the only thing `createMcpServer()` knows about. The CLI
 * daemon backs it with the local Remotion workspace, the hosted media-service
 * backs it with object storage and a job queue, and a test backs it with an
 * in-memory stub — none of which the registration in `server.ts` can tell
 * apart. That is the point: spec §Constraints/Contract requires local and
 * hosted to expose identical tool names and schemas, and the cheapest way to
 * keep that promise is to give them one registration and let them differ only
 * below this interface.
 *
 * Every method is named after the protocol tool it serves, so `server.ts` can
 * dispatch by tool name and TypeScript checks the mapping: drop a method and
 * `backend[name]` stops compiling. The argument and result types are the
 * generated ones from `@xplainer/protocol`, so the schemas are the single
 * source of truth for this interface too.
 */

import type {
  ExplainerCreateInput,
  ExplainerCreateOutput,
  ExplainerJobInput,
  ExplainerJobOutput,
  ExplainerListInput,
  ExplainerListOutput,
  ExplainerNarrateInput,
  ExplainerNarrateOutput,
  ExplainerPutMediaInput,
  ExplainerPutMediaOutput,
  ExplainerPutSourceInput,
  ExplainerPutSourceOutput,
  ExplainerRenderInput,
  ExplainerRenderOutput,
  ExplainerStillInput,
  ExplainerStillOutput,
} from "@xplainer/protocol";

/**
 * One implementation of the eight explainer tools.
 *
 * Implementations report failure by rejecting. `createMcpServer()` turns a
 * rejection into an MCP tool error carrying the message, so an implementation
 * never has to build a protocol-level result itself.
 */
export interface RenderBackend {
  /** Create a video and scaffold its wiring. Never overwrites. */
  explainer_create(input: ExplainerCreateInput): Promise<ExplainerCreateOutput>;

  /**
   * Write agent-authored Remotion source files into an existing video.
   *
   * An implementation never sees a write to an engine-owned file through
   * `createMcpServer()`: `assertAgentOwnedPaths` refuses the whole call before
   * this method is reached, so nothing is written and the agent gets the
   * `ENGINE_OWNED_PATH` tool error (ADR 0018). An implementation that can also
   * be reached without the MCP registration — a CLI subcommand, an internal HTTP
   * route — re-checks with the same function at the disk boundary, because the
   * guard above that route is not the guard above this one.
   */
  explainer_put_source(input: ExplainerPutSourceInput): Promise<ExplainerPutSourceOutput>;

  /** Upload one media asset into a video's media directory. */
  explainer_put_media(input: ExplainerPutMediaInput): Promise<ExplainerPutMediaOutput>;

  /** Queue voiceover, captions and segment timings. */
  explainer_narrate(input: ExplainerNarrateInput): Promise<ExplainerNarrateOutput>;

  /** Queue a single-frame render for a layout check. */
  explainer_still(input: ExplainerStillInput): Promise<ExplainerStillOutput>;

  /** Queue a full render to MP4. */
  explainer_render(input: ExplainerRenderInput): Promise<ExplainerRenderOutput>;

  /** Report the status and recent output of a queued job. */
  explainer_job(input: ExplainerJobInput): Promise<ExplainerJobOutput>;

  /** List the caller's videos and what each one has so far. */
  explainer_list(input: ExplainerListInput): Promise<ExplainerListOutput>;
}

/**
 * The tool names `RenderBackend` implements.
 *
 * Kept as a named type so a caller can state the relationship it depends on —
 * `server.test.ts` asserts at runtime that this set is exactly `TOOL_NAMES`,
 * which is what stops a method being added here without a schema behind it.
 */
export type RenderBackendMethod = keyof RenderBackend;
