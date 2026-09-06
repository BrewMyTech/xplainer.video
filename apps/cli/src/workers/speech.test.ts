/**
 * Where the narration worker's speech comes from, decided from the environment alone.
 *
 * The precedence matters more than it looks. A fixture directory wins over a server URL, so a test
 * environment cannot accidentally reach a developer's running container; and a blank variable is
 * ignored rather than resolved to an empty path, because an empty `XPLAINER_TTS_URL` in a systemd
 * unit or a shell profile is the ordinary way a variable ends up set to nothing.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BASE_URL, KokoroClient } from "@xplainer/tts-client";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureSynthesiser, resolveSpeech, TTS_FIXTURE_ENV, TTS_URL_ENV } from "./speech.js";
import { writeNarrationFixture } from "./testing/narration-fixture.js";

const directories: string[] = [];

function fixtureDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "xplainer-speech-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolveSpeech", () => {
  it("falls back to the tts-client's own resolution when nothing is configured", () => {
    const resolved = resolveSpeech({});

    expect(resolved.synthesiser).toBeInstanceOf(KokoroClient);
    expect(resolved.source).toBe(`kokoro at ${DEFAULT_BASE_URL}`);
  });

  it("takes XPLAINER_TTS_URL, and KOKORO_URL after it", () => {
    expect(resolveSpeech({ [TTS_URL_ENV]: "http://tts:9000" }).source).toBe(
      "kokoro at http://tts:9000",
    );
    expect(resolveSpeech({ KOKORO_URL: "http://legacy:8880" }).source).toBe(
      "kokoro at http://legacy:8880",
    );
    expect(
      resolveSpeech({ [TTS_URL_ENV]: "http://tts:9000", KOKORO_URL: "http://legacy:8880" }).source,
    ).toBe("kokoro at http://tts:9000");
  });

  it("ignores a blank URL rather than building a client on an empty base", () => {
    expect(resolveSpeech({ [TTS_URL_ENV]: "   " }).source).toBe(`kokoro at ${DEFAULT_BASE_URL}`);
  });

  it("prefers a fixture directory over any server URL", () => {
    const dir = fixtureDirectory();
    writeNarrationFixture(dir, [
      { id: "hook", text: "It was.", seconds: 0.5, frequency: 330, words: [] },
    ]);

    const resolved = resolveSpeech({ [TTS_FIXTURE_ENV]: dir, [TTS_URL_ENV]: "http://tts:9000" });

    expect(resolved.synthesiser).not.toBeInstanceOf(KokoroClient);
    expect(resolved.source).toContain(dir);
  });
});

describe("the fixture synthesiser", () => {
  it("answers with the recorded WAV and word spans, in the server's own envelope", async () => {
    const dir = fixtureDirectory();
    writeNarrationFixture(dir, [
      {
        id: "hook",
        text: "It was.",
        seconds: 0.5,
        frequency: 330,
        words: [{ word: "It", start_time: 0, end_time: 0.2 }],
      },
    ]);

    const response = await createFixtureSynthesiser(dir).captionedSpeech({
      text: "It was.",
      voice: "af_heart",
      speed: 1,
    });

    expect(Buffer.from(response.audio, "base64").toString("ascii", 0, 4)).toBe("RIFF");
    expect(response.timestamps).toEqual([{ word: "It", start_time: 0, end_time: 0.2 }]);
  });

  it("names what it has when a segment was never recorded", async () => {
    const dir = fixtureDirectory();
    writeNarrationFixture(dir, [
      { id: "hook", text: "It was.", seconds: 0.5, frequency: 330, words: [] },
    ]);

    await expect(
      createFixtureSynthesiser(dir).captionedSpeech({
        text: "something else",
        voice: "af_heart",
        speed: 1,
      }),
    ).rejects.toThrow(/no recorded speech .*"It was\."/s);
  });

  it("refuses a directory with no manifest, rather than answering silence", () => {
    const dir = fixtureDirectory();

    expect(() => createFixtureSynthesiser(dir)).toThrow(/fixtures\.json/);
  });

  it("refuses a manifest that is not a list of entries", () => {
    const dir = fixtureDirectory();
    writeFileSync(join(dir, "fixtures.json"), '{"segments": []}');

    expect(() => createFixtureSynthesiser(dir)).toThrow(/must be a JSON array/);
  });
});
