import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Narration } from "@xplainer/protocol";
import type { WordTimestamp } from "@xplainer/tts-client";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { buildCaptions } from "./captions.js";
import { type PlannedSegment, type PlannedWord, planSegments, type SegmentSpeech } from "./plan.js";

/**
 * The caption boundary between two adjacent segments.
 *
 * `@remotion/captions` builds a page by concatenating its tokens' `text`, and
 * it cuts a new page by elapsed time — never at a segment boundary, which it
 * cannot see. Two spoken segments therefore routinely share one page, so the
 * first word of a segment needs its leading space no less than every other word
 * does. Without it the burned caption read `segment one.Segment two`, which is
 * what this file exists to keep from coming back.
 *
 * The fixture is deliberately the smallest thing that can show it: two spoken
 * segments whose words spell the string the assertion names.
 */

const require = createRequire(import.meta.url);
const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "fixtures",
  "narrate",
);

/** The rate the plans below quantise their silence to. */
const RATE = 24000;

/** Each fixture segment's measured length, comfortably past its last word. */
const SPOKEN_MS = 900;

const ajv = new Ajv2020({ allErrors: true });
const validateCaptions = ajv.compile(
  JSON.parse(readFileSync(require.resolve("@xplainer/protocol/schemas/captions.json"), "utf8")),
);

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;
}

function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(`the fixture has no item at index ${index}`);
  }
  return value;
}

const adjacent = readJson<Narration>("adjacent.json");
const oneWords = readJson<WordTimestamp[]>("one-words.json");
const twoWords = readJson<WordTimestamp[]>("two-words.json");

/** The two measured segments of `adjacent.json`, both spoken. */
function measuredSpeech(): SegmentSpeech[] {
  return [
    { spokenMs: SPOKEN_MS, words: oneWords },
    { spokenMs: SPOKEN_MS, words: twoWords },
  ];
}

/** What a `@remotion/captions` page shows: the tokens, concatenated. */
function joined(captions: readonly { readonly text: string }[]): string {
  return captions.map((caption) => caption.text).join("");
}

describe("buildCaptions — the boundary between two segments", () => {
  it("separates the last word of one segment from the first word of the next", () => {
    const plan = planSegments(adjacent, measuredSpeech(), RATE);
    const captions = buildCaptions(plan.segments);

    expect(joined(captions)).toContain("one. Segment");
    expect(joined(captions)).not.toContain("one.Segment");
  });

  it("gives the first word of the second segment its leading space", () => {
    const plan = planSegments(adjacent, measuredSpeech(), RATE);
    const captions = buildCaptions(plan.segments);

    // Four captions, not six: each segment's trailing "." folds into the word
    // before it, and that fold never reaches back across the boundary.
    expect(captions).toHaveLength(4);
    expect(at(captions, 0).text).toBe("Segment");
    expect(at(captions, 1).text).toBe(" one.");
    expect(at(captions, 2).text).toBe(" Segment");
    expect(at(captions, 3).text).toBe(" two.");
  });

  it("leaves only the very first caption bare, on a track whose tokens are all words", () => {
    const plan = planSegments(adjacent, measuredSpeech(), RATE);
    const captions = buildCaptions(plan.segments);

    expect(at(captions, 0).text.startsWith(" ")).toBe(false);
    for (const caption of captions.slice(1)) {
      expect(caption.text.startsWith(" ")).toBe(true);
    }
  });

  it("keeps the boundary caption's own span, silence and all", () => {
    const plan = planSegments(adjacent, measuredSpeech(), RATE);
    const captions = buildCaptions(plan.segments);
    const lastOfFirst = at(captions, 1);
    const firstOfSecond = at(captions, 2);

    // The space is a text separator, never a timing one: the second segment
    // still starts where the plan puts it, past the first segment's tail and
    // the gap between them.
    expect(firstOfSecond.startMs).toBe(at(at(plan.segments, 1).words, 0).startMs);
    expect(firstOfSecond.startMs).toBeGreaterThan(lastOfFirst.endMs);
  });

  it("still validates against packages/protocol's captions schema", () => {
    const plan = planSegments(adjacent, measuredSpeech(), RATE);
    const captions = buildCaptions(plan.segments);

    expect(validateCaptions(captions), JSON.stringify(validateCaptions.errors)).toBe(true);
  });
});

