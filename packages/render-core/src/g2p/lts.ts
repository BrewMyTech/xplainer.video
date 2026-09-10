/**
 * Layer 3 of four: a deterministic letter-to-sound ruleset (plan D8).
 *
 * **What it is for.** CMUdict plus the curated lexicon still leaves a tail —
 * proper nouns, product names nobody has transcribed yet, novel compounds, a
 * misspelling. The plan considered two ways to close it: a small Apache-2.0
 * neural fallback run on the ONNX runtime already loaded, or a ruleset. D8 chose
 * the ruleset, for three reasons that are all about the same property: **the
 * same word always yields the same pronunciation.** A caption written on one run
 * has to match the audio of the next, it needs no second model on disk, and — the
 * one that matters most for a file somebody has to maintain — a wrong
 * pronunciation here is a rule you can read, find and change.
 *
 * **D5 still holds, and this is how.** Every pronunciation derived here is
 * *reported* — `phonemise()` returns it in `derived`, naming the word and what it
 * decided — so a caller logs it, a reviewer sees it, and the fix is to add the
 * word to `data/lexicon.txt`. Silence is what D5 forbids; a guess that announces
 * itself is not silence. This layer is deliberately the second-to-last thing
 * tried and is expected to fire rarely: the S0b spike measured 50 of 50 on
 * ordinary prose from CMUdict alone.
 *
 * **The engine.** The classic context-sensitive form — for each position in the
 * word, the first rule whose letters match there and whose left and right
 * contexts are satisfied wins, and the match is consumed. The word is upper-cased
 * and padded with a space at each end, so a rule can name a word boundary. Every
 * letter ends its group with an unconditional default, so the walk can never
 * stall: a word made of letters always produces phones.
 *
 * Context patterns use these classes, and nothing else:
 *
 * | Symbol | Means |
 * |---|---|
 * | `A`–`Z` | that letter, literally |
 * | ` ` | a word boundary |
 * | `#` | one or more vowels (`AEIOUY`) |
 * | `:` | zero or more consonants |
 * | `^` | exactly one consonant |
 * | `.` | one voiced consonant (`BDVGJLMNRWZ`) |
 * | `+` | one front vowel (`EIY`) |
 * | `@` | one of `TSRDLZNJ` — the consonants after which long `U` is `/u/`, not `/ju/` |
 *
 * Matching is greedy and does not backtrack, which is why no pattern here puts a
 * literal after a `#` or a `:`. That is a constraint on the table, stated so the
 * next rule added obeys it rather than silently not matching.
 *
 * **Stress is assigned afterwards, from the spelling, and it is the weakest part
 * of this module.** English stress is not recoverable from letters in general.
 * What is implemented is the part that is: a set of suffixes that fix the
 * stressed syllable relative to the end of the word (`-tion`, `-ic`, `-ity`,
 * `-ogy`), and otherwise the first syllable. That is right for most nouns and
 * wrong for many verbs — "unbounded" comes out "UN-bounded" — and the answer to
 * that is not a cleverer guess, it is `data/lexicon.txt`. Which is exactly why
 * every word that reaches here is reported.
 */

import { arpabetPhoneToIpa } from "./arpabet.js";

/** Letters that count as vowels for the `#` and `^` classes. `Y` is one, as in "system". */
const VOWELS = "AEIOUY";

/** The `.` class: consonants that are voiced, which is what makes a final `S` a `Z`. */
const VOICED_CONSONANTS = "BDVGJLMNRWZ";

/** The `+` class: front vowels, which is what softens `C` and `G`. */
const FRONT_VOWELS = "EIY";

/** The `@` class: after these, long `U` loses its `/j/` — "rude", not "ryude". */
const U_PLAIN_CONSONANTS = "TSRDLZNJ";

/** One rule: `[left context, letters, right context, phones]`. Phones are stressless ARPAbet. */
type LtsRule = readonly [string, string, string, string];

