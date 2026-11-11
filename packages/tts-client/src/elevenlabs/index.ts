/**
 * The ElevenLabs half of `@xplainer/tts-client`: one endpoint, shaped.
 *
 * `client.ts` sends the request and refuses an unusable answer; `alignment.ts` turns the answer's
 * character timings into the `WordTimestamp[]` the Kokoro routes already produce. Audio handling,
 * retries and the choice of provider live in the CLI, which is the only caller.
 */

export { alignmentToWordTimestamps } from "./alignment.js";
export {
  buildElevenLabsSpeechPayload,
  ELEVENLABS_DEFAULT_BASE_URL,
  ELEVENLABS_OUTPUT_FORMAT,
  ELEVENLABS_REQUEST_TIMEOUT_MS,
  ELEVENLABS_SAMPLE_RATE,
  ElevenLabsClient,
  ElevenLabsError,
  timestampedSpeechPath,
} from "./client.js";
export type {
  ElevenLabsAlignment,
  ElevenLabsClientOptions,
  ElevenLabsSpeech,
  ElevenLabsSpeechPayload,
  ElevenLabsSpeechRequest,
} from "./types.js";
