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
 *
 * **Every case here passes `XPLAINER_STATE_DIR`, and that is not tidiness.** Since plan S5 the
 * default locator reads `<state>/toolchain.json`, and the state directory's own precedence ends in
 * a *platform default* — so a case that passed `{}` would read the marker of whichever machine ran
 * the suite, and "nothing is configured" would mean one thing on a developer's laptop and another
 * on a runner. An empty scratch directory is what "this machine has never run setup" is.
 */

import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_URL_ENV_VAR, DEFAULT_BASE_URL, KokoroClient } from "@xplainer/tts-client";
import { afterEach, describe, expect, it } from "vitest";
import { STATE_DIR_ENV } from "../daemon/state-dir.js";
import { DOCKER_PROVIDER } from "../setup/providers/speech-docker.js";
import { recordTestOnnxSpeech, recordTestToolchain } from "../setup/testing/toolchain.js";
import { toolchainMarkerPath } from "../setup/toolchain.js";
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
  return {
    modelPath,
    voicePath,
    voice: "af_heart",
    runtimeLocation: join(directory, "runtime"),
    origin: "this test",
  };
}

/** A state directory with no marker in it: a machine on which `setup` has never run. */
function bareStateDir(): Record<string, string> {
  return { [STATE_DIR_ENV]: fixtureDirectory() };
}

/**
 * A state directory whose `toolchain.json` records the in-process engine, as `setup` records it.
 *
 * The real marker, written by the real writer and read back by the real reader, with real files
 * where it says they are. There is no `vi.mock` in this package and there is none here: what is
 * under test is that the *product's own record* selects the route.
 */
function onnxStateDir(): { env: Record<string, string>; stateDir: string; modelPath: string } {
  const stateDir = fixtureDirectory();
  const speech = recordTestOnnxSpeech(stateDir);
  recordTestToolchain({ stateDir, workspaceRoot: fixtureDirectory(), overrides: { speech } });
  return { env: { [STATE_DIR_ENV]: stateDir }, stateDir, modelPath: speech.path };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolveSpeech", () => {
  it("falls back to the tts-client's own resolution when nothing is configured", () => {
    const resolved = resolveSpeech(bareStateDir());

    expect(resolved.synthesiser).toBeInstanceOf(KokoroClient);
    expect(resolved.source).toBe(`kokoro at ${DEFAULT_BASE_URL}`);
  });

  it("takes XPLAINER_TTS_URL, and KOKORO_URL after it", () => {
    expect(resolveSpeech({ ...bareStateDir(), [TTS_URL_ENV]: "http://tts:9000" }).source).toBe(
      "kokoro at http://tts:9000",
    );
    expect(resolveSpeech({ ...bareStateDir(), KOKORO_URL: "http://legacy:8880" }).source).toBe(
      "kokoro at http://legacy:8880",
    );
    expect(
      resolveSpeech({
        ...bareStateDir(),
        [TTS_URL_ENV]: "http://tts:9000",
        KOKORO_URL: "http://legacy:8880",
      }).source,
    ).toBe("kokoro at http://tts:9000");
  });

  it("ignores a blank URL rather than building a client on an empty base", () => {
    expect(resolveSpeech({ ...bareStateDir(), [TTS_URL_ENV]: "   " }).source).toBe(
      `kokoro at ${DEFAULT_BASE_URL}`,
    );
  });

  it("prefers a fixture directory over any server URL", () => {
    const dir = fixtureDirectory();
    writeNarrationFixture(dir, [
      { id: "hook", text: "It was.", seconds: 0.5, frequency: 330, words: [] },
    ]);

    const resolved = resolveSpeech({
      ...bareStateDir(),
      [TTS_FIXTURE_ENV]: dir,
      [TTS_URL_ENV]: "http://tts:9000",
    });

    expect(resolved.synthesiser).not.toBeInstanceOf(KokoroClient);
    expect(resolved.source).toContain(dir);
  });
});

/**
 * The whole of plan S5: the daemon finds the engine its own `setup` acquired, with no locator
 * argument and no `XPLAINER_ONNX_*` variable anywhere.
 *
 * Every case in this block calls `resolveSpeech(env)` with **one** argument, which is the point.
 * The suite above can substitute a locator to assert an order; these cannot, because what is under
 * test is the default — the thing a narration worker gets when it calls `resolveSpeech()`.
 */
