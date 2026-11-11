import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchLike, HttpRequestInit, HttpResponseLike } from "../types";
import { alignmentToWordTimestamps } from "./alignment";
import {
  buildElevenLabsSpeechPayload,
  ELEVENLABS_DEFAULT_BASE_URL,
  ELEVENLABS_OUTPUT_FORMAT,
  ELEVENLABS_REQUEST_TIMEOUT_MS,
  ELEVENLABS_SAMPLE_RATE,
  ElevenLabsClient,
  ElevenLabsError,
  timestampedSpeechPath,
} from "./client";
import type { ElevenLabsAlignment, ElevenLabsSpeechPayload } from "./types";

type Call = { url: string; init: HttpRequestInit };

/** A recorded with-timestamps response (`test/fixtures/elevenlabs/`). */
type RecordedSpeech = {
  readonly request: { readonly voice_id: string; readonly model_id: string; readonly text: string };
  readonly response: {
    readonly audio_base64: string;
    readonly alignment: ElevenLabsAlignment;
    readonly normalized_alignment: ElevenLabsAlignment;
  };
};

/** The three real error bodies the service returned, keyed by HTTP status. */
type RecordedErrors = { readonly bodies: Readonly<Record<"400" | "401" | "404", unknown>> };

function fixture<T>(name: string): T {
  const path = fileURLToPath(new URL(`../../test/fixtures/elevenlabs/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

const MULTILINGUAL = fixture<RecordedSpeech>("with-timestamps.json");
const V4_OVERRUN = fixture<RecordedSpeech>("with-timestamps-v4-overrun.json");
const ERRORS = fixture<RecordedErrors>("errors.json");

/** Shaped like a real key and used nowhere but here, so a leak is a substring match. */
const API_KEY = "sk_0123456789abcdef0123456789abcdef0123456789abcdef";

const VOICE = "JBFqnCBsd6RMkjVDRZzb";
const MODEL = "eleven_multilingual_v2";
const REQUEST = { text: MULTILINGUAL.request.text, voiceId: VOICE, modelId: MODEL };

/**
 * A transport stub that records what it was asked to send and replies with a canned answer. Every
 * assertion below reads a recorded call or a returned value, so nothing here touches the network.
 */
function recordingFetch(answer: {
  status?: number;
  body?: unknown;
  text?: string;
  json?: () => Promise<unknown>;
}): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const status = answer.status ?? 200;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const response: HttpResponseLike = {
      ok: status >= 200 && status <= 299,
      status,
      json: answer.json ?? (async () => answer.body),
      text: async () => answer.text ?? JSON.stringify(answer.body),
    };
    return response;
  };
  return { fetch, calls };
}

function clientFor(fetch: FetchLike, timeoutMs?: number): ElevenLabsClient {
  return new ElevenLabsClient(
    timeoutMs === undefined ? { apiKey: API_KEY, fetch } : { apiKey: API_KEY, fetch, timeoutMs },
  );
}

function onlyCall(calls: Call[]): Call {
  expect(calls).toHaveLength(1);
  const call = calls[0];
  if (!call) {
    throw new Error("the client made no request");
  }
  return call;
}

function payloadOf(call: Call): ElevenLabsSpeechPayload {
  if (call.init.body === undefined) {
    throw new Error("the client posted no body");
  }
  return JSON.parse(call.init.body) as ElevenLabsSpeechPayload;
}

async function failure(promise: Promise<unknown>): Promise<ElevenLabsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ElevenLabsError) {
      return error;
    }
    throw error;
  }
  throw new Error("the request succeeded");
}

async function rejectionFor(
  answer: Parameters<typeof recordingFetch>[0],
): Promise<ElevenLabsError> {
  const { fetch } = recordingFetch(answer);
  return failure(clientFor(fetch).timestampedSpeech(REQUEST));
}

describe("buildElevenLabsSpeechPayload", () => {
  it("sends exactly text and model_id when no speed is given", () => {
    expect(buildElevenLabsSpeechPayload(REQUEST)).toStrictEqual({
      text: MULTILINGUAL.request.text,
      model_id: MODEL,
    });
  });

  it("sends exactly text and model_id at speed 1", () => {
    expect(buildElevenLabsSpeechPayload({ ...REQUEST, speed: 1 })).toStrictEqual({
      text: MULTILINGUAL.request.text,
      model_id: MODEL,
    });
  });

  it("sends voice_settings.speed for any other speed", () => {
    expect(buildElevenLabsSpeechPayload({ ...REQUEST, speed: 0.9 })).toStrictEqual({
      text: MULTILINGUAL.request.text,
      model_id: MODEL,
      voice_settings: { speed: 0.9 },
    });
  });
});

describe("timestampedSpeechPath", () => {
  it("names the with-timestamps endpoint for the voice and asks for 24 kHz PCM", () => {
    expect(timestampedSpeechPath(VOICE)).toBe(
      "/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/with-timestamps?output_format=pcm_24000",
    );
    expect(ELEVENLABS_OUTPUT_FORMAT).toBe("pcm_24000");
    expect(ELEVENLABS_SAMPLE_RATE).toBe(24000);
  });

  it("encodes the voice id, so it cannot reach another path", () => {
    expect(timestampedSpeechPath("../v1/user")).toBe(
      "/v1/text-to-speech/..%2Fv1%2Fuser/with-timestamps?output_format=pcm_24000",
    );
  });
});

describe("ElevenLabsClient request", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts JSON to the with-timestamps URL with the key in xi-api-key and a signal", async () => {
    const { fetch, calls } = recordingFetch({ body: MULTILINGUAL.response });

    await clientFor(fetch).timestampedSpeech({ ...REQUEST, speed: 1.1 });

    const call = onlyCall(calls);
    expect(call.url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/with-timestamps?output_format=pcm_24000",
    );
    expect(call.url.startsWith(ELEVENLABS_DEFAULT_BASE_URL)).toBe(true);
    expect(call.init.method).toBe("POST");
    expect(call.init.headers).toEqual({
      "xi-api-key": API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    });
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    // A redirect is refused rather than followed: fetch would carry xi-api-key to the new host.
    expect(call.init.redirect).toBe("error");
    expect(payloadOf(call)).toStrictEqual({
      text: MULTILINGUAL.request.text,
      model_id: MODEL,
      voice_settings: { speed: 1.1 },
    });
  });

  it("puts the key in the header only, never in the URL or the body", async () => {
    const { fetch, calls } = recordingFetch({ body: MULTILINGUAL.response });

    await clientFor(fetch).timestampedSpeech(REQUEST);

    const call = onlyCall(calls);
    expect(call.url).not.toContain(API_KEY);
    expect(call.init.body).not.toContain(API_KEY);
  });

  it("bounds the request with a 120 s timeout signal unless told otherwise", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const { fetch } = recordingFetch({ body: MULTILINGUAL.response });

    await clientFor(fetch).timestampedSpeech(REQUEST);
    await clientFor(fetch, 5_000).timestampedSpeech(REQUEST);

    expect(ELEVENLABS_REQUEST_TIMEOUT_MS).toBe(120_000);
    expect(timeout.mock.calls).toEqual([[120_000], [5_000]]);
  });

  it("posts to a given base URL with its trailing slashes trimmed", async () => {
    const { fetch, calls } = recordingFetch({ body: MULTILINGUAL.response });

    await new ElevenLabsClient({
      apiKey: API_KEY,
      baseUrl: "http://127.0.0.1:9000//",
      fetch,
    }).timestampedSpeech(REQUEST);

    expect(onlyCall(calls).url).toBe(`http://127.0.0.1:9000${timestampedSpeechPath(VOICE)}`);
  });
});

