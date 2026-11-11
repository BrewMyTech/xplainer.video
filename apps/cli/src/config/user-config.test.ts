/**
 * `config.json` over a real temporary state directory: what a round trip keeps, and what makes the
 * file unreadable rather than empty.
 *
 * The second half is the one that matters. A reader that answered "no setting" for a file it could
 * not parse would turn a typo in a hand edit into a silent return to Kokoro, so every malformed shape
 * here is asserted to raise `StateDocumentUnreadableError` — exit `11` — and never to read as unset.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STATE_UNREADABLE_EXIT_CODE } from "../daemon/exit-codes.js";
import {
  readUserConfigValue,
  StateDocumentUnreadableError,
  USER_CONFIG_FILE,
  unsetUserConfigValue,
  userConfigPath,
  writeUserConfigValue,
} from "./user-config.js";

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "xplainer-user-config-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function onDisk(): unknown {
  return JSON.parse(readFileSync(userConfigPath(scratch), "utf8"));
}

/** What a read of `key` throws, or a failure when it throws nothing. */
function unreadable(contents: string): StateDocumentUnreadableError {
  writeFileSync(userConfigPath(scratch), contents);
  try {
    readUserConfigValue(scratch, "tts.provider");
  } catch (error) {
    if (error instanceof StateDocumentUnreadableError) {
      return error;
    }
    throw error;
  }
  throw new Error(`reading ${contents} raised nothing`);
}

describe("config.json", () => {
  it("lives in the state directory under its own name", () => {
    expect(userConfigPath(scratch)).toBe(join(scratch, USER_CONFIG_FILE));
  });

  it("reads every setting as unset when the file is absent", () => {
    expect(readUserConfigValue(scratch, "tts.provider")).toBeNull();
    expect(readUserConfigValue(scratch, "tts.elevenlabs.voice")).toBeNull();
    expect(readUserConfigValue(scratch, "tts.elevenlabs.model")).toBeNull();
  });

  it("round-trips each non-secret setting into the documented shape", () => {
    writeUserConfigValue(scratch, "tts.provider", "elevenlabs");
    writeUserConfigValue(scratch, "tts.elevenlabs.voice", "JBFqnCBsd6RMkjVDRZzb");
    writeUserConfigValue(scratch, "tts.elevenlabs.model", "eleven_multilingual_v2");

    expect(readUserConfigValue(scratch, "tts.provider")).toBe("elevenlabs");
    expect(readUserConfigValue(scratch, "tts.elevenlabs.voice")).toBe("JBFqnCBsd6RMkjVDRZzb");
    expect(readUserConfigValue(scratch, "tts.elevenlabs.model")).toBe("eleven_multilingual_v2");
    expect(onDisk()).toEqual({
      format_version: 1,
      tts: {
        provider: "elevenlabs",
        elevenlabs: { voice: "JBFqnCBsd6RMkjVDRZzb", model: "eleven_multilingual_v2" },
      },
    });
  });

  it("creates a missing state directory, and writes the file 0600", () => {
    const nested = join(scratch, "not", "yet");
    writeUserConfigValue(nested, "tts.provider", "kokoro");

    expect(readUserConfigValue(nested, "tts.provider")).toBe("kokoro");
    if (process.platform !== "win32") {
      expect(statSync(nested).mode & 0o777).toBe(0o700);
      expect(statSync(userConfigPath(nested)).mode & 0o777).toBe(0o600);
    }
  });

  it("replaces a value that is already set", () => {
    writeUserConfigValue(scratch, "tts.provider", "elevenlabs");
    writeUserConfigValue(scratch, "tts.provider", "kokoro");

    expect(readUserConfigValue(scratch, "tts.provider")).toBe("kokoro");
  });

  /** A newer build's setting must survive an older build's `config set`. */
  it("keeps unknown keys, at the top level and inside tts, on every write", () => {
    writeFileSync(
      userConfigPath(scratch),
      JSON.stringify({
        format_version: 1,
        future: { flag: true },
        tts: { other: "kept", elevenlabs: { stability: 0.5 } },
      }),
    );

    writeUserConfigValue(scratch, "tts.elevenlabs.voice", "21m00Tcm4TlvDq8ikWAM");
    unsetUserConfigValue(scratch, "tts.elevenlabs.voice");
    writeUserConfigValue(scratch, "tts.provider", "elevenlabs");

    expect(onDisk()).toEqual({
      format_version: 1,
      future: { flag: true },
      tts: { other: "kept", provider: "elevenlabs", elevenlabs: { stability: 0.5 } },
    });
  });

  it("unsets a setting, answers whether there was one, and prunes what it emptied", () => {
    writeUserConfigValue(scratch, "tts.provider", "elevenlabs");
    writeUserConfigValue(scratch, "tts.elevenlabs.model", "eleven_v4");

    expect(unsetUserConfigValue(scratch, "tts.elevenlabs.model")).toBe(true);
    expect(unsetUserConfigValue(scratch, "tts.elevenlabs.model")).toBe(false);
    expect(readUserConfigValue(scratch, "tts.elevenlabs.model")).toBeNull();
    expect(onDisk()).toEqual({ format_version: 1, tts: { provider: "elevenlabs" } });
  });

  it("answers false, and creates nothing, when unsetting with no file", () => {
    expect(unsetUserConfigValue(scratch, "tts.provider")).toBe(false);
    expect(() => statSync(userConfigPath(scratch))).toThrow();
  });

  /** D2: the non-secret file never holds the key, so nothing that prints it needs a redactor. */
  it("refuses to read or write the API key", () => {
    expect(() => writeUserConfigValue(scratch, "tts.elevenlabs.api_key", "sk_x")).toThrow(
      "credentials.json",
    );
    expect(() => readUserConfigValue(scratch, "tts.elevenlabs.api_key")).toThrow(
      "credentials.json",
    );
  });
});

