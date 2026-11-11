/**
 * `@xplainer/tts-client` — request/response shaping for the speech services narration talks to:
 * Kokoro-FastAPI, and ElevenLabs' with-timestamps endpoint.
 *
 * See `./client.ts` and `./elevenlabs/client.ts` for what this package deliberately does not do.
 */

export {
  BASE_URL_ENV_VAR,
  buildCaptionedSpeechPayload,
  CAPTIONED_SPEECH_PATH,
  DEFAULT_BASE_URL,
  DEFAULT_SPEED,
  KokoroClient,
  type KokoroClientOptions,
  KokoroError,
  normaliseVoiceList,
  resolveBaseUrl,
  VOICES_PATH,
} from "./client.js";
export {
  alignmentToWordTimestamps,
  buildElevenLabsSpeechPayload,
  ELEVENLABS_DEFAULT_BASE_URL,
  ELEVENLABS_OUTPUT_FORMAT,
  ELEVENLABS_REQUEST_TIMEOUT_MS,
  ELEVENLABS_SAMPLE_RATE,
  type ElevenLabsAlignment,
  ElevenLabsClient,
  type ElevenLabsClientOptions,
  ElevenLabsError,
  type ElevenLabsSpeech,
  type ElevenLabsSpeechPayload,
  type ElevenLabsSpeechRequest,
  timestampedSpeechPath,
} from "./elevenlabs/index.js";
export type {
  CaptionedSpeechPayload,
  CaptionedSpeechRequest,
  CaptionedSpeechResponse,
  FetchLike,
  HttpRequestInit,
  HttpResponseLike,
  Voice,
  VoiceListEntry,
  VoiceListResponse,
  WordTimestamp,
} from "./types.js";
