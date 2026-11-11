import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { alignmentToWordTimestamps } from "./alignment";
import { ElevenLabsError } from "./client";
import type { ElevenLabsAlignment } from "./types";

/** The two recorded responses (`test/fixtures/elevenlabs/`), each with the request that produced it. */
type RecordedSpeech = {
  readonly provenance: string;
  readonly request: { readonly text: string; readonly model_id: string };
  readonly audio_bytes: number;
  readonly response: { readonly alignment: ElevenLabsAlignment };
};

function recorded(name: string): RecordedSpeech {
  const path = fileURLToPath(new URL(`../../test/fixtures/elevenlabs/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as RecordedSpeech;
}

const MULTILINGUAL = recorded("with-timestamps.json");
const V4_OVERRUN = recorded("with-timestamps-v4-overrun.json");

/** Build an alignment from `[character, start, end]` triples, so a case reads as a timeline. */
function alignmentOf(spans: readonly (readonly [string, number, number])[]): ElevenLabsAlignment {
  return {
    characters: spans.map(([character]) => character),
    character_start_times_seconds: spans.map(([, start]) => start),
    character_end_times_seconds: spans.map(([, , end]) => end),
  };
}

/** One character per 0.1 s, so a whitespace case asserts the split and nothing about the times. */
function evenlyTimed(text: string): ElevenLabsAlignment {
  return alignmentOf(
    Array.from(text, (character, index) => [character, index / 10, (index + 1) / 10] as const),
  );
}

function refusal(alignment: ElevenLabsAlignment): ElevenLabsError {
  try {
    alignmentToWordTimestamps(alignment);
  } catch (error) {
    if (error instanceof ElevenLabsError) {
      return error;
    }
    throw error;
  }
  throw new Error("the alignment was accepted");
}

describe("alignmentToWordTimestamps on the recorded multilingual_v2 response", () => {
  const alignment = MULTILINGUAL.response.alignment;
  const words = alignmentToWordTimestamps(alignment);

  it("was recorded from the live API over exactly the text it was sent", () => {
    expect(MULTILINGUAL.provenance).toBe("recorded");
    expect(alignment.characters.join("")).toBe(MULTILINGUAL.request.text);
  });

  it("gives one word per whitespace-separated token, punctuation attached and the dash on its own", () => {
    expect(words.map((span) => span.word)).toEqual([
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
  });

  it("starts each word at its first character's start and ends it at its last character's end", () => {
    const text = alignment.characters.join("");
    const tokens = [...text.matchAll(/\S+/gu)];
    expect(tokens).toHaveLength(words.length);

    for (const [index, token] of tokens.entries()) {
      // One element per UTF-16 unit in this recording, the em dash included, so a string index
      // is an alignment index.
      const first = token.index;
      const last = first + token[0].length - 1;
      expect(words[index]).toEqual({
        word: token[0],
        start_time: alignment.character_start_times_seconds[first],
        end_time: alignment.character_end_times_seconds[last],
      });
    }
  });

  it("never ends a word where the next one starts when a space sits between them", () => {
    for (let index = 0; index + 1 < words.length; index += 1) {
      const word = words[index];
      const next = words[index + 1];
      expect(word?.end_time).not.toBe(next?.start_time);
      expect(word?.end_time ?? 0).toBeLessThan(next?.start_time ?? 0);
    }
  });
});

describe("alignmentToWordTimestamps on the recorded eleven_v4 overrun", () => {
  it("returns the times as measured, including a last word that ends after the audio does", () => {
    const words = alignmentToWordTimestamps(V4_OVERRUN.response.alignment);
    const audioSeconds = V4_OVERRUN.audio_bytes / 2 / 24000;

    expect(words.map((span) => span.word)).toEqual([
      "The",
      "cache",
      "misses",
      "twice,",
      "then",
      "3",
      "workers",
      "retry",
      "—",
      "fast.",
    ]);
    // 4.80 s of audio, 4.88 s of alignment. Bounding against the audio is the caller's job, because
    // only the caller has decoded it; this function does not clamp.
    expect(audioSeconds).toBe(4.8);
    expect(words.at(-1)?.end_time).toBe(4.88);
  });
});

describe("alignmentToWordTimestamps word splitting", () => {
  it("ignores leading, trailing and repeated whitespace", () => {
    const words = alignmentToWordTimestamps(evenlyTimed("  two   words  "));

    expect(words.map((span) => span.word)).toEqual(["two", "words"]);
    expect(words[0]).toEqual({ word: "two", start_time: 0.2, end_time: 0.5 });
  });

  it("returns a single word for text with no whitespace", () => {
    expect(alignmentToWordTimestamps(evenlyTimed("Hello."))).toEqual([
      { word: "Hello.", start_time: 0, end_time: 0.6 },
    ]);
  });

  it("treats a newline and a tab as separators", () => {
    const words = alignmentToWordTimestamps(evenlyTimed("one\ntwo\tthree"));

    expect(words.map((span) => span.word)).toEqual(["one", "two", "three"]);
  });

  it("returns no words for an alignment that is only whitespace", () => {
    expect(alignmentToWordTimestamps(evenlyTimed(" \n "))).toEqual([]);
  });
});

describe("alignmentToWordTimestamps refusals", () => {
  it("refuses an alignment with no characters", () => {
    expect(refusal(alignmentOf([])).message).toMatch(/no characters/);
  });

  it("refuses arrays of different lengths", () => {
    const short = {
      characters: ["a", "b"],
      character_start_times_seconds: [0, 0.1],
      character_end_times_seconds: [0.1],
    };

    expect(refusal(short).message).toMatch(/2 characters, 2 start times, 1 end times/);
  });

  it("refuses a time that is not a finite number", () => {
    expect(refusal(alignmentOf([["a", Number.NaN, 0.1]])).message).toMatch(/not a finite number/);
    expect(refusal(alignmentOf([["a", 0, Number.POSITIVE_INFINITY]])).message).toMatch(
      /not a finite number/,
    );
  });

  it("refuses a negative start", () => {
    expect(refusal(alignmentOf([["a", -0.01, 0.1]])).message).toMatch(/character 0 \("a"\)/);
  });

  it("refuses a character that ends before it starts", () => {
    const error = refusal(
      alignmentOf([
        ["o", 0, 0.1],
        ["k", 0.3, 0.2],
      ]),
    );

    expect(error.message).toMatch(/character 1 \("k"\) ends at 0.2 s, before it starts at 0.3 s/);
  });

  it("refuses a word whose characters run backwards, checking the word once it is assembled", () => {
    // Each character is a valid span on its own; the word they make ends before it starts.
    const error = refusal(
      alignmentOf([
        ["n", 0.5, 0.6],
        ["o", 0.1, 0.2],
      ]),
    );

    expect(error.message).toMatch(/word 0 \("no"\) ends at 0.2 s, before it starts at 0.5 s/);
  });

  it("refuses a word that starts before the word in front of it starts", () => {
    const error = refusal(
      alignmentOf([
        ["a", 0.5, 0.6],
        [" ", 0.6, 0.7],
        ["b", 0.4, 0.8],
      ]),
    );

    expect(error.message).toMatch(/word 1 \("b"\) starts at 0.4 s, before word 0/);
  });

  it("refuses a word that ends before the word in front of it ends", () => {
    const error = refusal(
      alignmentOf([
        ["a", 0, 0.9],
        [" ", 0.9, 0.9],
        ["b", 0.2, 0.5],
      ]),
    );

    expect(error.message).toMatch(/word 1 \("b"\) ends at 0.5 s, before word 0/);
  });

  it("refuses with a shape failure: alignment_invalid, no status, not retryable", () => {
    const error = refusal(alignmentOf([]));

    expect(error).toBeInstanceOf(ElevenLabsError);
    expect(error.code).toBe("alignment_invalid");
    expect(error.status).toBeUndefined();
    expect(error.retryable).toBe(false);
  });
});

describe("alignmentToWordTimestamps tolerances", () => {
  it("accepts words with equal timestamps", () => {
    const words = alignmentToWordTimestamps(
      alignmentOf([
        ["a", 0.2, 0.2],
        [" ", 0.2, 0.2],
        ["b", 0.2, 0.2],
      ]),
    );

    expect(words).toEqual([
      { word: "a", start_time: 0.2, end_time: 0.2 },
      { word: "b", start_time: 0.2, end_time: 0.2 },
    ]);
  });

  it("accepts a word that starts before the word in front of it has ended", () => {
    const words = alignmentToWordTimestamps(
      alignmentOf([
        ["a", 0, 0.5],
        [" ", 0.3, 0.4],
        ["b", 0.4, 0.6],
      ]),
    );

    expect(words).toEqual([
      { word: "a", start_time: 0, end_time: 0.5 },
      { word: "b", start_time: 0.4, end_time: 0.6 },
    ]);
  });
});
