/**
 * `credentials.json` over a real temporary state directory.
 *
 * What is asserted is the protection as well as the value: the file is `0600` however it came to
 * exist, a file somebody loosened is replaced by one that is not, no temporary file is left holding
 * the key, and an unreadable file says why without quoting a byte of what is in it. The mode is
 * asserted inside `if (process.platform !== "win32")` rather than skipped, because on Windows the
 * protection is the ACL `daemon/windows-acl.ts` applies and a mode there means nothing.
 */

import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STATE_UNREADABLE_EXIT_CODE } from "../daemon/exit-codes.js";
import {
  CREDENTIALS_FILE,
  credentialsPath,
  readCredential,
  removeCredential,
  writeCredential,
} from "./credentials.js";
import { StateDocumentUnreadableError } from "./user-config.js";

const KEY = "sk_fedcba9876543210fedcba9876543210fedcba9876543210";

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "xplainer-credentials-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("credentials.json", () => {
  it("lives in the state directory under its own name", () => {
    expect(credentialsPath(scratch)).toBe(join(scratch, CREDENTIALS_FILE));
  });

  it("reads the key as unset when the file is absent", () => {
    expect(readCredential(scratch, "tts.elevenlabs.api_key")).toBeNull();
  });

  it("round-trips the key into the documented shape", () => {
    const stored = writeCredential(scratch, "tts.elevenlabs.api_key", KEY);

    expect(stored.path).toBe(credentialsPath(scratch));
    expect(readCredential(scratch, "tts.elevenlabs.api_key")).toBe(KEY);
    expect(JSON.parse(readFileSync(stored.path, "utf8"))).toEqual({
      format_version: 1,
      tts: { elevenlabs: { api_key: KEY } },
    });
  });

  it("is created 0600 in a 0700 directory, and says so", () => {
    const state = join(scratch, "state");
    const stored = writeCredential(state, "tts.elevenlabs.api_key", KEY);

    if (process.platform !== "win32") {
      expect(statSync(state).mode & 0o777).toBe(0o700);
      expect(statSync(stored.path).mode & 0o777).toBe(0o600);
      expect(stored.protection).toBe("mode 0600");
    }
  });

  /** Every write is a new file, so a mode loosened by hand does not survive the next one. */
  it("replaces a file somebody loosened with one that is 0600 again", () => {
    writeCredential(scratch, "tts.elevenlabs.api_key", "sk_old");
    chmodSync(credentialsPath(scratch), 0o644);

    writeCredential(scratch, "tts.elevenlabs.api_key", KEY);

    expect(readCredential(scratch, "tts.elevenlabs.api_key")).toBe(KEY);
    if (process.platform !== "win32") {
      expect(statSync(credentialsPath(scratch)).mode & 0o777).toBe(0o600);
    }
  });

  it("leaves no temporary file behind", () => {
    writeCredential(scratch, "tts.elevenlabs.api_key", KEY);
    removeCredential(scratch, "tts.elevenlabs.api_key");

    expect(readdirSync(scratch)).toEqual([CREDENTIALS_FILE]);
  });

  it("keeps unknown entries when it writes", () => {
    writeFileSync(
      credentialsPath(scratch),
      JSON.stringify({ format_version: 1, other: { token: "kept" }, tts: { kokoro: { x: 1 } } }),
    );

    writeCredential(scratch, "tts.elevenlabs.api_key", KEY);

    expect(JSON.parse(readFileSync(credentialsPath(scratch), "utf8"))).toEqual({
      format_version: 1,
      other: { token: "kept" },
      tts: { kokoro: { x: 1 }, elevenlabs: { api_key: KEY } },
    });
  });

  it("removes the key from the file, and answers whether there was one", () => {
    writeCredential(scratch, "tts.elevenlabs.api_key", KEY);

    expect(removeCredential(scratch, "tts.elevenlabs.api_key")).toBe(true);
    expect(removeCredential(scratch, "tts.elevenlabs.api_key")).toBe(false);
    expect(readCredential(scratch, "tts.elevenlabs.api_key")).toBeNull();
    expect(readFileSync(credentialsPath(scratch), "utf8")).not.toContain(KEY);
  });

  it("answers false, and creates nothing, when removing with no file", () => {
    expect(removeCredential(scratch, "tts.elevenlabs.api_key")).toBe(false);
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("refuses to hold a setting that is not a secret", () => {
    expect(() => writeCredential(scratch, "tts.provider", "elevenlabs")).toThrow("config.json");
    expect(() => readCredential(scratch, "tts.elevenlabs.voice")).toThrow("config.json");
  });
});

describe("an unreadable credentials.json", () => {
  /** The parser's own message quotes the text around the fault, which here is the key. */
  it("is invalid JSON, named without a byte of its contents", () => {
    writeFileSync(
      credentialsPath(scratch),
      `{"format_version":1,"tts":{"elevenlabs":{"api_key":"${KEY}"`,
    );

    let caught: unknown;
    try {
      readCredential(scratch, "tts.elevenlabs.api_key");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StateDocumentUnreadableError);
    const error = caught as StateDocumentUnreadableError;
    expect(error.exitCode).toBe(STATE_UNREADABLE_EXIT_CODE);
    expect(error.reason).toBe("it is not valid JSON");
    expect(error.message).toContain(credentialsPath(scratch));
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toContain("sk_");
  });

  it("is a newer format_version, and is not overwritten", () => {
    const newer = JSON.stringify({ format_version: 2, tts: { elevenlabs: { api_key: KEY } } });
    writeFileSync(credentialsPath(scratch), newer);

    expect(() => writeCredential(scratch, "tts.elevenlabs.api_key", "sk_new")).toThrow(
      StateDocumentUnreadableError,
    );
    expect(readFileSync(credentialsPath(scratch), "utf8")).toBe(newer);
  });
});
