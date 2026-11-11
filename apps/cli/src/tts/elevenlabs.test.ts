/**
 * The ElevenLabs adapter against recorded answers: what it sends, what it refuses before sending,
 * when it asks again, and what it makes of the answer.
 *
 * The service is the only substitution. `scriptedService` answers the real `ElevenLabsClient` with
 * the bodies the live API returned on 2026-11-11 (spec §11 C12), so each case asserts the request
 * the owner would actually be billed for — the voice id in the path, whether `voice_settings` went
 * in the body — and how many of them were sent. "Zero requests" is the assertion that matters most
 * here: every refusal of a narration's own choices is free, and a test that only checked the error
 * would pass for an adapter that billed a segment first.
 */

import { DEFAULT_SAMPLE_RATE, decodeWav } from "@xplainer/render-core";
import {
  alignmentToWordTimestamps,
  type CaptionedSpeechRequest,
  ElevenLabsError,
} from "@xplainer/tts-client";
import { describe, expect, it } from "vitest";
import {
  createElevenLabsSynthesiser,
  ELEVENLABS_MAX_RETRIES,
  ELEVENLABS_RETRY_DELAYS_MS,
  type ElevenLabsSynthesiserOptions,
} from "./elevenlabs.js";
import { TtsProviderError } from "./provider.js";
import { ELEVENLABS_DEFAULT_MODEL, ELEVENLABS_DEFAULT_VOICE } from "./resolve.js";
import {
  type RecordedSpeech,
  recordedErrorBody,
  recordedSpeech,
  type ScriptedAnswer,
  type ScriptedService,
  scriptedClient,
  scriptedService,
  TEST_API_KEY,
  timeoutError,
} from "./testing/elevenlabs-fixture.js";

const SENTENCE = recordedSpeech("with-timestamps");
const OVERRUN = recordedSpeech("with-timestamps-v4-overrun");

/** A voice id that is not the configured one, so a test can tell which was sent. */
const OTHER_VOICE = "21m00Tcm4TlvDq8ikWAM";

type Harness = {
  speak(
    request: Partial<CaptionedSpeechRequest>,
  ): ReturnType<ReturnType<typeof createElevenLabsSynthesiser>["captionedSpeech"]>;
  service: ScriptedService;
  lines: string[];
  sleeps: number[];
};

/** The adapter over a scripted service, recording what it logs and how long it waited. */
function harness(
  answers: readonly ScriptedAnswer[] = [],
  recordings: readonly RecordedSpeech[] = [SENTENCE, OVERRUN],
  overrides: Partial<ElevenLabsSynthesiserOptions> = {},
): Harness {
  const service = scriptedService(recordings, answers);
  const lines: string[] = [];
  const sleeps: number[] = [];
  const synthesiser = createElevenLabsSynthesiser({
    client: scriptedClient(service),
    voice: ELEVENLABS_DEFAULT_VOICE,
    model: ELEVENLABS_DEFAULT_MODEL,
    log: (line) => {
      lines.push(line);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...overrides,
  });
  return {
    speak: (request) =>
      synthesiser.captionedSpeech({ text: SENTENCE.text, voice: "af_heart", speed: 1, ...request }),
    service,
    lines,
    sleeps,
  };
}

async function refusalOf(promise: Promise<unknown>): Promise<TtsProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TtsProviderError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a TtsProviderError and the request succeeded");
}

/** A copy of a recording whose response body is changed by `edit`. */
function edited(
  recording: RecordedSpeech,
  edit: (body: Record<string, unknown>) => Record<string, unknown>,
): ScriptedAnswer {
  return { status: 200, body: edit({ ...recording.body }) };
}

