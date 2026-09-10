/**
 * The phoneme string as Kokoro token ids, with the character offset of each token.
 *
 * **One IPA symbol is one token, and that is a property of the model rather than a choice here.**
 * The 115-symbol vocabulary is a map from single symbols to ids, so the tokenisation is a walk over
 * the string. What this module adds over `kokoroTokenIds()` in `@xplainer/render-core` — which
 * answers with ids alone — is `offsets`: the position in `ipa` each token came from. That is what
 * turns `phonemise()`'s per-word character spans into token ranges, and a token range is what the
 * duration predictor can be summed over. An ids-only function cannot give it, which is the whole
 * reason this exists beside that one instead of calling it.
 *
 * The vocabulary itself is *not* restated here: {@link kokoroVocabulary} is the vendored
 * `tokenizer.json` of the model repository, and it stays the single place the alphabet is written
 * down. A symbol with no token is a refusal naming it, never a skip — the model drops what it
 * cannot tokenise, so skipping would mispronounce a word with nothing anywhere saying so (plan D5,
 * and `render-core`'s `g2p/vocab.ts` makes the same argument at the same seam).
 *
 * ---
 *
 * ## The affricate and diphthong spelling, settled by measurement (2026-09-10)
 *
 * The G2P spells affricates and diphthongs as sequences — `tʃ`, `dʒ`, `eɪ`, `oʊ` — and Kokoro's
 * vocabulary *also* carries misaki's single-character forms `ʧ` (133), `ʤ` (82), `A` (24), `I` (25),
 * `O` (31), `W` (39), `Y` (41). Both are in vocabulary, so both synthesise, and
 * `render-core`'s `g2p/arpabet.ts` left the question to this lane to settle by measurement.
 *
 * **The measurement says the single-character forms, clearly.** Two independent readings, against
 * the reference implementation's own Kokoro-FastAPI on this machine:
 *
 * 1. **`/dev/phonemize` is misaki**, the G2P Kokoro was *trained* against, and it emits the
 *    single-character forms without exception: "The change managed to adjust the major stage."
 *    becomes `ðə ʧˈAnʤ mˈænɪʤd tʊ əʤˈʌst ðə mˈAʤəɹ stˈAʤ.` So the sequences are not what the
 *    model saw.
 * 2. **The model realises a sequence as two segments, not as one phoneme.** Feeding misaki's own
 *    string against the same string with only its ligatures expanded — everything else identical —
 *    the duration predictor stretches the affricate region by **×1.70 in 24 of 24 occurrences** and
 *    the diphthong region by **×1.66 in 18 of 18**. `tʃ` is spoken as a stop *then* a fricative;
 *    `eɪ` as two vowels. A sentence with eight of them ran 9.5% long overall.
 *
 * **And yet this module does not contract them, because it cannot do so correctly.** A third
 * reading is what settles *where* the fix goes: misaki uses `t`+`ʃ` as a **genuine cluster** where
 * English has one — "hotshot" is `hˈɑtʃˌɑt`, "courtship" `kˈɔɹtʃˌɪp`, "nutshell" `nˈʌtʃˌɛl` — and
 * `ɔ`+`ɪ` likewise, since "drawing" is `dɹˈɔɪŋ` and not the `ɔɪ` of "choice". In an IPA string those
 * are character-for-character identical to the affricate and the diphthong. A contraction table
 * here would turn "hotshot" into "ha-chot" and "drawing" into "droying" — trading a 70% prosody
 * error for an outright mispronunciation, which is worse and is the kind of wrong nobody notices
 * until a viewer does.
 *
 * The distinction survives one step upstream: **ARPAbet has `CH` for the affricate and `T SH` for
 * the cluster**, and `AY` for the diphthong against `AO IH` for "drawing". So the place that can
 * emit `ʧ` for one and `tʃ` for the other is `g2p/arpabet.ts`'s table, where the ARPAbet phone is
 * still in hand — and the recorded answer to its question is therefore *"the single-character
 * forms, changed in that table"*, not "contracted downstream". This module is deliberately
 * agnostic: it maps whatever symbols the G2P emits, one per token, so that change needs nothing
 * here and the better prosody arrives on its own.
 */

