/**
 * An ElevenLabs client for the one endpoint narration uses:
 * `POST /v1/text-to-speech/{voice_id}/with-timestamps` — audio and character timings in one answer.
 *
 * This is wire shaping, the same job `../client.ts` does for Kokoro, and it stops at the same
 * place. It builds the body, sends **one** request, and hands back the base64 audio and the
 * `alignment` exactly as the service returned them, or an {@link ElevenLabsError} that says why
 * not. It does not decode or wrap the audio, does not convert the alignment (that is
 * `alignmentToWordTimestamps`, a pure function beside this one), does not read the environment
 * and does not retry.
 *
 * **Why no retry here.** Whether a failure is worth repeating depends on who is paying for the
 * repeat. The service bills per character, and a request that timed out on our side may well have
 * finished — and been billed — on theirs, so the decision to send it again belongs to the caller
 * that owns the job, the log and the account (`apps/cli/src/tts/`). This client only says which
 * failures are the service asking to be asked again: {@link ElevenLabsError.retryable}.
 *
 * **The API key.** It is sent as the `xi-api-key` header and appears nowhere else. Every message
 * this client composes from something it did not write — an error body, a transport error — has the
 * key replaced with `[redacted]` before it is truncated, so neither a service that echoes a key
 * back nor a cut that lands mid-key can put one into a job log.
 */

import type { FetchLike, HttpRequestInit } from "../types.js";
import type {
  ElevenLabsAlignment,
  ElevenLabsClientOptions,
  ElevenLabsSpeech,
  ElevenLabsSpeechPayload,
  ElevenLabsSpeechRequest,
} from "./types.js";

/** Where the ElevenLabs API is served. */
export const ELEVENLABS_DEFAULT_BASE_URL = "https://api.elevenlabs.io";

/**
 * The output format every request asks for: raw signed 16-bit mono PCM at 24 kHz.
 *
 * Fixed rather than configurable. It is the format the Kokoro routes already produce, so nothing
 * below the narration port sees a new sample rate; it is available on every tier, where 44.1 kHz
 * PCM needs Pro; and it has no header to trust, where `wav_24000` would hand us one we have not
 * seen.
 */
export const ELEVENLABS_OUTPUT_FORMAT = "pcm_24000";

/** The sample rate {@link ELEVENLABS_OUTPUT_FORMAT} implies, in hertz. */
export const ELEVENLABS_SAMPLE_RATE = 24000;

/**
 * How long one request may take before it fails as `timeout`, in milliseconds.
 *
 * Generous on purpose: a long segment on a busy account is tens of seconds, and a timeout that
 * fires while the service is still speaking costs a request that was probably billed anyway.
 */
export const ELEVENLABS_REQUEST_TIMEOUT_MS = 120_000;

/** How much of a failing response's message is quoted in an error, as in `../client.ts`. */
const ERROR_BODY_LIMIT = 400;

/** What a key is replaced with in every message this client composes. */
const REDACTED = "[redacted]";

/**
 * The path, query included, of the with-timestamps endpoint for one voice.
 *
 * The voice id is URL-encoded because it is a path segment: a caller that passed something other
 * than a plain id gets a `404` naming it, not a request to some other endpoint.
 */
export function timestampedSpeechPath(voiceId: string): string {
  return `/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=${ELEVENLABS_OUTPUT_FORMAT}`;
}

/**
 * Build the exact JSON body posted to the with-timestamps endpoint.
 *
 * `voice_settings` is sent only for a speed other than `1`. Nothing else is sent: not
 * `language_code` (the default model refuses it), not `previous_text`/`next_text` (each segment is
 * an independent utterance with silence around it), and not a seed or a pronunciation dictionary.
 * A field goes in when the narration port has a use for it, and not before.
 */
export function buildElevenLabsSpeechPayload(
  request: ElevenLabsSpeechRequest,
): ElevenLabsSpeechPayload {
  const payload: ElevenLabsSpeechPayload = { text: request.text, model_id: request.modelId };
  return request.speed === undefined || request.speed === 1
    ? payload
    : { ...payload, voice_settings: { speed: request.speed } };
}

