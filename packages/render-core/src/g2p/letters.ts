/**
 * Letter names, and the initialism speller built out of them.
 *
 * This is the part of layer 3 that runs *before* the letter-to-sound ruleset,
 * and it exists because those two answer different questions. `SQL` read as
 * spelling is "skwull"; read as letters it is "S-Q-L", which is what a person
 * says. No ruleset over the letters can tell an initialism from a word, so the
 * decision is made by the shape of the token — see `resolve.ts` — and this
 * module only does the saying.
 *
 * **Stress.** Every letter but the last carries secondary stress and the last
 * carries primary, which is how an English initialism is actually said: the beat
 * lands at the end, "S-Q-**L**". Written with no spaces between the letters, so
 * the whole initialism is one run rather than three words with pauses in it —
 * matching the curated entries in `data/lexicon.txt` that spell letters out by
 * hand, so a term that graduates from here into the lexicon does not change how
 * it sounds.
 *
 * The names are American English. `W` is the only one that is not one syllable,
 * and it carries its own internal secondary stress because "double-you" has two
 * beats of its own.
 */

import { PRIMARY_STRESS, SECONDARY_STRESS } from "./arpabet.js";

/**
 * Each letter as `[onset, rest]`, so the stress mark can be inserted between
 * them — immediately before the vowel, which is the convention every layer here
 * follows. `B` is `b` + `i`, so primary stress makes `bˈi` and secondary makes
 * `bˌi`; `A` has no onset, so the mark starts the syllable.
 */
const LETTER_NAMES: Readonly<Record<string, readonly [string, string]>> = {
  a: ["", "A"],
  b: ["b", "i"],
  c: ["s", "i"],
  d: ["d", "i"],
  e: ["", "i"],
  f: ["", "ɛf"],
  g: ["ʤ", "i"],
  h: ["", "Aʧ"],
  i: ["", "I"],
  j: ["ʤ", "A"],
  k: ["k", "A"],
  l: ["", "ɛl"],
  m: ["", "ɛm"],
  n: ["", "ɛn"],
  o: ["", "O"],
  p: ["p", "i"],
  q: ["kj", "u"],
  r: ["", "ɑɹ"],
  s: ["", "ɛs"],
  t: ["t", "i"],
  u: ["j", "u"],
  v: ["v", "i"],
  w: ["d", `ʌbəlj${SECONDARY_STRESS}u`],
  x: ["", "ɛks"],
  y: ["w", "I"],
  z: ["z", "i"],
};

/**
 * Every IPA symbol a spelled-out letter can contribute, for the vocabulary
 * assertion in `vocab.test.ts`.
 */
export const LETTER_NAME_SYMBOLS: readonly string[] = [
  ...new Set(
    Object.values(LETTER_NAMES)
      .flatMap(([onset, rest]) => [...onset, ...rest])
      .concat(PRIMARY_STRESS, SECONDARY_STRESS),
  ),
];

/** One letter's name, with the stress mark placed before its vowel. */
function letterName(letter: string, primary: boolean): string | null {
  const parts = LETTER_NAMES[letter.toLowerCase()];
  if (parts === undefined) {
    return null;
  }
  const [onset, rest] = parts;
  return `${onset}${primary ? PRIMARY_STRESS : SECONDARY_STRESS}${rest}`;
}

/**
 * `word` spelled out letter by letter, or `null` if it holds a character that is
 * not a letter of the English alphabet.
 *
 * `null` rather than skipping the character: a token that reached here with a
 * digit or an accent in it is a tokeniser bug, and swallowing it would produce a
 * pronunciation missing a piece with nothing to say so.
 */
export function spellOutLetters(word: string): string | null {
  const letters = [...word];
  if (letters.length === 0) {
    return null;
  }
  let ipa = "";
  for (const [index, letter] of letters.entries()) {
    const name = letterName(letter, index === letters.length - 1);
    if (name === null) {
      return null;
    }
    ipa += name;
  }
  return ipa;
}
