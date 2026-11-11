/**
 * ElevenLabs' character alignment, turned into the word spans the narration port is built on.
 *
 * The Kokoro routes report one span per word, and everything below the port — `planSegments`,
 * `buildCaptions`, `buildTimings` — reads exactly that shape, `WordTimestamp[]`. ElevenLabs reports
 * one span per *character*. This module is the whole conversion, and it is pure: no audio, no
 * environment, no knowledge of how long the audio turned out to be.
 *
 * **That last one is deliberate.** The service's alignment can run past its own audio — measured
 * at 4.88 s of alignment over 4.80 s of `eleven_v4` audio — and the honest response to that needs
 * the decoded duration, which only the caller that decoded the audio has. So the bound against the
 * audio, refusing a word that starts after it ends and clamping one that runs over, lives in that
 * caller (`apps/cli/src/tts/elevenlabs.ts`), and this function returns the times as measured.
 */

import type { WordTimestamp } from "../types.js";
import { ElevenLabsError } from "./client.js";
import type { ElevenLabsAlignment } from "./types.js";

/** An element made of nothing but whitespace separates two words; any other element is part of one. */
const SEPARATOR = /^\s+$/u;

/**
 * Convert a character alignment into one span per word.
 *
 * A word is a maximal run of characters that are not whitespace, so punctuation stays attached to
 * the word it touches (`"failed."`, `"again,"`) — the shape the in-process ONNX route emits — and a
 * free-standing mark such as `"—"` is a word of its own, which `buildCaptions` folds into the
 * caption before it exactly as it does Kokoro's punctuation tokens.
 *
 * A word starts when its first character starts and ends when its **last character ends** — never
 * when the next word starts. The gap between the two is the pause the voice took, and `plan.ts`
 * places silence and caption changes on it; closing the gap would make every caption linger into
 * the next word's breath.
 *
 * Refused, as `alignment_invalid`, rather than repaired:
 *
 *   * no characters, or three arrays of different lengths;
 *   * a character or a word whose start or end is not finite, whose start is negative, or whose end
 *     comes before its start — a word is checked again after it is assembled, because characters
 *     inside it that run backwards make a word that ends before it starts;
 *   * a word that starts before the word in front of it starts, or ends before it ends.
 *
 * Two words with equal times, and a word that starts before the one in front of it has ended, are
 * both accepted: the service does report them, and neither puts the script out of order.
 */
export function alignmentToWordTimestamps(alignment: ElevenLabsAlignment): WordTimestamp[] {
  const {
    characters,
    character_start_times_seconds: starts,
    character_end_times_seconds: ends,
  } = alignment;

  if (characters.length === 0) {
    throw invalid("it has no characters");
  }
  if (starts.length !== characters.length || ends.length !== characters.length) {
    throw invalid(
      `its arrays differ in length: ${characters.length} characters, ${starts.length} start times, ${ends.length} end times`,
    );
  }

  const words: WordTimestamp[] = [];
  let open: { word: string; start_time: number; end_time: number } | undefined;

  for (const [index, character] of characters.entries()) {
    // The lengths are equal, so these are always defined; `NaN` only satisfies the index type,
    // and would be refused by the check below if it ever arrived.
    const start = starts[index] ?? Number.NaN;
    const end = ends[index] ?? Number.NaN;
    checkSpan(`character ${index} (${JSON.stringify(character)})`, start, end);

    if (SEPARATOR.test(character)) {
      if (open !== undefined) {
        words.push(closeWord(open, words));
        open = undefined;
      }
      continue;
    }

    if (open === undefined) {
      open = { word: character, start_time: start, end_time: end };
    } else {
      open.word += character;
      open.end_time = end;
    }
  }

  if (open !== undefined) {
    words.push(closeWord(open, words));
  }
  return words;
}

/** Validate an assembled word on its own and against the word before it, then freeze it. */
function closeWord(word: WordTimestamp, previousWords: readonly WordTimestamp[]): WordTimestamp {
  const label = `word ${previousWords.length} (${JSON.stringify(word.word)})`;
  checkSpan(label, word.start_time, word.end_time);

  const previous = previousWords[previousWords.length - 1];
  if (previous !== undefined) {
    const before = `word ${previousWords.length - 1} (${JSON.stringify(previous.word)}, ${previous.start_time}–${previous.end_time} s)`;
    if (word.start_time < previous.start_time) {
      throw invalid(`${label} starts at ${word.start_time} s, before ${before} starts`);
    }
    if (word.end_time < previous.end_time) {
      throw invalid(`${label} ends at ${word.end_time} s, before ${before} ends`);
    }
  }
  return { word: word.word, start_time: word.start_time, end_time: word.end_time };
}

function checkSpan(label: string, start: number, end: number): void {
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw invalid(`${label} has a time that is not a finite number (start ${start}, end ${end})`);
  }
  if (start < 0) {
    throw invalid(`${label} starts at ${start} s, before the audio does`);
  }
  if (end < start) {
    throw invalid(`${label} ends at ${end} s, before it starts at ${start} s`);
  }
}

function invalid(problem: string): ElevenLabsError {
  return new ElevenLabsError(
    `elevenlabs returned an alignment that cannot be timed: ${problem}`,
    undefined,
    "alignment_invalid",
  );
}
