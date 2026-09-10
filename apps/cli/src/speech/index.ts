/**
 * `src/speech/` — speech synthesised in this process: no server, no container, no Python and no
 * GPL component anywhere in what is shipped or fetched
 * (`.omc/plans/ralplan-speech-onnx.md`).
 *
 * The whole directory serves one export, {@link createOnnxSynthesiser}, which is the third
 * implementation of the `SpeechSynthesiser` port `resolveSpeech()` returns. It is internal to this
 * package and deliberately not re-exported from `src/index.ts`: like `src/daemon/`, it is the local
 * runtime's own machinery, and the boundary is a compile-time fact rather than a convention.
 *
 * | Module | What it owns |
 * |---|---|
 * | `synthesiser.ts` | The port implementation: text → phonemes → tokens → audio and word spans |
 * | `timing.ts` | Plan D6 — the duration→seconds conversion, derived per run, and its refusals |
 * | `tokens.ts` | IPA → token ids with the offset each came from, and the affricate decision |
 * | `voice.ts` | The voice pack, and which of its 510 style rows speaks a given sentence |
 * | `runtime.ts` | The ONNX Runtime as an acquired path (plan D7), and the four members used |
 * | `locate.ts` | Where the three artefacts are, as a seam `setup`'s marker reader can fill |
 * | `errors.ts` | `OnnxSpeechError`: a refusal instead of audio nobody can tell is wrong |
 */

export type { OnnxSpeechErrorCode } from "./errors.js";
export { OnnxSpeechError } from "./errors.js";
export type { OnnxSpeechLocator, OnnxSpeechPaths } from "./locate.js";
export {
  ONNX_MODEL_ENV,
  ONNX_RUNTIME_ENV,
  ONNX_VOICE_ENV,
  ONNX_VOICE_NAME_ENV,
  onnxSpeechFromEnvironment,
  voiceFromPackPath,
} from "./locate.js";
export type {
  OnnxFeeds,
  OnnxInferenceSession,
  OnnxRuntimeModule,
  OnnxTensor,
} from "./runtime.js";
export { assertRuntime, loadOnnxRuntime } from "./runtime.js";
export type { OnnxSynthesiserOptions } from "./synthesiser.js";
export { createOnnxSynthesiser } from "./synthesiser.js";
export type { DerivedTiming, TimingInput } from "./timing.js";
export { deriveWordTimings } from "./timing.js";
export type { TokenisedPhonemes } from "./tokens.js";
export { PAD_TOKEN, tokenisePhonemes, tokenRange } from "./tokens.js";
export type { VoicePack } from "./voice.js";
export { readVoicePack, STYLE_DIMENSION, styleRow } from "./voice.js";