/**
 * The ruleset, grouped by the letter each group starts with, most specific
 * first, each group ending in an unconditional default.
 *
 * Order inside a group is the whole design: `["", "AI", "", "EY"]` has to precede
 * `["", "A", "", "AE"]` or "rain" becomes "ra-in". A rule added in the wrong
 * place is not a syntax error, it is a rule that never fires.
 */
const RULES: readonly LtsRule[] = [
  // --- A ---------------------------------------------------------------------
  [" ", "A", " ", "AH"], // the article, which is a schwa and not a name
  ["", "ARE", " ", "AA R"],
  ["", "AIR", "", "EH R"],
  ["", "AI", "", "EY"],
  ["", "AY", "", "EY"],
  ["", "AU", "", "AO"],
  ["", "AW", "", "AO"],
  ["", "A", "LL", "AO"], // ball, install
  ["", "AL", "^", "AO L"], // salt, alter
  ["", "AR", "", "AA R"],
  // The productive -ATE family, which is where technical coinages live:
  // frobnicate / frobnicated / frobnicator / frobnication all want a long A.
  // Deliberately these four suffixes and NOT the general "A before one
  // consonant and a vowel" rule, which is long in "nation" and "data" and short
  // in "balance" and "planet" — a coin flip is not a rule.
  ["", "A", "TION", "EY"],
  ["", "A", "TOR", "EY"],
  ["", "A", "TED", "EY"],
  ["", "A", "TING", "EY"],
  ["", "A", "^E ", "EY"], // the silent-E rule: cake, gate, made
  ["", "A", "^^", "AE"], // two consonants close the syllable: captain
  ["", "A", " ", "AH"], // a final A reduces: comma, schema
  ["", "A", "", "AE"],

  // --- B ---------------------------------------------------------------------
  ["", "BB", "", "B"],
  ["", "B", "", "B"],

  // --- C ---------------------------------------------------------------------
  ["", "CH", "", "CH"],
  ["", "CK", "", "K"],
  ["", "CIA", "", "SH"], // special, official
  ["", "CC", "+", "K S"], // accept, success
  ["", "CC", "", "K"],
  ["", "C", "+", "S"], // soft C before a front vowel: cent, city, cycle
  ["", "C", "", "K"],

  // --- D ---------------------------------------------------------------------
  ["", "DGE", "", "JH"], // edge, badge
  ["", "DD", "", "D"],
  ["", "D", "", "D"],

  // --- E ---------------------------------------------------------------------
  ["", "EIGH", "", "EY"],
  ["", "EE", "", "IY"],
  ["", "EA", "R", "ER"], // earn, learn
  ["", "EA", "", "IY"],
  ["", "EI", "", "IY"],
  ["", "EW", "", "UW"],
  ["", "EU", "", "Y UW"],
  ["", "ER", "", "ER"],
  ["", "E", "^E ", "IY"], // these, here
  ["#:", "E", " ", ""], // silent final E, but only where the word already had a vowel
  ["", "E", " ", "IY"], // he, be, we — the words that are one consonant and an E
  ["", "E", "", "EH"],

  // --- F ---------------------------------------------------------------------
  ["", "FF", "", "F"],
  ["", "F", "", "F"],

  // --- G ---------------------------------------------------------------------
  [" ", "GH", "", "G"], // ghost
  ["#", "GH", "", ""], // night, though — silent after a vowel
  [" ", "GN", "", "N"], // gnome
  ["", "GN", " ", "N"], // sign, design
  ["", "GG", "", "G"],
  ["", "G", "+", "JH"], // soft G: gem, gin, gym
  ["", "G", "", "G"],

  // --- H ---------------------------------------------------------------------
  ["", "H", "", "HH"],

  // --- I ---------------------------------------------------------------------
  ["", "IGH", "", "AY"],
  ["", "ION", "", "AH N"],
  ["", "IE", " ", "IY"], // cookie, movie
  ["", "IR", "", "ER"],
  ["", "I", "^E ", "AY"], // time, site, line
  ["", "I", "^^", "IH"],
  ["", "I", " ", "IY"], // mini, semi
  ["", "I", "", "IH"],

  // --- J ---------------------------------------------------------------------
  ["", "J", "", "JH"],

  // --- K ---------------------------------------------------------------------
  [" ", "KN", "", "N"], // knee, knot
  ["", "KK", "", "K"],
  ["", "K", "", "K"],

  // --- L ---------------------------------------------------------------------
  ["", "LL", "", "L"],
  ["", "L", "", "L"],

  // --- M ---------------------------------------------------------------------
  ["", "MM", "", "M"],
  ["", "M", "", "M"],

  // --- N ---------------------------------------------------------------------
  ["", "NG", "", "NG"],
  ["", "N", "K", "NG"], // think, bank — the velar is in the sound and not in the spelling
  ["", "NN", "", "N"],
  ["", "N", "", "N"],

  // --- O ---------------------------------------------------------------------
  ["", "OO", "", "UW"],
  ["", "OU", "", "AW"],
  ["", "OW", "", "OW"],
  ["", "OI", "", "OY"],
  ["", "OY", "", "OY"],
  ["", "OA", "", "OW"],
  ["", "OE", " ", "OW"], // toe, foe
  ["", "OR", "", "AO R"],
  ["", "O", "^E ", "OW"], // home, node
  ["", "O", "^^", "AA"],
  ["", "O", " ", "OW"], // hello, micro
  ["", "O", "", "AA"],

  // --- P ---------------------------------------------------------------------
  ["", "PH", "", "F"],
  [" ", "PS", "", "S"], // psychology
  ["", "PP", "", "P"],
  ["", "P", "", "P"],

  // --- Q ---------------------------------------------------------------------
  ["", "QU", "", "K W"],
  ["", "Q", "", "K"],

  // --- R ---------------------------------------------------------------------
  ["", "RR", "", "R"],
  ["", "R", "", "R"],

  // --- S ---------------------------------------------------------------------
  ["", "SCH", "", "SH"],
  ["", "SH", "", "SH"],
  ["", "SION", "", "ZH AH N"],
  ["", "SS", "", "S"],
  [".", "S", " ", "Z"], // a plural after a voiced consonant: logs, builds, names
  // There is deliberately NO rule voicing a final S after a VOWEL. It would be
  // right for "keys" and "videos" and wrong for "yes", "bus", "gas", "this" and
  // "plus", and the spelling does not say which is a plural morpheme and which
  // is part of the stem. The voiced-consonant rule above already catches the
  // overwhelming majority of plurals that reach this layer at all.
  ["", "S", "", "S"],

  // --- T ---------------------------------------------------------------------
  ["", "TCH", "", "CH"],
  ["", "TION", "", "SH AH N"],
  ["", "TH", "", "TH"],
  ["", "TT", "", "T"],
  ["", "T", "", "T"],

  // --- U ---------------------------------------------------------------------
  ["@", "U", "^E ", "UW"], // rude, tune — plain /u/ after T S R D L Z N J
  ["", "UE", " ", "UW"], // true, blue
  ["", "UR", "", "ER"],
  ["", "U", "^E ", "Y UW"], // cute, mute
  ["", "U", "^^", "AH"],
  ["", "U", "", "AH"],

  // --- V ---------------------------------------------------------------------
  ["", "V", "", "V"],

  // --- W ---------------------------------------------------------------------
  ["", "WH", "", "W"],
  [" ", "WR", "", "R"], // write, wrong
  ["", "WA", "^", "W AA"], // want, watch
  ["", "W", "", "W"],

  // --- X ---------------------------------------------------------------------
  [" ", "X", "", "Z"], // xylophone
  ["", "X", "", "K S"],

  // --- Y ---------------------------------------------------------------------
  [" ", "Y", "", "Y"], // yes, yield — a consonant only at the start
  ["", "Y", "^E ", "AY"], // type, byte
  ["", "Y", " ", "IY"], // happy, only
  ["", "Y", "", "IH"],

  // --- Z ---------------------------------------------------------------------
  ["", "ZZ", "", "Z"],
  ["", "Z", "", "Z"],
];

