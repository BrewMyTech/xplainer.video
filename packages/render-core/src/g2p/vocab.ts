/**
 * Kokoro's symbol table, and the gate that stops this package emitting anything
 * outside it (plan D5).
 *
 * **Why this module exists at all.** Kokoro's ONNX graph takes token ids, and
 * every id comes from the 115-symbol vocabulary in the model repository's own
 * `tokenizer.json`. The S0b spike's prototype turned an IPA string into ids with
 *
 * ```js
 * [...ipa].map((c) => vocab[c]).filter((v) => v !== undefined)
 * ```
 *
 * and that `.filter` is exactly the defect D5 exists to prevent, one layer down
 * from the one the plan found upstream: a symbol the vocabulary does not carry
 * is *dropped*, so a word phonemised with — say — `ʧ` instead of `tʃ` comes out
 * of the model mispronounced or missing a consonant, with nothing anywhere
 * saying so. A silently wrong phoneme is harder to notice than a silently
 * missing word and just as wrong.
 *
 * So the vocabulary is loaded from the vendored tokenizer rather than restated,
 * {@link kokoroTokenIds} **refuses** an unknown symbol instead of skipping it,
 * and `vocab.test.ts` walks every symbol this package can emit — every entry in
 * the curated lexicon, every value in the ARPAbet table, every phone the
 * letter-to-sound ruleset can produce and every punctuation mark the tokeniser
 * passes through — and asserts each one is a key here. That test is the reason
 * the refusal below should never fire in production: it is the last line rather
 * than the first.
 *
 * **Provenance.** `data/kokoro-tokenizer.json` is the `tokenizer.json` of
 * `onnx-community/Kokoro-82M-v1.0-ONNX-timestamped` at revision
 * `dd4401a9add81ac692d20e240d22ec9dda82cc29` (Apache-2.0), byte-identical to
 * upstream — sha256
 * `77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34`. It is
 * vendored rather than fetched because the mapping is part of *this* package's
 * correctness: the gate has to hold on a machine that has not run `setup` and
 * has no model on disk.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { G2pError } from "./errors.js";

/**
 * The tokenizer document, as much of it as this module reads.
 *
 * Declared rather than trusted: the file is parsed at runtime, so the shape is
 * checked before use and a document that is not this shape is a startup failure
 * naming the file, never an empty vocabulary that would make the gate vacuous.
 */
interface TokenizerDocument {
  readonly model?: { readonly vocab?: Readonly<Record<string, number>> };
}

/** Where the vendored tokenizer sits, beside this module in `src/` and in `dist/`. */
const TOKENIZER_PATH = fileURLToPath(new URL("data/kokoro-tokenizer.json", import.meta.url));

/**
 * The size the vendored vocabulary must have.
 *
 * A count is a weak assertion and a cheap one, and it catches the failure that
 * would otherwise be invisible: a tokenizer swapped for one from a different
 * Kokoro variant, whose symbols overlap enough that the subset test still passes
 * while the ids underneath have all moved.
 */
const EXPECTED_VOCAB_SIZE = 115;

/** Parsed once, on first use. Nothing here is per-call, and the file never changes. */
let cached: ReadonlyMap<string, number> | null = null;

/**
 * Kokoro's symbol → token id map, loaded from the vendored tokenizer.
 *
 * Lazy because `@xplainer/render-core` is imported by the CLI's every command,
 * and a command that never narrates should not pay to parse a speech model's
 * tokenizer at module load.
 */
export function kokoroVocabulary(): ReadonlyMap<string, number> {
  if (cached !== null) {
    return cached;
  }
  const parsed: unknown = JSON.parse(readFileSync(TOKENIZER_PATH, "utf8"));
  const vocab = (parsed as TokenizerDocument).model?.vocab;
  if (vocab === undefined) {
    throw new Error(
      `${TOKENIZER_PATH}: no model.vocab in the vendored Kokoro tokenizer. ` +
        "It must be the tokenizer.json of onnx-community/Kokoro-82M-v1.0-ONNX-timestamped.",
    );
  }
  const entries = Object.entries(vocab);
  if (entries.length !== EXPECTED_VOCAB_SIZE) {
    throw new Error(
      `${TOKENIZER_PATH}: vocabulary has ${entries.length} symbols, expected ` +
        `${EXPECTED_VOCAB_SIZE}. A different symbol table means different token ids, so the ` +
        "phoneme gate in this module would be checking against the wrong model.",
    );
  }
  cached = new Map(entries);
  return cached;
}

/**
 * The symbols in `ipa` that Kokoro has no token for, in order of first
 * appearance and without repeats.
 *
 * Answering with the *set* rather than with a boolean is what makes the test in
 * `vocab.test.ts` and the refusal below able to name what is wrong. Iterating
 * with a spread rather than by index is deliberate: every symbol in this
 * vocabulary is a single UTF-16 code unit today, but `[...s]` iterates code
 * points, so a surrogate pair reaches the lookup whole instead of arriving as
 * two halves that are both "unknown" and neither of which is the real character.
 */
export function unsupportedSymbols(ipa: string): readonly string[] {
  const vocab = kokoroVocabulary();
  const missing: string[] = [];
  for (const symbol of ipa) {
    if (!vocab.has(symbol) && !missing.includes(symbol)) {
      missing.push(symbol);
    }
  }
  return missing;
}

/**
 * `ipa` as Kokoro token ids, refusing rather than dropping.
 *
 * The synthesiser adds the model's own padding token at each end; that is its
 * business and not this function's, because the padding is a property of the
 * ONNX graph's expected input and this module is about the alphabet.
 *
 * @throws {G2pError} `UNPRONOUNCEABLE`, naming every symbol with no token.
 */
export function kokoroTokenIds(ipa: string): readonly number[] {
  const missing = unsupportedSymbols(ipa);
  if (missing.length > 0) {
    throw new G2pError(
      "UNPRONOUNCEABLE",
      `phoneme string carries ${missing.length} symbol(s) Kokoro has no token for: ` +
        `${missing.map((symbol) => JSON.stringify(symbol)).join(", ")}. The model drops what it ` +
        "cannot tokenise, so this would have been silently mispronounced.",
    );
  }
  const vocab = kokoroVocabulary();
  const ids: number[] = [];
  for (const symbol of ipa) {
    const id = vocab.get(symbol);
    if (id !== undefined) {
      ids.push(id);
    }
  }
  return ids;
}
