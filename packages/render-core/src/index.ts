/**
 * `@xplainer/render-core` — the Remotion workspace template, the scaffold
 * generator that writes one video's engine-owned shell and the agent's entry
 * point, the render preflight, and the pure argv builders for the Remotion CLI.
 *
 * Nothing here renders. The package holds the shapes that roadmap phase 1
 * executes against, the byte-fidelity guarantee that the wiring it writes is
 * the wiring the reference implementation writes, and the ownership split that
 * keeps the narration audio and the caption track out of the agent's reach
 * (ADR 0018).
 *
 * The Remotion workspace template itself is not a JavaScript export: it is the
 * `template/` directory (`package.json`, `remotion.config.ts`, `tailwind.css`,
 * `tsconfig.json`), reachable through this package's `./template/*` export.
 */

export type {
  PreflightCode,
  PreflightProblem,
  PreflightSeverity,
} from "./preflight.js";
export { assertRenderable, PreflightError, preflight } from "./preflight.js";
export type { RenderArgsInput, StillArgsInput } from "./render/args.js";
export {
  COMPOSITION_ID,
  DEFAULT_STILL_FRAME,
  DEFAULT_STILL_SCALE,
  entryPoint,
  REMOTION_BIN,
  renderArgs,
  stillArgs,
} from "./render/args.js";
export type {
  AgentOwnedFile,
  EngineOwnedFile,
  ScaffoldFile,
  ScaffoldResult,
} from "./scaffold/index.js";
export {
  AGENT_OWNED_FILES,
  ENGINE_OWNED_FILES,
  isEngineOwned,
  readScaffoldTemplate,
  SCAFFOLD_FILES,
  scaffoldVideo,
} from "./scaffold/index.js";