/**
 * An ElevenLabs request that failed, or that answered with something narration cannot use.
 *
 * `code` is what a caller branches on:
 *
 *   * for an HTTP failure, the service's own code. Its error body is
 *     `{"detail": {"type", "code", "status", "message", "request_id"}}`, and the two fields do not
 *     mean what the documentation suggests: a `401` arrives as `code: "unauthorized"`,
 *     `status: "invalid_api_key"`, and a bad model as `status: "model_not_found"` with no `code` at
 *     all. So `code` here is `detail.status` when that is a string, and `detail.code` otherwise —
 *     the specific reason first, the category only when there is nothing more specific;
 *   * `"alignment_missing"`, `"alignment_invalid"`, `"audio_missing"` or `"response_invalid"` for
 *     a `2xx` whose body is not usable;
 *   * `"timeout"` when no answer came within the client's timeout, and `"network"` when the request
 *     could not be sent or the answer could not be read.
 *
 * `retryable` is derived from the status and nothing else: it is `true` for `429` and `5xx`, the
 * failures the service itself reports as "not now", and `false` for everything else — including a
 * timeout and a transport failure. Those two can follow a request the service completed and
 * billed, so repeating one is not a decision this flag makes on anyone's behalf.
 */
export class ElevenLabsError extends Error {
  /** HTTP status, or `undefined` for a shape, timeout or transport failure. */
  readonly status: number | undefined;
  /** The service's `detail.status` or `detail.code`, or this client's own code; see the class. */
  readonly code: string | undefined;
  /** `true` exactly when `status` is `429` or `5xx`. */
  readonly retryable: boolean;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "ElevenLabsError";
    this.status = status;
    this.code = code;
    this.retryable = status === 429 || (status !== undefined && status >= 500 && status <= 599);
  }
}

const platformFetch: FetchLike = (url, init) => fetch(url, init);

/**
 * A client for `POST /v1/text-to-speech/{voice_id}/with-timestamps`.
 *
 * The key, the base URL, the transport and the timeout are all given to it, so it reads no
 * environment and a test can drive every path through a stub `fetch`.
 */
export class ElevenLabsClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: ElevenLabsClientOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? ELEVENLABS_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? platformFetch;
    this.#timeoutMs = options.timeoutMs ?? ELEVENLABS_REQUEST_TIMEOUT_MS;
  }

  /**
   * Speak one segment and return its raw PCM with the character alignment of the text as sent.
   *
   * One attempt. A response is refused unless it carries non-empty `audio_base64` and a non-empty
   * `alignment`; `normalized_alignment` is never read, so a response that has only that one fails
   * as `alignment_missing` rather than being timed over text the script does not contain.
   */
  async timestampedSpeech(request: ElevenLabsSpeechRequest): Promise<ElevenLabsSpeech> {
    const path = timestampedSpeechPath(request.voiceId);
    const body = await this.#post(path, buildElevenLabsSpeechPayload(request));
    return readSpeech(body, path);
  }

  /** Send the request and parse a `2xx` body, turning every other outcome into an error. */
  async #post(path: string, payload: ElevenLabsSpeechPayload): Promise<unknown> {
    const init: HttpRequestInit = {
      method: "POST",
      headers: {
        "xi-api-key": this.#apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.#timeoutMs),
      redirect: "error",
    };

    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, init);
      if (!response.ok) {
        throw this.#rejection(path, response.status, await response.text());
      }
      return await response.json();
    } catch (error) {
      throw this.#failure(path, error);
    }
  }

  /** The error for a non-`2xx` answer, carrying the service's own code when its body has one. */
  #rejection(path: string, status: number, text: string): ElevenLabsError {
    const detail = readErrorDetail(text);
    const said = detail.message === "" ? "no error body" : this.#quote(detail.message);
    // The code is the service's text too, so it is redacted and bounded like the message is.
    const code = detail.code === undefined ? undefined : this.#quote(detail.code);
    const label = code === undefined ? `${status}` : `${status} ${code}`;
    return new ElevenLabsError(`elevenlabs rejected ${path} (${label}): ${said}`, status, code);
  }

  /** Classify whatever was thrown while sending or reading, passing our own errors through. */
  #failure(path: string, error: unknown): ElevenLabsError {
    if (error instanceof ElevenLabsError) {
      return error;
    }
    if (nameOf(error) === "TimeoutError") {
      return new ElevenLabsError(
        `elevenlabs did not answer ${path} within ${this.#timeoutMs} ms (timeout). The service may have finished, and billed, the request anyway.`,
        undefined,
        "timeout",
      );
    }
    if (error instanceof SyntaxError) {
      return new ElevenLabsError(
        `elevenlabs answered ${path} with a body that is not JSON: ${this.#quote(error.message)}`,
        undefined,
        "response_invalid",
      );
    }
    return new ElevenLabsError(
      `could not reach elevenlabs at ${this.#baseUrl} (network): ${this.#quote(describeThrown(error))}`,
      undefined,
      "network",
    );
  }

  /** Redact the key, then truncate — in that order, so a cut cannot leave half a key behind. */
  #quote(text: string): string {
    const redacted = this.#apiKey === "" ? text : text.replaceAll(this.#apiKey, REDACTED);
    return redacted.length > ERROR_BODY_LIMIT
      ? `${redacted.slice(0, ERROR_BODY_LIMIT)}…`
      : redacted;
  }
}

