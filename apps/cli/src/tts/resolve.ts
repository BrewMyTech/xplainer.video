/**
 * Which speech provider this machine narrates with, and with what — without the secret.
 *
 * Two callers, and that is why this is its own module: the narration worker (`workers/speech.ts`),
 * which then builds the provider, and `xplainer status`, which prints what was chosen. Both need
 * the same answer, so both ask the same function — a status line computed by a second reading of
 * the same files is a status line that can disagree with the job log. One difference remains, and
 * it is the environment rather than the files: `status` reads its own shell's, the worker reads the
 * daemon's. `status` says when its shell sets one of the two variables; a variable that only the
 * daemon's supervisor sets is invisible to it.
 *
 * **The precedence is the provider first, then everything else (spec D1, §11 C1).**
 *
 * ```
 * provider = XPLAINER_TTS_PROVIDER  -> config.json tts.provider  -> "kokoro"
 * elevenlabs: voice = config.json tts.elevenlabs.voice -> JBFqnCBsd6RMkjVDRZzb
 *             model = config.json tts.elevenlabs.model -> eleven_multilingual_v2
 *             key   = ELEVENLABS_API_KEY -> credentials.json tts.elevenlabs.api_key
 * ```
 *
 * `XPLAINER_TTS_FIXTURE` sits above all of it and is `workers/speech.ts`'s, because a fixture is a
 * test environment rather than a provider; and inside `kokoro` the route chain
 * (`XPLAINER_TTS_URL`/`KOKORO_URL`, then the in-process engine, then the tts-client's default) is
 * also `workers/speech.ts`'s and untouched. A Kokoro URL in the environment **never** beats a
 * configured provider: it is a route setting, and a stale `KOKORO_URL` in a shell profile would
 * otherwise silently undo `config set tts.provider elevenlabs`.
 *
 * **`ELEVENLABS_API_KEY` never selects the provider.** It supplies the key once the provider is
 * already `elevenlabs`, and nothing else. A developer who exported it for some other tool must not
 * find every narration on the machine quietly billed to that account.
 *
 * **An unreadable file is a refusal, not a default.** `config.json` that does not parse, or that
 * holds a setting this build would refuse at `config set`, is `CONFIG_UNREADABLE` — never "no
 * config", which for `tts.provider` would mean a narration in a different voice than the owner
 * chose. A person can edit either file by hand, which is why each value is checked again here with
 * the same validation `config set` applies (`config/keys.ts`).
 *
 * **The key.** {@link resolveTtsSelection} says only *where* a key is, never what it is, so a
 * command that prints can call it. {@link readElevenLabsApiKey} is the one function that returns the
 * value, and it is called by the narration worker and by nothing that prints.
 */

import { readCredential } from "../config/credentials.js";
import { type ConfigKey, configKeySpec } from "../config/keys.js";
import {
  readUserConfigValue,
  StateDocumentUnreadableError,
  userConfigPath,
} from "../config/user-config.js";
import {
  DEFAULT_TTS_PROVIDER,
  parseProviderId,
  TtsProviderError,
  type TtsProviderId,
} from "./provider.js";

export { ELEVENLABS_VERIFIED_MODELS, ELEVENLABS_VOICE_ID } from "../config/keys.js";

/** The environment this module reads, narrowed to what it uses. */
export type TtsEnvironment = Readonly<Record<string, string | undefined>>;

/** A setting's default, which `config/keys.ts` declares once for `config list` and for this. */
function declaredDefault(key: ConfigKey): string {
  const value = configKeySpec(key).defaultValue;
  if (value === null) {
    throw new Error(`${key} declares no default in config/keys.ts`);
  }
  return value;
}

/** The variable that overrides a setting for one process, as `config/keys.ts` declares it. */
function declaredEnvironment(key: ConfigKey): string {
  const variable = configKeySpec(key).environment;
  if (variable === null) {
    throw new Error(`${key} declares no environment variable in config/keys.ts`);
  }
  return variable;
}

/** Overrides `tts.provider` for one process: `XPLAINER_TTS_PROVIDER`. */
export const TTS_PROVIDER_ENV: string = declaredEnvironment("tts.provider");

/** Supplies the ElevenLabs key for one process, once the provider is already `elevenlabs`. */
export const ELEVENLABS_API_KEY_ENV: string = declaredEnvironment("tts.elevenlabs.api_key");

/** "George", the voice ElevenLabs' own quickstart uses; the docs name no default (spec D8). */
export const ELEVENLABS_DEFAULT_VOICE: string = declaredDefault("tts.elevenlabs.voice");

/** The endpoint's documented default model, and the one the docs tie to `speed` (spec D8). */
export const ELEVENLABS_DEFAULT_MODEL: string = declaredDefault("tts.elevenlabs.model");

/** Where a setting came from, as `status` and the job log name it. */
export type SettingOrigin = "environment" | "config" | "credentials" | "default";

/** Where the ElevenLabs key is, when there is one. Never the key itself. */
export type ApiKeyOrigin = "environment" | "credentials";

