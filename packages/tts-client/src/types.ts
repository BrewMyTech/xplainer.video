/**
 * Wire types for the two Kokoro-FastAPI endpoints this package shapes
 * (plan §4 S2.3, deviation D-6).
 *
 * Everything here mirrors the reference implementation's `narrate.py`, the
 * only place the contract is currently written down. Field names that cross the
 * wire keep the server's snake_case spelling (`start_time`, `lang_code`) so a
 * reader can diff this file against the Python by eye; the names that stay on
 * our side of the boundary are camelCase like the rest of the workspace.
 *
 * This package synthesises nothing. It builds a request, parses a response, and
 * stops there: WAV concatenation, pacing, caption and timing derivation are
 * narration logic and land at roadmap phase 1.
 */

/**
 * A voice id, normalised to a plain string.
 *
 * `GET /v1/audio/voices` returns objects on current builds and bare strings on
 * older ones; {@link VoiceListEntry} is the raw shape and this is what callers
 * see after normalisation (`narrate.py:127-131`).
 */
export type Voice = string;

/** One entry as `/v1/audio/voices` actually returns it, in either build's shape. */
export type VoiceListEntry = string | { readonly id?: string; readonly name?: string };

/** The envelope `/v1/audio/voices` wraps its list in. */
export type VoiceListResponse = { readonly voices?: readonly VoiceListEntry[] };

/**
 * One synthesis request, in this package's idiom.
 *
 * {@link CaptionedSpeechPayload} is what it becomes on the wire; the mapping
 * (`text` → `input`, `langCode` → `lang_code`) is the whole job of
 * `buildCaptionedSpeechPayload`.
 */
export type CaptionedSpeechRequest = {
  /** The text to speak. Becomes the payload's `input` field. */
  text: string;
  /** A voice id, or a server-side blend such as `af_bella(2)+af_sky(1)`. */
  voice: Voice;
  /** Speaking rate, 0.25–4.0. Defaults to 1.0 (`narrate.py:193`). */
  speed?: number;
  /** Optional language override; inferred from the voice when omitted. */
  langCode?: string;
};

/**
 * The exact JSON body posted to `/dev/captioned_speech`
 * (`narrate.py:147-157`).
 *
 * `stream` and `return_timestamps` are literal types rather than `boolean` on
 * purpose: streaming returns raw audio instead of the JSON envelope that
 * carries the timestamps, so inverting either flag silently loses every word
 * timing (`narrate.py:153-154`). Typing them as literals makes that a compile
 * error, and `client.test.ts` asserts the emitted values as well.
 */
export type CaptionedSpeechPayload = {
  readonly model: "kokoro";
  readonly input: string;
  readonly voice: string;
  readonly response_format: "wav";
  readonly speed: number;
  readonly stream: false;
  readonly return_timestamps: true;
  readonly lang_code?: string;
};

/** One measured word span, exactly as the server reports it. */
export type WordTimestamp = {
  readonly word: string;
  readonly start_time: number;
  readonly end_time: number;
};

/**
 * The parsed `/dev/captioned_speech` envelope.
 *
 * `audio` is left base64-encoded. Decoding it is the first step of building an
 * audio track, which is narration work and out of scope for this phase.
 */
export type CaptionedSpeechResponse = {
  /** Base64 WAV, straight from the response body's `audio` field. */
  readonly audio: string;
  /** Word spans, empty when the server reports none (`narrate.py:170`). */
  readonly timestamps: readonly WordTimestamp[];
};

/** The subset of a `fetch` response this client reads. */
export type HttpResponseLike = {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
};

/** The request options this client passes; a subset of the platform `RequestInit`. */
export type HttpRequestInit = {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
};

/**
 * The injectable transport.
 *
 * Structural rather than `typeof fetch` so tests can supply a stub without
 * constructing a whole `Response`, and so the package does not depend on the
 * DOM lib. The platform `fetch` satisfies it.
 */
export type FetchLike = (url: string, init: HttpRequestInit) => Promise<HttpResponseLike>;
