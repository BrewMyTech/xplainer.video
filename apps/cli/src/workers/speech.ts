/**
 * Where the narration worker's speech comes from.
 *
 * **Three sources, and an agent chooses none of them.** Two are environment variables an operator
 * or a workflow sets; the third is what `xplainer setup` acquired on this machine, read out of the
 * record `setup` left. A tool call carries no flag that reaches here, which is the property to
 * preserve — the daemon speaking with whatever this machine has is not the same thing as a caller
 * picking an engine per request:
 *
 * - **The in-process ONNX engine**, when this machine has one, which is the product from plan
 *   P2-4 on (`.omc/plans/ralplan-speech-onnx.md`). Kokoro-82M runs inside the narration worker
 *   through the ONNX Runtime `setup` acquired, with the G2P in `@xplainer/render-core` in front of
 *   it, so a machine needs no Docker, no `--tts-url` and no Python. Word timings come from the
 *   model's own per-token duration predictor rather than from an alignment estimate.
 * - **A Kokoro server**, which is what the ONNX engine replaces and what still answers when one is
 *   configured. `XPLAINER_TTS_URL` names it; without that, `@xplainer/tts-client`'s own resolution
 *   applies (`KOKORO_URL`, then its default), so a developer who already exported that variable for
 *   the reference implementation keeps working.
 * - **A fixture directory**, when `XPLAINER_TTS_FIXTURE` names one. Each segment's audio and word
 *   spans are read from files that were recorded once, so a test — or a machine with no container
 *   running — gets *measured* timings from real WAV frames rather than the estimates a dry run
 *   invents. This is not a mock of the client: it is a stand-in for the **server**, and everything
 *   below it (decoding, measuring, planning, concatenating, writing) is the shipping code path.
 *
 * **The precedence is fixture, then URL, then whatever `toolchain.json` records, then the
 * tts-client's own default**, and each step of it is deliberate. A fixture wins over everything
 * because a test environment must not reach a developer's running container *or* spend six seconds
 * a segment in a real model. An explicit `XPLAINER_TTS_URL` beats the local engine because someone
 * who named a server meant it — a hosted voice, a variant, a comparison against the reference
 * implementation — and a machine that has run `setup` is exactly the machine where that intent would
 * otherwise be silently overridden. The marker then beats the tts-client's default, which is a
 * `localhost:8880` guess at a container that is usually not running.
 *
 * **Step three is the marker and not three environment variables, which is plan S5 and the whole
 * point of it.** Until it landed, {@link resolveSpeech}'s locator defaulted to
 * `onnxSpeechFromEnvironment`, so the engine `setup` had acquired spoke only for a caller who
 * exported `XPLAINER_ONNX_MODEL`, `XPLAINER_ONNX_VOICE` and `XPLAINER_ONNX_RUNTIME` — which meant a
 * daemon on a machine that had run `setup` could not find its own engine, and the proof supplied the
 * three variables by hand out of the marker to work around it. `setup/speech-locate.ts` is the
 * reader; the three variables stay, above it, as the way to point the engine at a model no `setup`
 * acquired. Nothing here decides the *acquisition* order — that is `setup/providers/speech.ts`'s,
 * and a machine that recorded `docker` still narrates against its container exactly as before,
 * because a marker recording any other provider is an absence to this module.
 *
 * A fixture is matched by the exact text the narration port asks for, which is the segment text
 * after whitespace collapsing. Matching on text rather than on position is what makes a fixture
 * directory readable on its own and what stops a re-ordered narration silently speaking the wrong
 * clip — a mismatch is a named failure instead.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import type { SpeechSynthesiser } from "@xplainer/render-core";
import {
  BASE_URL_ENV_VAR,
  type CaptionedSpeechRequest,
  type CaptionedSpeechResponse,
  KokoroClient,
  resolveBaseUrl,
  type WordTimestamp,
} from "@xplainer/tts-client";
import { onnxSpeechFromToolchain } from "../setup/speech-locate.js";
import { createOnnxSynthesiser, type OnnxSpeechLocator } from "../speech/index.js";

/** Names the Kokoro server this daemon narrates against. */
export const TTS_URL_ENV = "XPLAINER_TTS_URL";

/** Names a directory of pre-recorded speech to use instead of a server. */
export const TTS_FIXTURE_ENV = "XPLAINER_TTS_FIXTURE";

/** The manifest a fixture directory must carry. */
export const FIXTURE_MANIFEST_FILE = "fixtures.json";

/** One recorded segment: the text it speaks, and the two files that hold it. */
export type SpeechFixture = {
  /** The segment text, after whitespace collapsing, exactly as the narration port asks for it. */
  text: string;
  /** A 16-bit PCM WAV file, relative to the fixture directory. */
  audio: string;
  /** A JSON array of Kokoro-shaped `{word, start_time, end_time}` spans, relative to the same. */
  words: string;
};

/** The environment this module reads, narrowed to what it uses. */
export type SpeechEnvironment = Readonly<Record<string, string | undefined>>;

/** A synthesiser, and the one line the worker logs about where its speech came from. */
export type ResolvedSpeech = {
  synthesiser: SpeechSynthesiser;
  /** Human-readable provenance, for the job's log tail. */
  source: string;
};

