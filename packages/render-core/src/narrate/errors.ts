/**
 * The one error the narration port throws (roadmap P1-2, docs/ROADMAP.md).
 *
 * It lives in its own module because both halves of the port raise it — the
 * RIFF reader in `wav.ts` and the pure planner in `plan.ts` — and a shared
 * error class in either of those would make them import each other.
 *
 * The reference implementation (`narrate.py`) raises `SystemExit` for every one
 * of these, which is right for a script and wrong for a library: the narration
 * job runs inside a long-lived daemon, so a bad word span must be a catchable
 * failure of one job rather than the end of the process.
 */

/**
 * Why narration could not be built. Each value names a distinct defect, so a
 * caller can decide whether to retry, re-synthesise or refuse.
 */
export type NarrationErrorCode =
  /** The narration script carries no segments, so there is nothing to speak. */
  | "NO_SEGMENTS"
  /** One measured-speech entry per segment was expected; a different number arrived. */
  | "SEGMENT_COUNT_MISMATCH"
  /** A word span is unusable: not finite, negative, or ending before it starts. */
  | "WORD_SPAN_INVALID"
  /** The bytes are not a RIFF/WAVE container, or not the 16-bit PCM this reads. */
  | "WAV_UNREADABLE"
  /** Two segments came back in different audio formats; they cannot be concatenated. */
  | "AUDIO_FORMAT_MISMATCH";

/** A narration build that cannot produce a correct track, captions or timings. */
export class NarrationError extends Error {
  /** Which defect this is, for a caller that branches rather than logs. */
  readonly code: NarrationErrorCode;

  constructor(code: NarrationErrorCode, message: string) {
    super(message);
    this.name = "NarrationError";
    this.code = code;
  }
}
