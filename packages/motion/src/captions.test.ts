/**
 * Caption paging against the narration fixtures (AC-P1-2).
 *
 * Every word file under `packages/render-core/test/fixtures/narrate/` is turned into a
 * `captions.json` track the way `buildCaptions()` documents it — times in whole milliseconds,
 * every word but the track's first with a leading space, punctuation folded into the word before
 * it — and paged. The expected pages below were worked out by hand from the rule in
 * `captions.ts`'s docblock, not printed from the implementation; each carries the arithmetic that
 * decided its boundary.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type Caption,
  createTikTokStyleCaptions,
  paginateCaptions,
  type TikTokPage,
} from "./captions.js";

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "render-core",
  "test",
  "fixtures",
  "narrate",
);

type Word = { word: string; start_time: number; end_time: number };
type Narration = { segments: { id: string; text: string }[] };

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;
}

const PUNCTUATION_ONLY = /^[^\p{L}\p{N}_]+$/u;

/** `captions.json` for spoken segments placed at the given offsets, per the documented rule. */
function track(segments: readonly { words: readonly Word[]; offsetMs: number }[]): Caption[] {
  const captions: Caption[] = [];
  for (const { words, offsetMs } of segments) {
    const firstOfSegment = captions.length;
    for (const word of words) {
      const startMs = Math.round(offsetMs + word.start_time * 1000);
      const endMs = Math.round(offsetMs + word.end_time * 1000);
      const previous = captions[captions.length - 1];
      if (
        previous !== undefined &&
        captions.length > firstOfSegment &&
        PUNCTUATION_ONLY.test(word.word)
      ) {
        previous.text += word.word;
        previous.endMs = Math.max(previous.endMs, endMs);
        continue;
      }
      captions.push({
        text: captions.length === 0 ? word.word : ` ${word.word}`,
        startMs,
        endMs,
        timestampMs: null,
        confidence: null,
      });
    }
  }
  return captions;
}

function words(segmentId: string): Word[] {
  return readJson<Word[]>(`${segmentId}-words.json`);
}

function page(
  text: string,
  startMs: number,
  durationMs: number,
  tokens: [string, number, number][],
): TikTokPage {
  return {
    text,
    startMs,
    durationMs,
    tokens: tokens.map(([tokenText, fromMs, toMs]) => ({ text: tokenText, fromMs, toMs })),
  };
}

/**
 * Hand-derived pages for each word fixture as a track of its own, at the 1400 ms window the
 * scaffold's `Captions.tsx` uses and at a narrow one that forces breaks.
 */
const EXPECTED: Record<string, { windowMs: number; pages: TikTokPage[] }[]> = {
  // What 50–280 · if 300–420 · your 440–630 · build 650–950 · was 1050–1200 · already 1220–1620
  // · broken? 1640–2100 (the "?" 2000–2100 folded in).
  "hook-words.json": [
    {
      // 1640 − 50 = 1590 ≥ 1400 is the first word past the window; " already" at 1170 is not.
      windowMs: 1400,
      pages: [
        page("What if your build was already", 50, 1590, [
          ["What", 50, 280],
          [" if", 300, 420],
          [" your", 440, 630],
          [" build", 650, 950],
          [" was", 1050, 1200],
          [" already", 1220, 1620],
        ]),
        page("broken?", 1640, 460, [["broken?", 1640, 2100]]),
      ],
    },
    {
      // 650 − 50 = 600 ≥ 500 breaks; 1220 − 650 = 570 ≥ 500 breaks; 1640 − 1220 = 420 does not.
      windowMs: 500,
      pages: [
        page("What if your", 50, 600, [
          ["What", 50, 280],
          [" if", 300, 420],
          [" your", 440, 630],
        ]),
        page("build was", 650, 570, [
          ["build", 650, 950],
          [" was", 1050, 1200],
        ]),
        page("already broken?", 1220, 880, [
          ["already", 1220, 1620],
          [" broken?", 1640, 2100],
        ]),
      ],
    },
  ],
  // It 60–200 · was. 220–520.
  "cause-words.json": [
    {
      windowMs: 1400,
      pages: [
        page("It was.", 60, 460, [
          ["It", 60, 200],
          [" was.", 220, 520],
        ]),
      ],
    },
    {
      // 220 − 60 = 160 ≥ 100.
      windowMs: 100,
      pages: [page("It", 60, 160, [["It", 60, 200]]), page("was.", 220, 300, [["was.", 220, 520]])],
    },
  ],
  // Segment 40–410 · one. 430–790.
  "one-words.json": [
    {
      windowMs: 1400,
      pages: [
        page("Segment one.", 40, 750, [
          ["Segment", 40, 410],
          [" one.", 430, 790],
        ]),
      ],
    },
  ],
  // Segment 50–420 · two. 440–820.
  "two-words.json": [
    {
      // 440 − 50 = 390 ≥ 390: exactly on the window, so it opens the next page (half-open window).
      windowMs: 390,
      pages: [
        page("Segment", 50, 390, [["Segment", 50, 420]]),
        page("two.", 440, 380, [["two.", 440, 820]]),
      ],
    },
    {
      // 390 < 391: the same word one millisecond inside the window joins the page.
      windowMs: 391,
      pages: [
        page("Segment two.", 50, 770, [
          ["Segment", 50, 420],
          [" two.", 440, 820],
        ]),
      ],
    },
  ],
};

