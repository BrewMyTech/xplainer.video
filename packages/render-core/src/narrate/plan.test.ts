import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Narration } from "@xplainer/protocol";
import type { WordTimestamp } from "@xplainer/tts-client";
import { describe, expect, it } from "vitest";
import { buildCaptions } from "./captions.js";
import { NarrationError } from "./errors.js";
import { GAP_MS, LEAD_IN_MS, TAIL_MS } from "./pacing.js";
import { planSegments, type SegmentSpeech } from "./plan.js";
import { buildTimings } from "./timings.js";

/**
 * The planner is the part of the port that must not drift, so everything here
 * is arithmetic over committed fixtures: the word spans are the shapes Kokoro
 * returns, and the spoken lengths are the fixture WAVs' real durations.
 * Nothing in this file contacts a server.
 */

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "fixtures",
  "narrate",
);

/** The rate every fixture was written at, and the rate the plans below quantise to. */
const RATE = 24000;

/** The fixture WAVs' real lengths, in milliseconds: 56 400 and 18 000 frames at 24 kHz. */
const HOOK_SPOKEN_MS = 2350;
const CAUSE_SPOKEN_MS = 750;

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

const narration = readJson<Narration>("narration.json");
const hookWords = readJson<WordTimestamp[]>("hook-words.json");
const causeWords = readJson<WordTimestamp[]>("cause-words.json");

/** The three measured segments of `narration.json`: spoken, silent, spoken. */
function measuredSpeech(): SegmentSpeech[] {
  return [
    { spokenMs: HOOK_SPOKEN_MS, words: hookWords },
    { spokenMs: 0, words: [] },
    { spokenMs: CAUSE_SPOKEN_MS, words: causeWords },
  ];
}

describe("planSegments — lead-in, gap and tail arithmetic", () => {
  it("opens on the lead-in, so the first segment starts at LEAD_IN_MS", () => {
    const plan = planSegments(narration, measuredSpeech(), RATE);

    expect(LEAD_IN_MS).toBe(400);
    expect(at(plan.segments, 0).startMs).toBe(LEAD_IN_MS);
    expect(plan.leadInSamples).toBe((RATE * LEAD_IN_MS) / 1000);
  });

  it("ends each segment a GAP_MS beat after its speech, and starts the next one there", () => {
    const plan = planSegments(narration, measuredSpeech(), RATE);
    const hook = at(plan.segments, 0);
    const beat = at(plan.segments, 1);

    expect(GAP_MS).toBe(620);
    expect(hook.endMs).toBe(LEAD_IN_MS + HOOK_SPOKEN_MS + GAP_MS);
    expect(beat.startMs).toBe(hook.endMs);
  });

  it("extends a segment to its holdSeconds and adds the gap on top", () => {
    const plan = planSegments(narration, measuredSpeech(), RATE);
    const beat = at(plan.segments, 1);
    const cause = at(plan.segments, 2);

    // `beat` holds for 2 s with no speech at all; `cause` speaks for 750 ms of
    // its 3 s hold and is padded with the remaining 2 250 ms.
    expect(beat.endMs - beat.startMs).toBe(2000 + GAP_MS);
    expect(cause.endMs - cause.startMs).toBe(3000 + GAP_MS);
  });

  it("closes on the tail, so the track outlasts the last segment by TAIL_MS", () => {
    const plan = planSegments(narration, measuredSpeech(), RATE);
    const last = at(plan.segments, plan.segments.length - 1);

    expect(TAIL_MS).toBe(800);
    expect(plan.totalMs).toBe(last.endMs + TAIL_MS);
    expect(plan.tailSamples).toBe((RATE * TAIL_MS) / 1000);
  });

  it("derives every frame number from the milliseconds, never the other way round", () => {
    const plan = planSegments(narration, measuredSpeech(), RATE);

    expect(plan.fps).toBe(30);
    expect(plan.durationInFrames).toBe(Math.round((plan.totalMs / 1000) * 30));
    for (const segment of plan.segments) {
      expect(segment.from).toBe(Math.round((segment.startMs / 1000) * 30));
      expect(segment.durationInFrames).toBeGreaterThanOrEqual(1);
    }
  });

  it("leaves no hole and no overlap between consecutive segments", () => {
    const plan = planSegments(narration, measuredSpeech(), RATE);

    for (const [index, segment] of plan.segments.entries()) {
      if (index === 0) {
        continue;
      }
      expect(segment.startMs).toBe(at(plan.segments, index - 1).endMs);
    }
  });

  it("quantises every silence to whole samples, so the plan and the track agree", () => {
    // 44 100 Hz makes none of the three constants land on a sample boundary.
    const plan = planSegments(narration, measuredSpeech(), 44100);
    const spokenMs = HOOK_SPOKEN_MS + CAUSE_SPOKEN_MS;
    const silenceSamples =
      plan.leadInSamples +
      plan.segments.reduce((total, segment) => total + segment.trailingSilenceSamples, 0) +
      plan.tailSamples;

    expect(plan.totalMs).toBe(Math.round(spokenMs + (silenceSamples / 44100) * 1000));
  });
});

