/**
 * One word, through the four layers, in order — and the order **is** the design
 * (plan §6 S4, D5, D8).
 *
 * ```
 * 1  the curated lexicon    data/lexicon.txt — a name somebody chose
 * 2  CMUdict                126k hand-transcribed words — the English language
 * 3  a deterministic guess  spelled-out initialisms, then letter-to-sound
 * 4  refusal                a named error, never an empty string
 * ```
 *
 * Layer 3 is two mechanisms rather than one because they answer different
 * questions about the same token: `SQL` read as spelling is "skwull" and read as
 * letters is "S-Q-L", and no ruleset over the letters can tell which a token is.
 * The decision is made here, from the token's *shape*, and it is written down in
 * {@link isProbableInitialism}.
 *
 * **Between layers 2 and 3 sit two decompositions**, and they are here rather
 * than in the tokeniser because they are lookups that failed, not text that was
 * split:
 *
 * * **Possessives.** `daemon's` is in no dictionary; `daemon` is. The stem is
 *   resolved and the English possessive allomorph is appended — `/ɪz/` after a
 *   sibilant, `/s/` after a voiceless consonant, `/z/` otherwise — which is a
 *   rule about the language and not a guess. `developers'` is the stem and
 *   nothing else.
 * * **Compounds.** `write-ahead`, `snake_case`, `camelCase`, `x86`, `HTTPServer`.
 *   Each part is resolved through the whole stack independently and the parts are
 *   joined with a space, because a space is a real Kokoro token and a short
 *   pause, and "camel case" is how a person reads `camelCase` aloud. The split
 *   happens only *after* the whole token has failed layers 1 and 2, so
 *   `PostgreSQL` and `TypeScript` are read from the lexicon rather than taken
 *   apart.
 *
 * **What is reported.** Every resolution says which layer answered. `phonemise()`
 * turns a layer-3 answer into an entry in its `derived` list, which is D5's
 * "never silent" applied to a guess rather than to silence: the caller logs the
 * word and the pronunciation, and the fix is one line in `data/lexicon.txt`.
 */

import { lookUpCmudict } from "./cmudict.js";
import { spellOutLetters } from "./letters.js";
import { lookUpLexicon } from "./lexicon.js";
import { lettersToIpa } from "./lts.js";
import { readNumber } from "./numbers.js";

/** Which layer produced a pronunciation. The last two are guesses and are reported. */
export type PhonemeSource =
  /** `data/lexicon.txt` — curated, reviewed, and right by construction. */
  | "lexicon"
  /** CMUdict — hand-transcribed English. */
  | "cmudict"
  /** Spelled out letter by letter, because the token looks like an initialism. */
  | "initialism"
  /** Derived from the spelling by the D8 ruleset. Always reported. */
  | "letter-to-sound";

/** A word's pronunciation, and where it came from. */
export interface Resolution {
  readonly ipa: string;
  readonly source: PhonemeSource;
}

/** Ordered weakest-last, so a compound reports the weakest layer any part needed. */
const SOURCE_RANK: Readonly<Record<PhonemeSource, number>> = {
  lexicon: 0,
  cmudict: 1,
  initialism: 2,
  "letter-to-sound": 3,
};

/** A guess, as opposed to a lookup. These are the sources `phonemise()` reports. */
export function isDerivedSource(source: PhonemeSource): boolean {
  return source === "initialism" || source === "letter-to-sound";
}

/** IPA endings after which the possessive is a syllable of its own: `/ɪz/`. */
const SIBILANT_ENDINGS: readonly string[] = ["s", "z", "ʃ", "ʒ", "ʧ", "ʤ"];

/** IPA endings after which it is voiceless: `/s/`. Everything else takes `/z/`. */
const VOICELESS_ENDINGS: readonly string[] = ["p", "t", "k", "f", "θ"];

/** The characters that separate the parts of a compound token. */
const COMPOUND_SEPARATORS = /[-_./+]/g;

/** The most letters a token may have and still be read out letter by letter. */
const MAX_INITIALISM_LENGTH = 6;

/**
 * The English possessive `'s`, chosen by what the stem ends in.
 *
 * This is morphology, not a guess: the three allomorphs are complementary and
 * the rule that selects them is exceptionless in English.
 */
function possessiveSuffix(stemIpa: string): string {
  if (SIBILANT_ENDINGS.some((ending) => stemIpa.endsWith(ending))) {
    return "ɪz";
  }
  return VOICELESS_ENDINGS.some((ending) => stemIpa.endsWith(ending)) ? "s" : "z";
}

/**
 * Does this token look like something a person spells out rather than says?
 *
 * Two shapes qualify, and both are deliberately narrow because the cost of being
 * wrong is high in one direction only: spelling out a word that should be said
 * ("CACHE" in a heading) is ugly, while saying an initialism as a word ("skwull"
 * for `SQL`) is unintelligible.
 *
 * 1. **All upper case and short.** `SQL`, `API`, `TTL`. The length bound is what
 *    stops an upper-cased sentence fragment being spelled out a letter at a time.
 * 2. **No vowel letter at all.** `srv`, `tsx`, `xml`. A run of English letters
 *    with no vowel in it is not a word in any casing, so the ruleset below would
 *    be inventing one.
 *
 * The check runs after layers 1 and 2, so a token that *is* a dictionary word —
 * `IT`, `US`, `NO` — has already been resolved as that word. That is a real
 * trade-off, stated rather than hidden: "IT" in a sentence about an IT
 * department is read "it". A lexicon entry with an upper-case spelling is the
 * escape hatch, and it is why the lexicon supports case-sensitive keys.
 */