describe("ElevenLabsClient response", () => {
  it("returns the raw audio and the alignment of the recorded responses, as recorded", async () => {
    for (const recording of [MULTILINGUAL, V4_OVERRUN]) {
      const { fetch } = recordingFetch({ body: recording.response });

      const speech = await clientFor(fetch).timestampedSpeech({
        text: recording.request.text,
        voiceId: recording.request.voice_id,
        modelId: recording.request.model_id,
      });

      expect(speech.audio).toBe(recording.response.audio_base64);
      expect(speech.alignment).toEqual(recording.response.alignment);
      expect(speech.alignment.characters.join("")).toBe(recording.request.text);
    }
  });

  it("returns alignment, not normalized_alignment, which reads the dash as -- and pads spaces", async () => {
    const { fetch } = recordingFetch({ body: MULTILINGUAL.response });

    const speech = await clientFor(fetch).timestampedSpeech(REQUEST);

    expect(MULTILINGUAL.response.normalized_alignment.characters.join("")).not.toBe(
      MULTILINGUAL.request.text,
    );
    expect(speech.alignment.characters).toEqual(MULTILINGUAL.response.alignment.characters);
  });

  it("refuses alignment: null as alignment_missing even when normalized_alignment is present", async () => {
    const error = await rejectionFor({ body: { ...MULTILINGUAL.response, alignment: null } });

    expect(error.code).toBe("alignment_missing");
    expect(error.message).toMatch(/no alignment/);
  });

  it("refuses an absent alignment as alignment_missing even when normalized_alignment is present", async () => {
    const { alignment: _dropped, ...withoutAlignment } = MULTILINGUAL.response;

    const error = await rejectionFor({ body: withoutAlignment });

    expect(error.code).toBe("alignment_missing");
  });

  it("refuses an empty alignment as alignment_missing", async () => {
    const empty = {
      characters: [],
      character_start_times_seconds: [],
      character_end_times_seconds: [],
    };

    const error = await rejectionFor({ body: { ...MULTILINGUAL.response, alignment: empty } });

    expect(error.code).toBe("alignment_missing");
  });

  it("refuses an alignment that is not three arrays of characters and numbers as alignment_invalid", async () => {
    for (const alignment of [
      "T h e",
      {},
      { ...MULTILINGUAL.response.alignment, characters: "The" },
      { ...MULTILINGUAL.response.alignment, character_end_times_seconds: ["0.1"] },
    ]) {
      const error = await rejectionFor({ body: { ...MULTILINGUAL.response, alignment } });

      expect(error.code).toBe("alignment_invalid");
    }
  });

  it("refuses empty or absent audio_base64 as audio_missing", async () => {
    const { audio_base64: _dropped, ...withoutAudio } = MULTILINGUAL.response;

    const empty = await rejectionFor({ body: { ...MULTILINGUAL.response, audio_base64: "" } });
    const absent = await rejectionFor({ body: withoutAudio });

    expect(empty.code).toBe("audio_missing");
    expect(empty.message).toMatch(/audio_base64 is empty/);
    expect(absent.code).toBe("audio_missing");
  });

  it("refuses a 200 whose body is not JSON as response_invalid", async () => {
    const error = await rejectionFor({
      json: async () => JSON.parse("<html>"),
    });

    expect(error.code).toBe("response_invalid");
    expect(error.status).toBeUndefined();
    expect(error.retryable).toBe(false);
  });

  it("reports every shape refusal with no status and as not retryable", async () => {
    const error = await rejectionFor({ body: { ...MULTILINGUAL.response, alignment: null } });

    expect(error).toBeInstanceOf(ElevenLabsError);
    expect(error.status).toBeUndefined();
    expect(error.retryable).toBe(false);
  });
});