/** The ARPAbet vowels, which is where a stress mark can go. */
const VOWEL_PHONES: ReadonlySet<string> = new Set([
  "AA",
  "AE",
  "AH",
  "AO",
  "AW",
  "AY",
  "EH",
  "ER",
  "EY",
  "IH",
  "IY",
  "OW",
  "OY",
  "UH",
  "UW",
]);

/**
 * Suffixes that put the stress on the **second-to-last** syllable.
 *
 * "creation", "atomic", "official", "efficient". Longest first, so `-CIOUS`
 * is tested before `-IOUS` and wins where both would match.
 */
const PENULTIMATE_SUFFIXES: readonly string[] = [
  "CIOUS",
  "TIOUS",
  "IENCE",
  "IENCY",
  "ESQUE",
  "CIAN",
  "TION",
  "SION",
  "TIAL",
  "CIAL",
  "IOUS",
  "EOUS",
  "IENT",
  "ITIS",
  "IAN",
  "IAL",
  "ICS",
  "IC",
];

/**
 * Suffixes that put the stress on the **third-to-last** syllable.
 *
 * "activity", "photography", "astronomy". Same longest-first ordering, and
 * tested before the penultimate set so `-ICITY` is not read as `-IC`.
 */
const ANTEPENULTIMATE_SUFFIXES: readonly string[] = [
  "OMETRY",
  "GRAPHY",
  "ONOMY",
  "ULOUS",
  "OGIST",
  "OGY",
  "ITY",
  "ETY",
  "IFY",
];

