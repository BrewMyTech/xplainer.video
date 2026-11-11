/**
 * The four settings, what each admits, and which file each belongs in.
 *
 * Every rule here is asserted through `validate()`, which is what `config set` asks before it writes
 * anything — so a value refused here is a value that never reaches either file.
 */

import { describe, expect, it } from "vitest";
import { CONFIG_KEYS, configKeySpec, ELEVENLABS_VERIFIED_MODELS, findConfigKey } from "./keys.js";

describe("CONFIG_KEYS", () => {
  it("declares exactly the four settings, in the order `config list` prints them", () => {
    expect(CONFIG_KEYS.map((spec) => spec.key)).toEqual([
      "tts.provider",
      "tts.elevenlabs.voice",
      "tts.elevenlabs.model",
      "tts.elevenlabs.api_key",
    ]);
  });

  /** The routing rule: a secret goes to credentials.json, and the API key is the only secret. */
  it("marks the API key, and only the API key, as a secret", () => {
    expect(CONFIG_KEYS.filter((spec) => spec.secret).map((spec) => spec.key)).toEqual([
      "tts.elevenlabs.api_key",
    ]);
  });

  it("defaults to Kokoro, George and eleven_multilingual_v2, and has no default key", () => {
    expect(configKeySpec("tts.provider").defaultValue).toBe("kokoro");
    expect(configKeySpec("tts.elevenlabs.voice").defaultValue).toBe("JBFqnCBsd6RMkjVDRZzb");
    expect(configKeySpec("tts.elevenlabs.model").defaultValue).toBe("eleven_multilingual_v2");
    expect(configKeySpec("tts.elevenlabs.api_key").defaultValue).toBeNull();
  });

  it("names the variables that override a setting per process", () => {
    expect(configKeySpec("tts.provider").environment).toBe("XPLAINER_TTS_PROVIDER");
    expect(configKeySpec("tts.elevenlabs.api_key").environment).toBe("ELEVENLABS_API_KEY");
    expect(configKeySpec("tts.elevenlabs.voice").environment).toBeNull();
    expect(configKeySpec("tts.elevenlabs.model").environment).toBeNull();
  });

  /** Every default must be admissible by its own rule, or a fresh machine starts inadmissible. */
  it("admits every default it declares", () => {
    for (const spec of CONFIG_KEYS) {
      if (spec.defaultValue !== null) {
        expect(spec.validate(spec.defaultValue)).toBeNull();
      }
    }
  });
});

describe("findConfigKey", () => {
  it("answers undefined for a name that is not a setting", () => {
    expect(findConfigKey("tts.kokoro.voice")).toBeUndefined();
    expect(findConfigKey("tts")).toBeUndefined();
  });
});

describe("tts.provider", () => {
  const validate = configKeySpec("tts.provider").validate;

  it("admits kokoro and elevenlabs", () => {
    expect(validate("kokoro")).toBeNull();
    expect(validate("elevenlabs")).toBeNull();
  });

  it("refuses any other name with the admissibility sentence", () => {
    expect(validate("openai")).toBe(
      'speech provider "openai" is not one this build knows. Admissible providers: kokoro, ' +
        "elevenlabs. A provider is admissible only if it returns word or character timestamps " +
        "with its audio.",
    );
    expect(validate("ElevenLabs")).not.toBeNull();
    expect(validate("")).not.toBeNull();
  });
});

describe("tts.elevenlabs.voice", () => {
  const validate = configKeySpec("tts.elevenlabs.voice").validate;

  it("admits twenty letters and digits", () => {
    expect(validate("21m00Tcm4TlvDq8ikWAM")).toBeNull();
  });

  it("refuses a Kokoro voice, a short id, a long one and punctuation", () => {
    expect(validate("af_heart")).toContain("is not an ElevenLabs voice id");
    expect(validate("JBFqnCBsd6RMkjVDRZz")).not.toBeNull();
    expect(validate("JBFqnCBsd6RMkjVDRZzbX")).not.toBeNull();
    expect(validate("JBFqnCBsd6RMkjVDRZz-")).not.toBeNull();
  });
});

describe("tts.elevenlabs.model", () => {
  const validate = configKeySpec("tts.elevenlabs.model").validate;

  /** C5: any well-formed id is stored; being outside the measured set is a warning, not a refusal. */
  it("admits every measured model and any other well-formed id", () => {
    for (const model of ELEVENLABS_VERIFIED_MODELS) {
      expect(validate(model)).toBeNull();
    }
    expect(validate("eleven_v3")).toBeNull();
    expect(validate("a".repeat(64))).toBeNull();
  });

  it("refuses uppercase, hyphens, an empty id and one longer than 64", () => {
    expect(validate("Eleven_v4")).toContain("is not an ElevenLabs model id");
    expect(validate("eleven-v4")).not.toBeNull();
    expect(validate("")).not.toBeNull();
    expect(validate("a".repeat(65))).not.toBeNull();
  });

  /** A key is lowercase hex and underscores too, so it is refused by its prefix, and never quoted. */
  it("refuses an API key pasted as a model, without repeating it", () => {
    const key = "sk_0123456789abcdef0123456789abcdef0123456789abcdef";
    const problem = validate(key);
    expect(problem).toContain("a value beginning sk_");
    expect(problem).not.toContain(key);
  });

  it("lists exactly the three models measured on 2026-11-11", () => {
    expect(ELEVENLABS_VERIFIED_MODELS).toEqual([
      "eleven_multilingual_v2",
      "eleven_flash_v2_5",
      "eleven_v4",
    ]);
  });
});

describe("tts.elevenlabs.api_key", () => {
  const validate = configKeySpec("tts.elevenlabs.api_key").validate;
  const key = "sk_0123456789abcdef0123456789abcdef0123456789abcdef";

  it("admits a key with no whitespace of up to 256 characters", () => {
    expect(validate(key)).toBeNull();
    expect(validate("k".repeat(256))).toBeNull();
  });

  it("refuses an empty key, whitespace inside one, and one longer than 256", () => {
    expect(validate("")).not.toBeNull();
    expect(validate(`${key} ${key}`)).not.toBeNull();
    expect(validate(`${key}\n`)).not.toBeNull();
    expect(validate("k".repeat(257))).not.toBeNull();
  });

  /** The refusal is printed, so it must never carry what it refused. */
  it("never quotes the value it refuses", () => {
    for (const value of [`${key} ${key}`, `${key}x`.repeat(6)]) {
      const problem = validate(value);
      expect(problem).not.toBeNull();
      expect(problem).not.toContain(key);
    }
  });
});
