/**
 * The narration port: measured speech in, `narration.wav`, `captions.json` and
 * `timings.json` out (roadmap P1-2 and P1-6, docs/ROADMAP.md).
 *
 * A port of the reference implementation's `narrate.py`, split so that the part
 * that decides *when* things happen is pure and the part that talks to a server
 * is thin:
 *
 * | Module | What it owns |
 * | --- | --- |
 * | `pacing.ts` | The three silence constants and the defaults around them |
 * | `wav.ts` | RIFF/WAVE 16-bit PCM in and out, and sample-exact silence |
 * | `estimate.ts` | The dry run's stand-in for a speech server |
 * | `plan.ts` | Every offset: segment starts, ends, frames, absolute word spans |
 * | `captions.ts` | `captions.json` from a plan |
 * | `timings.ts` | `timings.json` from a plan |
 * | `track.ts` | One continuous WAV, padded by the plan's own sample counts |
 * | `write.ts` | The three files on disk |
 * | `build.ts` | `narrate()`: the run, in that order |
 *
 * The names are re-exported one by one rather than starred through, so this
 * file is a literal inventory and `noReExportAll` stays satisfied.
 */

export type { NarrateMode, NarrateOptions, NarrateResult, SpeechSynthesiser } from "./build.js";
export { narrate } from "./build.js";
export { buildCaptions } from "./captions.js";
export type { NarrationErrorCode } from "./errors.js";
export { NarrationError } from "./errors.js";
export type { SpeechEstimate } from "./estimate.js";
export { estimateSpeech } from "./estimate.js";
export {
  CAPTIONS_FILE,
  DEFAULT_FPS,
  DEFAULT_SAMPLE_RATE,
  DEFAULT_VOICE,
  GAP_MS,
  LEAD_IN_MS,
  NARRATION_AUDIO_FILE,
  TAIL_MS,
  TIMINGS_FILE,
} from "./pacing.js";
export type { NarrationPlan, PlannedSegment, PlannedWord, SegmentSpeech } from "./plan.js";
export { planSegments } from "./plan.js";
export { buildTimings } from "./timings.js";
export { buildTrack, reconcileFormat } from "./track.js";
export type { PcmFormat, WavAudio } from "./wav.js";
export {
  decodeWav,
  encodeWav,
  pcmDurationMs,
  pcmFrameBytes,
  samePcmFormat,
  silenceSamples,
  silentFrames,
} from "./wav.js";
export { writeCaptions, writeNarrationTrack, writeTimings } from "./write.js";