describe("paginateCaptions over the narration fixtures", () => {
  const wordFiles = readdirSync(FIXTURES)
    .filter((name) => name.endsWith("-words.json"))
    .sort();

  it("has an expectation for every word fixture, so a new fixture cannot go unpaged", () => {
    expect(wordFiles).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const file of Object.keys(EXPECTED).sort()) {
    for (const { windowMs, pages } of EXPECTED[file] ?? []) {
      it(`pages ${file} at a ${windowMs} ms window`, () => {
        const captions = track([{ words: readJson<Word[]>(file), offsetMs: 0 }]);
        expect(paginateCaptions(captions, { combineWithinMs: windowMs })).toEqual(pages);
      });
    }
  }

  it("pages adjacent.json's two segments as one track, breaking exactly at the window", () => {
    const [first, second] = readJson<Narration>("adjacent.json").segments;
    if (first === undefined || second === undefined) {
      throw new Error("adjacent.json no longer has two segments");
    }
    // one at 0 ms, two at 1000 ms: Segment 40–410 · one. 430–790 · Segment 1050–1420 · two. 1440–1820.
    const captions = track([
      { words: words(first.id), offsetMs: 0 },
      { words: words(second.id), offsetMs: 1000 },
    ]);
    // " Segment" 1050 − 40 = 1010 joins; " two." 1440 − 40 = 1400 ≥ 1400 opens the next page.
    expect(paginateCaptions(captions, { combineWithinMs: 1400 })).toEqual([
      page("Segment one. Segment", 40, 1400, [
        ["Segment", 40, 410],
        [" one.", 430, 790],
        [" Segment", 1050, 1420],
      ]),
      page("two.", 1440, 380, [["two.", 1440, 1820]]),
    ]);
  });

  it("pages narration.json's spoken segments as one track, the silent one included", () => {
    const spoken = readJson<Narration>("narration.json").segments.filter(
      (segment) => segment.text !== "",
    );
    expect(spoken.map((segment) => segment.id)).toEqual(["hook", "cause"]);
    // hook at 0 ms; cause at 5000 ms, after the silent two-second beat.
    const captions = track([
      { words: words("hook"), offsetMs: 0 },
      { words: words("cause"), offsetMs: 5000 },
    ]);
    // " It" 5060 − 1640 = 3420 opens a page; the page before it lasts until then.
    expect(paginateCaptions(captions, { combineWithinMs: 1400 })).toEqual([
      page("What if your build was already", 50, 1590, [
        ["What", 50, 280],
        [" if", 300, 420],
        [" your", 440, 630],
        [" build", 650, 950],
        [" was", 1050, 1200],
        [" already", 1220, 1620],
      ]),
      page("broken?", 1640, 3420, [["broken?", 1640, 2100]]),
      page("It was.", 5060, 460, [
        ["It", 5060, 5200],
        [" was.", 5220, 5520],
      ]),
    ]);
  });
});

describe("paginateCaptions edge cases", () => {
  const caption = (text: string, startMs: number, endMs: number): Caption => ({
    text,
    startMs,
    endMs,
    timestampMs: null,
    confidence: null,
  });

  it("returns no pages for no captions", () => {
    expect(paginateCaptions([], { combineWithinMs: 1400 })).toEqual([]);
  });

  it("makes one page of a single caption, trimmed, lasting as long as the caption", () => {
    expect(paginateCaptions([caption(" Hello", 100, 400)], { combineWithinMs: 1400 })).toEqual([
      page("Hello", 100, 300, [["Hello", 100, 400]]),
    ]);
  });

  it("never opens a page on a caption without a leading space, however late it starts", () => {
    const pages = paginateCaptions([caption("one.", 0, 300), caption("Segment", 9000, 9400)], {
      combineWithinMs: 1400,
    });
    expect(pages.map((current) => current.text)).toEqual(["one.Segment"]);
    expect(pages[0]?.durationMs).toBe(9400);
  });

  it("with a zero window, opens a page on every caption that has a leading space", () => {
    const pages = paginateCaptions(
      [caption("a", 0, 10), caption(" b", 10, 20), caption(",", 20, 25), caption(" c", 30, 40)],
      { combineWithinMs: 0 },
    );
    expect(pages.map((current) => current.text)).toEqual(["a", "b,", "c"]);
    expect(pages.map((current) => current.durationMs)).toEqual([10, 20, 10]);
  });

  it("refuses a window that is not a number of milliseconds", () => {
    expect(() => paginateCaptions([], { combineWithinMs: -1 })).toThrow(/combineWithinMs/);
    expect(() => paginateCaptions([], { combineWithinMs: Number.NaN })).toThrow(/combineWithinMs/);
  });

  it("createTikTokStyleCaptions is the same pager under its older name", () => {
    const captions = track([{ words: words("hook"), offsetMs: 0 }]);
    expect(
      createTikTokStyleCaptions({ captions, combineTokensWithinMilliseconds: 500 }).pages,
    ).toEqual(paginateCaptions(captions, { combineWithinMs: 500 }));
  });
});