const isVowel = (letter: string | undefined): boolean =>
  letter !== undefined && VOWELS.includes(letter);

const isConsonant = (letter: string | undefined): boolean =>
  letter !== undefined && letter !== " " && !VOWELS.includes(letter);

/**
 * Does `pattern` match `word` running rightwards from `start`?
 *
 * Greedy and without backtracking; see the module docblock for why the table is
 * written so that this is sufficient.
 */
function matchesRight(word: string, start: number, pattern: string): boolean {
  let at = start;
  for (const symbol of pattern) {
    const letter = word[at];
    switch (symbol) {
      case "#": {
        if (!isVowel(letter)) {
          return false;
        }
        while (isVowel(word[at])) {
          at += 1;
        }
        break;
      }
      case ":": {
        while (isConsonant(word[at])) {
          at += 1;
        }
        break;
      }
      case "^": {
        if (!isConsonant(letter)) {
          return false;
        }
        at += 1;
        break;
      }
      case ".": {
        if (letter === undefined || !VOICED_CONSONANTS.includes(letter)) {
          return false;
        }
        at += 1;
        break;
      }
      case "+": {
        if (letter === undefined || !FRONT_VOWELS.includes(letter)) {
          return false;
        }
        at += 1;
        break;
      }
      case "@": {
        if (letter === undefined || !U_PLAIN_CONSONANTS.includes(letter)) {
          return false;
        }
        at += 1;
        break;
      }
      default: {
        if (letter !== symbol) {
          return false;
        }
        at += 1;
      }
    }
  }
  return true;
}

/**
 * The same, running leftwards from the character before `end`.
 *
 * The pattern is read right to left, so `"#:"` means "some consonants, and
 * before them a vowel" — which is the shape that makes a final `E` silent in
 * "cake" and audible in "he".
 */
