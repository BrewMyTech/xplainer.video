/**
 * `@xplainer/render-core` — the workspace template, the scaffold generator that writes one video's
 * engine-owned shell and the agent's entry point, the narration port that measures scene durations
 * from real speech, the render preflight, and the layout of the shared workspace all of those
 * write into.
 *
 * Nothing here renders, and nothing here decides a duration by hand. The renderer is
 * `@xplainer/cli`'s: it bundles the files this package scaffolds against `@xplainer/motion` and
 * drives Chrome itself. This package holds the ownership split that keeps the narration audio and
 * the caption track out of the agent's reach (ADR 0018), and the narration port whose
 * `timings.json` is the one place a scene length comes from.
 *
 * The workspace template itself is not a JavaScript export: it is the `template/` directory
 * (`package.json`, `package-lock.json`, `tailwind.css`, `tsconfig.json`), reachable through this
 * package's `./template/*` export.
 *
 * `src/g2p/` is the grapheme-to-phoneme port that feeds an in-process
 * synthesiser: English text to Kokoro's IPA and per-word spans, through four
 * layers ending in a named refusal rather than in silence.
 */

export type {
  DerivedPronunciation,
  ExtraLexicon,
  G2pErrorCode,
  LexiconProblem,
  ParsedLexicon,
  PhonemeSource,
  Phonemisation,
  PhonemiseOptions,
  WordSpan,
} from "./g2p/index.js";
export {
  G2pError,
  kokoroTokenIds,
  kokoroVocabulary,
  parseLexicon,
  phonemise,
  unsupportedSymbols,
} from "./g2p/index.js";
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
  DEFAULT_STILL_FRAME,
  DEFAULT_STILL_SCALE,
  listVideoSlugs,
  MEDIA_DIR,
  materialiseWorkspace,
  NARRATION_SPEC_FILE,
  OUT_DIR,
  PUBLIC_DIR,
  RENDERED_FILE,
  stillOutput,
  VIDEOS_DIR,
  videoPaths,
  WORKSPACE_FILES,
} from "./workspace.js";