describe("ElevenLabsClient errors", () => {
  it("reads the recorded 401: code is detail.status, invalid_api_key, not detail.code", async () => {
    const error = await rejectionFor({ status: 401, body: ERRORS.bodies["401"] });

    expect(error.status).toBe(401);
    expect(error.code).toBe("invalid_api_key");
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/\(401 invalid_api_key\): Invalid API key/);
  });

  it("reads the recorded 404: voice_not_found, with the service's message", async () => {
    const error = await rejectionFor({ status: 404, body: ERRORS.bodies["404"] });

    expect(error.status).toBe(404);
    expect(error.code).toBe("voice_not_found");
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/A voice with voice_id 'AAAAAAAAAAAAAAAAAAAA' was not found/);
  });

  it("reads the recorded 400, which has detail.status and no detail.code at all", async () => {
    const error = await rejectionFor({ status: 400, body: ERRORS.bodies["400"] });

    expect(error.status).toBe(400);
    expect(error.code).toBe("model_not_found");
    expect(error.retryable).toBe(false);
  });

  it("falls back to detail.code when detail.status is not a string", async () => {
    const body = { detail: { type: "rate_limit_error", code: "system_busy", message: "Busy." } };

    const error = await rejectionFor({ status: 429, body });

    expect(error.code).toBe("system_busy");
    expect(error.retryable).toBe(true);
  });

  it("keeps the status of an error whose body is not JSON", async () => {
    const error = await rejectionFor({ status: 503, text: "upstream connect error" });

    expect(error.status).toBe(503);
    expect(error.code).toBeUndefined();
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/\(503\): upstream connect error/);
  });

  it("says so when an error has no body at all", async () => {
    const error = await rejectionFor({ status: 502, text: "" });

    expect(error.message).toMatch(/\(502\): no error body/);
  });

  it("quotes a string detail, and a validation error's whole body, with no code", async () => {
    const plain = await rejectionFor({ status: 404, body: { detail: "Not Found" } });
    const validation = await rejectionFor({
      status: 422,
      body: { detail: [{ loc: ["body", "text"], msg: "field required", type: "missing" }] },
    });

    expect(plain.code).toBeUndefined();
    expect(plain.message).toMatch(/\(404\): Not Found/);
    expect(validation.code).toBeUndefined();
    expect(validation.message).toMatch(/field required/);
  });

  it("is retryable for 429 and 5xx and for nothing else", async () => {
    for (const status of [429, 500, 502, 503, 504]) {
      expect((await rejectionFor({ status, text: "" })).retryable).toBe(true);
    }
    for (const status of [400, 401, 402, 403, 404, 409, 422]) {
      expect((await rejectionFor({ status, text: "" })).retryable).toBe(false);
    }
  });

  it("makes one attempt, however retryable the failure", async () => {
    const { fetch, calls } = recordingFetch({ status: 503, text: "" });

    await failure(clientFor(fetch).timestampedSpeech(REQUEST));

    expect(calls).toHaveLength(1);
  });

  it("truncates a long error message", async () => {
    const body = { detail: { status: "text_too_long", message: "x".repeat(2_000) } };

    const error = await rejectionFor({ status: 400, body });

    expect(error.message.length).toBeLessThan(600);
    expect(error.message.endsWith("…")).toBe(true);
  });

  it("fails as timeout, not retryable, when no answer arrives within the timeout", async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });

    const error = await failure(clientFor(hang, 20).timestampedSpeech(REQUEST));

    expect(error.code).toBe("timeout");
    expect(error.status).toBeUndefined();
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/within 20 ms \(timeout\)/);
    expect(error.message).toMatch(/billed/);
  });

  it("fails as network, not retryable, when the request cannot be sent", async () => {
    const refused: FetchLike = async () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    };

    const error = await failure(clientFor(refused).timestampedSpeech(REQUEST));

    expect(error.code).toBe("network");
    expect(error.status).toBeUndefined();
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/fetch failed \(connect ECONNREFUSED\)/);
  });

  it("never puts the API key in a message, even when the service or the transport echoes it", async () => {
    const echoed = await rejectionFor({
      status: 401,
      body: { detail: { status: "invalid_api_key", message: `Invalid API key: ${API_KEY}` } },
    });
    const echoedText = await rejectionFor({ status: 500, text: `bad key ${API_KEY}` });
    // A key that straddles the truncation point: redaction runs first, so no fragment survives.
    const straddling = await rejectionFor({
      status: 400,
      body: { detail: { status: "x", message: `${"y".repeat(380)}${API_KEY}` } },
    });
    const thrown = await failure(
      clientFor(async () => {
        throw new TypeError(`fetch failed for ${API_KEY}`);
      }).timestampedSpeech(REQUEST),
    );
    // The service's code is its text too: an echo there is redacted like one in the message.
    const echoedCode = await rejectionFor({
      status: 400,
      body: { detail: { status: `bad_${API_KEY}`, message: "no" } },
    });
    const recorded = await Promise.all([
      rejectionFor({ status: 401, body: ERRORS.bodies["401"] }),
      rejectionFor({ status: 404, body: ERRORS.bodies["404"] }),
      rejectionFor({ status: 400, body: ERRORS.bodies["400"] }),
    ]);

    for (const error of [echoed, echoedText, straddling, thrown, echoedCode, ...recorded]) {
      expect(error.message).not.toContain(API_KEY);
      expect(error.message).not.toContain(API_KEY.slice(0, 12));
      expect(error.code ?? "").not.toContain(API_KEY);
    }
    expect(echoed.message).toContain("[redacted]");
    expect(thrown.message).toContain("[redacted]");
  });
});