describe("the answer, in the port's envelope", () => {
  it("wraps the PCM as a 24 kHz mono 16-bit WAV, byte for byte", async () => {
    const { speak } = harness();

    const response = await speak({});
    const wav = decodeWav(Buffer.from(response.audio, "base64"));

    expect(wav.format).toEqual({ channels: 1, sampleWidth: 2, sampleRate: DEFAULT_SAMPLE_RATE });
    expect(wav.data.length).toBe(SENTENCE.audioBytes);
    expect(wav.data.subarray(0, SENTENCE.audioPrefix.length)).toEqual(SENTENCE.audioPrefix);
  });

  it("returns the alignment's words, with punctuation attached and the dash on its own", async () => {
    const { speak } = harness();

    const response = await speak({});
    const expected = alignmentToWordTimestamps(SENTENCE.alignment);

    expect(response.timestamps.map((word) => word.word)).toEqual([
      "The",
      "build",
      "failed",
      "—",
      "start",
      "again,",
      "at",
      "5",
      "dollars.",
    ]);
    // Everything but the last word is exactly as converted; the last one is the bound below.
    expect(response.timestamps.slice(0, -1)).toEqual(expected.slice(0, -1));
  });

  /**
   * Spec §11 C6, on the recording that showed it: `multilingual_v2` timed its full stop to
   * 3.158 s over 3.1579 s of audio. The word starts well inside the audio, so it is kept and its
   * end is brought back to where the audio really stops.
   */
  it("clamps a word that runs past the audio to the audio's end", async () => {
    const { speak } = harness();
    const seconds = SENTENCE.audioBytes / 2 / DEFAULT_SAMPLE_RATE;

    const last = (await speak({})).timestamps.at(-1);

    expect(last?.word).toBe("dollars.");
    expect(last?.end_time).toBe(seconds);
    expect(last?.end_time).toBeLessThan(3.158);
  });

  /** The `eleven_v4` recording: 4.88 s of alignment over 4.80 s of audio. */
  it("clamps the recorded eleven_v4 overrun to 4.80 s", async () => {
    const { speak } = harness();

    const response = await speak({ text: OVERRUN.text });
    const last = response.timestamps.at(-1);

    expect(OVERRUN.audioBytes / 2 / DEFAULT_SAMPLE_RATE).toBe(4.8);
    expect(last).toEqual({ word: "fast.", start_time: 4.16, end_time: 4.8 });
    for (const word of response.timestamps) {
      expect(word.end_time).toBeLessThanOrEqual(4.8);
    }
  });

  it("refuses a word that starts after the audio has ended", async () => {
    // The same answer with its audio cut to 4.1 s: "fast." is timed to start at 4.16 s.
    const short = Buffer.alloc(98_400 * 2).toString("base64"); // 98,400 samples at 24 kHz
    const { speak } = harness([edited(OVERRUN, (body) => ({ ...body, audio_base64: short }))]);

    const error = await refusalOf(speak({ text: OVERRUN.text }));

    expect(error.code).toBe("ALIGNMENT_OUT_OF_BOUNDS");
    expect(error.message).toContain('"fast."');
    expect(error.message).toContain("4.16");
    expect(error.message).toContain("4.1 s long");
  });

  it("refuses an alignment whose words are not the words that were sent", async () => {
    const characters = SENTENCE.alignment.characters.map((character) =>
      character === "5" ? "6" : character,
    );
    const { speak } = harness([
      edited(SENTENCE, (body) => ({ ...body, alignment: { ...SENTENCE.alignment, characters } })),
    ]);

    const error = await refusalOf(speak({}));

    expect(error.code).toBe("ALIGNMENT_MISMATCH");
    expect(error.message).toContain('word 8 was sent as "5" and timed as "6"');
  });

  it("refuses an odd number of PCM bytes, which cannot be 16-bit samples", async () => {
    const odd = Buffer.alloc(4801).toString("base64");
    const { speak } = harness([edited(SENTENCE, (body) => ({ ...body, audio_base64: odd }))]);

    const error = await refusalOf(speak({}));

    expect(error.code).toBe("AUDIO_UNUSABLE");
    expect(error.message).toContain("4801 bytes");
  });

  it("refuses empty audio", async () => {
    const { speak } = harness([edited(SENTENCE, (body) => ({ ...body, audio_base64: "" }))]);

    expect((await refusalOf(speak({}))).code).toBe("AUDIO_UNUSABLE");
  });

  /** Spec §9 AC 10: `normalized_alignment` is never read in `alignment`'s place. */
  it("refuses an answer with no alignment even when normalized_alignment is present", async () => {
    const { speak, service } = harness([
      edited(SENTENCE, (body) => ({ ...body, alignment: null })),
    ]);

    const error = await refusalOf(speak({}));

    expect(SENTENCE.body.normalized_alignment).toBeDefined();
    expect(error.code).toBe("TIMESTAMPS_MISSING");
    expect(error.message).toContain(
      `elevenlabs returned audio with no usable character timings for segment "${SENTENCE.text}"`,
    );
    // A shape refusal is not the service asking to be asked again.
    expect(service.requests).toHaveLength(1);
  });

  it("refuses an alignment whose words run backwards", async () => {
    // "build" (characters 4–8) moved to the first few milliseconds: it now ends before "The" does,
    // which spec §11 C7 refuses — overlap is allowed, a word finishing before its predecessor is not.
    const reversed = {
      ...SENTENCE.alignment,
      character_start_times_seconds: SENTENCE.alignment.character_start_times_seconds.map(
        (start, index) => (index >= 4 && index <= 8 ? start / 100 : start),
      ),
      character_end_times_seconds: SENTENCE.alignment.character_end_times_seconds.map(
        (end, index) => (index >= 4 && index <= 8 ? end / 100 : end),
      ),
    };
    const { speak } = harness([edited(SENTENCE, (body) => ({ ...body, alignment: reversed }))]);

    expect((await refusalOf(speak({}))).code).toBe("TIMESTAMPS_MISSING");
  });
});