/** What this machine narrates with. Carries no secret, so a command that prints may hold one. */
export type TtsSelection =
  | { provider: "kokoro"; providerOrigin: SettingOrigin }
  | {
      provider: "elevenlabs";
      providerOrigin: SettingOrigin;
      voice: string;
      voiceOrigin: SettingOrigin;
      model: string;
      modelOrigin: SettingOrigin;
      apiKeyOrigin: ApiKeyOrigin | null;
    };

/** A variable's value, or `undefined` when it is unset or blank — a blank export is not a setting. */
function environmentValue(env: TtsEnvironment, variable: string): string | undefined {
  const value = env[variable]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Run a read of one of the two state files, turning its unreadable-file error into ours.
 *
 * The underlying error is kept as `cause`, so `status` can print the path and the reason on its
 * own line rather than re-parsing a sentence.
 */
function readingStateFile<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof StateDocumentUnreadableError) {
      throw new TtsProviderError(
        "CONFIG_UNREADABLE",
        `${error.path} cannot be read (${error.reason}), so narration will not guess which speech ` +
          "provider to use or how to configure it. Correct the file, or delete it to return every " +
          "setting it holds to its default.",
        { cause: error },
      );
    }
    throw error;
  }
}

/** A non-secret setting from `config.json`, checked as `config set` would have checked it. */
function configuredValue(stateDir: string, key: ConfigKey): string | null {
  const value = readingStateFile(() => readUserConfigValue(stateDir, key));
  if (value === null) {
    return null;
  }
  const problem = configKeySpec(key).validate(value);
  if (problem !== null) {
    throw new TtsProviderError(
      "CONFIG_UNREADABLE",
      `${userConfigPath(stateDir)} sets ${key}, and ${problem} Run \`xplainer config set ${key}\` ` +
        `with a valid value, or \`xplainer config unset ${key}\` for the default.`,
    );
  }
  return value;
}

/** The provider, and which of the three steps chose it. */
function resolveProvider(
  env: TtsEnvironment,
  stateDir: string,
): { provider: TtsProviderId; origin: SettingOrigin } {
  const fromEnvironment = environmentValue(env, TTS_PROVIDER_ENV);
  if (fromEnvironment !== undefined) {
    return { provider: parseProviderId(fromEnvironment, TTS_PROVIDER_ENV), origin: "environment" };
  }
  const fromConfig = readingStateFile(() => readUserConfigValue(stateDir, "tts.provider"));
  if (fromConfig !== null) {
    return {
      provider: parseProviderId(fromConfig, `${userConfigPath(stateDir)} (tts.provider)`),
      origin: "config",
    };
  }
  return { provider: DEFAULT_TTS_PROVIDER, origin: "default" };
}

/** The key and where it was found, for the two exported functions below to share. */
function locateApiKey(
  env: TtsEnvironment,
  stateDir: string,
): { value: string; origin: ApiKeyOrigin } | null {
  const fromEnvironment = environmentValue(env, ELEVENLABS_API_KEY_ENV);
  if (fromEnvironment !== undefined) {
    return { value: fromEnvironment, origin: "environment" };
  }
  const stored = readingStateFile(() => readCredential(stateDir, "tts.elevenlabs.api_key"));
  return stored === null || stored.trim() === ""
    ? null
    : { value: stored.trim(), origin: "credentials" };
}

/**
 * Decide the provider and its settings for a narration run in `stateDir`.
 *
 * Under `kokoro` nothing beyond `tts.provider` is read — neither ElevenLabs setting nor
 * `credentials.json` — so a broken credentials file cannot fail a narration that would never have
 * used it.
 *
 * @throws {TtsProviderError} `PROVIDER_UNKNOWN` or `CONFIG_UNREADABLE`
 */
export function resolveTtsSelection(env: TtsEnvironment, stateDir: string): TtsSelection {
  const { provider, origin } = resolveProvider(env, stateDir);
  if (provider === "kokoro") {
    return { provider, providerOrigin: origin };
  }

  const voice = configuredValue(stateDir, "tts.elevenlabs.voice");
  const model = configuredValue(stateDir, "tts.elevenlabs.model");
  return {
    provider,
    providerOrigin: origin,
    voice: voice ?? ELEVENLABS_DEFAULT_VOICE,
    voiceOrigin: voice === null ? "default" : "config",
    model: model ?? ELEVENLABS_DEFAULT_MODEL,
    modelOrigin: model === null ? "default" : "config",
    apiKeyOrigin: locateApiKey(env, stateDir)?.origin ?? null,
  };
}

/**
 * The ElevenLabs API key, or `null` when neither the environment nor `credentials.json` has one.
 *
 * The only function that returns the key. Called by the narration worker, never by a command that
 * prints — `status` and `config` ask {@link resolveTtsSelection} where the key is instead.
 *
 * @throws {TtsProviderError} `CONFIG_UNREADABLE` for a `credentials.json` that cannot be used
 */
export function readElevenLabsApiKey(env: TtsEnvironment, stateDir: string): string | null {
  return locateApiKey(env, stateDir)?.value ?? null;
}