/**
 * The live half: one real request to ElevenLabs.
 *
 * Every stubbed test above proves what the client sends and how it reads a recorded answer; none of
 * them can tell whether the service still answers that way. A model that stopped returning
 * `alignment`, or started rewriting the characters in it, breaks narration while everything above
 * stays green — so this block asks once and checks the three things narration depends on: an
 * alignment that `alignmentToWordTimestamps` accepts, characters that join to exactly the text
 * sent, and spans that all lie within the audio once each end is bounded by its duration, which is
 * the bound the CLI applies. It deliberately does **not** assert that the audio outlasts the last
 * character: the service's own alignment can run past its audio, and that was measured.
 *
 * It bills about 45 characters to whoever exports the key, each time it runs. It runs under
 * `pnpm --filter @xplainer/tts-client test`, which hands vitest the whole shell; it does not run
 * under `turbo run test` or `pnpm verify`, because turbo's strict environment mode passes a task no
 * variable that `turbo.json` does not declare, and it declares none.
 *
 *   ELEVENLABS_API_KEY=… pnpm --filter @xplainer/tts-client test
 */
const LIVE_TIMEOUT_MS = ELEVENLABS_REQUEST_TIMEOUT_MS + 10_000;

/** 45 characters, with a digit and an em dash: the two things a normaliser would rewrite. */
const LIVE_TEXT = "The build failed — start again, at 5 dollars.";

