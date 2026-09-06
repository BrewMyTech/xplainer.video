/**
 * `narrate()` — the whole run, from a narration script to three files
 * (`narrate.py:190-299`) — roadmap P1-2 and P1-6, docs/ROADMAP.md.
 *
 * The order is the one thing this function contributes, and it is chosen so
 * that nothing is written before everything is known:
 *
 *   1. synthesise (or estimate) every segment, collecting frames and word spans;
 *   2. measure each segment's length from its frames — never from its last word;
 *   3. plan, which is pure and is where all the arithmetic lives;
 *   4. build the track from the plan's own sample counts;
 *   5. write the track, `captions.json` and `timings.json`.
 *
 * SYNTHESIS GOES THROUGH `@xplainer/tts-client`, unchanged. That package pins
 * the two Kokoro endpoints and the two payload flags that fail silently when
 * inverted (`stream: false`, `return_timestamps: true`), and it is the only
 * thing here that speaks HTTP. `narrate()` takes any object with the client's
 * `captionedSpeech` method, so a test drives a real `KokoroClient` over a stub
 * transport rather than a lookalike, and a caller with a configured server
 * hands its own client in.
 *
 * A DRY RUN IS LABELLED. With `dryRun`, no server is contacted and each segment
 * becomes silence of an estimated length; the result then reports
 * `mode: "dry_run"`, so nothing downstream can mistake invented timings for
 * measured ones.
 */

import type { Captions, Narration, Timings } from "@xplainer/protocol";
import {
  type CaptionedSpeechRequest,
  type CaptionedSpeechResponse,
  DEFAULT_SPEED,
  KokoroClient,
  type WordTimestamp,
} from "@xplainer/tts-client";
import { buildCaptions } from "./captions.js";
import { NarrationError } from "./errors.js";
import { estimateSpeech } from "./estimate.js";
import { DEFAULT_SAMPLE_RATE, DEFAULT_VOICE, NARRATION_AUDIO_FILE } from "./pacing.js";
import { planSegments, type SegmentSpeech } from "./plan.js";
import { buildTimings } from "./timings.js";
import { buildTrack, reconcileFormat } from "./track.js";
import { decodeWav, type PcmFormat, pcmDurationMs, silenceSamples, silentFrames } from "./wav.js";
import { writeCaptions, writeNarrationTrack, writeTimings } from "./write.js";

/**
 * The format a track falls back to when no speech was synthesised at all —
 * Kokoro's own, and the one a dry run invents (`narrate.py:76-78`).
 */
const FALLBACK_FORMAT: PcmFormat = {
  channels: 1,
  sampleWidth: 2,
  sampleRate: DEFAULT_SAMPLE_RATE,
};

/**
 * The one thing `narrate()` needs from a speech server.
 *
 * Structural rather than `KokoroClient` so a caller can supply a client built
 * with its own base URL or transport, and so a test can pass the real client
 * over a stub `fetch`. `KokoroClient` satisfies it as it stands.
 */
export type SpeechSynthesiser = {
  captionedSpeech(request: CaptionedSpeechRequest): Promise<CaptionedSpeechResponse>;
};

/** Whether the timings were measured from real speech or invented by a dry run. */
export type NarrateMode = "kokoro" | "dry_run";

/** Arguments for one narration run. */
export type NarrateOptions = {
  /** The narration spec, as `explainer_narrate` received it. */
  readonly narration: Narration;
  /** The video's public directory: where the three files are written. */
  readonly outDir: string;
  /** Speech server. Defaults to a `KokoroClient` on the configured base URL. */
  readonly client?: SpeechSynthesiser;
  /** Skip the server entirely and estimate every segment. Defaults to `false`. */
  readonly dryRun?: boolean;
  /** Track filename inside `outDir`. Defaults to `narration.wav`. */
  readonly audioFile?: string;
};