describe("planSegments — word spans", () => {
  it("places every word absolutely, offset by the segment's own start", () => {
    const plan = planSegments(narration, measuredSpeech(), RATE);
    const first = at(at(plan.segments, 0).words, 0);

    // "What" spans 0.05–0.28 s inside a segment that begins at 400 ms.
    expect(first.text).toBe("What");
    expect(first.startMs).toBe(450);
    expect(first.endMs).toBe(680);
  });

  it("takes each end from the server's end_time, never from the next word's start", () => {
    const plan = planSegments(narration, measuredSpeech(), RATE);
    const words = at(plan.segments, 0).words;
    const build = at(words, 3);
    const was = at(words, 4);

    // The fixture leaves 100 ms of real silence between "build" and "was".
    expect(build.text).toBe("build");
    expect(was.text).toBe("was");
    expect(build.endMs).toBe(1350);
    expect(was.startMs).toBe(1450);
    expect(was.startMs - build.endMs).toBe(100);
  });

  it("keeps that inter-word silence all the way into captions.json", () => {
    const plan = planSegments(narration, measuredSpeech(), RATE);
    const captions = buildCaptions(plan.segments);
    const build = at(captions, 3);
    const was = at(captions, 4);

    expect(build.text).toBe(" build");
    expect(was.text).toBe(" was");
    expect(was.startMs - build.endMs).toBe(100);
  });

  it("folds a punctuation-only token into the word before it", () => {
    const plan = planSegments(narration, measuredSpeech(), RATE);
    const captions = buildCaptions(plan.segments);
    const broken = at(captions, 6);

    // The fixture's eighth token is "?", spanning 2.00–2.10 s.
    expect(at(plan.segments, 0).words).toHaveLength(8);
    expect(captions).toHaveLength(9);
    expect(broken.text).toBe(" broken?");
    expect(broken.endMs).toBe(2500);
    expect(broken.timestampMs).toBe(Math.floor((broken.startMs + broken.endMs) / 2));
  });

  it("gives the first caption of a segment no leading space and the rest one", () => {
    const plan = planSegments(narration, measuredSpeech(), RATE);
    const captions = buildCaptions(plan.segments);

    expect(at(captions, 0).text).toBe("What");
    expect(at(captions, 1).text).toBe(" if");
    // "It" opens the third segment, so it starts a page and carries no space.
    expect(at(captions, 7).text).toBe("It");
  });

  it("drops a token that is empty once trimmed", () => {
    const script = readJson<Narration>("narration.json");
    const words: WordTimestamp[] = [
      { word: " ", start_time: 0, end_time: 0.1 },
      { word: "one", start_time: 0.1, end_time: 0.4 },
    ];
    const plan = planSegments(
      script,
      [{ spokenMs: 500, words }, ...measuredSpeech().slice(1)],
      RATE,
    );

    expect(at(plan.segments, 0).words).toHaveLength(1);
    expect(at(at(plan.segments, 0).words, 0).text).toBe("one");
  });
});

