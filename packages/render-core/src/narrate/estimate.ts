/**
 * The dry run's stand-in for a speech server (`narrate.py:173-187`) — roadmap
 * P1-2, docs/ROADMAP.md.
 *
 * A dry run exists to exercise the whole narration pipeline — pacing, spans,
 * concatenation, both documents and the render that reads them — in a second,
 * without a container, a model or a network. It invents a plausible duration
 * and word spans; everything downstream then treats them exactly as it treats
 * Kokoro's, which is the point: the code path under test is the real one.
 *
 * What it emits is an *estimate* and is labelled as one. `narrate()` reports
 * `mode: "dry_run"`, so no caller can mistake an invented timing for a measured
 * one.
 */

import type { WordTimestamp } from "@xplainer/tts-client";
import { DRY_RUN_MIN_SECONDS, DRY_RUN_WORDS_PER_SEC } from "./pacing.js";

/** An invented segment: how long it would take to say, and where each word would fall. */
export type SpeechEstimate = {
  /** Estimated spoken length, in milliseconds. */
  readonly durationMs: number;
  /** Word spans in seconds from the start of the segment, Kokoro's own shape. */
  readonly words: readonly WordTimestamp[];
};

/**
 * Estimate one segment: a plausible duration, and word spans weighted by length
 * so a long word occupies more of it than a short one.
 *
 * The spans tile the segment exactly, with no silence between them. That is
 * deliberately unlike real speech — and it is why a dry run proves the pipeline
 * and never the pacing.
 */
export function estimateSpeech(text: string): SpeechEstimate {
  const words = text.split(/\s+/).filter((word) => word !== "");
  const durationSeconds = Math.max(DRY_RUN_MIN_SECONDS, words.length / DRY_RUN_WORDS_PER_SEC);
  const durationMs = durationSeconds * 1000;

  if (words.length === 0) {
    return { durationMs, words: [] };
  }

  const weights = words.map((word) => word.length + 1);
  const total = weights.reduce((sum, weight) => sum + weight, 0);

  const spans: WordTimestamp[] = [];
  let cursor = 0;
  for (const [index, word] of words.entries()) {
    const weight = weights[index] ?? 0;
    const span = durationSeconds * (weight / total);
    spans.push({ word, start_time: cursor, end_time: cursor + span });
    cursor += span;
  }
  return { durationMs, words: spans };
}
