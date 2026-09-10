/**
 * Where the narration worker's speech comes from: two variables an operator sets, and one engine
 * this machine either has or does not.
 *
 * The precedence matters more than it looks. A fixture directory wins over everything, so a test
 * environment cannot accidentally reach a developer's running container or spend six seconds a
 * segment in a real model; a server somebody *named* wins over the local engine, because naming one
 * was an intention; and a blank variable is ignored rather than resolved to an empty path, because
 * an empty `XPLAINER_TTS_URL` in a systemd unit or a shell profile is the ordinary way a variable
 * ends up set to nothing.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_URL_ENV_VAR, DEFAULT_BASE_URL, KokoroClient } from "@xplainer/tts-client";
import { afterEach, describe, expect, it } from "vitest";
import {
  ONNX_MODEL_ENV,
  ONNX_RUNTIME_ENV,
  ONNX_VOICE_ENV,
  ONNX_VOICE_NAME_ENV,
  type OnnxSpeechPaths,
  onnxSpeechFromEnvironment,
  STYLE_DIMENSION,
  voiceFromPackPath,
} from "../speech/index.js";
import { createFixtureSynthesiser, resolveSpeech, TTS_FIXTURE_ENV, TTS_URL_ENV } from "./speech.js";
import { writeNarrationFixture } from "./testing/narration-fixture.js";

const directories: string[] = [];

function fixtureDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "xplainer-speech-"));
  directories.push(directory);
  return directory;
}

/**
 * A model file and a voice pack that exist, so `resolveSpeech` can really build the synthesiser.
 *
 * The ONNX branch validates its paths at construction — a route that cannot work must be refused
 * before a job starts — so a route test that handed it invented paths would be asserting the
 * refusal rather than the route.
 */
function onnxArtefacts(): OnnxSpeechPaths {
  const directory = fixtureDirectory();
  const modelPath = join(directory, "model_quantized.onnx");
  writeFileSync(modelPath, "not a real model; nothing here opens it");
  const voicePath = join(directory, "af_heart.bin");
  writeFileSync(voicePath, Buffer.alloc(510 * STYLE_DIMENSION * 4));
  return { modelPath, voicePath, voice: "af_heart", runtimeLocation: join(directory, "runtime") };
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

describe("resolveSpeech and the in-process ONNX engine", () => {
  it("uses it when this machine has one, in preference to the default server guess", () => {
    const paths = onnxArtefacts();

    const resolved = resolveSpeech({}, () => paths);

    expect(resolved.synthesiser).not.toBeInstanceOf(KokoroClient);
    expect(resolved.source).toBe(`kokoro in this process, voice af_heart (${paths.modelPath})`);
  });

  it("loses to a server somebody named, under either variable", () => {
    const paths = onnxArtefacts();

    expect(resolveSpeech({ [TTS_URL_ENV]: "http://tts:9000" }, () => paths).source).toBe(
      "kokoro at http://tts:9000",
    );
    expect(resolveSpeech({ [BASE_URL_ENV_VAR]: "http://legacy:8880" }, () => paths).source).toBe(
      "kokoro at http://legacy:8880",
    );
  });

  it("loses to a fixture directory, so a test never spends six seconds a segment in a model", () => {
    const dir = fixtureDirectory();
    writeNarrationFixture(dir, [
      { id: "hook", text: "It was.", seconds: 0.5, frequency: 330, words: [] },
    ]);

    const resolved = resolveSpeech({ [TTS_FIXTURE_ENV]: dir }, () => onnxArtefacts());

    expect(resolved.source).toContain(dir);
  });

  it("falls through to the server when this machine has no engine", () => {
    expect(resolveSpeech({}, () => null).source).toBe(`kokoro at ${DEFAULT_BASE_URL}`);
  });
});

describe("onnxSpeechFromEnvironment", () => {
  const full = {
    [ONNX_MODEL_ENV]: "/models/model_quantized.onnx",
    [ONNX_VOICE_ENV]: "/voices/af_heart.bin",
    [ONNX_RUNTIME_ENV]: "/runtime/onnxruntime-node",
  };

  it("answers the three paths, and the voice the pack's filename names", () => {
    expect(onnxSpeechFromEnvironment(full)).toEqual({
      modelPath: "/models/model_quantized.onnx",
      voicePath: "/voices/af_heart.bin",
      runtimeLocation: "/runtime/onnxruntime-node",
      voice: "af_heart",
    });
  });

  it("takes an explicit voice name over the filename", () => {
    expect(onnxSpeechFromEnvironment({ ...full, [ONNX_VOICE_NAME_ENV]: "af_bella" })?.voice).toBe(
      "af_bella",
    );
  });

  it("answers null unless all three are set, so a half-configured route falls through", () => {
    expect(onnxSpeechFromEnvironment({})).toBeNull();
    for (const variable of [ONNX_MODEL_ENV, ONNX_VOICE_ENV, ONNX_RUNTIME_ENV]) {
      expect(onnxSpeechFromEnvironment({ ...full, [variable]: undefined }), variable).toBeNull();
      expect(onnxSpeechFromEnvironment({ ...full, [variable]: "  " }), variable).toBeNull();
    }
  });
});

describe("voiceFromPackPath", () => {
  it("reads the voice id off the pack, which is how the model repository names one", () => {
    expect(voiceFromPackPath("/x/voices/af_heart.bin")).toBe("af_heart");
    expect(voiceFromPackPath("af_sky.bin")).toBe("af_sky");
    expect(voiceFromPackPath("/x/af_heart")).toBe("af_heart");
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
