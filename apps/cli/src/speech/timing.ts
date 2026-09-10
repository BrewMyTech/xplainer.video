/**
 * Word timings from the model's own duration predictor (plan D6).
 *
 * **This is the most important arithmetic in the speech path, and it is the reason this model was
 * chosen.** `onnx-community/Kokoro-82M-v1.0-ONNX-timestamped` returns `durations`, one predicted
 * duration per token, alongside the waveform. One token is one IPA symbol and `phonemise()` returns
 * the character span of every word, so accumulating durations across a word's span gives that word's
 * start and end **from the model that produced the audio** — not from an aligner's estimate, and not
 * from a rate assumption. Every caption on screen and every scene boundary in `timings.json` rests
 * on it, and a systematic error here is invisible: the audio is fine, the captions are self
 * consistent, and only a viewer notices the words are no longer on the voice.
 *
 * ## The conversion is derived, never written down
 *
 * A duration unit is not a unit of time. The published research on this model says
 * `seconds = duration / 80`; that does not reproduce, and the S1 spike measured ≈592 samples per
 * unit at 24 kHz — a divisor of ≈40 rather than 80, off by a factor of two. Worse, it is **not a
 * constant at all**. Measured on this machine, af_heart, over utterance lengths of 51 to 296 tokens
 * and across the whole speaking-rate range the port accepts:
 *
 * | `speed` | samples per unit |
 * |---|---|
 * | 0.25 | 600–602 |
 * | 0.80 | 583–600 |
 * | 1.00 | 585–608 |
 * | 1.30 | 627–646 |
 * | 2.00 | 634–650 |
 * | 4.00 | **1021–1042** |
 *
 * The predictor's floor is one unit per token, so at high speeds the audio stops getting shorter
 * while the unit count does not — and the ratio moves by 79% end to end. **So it is computed from
 * the run that produced the audio**: `samplesPerUnit = waveform.length / Σ durations`. That makes
 * the emitted timings agree with the emitted audio by construction whatever the unit turns out to
 * mean, on any platform, at any speed, and for any future revision of this graph. Nothing in this
 * module hard-codes a rate, and nothing may.
 *
 * ## What can still be wrong, and what each refusal is for
 *
 * With the conversion derived, the failures that remain are all *alignment* failures, and every one
 * of them produces plausible-looking output:
 *
 * - **`durations` not aligned with the tokens we fed.** If the array is a different length from the
 *   padded token sequence, every word after the divergence is attributed to the wrong phonemes. It
 *   is the load-bearing check and it is first.
 * - **`durations` not being durations.** A derived ratio far outside the range above means the array
 *   does not carry per-token durations at all — seconds, milliseconds, or a different tensor
 *   entirely after a graph change. The band is wide on purpose: a merely *different* unit is handled
 *   correctly by the derivation, so the band only has to catch an array that is not this quantity.
 * - **A word whose span covers no token**, which would be a caption with no duration.
 * - **Word spans that overlap**, which would attribute the same audio to two words.
 * - **Timings that do not add up to the audio.** The last check re-derives the whole clip's length
 *   from the seconds this function is about to emit, and compares it against the waveform. It is a
 *   tautology while everything above holds, and it is here for the edit that stops one of them
 *   holding — the same reason `render-core`'s `g2p/vocab.ts` keeps a refusal its own test says
 *   should never fire. It is the last line rather than the first.
 */

import type { WordSpan } from "@xplainer/render-core";
import type { WordTimestamp } from "@xplainer/tts-client";
import { OnnxSpeechError } from "./errors.js";
import { type TokenisedPhonemes, tokenRange } from "./tokens.js";

/**
 * The range a derived samples-per-unit must land in.
 *
 * Two orders of magnitude wide, because the whole point of deriving the conversion is that a
 * different-but-consistent unit is *handled* rather than refused. Measured 583–1042 across the full
 * speaking-rate range; a `durations` array in seconds would read ≈24,000 and one in milliseconds
 * ≈24, and those are the mistakes this catches.
 */
const MIN_SAMPLES_PER_UNIT = 50;

/** The other end of that range. See {@link MIN_SAMPLES_PER_UNIT}. */
const MAX_SAMPLES_PER_UNIT = 5000;

/**
 * How far the timings may fall from the audio before they are refused.
 *
 * One millisecond: far tighter than a frame at any rate this product renders (33 ms at 30 fps), and
 * far looser than float32 accumulation over a few hundred tokens.
 */
const TOLERANCE_MS = 1;

/** What the timing derivation needs: one inference's outputs, and the spans they belong to. */
export type TimingInput = {
  /** The padded token sequence that was fed to the graph. */
  readonly tokens: TokenisedPhonemes;
  /** The `durations` output, one entry per token of {@link tokens}. */
  readonly durations: ArrayLike<number>;
  /** Word spans from `phonemise()`, as character offsets into the string that was tokenised. */
  readonly words: readonly WordSpan[];
  /** How many audio samples the `waveform` output carried. */
  readonly sampleCount: number;
  /** The rate that waveform plays at — 24 kHz for this model. */
  readonly sampleRate: number;
};

/** The timings, and the conversion they were derived through, so a caller can log it. */
export type DerivedTiming = {
  /** One span per word, in seconds from the start of the clip, in the port's own shape. */
  readonly timestamps: readonly WordTimestamp[];
  /** The conversion this inference yielded: audio samples per duration unit. */
  readonly samplesPerUnit: number;
  /** The clip's length in seconds, from the waveform. */
  readonly seconds: number;
};

/**
 * Turn one inference's `durations` into word timings.
 *
 * @throws {OnnxSpeechError} `MODEL_CONTRACT` when `durations` is not a per-token duration array for
 *   the tokens that were fed, and `TIMING_INCONSISTENT` when the spans and the audio cannot be
 *   reconciled. Both refuse rather than emitting timings that disagree with the audio.
 */
