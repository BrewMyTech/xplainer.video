/**
 * A Kokoro-FastAPI client: request shaping in, parsed envelope out
 * (plan §4 S2.3; deviation D-6).
 *
 * The contract it pins comes from `max/.explainers/scripts/narrate.py`, which
 * is where this product's TTS integration currently lives:
 *
 *   * `GET  /v1/audio/voices`      — `narrate.py:126-131`
 *   * `POST /dev/captioned_speech` — `narrate.py:147-162`
 *
 * Nothing here synthesises, writes or measures audio. That is narration logic
 * and spec §Non-Goals keeps it out of this phase; the two endpoints and the
 * payload flags are pinned now because getting `stream` or `return_timestamps`
 * wrong fails silently rather than loudly.
 */

import type {
  CaptionedSpeechPayload,
  CaptionedSpeechRequest,
  CaptionedSpeechResponse,
  FetchLike,
  HttpResponseLike,
  Voice,
  VoiceListEntry,
  WordTimestamp,
} from "./types";

/** Where Kokoro's CPU container listens by default (`narrate.py:57`). */
export const DEFAULT_BASE_URL = "http://localhost:8880";

/** The environment variable that overrides {@link DEFAULT_BASE_URL} (`narrate.py:57`). */
export const BASE_URL_ENV_VAR = "KOKORO_URL";

/** Speaking rate used when a request omits one (`narrate.py:193`). */
export const DEFAULT_SPEED = 1.0;

/** Path of the voice-list endpoint (`narrate.py:126`). */
export const VOICES_PATH = "/v1/audio/voices";

/** Path of the captioned-speech endpoint (`narrate.py:162`). */
export const CAPTIONED_SPEECH_PATH = "/dev/captioned_speech";

/** How much of a failing response body is quoted in an error (`narrate.py:164`). */
const ERROR_BODY_LIMIT = 400;

/** A Kokoro request that the server rejected, or answered with an unusable body. */
export class KokoroError extends Error {
  /**
   * HTTP status, when the failure was an HTTP one, and `undefined` when it was
   * not. The field is always present so a caller reading the emitted `.d.ts`
   * sees that the absence is expressible rather than having to guess whether the
   * property exists (`exactOptionalPropertyTypes`).
   */
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "KokoroError";
    this.status = status;
  }
}

/**
 * Resolve the server base URL: `KOKORO_URL` when set and non-empty, otherwise
 * {@link DEFAULT_BASE_URL} (`narrate.py:57`).
 *
 * Takes the environment as an argument so it stays a pure function; the client
 * passes `process.env`.
 */
export function resolveBaseUrl(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = env[BASE_URL_ENV_VAR];
  return configured !== undefined && configured.trim() !== ""
    ? configured.trim()
    : DEFAULT_BASE_URL;
}

/** Drop trailing slashes so joining a path cannot produce a double slash. */
function trimTrailingSlashes(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Normalise a voice list to plain ids (`narrate.py:127-131`).
 *
 * Current builds return `[{"id": ..., "name": ...}]` and older ones return bare
 * strings, so both shapes are accepted. An entry carrying neither an `id` nor a
 * `name` is dropped rather than surfacing as `undefined` in the result.
 */
export function normaliseVoiceList(listed: readonly VoiceListEntry[] | undefined): Voice[] {
  if (!listed) {
    return [];
  }

  const voices: Voice[] = [];
  for (const entry of listed) {
    if (typeof entry === "string") {
      voices.push(entry);
      continue;
    }
    const id = entry.id ?? entry.name;
    if (typeof id === "string") {
      voices.push(id);
    }
  }
  return voices;
}

/**
 * Build the exact JSON body posted to `/dev/captioned_speech`
 * (`narrate.py:147-157`).
 *
 * `stream: false` and `return_timestamps: true` are not preferences. Streaming
 * returns raw audio rather than the JSON envelope that carries the timestamps,
 * so inverting either flag loses every word timing without erroring
 * (`narrate.py:153-154`). `lang_code` is present only when the caller supplies
 * one, because the server infers it from the voice otherwise
 * (`narrate.py:158-159`).
 */
export function buildCaptionedSpeechPayload(
  request: CaptionedSpeechRequest,
): CaptionedSpeechPayload {
  const payload: CaptionedSpeechPayload = {
    model: "kokoro",
    input: request.text,
    voice: request.voice,
    response_format: "wav",
    speed: request.speed ?? DEFAULT_SPEED,
    stream: false,
    return_timestamps: true,
  };

  return request.langCode ? { ...payload, lang_code: request.langCode } : payload;
}

/** Construction options for {@link KokoroClient}. */
export type KokoroClientOptions = {
  /** Server base URL. Defaults to {@link resolveBaseUrl}'s answer. */
  baseUrl?: string;
  /** Transport. Defaults to the platform `fetch`. */
  fetch?: FetchLike;
};

const platformFetch: FetchLike = (url, init) => fetch(url, init);

/**
 * A client for the two Kokoro-FastAPI endpoints the narration phase needs.
 *
 * Both the base URL and the transport are injectable: the base URL because a
 * sidecar container is reached at a different host than a developer's local
 * container, and the transport because that is what makes the request shaping
 * testable without a server.
 */
export class KokoroClient {
  /** The resolved base URL, with any trailing slashes removed. */
  readonly baseUrl: string;

  readonly #fetch: FetchLike;

  constructor(options: KokoroClientOptions = {}) {
    this.baseUrl = trimTrailingSlashes(options.baseUrl ?? resolveBaseUrl());
    this.#fetch = options.fetch ?? platformFetch;
  }

  /** The absolute URL of `path` on this client's server. */
  url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  /**
   * List the voices the server knows, normalised to plain ids
   * (`narrate.py:126-131`).
   */
  async listVoices(): Promise<Voice[]> {
    const response = await this.#fetch(this.url(VOICES_PATH), {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    const body = await this.#readJson(response, VOICES_PATH);
    const voices = (body as { voices?: readonly VoiceListEntry[] }).voices;
    return normaliseVoiceList(voices);
  }

  /**
   * Synthesise one segment and return the base64 audio together with its word
   * timestamps (`narrate.py:145-170`).
   *
   * The audio is left encoded: decoding it is the first step of building a
   * track, which this phase does not do.
   */
  async captionedSpeech(request: CaptionedSpeechRequest): Promise<CaptionedSpeechResponse> {
    const payload = buildCaptionedSpeechPayload(request);

    const response = await this.#fetch(this.url(CAPTIONED_SPEECH_PATH), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const body = (await this.#readJson(response, CAPTIONED_SPEECH_PATH)) as {
      audio?: unknown;
      timestamps?: readonly WordTimestamp[];
    };

    if (typeof body.audio !== "string" || body.audio === "") {
      throw new KokoroError(`no audio in response: ${truncate(JSON.stringify(body))}`);
    }

    return { audio: body.audio, timestamps: body.timestamps ?? [] };
  }

  /** Reject a non-2xx response the way `narrate.py:163-164` does, then parse. */
  async #readJson(response: HttpResponseLike, path: string): Promise<unknown> {
    if (!response.ok) {
      const detail = truncate(await response.text());
      throw new KokoroError(
        `kokoro rejected ${path} (${response.status}): ${detail}`,
        response.status,
      );
    }
    return response.json();
  }
}

function truncate(text: string): string {
  return text.length > ERROR_BODY_LIMIT ? `${text.slice(0, ERROR_BODY_LIMIT)}…` : text;
}
