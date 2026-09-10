import type { WordSpan } from "@xplainer/render-core";
import { phonemise } from "@xplainer/render-core";
import { describe, expect, it } from "vitest";
import { deriveWordTimings } from "./timing.js";
import { tokenisePhonemes } from "./tokens.js";

const SAMPLE_RATE = 24000;

/** A durations array of the right length: one entry per token, `units` each. */
function flatDurations(count: number, units = 40): Float32Array {
  return Float32Array.from({ length: count }, () => units);
}

describe("deriveWordTimings", () => {
  const spoken = phonemise("The cached value was stale.");
  const tokens = tokenisePhonemes(spoken.ipa);
  const durations = flatDurations(tokens.ids.length);
  const totalUnits = tokens.ids.length * 40;

  it("derives the samples-per-unit from the run rather than from a constant", () => {
    // The published figure for this model is `duration / 80`; the spike measured ≈592 samples per
    // unit, a divisor of ≈40, and the ratio then moves by 79% across the speaking-rate range. So
    // the same tokens with the same durations over twice the audio must yield twice the ratio —
    // which is what makes the emitted timings agree with the emitted audio at any rate.
    const single = deriveWordTimings({
      tokens,
      durations,
      words: spoken.words,
      sampleCount: totalUnits * 592,
      sampleRate: SAMPLE_RATE,
    });
    const doubled = deriveWordTimings({
      tokens,
      durations,
      words: spoken.words,
      sampleCount: totalUnits * 1184,
      sampleRate: SAMPLE_RATE,
    });

    expect(single.samplesPerUnit).toBeCloseTo(592, 6);
    expect(doubled.samplesPerUnit).toBeCloseTo(1184, 6);
    expect(doubled.seconds).toBeCloseTo(single.seconds * 2, 6);
  });

  it("times every word monotonically, without overlap, inside the audio", () => {
    const derived = deriveWordTimings({
      tokens,
      durations,
      words: spoken.words,
      sampleCount: totalUnits * 592,
      sampleRate: SAMPLE_RATE,
    });

    expect(derived.timestamps).toHaveLength(spoken.words.length);
    let previous = 0;
    for (const timing of derived.timestamps) {
      expect(timing.end_time).toBeGreaterThan(timing.start_time);
      expect(timing.start_time).toBeGreaterThanOrEqual(previous);
      previous = timing.end_time;
    }
    expect(previous).toBeLessThanOrEqual(derived.seconds);
  });

  it("attributes a word exactly the tokens its span covers", () => {
    const spans: WordSpan[] = [
      { word: "kæt", start: 0, end: 3, source: "cmudict" },
      { word: "sæt", start: 4, end: 7, source: "cmudict" },
    ];
    const two = tokenisePhonemes("kæt sæt");
    const derived = deriveWordTimings({
      tokens: two,
      durations: flatDurations(two.ids.length),
      words: spans,
      sampleCount: two.ids.length * 40 * 592,
      sampleRate: SAMPLE_RATE,
    });

    // Nine tokens: two pads, six phonemes, one space, 40 units each at 592 samples per unit.
    const perToken = (40 * 592) / SAMPLE_RATE;
    expect(derived.timestamps[0]?.start_time).toBeCloseTo(perToken, 6);
    expect(derived.timestamps[0]?.end_time).toBeCloseTo(perToken * 4, 6);
    // The space between the words belongs to no word, which is the invariant `narrate/plan.ts`
    // depends on: a caption stretched across real silence reads as lag.
    expect(derived.timestamps[1]?.start_time).toBeCloseTo(perToken * 5, 6);
  });

  it("refuses a durations array that does not align with the tokens that were fed", () => {
    expect(() =>
      deriveWordTimings({
        tokens,
        durations: flatDurations(tokens.ids.length - 1),
        words: spoken.words,
        sampleCount: totalUnits * 592,
        sampleRate: SAMPLE_RATE,
      }),
    ).toThrow(/One duration per token/);
  });

  it("refuses a duration that is not a length", () => {
    const broken = flatDurations(tokens.ids.length);
    broken[3] = Number.NaN;

    expect(() =>
      deriveWordTimings({
        tokens,
        durations: broken,
        words: spoken.words,
        sampleCount: totalUnits * 592,
        sampleRate: SAMPLE_RATE,
      }),
    ).toThrow(/which cannot be a length/);

    const negative = flatDurations(tokens.ids.length);
    negative[3] = -1;
    expect(() =>
      deriveWordTimings({
        tokens,
        durations: negative,
        words: spoken.words,
        sampleCount: totalUnits * 592,
        sampleRate: SAMPLE_RATE,
      }),
    ).toThrow(/which cannot be a length/);
  });

  it("refuses durations that sum to zero, and a clip with no samples", () => {
    expect(() =>
      deriveWordTimings({
        tokens,
        durations: flatDurations(tokens.ids.length, 0),
        words: spoken.words,
        sampleCount: totalUnits * 592,
        sampleRate: SAMPLE_RATE,
      }),
    ).toThrow(/sum to zero/);

    expect(() =>
      deriveWordTimings({
        tokens,
        durations,
        words: spoken.words,
        sampleCount: 0,
        sampleRate: SAMPLE_RATE,
      }),
    ).toThrow(/no clip to time words against/);
  });

  it("refuses an array whose units are not durations at all", () => {
    // Two ways for the array to mean something else: seconds (≈24,000 samples per unit) and
    // milliseconds (≈24). Both would produce timings that look like times and are not.
    const seconds = Float32Array.from({ length: tokens.ids.length }, () => 0.05);
    expect(() =>
      deriveWordTimings({
        tokens,
        durations: seconds,
        words: spoken.words,
        sampleCount: 24000 * 2,
        sampleRate: SAMPLE_RATE,
      }),
    ).toThrow(/samples per unit, outside the/);

    const milliseconds = Float32Array.from({ length: tokens.ids.length }, () => 50);
    expect(() =>
      deriveWordTimings({
        tokens,
        durations: milliseconds,
        words: spoken.words,
        sampleCount: 1200,
        sampleRate: SAMPLE_RATE,
      }),
    ).toThrow(/samples per unit, outside the/);
  });

  it("refuses a word whose span holds no token, rather than emitting a caption with no length", () => {
    expect(() =>
      deriveWordTimings({
        tokens,
        durations,
        words: [{ word: "ghost", start: 3, end: 3, source: "lexicon" }],
        sampleCount: totalUnits * 592,
        sampleRate: SAMPLE_RATE,
      }),
    ).toThrow(/hold no token/);
  });

  it("refuses overlapping spans, which would attribute the same audio twice", () => {
    const two = tokenisePhonemes("kæt sæt");
    expect(() =>
      deriveWordTimings({
        tokens: two,
        durations: flatDurations(two.ids.length),
        words: [
          { word: "kæt", start: 0, end: 3, source: "cmudict" },
          { word: "æts", start: 1, end: 5, source: "cmudict" },
        ],
        sampleCount: two.ids.length * 40 * 592,
        sampleRate: SAMPLE_RATE,
      }),
    ).toThrow(/more than one word span/);
  });

  it("refuses spans that run backwards, because the planner reads them in order", () => {
    const two = tokenisePhonemes("kæt sæt");
    expect(() =>
      deriveWordTimings({
        tokens: two,
        durations: flatDurations(two.ids.length),
        words: [
          { word: "sæt", start: 4, end: 7, source: "cmudict" },
          { word: "kæt", start: 0, end: 3, source: "cmudict" },
        ],
        sampleCount: two.ids.length * 40 * 592,
        sampleRate: SAMPLE_RATE,
      }),
    ).toThrow(/before the previous word ended/);
  });

  it("accounts for the whole clip: every word, plus the units no word claimed", () => {
    const derived = deriveWordTimings({
      tokens,
      durations,
      words: spoken.words,
      sampleCount: totalUnits * 592,
      sampleRate: SAMPLE_RATE,
    });

    let spokenSeconds = 0;
    for (const timing of derived.timestamps) {
      spokenSeconds += timing.end_time - timing.start_time;
    }
    // Words never cover the whole clip — the pads, the spaces and the full stop are outside every
    // span — but they may never exceed it either.
    expect(spokenSeconds).toBeGreaterThan(derived.seconds * 0.5);
    expect(spokenSeconds).toBeLessThan(derived.seconds);
  });
});
