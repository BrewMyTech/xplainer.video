/**
 * The one error grapheme-to-phoneme conversion throws (plan D5,
 * `.omc/plans/ralplan-speech-onnx.md` §2).
 *
 * It lives in its own module for the same reason `narrate/errors.ts` does: both
 * ends of the pipeline raise it — the tokeniser, when a segment holds nothing
 * anyone could say, and the resolver, when a word survives all four layers
 * unpronounced — and a shared class defined in either would make them import
 * each other.
 *
 * **Why an error rather than a fallback to silence.** `kokoro/pipeline.py`
 * constructs its G2P with `unk=''` and `model.py` then filters unknown symbols
 * away, so upstream an out-of-dictionary word becomes the empty string and
 * *vanishes from the audio*, logging a warning nobody reads. In a product where
 * the narration is the source of truth for every scene boundary and every burned
 * caption, a word that is silently not spoken is a correctness defect, not
 * degraded quality. D5 is the rule that came out of discovering it: no
 * configuration of this product may drop a word from narration. This class is
 * how the rule is kept — the failure names the word, and the narration job fails
 * with it rather than producing a track that is quietly wrong.
 *
 * The narration job runs inside a long-lived daemon, so this is a catchable
 * failure of one job and never the end of the process.
 */

/**
 * Why a phonemisation could not be produced. Each value names a distinct defect,
 * so a caller can decide whether to refuse the job or to ask for different text.
 */
export type G2pErrorCode =
  /** No layer could pronounce a word. {@link G2pError.word} names it. */
  | "UNPRONOUNCEABLE"
  /** The text held no token anyone could speak, so there is nothing to synthesise. */
  | "NOTHING_TO_SPEAK";

/** A phonemisation that cannot be produced correctly, rather than one produced wrongly. */
export class G2pError extends Error {
  /** Which defect this is, for a caller that branches rather than logs. */
  readonly code: G2pErrorCode;

  /**
   * The word that could not be pronounced, exactly as it appeared in the source
   * text, or `null` for a defect that is not about one word.
   *
   * Carried as a field rather than left inside the message because the fix is
   * mechanical — add this spelling to `data/lexicon.txt` — and a caller that has
   * to regex its own error message to find out which word to add is a caller
   * that will get it wrong.
   */
  readonly word: string | null;

  constructor(code: G2pErrorCode, message: string, word: string | null = null) {
    super(message);
    this.name = "G2pError";
    this.code = code;
    this.word = word;
  }
}
