/**
 * The admissibility rule, at both of the points it is enforced: a descriptor that declares no
 * timestamps cannot be admitted, and a remote answer with words in it and no spans cannot pass.
 *
 * The registry is asserted entry by entry rather than trusted, because the rule's force is that a
 * provider declared dishonestly — or honestly as `"none"` — fails here, in the build, instead of in
 * the log of a narration that produced a video with no captions.
 */

import type { SpeechSynthesiser } from "@xplainer/render-core";
import type { CaptionedSpeechResponse } from "@xplainer/tts-client";
import { describe, expect, it } from "vitest";
import {
  admitProvider,
  DEFAULT_TTS_PROVIDER,
  isTtsProviderId,
  PROVIDER_ADMISSIBILITY_RULE,
  parseProviderId,
  requireWordSpans,
  TTS_PROVIDER_IDS,
  TTS_PROVIDERS,
  TtsProviderError,
  unknownProviderProblem,
} from "./provider.js";

/** A synthesiser that answers every request with `response`, and counts the requests. */
function answering(response: CaptionedSpeechResponse): SpeechSynthesiser & { calls: number } {
  const synthesiser = {
    calls: 0,
    captionedSpeech: async () => {
      synthesiser.calls += 1;
      return response;
    },
  };
  return synthesiser;
}

function caught(run: () => unknown): TtsProviderError {
  try {
    run();
  } catch (error) {
    if (error instanceof TtsProviderError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a TtsProviderError and nothing was thrown");
}

describe("the provider registry", () => {
  it("admits every provider it declares, and declares one for every id", () => {
    expect(Object.keys(TTS_PROVIDERS).sort()).toEqual([...TTS_PROVIDER_IDS].sort());
    for (const id of TTS_PROVIDER_IDS) {
      const descriptor = TTS_PROVIDERS[id];
      expect(descriptor.id).toBe(id);
      expect(() => admitProvider(descriptor), id).not.toThrow();
    }
  });

  it("speaks with the built-in Kokoro voice when nobody configured anything", () => {
    expect(DEFAULT_TTS_PROVIDER).toBe("kokoro");
    expect(TTS_PROVIDERS.kokoro).toMatchObject({ remote: false, billed: false });
  });

  it("declares ElevenLabs as remote, billed and character-timed", () => {
    expect(TTS_PROVIDERS.elevenlabs).toEqual({
      id: "elevenlabs",
      timestamps: "character",
      remote: true,
      billed: true,
    });
  });

  it("refuses a descriptor that returns no timestamps with its audio", () => {
    const error = caught(() =>
      admitProvider({ id: "audio-only", timestamps: "none", remote: true, billed: true }),
    );

    expect(error.code).toBe("PROVIDER_INADMISSIBLE");
    expect(error.message).toContain('"audio-only"');
    expect(error.message).toContain(PROVIDER_ADMISSIBILITY_RULE);
  });
});

describe("parseProviderId", () => {
  it("answers a known provider as itself", () => {
    expect(parseProviderId("kokoro", "XPLAINER_TTS_PROVIDER")).toBe("kokoro");
    expect(parseProviderId("elevenlabs", "XPLAINER_TTS_PROVIDER")).toBe("elevenlabs");
    expect(isTtsProviderId("elevenlabs")).toBe(true);
    expect(isTtsProviderId("ElevenLabs")).toBe(false);
  });

  it("refuses an unknown one with the admissibility sentence and where it was read", () => {
    const error = caught(() => parseProviderId("openai", "/state/config.json (tts.provider)"));

    expect(error.code).toBe("PROVIDER_UNKNOWN");
    expect(error.message).toBe(
      'speech provider "openai" is not one this build knows. Admissible providers: kokoro, ' +
        "elevenlabs. A provider is admissible only if it returns word or character timestamps " +
        "with its audio. It was read from /state/config.json (tts.provider).",
    );
  });

  /** `config set` refuses with this sentence too, so a typo reads the same at both ends. */
  it("starts its refusal with the sentence config set uses", () => {
    expect(caught(() => parseProviderId("openai", "X")).message).toContain(
      unknownProviderProblem("openai"),
    );
  });

  /** The sentence is printed and logged, so a key exported or pasted as the provider is not. */
  it("describes an API key given as the provider rather than repeating it", () => {
    const key = "sk_0123456789abcdef0123456789abcdef0123456789abcdef";
    const message = caught(() => parseProviderId(key, "XPLAINER_TTS_PROVIDER")).message;

    expect(message).toContain("speech provider a value beginning sk_");
    expect(message).not.toContain(key);
  });
});

describe("requireWordSpans", () => {
  it("refuses a segment with words in it that came back with no spans", async () => {
    const inner = answering({ audio: "UklGRg==", timestamps: [] });

    const wrapped = requireWordSpans(inner, "elevenlabs");

    await expect(
      wrapped.captionedSpeech({ text: "The build failed.", voice: "af_heart" }),
    ).rejects.toMatchObject({ code: "TIMESTAMPS_MISSING" });
    await expect(
      wrapped.captionedSpeech({ text: "The build failed.", voice: "af_heart" }),
    ).rejects.toThrow(
      /elevenlabs returned audio with no word timings for segment "The build failed\."/,
    );
  });

  it("refuses digits on their own too: a number is spoken", async () => {
    const wrapped = requireWordSpans(answering({ audio: "", timestamps: [] }), "elevenlabs");

    await expect(wrapped.captionedSpeech({ text: "42", voice: "af_heart" })).rejects.toMatchObject({
      code: "TIMESTAMPS_MISSING",
    });
  });

  it("passes punctuation with no spans, because there is no word to caption", async () => {
    const response = { audio: "UklGRg==", timestamps: [] };
    const wrapped = requireWordSpans(answering(response), "elevenlabs");

    await expect(wrapped.captionedSpeech({ text: "—", voice: "af_heart" })).resolves.toBe(response);
  });

  it("passes an answer that carries spans through unchanged", async () => {
    const response = {
      audio: "UklGRg==",
      timestamps: [{ word: "Hello", start_time: 0, end_time: 0.4 }],
    };
    const inner = answering(response);

    await expect(
      requireWordSpans(inner, "elevenlabs").captionedSpeech({ text: "Hello", voice: "af_heart" }),
    ).resolves.toBe(response);
    expect(inner.calls).toBe(1);
  });
});
