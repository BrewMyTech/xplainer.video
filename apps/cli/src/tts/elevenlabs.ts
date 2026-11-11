/**
 * ElevenLabs behind render-core's `SpeechSynthesiser` port: one segment in, a WAV and word spans out.
 *
 * `@xplainer/tts-client` does the wire — the body, the one request, the error body, the alignment
 * conversion — and stops there on purpose. This module owns the four things that need either
 * render-core or the job:
 *
 * 1. **The narration's choices, checked before anything is billed.** `voice` and `speed` arrive on
 *    every request because render-core's `speechRequest()` fills them in, so the refusals happen on
 *    the first segment and with **zero** requests sent. Spec §11 C3 fixes the voice rule: omitted
 *    or render-core's default `af_heart` means the voice the owner configured; a 20-character
 *    ElevenLabs id is used as given; anything else — `af_bella`, a Kokoro blend — is refused
 *    (`VOICE_UNSUPPORTED`) rather than substituted, because a script that names a voice meant
 *    *that* voice, and speaking it in another one silently is a decision nobody made. `speed` is
 *    sent only inside 0.7–1.2, the range ElevenLabs documents, and refused outside it; `1` sends
 *    nothing at all. `langCode` is Kokoro's vocabulary and is not sent: the default model refuses
 *    `language_code`, and it infers the language from the text anyway. The job log says so once.
 *
 * 2. **Retries, and only the ones that cannot double-bill (spec §11 C8).** `429` and `5xx` are the
 *    service asking to be asked again: up to {@link ELEVENLABS_MAX_RETRIES} more attempts, waiting
 *    1 s and then 4 s, each one a log line. A **timeout or a transport error is never retried**: the
 *    request may have been spoken and billed on their side while the answer was lost on ours, and
 *    repeating it would pay twice for one segment. The refusal says so and says to re-run
 *    `explainer_narrate`, which is the owner's decision to pay again rather than this module's.
 *    Nothing else is retried either — a `401` is not going to start working on the third try.
 *
 * 3. **The answer, checked against what was sent and against itself.** `pcm_24000` is raw signed
 *    16-bit mono, so an empty or odd-length body is refused (`AUDIO_UNUSABLE`). The alignment
 *    becomes word spans through `alignmentToWordTimestamps`, and then:
 *    - its whitespace-separated tokens must **equal** the sent text's (`ALIGNMENT_MISMATCH`, naming
 *      the first difference). Captions must show the script; a service that dropped or rewrote a
 *      character would otherwise caption words nobody wrote, or lose one silently.
 *    - every word must lie within the audio (spec §11 C6). The service's alignment can run **past**
 *      its own audio — measured at 4.88 s of alignment over 4.80 s of `eleven_v4` audio — so with
 *      `D` the decoded duration, a word whose start is at or after `D` is refused
 *      (`ALIGNMENT_OUT_OF_BOUNDS`: it would be captioned over silence that was never spoken), and
 *      any other word's end is clamped to `D`. Only here can that be done: the alignment conversion
 *      is pure and never sees the audio.
 *
 * 4. **The port's envelope.** The PCM is wrapped with render-core's own `encodeWav` as 24 kHz mono
 *    16-bit — exactly `DEFAULT_SAMPLE_RATE` and what every Kokoro route returns — so `decodeWav`,
 *    `reconcileFormat`, `planSegments`, `buildCaptions` and `buildTimings` see nothing new.
 *
 * **The key never leaves through here.** The client already keeps it out of its own messages; every
 * message this module composes or passes on goes through the injected `redact` as well, so a key
 * that turns up in some other error's text is replaced with `[redacted]` before it can reach the job
 * log. There is no fallback to Kokoro anywhere in this file: every failure is a failed narration.
 */

import process from "node:process";
import {
  DEFAULT_VOICE,
  encodeWav,
  type PcmFormat,
  type SpeechSynthesiser,
} from "@xplainer/render-core";
import {
  alignmentToWordTimestamps,
  type CaptionedSpeechRequest,
  type CaptionedSpeechResponse,
  ELEVENLABS_SAMPLE_RATE,
  type ElevenLabsClient,
  ElevenLabsError,
  type ElevenLabsSpeech,
  type ElevenLabsSpeechRequest,
  type WordTimestamp,
} from "@xplainer/tts-client";
import { segmentExcerpt, TtsProviderError } from "./provider.js";
import { ELEVENLABS_VOICE_ID } from "./resolve.js";