describe("the narration's own choices, refused before anything is billed", () => {
  it("speaks render-core's default af_heart in the configured voice", async () => {
    const { speak, service, lines } = harness();

    await speak({ voice: "af_heart" });

    expect(service.requests.map((request) => request.voiceId)).toEqual([ELEVENLABS_DEFAULT_VOICE]);
    expect(lines.some((line) => line.includes("which speaks instead of"))).toBe(false);
  });

  it("uses a 20-character ElevenLabs voice id the narration names, and says so once", async () => {
    const { speak, service, lines } = harness();

    await speak({ voice: OTHER_VOICE });
    await speak({ voice: OTHER_VOICE });

    expect(service.requests[0]?.voiceId).toBe(OTHER_VOICE);
    expect(lines.filter((line) => line.includes("which speaks instead of"))).toEqual([
      `[xplainer] the narration names voice ${OTHER_VOICE}, which speaks instead of ` +
        `${ELEVENLABS_DEFAULT_VOICE}`,
    ]);
  });

  /** Spec §11 C3: refused, not substituted — a script that names a voice meant that voice. */
  it("refuses any other voice with no request sent", async () => {
    for (const voice of ["af_bella", "af_bella(2)+af_sky(1)", "JBFqnCBsd6RMkjVDRZz"]) {
      const { speak, service } = harness();

      const error = await refusalOf(speak({ voice }));

      expect(error.code, voice).toBe("VOICE_UNSUPPORTED");
      expect(error.message).toBe(
        `voice "${voice}" is not an ElevenLabs voice id. This machine speaks with ElevenLabs ` +
          `(voice ${ELEVENLABS_DEFAULT_VOICE}). Omit "voice" to use it, or pass a 20-character ` +
          "ElevenLabs voice id.",
      );
      expect(service.requests, voice).toHaveLength(0);
    }
  });

  it("sends no voice_settings at speed 1, and the model it was configured with", async () => {
    const { speak, service } = harness();

    await speak({ speed: 1 });

    expect(service.requests[0]?.body).toEqual({
      text: SENTENCE.text,
      model_id: ELEVENLABS_DEFAULT_MODEL,
    });
    expect(service.requests[0]?.headers["xi-api-key"]).toBe(TEST_API_KEY);
  });

  it("sends a speed inside 0.7–1.2 as voice_settings.speed", async () => {
    const { speak, service } = harness();

    await speak({ speed: 0.9 });

    expect(service.requests[0]?.body.voice_settings).toEqual({ speed: 0.9 });
  });

  it("refuses a speed outside 0.7–1.2 with no request sent", async () => {
    for (const speed of [1.5, 0.5, 4]) {
      const { speak, service } = harness();

      const error = await refusalOf(speak({ speed }));

      expect(error.code, String(speed)).toBe("SPEED_UNSUPPORTED");
      expect(error.message).toContain(`speed ${speed}`);
      expect(error.message).toContain("0.7 to 1.2");
      expect(service.requests).toHaveLength(0);
    }
  });

  it("does not send a Kokoro langCode, and says so once", async () => {
    const { speak, service, lines } = harness();

    await speak({ langCode: "a" });
    await speak({ langCode: "a", text: OVERRUN.text });

    expect(service.requests.map((request) => Object.keys(request.body))).toEqual([
      ["text", "model_id"],
      ["text", "model_id"],
    ]);
    expect(lines.filter((line) => line.includes("langCode"))).toHaveLength(1);
  });
});

