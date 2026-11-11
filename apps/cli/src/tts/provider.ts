/**
 * The speech providers this build can narrate with, and the one rule that admits a provider at all.
 *
 * **A provider is admissible only if it returns word or character timestamps with its audio.**
 * `timings.json` — the document every scene duration is measured against — and `captions.json` are
 * both built from *measured* spans: `planSegments` places silence and caption changes on the gaps
 * between words, and `buildCaptions` shows each word for exactly as long as it was spoken. A
 * provider that answers with audio alone would force one of two things, and this module refuses
 * both: estimating the spans (the dry run's job, and labelled as such), or a forced aligner bolted
 * on after the fact (a second model, a second set of failure modes, and timings that are a guess
 * about audio rather than a fact from the engine that made it).
 *
 * So the rule is enforced twice, and both points are here:
 *
 * - **At declaration.** Every entry of {@link TTS_PROVIDERS} says what it returns with its audio,
 *   and {@link admitProvider} refuses one that returns nothing. It runs over the whole registry when
 *   this module loads, so a provider declared with `timestamps: "none"` cannot ship — the build's
 *   first import of this file throws, and the registry test asserts it. That is also why
 *   {@link parseProviderId}'s refusal states the rule: a user who names a provider this build does
 *   not know reads *why* the list is short, not just that it is.
 * - **At run time.** A declaration is a promise, and a remote service can break it on any request:
 *   ElevenLabs documents its `alignment` as optional and nullable. {@link requireWordSpans} wraps a
 *   remote provider's synthesiser and refuses a segment that has letters or digits in it and came
 *   back with no spans, rather than letting `planSegments` lay out a segment with no words in it —
 *   which it would do quietly, and the captions would simply be missing.
 *
 * **Only remote providers are wrapped (spec §11 C10).** A Kokoro server that answers with zero
 * spans is accepted exactly as it was before this module existed. Tightening that is a separate
 * decision with its own blast radius — every Kokoro deployment in the field — and ADR 0030 records
 * that it was deliberately not taken here.
 *
 * **The provider is the owner's choice and never an agent's.** Nothing in this directory reads a
 * tool call: the provider, the model and the key come from `<state>/config.json`,
 * `<state>/credentials.json` and two environment variables (`./resolve.ts`), and the one thing a
 * narration may still choose is the voice, among those on an account the owner already enabled.
 */

import type { SpeechSynthesiser } from "@xplainer/render-core";
import type { CaptionedSpeechRequest, CaptionedSpeechResponse } from "@xplainer/tts-client";

/** Every provider this build knows, in the order a refusal lists them. */
export const TTS_PROVIDER_IDS = ["kokoro", "elevenlabs"] as const;

/** One of {@link TTS_PROVIDER_IDS}. */
export type TtsProviderId = (typeof TTS_PROVIDER_IDS)[number];

/** The provider a machine nobody configured narrates with: the built-in Kokoro voice. */
export const DEFAULT_TTS_PROVIDER: TtsProviderId = "kokoro";

/** What a provider returns beside its audio. `"none"` is the value {@link admitProvider} refuses. */
export type TimestampGranularity = "word" | "character" | "none";

/** One provider, described by the three facts the rest of the product decides on. */
export type TtsProviderDescriptor = {
  readonly id: string;
  /** What the provider returns with its audio — the fact admissibility is decided on. */
  readonly timestamps: TimestampGranularity;
  /** Narration text leaves this machine. Decides whether {@link requireWordSpans} applies. */
  readonly remote: boolean;
  /** The owner pays per character. Decides whether the job log says how many were sent. */
  readonly billed: boolean;
};

/**
 * The registry. A new provider is one entry here, with an honest `timestamps`, plus a branch in
 * `workers/speech.ts`'s `resolveSpeech()` — `apps/cli/AGENTS.md` carries the recipe.
 *
 * Kokoro is declared `"word"` and local for all three of its routes — the in-process engine, a
 * Kokoro-FastAPI server and a fixture directory — because the route is how Kokoro is reached, not
 * which provider it is. A Kokoro-FastAPI server somebody named may well be on another machine; it
 * is still the voice the owner installed rather than a service billing an account, and the
 * provider level above the routes exists for exactly that difference.
 */
export const TTS_PROVIDERS: Readonly<Record<TtsProviderId, TtsProviderDescriptor>> = {
  kokoro: { id: "kokoro", timestamps: "word", remote: false, billed: false },
  elevenlabs: { id: "elevenlabs", timestamps: "character", remote: true, billed: true },
};

/** Which refusal this is, for a caller — or a test — that branches rather than logs. */
export type TtsProviderErrorCode =
  /** A provider name outside {@link TTS_PROVIDER_IDS}. */
  | "PROVIDER_UNKNOWN"
  /** A descriptor that declares no timestamps. */
  | "PROVIDER_INADMISSIBLE"
  /** `config.json` or `credentials.json` exists and cannot be used, or holds an invalid setting. */
  | "CONFIG_UNREADABLE"
  /** The provider needs an API key and neither the environment nor `credentials.json` has one. */
  | "CREDENTIAL_MISSING"
  /** The narration's `voice` is not one this provider can speak with. */
  | "VOICE_UNSUPPORTED"
  /** The narration's `speed` is outside what this provider accepts. */
  | "SPEED_UNSUPPORTED"
  /** Audio came back with no usable timings. */
  | "TIMESTAMPS_MISSING"
  /** The words the provider timed are not the words it was sent. */
  | "ALIGNMENT_MISMATCH"
  /** A word is timed to start after the audio it belongs to has ended. */
  | "ALIGNMENT_OUT_OF_BOUNDS"
  /** The audio is empty, not whole 16-bit samples, or the answer could not be read at all. */
  | "AUDIO_UNUSABLE"
  /** The provider answered with an HTTP error. */
  | "PROVIDER_REJECTED"
  /** No answer came back at all: a timeout or a transport failure. Never retried (spec §11 C8). */
  | "PROVIDER_UNREACHABLE";

