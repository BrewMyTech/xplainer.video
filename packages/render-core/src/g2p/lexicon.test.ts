import { describe, expect, it } from "vitest";
import { lexiconEntries, lookUpLexicon } from "./lexicon.js";

/**
 * Layer 1 as data: the file parses, says each thing once, and says the things it
 * claims to say.
 *
 * The vocabulary-subset assertion over every entry lives in `vocab.test.ts`,
 * with the other three layers, because it is one property of all of them. What
 * is here is the file's own integrity and a spot-check of the pronunciations
 * against the glosses beside them — which is the review this file was written to
 * be reviewable by.
 */

describe("the lexicon file", () => {
  const entries = lexiconEntries();

  it("holds a useful number of curated terms", () => {
    expect(entries.length).toBeGreaterThan(200);
  });

  it("gives every entry a gloss, because the gloss is how a human checks it", () => {
    const ungloss = entries.filter((entry) => entry.gloss === null).map((entry) => entry.spelling);
    expect(ungloss).toEqual([]);
  });

  it("gives every entry a primary stress, and no spoken word two of them", () => {
    // An entry may be several spoken words — "systemd" is "system D" — so the
    // count is per space-separated part rather than per entry. What must never
    // happen is a part with no beat at all across the whole entry, which is what
    // a missing mark sounds like, or two beats in one word, which is what a
    // stray one sounds like.
    const unstressed = entries
      .filter((entry) => !entry.ipa.includes("ˈ"))
      .map((entry) => entry.spelling);
    expect(unstressed).toEqual([]);
    const doubled = entries
      .filter((entry) =>
        entry.ipa.split(" ").some((part) => [...part].filter((mark) => mark === "ˈ").length > 1),
      )
      .map((entry) => entry.spelling);
    expect(doubled).toEqual([]);
  });

  it("never lets an apostrophe or a hyphen into a pronunciation", () => {
    // Neither is in Kokoro's vocabulary; a `'` typed for a stress mark is the
    // realistic mistake, and it looks almost identical in a proportional font.
    const wrong = entries.filter((entry) => /['’-]/.test(entry.ipa)).map((entry) => entry.spelling);
    expect(wrong).toEqual([]);
  });

  it("uses only the five upper-case letters that are phonemes", () => {
    // `A I O W Y` are misaki's shorthands for the vowels of day, my, go, now and
    // boy. Every OTHER upper-case letter is either absent from the vocabulary —
    // which `vocab.test.ts` would catch — or, worse, present as a symbol for
    // some other language: `Q` (33), `S` (35) and `T` (36) all have token ids,
    // so a `T` typed here meaning "tee" would tokenise cleanly and synthesise as
    // something nobody intended. That is the one mistake in this file that no
    // other gate can see, which is why it has its own.
    const allowed = new Set(["A", "I", "O", "W", "Y"]);
    const wrong = entries
      .filter((entry) => [...entry.ipa].some((s) => /[A-Z]/.test(s) && !allowed.has(s)))
      .map((entry) => entry.spelling);
    expect(wrong).toEqual([]);
  });

  it("never writes a two-symbol affricate or diphthong where a single symbol belongs", () => {
    // Kokoro reads `tʃ` as a stop then a fricative and `eɪ` as two vowels — a
    // x1.70 and x1.66 stretch of those regions. The lexicon is hand-written, so
    // it is the one layer where the old spelling can come back by habit; the
    // other three go through `arpabet.ts` and cannot.
    const sequences = ["tʃ", "dʒ", "eɪ", "aɪ", "oʊ", "aʊ", "ɔɪ"];
    const wrong = entries
      .filter((entry) => sequences.some((sequence) => entry.ipa.includes(sequence)))
      .map((entry) => entry.spelling);
    expect(wrong).toEqual([]);
  });

  it("never writes ASCII g where the script g belongs", () => {
    const wrong = entries.filter((entry) => entry.ipa.includes("g")).map((entry) => entry.spelling);
    expect(wrong).toEqual([]);
  });

  it("refuses two entries for one spelling rather than letting one win silently", () => {
    const seen = new Set<string>();
    for (const entry of entries) {
      const key = entry.caseSensitive ? entry.spelling : entry.spelling.toLowerCase();
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe("looking a term up", () => {
  it("is case insensitive for a lower-case entry", () => {
    const expected = "ˈɛnʤɪn ˌɛks";
    expect(lookUpLexicon("nginx")).toBe(expected);
    expect(lookUpLexicon("Nginx")).toBe(expected);
    expect(lookUpLexicon("NGINX")).toBe(expected);
  });

  it("answers null for a term it does not carry", () => {
    expect(lookUpLexicon("frobnicator")).toBeNull();
  });
});

describe("the seeded terms say what their glosses say", () => {
  /**
   * The pronunciations the task named explicitly, spelled out here so that a
   * change to any of them is a change to this file too. "nginx" is "engine X"
   * and "PostgreSQL" is "post-gres-Q-L" — those are the two the plan calls out
   * by name, and they are the two a rule-based G2P would certainly get wrong.
   */
  const spotChecks: readonly (readonly [string, string, string])[] = [
    ["nginx", "ˈɛnʤɪn ˌɛks", "engine X"],
    ["postgresql", "pˈOstɡɹɛs kjˌuˈɛl", "post-gres-Q-L"],
    ["kubernetes", "ˌkubɚnˈɛtiz", "koo-ber-NET-eez"],
    ["systemd", "sˈɪstəm dˈi", "system-D"],
    ["launchd", "lˈɔnʧ dˈi", "launch-D"],
    ["json", "ʤˈAsən", "JAY-son"],
    ["yaml", "jˈæməl", "YAM-ul"],
    ["sql", "ˌɛskjˌuˈɛl", "S-Q-L"],
    ["npm", "ˌɛnpˌiˈɛm", "N-P-M"],
    ["oauth", "ˌOˈɔθ", "oh-AWTH"],
    ["idempotent", "Idˈɛmpətənt", "eye-DEM-po-tent"],
    ["onnx", "ˈɑnɪks", "ON-nix"],
    ["vite", "vˈit", "veet"],
    ["goroutine", "ɡˈOɹutˌin", "GO-rou-teen"],
    ["typescript", "tˈIpskɹˌɪpt", "TYPE-script"],
  ];

  for (const [spelling, ipa, gloss] of spotChecks) {
    it(`${spelling} is "${gloss}"`, () => {
      expect(lookUpLexicon(spelling)).toBe(ipa);
    });
  }
});
