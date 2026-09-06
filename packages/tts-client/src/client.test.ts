import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BASE_URL_ENV_VAR,
  buildCaptionedSpeechPayload,
  CAPTIONED_SPEECH_PATH,
  DEFAULT_BASE_URL,
  KokoroClient,
  KokoroError,
  normaliseVoiceList,
  resolveBaseUrl,
  VOICES_PATH,
} from "./client";
import type { CaptionedSpeechPayload, FetchLike, HttpRequestInit } from "./types";

type Call = { url: string; init: HttpRequestInit };

/**
 * A transport stub that records what it was asked to send and replies with a
 * canned body. Every assertion below reads a recorded call or a returned value,
 * so nothing here needs a running Kokoro server.
 */
function recordingFetch(
  body: unknown,
  response: { ok?: boolean; status?: number; text?: string } = {},
): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => body,
      text: async () => response.text ?? JSON.stringify(body),
    };
  };
  return { fetch, calls };
}

const SPEECH_BODY = {
  audio: "UklGRiQAAABXQVZF",
  timestamps: [{ word: "hello", start_time: 0, end_time: 0.42 }],
};

function firstCall(calls: Call[]): Call {
  const call = calls[0];
  if (!call) {
    throw new Error("the client made no request");
  }
  return call;
}

function payloadOf(call: Call): CaptionedSpeechPayload {
  if (call.init.body === undefined) {
    throw new Error("the client posted no body");
  }
  return JSON.parse(call.init.body) as CaptionedSpeechPayload;
}

describe("buildCaptionedSpeechPayload", () => {
  it("sets stream false and return_timestamps true, the two flags that silently lose word timings", () => {
    const payload = buildCaptionedSpeechPayload({ text: "Hello there.", voice: "af_heart" });

    expect(payload.stream).toBe(false);
    expect(payload.return_timestamps).toBe(true);
  });

  it("reproduces narrate.py's payload including model, response_format and the default speed", () => {
    const payload = buildCaptionedSpeechPayload({ text: "Hello there.", voice: "af_heart" });

    expect(payload).toEqual({
      model: "kokoro",
      input: "Hello there.",
      voice: "af_heart",
      response_format: "wav",
      speed: 1.0,
      stream: false,
      return_timestamps: true,
    });
  });

  it("carries an explicit speed through instead of the default", () => {
    const payload = buildCaptionedSpeechPayload({ text: "Faster.", voice: "af_sky", speed: 1.35 });

    expect(payload.speed).toBe(1.35);
  });

  it("includes lang_code only when the caller supplies one", () => {
    const without = buildCaptionedSpeechPayload({ text: "Inferred.", voice: "af_heart" });
    const with_ = buildCaptionedSpeechPayload({
      text: "Explicit.",
      voice: "af_heart",
      langCode: "a",
    });

    expect(without).not.toHaveProperty("lang_code");
    expect(with_.lang_code).toBe("a");
  });
});

describe("resolveBaseUrl", () => {
  it("falls back to Kokoro's default container port when the environment is unset", () => {
    expect(resolveBaseUrl({})).toBe("http://localhost:8880");
    expect(DEFAULT_BASE_URL).toBe("http://localhost:8880");
  });

  it("returns the KOKORO_URL override when one is set", () => {
    expect(resolveBaseUrl({ [BASE_URL_ENV_VAR]: "http://tts-sidecar:8880" })).toBe(
      "http://tts-sidecar:8880",
    );
  });

  it("ignores a blank override rather than producing an empty base URL", () => {
    expect(resolveBaseUrl({ [BASE_URL_ENV_VAR]: "   " })).toBe(DEFAULT_BASE_URL);
  });
});

describe("normaliseVoiceList", () => {
  it("reads the id from the object shape current builds return", () => {
    expect(normaliseVoiceList([{ id: "af_heart", name: "Heart" }, { id: "af_sky" }])).toEqual([
      "af_heart",
      "af_sky",
    ]);
  });

  it("accepts the bare-string shape older builds return", () => {
    expect(normaliseVoiceList(["af_heart", "af_bella"])).toEqual(["af_heart", "af_bella"]);
  });

  it("falls back to name when an entry carries no id, and drops an entry with neither", () => {
    expect(normaliseVoiceList([{ name: "af_nicole" }, {}, "af_sky"])).toEqual([
      "af_nicole",
      "af_sky",
    ]);
  });

  it("returns an empty list when the server omits the voices field", () => {
    expect(normaliseVoiceList(undefined)).toEqual([]);
  });
});