describe("retries", () => {
  const busy: ScriptedAnswer = {
    status: 429,
    body: { detail: { status: "system_busy", message: "busy, try again" } },
  };
  const down: ScriptedAnswer = { status: 503, body: "upstream unavailable" };

  it("asks again after a 429, once, logging the retry and waiting a second", async () => {
    const { speak, service, lines, sleeps } = harness([busy]);

    const response = await speak({});

    expect(response.timestamps).toHaveLength(9);
    expect(service.requests).toHaveLength(2);
    expect(sleeps).toEqual([1_000]);
    expect(lines).toEqual([
      "[xplainer] elevenlabs answered 429 system_busy; asking again in 1 s (attempt 2 of 3)",
    ]);
  });

  it("gives up after three attempts, having waited 1 s and then 4 s", async () => {
    const { speak, service, lines, sleeps } = harness([down, down, down]);

    const error = await refusalOf(speak({}));

    expect(ELEVENLABS_MAX_RETRIES).toBe(2);
    expect(service.requests).toHaveLength(3);
    expect(sleeps).toEqual([...ELEVENLABS_RETRY_DELAYS_MS]);
    expect(lines).toHaveLength(2);
    expect(error.code).toBe("PROVIDER_REJECTED");
    expect(error.message).toContain("after 3 attempts");
    expect(error.message).toContain("503");
  });

  /** Spec §11 C8: an unanswered request may already have been billed. */
  it("never asks again after a timeout or a transport failure", async () => {
    for (const thrown of [timeoutError(), new TypeError("fetch failed")]) {
      const { speak, service, sleeps } = harness([{ thrown }]);

      const error = await refusalOf(speak({}));

      expect(error.code, thrown.name).toBe("PROVIDER_UNREACHABLE");
      expect(error.message).toContain("not retried");
      expect(error.message).toContain("re-run explainer_narrate");
      expect(service.requests).toHaveLength(1);
      expect(sleeps).toEqual([]);
    }
  });

  it("refuses a bad key after one request, in the words the job log uses", async () => {
    const { speak, service } = harness([{ status: 401, body: recordedErrorBody(401) }]);

    const error = await refusalOf(speak({}));

    expect(service.requests).toHaveLength(1);
    expect(error.code).toBe("PROVIDER_REJECTED");
    expect(error.message).toBe(
      "elevenlabs refused the API key (401 invalid_api_key). Replace it with " +
        "`xplainer config set tts.elevenlabs.api_key`.",
    );
  });

  it("treats a 400 invalid_api_key as a bad key too, which is how a malformed key is answered", async () => {
    // Measured against the live API on 2026-11-11: a key of the wrong shape is a 400, not a 401.
    const { speak, service } = harness([
      {
        status: 400,
        body: { detail: { status: "invalid_api_key", message: "API key is invalid." } },
      },
    ]);

    const error = await refusalOf(speak({}));

    expect(service.requests).toHaveLength(1);
    expect(error.code).toBe("PROVIDER_REJECTED");
    expect(error.message).toBe(
      "elevenlabs refused the API key (400 invalid_api_key). Replace it with " +
        "`xplainer config set tts.elevenlabs.api_key`.",
    );
  });

  it("says the account is out of credits on a 402, and that nothing was written", async () => {
    const { speak, service } = harness([
      { status: 402, body: { detail: { status: "insufficient_credits", message: "no" } } },
    ]);

    const error = await refusalOf(speak({}));

    expect(service.requests).toHaveLength(1);
    expect(error.message).toBe(
      "the ElevenLabs account has no credits left (402 insufficient_credits). Segments already " +
        "spoken in this run were billed; nothing was written.",
    );
  });

  it("names the setting to change for an unknown voice or model, after one request", async () => {
    const voice = harness([{ status: 404, body: recordedErrorBody(404) }]);
    const voiceError = await refusalOf(voice.speak({}));
    expect(voice.service.requests).toHaveLength(1);
    expect(voiceError.message).toContain("404 voice_not_found");
    expect(voiceError.message).toContain("tts.elevenlabs.voice");

    const model = harness([{ status: 400, body: recordedErrorBody(400) }]);
    const modelError = await refusalOf(model.speak({}));
    expect(model.service.requests).toHaveLength(1);
    expect(modelError.message).toContain("400 model_not_found");
    expect(modelError.message).toContain("tts.elevenlabs.model");
  });
});

describe("the key", () => {
  it("is taken out of anything thrown or logged, by the redactor it is given", async () => {
    const lines: string[] = [];
    const leaky = {
      calls: 0,
      async timestampedSpeech(): Promise<never> {
        leaky.calls += 1;
        throw leaky.calls === 1
          ? new ElevenLabsError(`busy for ${TEST_API_KEY}`, 503, `code_${TEST_API_KEY}`)
          : new ElevenLabsError(`a proxy echoed ${TEST_API_KEY}`, 400, "bad_request");
      },
    };
    const synthesiser = createElevenLabsSynthesiser({
      client: leaky,
      voice: ELEVENLABS_DEFAULT_VOICE,
      model: ELEVENLABS_DEFAULT_MODEL,
      log: (line) => {
        lines.push(line);
      },
      sleep: async () => {},
      redact: (text) => text.replaceAll(TEST_API_KEY, "[redacted]"),
    });

    const error = await refusalOf(
      synthesiser.captionedSpeech({ text: SENTENCE.text, voice: "af_heart" }),
    );

    expect(error.message).not.toContain(TEST_API_KEY);
    expect(error.message).toContain("a proxy echoed [redacted]");
    expect(lines.join("\n")).not.toContain(TEST_API_KEY);
    expect(lines.join("\n")).toContain("[redacted]");
  });
});
