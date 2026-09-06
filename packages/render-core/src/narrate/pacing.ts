/**
 * Narration pacing, ported verbatim from the reference implementation
 * (`narrate.py:60-68`) — roadmap P1-2 and P1-6, docs/ROADMAP.md.
 *
 * The three millisecond constants are the whole of the pacing policy, and the
 * comment in the original says the load-bearing part: **silence is inserted,
 * never trimmed**. Every offset the port reports is a position on a track that
 * really contains that much audio, so the measured word timings stay
 * authoritative and the picture cannot drift from the voice.
 *
 * They are exported rather than kept private because the durations they produce
 * are what `timings.json` promises, and a caller that wants to explain a
 * segment boundary — or a test that wants to assert one — needs the same three
 * numbers rather than a copy of them.
 */

/** Silence before the first word, so the video does not open mid-syllable. */
export const LEAD_IN_MS = 400;

/** Silence between two segments: the beat that separates one scene from the next. */
export const GAP_MS = 620;

/** Silence after the last word, so it lands before the video cuts. */
export const TAIL_MS = 800;

/**
 * Sample rate the narration track is built at when the server has not told us
 * otherwise — Kokoro's own output rate, and the rate a dry run invents.
 *
 * A live run overrides this with the rate of the first WAV the server returns
 * and rejects any later segment that disagrees; this value is only the fallback
 * for a track with no speech in it at all.
 */
export const DEFAULT_SAMPLE_RATE = 24000;

/** Frame rate used when the narration script names none (`narrate.py:191`). */
export const DEFAULT_FPS = 30;

/** Voice used when the narration script names none (`narrate.py:192`). */
export const DEFAULT_VOICE = "af_heart";

/** A plausible speaking rate, used only by the dry run (`narrate.py:68`). */
export const DRY_RUN_WORDS_PER_SEC = 2.9;

/** Floor on an estimated segment length, in seconds (`narrate.py:176`). */
export const DRY_RUN_MIN_SECONDS = 0.6;

/** Filename of the narration track, relative to the video's public directory. */
export const NARRATION_AUDIO_FILE = "narration.wav";

/** Filename of the measured segment timings, relative to the same directory. */
export const TIMINGS_FILE = "timings.json";

/** Filename of the word-level caption track, relative to the same directory. */
export const CAPTIONS_FILE = "captions.json";