describe("KokoroClient.captionedSpeech", () => {
  it("posts JSON to /dev/captioned_speech", async () => {
    const { fetch, calls } = recordingFetch(SPEECH_BODY);
    const client = new KokoroClient({ baseUrl: "http://localhost:8880", fetch });

    await client.captionedSpeech({ text: "Hello there.", voice: "af_heart" });

    const call = firstCall(calls);
    expect(call.url).toBe(`http://localhost:8880${CAPTIONED_SPEECH_PATH}`);
    expect(call.url).toBe("http://localhost:8880/dev/captioned_speech");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers["Content-Type"]).toBe("application/json");
  });

  it("sends stream false and return_timestamps true over the wire", async () => {
    const { fetch, calls } = recordingFetch(SPEECH_BODY);
    const client = new KokoroClient({ baseUrl: "http://localhost:8880", fetch });

    await client.captionedSpeech({ text: "Hello there.", voice: "af_heart", langCode: "a" });

    const payload = payloadOf(firstCall(calls));
    expect(payload.stream).toBe(false);
    expect(payload.return_timestamps).toBe(true);
    expect(payload.input).toBe("Hello there.");
    expect(payload.lang_code).toBe("a");
  });

  it("returns the base64 audio and the word timestamps from the envelope", async () => {
    const { fetch } = recordingFetch(SPEECH_BODY);
    const client = new KokoroClient({ fetch });

    const result = await client.captionedSpeech({ text: "Hello there.", voice: "af_heart" });

    expect(result.audio).toBe("UklGRiQAAABXQVZF");
    expect(result.timestamps).toEqual([{ word: "hello", start_time: 0, end_time: 0.42 }]);
  });

  it("reports an empty timestamp list when the server returns none", async () => {
    const { fetch } = recordingFetch({ audio: "UklGRiQAAABXQVZF" });
    const client = new KokoroClient({ fetch });

    const result = await client.captionedSpeech({ text: "Hello there.", voice: "af_heart" });

    expect(result.timestamps).toEqual([]);
  });

  it("throws a KokoroError carrying the status when the server rejects the request", async () => {
    const { fetch } = recordingFetch(null, { ok: false, status: 422, text: "unknown voice" });
    const client = new KokoroClient({ fetch });

    const failure = client.captionedSpeech({ text: "Hello.", voice: "not_a_voice" });

    await expect(failure).rejects.toBeInstanceOf(KokoroError);
    await expect(failure).rejects.toMatchObject({ status: 422 });
    await expect(failure).rejects.toThrow(/422/);
  });

  it("throws when the response carries no audio", async () => {
    const { fetch } = recordingFetch({ timestamps: [] });
    const client = new KokoroClient({ fetch });

    await expect(client.captionedSpeech({ text: "Hello.", voice: "af_heart" })).rejects.toThrow(
      /no audio in response/,
    );
  });
});

describe("KokoroClient.listVoices", () => {
  it("gets /v1/audio/voices and normalises the object shape", async () => {
    const { fetch, calls } = recordingFetch({ voices: [{ id: "af_heart" }, { id: "af_sky" }] });
    const client = new KokoroClient({ baseUrl: "http://localhost:8880", fetch });

    const voices = await client.listVoices();

    expect(firstCall(calls).url).toBe(`http://localhost:8880${VOICES_PATH}`);
    expect(firstCall(calls).init.method).toBe("GET");
    expect(voices).toEqual(["af_heart", "af_sky"]);
  });

  it("normalises the bare-string shape older builds return", async () => {
    const { fetch } = recordingFetch({ voices: ["af_heart", "af_bella"] });
    const client = new KokoroClient({ fetch });

    expect(await client.listVoices()).toEqual(["af_heart", "af_bella"]);
  });
});

describe("KokoroClient base URL", () => {
  const saved = process.env[BASE_URL_ENV_VAR];

  beforeEach(() => {
    delete process.env[BASE_URL_ENV_VAR];
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env[BASE_URL_ENV_VAR];
    } else {
      process.env[BASE_URL_ENV_VAR] = saved;
    }
  });

  it("defaults to localhost:8880 when KOKORO_URL is unset", async () => {
    const { fetch, calls } = recordingFetch(SPEECH_BODY);
    const client = new KokoroClient({ fetch });

    await client.captionedSpeech({ text: "Hello.", voice: "af_heart" });

    expect(client.baseUrl).toBe("http://localhost:8880");
    expect(firstCall(calls).url).toBe("http://localhost:8880/dev/captioned_speech");
  });

  it("posts to the KOKORO_URL override instead of the default", async () => {
    process.env[BASE_URL_ENV_VAR] = "http://tts-sidecar:9001";
    const { fetch, calls } = recordingFetch(SPEECH_BODY);
    const client = new KokoroClient({ fetch });

    await client.captionedSpeech({ text: "Hello.", voice: "af_heart" });

    expect(client.baseUrl).toBe("http://tts-sidecar:9001");
    expect(firstCall(calls).url).toBe("http://tts-sidecar:9001/dev/captioned_speech");
  });

  it("prefers an explicit baseUrl option over the environment", () => {
    process.env[BASE_URL_ENV_VAR] = "http://tts-sidecar:9001";

    expect(new KokoroClient({ baseUrl: "http://elsewhere:8880" }).baseUrl).toBe(
      "http://elsewhere:8880",
    );
  });

  it("trims trailing slashes so a joined path cannot double up", async () => {
    const { fetch, calls } = recordingFetch(SPEECH_BODY);
    const client = new KokoroClient({ baseUrl: "http://localhost:8880//", fetch });

    await client.captionedSpeech({ text: "Hello.", voice: "af_heart" });

    expect(client.baseUrl).toBe("http://localhost:8880");
    expect(firstCall(calls).url).toBe("http://localhost:8880/dev/captioned_speech");
  });
});
