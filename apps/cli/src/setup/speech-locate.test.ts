/**
 * Turning a recorded `onnx` component back into the three paths the synthesiser takes.
 *
 * The composed locator's *precedence* is asserted in `workers/speech.test.ts`, where it is one step
 * of `resolveSpeech()`'s. What is asserted here is the reading itself, over markers written by the
 * real writer: which field the model comes from, that the voice pack is taken out of the record
 * rather than guessed, and the two ways a component can be recorded and still not be a route.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolchainComponent } from "@xplainer/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { STATE_DIR_ENV } from "../daemon/state-dir.js";
import { OnnxSpeechError } from "../speech/index.js";
import { ONNX_PROVIDER, ONNX_RUNTIME_DIR, ONNX_VOICES_DIR } from "./providers/speech-onnx.js";
import { onnxSpeechFromComponent, onnxSpeechFromToolchain } from "./speech-locate.js";
import { recordTestOnnxSpeech, recordTestToolchain } from "./testing/toolchain.js";
import { toolchainMarkerPath } from "./toolchain.js";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "xplainer-speech-locate-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("onnxSpeechFromComponent", () => {
  it("reads the model from `path` and the voice out of the component's own file list", () => {
    const stateDir = temporaryDirectory();
    const component = recordTestOnnxSpeech(stateDir);
    const root = dirname(component.path);

    const paths = onnxSpeechFromComponent(component, "/state/toolchain.json");

    expect(paths).toEqual({
      modelPath: component.path,
      voicePath: join(root, ONNX_VOICES_DIR, "af_heart.bin"),
      voice: "af_heart",
      runtimeLocation: join(root, ...ONNX_RUNTIME_DIR.split("/")),
      origin: "recorded by setup in /state/toolchain.json",
    });
  });

  /**
   * The three other providers are absences here, not failures: `docker` and `url` are machines that
   * narrate over HTTP and always did, and returning `null` is what lets `resolveSpeech()` carry on
   * to the tts-client's own resolution instead of refusing a job on a working machine.
   */
  it("answers null for every provider that is not the in-process engine", () => {
    const component: ToolchainComponent = {
      version: "external",
      path: "/state/toolchain/speech/url.json",
      sha256: "0".repeat(64),
      provider: "url",
    };

    for (const provider of ["url", "docker", "bundle"]) {
      expect(onnxSpeechFromComponent({ ...component, provider }, "/m.json"), provider).toBeNull();
    }
  });

  /**
   * A component recording this route and naming no pack cannot be narrated with, and the refusal is
   * the alternative to guessing `af_heart.bin`: a filename this module invented would speak the
   * narration in whatever voice happened to be on the disk, which is the silent substitution the
   * whole engine refuses elsewhere (`VOICE_MISMATCH`).
   */
  it("refuses a component that records the route and names no voice pack", () => {
    const stateDir = temporaryDirectory();
    const component = recordTestOnnxSpeech(stateDir);
    const withoutVoice: ToolchainComponent = {
      ...component,
      files: (component.files ?? []).filter(
        (file) => dirname(file.path) !== join(dirname(component.path), ONNX_VOICES_DIR),
      ),
    };

    const refusal = (() => {
      try {
        onnxSpeechFromComponent(withoutVoice, "/state/toolchain.json");
        return null;
      } catch (error) {
        return error;
      }
    })();

    expect(refusal).toBeInstanceOf(OnnxSpeechError);
    expect((refusal as OnnxSpeechError).code).toBe("VOICE_UNREADABLE");
    expect((refusal as OnnxSpeechError).message).toContain("/state/toolchain.json");
    expect((refusal as OnnxSpeechError).message).toContain(ONNX_PROVIDER);
  });

  /** No `files` at all is the same case: every marker this route writes records at least four. */
  it("refuses a component with no file list, which no acquisition of this route produces", () => {
    const stateDir = temporaryDirectory();
    const { files: _dropped, ...withoutFiles } = recordTestOnnxSpeech(stateDir);

    expect(() => onnxSpeechFromComponent(withoutFiles, "/m.json")).toThrow(OnnxSpeechError);
  });
});

describe("onnxSpeechFromToolchain", () => {
  it("answers null on a machine with no marker, and on one whose marker is unreadable", () => {
    const stateDir = temporaryDirectory();
    expect(onnxSpeechFromToolchain({ [STATE_DIR_ENV]: stateDir })).toBeNull();

    writeFileSync(toolchainMarkerPath(stateDir), "not a document");
    expect(onnxSpeechFromToolchain({ [STATE_DIR_ENV]: stateDir })).toBeNull();
  });

  /**
   * The state directory comes from the same precedence every other reader uses, which is why
   * `daemon/workers.ts` puts the daemon's own directory into the narration worker's environment: a
   * `serve --state-dir …` daemon and a worker resolving the platform default would otherwise read
   * two different markers.
   */
  it("reads the marker in the directory XPLAINER_STATE_DIR names", () => {
    const stateDir = temporaryDirectory();
    const speech = recordTestOnnxSpeech(stateDir);
    recordTestToolchain({ stateDir, workspaceRoot: temporaryDirectory(), overrides: { speech } });

    expect(onnxSpeechFromToolchain({ [STATE_DIR_ENV]: stateDir })?.modelPath).toBe(speech.path);
    expect(onnxSpeechFromToolchain({ [STATE_DIR_ENV]: temporaryDirectory() })).toBeNull();
  });

  it("takes the three variables over the marker, and needs all three of them", () => {
    const stateDir = temporaryDirectory();
    const speech = recordTestOnnxSpeech(stateDir);
    recordTestToolchain({ stateDir, workspaceRoot: temporaryDirectory(), overrides: { speech } });
    const elsewhere = temporaryDirectory();
    const model = join(elsewhere, "another.onnx");
    const voice = join(elsewhere, "voices", "af_bella.bin");
    mkdirSync(dirname(voice), { recursive: true });
    writeFileSync(model, "");
    writeFileSync(voice, "");

    expect(
      onnxSpeechFromToolchain({
        [STATE_DIR_ENV]: stateDir,
        XPLAINER_ONNX_MODEL: model,
        XPLAINER_ONNX_VOICE: voice,
        XPLAINER_ONNX_RUNTIME: elsewhere,
      }),
    ).toEqual({
      modelPath: model,
      voicePath: voice,
      voice: "af_bella",
      runtimeLocation: elsewhere,
      origin: "XPLAINER_ONNX_MODEL, XPLAINER_ONNX_VOICE and XPLAINER_ONNX_RUNTIME",
    });

    // Two of three is somebody mid-experiment, so the marker still answers rather than a
    // half-configured route failing a narration job.
    expect(
      onnxSpeechFromToolchain({
        [STATE_DIR_ENV]: stateDir,
        XPLAINER_ONNX_MODEL: model,
        XPLAINER_ONNX_VOICE: voice,
      })?.modelPath,
    ).toBe(speech.path);
  });
});
