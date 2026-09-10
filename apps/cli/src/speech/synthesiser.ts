/**
 * `OnnxSynthesiser` — the third implementation of the `SpeechSynthesiser` port, speaking in this
 * process with no server, no container and no Python (plan §3).
 *
 * `resolveSpeech()` already returns a synthesiser behind that port, and there were two: the HTTP
 * `KokoroClient` and the fixture reader. This is the third, and it satisfies the *same* contract —
 * base64 WAV plus `{word, start_time, end_time}` spans — so everything downstream of it
 * (`decodeWav`, `planSegments`, `buildCaptions`, `buildTimings`) is the shipping code path
 * unchanged. Nothing downstream knows which of the three answered, which is the property that makes
 * this a route rather than a rewrite.
 *
 * **It lives in `apps/cli` and may never move into `@xplainer/tts-client`.** That package is what
 * `@xplainer/render-core` depends on for the wire types, so a synthesiser there that imported
 * `phonemise()` from render-core would close a cycle. `apps/cli` is downstream of both, which is
 * why the narration worker is the right home for the one implementation that needs them together.
 *
 * **Every path arrives as an argument.** The model file, the voice pack and the ONNX Runtime
 * location are explicit options — this module discovers nothing, reads no environment variable and
 * consults no marker. Acquisition is `setup`'s (plan S2) and route selection is
 * `workers/speech.ts`'s; keeping both out of here is what lets the whole synthesiser be driven
 * against a fake runtime in a unit test and against the real model in a gated one.
 *
 * **Construction is cheap; the model loads on first use.** `resolveSpeech()` is synchronous and is
 * called before the narration worker knows whether it will synthesise anything, so opening a 92 MB
 * session there would cost every job that turns out to be a dry run. What construction *does* do is
 * check that the files are where the caller said and that the voice pack is the shape a voice pack
 * has, because a misconfigured route should fail before a job starts rather than on its first
 * segment.
 *
 * **The clip is returned as the model produced it, and that is one measured difference from the
 * server route.** Kokoro-FastAPI trims its output; this does not. Measured on this machine on
 * 2026-09-10, a clip carries **≈0.32–0.49 s before the first phoneme** and **≈0.19 s after the
 * last**, so the same sentence comes back 8–13% longer here than from the reference
 * implementation — the *speech* is the same length, and the padding is not. It is left in
 * deliberately rather than trimmed:
 *
 * - The head is not digital silence. It is a noise floor below −66 dBFS — inaudible, but not zero —
 *   and the first phoneme's onset begins *before* the boundary the duration predictor implies. So a
 *   trim needs an audibility threshold, and a threshold set slightly wrong clips the start of the
 *   first word, which is the failure this whole path exists to refuse.
 * - Pacing is not this module's to decide. `render-core`'s `narrate/pacing.ts` owns `LEAD_IN_MS`,
 *   `GAP_MS` and `TAIL_MS`, they apply to every engine rather than to this one, and changing them
 *   changes every existing video's timing — which that package's own instructions say needs a
 *   changeset that says so.
 *
 * **The head does not shift the word timings, and that is what makes leaving it in safe.** The
 * timings are absolute offsets into the clip *as delivered* — the head is inside the timeline as
 * well as inside the audio, so the leading pad's own predicted duration is what the first word's
 * `start_time` sits after. Measured against the audible onset in this synthesiser's own output
 * (first sample above −40 dBFS), the first word's `start_time` lands **13–41 ms after the voice
 * starts, mean 29 ms** — under a frame and a half at 30 fps, and it is the duration predictor's
 * own alignment rather than this module's arithmetic: the reference implementation has the same
 * predictor and the same small lateness. Internally the two agree too. With the constant head
 * offset removed, our word starts sit **52 ms** from Kokoro-FastAPI's and our word lengths **50 ms**
 * from its, over 44 words of four sentences — and that spread includes the G2P difference (CMUdict
 * phonemes against misaki's), not just the timing arithmetic.
 *
 * So **nothing downstream needs to know about the padding**: a caption placed at `start_time` lands
 * on the voice, and `narrate/plan.ts` measures a segment's length from its PCM frames rather than
 * from its last word, which is the invariant that makes a clip with padding ordinary rather than
 * special. What the padding costs is pacing, not correctness. The word timings are exact for the
 * audio returned either way: they come from the same run, and `timing.ts` refuses to emit any that
 * disagree with it.
 */

