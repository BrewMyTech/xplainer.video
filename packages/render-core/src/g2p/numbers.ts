/**
 * Numbers, spelled into the words that then go through the four layers.
 *
 * A digit has no pronunciation of its own — `4` is "four" here and "fourth" in
 * `4th` and "for" in a phone number — so the only honest thing a G2P can do is
 * turn it into English and let the dictionary say the English. Every word this
 * module can produce is in CMUdict, so a number never reaches the
 * letter-to-sound layer.
 *
 * **The decisions, each made deliberately because each could have gone the other
 * way.**
 *
 * * **An integer is read as a cardinal, always.** `1999` is "one thousand nine
 *   hundred ninety nine" and never "nineteen ninety nine". Year reading is a
 *   guess about what the number *means*, and the token does not carry that: in
 *   narration about software, `1999` is far more often a count of rows than a
 *   year, and "nineteen ninety nine servers" is a worse failure than a long
 *   reading of a date. A caller who knows it is a year can write the year out.
 * * **No "and".** "one hundred one", not "one hundred and one" — American
 *   English, matching the voice pack (`af_heart`) and CMUdict's own dialect.
 * * **A decimal point is "point", and the digits after it are read one at a
 *   time.** `1.0` is "one point zero" and `3.14` is "three point one four".
 *   Reading the fraction as a number ("three point fourteen") is wrong for
 *   version strings, which is what most decimals in this product's narration
 *   are.
 * * **A leading `-` immediately before digits is "minus".** Elsewhere a hyphen
 *   is a word separator (see `tokenise.ts`), so this is the one place the
 *   character survives as meaning rather than as punctuation.
 * * **Group separators are removed before reading.** `1,000` is one token and
 *   one number; the comma inside it is not a pause.
 * * **Anything longer than fifteen digits is read digit by digit.** A 32-digit
 *   identifier has no name in English, and "four hundred sextillion" would be an
 *   invention rather than a reading.
 */

/** 0–19, which English names individually rather than compositionally. */
const ONES: readonly string[] = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];

/** The tens, indexed by the tens digit; the first two slots are never reached. */
const TENS: readonly string[] = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];

/** Powers of a thousand, largest first, with the three-digit group each names. */
const SCALES: readonly string[] = ["", "thousand", "million", "billion", "trillion"];

/** The most digits that get a compositional reading. Beyond this, digit by digit. */
const MAX_CARDINAL_DIGITS = 15;

/** The irregular ordinals; every other ordinal is its cardinal plus `th`. */
const ORDINALS: Readonly<Record<string, string>> = {
  one: "first",
  two: "second",
  three: "third",
  five: "fifth",
  eight: "eighth",
  nine: "ninth",
  twelve: "twelfth",
};

/** Symbols that are read as a word when they are attached to a number. */
export const NUMERIC_SYMBOL_WORDS: Readonly<Record<string, string>> = {
  "%": "percent",
  $: "dollars",
  "°": "degrees",
};

/** One to three digits as words. Never called with `"0"`, which the caller handles. */
function readGroup(group: number): readonly string[] {
  const words: string[] = [];
  const hundreds = Math.floor(group / 100);
  const remainder = group % 100;
  if (hundreds > 0) {
    words.push(ONES[hundreds] ?? "", "hundred");
  }
  if (remainder >= 20) {
    words.push(TENS[Math.floor(remainder / 10)] ?? "");
    const unit = remainder % 10;
    if (unit > 0) {
      words.push(ONES[unit] ?? "");
    }
  } else if (remainder > 0) {
    words.push(ONES[remainder] ?? "");
  }
  return words;
}

/** Each digit named on its own: the reading for an identifier rather than a quantity. */
function readDigits(digits: string): readonly string[] {
  return [...digits].map((digit) => ONES[Number(digit)] ?? digit);
}

/**
 * A run of digits as English words.
 *
 * Exported because the tokeniser needs it for the digit half of a token like
 * `x86`, where there is no sign, no decimal point and no ordinal suffix.
 */
export function readCardinal(digits: string): readonly string[] {
  const trimmed = digits.replace(/^0+(?=\d)/, "");
  if (trimmed.length > MAX_CARDINAL_DIGITS) {
    return readDigits(digits);
  }
  if (trimmed === "0") {
    return ["zero"];
  }
  const groups: number[] = [];
  for (let end = trimmed.length; end > 0; end -= 3) {
    groups.unshift(Number(trimmed.slice(Math.max(0, end - 3), end)));
  }
  const words: string[] = [];
  for (const [index, group] of groups.entries()) {
    if (group === 0) {
      continue;
    }
    words.push(...readGroup(group));
    const scale = SCALES[groups.length - 1 - index] ?? "";
    if (scale !== "") {
      words.push(scale);
    }
  }
  return words;
}

/** A cardinal reading turned into an ordinal by rewriting its last word. */
function readOrdinal(digits: string): readonly string[] {
  const words = [...readCardinal(digits)];
  const last = words.at(-1);
  if (last === undefined) {
    return words;
  }
  const irregular = ORDINALS[last];
  if (irregular !== undefined) {
    words[words.length - 1] = irregular;
    return words;
  }
  words[words.length - 1] = last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`;
  return words;
}

/**
 * A numeric token as the words that should be spoken in its place, or `null` if
 * the token is not numeric at all.
 *
 * Handles the sign, group separators, a decimal point, an ordinal suffix and a
 * trailing symbol. Anything else — a token with letters mixed in, like `x86` —
 * is decomposed by the tokeniser before it gets here, so this function only ever
 * sees a number.
 */
export function readNumber(token: string): readonly string[] | null {
  const match = /^(-?)(\d[\d,]*)(?:\.(\d+))?(st|nd|rd|th)?([%$°])?$/i.exec(token);
  if (match === null) {
    return null;
  }
  const [, sign, integerPart, fractionPart, ordinalSuffix, symbol] = match;
  if (integerPart === undefined) {
    return null;
  }
  const digits = integerPart.replaceAll(",", "");
  const words: string[] = [];
  if (sign === "-") {
    words.push("minus");
  }
  if (ordinalSuffix !== undefined && fractionPart === undefined) {
    words.push(...readOrdinal(digits));
  } else {
    words.push(...readCardinal(digits));
  }
  if (fractionPart !== undefined) {
    words.push("point", ...readDigits(fractionPart));
  }
  if (symbol !== undefined) {
    const spoken = NUMERIC_SYMBOL_WORDS[symbol];
    if (spoken !== undefined) {
      words.push(spoken);
    }
  }
  return words;
}