/** How many times a `429` or `5xx` is asked again, so a segment costs at most three requests. */
export const ELEVENLABS_MAX_RETRIES = 2;

/** How long to wait before each retry, in milliseconds: 1 s, then 4 s. */
export const ELEVENLABS_RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000];

/** The slowest speed ElevenLabs documents. */
export const ELEVENLABS_MIN_SPEED = 0.7;

/** The fastest speed ElevenLabs documents. */
export const ELEVENLABS_MAX_SPEED = 1.2;

/** What `pcm_24000` is, as render-core spells a PCM format. */
const PCM_FORMAT: PcmFormat = { channels: 1, sampleWidth: 2, sampleRate: ELEVENLABS_SAMPLE_RATE };

/** Options for {@link createElevenLabsSynthesiser}. Everything with a side effect is injectable. */
export type ElevenLabsSynthesiserOptions = {
  /** The wire client. Only `timestampedSpeech` is used, so a test can pass a fake. */
  readonly client: Pick<ElevenLabsClient, "timestampedSpeech">;
  /** The configured voice: what a narration that names none, or names `af_heart`, is spoken in. */
  readonly voice: string;
  /** The configured model id. */
  readonly model: string;
  /** Where a log line goes. Defaults to stdout, which is the narration job's log tail. */
  readonly log?: (line: string) => void;
  /** How to wait between retries. Injectable so a test does not wait five seconds. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Replaces the API key in any text with `[redacted]`. Defaults to returning the text unchanged. */
  readonly redact?: (text: string) => string;
};

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The voice id to send, or the refusal C3 calls for. */
function chooseVoice(requested: string | undefined, configured: string): string {
  if (requested === undefined || requested === DEFAULT_VOICE) {
    return configured;
  }
  if (ELEVENLABS_VOICE_ID.test(requested)) {
    return requested;
  }
  throw new TtsProviderError(
    "VOICE_UNSUPPORTED",
    `voice "${requested}" is not an ElevenLabs voice id. This machine speaks with ElevenLabs ` +
      `(voice ${configured}). Omit "voice" to use it, or pass a 20-character ElevenLabs voice id.`,
  );
}

/** The speed to send — `undefined` for `1`, which sends no `voice_settings` — or a refusal. */
function chooseSpeed(requested: number | undefined): number | undefined {
  if (requested === undefined || requested === 1) {
    return undefined;
  }
  if (
    Number.isFinite(requested) &&
    requested >= ELEVENLABS_MIN_SPEED &&
    requested <= ELEVENLABS_MAX_SPEED
  ) {
    return requested;
  }
  throw new TtsProviderError(
    "SPEED_UNSUPPORTED",
    `narration speed ${requested} is outside what ElevenLabs accepts ` +
      `(${ELEVENLABS_MIN_SPEED} to ${ELEVENLABS_MAX_SPEED}). Set "speed" inside that range, or omit ` +
      "it to speak at 1. Nothing was sent.",
  );
}

/** `401 invalid_api_key`, or just `503` when the body carried no code. */
function statusLabel(error: ElevenLabsError): string {
  const status = error.status === undefined ? "" : String(error.status);
  return [status, error.code ?? ""].filter((part) => part !== "").join(" ");
}

/** Which setting to change for a `4xx` that names a voice or a model. */
function settingHint(error: ElevenLabsError): string {
  const code = error.code ?? "";
  if (code.includes("voice")) {
    return (
      "The voice is tts.elevenlabs.voice (`xplainer config set tts.elevenlabs.voice <id>`), " +
      'unless the narration\'s "voice" names another.'
    );
  }
  if (code.includes("model")) {
    return "The model is tts.elevenlabs.model (`xplainer config set tts.elevenlabs.model <id>`).";
  }
  return "`xplainer config list` shows the voice and model this machine sends.";
}

