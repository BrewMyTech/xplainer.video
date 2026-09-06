/**
 * WAV concatenation: one continuous voice track, padded exactly as the plan
 * says (`narrate.py:71-109`, `206-285`) — roadmap P1-2, docs/ROADMAP.md.
 *
 * The builder writes no numbers of its own. Every silence length comes from the
 * plan, in samples, so the track's byte count and `timings.json`'s `totalMs`
 * are two readings of the same arithmetic rather than two calculations that
 * happen to agree today.
 */

import { NarrationError } from "./errors.js";
import type { NarrationPlan } from "./plan.js";
import {
  describeFormat,
  type PcmFormat,
  samePcmFormat,
  silentFrames,
  type WavAudio,
} from "./wav.js";

/**
 * Assemble the narration track: lead-in, then every segment's speech followed
 * by its hold padding and gap, then the tail.
 *
 * @param plan the plan those segments were placed by
 * @param speech one buffer of PCM frames per segment, in narration order; an
 *   empty buffer for a segment with no text
 * @param format the PCM format every buffer is in, whose sample rate must be
 *   the rate the plan quantised its silence at
 *
 * @throws NarrationError `AUDIO_FORMAT_MISMATCH` when the format and the plan
 *   disagree about the sample rate, or when there is not exactly one buffer per
 *   planned segment.
 */
export function buildTrack(
  plan: NarrationPlan,
  speech: readonly Buffer[],
  format: PcmFormat,
): WavAudio {
  if (format.sampleRate !== plan.sampleRate) {
    throw new NarrationError(
      "AUDIO_FORMAT_MISMATCH",
      `the plan quantised its silence at ${plan.sampleRate} Hz and the audio is ` +
        `${describeFormat(format)}; the track would drift.`,
    );
  }
  if (speech.length !== plan.segments.length) {
    throw new NarrationError(
      "AUDIO_FORMAT_MISMATCH",
      `the plan has ${plan.segments.length} segments and ${speech.length} audio buffers ` +
        "were supplied.",
    );
  }

  const parts: Buffer[] = [silentFrames(format, plan.leadInSamples)];
  for (const [index, segment] of plan.segments.entries()) {
    const frames = speech[index];
    if (frames === undefined) {
      throw new NarrationError(
        "AUDIO_FORMAT_MISMATCH",
        `no audio buffer for segment ${index} ("${segment.id}").`,
      );
    }
    parts.push(frames, silentFrames(format, segment.trailingSilenceSamples));
  }
  parts.push(silentFrames(format, plan.tailSamples));

  return { format, data: Buffer.concat(parts) };
}

/**
 * The format `next` must agree with, or the first one seen.
 *
 * The reference implementation's `Track._configure` (`narrate.py:81-89`) raises
 * on a mismatch rather than resampling, and so does this: two segments in
 * different formats concatenated byte-wise produce a track that plays the
 * second one at the wrong pitch, which is a failure nobody would think to look
 * for.
 */
export function reconcileFormat(current: PcmFormat | undefined, next: PcmFormat): PcmFormat {
  if (current === undefined) {
    return next;
  }
  if (!samePcmFormat(current, next)) {
    throw new NarrationError(
      "AUDIO_FORMAT_MISMATCH",
      `the server changed audio format mid-narration: got ${describeFormat(next)}, ` +
        `expected ${describeFormat(current)}.`,
    );
  }
  return current;
}