import { existsSync } from "node:fs";
import process from "node:process";
import {
  DEFAULT_SAMPLE_RATE,
  type DerivedPronunciation,
  encodeWav,
  phonemise,
  type SpeechSynthesiser,
} from "@xplainer/render-core";
import {
  type CaptionedSpeechRequest,
  type CaptionedSpeechResponse,
  DEFAULT_SPEED,
} from "@xplainer/tts-client";
import { OnnxSpeechError } from "./errors.js";
import { loadOnnxRuntime, type OnnxInferenceSession, type OnnxRuntimeModule } from "./runtime.js";
import { deriveWordTimings } from "./timing.js";
import { tokenisePhonemes } from "./tokens.js";
import { readVoicePack, STYLE_DIMENSION, styleRow, type VoicePack } from "./voice.js";

/** The graph's three input names, and its two output names. Verified against the model in S1. */
const INPUT_IDS = "input_ids";

/** See {@link INPUT_IDS}. */
const STYLE = "style";

/** See {@link INPUT_IDS}. */
const SPEED = "speed";

/** See {@link INPUT_IDS}. */
const WAVEFORM = "waveform";

/** See {@link INPUT_IDS}. */
const DURATIONS = "durations";

/**
 * The speaking-rate range the port documents (`tts-client`'s `CaptionedSpeechRequest.speed`).
 *
 * Refused rather than clamped outside it: a script asking for a rate this engine cannot honour
 * should hear about it, not get a different rate silently. Zero in particular would be a division
 * inside the graph and would come back as noise.
 */
const MIN_SPEED = 0.25;

/** See {@link MIN_SPEED}. */
const MAX_SPEED = 4;

/** 16-bit PCM's positive limit, which is also where a float sample is clipped. */
const INT16_MAX = 32767;

/** …and its negative one. Asymmetric, as two's complement is. */
const INT16_MIN = -32768;

/** Everything the synthesiser needs, and nothing it could look up for itself. */
export type OnnxSynthesiserOptions = {
  /** The `.onnx` model file, as the toolchain recorded it. */
  readonly modelPath: string;
  /** The voice pack, as the toolchain recorded it. */
  readonly voicePath: string;
  /** The voice id that pack speaks — `af_heart`. A narration asking for another is refused. */
  readonly voice: string;
  /** Where `setup` put the ONNX Runtime: a package directory or an entry file. */
  readonly runtimeLocation: string;
  /**
   * Where the derived-pronunciation lines go (plan D5).
   *
   * Defaults to this process's stdout, which in the narration worker *is* the job's log tail — the
   * runner captures both streams into the record's bounded `log`, so a line written here is a line
   * the agent that polled the job can read.
   */
  readonly log?: (line: string) => void;
  /**
   * A runtime module to use instead of loading one from `runtimeLocation`.
   *
   * The seam every test below the gated real-inference one drives. It is not a way to inject a
   * different real runtime: `runtimeLocation` is still required and still reported, so a
   * misconfigured route is a named failure whether or not this is set.
   */
  readonly runtime?: OnnxRuntimeModule;
};

/** Write one line to the job's log tail. */
function writeToJobLog(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** The sentence a derived pronunciation gets in the log (plan D5). */
function derivedLine(derived: DerivedPronunciation): string {
  return (
    `[xplainer] speech derived a pronunciation for ${JSON.stringify(derived.word)}: ` +
    `/${derived.ipa}/ (${derived.source}). Add it to ` +
    "packages/render-core/src/g2p/data/lexicon.txt to fix it in place."
  );
}

/** Read a tensor out of a run's outputs, refusing the shape this code was not written against. */
function readTensor(
  outputs: Readonly<Record<string, { readonly data: ArrayLike<number> }>>,
  name: string,
): ArrayLike<number> {
  const tensor = outputs[name];
  if (tensor === undefined) {
    throw new OnnxSpeechError(
      "MODEL_CONTRACT",
      `the model produced no "${name}" output. This code needs the timestamped Kokoro graph, ` +
        `whose outputs are "${WAVEFORM}" and "${DURATIONS}"; a graph without the second cannot ` +
        "place a word in time at all.",
    );
  }
  return tensor.data;
}

/**
 * Float samples in [-1, 1] as the 16-bit little-endian PCM the narration port reads.
 *
 * Clipped rather than normalised. A normalising pass would make one segment's loudness depend on
 * its own peak, so the narration track would breathe between segments; the model's output only
 * grazes the limit, and `render-core`'s WAV reader handles 16-bit integer PCM and nothing else.
 */
function toPcm16(samples: ArrayLike<number>): Buffer {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;
    const scaled = Math.round(sample * INT16_MAX);
    pcm.writeInt16LE(Math.min(INT16_MAX, Math.max(INT16_MIN, scaled)), index * 2);
  }
  return pcm;
}