/** Pull the code and message out of an error body, whatever shape it turned out to have. */
function readErrorDetail(text: string): { code: string | undefined; message: string } {
  const detail = parseDetail(text);
  if (typeof detail === "string") {
    return { code: undefined, message: detail };
  }
  if (isRecord(detail)) {
    const code =
      typeof detail.status === "string"
        ? detail.status
        : typeof detail.code === "string"
          ? detail.code
          : undefined;
    const message = typeof detail.message === "string" ? detail.message : text.trim();
    return { code, message };
  }
  return { code: undefined, message: text.trim() };
}

/** The `detail` of a JSON error body, or `undefined` for a body that is not one. */
function parseDetail(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed.detail : undefined;
  } catch {
    return undefined;
  }
}

/** Refuse a `2xx` body that lacks either half, and type the half this client hands back. */
function readSpeech(body: unknown, path: string): ElevenLabsSpeech {
  const fields = isRecord(body) ? body : {};
  const audio = fields.audio_base64;
  if (typeof audio !== "string" || audio === "") {
    throw new ElevenLabsError(
      `elevenlabs answered ${path} with no audio: audio_base64 is ${audio === "" ? "empty" : "missing"}`,
      undefined,
      "audio_missing",
    );
  }
  return { audio, alignment: readAlignment(fields.alignment, path) };
}

/**
 * The response's `alignment`, checked for shape only.
 *
 * Absent, `null` or empty is `alignment_missing` — the service documents the field as optional and
 * nullable, and it is the whole reason this endpoint is used. Present but not three arrays of
 * characters and numbers is `alignment_invalid`. Whether the times make sense is
 * `alignmentToWordTimestamps`' question, not this one's.
 */
function readAlignment(value: unknown, path: string): ElevenLabsAlignment {
  if (value === undefined || value === null) {
    throw new ElevenLabsError(
      `elevenlabs answered ${path} with audio but no alignment, so nothing says when each word was spoken. normalized_alignment is not read in its place.`,
      undefined,
      "alignment_missing",
    );
  }
  const characters = isRecord(value) ? value.characters : undefined;
  const starts = isRecord(value) ? value.character_start_times_seconds : undefined;
  const ends = isRecord(value) ? value.character_end_times_seconds : undefined;
  if (!isStringArray(characters) || !isNumberArray(starts) || !isNumberArray(ends)) {
    throw new ElevenLabsError(
      `elevenlabs answered ${path} with an alignment that is not three arrays of characters, start times and end times`,
      undefined,
      "alignment_invalid",
    );
  }
  if (characters.length === 0) {
    throw new ElevenLabsError(
      `elevenlabs answered ${path} with an empty alignment, so nothing says when each word was spoken`,
      undefined,
      "alignment_missing",
    );
  }
  return {
    characters,
    character_start_times_seconds: starts,
    character_end_times_seconds: ends,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number");
}

function nameOf(error: unknown): string | undefined {
  return isRecord(error) && typeof error.name === "string" ? error.name : undefined;
}

/**
 * A transport error as one line. The platform `fetch` throws a bare `fetch failed` and puts the
 * reason — `ECONNREFUSED`, `ENOTFOUND` — on `cause`, so the cause is the useful half.
 */
function describeThrown(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause: unknown = error.cause;
  if (cause instanceof Error) {
    return `${error.message} (${cause.message})`;
  }
  return error.message;
}