/** Turn the client's error into the job log's sentence, after `attempts` requests. */
function refusal(error: ElevenLabsError, text: string, attempts: number): TtsProviderError {
  const options = { cause: error };
  switch (error.code) {
    case "alignment_missing":
    case "alignment_invalid":
      return new TtsProviderError(
        "TIMESTAMPS_MISSING",
        `elevenlabs returned audio with no usable character timings for segment ` +
          `"${segmentExcerpt(text)}". Timings and captions are built from them, so the audio was ` +
          `discarded. (${error.message})`,
        options,
      );
    case "audio_missing":
    case "response_invalid":
      return new TtsProviderError("AUDIO_UNUSABLE", error.message, options);
    case "timeout":
    case "network":
      return new TtsProviderError(
        "PROVIDER_UNREACHABLE",
        `${error.message} It was not retried, because a request that went unanswered may still ` +
          "have been spoken and billed; re-run explainer_narrate to try again.",
        options,
      );
    default:
      break;
  }

  const label = statusLabel(error);
  if (error.status === 402 || (error.status === 401 && error.code === "quota_exceeded")) {
    return new TtsProviderError(
      "PROVIDER_REJECTED",
      `the ElevenLabs account has no credits left (${label}). Segments already spoken in this run ` +
        "were billed; nothing was written.",
      options,
    );
  }
  // A key ElevenLabs cannot parse is a `400 invalid_api_key`, not a `401` — measured live on
  // 2026-11-11 with a malformed key — so the code decides this as well as the status does.
  if (error.status === 401 || error.code === "invalid_api_key") {
    return new TtsProviderError(
      "PROVIDER_REJECTED",
      `elevenlabs refused the API key (${label}). Replace it with ` +
        "`xplainer config set tts.elevenlabs.api_key`.",
      options,
    );
  }
  if (error.retryable) {
    return new TtsProviderError(
      "PROVIDER_REJECTED",
      `elevenlabs was still refusing after ${attempts} attempts; the last answer was ${label}. ` +
        `${error.message}`,
      options,
    );
  }
  return new TtsProviderError(
    "PROVIDER_REJECTED",
    `${error.message} ${settingHint(error)}`,
    options,
  );
}

/** Send one request, asking again only for a `429` or a `5xx`. */
async function speakWithRetries(
  client: Pick<ElevenLabsClient, "timestampedSpeech">,
  request: ElevenLabsSpeechRequest,
  log: (line: string) => void,
  sleep: (ms: number) => Promise<void>,
): Promise<ElevenLabsSpeech> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await client.timestampedSpeech(request);
    } catch (error) {
      if (!(error instanceof ElevenLabsError)) {
        throw error;
      }
      if (!error.retryable || attempt > ELEVENLABS_MAX_RETRIES) {
        throw refusal(error, request.text, attempt);
      }
      const delay =
        ELEVENLABS_RETRY_DELAYS_MS[attempt - 1] ??
        ELEVENLABS_RETRY_DELAYS_MS[ELEVENLABS_RETRY_DELAYS_MS.length - 1] ??
        0;
      log(
        `[xplainer] elevenlabs answered ${statusLabel(error)}; asking again in ` +
          `${delay / 1000} s (attempt ${attempt + 1} of ${ELEVENLABS_MAX_RETRIES + 1})`,
      );
      await sleep(delay);
    }
  }
}

/** The text's whitespace-separated tokens, which is how the alignment is split into words. */
function tokens(text: string): string[] {
  return text.split(/\s+/u).filter((token) => token !== "");
}

/** Refuse spans whose words are not the words that were sent (spec D6, §11 C11a). */
function requireSameWords(words: readonly WordTimestamp[], text: string): void {
  const sent = tokens(text);
  const timed = words.map((word) => word.word);
  const length = Math.max(sent.length, timed.length);
  for (let index = 0; index < length; index += 1) {
    if (sent[index] !== timed[index]) {
      const said = (token: string | undefined): string =>
        token === undefined ? "nothing" : `"${token}"`;
      throw new TtsProviderError(
        "ALIGNMENT_MISMATCH",
        `elevenlabs timed different words than it was sent: word ${index + 1} was sent as ` +
          `${said(sent[index])} and timed as ${said(timed[index])}. Captions must show the ` +
          "script, so the audio was discarded.",
      );
    }
  }
}

