import { kokoroVocabulary, phonemise } from "@xplainer/render-core";
import { describe, expect, it } from "vitest";
import { PAD_TOKEN, tokenisePhonemes, tokenRange } from "./tokens.js";

describe("tokenisePhonemes", () => {
  it("pads at both ends and gives one token per IPA symbol", () => {
    const tokens = tokenisePhonemes("ðə");

    expect(tokens.ids[0]).toBe(PAD_TOKEN);
    expect(tokens.ids.at(-1)).toBe(PAD_TOKEN);
    expect(tokens.phonemeCount).toBe(2);
    expect(tokens.ids).toHaveLength(4);
  });

  it("records the character each token came from, and -1 for the two pads", () => {
    const tokens = tokenisePhonemes("kæt");

    expect(tokens.offsets).toEqual([-1, 0, 1, 2, -1]);
  });

  it("uses the vendored vocabulary rather than a table of its own", () => {
    const vocabulary = kokoroVocabulary();
    const tokens = tokenisePhonemes("kæt");

    expect(tokens.ids.slice(1, -1)).toEqual([
      vocabulary.get("k"),
      vocabulary.get("æ"),
      vocabulary.get("t"),
    ]);
  });

  it("refuses a symbol with no token instead of dropping it", () => {
    // ASCII `g` is the case that matters: the vocabulary carries a-f and h-z and skips exactly
    // where `g` would sit, because `ɡ` U+0261 is the phoneme. The two are indistinguishable on
    // screen, and a drop would turn "go" into "oh" with nothing saying so.
    expect(() => tokenisePhonemes("ɡoʊ ɡud")).not.toThrow();
    expect(() => tokenisePhonemes("goʊ")).toThrow(/no token for: "g"/);
  });

  it("names every unknown symbol once, in order of first appearance", () => {
    expect(() => tokenisePhonemes("g@k@")).toThrow(/"g", "@"/);
  });

  it("refuses a string that tokenised to nothing rather than answering silence", () => {
    expect(() => tokenisePhonemes("")).toThrow(/tokenised to nothing/);
  });

  it("tokenises what the G2P actually emits, punctuation and spaces included", () => {
    const spoken = phonemise("The cached value was stale, so the reader observed it.");
    const tokens = tokenisePhonemes(spoken.ipa);

    expect(tokens.phonemeCount).toBe([...spoken.ipa].length);
    expect(tokens.offsets.slice(1, -1)).toEqual([...spoken.ipa].map((_, index) => index));
  });
});

describe("tokenRange", () => {
  const tokens = tokenisePhonemes("kæt sæt");

  it("maps a character span onto the tokens inside it, pads excluded", () => {
    expect(tokenRange(tokens, 0, 3)).toEqual({ first: 1, last: 3 });
    expect(tokenRange(tokens, 4, 7)).toEqual({ first: 5, last: 7 });
  });

  it("answers null for a span that covers no token", () => {
    expect(tokenRange(tokens, 3, 3)).toBeNull();
  });

  it("finds every word the G2P reported, in the string the G2P returned", () => {
    const spoken = phonemise("Kubernetes restarted the adjacent node.");
    const tokens = tokenisePhonemes(spoken.ipa);

    for (const word of spoken.words) {
      const range = tokenRange(tokens, word.start, word.end);
      expect(range, word.word).not.toBeNull();
      expect(range?.last).toBeGreaterThanOrEqual(range?.first ?? 0);
    }
  });
});
