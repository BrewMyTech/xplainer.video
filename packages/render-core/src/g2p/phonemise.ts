/**
 * English text → Kokoro's IPA phoneme string, plus the per-word spans that make
 * word-level timing possible downstream.
 *
 * This is the whole public entry point of the G2P; everything under `src/g2p/`
 * exists to serve it. It is pure — no network, no ONNX, no clock, and no I/O
 * beyond reading its own three committed data files — which is what lets the
 * synthesiser lane test it without a model and lets a caption be re-derived
 * without re-synthesising.
 *
 * **The spans are the reason this returns a structure rather than a string.**
 * Kokoro's timestamped ONNX graph returns `pred_dur`, one predicted duration per
 * *token*, and a token is one IPA symbol. Accumulating the durations over a
 * word's `[start, end)` range in the phoneme string gives that word's start and
 * end **from the model's own duration predictor** — exact timing rather than an
 * alignment estimate, which is the whole reason the plan chose this model
 * (`.omc/plans/ralplan-speech-onnx.md` §1). A span therefore has to be an offset
 * into the exact string that is tokenised, so nothing may rewrite `ipa` after
 * this function returns it.
 *
 * A span covers the word's phonemes only. The space before it and any
 * punctuation after it are outside every span, deliberately: the silence at a
 * comma belongs to no word, and a caption stretched across it reads as lag —
 * the same argument `src/narrate/` already makes about a word's end being the
 * server's `end_time` and never the next word's `start_time`.
 *
 * **Punctuation attaches to the word before it**, with no space between, and the
 * next word is preceded by a space: `wˈɚd, nˈɛkst`. That is how misaki writes it
 * and how the pause lands. The exception is an opening bracket or quote, which
 * attaches forward for the same reason.
 */

import { G2pError } from "./errors.js";
import { isDerivedSource, type PhonemeSource, resolveWord } from "./resolve.js";
import { tokenise } from "./tokenise.js";

/** One word's phonemes, located in the phoneme string. */
export interface WordSpan {
  /** The word exactly as it appeared in the source text. */
  readonly word: string;
  /** Index of the word's first phoneme symbol in `ipa`, inclusive. */
  readonly start: number;
  /** Index one past the word's last phoneme symbol in `ipa`. */
  readonly end: number;
  /** Which of the four layers pronounced it. */
  readonly source: PhonemeSource;
}

/**
 * A pronunciation this package derived rather than looked up (D5).
 *
 * Returned instead of logged, because a pure function that logs is a pure
 * function with a hidden dependency on somebody's logger. The caller — the
 * narration worker — decides where these go, and the plan's rule is that they go
 * somewhere: "every LTS-derived pronunciation is logged, so D5's rule holds in
 * spirit — the result is auditable and never silent".
 */
export interface DerivedPronunciation {
  /** The word, as it appeared, so it can be pasted into `data/lexicon.txt`. */
  readonly word: string;
  /** What this package decided it sounds like. */
  readonly ipa: string;
  /** `initialism` or `letter-to-sound` — never one of the two lookup layers. */
  readonly source: PhonemeSource;
}

/** What {@link phonemise} answers with. */
export interface Phonemisation {
  /** The phoneme string, exactly as it must be tokenised. Every symbol is in Kokoro's vocabulary. */
  readonly ipa: string;
  /** One span per word, in reading order. */
  readonly words: readonly WordSpan[];
  /** Every pronunciation that was derived rather than looked up. Empty is the good case. */
  readonly derived: readonly DerivedPronunciation[];
}

/** Punctuation that binds to the word after it rather than the word before it. */
const OPENING = new Set(["(", "“"]);

/**
 * The straight double quote, which is the one mark whose direction is not
 * visible in the character.
 *
 * `“` and `”` say which they are; `"` does not, so its direction is taken from
 * its position in the text — the first is opening, the second closing, and so on
 * — which is exactly what a reader does. Deterministic (the same text always
 * gives the same answer) and right for balanced text, which narration is. On
 * unbalanced text it puts one pause on the wrong side of one word.
 */
const STRAIGHT_QUOTE = '"';

/**
 * Phonemise `text`.
 *
 * @throws {G2pError} `UNPRONOUNCEABLE` when a word survives all four layers, or
 * when the text holds a letter outside the English alphabet — both name the
 * thing that could not be read. `NOTHING_TO_SPEAK` when the text holds no word
 * at all, which is a caller passing an empty or punctuation-only segment.
 */
export function phonemise(text: string): Phonemisation {
  const words: WordSpan[] = [];
  const derived: DerivedPronunciation[] = [];
  let ipa = "";
  let pendingSpace = false;
  let quoteIsOpening = true;

  for (const token of tokenise(text)) {
    if (token.kind === "foreign") {
      throw new G2pError(
        "UNPRONOUNCEABLE",
        `${JSON.stringify(token.text)} is a letter outside the English alphabet, and this G2P ` +
          "reads English only. Reading the word without it would drop a sound from the audio.",
        token.text,
      );
    }

    if (token.kind === "punctuation") {
      const opens = token.text === STRAIGHT_QUOTE ? quoteIsOpening : OPENING.has(token.text);
      if (token.text === STRAIGHT_QUOTE) {
        quoteIsOpening = !quoteIsOpening;
      }
      if (opens && ipa !== "" && pendingSpace) {
        ipa += " ";
      }
      ipa += token.text;
      pendingSpace = !opens;
      continue;
    }

    const resolved = resolveWord(token.text);
    if (resolved === null) {
      throw new G2pError(
        "UNPRONOUNCEABLE",
        `no pronunciation for ${JSON.stringify(token.text)}. Add it to ` +
          "packages/render-core/src/g2p/data/lexicon.txt, with a gloss.",
        token.text,
      );
    }

    if (ipa !== "" && pendingSpace) {
      ipa += " ";
    }
    const start = ipa.length;
    ipa += resolved.ipa;
    words.push({ word: token.text, start, end: ipa.length, source: resolved.source });
    if (isDerivedSource(resolved.source)) {
      derived.push({ word: token.text, ipa: resolved.ipa, source: resolved.source });
    }
    pendingSpace = true;
  }

  if (words.length === 0) {
    throw new G2pError(
      "NOTHING_TO_SPEAK",
      `${JSON.stringify(text)} holds no word to speak. A narration segment with nothing in it ` +
        "would produce a silent clip whose duration every scene boundary downstream would " +
        "inherit.",
    );
  }

  return { ipa, words, derived };
}
