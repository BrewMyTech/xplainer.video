/**
 * The voice pack, and the row of it that speaks a given sentence.
 *
 * **This module exists because "the style vector" is not one vector.** `af_heart.bin` is 522,240
 * bytes: 510 rows of 256 float32. The row is selected by the *length of the utterance in tokens* —
 * Kokoro's own Python does `ref_s = pack[len(ps) - 1]` — because the style embedding carries the
 * prosody, and the prosody of a one-word answer is not the prosody of a thirty-word sentence.
 *
 * **Measured, because the spike got this wrong and the error is invisible.** The S0b prototype took
 * the first 256 floats — row 0, the prosody of a *one-token* utterance — for every sentence. Against
 * the reference implementation's own Kokoro-FastAPI rendering the same phoneme string
 * (`/dev/generate_from_phonemes`, af_heart, full-precision model), on this machine on 2026-09-10:
 *
 * | Style row | Mean length error vs the reference | Worst |
 * |---|---|---|
 * | row 0 (the spike's) | **17.1%** | **30.6%** |
 * | `len - 1` (Kokoro's Python) | **0.3%** | 0.8% |
 * | `len` (transformers.js) | 0.6% | 1.6% |
 *
 * Row 0 spoke a 112-token sentence in 4.83 s where the reference takes 6.95 s — the same words,
 * rushed, and quieter with it (RMS 0.040 against 0.069). It is not a failure anyone would see: the
 * audio is fluent, the captions derived from it are self-consistent, and only a side-by-side with
 * the reference shows the speaker sprinting. `len - 1` is used because it is what the
 * implementation Kokoro ships selects, and it is what measured closest.
 *
 * The length that selects the row is the **token count without the padding**, which is `len(ps)` on
 * the Python side: the pads are this graph's input convention and were never part of the phoneme
 * string the style row is indexed by.
 */

import { existsSync, readFileSync } from "node:fs";
import { OnnxSpeechError } from "./errors.js";

/** Floats per style row, fixed by the model's `style` input being `float32[1, 256]`. */
export const STYLE_DIMENSION = 256;

/** A voice pack, in memory, and the identity it speaks with. */
export type VoicePack = {
  /** The voice id — `af_heart` — as the narration script must ask for it. */
  readonly voice: string;
  /** Every row, back to back. `length` is a whole multiple of {@link STYLE_DIMENSION}. */
  readonly rows: Float32Array;
  /** How many rows there are: the longest utterance the pack has a prosody for. */
  readonly rowCount: number;
};

/**
 * Read the voice pack at `path`.
 *
 * @param voice the voice id this pack speaks, which the narration script's `voice` must match
 *
 * @throws {OnnxSpeechError} `VOICE_UNREADABLE` when the file is absent, empty, or not a whole
 *   number of style rows. A truncated pack is refused rather than padded: a short final row would
 *   be read as a style vector and would speak in a voice nobody chose.
 */
export function readVoicePack(path: string, voice: string): VoicePack {
  if (!existsSync(path)) {
    throw new OnnxSpeechError(
      "VOICE_UNREADABLE",
      `no voice pack at ${path}. Run \`xplainer setup\` to acquire the speech voice.`,
    );
  }
  const bytes = readFileSync(path);
  const floats = bytes.length / 4;
  if (bytes.length === 0 || floats % STYLE_DIMENSION !== 0) {
    throw new OnnxSpeechError(
      "VOICE_UNREADABLE",
      `${path} is ${bytes.length} bytes, which is not a whole number of ${STYLE_DIMENSION}-float ` +
        "style rows. A Kokoro voice pack is 510 rows of 256 float32 — 522,240 bytes.",
    );
  }
  // A copy rather than a view onto the file buffer: `readFileSync` may hand back a Buffer that
  // shares a pooled ArrayBuffer, and a Float32Array over it would need `byteOffset` handling that
  // is easy to get right once and easy to lose in an edit.
  const rows = new Float32Array(floats);
  for (let index = 0; index < floats; index += 1) {
    rows[index] = bytes.readFloatLE(index * 4);
  }
  return { voice, rows, rowCount: floats / STYLE_DIMENSION };
}

/**
 * The style row for an utterance of `tokenCount` phoneme tokens, padding excluded.
 *
 * Clamped at both ends rather than refused. The lower clamp is for a one-symbol segment, where
 * `len - 1` is row −1; the upper is for a segment longer than the pack describes, where the last
 * row is the closest prosody there is and refusing would fail a job over a long sentence the
 * reference implementation speaks without complaint.
 */
export function styleRow(pack: VoicePack, tokenCount: number): Float32Array {
  const row = Math.min(Math.max(tokenCount - 1, 0), pack.rowCount - 1);
  const start = row * STYLE_DIMENSION;
  return pack.rows.slice(start, start + STYLE_DIMENSION);
}