describe("resolveSpeech and the marker setup wrote", () => {
  it("narrates with the engine toolchain.json records, needing no variable at all", () => {
    const machine = onnxStateDir();

    const resolved = resolveSpeech(machine.env);

    expect(resolved.synthesiser).not.toBeInstanceOf(KokoroClient);
    expect(resolved.source).toContain("kokoro in this process, voice af_heart");
    expect(resolved.source).toContain(machine.modelPath);
    // The provenance the proof reads: this route was chosen from the record, not from a variable.
    expect(resolved.source).toContain(`route recorded by setup in ${machine.stateDir}`);
  });

  it("still loses to a fixture and to a server somebody named", () => {
    const machine = onnxStateDir();
    const dir = fixtureDirectory();
    writeNarrationFixture(dir, [
      { id: "hook", text: "It was.", seconds: 0.5, frequency: 330, words: [] },
    ]);

    expect(resolveSpeech({ ...machine.env, [TTS_URL_ENV]: "http://tts:9000" }).source).toBe(
      "kokoro at http://tts:9000",
    );
    expect(resolveSpeech({ ...machine.env, [BASE_URL_ENV_VAR]: "http://legacy:8880" }).source).toBe(
      "kokoro at http://legacy:8880",
    );
    expect(resolveSpeech({ ...machine.env, [TTS_FIXTURE_ENV]: dir }).source).toContain(dir);
  });

  /**
   * The three variables are the override *above* the marker, so a spike pointing them at another
   * export is not silently overruled by whatever this machine happens to have acquired.
   */
  it("lets the three variables name a model no setup on this machine acquired", () => {
    const machine = onnxStateDir();
    const other = onnxArtefacts();

    const resolved = resolveSpeech({
      ...machine.env,
      [ONNX_MODEL_ENV]: other.modelPath,
      [ONNX_VOICE_ENV]: other.voicePath,
      [ONNX_RUNTIME_ENV]: other.runtimeLocation,
    });

    expect(resolved.source).toContain(other.modelPath);
    expect(resolved.source).toContain(`route ${ONNX_MODEL_ENV}`);
  });

  /**
   * A machine that recorded `docker` narrates exactly as it did before this locator existed: the
   * container it started answers on the tts-client's default. A marker naming another provider is
   * an *absence* to this module, not a route it half-takes.
   */
  it("falls through for a marker recording any other provider", () => {
    const stateDir = fixtureDirectory();
    const marker = recordTestToolchain({ stateDir, workspaceRoot: fixtureDirectory() });
    expect(marker.speech.provider).toBe(DOCKER_PROVIDER);

    const resolved = resolveSpeech({ [STATE_DIR_ENV]: stateDir });

    expect(resolved.synthesiser).toBeInstanceOf(KokoroClient);
    expect(resolved.source).toBe(`kokoro at ${DEFAULT_BASE_URL}`);
  });

  /**
   * The other half of plan D5's rule, and the one that would be easiest to get wrong: a route the
   * marker *chose* whose files have gone is a broken machine, not a machine without the route.
   * Falling through would narrate at `localhost:8880` and report a connection error about a
   * container this machine never had — so it refuses, naming the missing path and `xplainer setup`.
   */
  it("refuses when the marker records the engine and its files have gone", () => {
    const machine = onnxStateDir();
    unlinkSync(machine.modelPath);

    expect(() => resolveSpeech(machine.env)).toThrow(machine.modelPath);
    expect(() => resolveSpeech(machine.env)).toThrow(/xplainer setup/);
  });

  it("ignores a marker that cannot be read at all, which is a machine setup has not finished", () => {
    const stateDir = fixtureDirectory();
    writeFileSync(toolchainMarkerPath(stateDir), "{ half a document");

    expect(resolveSpeech({ [STATE_DIR_ENV]: stateDir }).source).toBe(
      `kokoro at ${DEFAULT_BASE_URL}`,
    );
  });
});

describe("resolveSpeech and the in-process ONNX engine", () => {
  it("uses it when this machine has one, in preference to the default server guess", () => {
    const paths = onnxArtefacts();

    const resolved = resolveSpeech({}, () => paths);

    expect(resolved.synthesiser).not.toBeInstanceOf(KokoroClient);
    expect(resolved.source).toBe(
      `kokoro in this process, voice af_heart (${paths.modelPath}), route ${paths.origin}`,
    );
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

  it("answers the three paths, the voice the pack's filename names, and where it looked", () => {
    expect(onnxSpeechFromEnvironment(full)).toEqual({
      modelPath: "/models/model_quantized.onnx",
      voicePath: "/voices/af_heart.bin",
      runtimeLocation: "/runtime/onnxruntime-node",
      voice: "af_heart",
      origin: `${ONNX_MODEL_ENV}, ${ONNX_VOICE_ENV} and ${ONNX_RUNTIME_ENV}`,
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
