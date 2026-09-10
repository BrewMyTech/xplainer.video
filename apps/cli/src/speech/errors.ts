/**
 * The one error the in-process synthesiser raises, and the five things it can be about.
 *
 * It exists for the same reason `G2pError` and `NarrationError` do: a narration job runs inside a
 * long-lived daemon, so a speech failure has to be a catchable failure of *one job* that names what
 * is wrong, never a process that dies or — far worse here — a track that is quietly wrong.
 *
 * **Every code below is a refusal to produce audio, and that is the point.** The route this
 * replaces was an HTTP call to a server that could be asked again; this one runs in the worker, so
 * the failures it can have are configuration (a path that is not there, a voice pack that is not
 * the shape a voice pack has) and contract (a model whose outputs do not mean what this code was
 * measured against). Both classes produce *plausible-looking* audio if you let them through: the
 * wrong style row speaks the sentence 30% too fast, and a `durations` array that does not align
 * with the tokens puts every caption in the wrong place. Neither is visible in the MP4 without
 * someone watching it, so both are refusals.
 */

/** Which defect this is, for a caller that branches rather than logs. */
export type OnnxSpeechErrorCode =
  /** The ONNX Runtime location does not hold a loadable runtime. `setup` acquires it. */
  | "RUNTIME_UNAVAILABLE"
  /** The model file is not where the toolchain said, or the session would not open on it. */
  | "MODEL_UNAVAILABLE"
  /** The voice pack is missing, or is not a whole number of 256-float style rows. */
  | "VOICE_UNREADABLE"
  /** The narration asked for a voice this synthesiser has no pack for. */
  | "VOICE_MISMATCH"
  /** The graph's inputs or outputs are not the ones this code was written against. */
  | "MODEL_CONTRACT"
  /** The word timings and the audio disagree; see `timing.ts`'s docblock (plan D6). */
  | "TIMING_INCONSISTENT";

/** A synthesis that cannot be produced correctly, rather than one produced wrongly. */
export class OnnxSpeechError extends Error {
  /** Which defect this is. */
  readonly code: OnnxSpeechErrorCode;

  constructor(code: OnnxSpeechErrorCode, message: string) {
    super(message);
    this.name = "OnnxSpeechError";
    this.code = code;
  }
}
