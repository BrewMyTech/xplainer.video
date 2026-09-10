/**
 * The locator that reads `toolchain.json`, which is how a machine that has run `setup` narrates
 * with the engine it acquired.
 *
 * `speech/locate.ts` declares {@link OnnxSpeechLocator} as a **function type** and says the marker's
 * reader lives in `src/setup/`, because the marker is this directory's document: `providers/
 * speech-onnx.ts` writes the component and `toolchain.ts` validates it, and neither of those is a
 * thing the synthesiser is allowed to know about. This module is the missing half — plan S5 — and it
 * is what closes the gap that made the engine reachable only by hand:
 *
 * **Until this existed, `resolveSpeech()` defaulted to `onnxSpeechFromEnvironment`, so the
 * in-process engine spoke only for a caller who set three variables.** `xplainer setup` acquires the
 * model, the voice and this platform's ONNX Runtime and writes all of it down; nothing then read
 * that record, so a daemon on a machine that had run `setup` fell through to the tts-client's
 * `localhost:8880` guess at a container that route exists to make unnecessary.
 * `scripts/e2e/speech.mjs` supplied the three variables itself, out of the marker `setup` had just
 * written, and its docblock named the three lines to delete once this landed. They are deleted.
 *
 * **The marker is read, never re-derived.** `speech.path` *is* the model graph — that is the field
 * every other reader already looks at — and the voice pack comes out of the component's own
 * `files[]` rather than from a filename this module guesses. The one thing taken from the layout
 * instead of from the record is the runtime directory, because a tree arrives in one `rename` and is
 * recorded by a witness inside it rather than by its root; {@link ONNX_RUNTIME_DIR} is exported from
 * the provider that puts it there so the two cannot drift.
 *
 * **A route that is absent falls through; a route that is broken raises** (plan D5). A marker
 * recording any other provider — `docker`, `url`, `bundle` — is an absence here: this machine
 * narrates the way it always did, and returning `null` is what lets `resolveSpeech()` carry on to
 * the tts-client's own resolution. A marker recording `onnx` whose artefacts have been cleaned away
 * is **not** an absence: `createOnnxSynthesiser` refuses it by name and the narration job fails
 * saying which path is missing and that `xplainer setup` restores it. Falling through there would
 * narrate against a server nobody is running and report a connection error about a route the machine
 * was not using.
 */

import { dirname, join } from "node:path";
import type { Toolchain, ToolchainComponent } from "@xplainer/protocol";
import { resolveStateDir } from "../daemon/state-dir.js";
import {
  OnnxSpeechError,
  type OnnxSpeechLocator,
  type OnnxSpeechPaths,
  onnxSpeechFromEnvironment,
  voiceFromPackPath,
} from "../speech/index.js";
import { ONNX_PROVIDER, ONNX_RUNTIME_DIR, ONNX_VOICES_DIR } from "./providers/speech-onnx.js";
import { readToolchainMarker, toolchainMarkerPath } from "./toolchain.js";

/**
 * The three paths a recorded `onnx` component names, or `null` for a component that is not one.
 *
 * @param component the marker's `speech` component, exactly as it was read from disk
 * @param markerPath the marker's own path, which is what the provenance line and the refusal name —
 *   "the in-process engine" is two different facts (see `speech/locate.ts`), and a message that did
 *   not say which record it came from would send a reader to look at the wrong machine.
 */
export function onnxSpeechFromComponent(
  component: ToolchainComponent,
  markerPath: string,
): OnnxSpeechPaths | null {
  if (component.provider !== ONNX_PROVIDER) {
    return null;
  }
  const root = dirname(component.path);
  const voicePath = recordedVoice(component, root);
  if (voicePath === null) {
    throw new OnnxSpeechError(
      "VOICE_UNREADABLE",
      `${markerPath} records the ${ONNX_PROVIDER} speech route and names no voice pack under ` +
        `${join(root, ONNX_VOICES_DIR)}. The route needs a pack to speak with, and guessing a ` +
        "filename would speak the narration in whatever voice happened to be there. Run " +
        "`xplainer setup` to record the component again.",
    );
  }
  return {
    modelPath: component.path,
    voicePath,
    voice: voiceFromPackPath(voicePath),
    runtimeLocation: join(root, ...ONNX_RUNTIME_DIR.split("/")),
    origin: `recorded by setup in ${markerPath}`,
  };
}

/**
 * The first voice pack the component records, or `null` when it records none.
 *
 * The **first** is not an arbitrary choice today and this is where it stops being one if that
 * changes: `ONNX_VOICES` acquires exactly one pack, deliberately, because nothing in the tool
 * contract can select a voice (`providers/speech-onnx.ts` §One voice). A second entry there would
 * make this function the place that has to decide which pack a narration gets, and the narration
 * document's own `voice` field is the only honest input to that decision.
 */
function recordedVoice(component: ToolchainComponent, root: string): string | null {
  const voicesDir = join(root, ONNX_VOICES_DIR);
  return (
    (component.files ?? []).map((file) => file.path).find((path) => dirname(path) === voicesDir) ??
    null
  );
}

/**
 * The locator `resolveSpeech()` defaults to: the three variables if they are set, else the marker.
 *
 * The environment is asked first for the reason `speech/locate.ts` gives — three explicit paths are
 * an instruction and the marker is a discovery — and the state directory comes from the same
 * `XPLAINER_STATE_DIR` precedence every other reader uses, so a worker spawned by a
 * `serve --state-dir …` daemon reads that daemon's marker: `daemon/workers.ts` puts the resolved
 * directory into the narration worker's environment for exactly this call.
 */
export const onnxSpeechFromToolchain: OnnxSpeechLocator = (env) => {
  const named = onnxSpeechFromEnvironment(env);
  if (named !== null) {
    return named;
  }
  const stateDir = resolveStateDir(env);
  const marker: Toolchain | null = readToolchainMarker(stateDir);
  if (marker === null) {
    return null;
  }
  return onnxSpeechFromComponent(marker.speech, toolchainMarkerPath(stateDir));
};
