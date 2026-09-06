import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Narration } from "@xplainer/protocol";
import type { WordTimestamp } from "@xplainer/tts-client";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { buildCaptions } from "./captions.js";
import { planSegments, type SegmentSpeech } from "./plan.js";

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

  it("leaves only the very first caption of the track bare", () => {
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