function matchesLeft(word: string, end: number, pattern: string): boolean {
  let at = end - 1;
  for (let index = pattern.length - 1; index >= 0; index -= 1) {
    const symbol = pattern[index];
    const letter = at >= 0 ? word[at] : undefined;
    switch (symbol) {
      case "#": {
        if (!isVowel(letter)) {
          return false;
        }
        while (at >= 0 && isVowel(word[at])) {
          at -= 1;
        }
        break;
      }
      case ":": {
        while (at >= 0 && isConsonant(word[at])) {
          at -= 1;
        }
        break;
      }
      case "^": {
        if (!isConsonant(letter)) {
          return false;
        }
        at -= 1;
        break;
      }
      case ".": {
        if (letter === undefined || !VOICED_CONSONANTS.includes(letter)) {
          return false;
        }
        at -= 1;
        break;
      }
      case "+": {
        if (letter === undefined || !FRONT_VOWELS.includes(letter)) {
          return false;
        }
        at -= 1;
        break;
      }
      case "@": {
        if (letter === undefined || !U_PLAIN_CONSONANTS.includes(letter)) {
          return false;
        }
        at -= 1;
        break;
      }
      default: {
        if (letter !== symbol) {
          return false;
        }
        at -= 1;
      }
    }
  }
  return true;
}

/** Which vowel of `phones` carries the primary stress, or `-1` when there is none to carry it. */
function stressedVowelIndex(spelling: string, phones: readonly string[]): number {
  const vowels = phones.flatMap((phone, index) => (VOWEL_PHONES.has(phone) ? [index] : []));
  if (vowels.length === 0) {
    return -1;
  }
  if (vowels.length === 1) {
    return vowels[0] ?? -1;
  }
  const upper = spelling.toUpperCase();
  if (ANTEPENULTIMATE_SUFFIXES.some((suffix) => upper.endsWith(suffix)) && vowels.length >= 3) {
    return vowels[vowels.length - 3] ?? -1;
  }
  if (PENULTIMATE_SUFFIXES.some((suffix) => upper.endsWith(suffix))) {
    return vowels[vowels.length - 2] ?? -1;
  }
  return vowels[0] ?? -1;
}

/**
 * `word` as stressless ARPAbet phones, or `null` if it holds a character that is
 * not a letter.
 *
 * Exported for `lts.test.ts`, which asserts rules by the phones they produce
 * rather than through two more translations.
 */
export function lettersToPhones(word: string): readonly string[] | null {
  if (!/^[A-Za-z]+$/.test(word)) {
    return null;
  }
  const padded = ` ${word.toUpperCase()} `;
  const phones: string[] = [];
  let at = 1;
  while (at < padded.length - 1) {
    const rule = RULES.find(
      ([left, letters, right]) =>
        padded.startsWith(letters, at) &&
        matchesRight(padded, at + letters.length, right) &&
        matchesLeft(padded, at, left),
    );
    if (rule === undefined) {
      // Unreachable while every letter group ends in an unconditional default.
      // Returning null rather than continuing keeps that a refusal instead of a
      // dropped letter, which is the distinction D5 is about.
      return null;
    }
    const [, letters, , produced] = rule;
    if (produced !== "") {
      phones.push(...produced.split(" "));
    }
    at += letters.length;
  }
  return phones;
}

/**
 * `word`'s letter-to-sound pronunciation as Kokoro IPA, or `null` if it is not a
 * run of English letters.
 *
 * The stress digits are applied here rather than in the table because stress is
 * a property of the whole word and the table is local to a position.
 */
export function lettersToIpa(word: string): string | null {
  const phones = lettersToPhones(word);
  if (phones === null || phones.length === 0) {
    return null;
  }
  const stressed = stressedVowelIndex(word, phones);
  let ipa = "";
  for (const [index, phone] of phones.entries()) {
    const withStress = VOWEL_PHONES.has(phone)
      ? `${phone}${index === stressed ? "1" : "0"}`
      : phone;
    const translated = arpabetPhoneToIpa(withStress);
    if (translated === null) {
      return null;
    }
    ipa += translated;
  }
  return ipa;
}

/**
 * Every ARPAbet phone this ruleset can produce, stressless, so `vocab.test.ts`
 * can check the whole reachable alphabet without executing the rules.
 */
export const LTS_PHONES: readonly string[] = [
  ...new Set(RULES.flatMap(([, , , phones]) => (phones === "" ? [] : phones.split(" ")))),
];
