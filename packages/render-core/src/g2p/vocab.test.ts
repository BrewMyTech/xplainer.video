import { describe, expect, it } from "vitest";
import { ARPABET_IPA_SYMBOLS, arpabetPhoneToIpa } from "./arpabet.js";
import { G2pError } from "./errors.js";
import { LETTER_NAME_SYMBOLS } from "./letters.js";
import { lexiconEntries } from "./lexicon.js";
import { LTS_PHONES } from "./lts.js";
import { phonemise } from "./phonemise.js";
import { SPOKEN_SYMBOLS } from "./tokenise.js";
import { kokoroTokenIds, kokoroVocabulary, unsupportedSymbols } from "./vocab.js";

/**
 * The assertion the whole G2P rests on (plan D5).
 *
 * Kokoro drops a symbol it has no token for. Not an error, not a warning — the
 * id lookup misses and the symbol is gone, so a phoneme outside the vocabulary
 * is a consonant missing from the audio with nothing anywhere saying so. The
 * refusal in `vocab.ts` is the last line of defence; this file is the first, and
 * it works by enumerating every symbol every layer can emit rather than by
 * sampling text and hoping.
 *
 * There are four sources of symbols and all four are walked:
 *
 *   1. the ARPAbet table, at every stress level;
 *   2. the letter names the initialism speller uses;
 *   3. the phones the letter-to-sound ruleset can produce, at every stress level;
 *   4. every line of the curated lexicon, which is hand-written and therefore
 *      the one place a typo can put a bare ASCII `g` where `ɡ` belongs.
 *
 * Plus the punctuation the tokeniser passes through, which reaches the phoneme
 * string as literal characters.
 */

const vocabulary = kokoroVocabulary();

/** Every symbol in a string that Kokoro has no token for. */
const missingFrom = (ipa: string): readonly string[] => unsupportedSymbols(ipa);

describe("the vendored Kokoro vocabulary", () => {
  it("is the 115-symbol table the timestamped ONNX model was built with", () => {
    expect(vocabulary.size).toBe(115);
    expect(vocabulary.get("$")).toBe(0);
    expect(vocabulary.get(" ")).toBe(16);
  });

  it("carries the script g and not the ASCII one, which is why the table says so", () => {
    expect(vocabulary.has("ɡ")).toBe(true);
    expect(vocabulary.has("g")).toBe(false);
  });

  it("carries both stress marks, without which every word is flat", () => {
    expect(vocabulary.has("ˈ")).toBe(true);
    expect(vocabulary.has("ˌ")).toBe(true);
  });

  it("carries misaki's single-character affricates and diphthongs, at these ids", () => {
    // The seven symbols `arpabet.ts` emits instead of the two-character
    // sequences, because Kokoro was trained against misaki and reads a sequence
    // as two segments. Asserted by id rather than by presence: a tokenizer
    // swapped for one from a different Kokoro variant could carry the same
    // symbols at different ids, and that is exactly the failure the size check
    // above cannot see on its own.
    expect(
      Object.fromEntries(
        ["ʧ", "ʤ", "A", "I", "O", "W", "Y"].map((symbol) => [symbol, vocabulary.get(symbol)]),
      ),
    ).toEqual({ ʧ: 133, ʤ: 82, A: 24, I: 25, O: 31, W: 39, Y: 41 });
  });

  it("also carries the sequences, which is why the choice needed a measurement", () => {
    // Both spellings tokenise, so nothing fails loudly if the wrong one is
    // emitted — the only symptom is timing. That is what made this worth
    // measuring rather than reasoning about, and it is why the lexicon has a
    // test of its own forbidding the sequences.
    for (const symbol of ["t", "ʃ", "d", "ʒ", "e", "ɪ", "a", "o", "ʊ", "ɔ"]) {
      expect({ symbol, known: vocabulary.has(symbol) }).toEqual({ symbol, known: true });
    }
  });
});

