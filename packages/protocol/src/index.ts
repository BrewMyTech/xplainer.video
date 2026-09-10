/**
 * The xplainer tool contract.
 *
 * `schemas/` is the source of truth; everything exported here is generated from
 * it by `scripts/codegen.mjs` and regenerated in the same breath as the pydantic
 * models, so the two languages cannot describe different contracts. Import the
 * types and `TOOL_NAMES` from this entry point rather than reaching into
 * `src/generated/`, which is rewritten wholesale on every run.
 *
 * The lists below are written out rather than starred through, so this file is
 * a literal inventory of the contract: a grep for any exported name lands on the
 * entry point that publishes it. A schema that adds or removes a type is not
 * exported until it is added here.
 */

export { isContractCompatible } from "./contract-version.js";
export type { EngineOwnedFile, ToolName } from "./generated/manifest.js";
export { ENGINE_OWNED_FILES, MCP_CONTRACT_VERSION, TOOL_NAMES } from "./generated/manifest.js";
export { JOB_ERROR_CODE_VALUES, toJobErrorCode } from "./generated/open-enums.js";
export type {
  Caption,
  Captions,
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
  JobErrorCode,
  JobOutput,
  JobState,
  JobType,
  Narration,
  NarrationSegment,
  Slug,
  SourceFile,
  Timings,
  TimingsSegment,
  Toolchain,
  ToolchainComponent,
  ToolchainFile,
  ToolchainWorkspace,
  VideoSummary,
} from "./generated/types.js";
