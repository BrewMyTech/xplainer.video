/**
 * `@xplainer/tts-client` — Kokoro-FastAPI request/response shaping.
 *
 * See `./client.ts` for what this package deliberately does not do.
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
} from "./client";
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
} from "./types";
