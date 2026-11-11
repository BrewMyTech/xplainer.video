/**
 * Caption paging: word-level `captions.json` into the pages the caption track shows one at a time.
 *
 * **The rule, which `packages/render-core` already writes `captions.json` against.** Its
 * `buildCaptions()` gives every word but the first of the whole track a leading space and never
 * gives one to folded punctuation (`packages/render-core/src/narrate/captions.ts`). The pager is
 * the other half of that agreement:
 *
 * 1. Captions are taken in order. The first one opens the first page.
 * 2. A caption **opens a new page only if its `text` begins with whitespace** and at least
 *    `combineWithinMs` have elapsed from the current page's start to the caption's `startMs`. The
 *    window is half-open: a caption exactly `combineWithinMs` after the page start opens the next
 *    page. A caption with no leading space never opens a page however late it is — it is the tail
 *    of the word before it, and splitting there would strand it.
 * 3. The caption that opens a page has its leading whitespace trimmed, in the page `text` and in
 *    its token, so no page begins with a space. Every other caption is appended verbatim: page
 *    `text` is the plain concatenation of its tokens' `text`.
 * 4. A page lasts until the next page starts; the last page lasts until the latest `endMs` among
 *    its own tokens. So consecutive pages tile the time between them with no gap for the caption
 *    band to flicker through, and the track ends when the speech does.
 *
 * Grouping is by elapsed time only; nothing here knows where a sentence or a narration segment
 * ends. The scaffold's `Captions.tsx` gets sentence-aware pages by calling this once per sentence,
 * which is why this function stays this small.
 *
 * Pure: no clock, no frame, no order dependence, so a frame rendered out of order or a still taken
 * alone pages exactly as the full render does.
 */

/** One word of `captions.json`, in the shape `packages/protocol/schemas/captions.json` defines. */
export type Caption = {
  text: string;
  startMs: number;
  endMs: number;
  timestampMs: number | null;
  confidence: number | null;
};

/** One caption inside a page, with its own span so the spoken word can be highlighted. */
export type TikTokToken = {
  text: string;
  fromMs: number;
  toMs: number;
};

/** One page of caption text and the tokens it was built from. */
export type TikTokPage = {
  text: string;
  startMs: number;
  durationMs: number;
  tokens: TikTokToken[];
};

/** The fields of a caption the pager reads. Every `Caption` is one. */
export type PageableCaption = Pick<Caption, "text" | "startMs" | "endMs">;

export type PaginateCaptionsOptions = {
  /** A caption starting this long after its page's start (or later) may open the next page. */
  combineWithinMs: number;
};

const LEADING_WHITESPACE = /^\s/u;

export function paginateCaptions(
  captions: readonly PageableCaption[],
  options: PaginateCaptionsOptions,
): TikTokPage[] {
  const { combineWithinMs } = options;
  if (!(Number.isFinite(combineWithinMs) && combineWithinMs >= 0)) {
    throw new RangeError(
      `paginateCaptions: combineWithinMs must be zero or a positive number, got ${String(combineWithinMs)}.`,
    );
  }
  const pages: TikTokPage[] = [];
  let page: TikTokPage | undefined;
  for (const caption of captions) {
    const opens =
      page === undefined ||
      (LEADING_WHITESPACE.test(caption.text) && caption.startMs - page.startMs >= combineWithinMs);
    if (opens || page === undefined) {
      const text = caption.text.trimStart();
      page = {
        text,
        startMs: caption.startMs,
        durationMs: 0,
        tokens: [{ text, fromMs: caption.startMs, toMs: caption.endMs }],
      };
      pages.push(page);
      continue;
    }
    page.text += caption.text;
    page.tokens.push({ text: caption.text, fromMs: caption.startMs, toMs: caption.endMs });
  }

  for (const [index, current] of pages.entries()) {
    const next = pages[index + 1];
    const end =
      next === undefined ? Math.max(...current.tokens.map((token) => token.toMs)) : next.startMs;
    current.durationMs = Math.max(0, end - current.startMs);
  }
  return pages;
}

export type CreateTikTokStyleCaptionsInput = {
  captions: readonly PageableCaption[];
  combineTokensWithinMilliseconds: number;
};

/**
 * `paginateCaptions` under its older name and argument shape.
 *
 * It exists so scenes written before this package — which imported the pager from a
 * captions-specific module under this name — keep compiling through the renderer's import alias
 * for one release. New code should call `paginateCaptions`.
 */
export function createTikTokStyleCaptions(input: CreateTikTokStyleCaptionsInput): {
  pages: TikTokPage[];
} {
  return {
    pages: paginateCaptions(input.captions, {
      combineWithinMs: input.combineTokensWithinMilliseconds,
    }),
  };
}
