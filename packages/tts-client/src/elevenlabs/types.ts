/**
 * Wire types for ElevenLabs' `POST /v1/text-to-speech/{voice_id}/with-timestamps`.
 *
 * As in `../types.ts`, a field that crosses the wire keeps the service's snake_case spelling
 * (`model_id`, `character_start_times_seconds`) so a reader can hold this file against the API
 * reference, and a name that stays on our side is camelCase.
 *
 * This is the one ElevenLabs endpoint the narration port uses, and it is used because it is the one
 * that answers with **character timings beside the audio**. Every timing and caption downstream is
 * built from measured spans, so a speech provider that cannot say when each word was spoken is not
 * one this product can narrate with — the plain `/v1/text-to-speech/{voice_id}` endpoint returns
 * audio alone and is deliberately not modelled here.
 */

import type { FetchLike } from "../types.js";

/**
 * When each character of the text was spoken, as three parallel arrays.
 *
 * This is the response's `alignment` — the characters of the text **as it was sent**, digits and
 * dashes included. The response also carries a `normalized_alignment`, timed over the text after
 * the service rewrote it (the recorded `eleven_multilingual_v2` response turns `—` into `--` and
 * pads both ends with a space), and this package never reads it: a caption must show the script,
 * not the service's reading of it.
 */
export type ElevenLabsAlignment = {
  readonly characters: readonly string[];
  readonly character_start_times_seconds: readonly number[];
  readonly character_end_times_seconds: readonly number[];
};

/**
 * One synthesis request, in this package's idiom.
 *
 * {@link ElevenLabsSpeechPayload} is the body it becomes; `voiceId` goes into the path instead.
 */
export type ElevenLabsSpeechRequest = {
  /** The text to speak, exactly as the captions should read it. */
  text: string;
  /** An ElevenLabs voice id. It is a path segment, so it is URL-encoded on the way out. */
  voiceId: string;
  /** An ElevenLabs model id, such as `eleven_multilingual_v2`. */
  modelId: string;
  /** Speaking rate. `1`, or absent, sends no `voice_settings` at all. */
  speed?: number;
};

/**
 * The exact JSON body posted to the with-timestamps endpoint.
 *
 * `voice_settings` is present only when a speed other than `1` was asked for. Sending it at `1`
 * would be harmless today, but `voice_settings` carries other fields whose server-side defaults
 * come from the voice itself, and a body that names only what was asked for cannot override them
 * by accident.
 */
export type ElevenLabsSpeechPayload = {
  readonly text: string;
  readonly model_id: string;
  readonly voice_settings?: { readonly speed: number };
};

/**
 * The parsed response, refused before it gets here unless both halves are present.
 *
 * `audio` stays base64 and stays **raw** signed 16-bit little-endian mono PCM at 24 kHz — the
 * `pcm_24000` output format has no header. Wrapping it as a WAV is the caller's job, because that
 * needs render-core's `encodeWav` and render-core already depends on this package.
 */
export type ElevenLabsSpeech = {
  /** Base64 raw PCM, straight from the response's `audio_base64`. */
  readonly audio: string;
  /** The response's `alignment`, present and non-empty. */
  readonly alignment: ElevenLabsAlignment;
};

/** Construction options for `ElevenLabsClient`. */
export type ElevenLabsClientOptions = {
  /** Sent as the `xi-api-key` header and never in any error message. */
  apiKey: string;
  /** Service base URL. Defaults to `https://api.elevenlabs.io`. */
  baseUrl?: string;
  /** Transport. Defaults to the platform `fetch`. */
  fetch?: FetchLike;
  /** How long one request may take, in milliseconds, before it fails as a timeout. */
  timeoutMs?: number;
};
