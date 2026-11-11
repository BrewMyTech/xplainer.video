/**
 * Which provider a machine narrates with, decided from real files in a scratch state directory.
 *
 * The files are written by WP-B's own writers rather than by hand, except where the case is a hand
 * edit gone wrong — which is the case the re-validation here exists for. Every environment is an
 * explicit object, never `process.env`, so a developer who exported `ELEVENLABS_API_KEY` for some
 * other tool runs the same suite as a CI runner that has never heard of it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeCredential } from "../config/credentials.js";
import { ELEVENLABS_VERIFIED_MODELS as KEYS_VERIFIED_MODELS } from "../config/keys.js";
import { userConfigPath, writeUserConfigValue } from "../config/user-config.js";
import { TtsProviderError } from "./provider.js";
import {
  ELEVENLABS_API_KEY_ENV,
  ELEVENLABS_DEFAULT_MODEL,
  ELEVENLABS_DEFAULT_VOICE,
  ELEVENLABS_VERIFIED_MODELS,
  ELEVENLABS_VOICE_ID,
  readElevenLabsApiKey,
  resolveTtsSelection,
  TTS_PROVIDER_ENV,
} from "./resolve.js";
import { TEST_API_KEY } from "./testing/elevenlabs-fixture.js";

const scratch: string[] = [];

function stateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "xplainer-tts-resolve-"));
  scratch.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function caught(run: () => unknown): TtsProviderError {
  try {
    run();
  } catch (error) {
    if (error instanceof TtsProviderError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a TtsProviderError and nothing was thrown");
}

describe("the constants", () => {
  it("names the two variables and the two defaults the spec fixes", () => {
    expect(TTS_PROVIDER_ENV).toBe("XPLAINER_TTS_PROVIDER");
    expect(ELEVENLABS_API_KEY_ENV).toBe("ELEVENLABS_API_KEY");
    expect(ELEVENLABS_DEFAULT_VOICE).toBe("JBFqnCBsd6RMkjVDRZzb");
    expect(ELEVENLABS_DEFAULT_MODEL).toBe("eleven_multilingual_v2");
    expect(ELEVENLABS_VOICE_ID.test(ELEVENLABS_DEFAULT_VOICE)).toBe(true);
    expect(ELEVENLABS_VOICE_ID.test("af_heart")).toBe(false);
    expect(ELEVENLABS_VERIFIED_MODELS).toBe(KEYS_VERIFIED_MODELS);
  });
});

describe("resolveTtsSelection: the provider", () => {
  it("is kokoro, by default, on a machine nobody configured", () => {
    expect(resolveTtsSelection({}, stateDirectory())).toEqual({
      provider: "kokoro",
      providerOrigin: "default",
    });
  });

  it("is what config.json says, and the environment beats it", () => {
    const stateDir = stateDirectory();
    writeUserConfigValue(stateDir, "tts.provider", "elevenlabs");

    expect(resolveTtsSelection({}, stateDir)).toMatchObject({
      provider: "elevenlabs",
      providerOrigin: "config",
    });
    expect(resolveTtsSelection({ [TTS_PROVIDER_ENV]: "kokoro" }, stateDir)).toEqual({
      provider: "kokoro",
      providerOrigin: "environment",
    });
  });

  it("takes the environment over the default, and ignores a blank one", () => {
    const stateDir = stateDirectory();

    expect(resolveTtsSelection({ [TTS_PROVIDER_ENV]: "elevenlabs" }, stateDir)).toMatchObject({
      provider: "elevenlabs",
      providerOrigin: "environment",
    });
    expect(resolveTtsSelection({ [TTS_PROVIDER_ENV]: "  " }, stateDir).provider).toBe("kokoro");
  });

  /** A key exported for some other tool must not quietly bill every narration on the machine. */
  it("is never chosen by ELEVENLABS_API_KEY on its own", () => {
    expect(
      resolveTtsSelection({ [ELEVENLABS_API_KEY_ENV]: TEST_API_KEY }, stateDirectory()),
    ).toEqual({ provider: "kokoro", providerOrigin: "default" });
  });

  it("refuses an unknown name from either place, saying which", () => {
    const stateDir = stateDirectory();
    expect(
      caught(() => resolveTtsSelection({ [TTS_PROVIDER_ENV]: "openai" }, stateDir)),
    ).toMatchObject({
      code: "PROVIDER_UNKNOWN",
      message: expect.stringContaining(TTS_PROVIDER_ENV),
    });

    writeFileSync(
      userConfigPath(stateDir),
      JSON.stringify({ format_version: 1, tts: { provider: "openai" } }),
    );
    const error = caught(() => resolveTtsSelection({}, stateDir));
    expect(error.code).toBe("PROVIDER_UNKNOWN");
    expect(error.message).toContain(userConfigPath(stateDir));
  });

  /** "No config" here would be a narration in a different voice than the owner chose. */
  it("refuses an unreadable config.json rather than answering kokoro", () => {
    const stateDir = stateDirectory();
    writeFileSync(userConfigPath(stateDir), "{ half a document");

    const error = caught(() => resolveTtsSelection({}, stateDir));

    expect(error.code).toBe("CONFIG_UNREADABLE");
    expect(error.message).toContain(userConfigPath(stateDir));
    expect(error.message).toContain("will not guess");
  });

  it("refuses a config.json of a format this build does not read", () => {
    const stateDir = stateDirectory();
    writeFileSync(userConfigPath(stateDir), JSON.stringify({ format_version: 2 }));

    expect(caught(() => resolveTtsSelection({}, stateDir)).code).toBe("CONFIG_UNREADABLE");
  });
});

