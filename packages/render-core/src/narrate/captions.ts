/**
 * `captions.json`: word-level captions in `@remotion/captions` `Caption[]` form
 * (`narrate.py:226-254`) — roadmap P1-2, docs/ROADMAP.md.
 *
 * Two details in the original are not cosmetic, and both are ported exactly.
 *
 * **Punctuation is folded into the word it follows.** Kokoro timestamps a comma
 * or a full stop as its own token; rendered on its own it becomes a caption
 * page containing one comma, which flashes on screen and reads as a glitch. The
 * fold extends the previous caption's end rather than replacing it, so the
 * punctuation's own span is kept.
 *
 * **Every token but the first of a segment carries a leading space.**
 * `@remotion/captions` joins a page by concatenating `text`, so a missing space
 * silently welds two words together. The first token of a segment carries none,
 * because a page never begins with a space.
 */

import type { Caption, Captions } from "@xplainer/protocol";
import type { PlannedSegment } from "./plan.js";

/**
 * A token made entirely of non-word characters.
 *
 * The unicode property escapes match the reference implementation's `\W` under
 * `re.UNICODE` — letters, digits and underscore are word characters, everything
 * else is not — which JavaScript's ASCII-only `\w` would not.
 */
const PUNCTUATION_ONLY = /^[^\p{L}\p{N}_]+$/u;

/** Midpoint of a span, which is what `@remotion/captions` pages on. */
function midpoint(startMs: number, endMs: number): number {
  return Math.floor((startMs + endMs) / 2);
}

/**
 * Build the caption track from a plan's absolute word spans.
 *
 * The result validates against `packages/protocol/schemas/captions.json`.
 * `confidence` is always `null`: Kokoro synthesised the audio, so the timings
 * are exact rather than a recogniser's guess, and a fabricated number there
 * would be worse than none.
 */
export function buildCaptions(segments: readonly PlannedSegment[]): Captions {
  const captions: Caption[] = [];

  for (const segment of segments) {
    const firstOfSegment = captions.length;

    for (const word of segment.words) {
      const previous = captions[captions.length - 1];
      if (
        previous !== undefined &&
        captions.length > firstOfSegment &&
        PUNCTUATION_ONLY.test(word.text)
      ) {
        previous.text += word.text;
        previous.endMs = Math.max(previous.endMs, word.endMs);
        previous.timestampMs = midpoint(previous.startMs, previous.endMs);
        continue;
      }

      captions.push({
        text: captions.length === firstOfSegment ? word.text : ` ${word.text}`,
        startMs: word.startMs,
        endMs: word.endMs,
        timestampMs: midpoint(word.startMs, word.endMs),
        confidence: null,
      });
    }
  }

  return captions;
}
