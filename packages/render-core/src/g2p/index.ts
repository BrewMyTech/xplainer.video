/**
 * The grapheme-to-phoneme port: English text → Kokoro's IPA, with per-word spans.
 *
 * Four layers, in precedence order — a curated domain lexicon, CMUdict, a
 * deterministic letter-to-sound ruleset, and a refusal — described in
 * `resolve.ts`. Pure: no network, no ONNX, no clock, and no I/O beyond three
 * committed data files under `data/`.
 *
 * It lives in `@xplainer/render-core` beside the narration port rather than in
 * `apps/cli` because the narration port is the only consumer that exists today
 * and the CLI is downstream of both; and because it is exactly the kind of thing
 * this package already holds — pure arithmetic over narration, tested from
 * committed fixtures rather than from a live server.
 */

export type { G2pErrorCode } from "./errors.js";
export { G2pError } from "./errors.js";
export type {
  DerivedPronunciation,
  Phonemisation,
  WordSpan,
} from "./phonemise.js";
export { phonemise } from "./phonemise.js";
export type { PhonemeSource } from "./resolve.js";
export { kokoroTokenIds, kokoroVocabulary, unsupportedSymbols } from "./vocab.js";