export function isProbableInitialism(word: string): boolean {
  if (!/^[A-Za-z]+$/.test(word) || word.length < 2 || word.length > MAX_INITIALISM_LENGTH) {
    return false;
  }
  return word === word.toUpperCase() || !/[aeiouy]/i.test(word);
}

/**
 * Split a compound into the parts that are looked up separately.
 *
 * Four boundaries, in one pass: the separator characters, the letter-to-digit
 * and digit-to-letter transitions (`x86`, `utf8`), the lower-to-upper transition
 * (`putSource`), and the run-of-capitals-then-a-capitalised-word transition
 * (`HTTPServer` → `HTTP`, `Server`). Empty parts are dropped, so a trailing
 * separator costs nothing.
 */
export function splitCompound(word: string): readonly string[] {
  const marked = word
    .replace(COMPOUND_SEPARATORS, " ")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
  return marked.split(" ").filter((part) => part !== "");
}

/**
 * A numeric token as its spoken words, each of which is then resolved through
 * the layers above — and every word `numbers.ts` can produce is in CMUdict, so
 * a number never reaches the letter-to-sound layer. `null` when the token is not
 * a number at all.
 *
 * The source is reported as `cmudict` rather than as a guess of its own: the
 * digits are not being guessed at, they are being read, and the reading is a
 * documented decision rather than a derivation from spelling.
 */
function resolveSpokenNumber(token: string): Resolution | null {
  const words = readNumber(token);
  if (words === null || words.length === 0) {
    return null;
  }
  const parts: string[] = [];
  for (const word of words) {
    const resolved = lookUpLexicon(word) ?? lookUpCmudict(word) ?? lettersToIpa(word);
    if (resolved === null) {
      return null;
    }
    parts.push(resolved);
  }
  return { ipa: parts.join(" "), source: "cmudict" };
}

/**
 * `word` as IPA, or `null` if all four layers came up empty — which the caller
 * turns into a {@link G2pError} naming the word.
 *
 * `null` rather than `""`: an empty string is a word that vanishes from the
 * audio, which is precisely the upstream behaviour D5 exists to forbid.
 */
export function resolveWord(word: string): Resolution | null {
  if (word === "") {
    return null;
  }

  const curated = lookUpLexicon(word);
  if (curated !== null) {
    return { ipa: curated, source: "lexicon" };
  }

  const transcribed = lookUpCmudict(word);
  if (transcribed !== null) {
    return { ipa: transcribed, source: "cmudict" };
  }

  const numeric = resolveSpokenNumber(word);
  if (numeric !== null) {
    return numeric;
  }

  const possessive = /^(.+?)['’](s?)$/.exec(word);
  if (possessive !== null) {
    const [, stem, plural] = possessive;
    if (stem !== undefined && stem !== "") {
      const resolved = resolveWord(stem);
      if (resolved !== null) {
        const suffix = plural === "s" ? possessiveSuffix(resolved.ipa) : "";
        return { ipa: `${resolved.ipa}${suffix}`, source: resolved.source };
      }
    }
  }

  const parts = splitCompound(word.replaceAll(/['’]/g, ""));
  if (parts.length > 1) {
    const resolutions: Resolution[] = [];
    for (const part of parts) {
      const resolved = resolvePart(part);
      if (resolved === null) {
        return null;
      }
      resolutions.push(resolved);
    }
    const weakest = resolutions.reduce((worst, one) =>
      SOURCE_RANK[one.source] > SOURCE_RANK[worst.source] ? one : worst,
    );
    return { ipa: resolutions.map((one) => one.ipa).join(" "), source: weakest.source };
  }

  return resolvePart(parts[0] ?? word);
}

/**
 * One indivisible part: the layers that apply once splitting is done.
 *
 * Separated from {@link resolveWord} so a compound's parts cannot be split again
 * — `splitCompound` is idempotent, but a recursive call would also retry the
 * possessive branch on a stem that has already had its apostrophe removed.
 */
function resolvePart(part: string): Resolution | null {
  if (part === "") {
    return null;
  }
  if (/^\d+$/.test(part)) {
    return resolveSpokenNumber(part);
  }
  const curated = lookUpLexicon(part);
  if (curated !== null) {
    return { ipa: curated, source: "lexicon" };
  }
  const transcribed = lookUpCmudict(part);
  if (transcribed !== null) {
    return { ipa: transcribed, source: "cmudict" };
  }
  if (isProbableInitialism(part)) {
    const spelled = spellOutLetters(part);
    if (spelled !== null) {
      return { ipa: spelled, source: "initialism" };
    }
  }
  const derived = lettersToIpa(part);
  return derived === null ? null : { ipa: derived, source: "letter-to-sound" };
}