describe("an unreadable config.json", () => {
  it("is invalid JSON, named with the parser's reason and exit 11", () => {
    const error = unreadable("{ not json");

    expect(error.exitCode).toBe(STATE_UNREADABLE_EXIT_CODE);
    expect(error.path).toBe(userConfigPath(scratch));
    expect(error.reason).toContain("it is not valid JSON");
    expect(error.message).toContain(userConfigPath(scratch));
  });

  it("is a newer format_version, which is refused rather than rewritten", () => {
    const error = unreadable(JSON.stringify({ format_version: 2, tts: { provider: "kokoro" } }));
    expect(error.reason).toBe("it records format_version 2, and this build reads only 1");

    expect(() => writeUserConfigValue(scratch, "tts.provider", "kokoro")).toThrow(
      StateDocumentUnreadableError,
    );
    expect(JSON.parse(readFileSync(userConfigPath(scratch), "utf8"))).toEqual({
      format_version: 2,
      tts: { provider: "kokoro" },
    });
  });

  it("is a document with no format_version", () => {
    expect(unreadable(JSON.stringify({ tts: { provider: "kokoro" } })).reason).toBe(
      "it records no format_version",
    );
  });

  it("is a document that is not an object", () => {
    expect(unreadable("[]").reason).toBe("it does not hold a JSON object");
    expect(unreadable('"kokoro"').reason).toBe("it does not hold a JSON object");
  });

  it("is a known setting that is not a string, or a container that is not an object", () => {
    expect(unreadable(JSON.stringify({ format_version: 1, tts: { provider: 5 } })).reason).toBe(
      "tts.provider is not a string",
    );
    expect(unreadable(JSON.stringify({ format_version: 1, tts: "elevenlabs" })).reason).toBe(
      "tts is not an object",
    );
  });

  /** A directory where the file should be: present, and not readable as one. */
  it("is a path that exists and cannot be read as a file", () => {
    mkdirSync(userConfigPath(scratch));

    expect(() => readUserConfigValue(scratch, "tts.provider")).toThrow(
      StateDocumentUnreadableError,
    );
  });
});