describe("every symbol this package can emit is in that vocabulary", () => {
  it("covers the ARPAbet translation table", () => {
    for (const symbol of ARPABET_IPA_SYMBOLS) {
      expect({ symbol, missing: missingFrom(symbol) }).toEqual({ symbol, missing: [] });
    }
  });

  it("covers every ARPAbet phone at every stress level", () => {
    const phones = [
      "AA",
      "AE",
      "AH",
      "AO",
      "AW",
      "AY",
      "B",
      "CH",
      "D",
      "DH",
      "EH",
      "ER",
      "EY",
      "F",
      "G",
      "HH",
      "IH",
      "IY",
      "JH",
      "K",
      "L",
      "M",
      "N",
      "NG",
      "OW",
      "OY",
      "P",
      "R",
      "S",
      "SH",
      "T",
      "TH",
      "UH",
      "UW",
      "V",
      "W",
      "Y",
      "Z",
      "ZH",
    ];
    for (const phone of phones) {
      for (const stress of ["", "0", "1", "2"]) {
        const ipa = arpabetPhoneToIpa(`${phone}${stress}`);
        expect({ phone, stress, ipa }).toEqual({ phone, stress, ipa });
        expect(ipa).not.toBeNull();
        expect({ phone, stress, missing: missingFrom(ipa ?? "") }).toEqual({
          phone,
          stress,
          missing: [],
        });
      }
    }
  });

  it("covers the letter names the initialism speller uses", () => {
    for (const symbol of LETTER_NAME_SYMBOLS) {
      expect({ symbol, missing: missingFrom(symbol) }).toEqual({ symbol, missing: [] });
    }
  });

  it("covers every phone the letter-to-sound ruleset can produce", () => {
    for (const phone of LTS_PHONES) {
      for (const stress of ["", "0", "1"]) {
        const ipa = arpabetPhoneToIpa(`${phone}${stress}`);
        expect({ phone, ipa }).toEqual({ phone, ipa });
        expect(ipa).not.toBeNull();
        expect({ phone, stress, missing: missingFrom(ipa ?? "") }).toEqual({
          phone,
          stress,
          missing: [],
        });
      }
    }
  });

  it("covers every entry in the curated lexicon", () => {
    for (const entry of lexiconEntries()) {
      expect({ spelling: entry.spelling, missing: missingFrom(entry.ipa) }).toEqual({
        spelling: entry.spelling,
        missing: [],
      });
    }
  });

  it("covers the punctuation the tokeniser passes through", () => {
    for (const symbol of [".", ",", "!", "?", ";", ":", '"', "(", ")", "“", "”", "…", "—"]) {
      expect({ symbol, missing: missingFrom(symbol) }).toEqual({ symbol, missing: [] });
    }
  });

  it("covers a phonemisation that reaches all four layers at once", () => {
    const { ipa } = phonemise(
      "Kubernetes restarted nginx at 3:04, the frobnicating widget's SQL query timed out — twice.",
    );
    expect(missingFrom(ipa)).toEqual([]);
  });

  it("covers every symbol word, which reaches the layers as English", () => {
    for (const symbol of Object.keys(SPOKEN_SYMBOLS)) {
      const { ipa } = phonemise(`a ${symbol} b`);
      expect({ symbol, missing: missingFrom(ipa) }).toEqual({ symbol, missing: [] });
    }
  });
});

describe("kokoroTokenIds", () => {
  it("turns a phoneme string into one id per symbol", () => {
    const ids = kokoroTokenIds("kˈæt");
    expect(ids).toEqual([53, 156, 72, 62]);
  });

  it("refuses an out-of-vocabulary symbol instead of dropping it", () => {
    // ASCII `g` is the realistic version of this mistake: it is indistinguishable
    // from `ɡ` in most editors and the model would silently swallow it.
    expect(() => kokoroTokenIds("ɡoʊ")).not.toThrow();
    let raised: unknown = null;
    try {
      kokoroTokenIds("goʊ");
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(G2pError);
    expect((raised as G2pError).code).toBe("UNPRONOUNCEABLE");
    expect((raised as G2pError).message).toContain('"g"');
  });

  it("names every unknown symbol once, in order", () => {
    expect(unsupportedSymbols("gʧg")).toEqual(["g"]);
  });
});
