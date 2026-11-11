/**
 * ElevenLabs, as recorded: the real answers the lead captured from the live API on 2026-11-11,
 * served to the real `ElevenLabsClient` through a scripted `fetch`.
 *
 * **What is substituted is the service, and nothing nearer than that.** The client builds the real
 * body, parses the real error bodies and refuses what it refuses in production; the adapter under
 * test then sees exactly what it would see from a live request. A fake standing in for the client
 * itself would leave the wire body — whether `voice_settings` was sent, which voice id went into
 * the path — unasserted, and those are what the owner is billed for.
 *
 * **The fixtures are read from `@xplainer/tts-client`'s own test directory**, by path, the way
 * `backend.test.ts` reads `packages/protocol/schemas/`: one recording, owned by the package that
 * shapes the wire, rather than a copy here that could drift from it. Each recording keeps only the
 * first 4,800 bytes of its PCM (100 ms) and records the full length in `audio_bytes`; the body
 * served here grows the audio back to that length — the recorded prefix, then silence — so the
 * decoded duration is the true one. That matters: the `eleven_v4` recording's alignment runs to
 * 4.88 s over 4.80 s of audio, and the bound the adapter applies (spec §11 C6) is only tested by
 * audio of the length the service really returned.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type ElevenLabsAlignment,
  ElevenLabsClient,
  type FetchLike,
  type HttpRequestInit,
} from "@xplainer/tts-client";

/** `packages/tts-client/test/fixtures/elevenlabs/`, from this file rather than a hard-coded depth. */
const FIXTURES = fileURLToPath(
  new URL("../../../../../packages/tts-client/test/fixtures/elevenlabs/", import.meta.url),
);

/** A key shaped like a real one, so a test can assert it appears in no output. */
export const TEST_API_KEY = "sk_0123456789abcdef0123456789abcdef0123456789abcdef";

/** The two recorded successful answers. */
export type RecordingName = "with-timestamps" | "with-timestamps-v4-overrun";

/** One recorded answer, grown back to full length. */
export type RecordedSpeech = {
  /** The text that was sent, exactly. */
  readonly text: string;
  /** The model it was recorded with. */
  readonly modelId: string;
  /** The full PCM length the service returned. */
  readonly audioBytes: number;
  /** The recorded first bytes of that PCM. */
  readonly audioPrefix: Buffer;
  /** The response's `alignment`, verbatim. */
  readonly alignment: ElevenLabsAlignment;
  /** The response body, with `audio_base64` holding `audioBytes` bytes. */
  readonly body: Readonly<Record<string, unknown>>;
};

type RecordingFile = {
  request: { text: string; model_id: string };
  audio_bytes: number;
  response: Record<string, unknown> & { audio_base64: string; alignment: ElevenLabsAlignment };
};

/** Read one recording, and grow its audio back to the length the service returned. */
export function recordedSpeech(name: RecordingName): RecordedSpeech {
  const file = JSON.parse(readFileSync(`${FIXTURES}${name}.json`, "utf8")) as RecordingFile;
  const audioPrefix = Buffer.from(file.response.audio_base64, "base64");
  const audio = Buffer.alloc(file.audio_bytes);
  audioPrefix.copy(audio);
  return {
    text: file.request.text,
    modelId: file.request.model_id,
    audioBytes: file.audio_bytes,
    audioPrefix,
    alignment: file.response.alignment,
    body: { ...file.response, audio_base64: audio.toString("base64") },
  };
}

/** A recorded error body: `401` bad key, `404` unknown voice, `400` unknown model. */
export function recordedErrorBody(status: 400 | 401 | 404): unknown {
  const file = JSON.parse(readFileSync(`${FIXTURES}errors.json`, "utf8")) as {
    bodies: Record<string, unknown>;
  };
  return file.bodies[String(status)];
}

/** What the scripted service answers one request with. */
export type ScriptedAnswer =
  | { readonly status: number; readonly body: unknown }
  | { readonly thrown: unknown };

/** One request the scripted service received. */
export type ScriptedRequest = {
  readonly url: string;
  /** The voice id, read back out of the path. */
  readonly voiceId: string;
  readonly headers: Record<string, string>;
  readonly body: Readonly<Record<string, unknown>>;
};

/** A stand-in for api.elevenlabs.io, and the requests it was sent. */
export type ScriptedService = {
  readonly fetch: FetchLike;
  readonly requests: ScriptedRequest[];
};

/**
 * A service that answers each request with the next scripted answer, and once those run out with
 * the recording whose text was sent — or a `400` naming the text, so a test that sends something
 * unrecorded fails by name.
 */
export function scriptedService(
  recordings: readonly RecordedSpeech[],
  answers: readonly ScriptedAnswer[] = [],
): ScriptedService {
  const queue = [...answers];
  const requests: ScriptedRequest[] = [];
  const fetch: FetchLike = async (url: string, init: HttpRequestInit) => {
    const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
    const voiceId = decodeURIComponent(/\/text-to-speech\/([^/]+)\//.exec(url)?.[1] ?? "");
    requests.push({ url, voiceId, headers: init.headers, body });

    const scripted = queue.shift();
    if (scripted !== undefined && "thrown" in scripted) {
      throw scripted.thrown;
    }
    const answer = scripted ?? answerFromRecordings(recordings, body.text);
    return {
      ok: answer.status >= 200 && answer.status <= 299,
      status: answer.status,
      json: async () => answer.body,
      text: async () => JSON.stringify(answer.body),
    };
  };
  return { fetch, requests };
}

function answerFromRecordings(
  recordings: readonly RecordedSpeech[],
  text: unknown,
): { status: number; body: unknown } {
  const recording = recordings.find((candidate) => candidate.text === text);
  return recording === undefined
    ? {
        status: 400,
        body: { detail: { status: "unrecorded", message: `nothing recorded for ${String(text)}` } },
      }
    : { status: 200, body: recording.body };
}

/** The real client, talking to a scripted service with {@link TEST_API_KEY}. */
export function scriptedClient(service: ScriptedService): ElevenLabsClient {
  return new ElevenLabsClient({ apiKey: TEST_API_KEY, fetch: service.fetch });
}

/** What the platform `fetch` throws when `AbortSignal.timeout()` fires. */
export function timeoutError(): Error {
  const error = new Error("The operation was aborted due to timeout");
  error.name = "TimeoutError";
  return error;
}