describe("resolveTtsSelection: ElevenLabs settings", () => {
  const elevenlabs = { [TTS_PROVIDER_ENV]: "elevenlabs" };

  it("defaults the voice and model, and reports that no key is stored", () => {
    expect(resolveTtsSelection(elevenlabs, stateDirectory())).toEqual({
      provider: "elevenlabs",
      providerOrigin: "environment",
      voice: ELEVENLABS_DEFAULT_VOICE,
      voiceOrigin: "default",
      model: ELEVENLABS_DEFAULT_MODEL,
      modelOrigin: "default",
      apiKeyOrigin: null,
    });
  });

  it("reads the voice and model from config.json", () => {
    const stateDir = stateDirectory();
    writeUserConfigValue(stateDir, "tts.elevenlabs.voice", "21m00Tcm4TlvDq8ikWAM");
    writeUserConfigValue(stateDir, "tts.elevenlabs.model", "eleven_flash_v2_5");

    expect(resolveTtsSelection(elevenlabs, stateDir)).toMatchObject({
      voice: "21m00Tcm4TlvDq8ikWAM",
      voiceOrigin: "config",
      model: "eleven_flash_v2_5",
      modelOrigin: "config",
    });
  });

  /** A person can edit the file by hand, so what `config set` would refuse is refused here too. */
  it("refuses a hand-edited voice that config set would have refused", () => {
    const stateDir = stateDirectory();
    writeFileSync(
      userConfigPath(stateDir),
      JSON.stringify({ format_version: 1, tts: { elevenlabs: { voice: "af_bella" } } }),
    );

    const error = caught(() => resolveTtsSelection(elevenlabs, stateDir));

    expect(error.code).toBe("CONFIG_UNREADABLE");
    expect(error.message).toContain("tts.elevenlabs.voice");
    expect(error.message).toContain("af_bella");
  });

  it("names where the key is — environment over credentials.json — and never the key", () => {
    const stateDir = stateDirectory();
    writeCredential(stateDir, "tts.elevenlabs.api_key", TEST_API_KEY);

    const stored = resolveTtsSelection(elevenlabs, stateDir);
    const exported = resolveTtsSelection(
      { ...elevenlabs, [ELEVENLABS_API_KEY_ENV]: "sk_from_the_shell" },
      stateDir,
    );

    expect(stored).toMatchObject({ apiKeyOrigin: "credentials" });
    expect(exported).toMatchObject({ apiKeyOrigin: "environment" });
    expect(JSON.stringify([stored, exported])).not.toContain(TEST_API_KEY);
    expect(JSON.stringify(exported)).not.toContain("sk_from_the_shell");
  });

  /** Under kokoro nothing else is read, so a broken credentials file cannot fail it. */
  it("does not read credentials.json at all when the provider is kokoro", () => {
    const stateDir = stateDirectory();
    writeFileSync(join(stateDir, "credentials.json"), "{ not json");

    expect(resolveTtsSelection({}, stateDir).provider).toBe("kokoro");
    expect(caught(() => resolveTtsSelection(elevenlabs, stateDir)).code).toBe("CONFIG_UNREADABLE");
  });
});

describe("readElevenLabsApiKey", () => {
  it("answers the environment's key, else the stored one, else null", () => {
    const stateDir = stateDirectory();
    expect(readElevenLabsApiKey({}, stateDir)).toBeNull();

    writeCredential(stateDir, "tts.elevenlabs.api_key", TEST_API_KEY);
    expect(readElevenLabsApiKey({}, stateDir)).toBe(TEST_API_KEY);
    expect(readElevenLabsApiKey({ [ELEVENLABS_API_KEY_ENV]: " sk_shell " }, stateDir)).toBe(
      "sk_shell",
    );
    expect(readElevenLabsApiKey({ [ELEVENLABS_API_KEY_ENV]: "" }, stateDir)).toBe(TEST_API_KEY);
  });
});
