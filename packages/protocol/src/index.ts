/**
 * The xplainer tool contract.
 *
 * `schemas/` is the source of truth; everything exported here is generated from
 * it by `scripts/codegen.mjs` and regenerated in the same breath as the pydantic
 * models, so the two languages cannot describe different contracts. Import the
 * types and `TOOL_NAMES` from this entry point rather than reaching into
 * `src/generated/`, which is rewritten wholesale on every run.
 */

export * from "./generated/manifest.js";
export * from "./generated/types.js";
