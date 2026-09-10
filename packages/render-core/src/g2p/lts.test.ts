import { describe, expect, it } from "vitest";
import { spellOutLetters } from "./letters.js";
import { lettersToIpa, lettersToPhones } from "./lts.js";

/**
 * Layer 3: the deterministic ruleset, and the property that makes it worth
 * having (D8).
 *
 * The rules are asserted through the phones they produce rather than through
 * IPA, because a rule is about spelling and a translation is a separate concern
 * that `arpabet.test`-worthy assertions in `cmudict.test.ts` already cover. The
 * words below are real English chosen so that a reader can check the expectation
 * by saying it — and none of them is in the lexicon, so the ruleset is what is
 * being measured even where CMUdict would also have known the word.
 */

describe("determinism, which is the reason this layer exists", () => {
  it("gives the same answer every time, for the same word", () => {
    const once = lettersToIpa("frobnicator");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(lettersToIpa("frobnicator")).toBe(once);
    }
  });

  it("is case insensitive, so a capitalised sentence opener is not a different word", () => {
    expect(lettersToIpa("Frobnicator")).toBe(lettersToIpa("frobnicator"));
    expect(lettersToIpa("FROBNICATOR")).toBe(lettersToIpa("frobnicator"));
  });

  it("refuses anything that is not a run of English letters", () => {
    expect(lettersToPhones("x86")).toBeNull();
    expect(lettersToPhones("don't")).toBeNull();
    expect(lettersToPhones("")).toBeNull();
  });
});

describe("the rules", () => {
  const cases: readonly (readonly [string, readonly string[], string])[] = [
    ["rain", ["R", "EY", "N"], "AI is a single long A"],
    ["day", ["D", "EY"], "so is AY"],
    ["ball", ["B", "AO", "L"], "A before LL is broad"],
    ["cake", ["K", "EY", "K"], "the silent-E rule lengthens the vowel and drops the E"],
    ["he", ["HH", "IY"], "but a final E is a vowel when the word has no other"],
    ["city", ["S", "IH", "T", "IY"], "C before a front vowel is soft"],
    ["cat", ["K", "AE", "T"], "and hard otherwise"],
    ["chair", ["CH", "EH", "R"], "CH is one phone"],
    ["knot", ["N", "AA", "T"], "an initial KN loses the K"],
    ["write", ["R", "AY", "T"], "an initial WR loses the W"],
    ["phone", ["F", "OW", "N"], "PH is F"],
    ["quick", ["K", "W", "IH", "K"], "QU is KW"],
    ["night", ["N", "AY", "T"], "IGH is a long I"],
    ["ship", ["SH", "IH", "P"], "SH is one phone"],
    ["think", ["TH", "IH", "NG", "K"], "TH is one phone and NG is another"],
    ["logs", ["L", "AA", "G", "Z"], "a plural S after a voiced consonant is a Z"],
    ["cats", ["K", "AE", "T", "S"], "and stays an S after a voiceless one"],
    ["box", ["B", "AA", "K", "S"], "X is two phones"],
    ["yes", ["Y", "EH", "S"], "Y is a consonant only at the start of a word"],
    ["bus", ["B", "AH", "S"], "and a final S after a vowel stays voiceless, deliberately"],
    ["happy", ["HH", "AE", "P", "IY"], "and a vowel at the end"],
    ["edge", ["EH", "JH"], "DGE is one affricate"],
    ["rude", ["R", "UW", "D"], "long U after R has no glide"],
    ["cute", ["K", "Y", "UW", "T"], "and keeps one elsewhere"],
  ];

  for (const [word, phones, why] of cases) {
    it(`${word}: ${why}`, () => {
      expect(lettersToPhones(word)).toEqual(phones);
    });
  }
});

describe("stress, which is the weakest part and is therefore pinned", () => {
  it("puts the beat on the first syllable when nothing says otherwise", () => {
    expect(lettersToIpa("frobnicator")).toBe("fɹˈɑbnɪkAtɔɹ");
  });

  it("moves it back one for a -tion or -ic word", () => {
    // "frob-ni-CAY-shun": the -TION suffix fixes the beat on the syllable before
    // it, wherever in the word that lands.
    expect(lettersToIpa("frobnication")).toBe("fɹɑbnɪkˈAʃən");
    // "blorp-TAS-tic" — the same rule through -IC.
    expect(lettersToIpa("blorptastic")).toBe("blɔɹptˈæstɪk");
  });

  it("marks exactly one syllable, never none and never two", () => {
    for (const word of ["frobnicator", "blorptastic", "gronkulated", "widget", "a", "strengths"]) {
      const ipa = lettersToIpa(word) ?? "";
      const primary = [...ipa].filter((symbol) => symbol === "ˈ").length;
      expect({ word, primary }).toEqual({ word, primary: ipa === "" ? 0 : 1 });
    }
  });
});

describe("spelling a token out letter by letter", () => {
  it("stresses the last letter and only the last", () => {
    expect(spellOutLetters("srv")).toBe("ˌɛsˌɑɹvˈi");
  });

  it("agrees with the curated entries that spell letters out by hand", () => {
    // `data/lexicon.txt` writes "S-Q-L" as ˌɛskjˌuˈɛl. A term that graduates
    // from the speller into the lexicon must not change how it sounds.
    expect(spellOutLetters("sql")).toBe("ˌɛskjˌuˈɛl");
    expect(spellOutLetters("xml")).toBe("ˌɛksˌɛmˈɛl");
  });

  it("is case insensitive", () => {
    expect(spellOutLetters("SQL")).toBe(spellOutLetters("sql"));
  });

  it("refuses a token holding anything but letters", () => {
    expect(spellOutLetters("s3")).toBeNull();
    expect(spellOutLetters("")).toBeNull();
  });
});
