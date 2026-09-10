/**
 * Where the three ONNX speech artefacts are, and the one seam that answers it.
 *
 * **This module exists so that the synthesiser never discovers anything.** `createOnnxSynthesiser`
 * takes three explicit paths; something has to produce them, and the honest answer is that
 * `setup` does — it acquires the model, the voice pack and the host's ONNX Runtime, and records
 * them in `toolchain.json` (plan S2). That marker's reader lives in `src/setup/`, so this module is
 * a **function type** rather than a second reader: `resolveSpeech()` takes an
 * {@link OnnxSpeechLocator} and the acquisition lane supplies the one that reads the marker.
 *
 * {@link onnxSpeechFromEnvironment} is the locator in the meantime, and it is not scaffolding — it
 * is the same seam every other part of this file's route selection uses, and it is what lets the
 * proof and the gated test point at a model without a `setup` run. It answers `null` unless all
 * three variables are set, because a partially configured route must fall through to the server
 * rather than fail: two of three paths is somebody mid-experiment, not somebody asking for this
 * engine.
 */

import { basename, extname } from "node:path";

/** Names the `.onnx` model file the in-process synthesiser speaks with. */
export const ONNX_MODEL_ENV = "XPLAINER_ONNX_MODEL";

/** Names the voice pack — 510 rows of 256 float32, `af_heart.bin` upstream. */
export const ONNX_VOICE_ENV = "XPLAINER_ONNX_VOICE";

/** Names the ONNX Runtime package directory or entry file `setup` acquired. */
export const ONNX_RUNTIME_ENV = "XPLAINER_ONNX_RUNTIME";

/**
 * Overrides the voice id taken from the voice pack's filename.
 *
 * The upstream repository names a pack after the voice it speaks — `voices/af_heart.bin` — so the
 * basename *is* the id and needs no variable in the ordinary case. This is here for a pack that was
 * renamed on the way down, and it exists at all because the alternative to knowing the id is
 * speaking a narration in a voice it did not ask for without saying so.
 */
export const ONNX_VOICE_NAME_ENV = "XPLAINER_ONNX_VOICE_NAME";

/** The three paths, and the voice the pack speaks. */
export type OnnxSpeechPaths = {
  readonly modelPath: string;
  readonly voicePath: string;
  readonly voice: string;
  readonly runtimeLocation: string;
};

/** How `resolveSpeech()` asks whether this machine has an in-process speech engine. */
export type OnnxSpeechLocator = (
  env: Readonly<Record<string, string | undefined>>,
) => OnnxSpeechPaths | null;

/** A variable that is set to whitespace is a variable a shell profile or a unit set to nothing. */
function trimmed(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const text = value.trim();
  return text === "" ? null : text;
}

/** The voice id a pack filename carries: `af_heart.bin` speaks `af_heart`. */
export function voiceFromPackPath(path: string): string {
  const name = basename(path);
  return name.slice(0, name.length - extname(name).length);
}

/**
 * The three paths from the environment, or `null` when this machine has not been told all three.
 */
export const onnxSpeechFromEnvironment: OnnxSpeechLocator = (env) => {
  const modelPath = trimmed(env[ONNX_MODEL_ENV]);
  const voicePath = trimmed(env[ONNX_VOICE_ENV]);
  const runtimeLocation = trimmed(env[ONNX_RUNTIME_ENV]);
  if (modelPath === null || voicePath === null || runtimeLocation === null) {
    return null;
  }
  return {
    modelPath,
    voicePath,
    runtimeLocation,
    voice: trimmed(env[ONNX_VOICE_NAME_ENV]) ?? voiceFromPackPath(voicePath),
  };
};
