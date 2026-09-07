/**
 * The narration planner: where every segment and every word sits on the track
 * (roadmap P1-2 and P1-6, docs/ROADMAP.md).
 *
 * This is the pure half of the port. `narrate.py:206-285` interleaves three
 * jobs — talk to the server, append PCM frames, accumulate offsets — and the
 * offsets are what the whole product depends on, so here they are separated
 * out: `planSegments()` takes what was *measured* (each segment's spoken length
 * and its word spans) and returns where everything lands. It performs no I/O,
 * spawns nothing, and can be exhaustively tested from a fixture.
 *
 * TWO PROPERTIES ARE LOAD-BEARING, and both are easy to lose in a rewrite.
 *
 * **A word's end comes from the server's `end_time`, never from the next word's
 * `start_time`.** Kokoro reports both ends of every span, and the space between
 * two spans is real silence — a breath, a comma, the pause before a clause. A
 * caption stretched to meet the next word stays on screen through that silence
 * and reads as lag. So `end_time` is used verbatim and inter-word silence
 * survives into `captions.json`.
 *
 * **Silence is quantised to whole samples here, not in the track builder.** The
 * plan reports the lead-in, per-segment and tail padding in samples, and
 * `buildTrack()` writes exactly those. If each side rounded independently the
 * two would diverge by a fraction of a sample per gap, and after fifty segments
 * `timings.json` would describe a track a few milliseconds longer than the WAV
 * really is — the drift this port exists to make impossible.
 */

import type { Narration } from "@xplainer/protocol";
import type { WordTimestamp } from "@xplainer/tts-client";
import { NarrationError } from "./errors.js";
import { DEFAULT_FPS, DEFAULT_SAMPLE_RATE, GAP_MS, LEAD_IN_MS, TAIL_MS } from "./pacing.js";
import { silenceSamples } from "./wav.js";

/** Milliseconds `samples` occupy at `sampleRate`. The inverse of `silenceSamples`. */
function samplesToMs(samples: number, sampleRate: number): number {
  return (samples / sampleRate) * 1000;
}

/**
 * What was measured for one segment: how long its audio actually plays, and the
 * word spans the server reported for it.
 *
 * `spokenMs` is separate from the words on purpose. A synthesised clip is
 * routinely longer than its last `end_time` — trailing breath, decay, the
 * model's own tail — so a planner that inferred the length from the spans would
 * cut every segment short and shift the whole track earlier than the audio.
 */
export type SegmentSpeech = {
  /** Length of this segment's audio, in milliseconds, measured from its frames. */
  readonly spokenMs: number;
  /** Word spans in seconds from the start of the segment, as the server reported them. */
  readonly words: readonly WordTimestamp[];
};

/** One word, moved from segment-relative seconds onto the whole track in milliseconds. */
export type PlannedWord = {
  /** The token, trimmed. Punctuation tokens survive; `captions.ts` folds them. */
  readonly text: string;
  /** Absolute start on the narration track, in milliseconds. */
  readonly startMs: number;
  /** Absolute end on the narration track, from the server's `end_time`. */
  readonly endMs: number;
};

/** One segment's place on the track, and every word inside it. */
export type PlannedSegment = {
  /** The narration segment's id, which is how a scene finds its own timing. */
  readonly id: string;
  /** Zero-based position in the narration. */
  readonly index: number;
  /** Segment start, in milliseconds. */
  readonly startMs: number;
  /** Segment end — after its hold padding and the gap that follows it. */
  readonly endMs: number;
  /** `startMs` as a frame number, for Remotion's `Sequence`. */
  readonly from: number;
  /** Segment length in frames, never below 1. */
  readonly durationInFrames: number;
  /** Every word of this segment, in absolute track milliseconds. */
  readonly words: readonly PlannedWord[];
  /** Silence written after this segment's speech: hold padding plus the gap. */
  readonly trailingSilenceSamples: number;
};

/** Everything the two documents and the track builder need, and nothing else. */
export type NarrationPlan = {
  /** Frame rate the frame numbers are expressed in. */
  readonly fps: number;
  /** Sample rate the silence counts are expressed in. */
  readonly sampleRate: number;
  /** Total track length in milliseconds, rounded. */
  readonly totalMs: number;
  /** Total composition length in frames, never below 1. */
  readonly durationInFrames: number;
  /** Silence before the first segment, in samples. */
  readonly leadInSamples: number;
  /** Silence after the last segment, in samples. */
  readonly tailSamples: number;
  /** One entry per narration segment, in narration order. */
  readonly segments: readonly PlannedSegment[];
};

