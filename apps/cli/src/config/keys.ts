/**
 * The settings `xplainer config` knows, what each one admits, and which file it lives in.
 *
 * There are four, and the list is closed on purpose: a key nobody declared here is refused by
 * `config set` rather than written, because a setting that is stored and read by nothing is a
 * setting a user believes they changed. Each one is declared once, with its default, its
 * validation and whether it is a **secret** — and that last flag is the whole routing rule: a
 * secret lives in `credentials.json` and nowhere else, everything else in `config.json`, so the
 * non-secret file never holds a value that would need redacting (spec D2).
 *
 * **What a value may be is decided here, before anything is written.** The narration worker
 * re-checks what it reads, because a person can edit either file by hand, but a value refused at
 * `config set` is a mistake caught at the keyboard instead of in the log of a narration job that
 * failed minutes later.
 *
 * **The provider check is `tts/provider.ts`'s, not a copy of it.** That module owns the registry of
 * admissible providers, and `tts.provider` is refused with its `unknownProviderProblem` sentence, so
 * a user who mistypes a provider at `config set` and one whose narration names an unknown provider
 * read the same explanation — and a provider added there is accepted here with no second edit.
 */

import { isTtsProviderId, unknownProviderProblem } from "../tts/provider.js";

/** A setting `xplainer config` reads and writes. */
export type ConfigKey =
  | "tts.provider"
  | "tts.elevenlabs.voice"
  | "tts.elevenlabs.model"
  | "tts.elevenlabs.api_key";

/** One setting: its name, where it lives, what it defaults to, and what it admits. */
export type ConfigKeySpec = {
  /** The dotted name, which is also the path to the value inside its file. */
  key: ConfigKey;
  /** What the setting is, in the words a prompt or a refusal uses. */
  label: string;
  /** A secret lives in `credentials.json`, is never printed, and is never accepted on argv. */
  secret: boolean;
  /** What applies when neither the environment nor a file supplies a value. */
  defaultValue: string | null;
  /**
   * The environment variable that overrides this setting for one process, or `null` for none.
   *
   * It overrides only the process it is set in. A supervised daemon does not inherit a shell, which
   * is why `config list` names this origin rather than letting a shell export pass for a setting.
   */
  environment: string | null;
  /**
   * Why `value` is not admissible, or `null` when it is.
   *
   * For a secret the answer never quotes the value: it is printed, and a refusal that echoed the
   * key would put it in the scrollback the refusal exists to keep it out of.
   */
  validate(value: string): string | null;
};

/**
 * The ElevenLabs models measured to return character timestamps from `with-timestamps`.
 *
 * Measured live on 2026-11-11 (spec §11): each returned a non-null `alignment` whose characters,
 * joined, equal the text that was sent. Any other well-formed model id is still accepted —
 * ElevenLabs adds models faster than this list can — and `config set` says that it is outside
 * the measured set; a model that then answers without timestamps fails its narration by name.
 */
export const ELEVENLABS_VERIFIED_MODELS: readonly string[] = [
  "eleven_multilingual_v2",
  "eleven_flash_v2_5",
  "eleven_v4",
];

/**
 * An ElevenLabs voice id: twenty letters and digits.
 *
 * Declared here, beside the setting it validates, and re-exported by `tts/resolve.ts`, so the
 * pattern `config set` admits and the one the narration worker maps a requested voice by are one.
 */
export const ELEVENLABS_VOICE_ID: RegExp = /^[A-Za-z0-9]{20}$/;

/** An ElevenLabs model id as the service spells them: lowercase, digits and underscores. */
const ELEVENLABS_MODEL_ID = /^[a-z0-9_]{1,64}$/;

/** The longest API key accepted. Longer than any key ElevenLabs issues, and short of absurd. */
const API_KEY_MAX_LENGTH = 256;

function validateProvider(value: string): string | null {
  return isTtsProviderId(value) ? null : unknownProviderProblem(value);
}

/**
 * `value` in quotes, or a description of it when it may be an API key.
 *
 * A refusal is printed, and an ElevenLabs key pasted under the wrong setting is a mistake a person
 * actually makes. Every ElevenLabs key begins `sk_`; nothing this module admits does.
 */
function quoted(value: string): string {
  return value.startsWith("sk_")
    ? "a value beginning sk_ (an API key? it is not repeated here)"
    : `"${value}"`;
}

function validateVoice(value: string): string | null {
  return ELEVENLABS_VOICE_ID.test(value)
    ? null
    : `${quoted(value)} is not an ElevenLabs voice id: a voice id is 20 letters and digits, ` +
        "such as JBFqnCBsd6RMkjVDRZzb.";
}

/**
 * A model id is lowercase letters, digits and underscores — and so, character for character, is an
 * ElevenLabs API key (`sk_` and 48 hex digits). Without the `sk_` refusal a key pasted under
 * `tts.elevenlabs.model` would be admitted, written to `config.json` and printed by `config list`.
 */
function validateModel(value: string): string | null {
  return ELEVENLABS_MODEL_ID.test(value) && !value.startsWith("sk_")
    ? null
    : `${quoted(value)} is not an ElevenLabs model id: a model id is 1 to 64 lowercase letters, ` +
        "digits and underscores, such as eleven_multilingual_v2.";
}

/** Never quotes the value, for the reason {@link ConfigKeySpec.validate} gives. */
function validateApiKey(value: string): string | null {
  if (value === "") {
    return "the API key is empty.";
  }
  if (/\s/u.test(value)) {
    return "the API key contains whitespace, which no API key does; it was probably pasted with something else.";
  }
  if (value.length > API_KEY_MAX_LENGTH) {
    return `the API key is ${String(value.length)} characters long, and no API key is longer than ${String(API_KEY_MAX_LENGTH)}.`;
  }
  return null;
}

/** Every setting, in the order `config list` prints them. */
export const CONFIG_KEYS: readonly ConfigKeySpec[] = [
  {
    key: "tts.provider",
    label: "speech provider",
    secret: false,
    defaultValue: "kokoro",
    environment: "XPLAINER_TTS_PROVIDER",
    validate: validateProvider,
  },
  {
    key: "tts.elevenlabs.voice",
    label: "ElevenLabs voice id",
    secret: false,
    defaultValue: "JBFqnCBsd6RMkjVDRZzb",
    environment: null,
    validate: validateVoice,
  },
  {
    key: "tts.elevenlabs.model",
    label: "ElevenLabs model id",
    secret: false,
    defaultValue: "eleven_multilingual_v2",
    environment: null,
    validate: validateModel,
  },
  {
    key: "tts.elevenlabs.api_key",
    label: "ElevenLabs API key",
    secret: true,
    defaultValue: null,
    environment: "ELEVENLABS_API_KEY",
    validate: validateApiKey,
  },
];

/** The declaration for `name`, or `undefined` for a name that is not a setting. */
export function findConfigKey(name: string): ConfigKeySpec | undefined {
  return CONFIG_KEYS.find((spec) => spec.key === name);
}

/** The declaration for a key the type system already knows is one. */
export function configKeySpec(key: ConfigKey): ConfigKeySpec {
  const spec = findConfigKey(key);
  if (spec === undefined) {
    throw new Error(`${key} is a ConfigKey with no entry in CONFIG_KEYS`);
  }
  return spec;
}