// The condition is written out at the call site, as AGENTS.md requires of every `skipIf`.
describe.skipIf((process.env.ELEVENLABS_API_KEY ?? "").trim() === "")("live ElevenLabs", () => {
  it(
    "returns raw PCM and an alignment of exactly the text sent, within the audio once bounded",
    async () => {
      const client = new ElevenLabsClient({
        apiKey: (process.env.ELEVENLABS_API_KEY ?? "").trim(),
      });

      const speech = await client.timestampedSpeech({
        text: LIVE_TEXT,
        voiceId: VOICE,
        modelId: MODEL,
      });

      expect(LIVE_TEXT.length).toBeLessThanOrEqual(45);
      expect(speech.alignment.characters.join("")).toBe(LIVE_TEXT);

      // Raw validity: lengths, finite non-negative spans, words that never run backwards.
      const words = alignmentToWordTimestamps(speech.alignment);
      expect(words.map((span) => span.word)).toEqual(LIVE_TEXT.split(/\s+/u));

      const pcm = Buffer.from(speech.audio, "base64");
      expect(pcm.byteLength).toBeGreaterThan(0);
      expect(pcm.byteLength % 2).toBe(0);

      // The CLI's bound: a word that starts at or after the end of the audio is refused, and an
      // end that runs past it is clamped to it. Every word starting inside the audio is what makes
      // the clamped spans all lie within it, so that is the assertion.
      const audioSeconds = pcm.byteLength / 2 / ELEVENLABS_SAMPLE_RATE;
      for (const span of words) {
        expect(span.start_time).toBeLessThan(audioSeconds);
      }
    },
    LIVE_TIMEOUT_MS,
  );
});