describe("planSegments — a segment with zero words", () => {
  it("gives a silent segment its hold and its gap, and no captions", () => {
    const plan = planSegments(narration, measuredSpeech(), RATE);
    const beat = at(plan.segments, 1);

    expect(beat.id).toBe("beat");
    expect(beat.words).toEqual([]);
    expect(beat.endMs - beat.startMs).toBe(2000 + GAP_MS);
    expect(beat.durationInFrames).toBeGreaterThanOrEqual(1);
  });

  it("still emits a timings entry for it, so the scene exists in the composition", () => {
    const plan = planSegments(narration, measuredSpeech(), RATE);
    const timings = buildTimings(plan, "narration.wav");

    expect(timings.segments).toHaveLength(3);
    expect(at(timings.segments, 1).id).toBe("beat");
    expect(at(timings.segments, 1).durationInFrames).toBeGreaterThanOrEqual(1);
  });

  it("gives a zero-length segment with no hold at least one frame", () => {
    const script = JSON.parse(
      JSON.stringify({ fps: 30, segments: [{ id: "empty", text: "" }] }),
    ) as Narration;
    const plan = planSegments(script, [{ spokenMs: 0, words: [] }], RATE);

    expect(at(plan.segments, 0).durationInFrames).toBeGreaterThanOrEqual(1);
  });
});

describe("planSegments — what it refuses", () => {
  it("rejects a word whose end is before its start", () => {
    const words: WordTimestamp[] = [{ word: "backwards", start_time: 1.2, end_time: 0.9 }];

    try {
      planSegments(narration, [{ spokenMs: 1500, words }, ...measuredSpeech().slice(1)], RATE);
      expect.unreachable("planSegments accepted a reversed word span");
    } catch (error) {
      expect(error).toBeInstanceOf(NarrationError);
      expect((error as NarrationError).code).toBe("WORD_SPAN_INVALID");
      expect((error as NarrationError).message).toMatch(/ends before it starts/);
      expect((error as NarrationError).message).toMatch(/"hook"/);
    }
  });

  it("rejects a word that starts before its segment does", () => {
    const words: WordTimestamp[] = [{ word: "early", start_time: -0.2, end_time: 0.4 }];

    expect(() =>
      planSegments(narration, [{ spokenMs: 1500, words }, ...measuredSpeech().slice(1)], RATE),
    ).toThrow(/starts before the segment does/);
  });

  it("rejects a non-finite span rather than writing NaN into captions.json", () => {
    const words: WordTimestamp[] = [
      { word: "broken", start_time: 0, end_time: Number.POSITIVE_INFINITY },
    ];

    expect(() =>
      planSegments(narration, [{ spokenMs: 1500, words }, ...measuredSpeech().slice(1)], RATE),
    ).toThrow(/non-finite span/);
  });

  it("rejects a narration script with no segments", () => {
    const empty = JSON.parse('{"segments":[]}') as Narration;

    try {
      planSegments(empty, [], RATE);
      expect.unreachable("planSegments accepted an empty script");
    } catch (error) {
      expect((error as NarrationError).code).toBe("NO_SEGMENTS");
    }
  });

  it("rejects a measured list that is not one entry per segment", () => {
    try {
      planSegments(narration, measuredSpeech().slice(0, 2), RATE);
      expect.unreachable("planSegments accepted a short measurement list");
    } catch (error) {
      expect((error as NarrationError).code).toBe("SEGMENT_COUNT_MISMATCH");
      expect((error as NarrationError).message).toMatch(/3 segments and 2 were measured/);
    }
  });
});