/**
 * Place every segment and every word on the narration track.
 *
 * @param narrationScript the narration spec, as `explainer_narrate` received it
 * @param perSegmentWords one entry per segment of `narrationScript`, in the same
 *   order: the measured spoken length and the server's word spans
 * @param sampleRate rate the track is built at, which fixes how silence is
 *   quantised. Defaults to Kokoro's own rate.
 *
 * @throws NarrationError `NO_SEGMENTS` when the script is empty,
 *   `SEGMENT_COUNT_MISMATCH` when the two lists are different lengths, and
 *   `WORD_SPAN_INVALID` for a span that is not finite, is negative, or ends
 *   before it starts.
 */
export function planSegments(
  narrationScript: Narration,
  perSegmentWords: readonly SegmentSpeech[],
  sampleRate: number = DEFAULT_SAMPLE_RATE,
): NarrationPlan {
  const segments = narrationScript.segments;
  if (segments.length === 0) {
    throw new NarrationError("NO_SEGMENTS", "the narration script has no segments to speak.");
  }
  if (perSegmentWords.length !== segments.length) {
    throw new NarrationError(
      "SEGMENT_COUNT_MISMATCH",
      `the narration script has ${segments.length} segments and ${perSegmentWords.length} ` +
        "were measured; one measured entry per segment is required.",
    );
  }

  const fps = narrationScript.fps ?? DEFAULT_FPS;
  const leadInSamples = silenceSamples(sampleRate, LEAD_IN_MS);
  const gapSamples = silenceSamples(sampleRate, GAP_MS);
  const tailSamples = silenceSamples(sampleRate, TAIL_MS);

  let cursorMs = samplesToMs(leadInSamples, sampleRate);
  const planned: PlannedSegment[] = [];

  for (const [index, segment] of segments.entries()) {
    const speech = perSegmentWords[index];
    if (speech === undefined) {
      throw new NarrationError(
        "SEGMENT_COUNT_MISMATCH",
        `no measured speech for segment ${index} ("${segment.id}").`,
      );
    }

    const startMs = cursorMs;
    const words = absoluteWords(startMs, speech.words, segment.id);
    cursorMs += speech.spokenMs;

    // A segment can outlast its narration, so an animation can finish or a beat
    // can land silently (`narrate.py:259-262`).
    let trailingSilenceSamples = 0;
    const holdMs = (segment.holdSeconds ?? 0) * 1000;
    const spokenSoFar = cursorMs - startMs;
    if (spokenSoFar < holdMs) {
      const holdSamples = silenceSamples(sampleRate, holdMs - spokenSoFar);
      trailingSilenceSamples += holdSamples;
      cursorMs += samplesToMs(holdSamples, sampleRate);
    }
    trailingSilenceSamples += gapSamples;
    cursorMs += samplesToMs(gapSamples, sampleRate);

    const from = Math.round((startMs / 1000) * fps);
    const endFrame = Math.round((cursorMs / 1000) * fps);
    planned.push({
      id: segment.id === "" ? `segment-${index}` : segment.id,
      index,
      startMs: Math.round(startMs),
      endMs: Math.round(cursorMs),
      from,
      durationInFrames: Math.max(1, endFrame - from),
      words,
      trailingSilenceSamples,
    });
  }

  cursorMs += samplesToMs(tailSamples, sampleRate);

  return {
    fps,
    sampleRate,
    totalMs: Math.round(cursorMs),
    durationInFrames: Math.max(1, Math.round((cursorMs / 1000) * fps)),
    leadInSamples,
    tailSamples,
    segments: planned,
  };
}

/**
 * Move one segment's word spans onto the track.
 *
 * Empty tokens are dropped — Kokoro occasionally emits one — and every
 * surviving span is validated before it can reach `captions.json`, where a
 * negative or reversed span would fail the schema far from its cause.
 */
function absoluteWords(
  startMs: number,
  words: readonly WordTimestamp[],
  segmentId: string,
): PlannedWord[] {
  const placed: PlannedWord[] = [];
  for (const word of words) {
    const text = String(word.word ?? "").trim();
    if (text === "") {
      continue;
    }

    const { start_time: start, end_time: end } = word;
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new NarrationError(
        "WORD_SPAN_INVALID",
        `word "${text}" in segment "${segmentId}" has a non-finite span ` +
          `(start_time=${start}, end_time=${end}).`,
      );
    }
    if (start < 0) {
      throw new NarrationError(
        "WORD_SPAN_INVALID",
        `word "${text}" in segment "${segmentId}" starts before the segment does ` +
          `(start_time=${start}).`,
      );
    }
    if (end < start) {
      throw new NarrationError(
        "WORD_SPAN_INVALID",
        `word "${text}" in segment "${segmentId}" ends before it starts ` +
          `(start_time=${start}, end_time=${end}).`,
      );
    }

    placed.push({
      text,
      startMs: Math.round(startMs + start * 1000),
      endMs: Math.round(startMs + end * 1000),
    });
  }
  return placed;
}