/** Refuse a word that starts after the audio ends, and clamp one that runs past it (§11 C6). */
function boundToAudio(words: readonly WordTimestamp[], seconds: number): WordTimestamp[] {
  return words.map((word) => {
    if (word.start_time >= seconds) {
      throw new TtsProviderError(
        "ALIGNMENT_OUT_OF_BOUNDS",
        `elevenlabs timed "${word.word}" at ${word.start_time}–${word.end_time} s, but the audio ` +
          `it returned is ${seconds} s long, so the word would be captioned over silence that was ` +
          "never spoken. The audio was discarded.",
      );
    }
    return word.end_time > seconds ? { ...word, end_time: seconds } : word;
  });
}

/** Check one answer and wrap it in the port's envelope. */
function toPortResponse(speech: ElevenLabsSpeech, text: string): CaptionedSpeechResponse {
  const pcm = Buffer.from(speech.audio, "base64");
  if (pcm.length === 0) {
    throw new TtsProviderError(
      "AUDIO_UNUSABLE",
      `elevenlabs returned no audio for segment "${segmentExcerpt(text)}".`,
    );
  }
  if (pcm.length % PCM_FORMAT.sampleWidth !== 0) {
    throw new TtsProviderError(
      "AUDIO_UNUSABLE",
      `elevenlabs returned ${pcm.length} bytes of audio for segment "${segmentExcerpt(text)}", an ` +
        "odd count, which cannot be whole 16-bit samples.",
    );
  }

  let words: WordTimestamp[];
  try {
    words = alignmentToWordTimestamps(speech.alignment);
  } catch (error) {
    if (error instanceof ElevenLabsError) {
      throw refusal(error, text, 1);
    }
    throw error;
  }
  requireSameWords(words, text);

  const seconds = pcm.length / PCM_FORMAT.sampleWidth / PCM_FORMAT.sampleRate;
  return {
    audio: encodeWav({ format: PCM_FORMAT, data: pcm }).toString("base64"),
    timestamps: boundToAudio(words, seconds),
  };
}

/** The same error with the key taken out of its message, keeping its code and cause. */
function redacted(error: unknown, redact: (text: string) => string): unknown {
  if (error instanceof TtsProviderError) {
    const message = redact(error.message);
    return message === error.message
      ? error
      : new TtsProviderError(error.code, message, { cause: error.cause });
  }
  if (error instanceof Error) {
    const message = redact(error.message);
    return message === error.message ? error : new Error(message);
  }
  return new Error(redact(String(error)));
}

/**
 * A `SpeechSynthesiser` that speaks through ElevenLabs.
 *
 * Wrap it in `requireWordSpans` before use, as `resolveSpeech()` does: that is the run-time half of
 * the admissibility rule, and applies to every remote provider whatever its adapter checks.
 */
export function createElevenLabsSynthesiser(
  options: ElevenLabsSynthesiserOptions,
): SpeechSynthesiser {
  const log = options.log ?? writeLine;
  const sleep = options.sleep ?? wait;
  const redact = options.redact ?? ((text: string): string => text);
  let languageNoted = false;
  let voiceNoted = false;

  return {
    async captionedSpeech(request: CaptionedSpeechRequest): Promise<CaptionedSpeechResponse> {
      try {
        const voiceId = chooseVoice(request.voice, options.voice);
        const speed = chooseSpeed(request.speed);
        // The first log line names the configured voice; a narration that names its own says so,
        // once, so the log never claims a voice that did not speak.
        if (voiceId !== options.voice && !voiceNoted) {
          voiceNoted = true;
          log(
            `[xplainer] the narration names voice ${voiceId}, which speaks instead of ${options.voice}`,
          );
        }
        if (request.langCode !== undefined && !languageNoted) {
          languageNoted = true;
          log(
            `[xplainer] langCode "${request.langCode}" is a Kokoro language code and was not sent ` +
              "to elevenlabs, which infers the language from the text",
          );
        }
        const speech = await speakWithRetries(
          options.client,
          {
            text: request.text,
            voiceId,
            modelId: options.model,
            ...(speed === undefined ? {} : { speed }),
          },
          (line) => log(redact(line)),
          sleep,
        );
        return toPortResponse(speech, request.text);
      } catch (error) {
        throw redacted(error, redact);
      }
    },
  };
}
