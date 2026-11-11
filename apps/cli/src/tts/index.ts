/**
 * `src/tts/` — the speech **provider** level, above the Kokoro routes `workers/speech.ts` chooses
 * between.
 *
 * A provider is who speaks: the built-in Kokoro voice (by whichever of its three routes), or a
 * remote service the machine's owner opted into and pays for. It is admitted only if it returns
 * word or character timestamps with its audio, because `timings.json` and `captions.json` are
 * built from measured spans (ADR 0030). Internal to this package and not re-exported from
 * `src/index.ts`, like `src/speech/`.
 *
 * | Module | What it owns |
 * |---|---|
 * | `provider.ts` | The registry, the admissibility rule and its two enforcement points, the named error |
 * | `resolve.ts` | Which provider, voice, model and key origin this machine uses — no secret, so `status` can ask too |
 * | `elevenlabs.ts` | The ElevenLabs adapter behind render-core's port: voice and speed rules, retries, the checks on the answer |
 */

export type { ElevenLabsSynthesiserOptions } from "./elevenlabs.js";
export {
  createElevenLabsSynthesiser,
  ELEVENLABS_MAX_RETRIES,
  ELEVENLABS_MAX_SPEED,
  ELEVENLABS_MIN_SPEED,
  ELEVENLABS_RETRY_DELAYS_MS,
} from "./elevenlabs.js";
export type {
  TimestampGranularity,
  TtsProviderDescriptor,
  TtsProviderErrorCode,
  TtsProviderId,
} from "./provider.js";
export {
  admitProvider,
  DEFAULT_TTS_PROVIDER,
  isTtsProviderId,
  PROVIDER_ADMISSIBILITY_RULE,
  parseProviderId,
  requireWordSpans,
  TTS_PROVIDER_IDS,
  TTS_PROVIDERS,
  TtsProviderError,
  unknownProviderProblem,
} from "./provider.js";
export type { ApiKeyOrigin, SettingOrigin, TtsEnvironment, TtsSelection } from "./resolve.js";
export {
  ELEVENLABS_API_KEY_ENV,
  ELEVENLABS_DEFAULT_MODEL,
  ELEVENLABS_DEFAULT_VOICE,
  ELEVENLABS_VERIFIED_MODELS,
  ELEVENLABS_VOICE_ID,
  readElevenLabsApiKey,
  resolveTtsSelection,
  TTS_PROVIDER_ENV,
} from "./resolve.js";