import { kokoroVocabulary } from "@xplainer/render-core";
import { OnnxSpeechError } from "./errors.js";

/**
 * The token this graph pads with at both ends.
 *
 * Id 0 is `$` in the vocabulary, the boundary symbol, and the padding is a property of the ONNX
 * graph's expected input rather than of the alphabet — which is why `kokoroTokenIds()` upstream
 * deliberately does not add it and this module does.
 */
export const PAD_TOKEN = 0;

/** A phoneme string, tokenised, with the padding this graph expects already in place. */
export type TokenisedPhonemes = {
  /** Token ids in model order: {@link PAD_TOKEN}, one per symbol, {@link PAD_TOKEN}. */
  readonly ids: readonly number[];
  /**
   * For each index of `ids`, the offset in `ipa` of the character it came from — and `-1` for the
   * two pads, which came from no character.
   */
  readonly offsets: readonly number[];
  /** How many tokens are phonemes, padding excluded. This is what selects the voice's style row. */
  readonly phonemeCount: number;
};

/**
 * Tokenise `ipa`, padded.
 *
 * Iterated by code point rather than by UTF-16 index — every symbol in this vocabulary is a single
 * code unit today, but a spread iterates code points, so a future surrogate-pair symbol reaches the
 * lookup whole instead of as two halves that are both unknown. The offset recorded is still a
 * UTF-16 offset, because that is the unit `phonemise()`'s spans are measured in.
 *
 * @throws {OnnxSpeechError} `MODEL_CONTRACT` naming every symbol the vocabulary has no token for,
 *   and `MODEL_CONTRACT` for an empty phoneme string — a segment that tokenised to nothing would
 *   produce a silent clip whose length every scene boundary downstream would inherit.
 */
export function tokenisePhonemes(ipa: string): TokenisedPhonemes {
  const vocabulary = kokoroVocabulary();
  const ids: number[] = [PAD_TOKEN];
  const offsets: number[] = [-1];
  const missing: string[] = [];
  let offset = 0;

  for (const symbol of ipa) {
    const id = vocabulary.get(symbol);
    if (id === undefined) {
      if (!missing.includes(symbol)) {
        missing.push(symbol);
      }
    } else {
      ids.push(id);
      offsets.push(offset);
    }
    offset += symbol.length;
  }

  if (missing.length > 0) {
    throw new OnnxSpeechError(
      "MODEL_CONTRACT",
      `the phoneme string carries ${missing.length} symbol(s) Kokoro has no token for: ` +
        `${missing.map((symbol) => JSON.stringify(symbol)).join(", ")}. The model drops what it ` +
        "cannot tokenise, so this would have been silently mispronounced.",
    );
  }
  if (ids.length === 1) {
    throw new OnnxSpeechError(
      "MODEL_CONTRACT",
      `${JSON.stringify(ipa)} tokenised to nothing, so there is no speech to synthesise.`,
    );
  }

  const phonemeCount = ids.length - 1;
  ids.push(PAD_TOKEN);
  offsets.push(-1);
  return { ids, offsets, phonemeCount };
}

/**
 * The token range `[first, last]`, inclusive, covering the characters `[start, end)` of the string
 * `tokens` was built from — or `null` when that character range holds no token at all.
 *
 * `null` rather than an empty range, because an empty range is a word with no phonemes and
 * therefore a word with no duration, and a zero-length caption is exactly the silent wrongness this
 * whole path is built to refuse. The caller names the word.
 */
export function tokenRange(
  tokens: TokenisedPhonemes,
  start: number,
  end: number,
): { readonly first: number; readonly last: number } | null {
  let first = -1;
  let last = -1;
  for (const [index, at] of tokens.offsets.entries()) {
    if (at >= start && at < end) {
      if (first === -1) {
        first = index;
      }
      last = index;
    }
  }
  return first === -1 ? null : { first, last };
}