/**
 * Build a synthesiser that speaks in this process.
 *
 * @throws {OnnxSpeechError} `MODEL_UNAVAILABLE` or `VOICE_UNREADABLE` — at construction, from the
 *   two paths, so a route that cannot work is refused before a job starts.
 */
export function createOnnxSynthesiser(options: OnnxSynthesiserOptions): SpeechSynthesiser {
  const { modelPath, voicePath, voice, runtimeLocation } = options;
  const log = options.log ?? writeToJobLog;

  if (!existsSync(modelPath)) {
    throw new OnnxSpeechError(
      "MODEL_UNAVAILABLE",
      `no speech model at ${modelPath}. Run \`xplainer setup\` to acquire it.`,
    );
  }
  const pack: VoicePack = readVoicePack(voicePath, voice);

  // One session per synthesiser, opened once and awaited by every segment after the first. Held as
  // the promise rather than as the resolved session so two overlapping calls cannot each open one:
  // the model is ~92 MB of weights and the peak RSS of this worker is a recorded budget.
  let opening: Promise<{ runtime: OnnxRuntimeModule; session: OnnxInferenceSession }> | null = null;

  function open(): Promise<{ runtime: OnnxRuntimeModule; session: OnnxInferenceSession }> {
    if (opening === null) {
      opening = (async () => {
        const runtime = options.runtime ?? loadOnnxRuntime(runtimeLocation);
        try {
          const session = await runtime.InferenceSession.create(modelPath, {
            executionProviders: ["cpu"],
          });
          return { runtime, session };
        } catch (error) {
          throw new OnnxSpeechError(
            "MODEL_UNAVAILABLE",
            `${modelPath} would not open as an ONNX model ` +
              `(${error instanceof Error ? error.message : String(error)}).`,
          );
        }
      })();
    }
    return opening;
  }

  return {
    async captionedSpeech(request: CaptionedSpeechRequest): Promise<CaptionedSpeechResponse> {
      if (request.voice !== pack.voice) {
        throw new OnnxSpeechError(
          "VOICE_MISMATCH",
          `the narration asks for voice ${JSON.stringify(request.voice)} and the acquired voice ` +
            `pack is ${JSON.stringify(pack.voice)}. Speaking it in the wrong voice would be a ` +
            "silent substitution; a server-side blend such as af_bella(2)+af_sky(1) has no " +
            "meaning on this route at all.",
        );
      }
      const speed = request.speed ?? DEFAULT_SPEED;
      if (!Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) {
        throw new OnnxSpeechError(
          "MODEL_CONTRACT",
          `speed ${String(speed)} is outside the ${MIN_SPEED}–${MAX_SPEED} this engine speaks at.`,
        );
      }

      // A G2pError here fails the narration job with the word named, which is D5: no configuration
      // of this product may drop a word from the audio. It is rethrown untouched — it already
      // carries the word as a field and the one-line fix in its message, and wrapping it would
      // leave a caller regexing a message for the spelling to add.
      const spoken = phonemise(request.text);
      for (const derived of spoken.derived) {
        log(derivedLine(derived));
      }

      const tokens = tokenisePhonemes(spoken.ipa);
      const { runtime, session } = await open();
      const style = styleRow(pack, tokens.phonemeCount);
      const outputs = await session.run({
        [INPUT_IDS]: new runtime.Tensor(
          "int64",
          BigInt64Array.from(tokens.ids, (id) => BigInt(id)),
          [1, tokens.ids.length],
        ),
        [STYLE]: new runtime.Tensor("float32", style, [1, STYLE_DIMENSION]),
        [SPEED]: new runtime.Tensor("float32", Float32Array.from([speed]), [1]),
      });

      const waveform = readTensor(outputs, WAVEFORM);
      const durations = readTensor(outputs, DURATIONS);
      const timing = deriveWordTimings({
        tokens,
        durations,
        words: spoken.words,
        sampleCount: waveform.length,
        sampleRate: DEFAULT_SAMPLE_RATE,
      });

      return {
        audio: encodeWav({
          format: { channels: 1, sampleWidth: 2, sampleRate: DEFAULT_SAMPLE_RATE },
          data: toPcm16(waveform),
        }).toString("base64"),
        timestamps: timing.timestamps,
      };
    },
  };
}