/** A fixture directory that is missing, malformed, or has no clip for a segment. */
export class SpeechFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeechFixtureError";
  }
}

function readManifest(dir: string): SpeechFixture[] {
  const path = join(dir, FIXTURE_MANIFEST_FILE);
  if (!existsSync(path)) {
    throw new SpeechFixtureError(
      `${TTS_FIXTURE_ENV} points at ${dir}, which has no ${FIXTURE_MANIFEST_FILE}. The manifest is ` +
        'a JSON array of {"text", "audio", "words"} entries.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new SpeechFixtureError(`${path} is not readable JSON (${String(error)}).`);
  }
  if (!Array.isArray(parsed)) {
    throw new SpeechFixtureError(`${path} must be a JSON array of fixture entries.`);
  }
  return parsed.map((entry, index) => {
    const candidate = entry as Partial<SpeechFixture>;
    if (
      typeof candidate.text !== "string" ||
      typeof candidate.audio !== "string" ||
      typeof candidate.words !== "string"
    ) {
      throw new SpeechFixtureError(
        `${path} entry ${index} needs string "text", "audio" and "words" fields.`,
      );
    }
    return { text: candidate.text, audio: candidate.audio, words: candidate.words };
  });
}

function readWordSpans(path: string): WordTimestamp[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new SpeechFixtureError(`${path} is not readable JSON (${String(error)}).`);
  }
  if (!Array.isArray(parsed)) {
    throw new SpeechFixtureError(`${path} must be a JSON array of word spans.`);
  }
  return parsed as WordTimestamp[];
}

/**
 * A synthesiser that answers out of `dir` instead of talking to a server.
 *
 * The response is the server's own envelope — base64 WAV plus word spans — so the narration port
 * decodes, measures and plans exactly as it does against Kokoro.
 */
export function createFixtureSynthesiser(dir: string): SpeechSynthesiser {
  const fixtures = readManifest(dir);
  return {
    captionedSpeech(request: CaptionedSpeechRequest): Promise<CaptionedSpeechResponse> {
      const fixture = fixtures.find((candidate) => candidate.text === request.text);
      if (fixture === undefined) {
        const known = fixtures.map((candidate) => JSON.stringify(candidate.text)).join(", ");
        return Promise.reject(
          new SpeechFixtureError(
            `no recorded speech in ${dir} for ${JSON.stringify(request.text)}. Recorded: ${known}.`,
          ),
        );
      }
      const audioPath = join(dir, fixture.audio);
      if (!existsSync(audioPath)) {
        return Promise.reject(new SpeechFixtureError(`${audioPath} does not exist.`));
      }
      return Promise.resolve({
        audio: readFileSync(audioPath).toString("base64"),
        timestamps: readWordSpans(join(dir, fixture.words)),
      });
    },
  };
}

/**
 * The server this environment *names*, or `null` when it names none.
 *
 * Both variables are read here rather than left to `resolveBaseUrl()`, which cannot distinguish
 * "`KOKORO_URL` is set" from "nothing is set, so here is the default". That distinction is the
 * whole of the ONNX route's precedence: a server someone typed beats the local engine, and a
 * `localhost:8880` guess does not.
 */
function namedServer(env: SpeechEnvironment): string | null {
  for (const variable of [TTS_URL_ENV, BASE_URL_ENV_VAR]) {
    const value = env[variable];
    if (value !== undefined && value.trim() !== "") {
      return value.trim();
    }
  }
  return null;
}

/**
 * Decide where this narration run's speech comes from.
 *
 * @param env the environment to read; defaults to this process's
 * @param locateOnnx how to ask whether this machine has an in-process engine. Defaults to
 *   `setup/speech-locate.ts`'s reader — the three `XPLAINER_ONNX_*` variables, else what
 *   `toolchain.json` records — and stays an argument rather than a call so that a route test can
 *   assert the *precedence* without a marker on the machine running it.
 */
export function resolveSpeech(
  env: SpeechEnvironment = process.env,
  locateOnnx: OnnxSpeechLocator = onnxSpeechFromToolchain,
): ResolvedSpeech {
  const fixtureDir = env[TTS_FIXTURE_ENV];
  if (fixtureDir !== undefined && fixtureDir.trim() !== "") {
    const dir = fixtureDir.trim();
    return {
      synthesiser: createFixtureSynthesiser(dir),
      source: `recorded speech from ${dir} (${TTS_FIXTURE_ENV})`,
    };
  }

  const named = namedServer(env);
  if (named !== null) {
    return { synthesiser: new KokoroClient({ baseUrl: named }), source: `kokoro at ${named}` };
  }

  const onnx = locateOnnx(env);
  if (onnx !== null) {
    return {
      synthesiser: createOnnxSynthesiser(onnx),
      // The origin is in the line because "the in-process engine" is two facts: the engine this
      // machine acquired, and an engine three variables point at. The proof reads this line to
      // assert that the *product* selected the route, which it cannot do if the two look alike.
      source:
        `kokoro in this process, voice ${onnx.voice} (${onnx.modelPath}), ` +
        `route ${onnx.origin}`,
    };
  }

  const baseUrl = resolveBaseUrl(env);
  return {
    synthesiser: new KokoroClient({ baseUrl }),
    source: `kokoro at ${baseUrl}`,
  };
}