/**
 * A narration that cannot be spoken as configured, said in words for the job log.
 *
 * Raised from configuration time through to the last segment, and every one of them is a failed
 * narration job — never a quiet switch to another provider. A video in a different voice than the
 * owner chose, with nothing in the log to say so, is the failure this class exists to prevent.
 */
export class TtsProviderError extends Error {
  /** Which refusal this is. */
  readonly code: TtsProviderErrorCode;

  constructor(code: TtsProviderErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TtsProviderError";
    this.code = code;
  }
}

/** The admissibility rule, as the one sentence every refusal of a provider ends with. */
export const PROVIDER_ADMISSIBILITY_RULE =
  "A provider is admissible only if it returns word or character timestamps with its audio.";

/** Whether `value` names a provider this build knows. */
export function isTtsProviderId(value: string): value is TtsProviderId {
  return (TTS_PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * Why `value` is not a provider, in the words `xplainer config set` and a failed narration share.
 *
 * Exported so `config/keys.ts` can refuse a mistyped `tts.provider` with this exact sentence: a
 * user reads the same explanation at the keyboard as in the log of a narration that failed later.
 */
export function unknownProviderProblem(value: string): string {
  // Printed by `config set`, `config get`, `status` and the job log, so a key pasted or exported
  // under the wrong name is described rather than repeated. Every ElevenLabs key begins `sk_`.
  const named = value.startsWith("sk_")
    ? "a value beginning sk_ (an API key? it is not repeated here)"
    : `"${value}"`;
  return (
    `speech provider ${named} is not one this build knows. Admissible providers: ` +
    `${TTS_PROVIDER_IDS.join(", ")}. ${PROVIDER_ADMISSIBILITY_RULE}`
  );
}

/**
 * Refuse a descriptor that returns no timestamps with its audio.
 *
 * @throws {TtsProviderError} `PROVIDER_INADMISSIBLE`
 */
export function admitProvider(descriptor: TtsProviderDescriptor): void {
  if (descriptor.timestamps === "none") {
    throw new TtsProviderError(
      "PROVIDER_INADMISSIBLE",
      `speech provider "${descriptor.id}" returns no timestamps with its audio, and timings.json ` +
        `and captions.json are built from measured word spans. ${PROVIDER_ADMISSIBILITY_RULE}`,
    );
  }
}

for (const descriptor of Object.values(TTS_PROVIDERS)) {
  admitProvider(descriptor);
}

/**
 * Read a provider name, or refuse it with the admissibility sentence and where it was read from.
 *
 * @param where the setting that held it — an environment variable's name, or a file and key — so a
 *   refusal at narration time says which of the two places to correct.
 * @throws {TtsProviderError} `PROVIDER_UNKNOWN`
 */
export function parseProviderId(value: string, where: string): TtsProviderId {
  if (isTtsProviderId(value)) {
    return value;
  }
  throw new TtsProviderError(
    "PROVIDER_UNKNOWN",
    `${unknownProviderProblem(value)} It was read from ${where}.`,
  );
}

/** Whether `text` holds something a voice speaks: a letter or a digit, in any script. */
const SPOKEN = /[\p{L}\p{N}]/u;

/** The longest excerpt of a segment a refusal quotes. */
const EXCERPT_LIMIT = 80;

/** A segment's text, short enough to quote in a log line. */
export function segmentExcerpt(text: string): string {
  return text.length > EXCERPT_LIMIT ? `${text.slice(0, EXCERPT_LIMIT)}…` : text;
}

/**
 * Wrap a remote provider's synthesiser so a segment with words in it cannot come back without them.
 *
 * Text made only of punctuation — a free-standing `"—"`, an ellipsis — may come back with no spans
 * and passes: there is no word to caption. Anything with a letter or a digit may not.
 *
 * @throws {TtsProviderError} `TIMESTAMPS_MISSING`, from the returned synthesiser
 */
export function requireWordSpans(
  inner: SpeechSynthesiser,
  provider: TtsProviderId,
): SpeechSynthesiser {
  return {
    async captionedSpeech(request: CaptionedSpeechRequest): Promise<CaptionedSpeechResponse> {
      const response = await inner.captionedSpeech(request);
      if (response.timestamps.length === 0 && SPOKEN.test(request.text)) {
        throw new TtsProviderError(
          "TIMESTAMPS_MISSING",
          `${provider} returned audio with no word timings for segment ` +
            `"${segmentExcerpt(request.text)}". Timings and captions are built from them, so the ` +
            "audio was discarded.",
        );
      }
      return response;
    },
  };
}
