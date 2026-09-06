/**
 * Where the narration worker's speech comes from.
 *
 * Two sources, chosen by the environment and never by a flag an agent can set:
 *
 * - **A Kokoro server**, which is the product. `XPLAINER_TTS_URL` names it; without that,
 *   `@xplainer/tts-client`'s own resolution applies (`KOKORO_URL`, then its default), so a
 *   developer who already exported that variable for the reference implementation keeps working.
 * - **A fixture directory**, when `XPLAINER_TTS_FIXTURE` names one. Each segment's audio and word
 *   spans are read from files that were recorded once, so a test — or a machine with no container
 *   running — gets *measured* timings from real WAV frames rather than the estimates a dry run
 *   invents. This is not a mock of the client: it is a stand-in for the **server**, and everything
 *   below it (decoding, measuring, planning, concatenating, writing) is the shipping code path.
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
  type CaptionedSpeechRequest,
  type CaptionedSpeechResponse,
  KokoroClient,
  resolveBaseUrl,
  type WordTimestamp,
} from "@xplainer/tts-client";

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
 * Decide where this narration run's speech comes from.
 *
 * @param env the environment to read; defaults to this process's
 */
export function resolveSpeech(env: SpeechEnvironment = process.env): ResolvedSpeech {
  const fixtureDir = env[TTS_FIXTURE_ENV];
  if (fixtureDir !== undefined && fixtureDir.trim() !== "") {
    const dir = fixtureDir.trim();
    return {
      synthesiser: createFixtureSynthesiser(dir),
      source: `recorded speech from ${dir} (${TTS_FIXTURE_ENV})`,
    };
  }
  const configured = env[TTS_URL_ENV];
  const baseUrl =
    configured !== undefined && configured.trim() !== "" ? configured.trim() : resolveBaseUrl(env);
  return {
    synthesiser: new KokoroClient({ baseUrl }),
    source: `kokoro at ${baseUrl}`,
  };
}
