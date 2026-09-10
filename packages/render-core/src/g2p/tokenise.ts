/**
 * Text → tokens: which characters are words, which are punctuation the model has
 * a token for, and which are neither.
 *
 * This module makes no pronunciation decisions. It decides only what a *word* is
 * and what should survive as punctuation, and every one of those decisions is
 * written down here because each could have gone the other way.
 *
 * **A word may contain separators.** `write-ahead`, `snake_case`, `camelCase`,
 * `1.0`, `x86`, `don't` are each ONE token. A separator only stays inside a word
 * when an alphanumeric follows it, so `foo.` is the word `foo` and a full stop,
 * while `e.g.` is the word `e.g` and a full stop. Splitting compounds is
 * `resolve.ts`'s job and happens only after the whole token has failed the
 * dictionary — otherwise `PostgreSQL` would be taken apart before the lexicon
 * ever saw it.
 *
 * **Punctuation survives only where Kokoro has a token for it.** The vocabulary
 * carries `; : , . ! ? — … " ( ) “ ”` and the space, and nothing else. So:
 *
 * * `'` and `’` are **dropped** as standalone characters — they have no token,
 *   and inside a word they are handled by the possessive rule in `resolve.ts`.
 * * `-` and `–` standing alone become `—`, which the vocabulary does carry.
 * * A run of three or more `.` becomes `…`, so an ellipsis is one pause and not
 *   three full stops.
 * * `[`, `]`, `{`, `}` and the rest are dropped. **This is not a D5 violation**:
 *   D5 is about words that would be *spoken* vanishing from the audio, and a
 *   square bracket is not spoken by anyone. The rule is that nothing audible is
 *   ever dropped silently, and {@link SPOKEN_SYMBOLS} is where the audible
 *   symbols are enumerated.
 *
 * **Some symbols are words.** A standalone `&` is "and", `%` is "percent", `/`
 * is "slash". These are read rather than dropped because a listener hears a word
 * there; the full list is {@link SPOKEN_SYMBOLS} and adding to it is a
 * deliberate edit.
 *
 * **A non-ASCII letter is a refusal, not a drop.** `café` would otherwise be
 * tokenised as `caf`, which is a word silently missing a sound — exactly the
 * failure class D5 is about. The tokeniser marks the character and
 * `phonemise()` refuses, naming it. English-only is a real limitation of this
 * G2P and it is better stated than papered over.
 */

/** What a token is, which is all a caller downstream needs to branch on. */
export type TokenKind =
  /** Letters, digits and internal separators: the thing that gets a pronunciation. */
  | "word"
  /** A character Kokoro has a token for, emitted into the phoneme string verbatim. */
  | "punctuation"
  /** A character that is a letter but not one this G2P can read. Always a refusal. */
  | "foreign";

/** One token, with the source text that produced it so a refusal can name it. */
export interface Token {
  readonly kind: TokenKind;
  /** For a word, the spelling to resolve; for punctuation, the symbol to emit. */
  readonly text: string;
}

/**
 * Symbols that are read aloud as words when they stand alone.
 *
 * Deliberately short. Each entry is a symbol a narrator would say rather than
 * pause at, and the risk of a longer list is reading decoration out loud — an
 * `*` in a bulleted line becoming "star" is worse than an `*` being silent.
 */
export const SPOKEN_SYMBOLS: Readonly<Record<string, string>> = {
  "&": "and",
  "@": "at",
  "%": "percent",
  "+": "plus",
  "=": "equals",
  "/": "slash",
  "<": "less than",
  ">": "greater than",
  $: "dollars",
  "°": "degrees",
};

/**
 * Punctuation that reaches the phoneme string, mapped to the exact character
 * Kokoro tokenises. Anything not in here and not a word is dropped.
 */
const PUNCTUATION: Readonly<Record<string, string>> = {
  ".": ".",
  ",": ",",
  "!": "!",
  "?": "?",
  ";": ";",
  ":": ":",
  '"': '"',
  "(": "(",
  ")": ")",
  "“": "“",
  "”": "”",
  "…": "…",
  "—": "—",
  "–": "—",
  "-": "—",
};

/**
 * One word: an alphanumeric run, optionally continued through `- _ . ' ’ + /`
 * where an alphanumeric follows, with an optional leading minus sign before a
 * digit and an optional trailing unit symbol.
 *
 * The lookahead on the leading `-` is what keeps `-5` a negative number while
 * leaving a dash between two words as punctuation.
 */
const WORD = /^(?:-(?=\d))?[A-Za-z0-9]+(?:['’\-_.+/][A-Za-z0-9]+)*['’]?[%$°]?/;

/** A currency amount, whose symbol leads and whose word follows: `$5` is "five dollars". */
const CURRENCY = /^\$(\d[\d,]*(?:\.\d+)?)/;

/** Three or more full stops, which become one ellipsis. */
const ELLIPSIS = /^\.{3,}/;

/** Any Unicode letter, used to tell "not spoken" from "spoken and unreadable". */
const LETTER = /\p{L}/u;

/**
 * Split `text` into tokens.
 *
 * A single pass, longest match first at each position, so `...` is seen before
 * `.` and a word is seen before the alphanumeric that starts it.
 */
export function tokenise(text: string): readonly Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < text.length) {
    const rest = text.slice(at);
    const character = rest[0] ?? "";
    if (/\s/.test(character)) {
      at += 1;
      continue;
    }
    const ellipsis = ELLIPSIS.exec(rest);
    if (ellipsis !== null) {
      tokens.push({ kind: "punctuation", text: "…" });
      at += ellipsis[0].length;
      continue;
    }
    const currency = CURRENCY.exec(rest);
    if (currency !== null && currency[1] !== undefined) {
      // The symbol leads in writing and trails in speech, which is the one
      // place a symbol's position has to be rearranged rather than read where
      // it stands.
      tokens.push({ kind: "word", text: currency[1] }, { kind: "word", text: "dollars" });
      at += currency[0].length;
      continue;
    }
    const word = /^[A-Za-z0-9]/.test(rest) || /^-\d/.test(rest) ? WORD.exec(rest) : null;
    if (word !== null && word[0] !== "") {
      tokens.push({ kind: "word", text: word[0] });
      at += word[0].length;
      continue;
    }
    const spoken = SPOKEN_SYMBOLS[character];
    if (spoken !== undefined) {
      // A replacement may be two words ("less than"), and each is resolved on
      // its own, so it is emitted as two tokens rather than as one token with a
      // space in it that no dictionary carries.
      for (const part of spoken.split(" ")) {
        tokens.push({ kind: "word", text: part });
      }
      at += 1;
      continue;
    }
    const punctuation = PUNCTUATION[character];
    if (punctuation !== undefined) {
      tokens.push({ kind: "punctuation", text: punctuation });
      at += 1;
      continue;
    }
    if (LETTER.test(character)) {
      tokens.push({ kind: "foreign", text: character });
      at += 1;
      continue;
    }
    at += 1;
  }
  return tokens;
}
