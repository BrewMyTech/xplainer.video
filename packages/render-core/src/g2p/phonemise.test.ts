import { describe, expect, it } from "vitest";
import { G2pError } from "./errors.js";
import { phonemise } from "./phonemise.js";
import { isProbableInitialism, resolveWord, splitCompound } from "./resolve.js";
import { tokenise } from "./tokenise.js";
import { unsupportedSymbols } from "./vocab.js";

/**
 * The four layers in precedence order, the spans, and the refusal — the three
 * things the rest of the speech path depends on.
 *
 * Every assertion here is over real text and real data files; there is no
 * stubbed dictionary and no injected lexicon, because the thing being tested is
 * partly the data. That is the same choice `src/narrate/` makes about testing
 * from committed fixtures rather than from a live server.
 */

describe("the layers, in precedence order", () => {
  it("1. the curated lexicon wins, even over a word CMUdict knows", () => {
    // CMUdict carries `mac` and `sql`, and its readings are not the ones a
    // narration about software wants. Precedence is what makes the lexicon able
    // to correct the dictionary rather than only to extend it.
    const { words } = phonemise("Kubernetes nginx PostgreSQL");
    expect(words.map((word) => word.source)).toEqual(["lexicon", "lexicon", "lexicon"]);
    expect(resolveWord("nginx")).toEqual({ ipa: "ˈɛnʤɪn ˌɛks", source: "lexicon" });
  });

  it("2. CMUdict answers ordinary English", () => {
    const { words } = phonemise("the cached value was stale");
    expect(words.every((word) => word.source === "cmudict")).toBe(true);
  });

  it("3a. an initialism is spelled out rather than pronounced as a word", () => {
    const { words, derived } = phonemise("the srv record");
    expect(words[1]).toMatchObject({ word: "srv", source: "initialism" });
    expect(derived).toEqual([{ word: "srv", ipa: "ˌɛsˌɑɹvˈi", source: "initialism" }]);
  });

  it("3b. everything else reaches the letter-to-sound ruleset", () => {
    const { words, derived } = phonemise("a frobnicator");
    expect(words[1]?.source).toBe("letter-to-sound");
    expect(derived).toEqual([
      { word: "frobnicator", ipa: "fɹˈɑbnɪkAtɔɹ", source: "letter-to-sound" },
    ]);
  });

  it("4. a word nothing can read is a refusal that names it, never an empty string", () => {
    let raised: unknown = null;
    try {
      phonemise("the café was closed");
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(G2pError);
    expect((raised as G2pError).code).toBe("UNPRONOUNCEABLE");
    expect((raised as G2pError).word).toBe("é");
  });

  it("reports every derived pronunciation and nothing that was looked up", () => {
    // D5's rule applied to a guess: the caller can log exactly the words that
    // need a lexicon entry, and no more.
    const { derived } = phonemise("Kubernetes ran the frobnicator on srv");
    expect(derived.map((entry) => entry.word)).toEqual(["frobnicator", "srv"]);
  });

  it("says nothing when every word was looked up", () => {
    expect(phonemise("Kubernetes and nginx both restarted.").derived).toEqual([]);
  });
});

describe("the phoneme string", () => {
  it("is the exact string the spike drove Kokoro with", () => {
    const { ipa } = phonemise("The cached value was stale, so the reader observed an old record.");
    expect(ipa).toBe("ðə kˈæʃt vˈælju wˈɑz stˈAl, sˈO ðə ɹˈidɚ əbzˈɚvd ˈæn ˈOld ɹəkˈɔɹd.");
  });

  it("only ever holds symbols Kokoro has a token for", () => {
    const text =
      'Deploy v2.1 to 3 nodes — "carefully" — then check (the logs) at 99% and 5:30; SQL, YAML…';
    expect(unsupportedSymbols(phonemise(text).ipa)).toEqual([]);
  });

  it("attaches punctuation to the word before it, and an opening bracket to the word after", () => {
    expect(phonemise("yes, no.").ipa).toBe("jˈɛs, nˈO.");
    expect(phonemise("a (b) c").ipa.includes("(bˈi)")).toBe(true);
  });

  it("collapses a run of full stops into the one ellipsis token the model has", () => {
    expect(phonemise("wait... go").ipa).toContain("…");
    expect(phonemise("wait... go").ipa).not.toContain("...");
  });

  it("never emits an apostrophe, which the model has no token for", () => {
    expect(phonemise("the daemon's socket").ipa).not.toContain("'");
  });
});

describe("the per-word spans, which are what make word-level timing possible", () => {
  const source = "Kubernetes restarted nginx, twice.";
  const { ipa, words } = phonemise(source);

  it("gives one span per spoken word, in reading order", () => {
    expect(words.map((word) => word.word)).toEqual(["Kubernetes", "restarted", "nginx", "twice"]);
  });

  it("slices back to exactly that word's phonemes", () => {
    expect(ipa.slice(words[0]?.start ?? 0, words[0]?.end ?? 0)).toBe("ˌkubɚnˈɛtiz");
    expect(ipa.slice(words[2]?.start ?? 0, words[2]?.end ?? 0)).toBe("ˈɛnʤɪn ˌɛks");
  });

  it("never overlaps, and always moves forward", () => {
    for (const [index, word] of words.entries()) {
      expect(word.end).toBeGreaterThan(word.start);
      const previous = words[index - 1];
      if (previous !== undefined) {
        expect(word.start).toBeGreaterThanOrEqual(previous.end);
      }
    }
  });

  it("leaves the separators and the punctuation outside every span", () => {
    // The silence at a comma belongs to no word. A span that swallowed it would
    // stretch that word's caption across a pause, which reads as lag — the same
    // argument src/narrate/ makes about a word's end being its own end_time.
    const covered = new Set<number>();
    for (const word of words) {
      for (let at = word.start; at < word.end; at += 1) {
        covered.add(at);
      }
    }
    const uncovered = [...ipa].flatMap((symbol, at) => (covered.has(at) ? [] : [symbol]));
    expect(new Set(uncovered)).toEqual(new Set([" ", ",", "."]));
  });
});

describe("numbers, punctuation, acronyms and possessives, each decided deliberately", () => {
  it("reads an integer as a cardinal and never as a year", () => {
    expect(phonemise("1999").words[0]?.word).toBe("1999");
    expect(phonemise("in 1999").ipa).toBe(
      phonemise("in one thousand nine hundred ninety nine").ipa,
    );
  });

  it("reads a decimal point as 'point' and the fraction digit by digit", () => {
    expect(phonemise("version 1.0").ipa).toBe(phonemise("version one point zero").ipa);
    expect(phonemise("3.14").ipa).toBe(phonemise("three point one four").ipa);
  });

  it("reads an ordinal as an ordinal", () => {
    expect(phonemise("21st").ipa).toBe(phonemise("twenty first").ipa);
  });

  it("reads a unit symbol as its word, and moves a currency symbol after its number", () => {
    expect(phonemise("50%").ipa).toBe(phonemise("fifty percent").ipa);
    expect(phonemise("$5").ipa).toBe(phonemise("five dollars").ipa);
  });

  it("builds a possessive from its stem and the right allomorph", () => {
    // /z/ after a voiced consonant, /s/ after a voiceless one, /ɪz/ after a
    // sibilant. Morphology, not a guess — and it is what lets an unknown word
    // take a possessive at all.
    expect(resolveWord("frobnicator's")?.ipa.endsWith("z")).toBe(true);
    expect(resolveWord("widget's")?.ipa.endsWith("s")).toBe(true);
    expect(resolveWord("nginx's")?.ipa.endsWith("ɪz")).toBe(true);
    expect(resolveWord("developers'")?.ipa).toBe(resolveWord("developers")?.ipa);
  });

  it("splits a compound only after the whole token has failed the dictionary", () => {
    expect(splitCompound("write-ahead")).toEqual(["write", "ahead"]);
    expect(splitCompound("snake_case")).toEqual(["snake", "case"]);
    expect(splitCompound("putSource")).toEqual(["put", "Source"]);
    expect(splitCompound("HTTPServer")).toEqual(["HTTP", "Server"]);
    expect(splitCompound("x86")).toEqual(["x", "86"]);
    // But PostgreSQL and TypeScript are single lexicon entries and must not be
    // taken apart before layer 1 has seen them.
    expect(resolveWord("PostgreSQL")?.source).toBe("lexicon");
    expect(resolveWord("TypeScript")?.source).toBe("lexicon");
  });

  it("spells out a token that looks like an initialism, and only such a token", () => {
    expect(isProbableInitialism("SQL")).toBe(true);
    expect(isProbableInitialism("srv")).toBe(true);
    expect(isProbableInitialism("cache")).toBe(false);
    expect(isProbableInitialism("Kubernetes")).toBe(false);
    // The stated trade-off: an all-caps word that is also an English word is
    // read as the word, because layers 1 and 2 run first.
    expect(resolveWord("IT")?.source).toBe("cmudict");
  });

  it("drops the characters that are not spoken, and reads the ones that are", () => {
    expect(tokenise("a [b] c").map((token) => token.text)).toEqual(["a", "b", "c"]);
    expect(phonemise("a & b").ipa).toBe(phonemise("a and b").ipa);
    expect(phonemise("a / b").ipa).toBe(phonemise("a slash b").ipa);
  });
});

describe("D5, as a property rather than as a case", () => {
  /**
   * The rule the whole port exists for: a word is spoken, or the call fails
   * naming it. There is no third outcome, and in particular no outcome where a
   * word is present in the text, absent from the audio, and mentioned nowhere.
   *
   * Asserted over deliberately awkward input — the shapes that would tempt a
   * layer into returning "" and carrying on.
   */
  const awkward: readonly string[] = [
    "a",
    "I",
    "e",
    "gh",
    "hmm",
    "queue",
    "strengths",
    "xyzzy",
    "aaaaaa",
    "zzz",
    "ough",
    "mkdir",
    "tsx",
    "s3",
    "x86",
    "utf8",
    "v1.2.3",
    "0",
    "007",
    "1234567890123456789",
    "-42",
    "don't",
    "developers'",
    "nginx's",
    "write-ahead-log",
    "snake_case_name",
    "camelCaseIdentifier",
    "HTTPServerFactory",
    "K8s",
    "e.g",
  ];

  for (const token of awkward) {
    it(`${token} is spoken, never silently dropped`, () => {
      const { ipa, words } = phonemise(token);
      expect(words.length).toBeGreaterThan(0);
      for (const word of words) {
        expect(word.end).toBeGreaterThan(word.start);
        expect(ipa.slice(word.start, word.end).trim()).not.toBe("");
      }
      expect(unsupportedSymbols(ipa)).toEqual([]);
    });
  }

  it("gives every word of a sentence a span of its own", () => {
    const text = "Kubernetes 1.29 restarted nginx's worker after a frobnicating x86 build failed.";
    const { words } = phonemise(text);
    expect(words.map((word) => word.word)).toEqual([
      "Kubernetes",
      "1.29",
      "restarted",
      "nginx's",
      "worker",
      "after",
      "a",
      "frobnicating",
      "x86",
      "build",
      "failed",
    ]);
  });
});

describe("the empty case", () => {
  it("refuses text with no word in it rather than answering silence", () => {
    // A segment that phonemised to nothing would synthesise to a silent clip
    // whose length every scene boundary downstream would inherit.
    for (const text of ["", "   ", "-- ... --", "[]"]) {
      let raised: unknown = null;
      try {
        phonemise(text);
      } catch (error) {
        raised = error;
      }
      expect({ text, code: (raised as G2pError | null)?.code }).toEqual({
        text,
        code: "NOTHING_TO_SPEAK",
      });
    }
  });
});