export function deriveWordTimings(input: TimingInput): DerivedTiming {
  const { tokens, durations, words, sampleCount, sampleRate } = input;

  if (durations.length !== tokens.ids.length) {
    throw new OnnxSpeechError(
      "MODEL_CONTRACT",
      `the model returned ${durations.length} durations for ${tokens.ids.length} tokens. One ` +
        "duration per token is what makes a word's timing derivable; a different count means " +
        "every word after the first divergence would be timed against the wrong phonemes.",
    );
  }
  if (sampleCount <= 0 || !Number.isFinite(sampleCount)) {
    throw new OnnxSpeechError(
      "MODEL_CONTRACT",
      `the model returned ${sampleCount} audio samples, so there is no clip to time words against.`,
    );
  }

  // The cumulative sum is built once, over the padded sequence, so a word's units are one
  // subtraction rather than a loop per word — and so the total below is the same arithmetic the
  // per-word figures came out of rather than a second, independently rounded one.
  const cumulative = new Float64Array(durations.length + 1);
  for (let index = 0; index < durations.length; index += 1) {
    const unit = durations[index];
    if (unit === undefined || !Number.isFinite(unit) || unit < 0) {
      throw new OnnxSpeechError(
        "MODEL_CONTRACT",
        `duration ${index} of ${durations.length} is ${String(unit)}, which cannot be a length.`,
      );
    }
    cumulative[index + 1] = (cumulative[index] ?? 0) + unit;
  }

  const totalUnits = cumulative[durations.length] ?? 0;
  if (totalUnits <= 0) {
    throw new OnnxSpeechError(
      "MODEL_CONTRACT",
      "the model's durations sum to zero, so no word can be placed in the audio it produced.",
    );
  }

  const samplesPerUnit = sampleCount / totalUnits;
  if (samplesPerUnit < MIN_SAMPLES_PER_UNIT || samplesPerUnit > MAX_SAMPLES_PER_UNIT) {
    throw new OnnxSpeechError(
      "MODEL_CONTRACT",
      `${sampleCount} samples over ${totalUnits.toFixed(1)} duration units is ` +
        `${samplesPerUnit.toFixed(1)} samples per unit, outside the ` +
        `${MIN_SAMPLES_PER_UNIT}–${MAX_SAMPLES_PER_UNIT} this model's durations have ever ` +
        "measured. The array is not a per-token duration, so nothing derived from it would be a " +
        "time.",
    );
  }

  const secondsPerUnit = samplesPerUnit / sampleRate;
  const visits = new Uint8Array(durations.length);
  const timestamps: WordTimestamp[] = [];
  let previousEnd = 0;

  for (const span of words) {
    const range = tokenRange(tokens, span.start, span.end);
    if (range === null) {
      throw new OnnxSpeechError(
        "TIMING_INCONSISTENT",
        `word ${JSON.stringify(span.word)} spans characters ${span.start}–${span.end} of the ` +
          "phoneme string, which hold no token. A word with no phonemes has no duration, and a " +
          "zero-length caption is the silent wrongness this path exists to refuse.",
      );
    }
    for (let index = range.first; index <= range.last; index += 1) {
      const seen = visits[index] ?? 0;
      if (seen > 0) {
        throw new OnnxSpeechError(
          "TIMING_INCONSISTENT",
          `token ${index} belongs to more than one word span; ${JSON.stringify(span.word)} is the ` +
            "second. Overlapping spans would attribute the same audio to two words.",
        );
      }
      visits[index] = seen + 1;
    }

    const start = (cumulative[range.first] ?? 0) * secondsPerUnit;
    const end = (cumulative[range.last + 1] ?? 0) * secondsPerUnit;
    if (start < previousEnd - TOLERANCE_MS / 1000) {
      throw new OnnxSpeechError(
        "TIMING_INCONSISTENT",
        `word ${JSON.stringify(span.word)} starts at ${start.toFixed(3)}s, before the previous ` +
          `word ended at ${previousEnd.toFixed(3)}s. The narration planner reads these in order.`,
      );
    }
    previousEnd = end;
    timestamps.push({ word: span.word, start_time: start, end_time: end });
  }

  const seconds = sampleCount / sampleRate;
  if (previousEnd > seconds + TOLERANCE_MS / 1000) {
    throw new OnnxSpeechError(
      "TIMING_INCONSISTENT",
      `the last word ends at ${previousEnd.toFixed(3)}s in a clip that is ${seconds.toFixed(3)}s ` +
        "long. A caption cannot outlive the audio it captions.",
    );
  }

  // The last line: rebuild the clip from what is about to be emitted — every word's seconds, plus
  // the units no word claimed — and hold it against the waveform. See the module docblock.
  let accounted = 0;
  for (const timing of timestamps) {
    accounted += timing.end_time - timing.start_time;
  }
  for (let index = 0; index < durations.length; index += 1) {
    if ((visits[index] ?? 0) === 0) {
      accounted += (durations[index] ?? 0) * secondsPerUnit;
    }
  }
  if (Math.abs(accounted - seconds) * 1000 > TOLERANCE_MS) {
    throw new OnnxSpeechError(
      "TIMING_INCONSISTENT",
      `the derived timings account for ${accounted.toFixed(4)}s of a ${seconds.toFixed(4)}s clip, ` +
        `a ${((accounted - seconds) * 1000).toFixed(1)} ms disagreement. Emitting them would put ` +
        "every caption and every scene boundary at a time the audio does not have.",
    );
  }

  return { timestamps, samplesPerUnit, seconds };
}
