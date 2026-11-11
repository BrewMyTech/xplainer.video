/**
 * Where the narration worker's speech comes from.
 *
 * **Two levels: first which provider, then which route inside it — and an agent chooses none of
 * them.** The provider, its model, its key and the route are the machine owner's: environment
 * variables an operator or a workflow sets, `<state>/config.json` and `<state>/credentials.json`
 * that `xplainer config` writes, and what `xplainer setup` acquired. A tool call carries no flag
 * that reaches here, which is the property to preserve — the daemon speaking with whatever this
 * machine has is not the same thing as a caller picking an engine, or an account to bill, per
 * request. The one thing a narration may still choose is the voice (`tts/elevenlabs.ts`).
 *
 * ```
 * 1. XPLAINER_TTS_FIXTURE set                  -> a fixture directory (always wins, never bills)
 * 2. provider = XPLAINER_TTS_PROVIDER          -> else config.json tts.provider -> else "kokoro"
 * 3. provider == "elevenlabs"                  -> ElevenLabs; no Kokoro variable is consulted
 * 4. provider == "kokoro"                      -> the Kokoro route chain below, unchanged:
 *      XPLAINER_TTS_URL / KOKORO_URL -> XPLAINER_ONNX_* / toolchain.json -> tts-client default
 * ```
 *
 * Steps 2 and 3 are `tts/resolve.ts`'s, which `xplainer status` asks too, so the status line and
 * the job log cannot disagree about who is speaking. A Kokoro URL never beats a configured provider
 * (spec §11 C1): it is a *route* setting, and a stale `KOKORO_URL` in a shell profile would
 * otherwise silently undo `xplainer config set tts.provider elevenlabs`. When step 3 is taken with
 * one set anyway, the job log says once that it was not consulted. **There is no fallback from
 * ElevenLabs to Kokoro** — not for a missing key, not for a refused request. A video in a different
 * voice than the owner pays for, with nothing in the log to say so, is worse than a failed job.
 *
 * **The Kokoro routes.** Three, all of them the same provider reached three ways:
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
 * tts-client's own default**, and each step of it is deliberate. A fixture wins over everything —
 * the provider included — because a test environment must not reach a developer's running
 * container, spend six seconds a segment in a real model, *or bill an ElevenLabs account*. An
 * explicit `XPLAINER_TTS_URL` beats the local engine because someone who named a server meant it —
 * a hosted voice, a variant, a comparison against the reference implementation — and a machine
 * that has run `setup` is exactly the machine where that intent would otherwise be silently
 * overridden. The marker then beats the tts-client's default, which is a `localhost:8880` guess at
 * a container that is usually not running.
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
  ElevenLabsClient,
  KokoroClient,
  resolveBaseUrl,
  type WordTimestamp,
} from "@xplainer/tts-client";
import { credentialsPath } from "../config/credentials.js";
import { userConfigPath } from "../config/user-config.js";
import { resolveStateDir } from "../daemon/state-dir.js";
import { onnxSpeechFromToolchain } from "../setup/speech-locate.js";
import { createOnnxSynthesiser, type OnnxSpeechLocator } from "../speech/index.js";
import { readUserLexicon } from "../speech/user-lexicon.js";
import {
  createElevenLabsSynthesiser,
  ELEVENLABS_API_KEY_ENV,
  readElevenLabsApiKey,
  requireWordSpans,
  resolveTtsSelection,
  type SettingOrigin,
  TTS_PROVIDER_ENV,
  TTS_PROVIDERS,
  TtsProviderError,
  type TtsProviderId,
  type TtsSelection,
} from "../tts/index.js";

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

/** A synthesiser, and what the worker logs about where its speech came from. */
export type ResolvedSpeech = {
  synthesiser: SpeechSynthesiser;
  /** Human-readable provenance, for the first line of the job's log tail. */
  source: string;
  /** Who speaks: `"kokoro"` for all three Kokoro routes, the fixture included. */
  provider: TtsProviderId;
  /** The owner pays per character, so the job log says how many this narration sends. */
  billed: boolean;
  /**
   * Settings that were present and deliberately not used, one line each, for the job log right
   * after the first line. Empty for every Kokoro route, whose log stays byte-identical.
   */
  notes: readonly string[];
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

/** The ElevenLabs half of a {@link TtsSelection}. */
type ElevenLabsSelection = Extract<TtsSelection, { provider: "elevenlabs" }>;

/** Where a setting came from, as the job log's first line names it. */
function originLabel(origin: SettingOrigin): string {
  return origin === "config" ? "config.json" : origin;
}

/**
 * The ElevenLabs route: the key, the adapter, and the notes about what was not consulted.
 *
 * Refuses with `CREDENTIAL_MISSING` rather than falling through to a Kokoro route: the owner chose a
 * provider, and a narration in another voice is not a degraded form of that choice but a different
 * one, made by nobody.
 */
function elevenLabsSpeech(
  env: SpeechEnvironment,
  stateDir: string,
  selection: ElevenLabsSelection,
): ResolvedSpeech {
  const providerFrom =
    selection.providerOrigin === "environment" ? TTS_PROVIDER_ENV : userConfigPath(stateDir);
  const apiKey = readElevenLabsApiKey(env, stateDir);
  if (apiKey === null) {
    throw new TtsProviderError(
      "CREDENTIAL_MISSING",
      `the speech provider is elevenlabs (from ${providerFrom}) and no API key is stored. Run ` +
        "`xplainer config set tts.elevenlabs.api_key`. A key exported in a shell does not reach a " +
        "supervised daemon. Kokoro was not used instead: to go back, run " +
        "`xplainer config set tts.provider kokoro`.",
    );
  }
  const keyFrom =
    selection.apiKeyOrigin === "environment" ? ELEVENLABS_API_KEY_ENV : credentialsPath(stateDir);

  const notes: string[] = [];
  const kokoroVariables = [TTS_URL_ENV, BASE_URL_ENV_VAR].filter(
    (variable) => (env[variable] ?? "").trim() !== "",
  );
  if (kokoroVariables.length > 0) {
    const one = kokoroVariables.length === 1;
    notes.push(
      `${kokoroVariables.join(" and ")} ${one ? "names" : "name"} a Kokoro server and ` +
        `${one ? "was" : "were"} not consulted: the speech provider is elevenlabs (from ${providerFrom})`,
    );
  }
  // The file's second column is Kokoro's phoneme alphabet and feeds only render-core's G2P, so it
  // cannot apply here (spec D9) — and the skill tells agents to edit it, so silence would mislead.
  const lexicon = readUserLexicon(stateDir);
  if (lexicon.entries > 0) {
    notes.push(
      `pronunciations in ${lexicon.path} apply to the built-in Kokoro voice only and were not used`,
    );
  }

  const adapter = createElevenLabsSynthesiser({
    client: new ElevenLabsClient({ apiKey }),
    voice: selection.voice,
    model: selection.model,
    redact: (text) => text.replaceAll(apiKey, "[redacted]"),
  });
  const descriptor = TTS_PROVIDERS.elevenlabs;
  return {
    // The run-time half of the admissibility rule applies to remote providers only (spec §11 C10).
    synthesiser: descriptor.remote ? requireWordSpans(adapter, "elevenlabs") : adapter,
    source:
      `elevenlabs — voice ${selection.voice} (${originLabel(selection.voiceOrigin)}), ` +
      `model ${selection.model} (${originLabel(selection.modelOrigin)}), ` +
      `provider from ${providerFrom}, key from ${keyFrom}`,
    provider: "elevenlabs",
    billed: descriptor.billed,
    notes,
  };
}

/**
 * Decide where this narration run's speech comes from.
 *
 * The state directory is resolved from `env` exactly as the daemon resolved it, which is why the
 * worker is handed `XPLAINER_STATE_DIR`: `config.json`, `credentials.json` and `toolchain.json` are
 * all read from the directory this daemon owns, never from the platform default of whoever ran it.
 *
 * @param env the environment to read; defaults to this process's
 * @param locateOnnx how to ask whether this machine has an in-process engine. Defaults to
 *   `setup/speech-locate.ts`'s reader — the three `XPLAINER_ONNX_*` variables, else what
 *   `toolchain.json` records — and stays an argument rather than a call so that a route test can
 *   assert the *precedence* without a marker on the machine running it.
 * @throws {TtsProviderError} for a provider setting that cannot be used, or ElevenLabs with no key
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
      provider: "kokoro",
      billed: false,
      notes: [],
    };
  }

  const stateDir = resolveStateDir(env);
  const selection = resolveTtsSelection(env, stateDir);
  if (selection.provider === "elevenlabs") {
    return elevenLabsSpeech(env, stateDir, selection);
  }

  const named = namedServer(env);
  if (named !== null) {
    return {
      synthesiser: new KokoroClient({ baseUrl: named }),
      source: `kokoro at ${named}`,
      provider: "kokoro",
      billed: false,
      notes: [],
    };
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
      provider: "kokoro",
      billed: false,
      notes: [],
    };
  }

  const baseUrl = resolveBaseUrl(env);
  return {
    synthesiser: new KokoroClient({ baseUrl }),
    source: `kokoro at ${baseUrl}`,
    provider: "kokoro",
    billed: false,
    notes: [],
  };
}