/** What one narration run produced, in memory and on disk. */
export type NarrateResult = {
  /** `"dry_run"` when the timings were estimated rather than measured. */
  readonly mode: NarrateMode;
  /** The `timings.json` document, as written. */
  readonly timings: Timings;
  /** The `captions.json` document, as written. */
  readonly captions: Captions;
  /** Path of the narration track. */
  readonly audioPath: string;
  /** Path of `timings.json`. */
  readonly timingsPath: string;
  /** Path of `captions.json`. */
  readonly captionsPath: string;
};

/** One segment's raw audio and the word spans that go with it. */
type SegmentAudio = {
  readonly frames: Buffer;
  readonly words: readonly WordTimestamp[];
};

/** Collapse runs of whitespace, as the reference implementation does (`narrate.py:214`). */
function collapseWhitespace(text: string): string {
  return text
    .split(/\s+/)
    .filter((part) => part !== "")
    .join(" ");
}

/** Build the request for one segment, omitting `langCode` when the script gives none. */
function speechRequest(narration: Narration, text: string): CaptionedSpeechRequest {
  const request: CaptionedSpeechRequest = {
    text,
    voice: narration.voice ?? DEFAULT_VOICE,
    speed: narration.speed ?? DEFAULT_SPEED,
  };
  return narration.langCode === undefined ? request : { ...request, langCode: narration.langCode };
}

/**
 * Narrate one video: synthesise or estimate, measure, plan, concatenate, write.
 *
 * @throws NarrationError when the script is empty, a word span is unusable, a
 *   segment's audio is not readable 16-bit PCM, or the server changes format
 *   between segments.
 */
export async function narrate(options: NarrateOptions): Promise<NarrateResult> {
  const { narration, outDir } = options;
  const dryRun = options.dryRun === true;
  const audioFile = options.audioFile ?? NARRATION_AUDIO_FILE;

  if (narration.segments.length === 0) {
    throw new NarrationError("NO_SEGMENTS", "the narration script has no segments to speak.");
  }

  const client = dryRun ? undefined : (options.client ?? new KokoroClient());
  let format: PcmFormat | undefined = dryRun ? FALLBACK_FORMAT : undefined;
  const audio: SegmentAudio[] = [];

  for (const segment of narration.segments) {
    const text = collapseWhitespace(segment.text);

    if (text === "") {
      // An empty segment is silent for exactly its hold, which the planner adds.
      audio.push({ frames: Buffer.alloc(0), words: [] });
      continue;
    }

    if (client === undefined) {
      const estimated = estimateSpeech(text);
      const samples = silenceSamples(FALLBACK_FORMAT.sampleRate, estimated.durationMs);
      audio.push({ frames: silentFrames(FALLBACK_FORMAT, samples), words: estimated.words });
      continue;
    }

    const response = await client.captionedSpeech(speechRequest(narration, text));
    const decoded = decodeWav(Buffer.from(response.audio, "base64"));
    format = reconcileFormat(format, decoded.format);
    audio.push({ frames: decoded.data, words: response.timestamps });
  }

  const resolvedFormat = format ?? FALLBACK_FORMAT;
  const perSegmentWords: SegmentSpeech[] = audio.map((segment) => ({
    spokenMs: pcmDurationMs(resolvedFormat, segment.frames.length),
    words: segment.words,
  }));

  const plan = planSegments(narration, perSegmentWords, resolvedFormat.sampleRate);
  const track = buildTrack(
    plan,
    audio.map((segment) => segment.frames),
    resolvedFormat,
  );
  const captions = buildCaptions(plan.segments);
  const timings = buildTimings(plan, audioFile);

  return {
    mode: dryRun ? "dry_run" : "kokoro",
    timings,
    captions,
    audioPath: writeNarrationTrack(outDir, audioFile, track),
    timingsPath: writeTimings(outDir, timings),
    captionsPath: writeCaptions(outDir, captions),
  };
}