/**
 * The other boundary case, and the one US-012's fix got wrong.
 *
 * Kokoro timestamps a comma as its own token, so a narration segment that
 * *begins* with one — `"Alpha"` then `", beta"` — hands `buildCaptions` a
 * punctuation token in first position. The fold cannot take it: folding reaches
 * back into the previous segment, whose last word is a whole inter-segment gap
 * away, and the previous caption would stay on screen through that silence. So
 * it is emitted as its own caption, and the leading space every *word* gets
 * would render `"Alpha , beta"` — which is what this block exists to keep from
 * coming back, without giving up the separation `"one. Segment"` needs.
 *
 * These plans are spelled out rather than measured: the property is about token
 * text and one boundary, and a fixture would bury both.
 */

/** How long every token below is spoken for. */
const TOKEN_MS = 200;

/** The silence between two of these segments — wide enough to be visible. */
const SEGMENT_GAP_MS = 700;

/** The fields `buildCaptions` reads, wrapped around word spans a case chose. */
function plannedSegment(index: number, words: readonly PlannedWord[]): PlannedSegment {
  const first = words[0];
  const last = words[words.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error("a planned segment needs at least one word");
  }
  return {
    id: `segment-${index + 1}`,
    index,
    startMs: first.startMs,
    endMs: last.endMs,
    from: 0,
    durationInFrames: 1,
    words,
    trailingSilenceSamples: 0,
  };
}

/** Tokens laid end to end, one `PlannedSegment` per array, a real gap between them. */
function planFromTokens(tokensPerSegment: readonly (readonly string[])[]): PlannedSegment[] {
  let cursor = 0;
  return tokensPerSegment.map((tokens, index) => {
    const words = tokens.map((text) => {
      const startMs = cursor;
      cursor += TOKEN_MS;
      return { text, startMs, endMs: cursor };
    });
    cursor += SEGMENT_GAP_MS;
    return plannedSegment(index, words);
  });
}

describe("buildCaptions — a segment whose first token is punctuation", () => {
  it('reads "Alpha, beta", never "Alpha , beta"', () => {
    const captions = buildCaptions(planFromTokens([["Alpha"], [",", "beta"]]));

    expect(joined(captions)).toBe("Alpha, beta");
    expect(joined(captions)).not.toContain(" ,");
    expect(captions.map((caption) => caption.text)).toEqual(["Alpha", ",", " beta"]);
  });

  it("keeps that token's own span instead of stretching the caption before it", () => {
    const captions = buildCaptions(planFromTokens([["Alpha"], [",", "beta"]]));
    const alpha = at(captions, 0);
    const comma = at(captions, 1);

    // The fold would have moved `alpha.endMs` to 1100, holding "Alpha" on
    // screen through 700 ms of silence it was never spoken over.
    expect(alpha.endMs).toBe(TOKEN_MS);
    expect(comma.startMs).toBe(TOKEN_MS + SEGMENT_GAP_MS);
    expect(comma.endMs).toBe(TOKEN_MS + SEGMENT_GAP_MS + TOKEN_MS);
  });

  it('still separates two words across the same boundary: "one. Segment"', () => {
    const captions = buildCaptions(planFromTokens([["one", "."], ["Segment"]]));

    expect(joined(captions)).toBe("one. Segment");
    expect(joined(captions)).not.toContain("one.Segment");
    expect(captions.map((caption) => caption.text)).toEqual(["one.", " Segment"]);
  });

  it("validates against packages/protocol's captions schema with a bare token in it", () => {
    const captions = buildCaptions(planFromTokens([["Alpha"], [",", "beta"]]));

    expect(validateCaptions(captions), JSON.stringify(validateCaptions.errors)).toBe(true);
  });
});
