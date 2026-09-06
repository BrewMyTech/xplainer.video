/**
 * `@xplainer/render-core` — the Remotion workspace template, the scaffold
 * generator that writes one video's engine-owned shell and the agent's entry
 * point, the narration port that measures scene durations from real speech,
 * the render preflight, the pure argv builders for the Remotion CLI, and the
 * layout of the shared workspace all four of those write into.
 *
 * Nothing here renders, and nothing here decides a duration by hand. The
 * package holds the byte-fidelity guarantee that the wiring it writes is the
 * wiring the reference implementation writes, the ownership split that keeps
 * the narration audio and the caption track out of the agent's reach
 * (ADR 0018), and the narration port whose `timings.json` is the one place a
 * scene length comes from.
 *
 * The Remotion workspace template itself is not a JavaScript export: it is the
 * `template/` directory (`package.json`, `remotion.config.ts`, `tailwind.css`,
 * `tsconfig.json`), reachable through this package's `./template/*` export.
 */

export type {
  NarrateMode,
  NarrateOptions,
  NarrateResult,
  NarrationErrorCode,
  NarrationPlan,
  PcmFormat,
  PlannedSegment,
  PlannedWord,
  SegmentSpeech,
  SpeechEstimate,
  SpeechSynthesiser,
  WavAudio,
} from "./narrate/index.js";
export {
  buildCaptions,
  buildTimings,
  buildTrack,
  CAPTIONS_FILE,
  DEFAULT_FPS,
  DEFAULT_SAMPLE_RATE,
  DEFAULT_VOICE,
  decodeWav,
  encodeWav,
  estimateSpeech,
  GAP_MS,
  LEAD_IN_MS,
  NARRATION_AUDIO_FILE,
  NarrationError,
  narrate,
  pcmDurationMs,
  pcmFrameBytes,
  planSegments,
  reconcileFormat,
  samePcmFormat,
  silenceSamples,
  silentFrames,
  TAIL_MS,
  TIMINGS_FILE,
  writeCaptions,
  writeNarrationTrack,
  writeTimings,
} from "./narrate/index.js";
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
export type { VideoPaths, WorkspaceFile, WorkspaceResult } from "./workspace.js";
export {
  isWorkspaceInstalled,
  listVideoSlugs,
  MEDIA_DIR,
  materialiseWorkspace,
  NARRATION_SPEC_FILE,
  OUT_DIR,
  PUBLIC_DIR,
  RENDERED_FILE,
  remotionBinary,
  stillOutput,
  VIDEOS_DIR,
  videoPaths,
  WORKSPACE_FILES,
  workspaceNotInstalledMessage,
} from "./workspace.js";
