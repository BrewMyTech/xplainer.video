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
 * **Every token but the very first carries a leading space — unless it is
 * punctuation.** `@remotion/captions` joins a page by concatenating `text`, so a
 * missing space silently welds two words together. The first token of the whole
 * track is bare: `createTikTokStyleCaptions` starts a new page precisely when a
 * token begins with a space, and trims that space off the token it opens the
 * page with, so a leading space is what *permits* a page break rather than what
 * spoils one. A segment boundary is not a page boundary — pages are cut by
 * elapsed time, not by segment — so the first *word* of a segment needs its
 * space no less than every other word does, or `"one."` and `"Segment"` land in
 * one page as `"one.Segment"`.
 *
 * A segment whose first token is punctuation is the one place where those two
 * rules meet, and the space rule loses. The fold above cannot apply — it would
 * stretch the previous caption's `endMs` forward across the whole inter-segment
 * gap, leaving that caption on screen through the silence — so the token is
 * emitted as its own caption, keeping its own span, and it is emitted **bare**.
 * A leading space there would render `"Alpha , beta"`, which is the space rule
 * applied to a token that is not a word; the word that follows it inside the
 * same segment still gets its space, so two words across a boundary are still
 * separated.
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
      const punctuation = PUNCTUATION_ONLY.test(word.text);
      // The fold never reaches back across a segment boundary: it extends the
      // previous caption's `endMs`, and the previous segment's last word is a
      // whole inter-segment gap away.
      if (previous !== undefined && captions.length > firstOfSegment && punctuation) {
        previous.text += word.text;
        previous.endMs = Math.max(previous.endMs, word.endMs);
        previous.timestampMs = midpoint(previous.startMs, previous.endMs);
        continue;
      }

      captions.push({
        // Bare for the first token of the track, and bare for punctuation that
        // opens a segment — reaching here punctuation means exactly that, since
        // anything later in the segment folded above.
        text: captions.length === 0 || punctuation ? word.text : ` ${word.text}`,
        startMs: word.startMs,
        endMs: word.endMs,
        timestampMs: midpoint(word.startMs, word.endMs),
        confidence: null,
      });
    }
  }

  return captions;
}
