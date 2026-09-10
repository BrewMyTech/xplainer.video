/**
 * A real `toolchain.json` and a real workspace manifest, for the tests of everything downstream.
 *
 * The gate `setup/toolchain.ts` applies is a judgement over two documents and two paths, and every
 * caller of it — the worker factory, the backend, `/healthz` — has tests whose subject is something
 * else entirely. This module stands the two documents up so those tests can say "a machine where
 * setup has run" in one line, without any of them acquiring a browser.
 *
 * **Nothing here is a stub of the thing under test.** The marker written is the marker `setup`
 * writes, validated by the same reader; the stand-in files it points at are real files whose real
 * digests are recorded; and the workspace manifest carries the template's **own** pins, read from
 * `@xplainer/render-core`, so a test that passes here is a test that would pass against a workspace
 * `npm ci` produced. What is absent is the ~200 MB of bytes, which is the one part no assertion in
 * those suites is about.
 *
 * `tsconfig.build.json` excludes `src/**\/testing/**`, so none of this compiles into `dist/` or
 * reaches a tarball.
 */

import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import type { Toolchain, ToolchainComponent } from "@xplainer/protocol";
import { hashFile, MANIFEST_VERSION, WORKSPACE_MANIFEST_FILE } from "../../runtime/manifest.js";
import { readTemplatePins } from "../../runtime/verify.js";
import { STYLE_DIMENSION } from "../../speech/index.js";
import { KOKORO_IMAGE } from "../providers/speech-docker.js";
import {
  ONNX_DIR_NAME,
  ONNX_PROVIDER,
  ONNX_RUNTIME_DIR,
  ONNX_SPEECH_VERSION,
  ONNX_VOICES_DIR,
} from "../providers/speech-onnx.js";
import { TOOLCHAIN_FORMAT_VERSION, writeToolchainMarker } from "../toolchain.js";

/** Where the stand-ins go, matching what `commands/setup.ts` uses for real acquisitions. */
export const TEST_TOOLCHAIN_DIR = "toolchain";

/**
 * Rows in a real Kokoro voice pack, so the stand-in is the shape the acquired file is.
 *
 * `readVoicePack` accepts any whole number of 256-float rows, so a route test would pass with one
 * row; the pack is written at full size anyway because a helper that says "a machine where setup has
 * run" should not hand the suites downstream a file no acquisition could produce.
 */
const REAL_VOICE_PACK_ROWS = 510;

/** What {@link recordTestToolchain} was asked to record. */
export type TestToolchainOptions = {
  stateDir: string;
  /** The workspace root the marker's `workspace` half describes. */
  workspaceRoot: string;
  /** Override any field of the marker, for a test whose subject is one broken field. */
  overrides?: Partial<Toolchain>;
  /**
   * Resolved versions for the workspace manifest.
   *
   * Defaults to the template's own pins, which is the case that passes. A test about staleness
   * passes a map that disagrees with one of them.
   */
  resolved?: Record<string, string>;
  /**
   * The template pins the workspace was resolved **for**.
   *
   * Defaults to the template's own, which is the case that passes. A test about a daemon update
   * that changed a pin passes a map that disagrees with one of them — that, and not `resolved`, is
   * what the runtime gate compares, because it is the half an update changes.
   */
  pins?: Record<string, string>;
  /** `<platform>-<arch>` the workspace claims. Defaults to this machine's, which is what passes. */
  platform?: string;
  arch?: string;
};

/** Write a complete, passing toolchain: two stand-in artefacts, a workspace manifest, the marker. */
export function recordTestToolchain(options: TestToolchainOptions): Toolchain {
  const toolchainDir = join(options.stateDir, TEST_TOOLCHAIN_DIR);
  const chromePath = writeStandIn(join(toolchainDir, "chrome-headless-shell", "headless_shell"));
  const speechPath = writeStandIn(join(toolchainDir, "speech", "docker.json"));
  writeTestWorkspaceManifest(options);

  const marker: Toolchain = {
    format_version: TOOLCHAIN_FORMAT_VERSION,
    created_at: new Date().toISOString(),
    chrome: {
      version: "149.0.7790.0",
      path: chromePath,
      sha256: hashFile(chromePath),
      provider: "remotion",
    },
    speech: {
      version: KOKORO_IMAGE,
      path: speechPath,
      sha256: hashFile(speechPath),
      provider: "docker",
    },
    workspace: {
      platform: `${options.platform ?? process.platform}-${options.arch ?? process.arch}`,
      version: "1.0.0",
    },
    ...options.overrides,
  };
  writeToolchainMarker(options.stateDir, marker);
  return marker;
}

/**
 * Write the workspace manifest half on its own.
 *
 * Separate from the marker because the two documents fail independently: a workspace can go stale
 * under a marker that is perfectly fine, which is the case `checkToolchain`'s second reason exists
 * for.
 */
export function writeTestWorkspaceManifest(options: TestToolchainOptions): string {
  const file = join(options.workspaceRoot, WORKSPACE_MANIFEST_FILE);
  mkdirSync(options.workspaceRoot, { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        kind: "workspace",
        manifest_version: MANIFEST_VERSION,
        created_at: new Date().toISOString(),
        platform: options.platform ?? process.platform,
        arch: options.arch ?? process.arch,
        node_version: process.version,
        npm_version: "11.0.0",
        installer: "npm ci",
        pins: options.pins ?? readTemplatePins(),
        resolved: options.resolved ?? readTemplatePins(),
        remotion_entry: "node_modules/@remotion/cli/remotion-cli.js",
        files: [],
        links: [],
      },
      null,
      2,
    )}\n`,
  );
  return file;
}

/**
 * The `onnx` speech component, in the layout the provider commits and the marker records.
 *
 * For the route-selection suites: `resolveSpeech()` reads the marker and turns a recorded `onnx`
 * component back into three paths (`setup/speech-locate.ts`), and every one of those has to be a
 * real file, because the synthesiser validates them at construction. So the model and the two
 * runtime witnesses are stand-ins and the **voice pack is real bytes** — 510 rows of 256 float32,
 * which is the shape `readVoicePack` refuses anything else for.
 *
 * What is absent is the 204 MB and the graph itself. Nothing in a route test opens the model: the
 * session is opened lazily by the first segment, and a test about *which route was chosen* never
 * synthesises. `pnpm e2e:speech` is where a real acquisition speaks.
 *
 * @param stateDir the state directory whose `toolchain/` the component is written under
 * @returns the component, ready to pass as `recordTestToolchain`'s `overrides.speech`
 */
export function recordTestOnnxSpeech(stateDir: string): ToolchainComponent {
  const root = join(stateDir, TEST_TOOLCHAIN_DIR, `${ONNX_DIR_NAME}-${ONNX_SPEECH_VERSION}`);
  const modelPath = writeStandIn(join(root, "model_quantized.onnx"));
  const voicePath = join(root, ONNX_VOICES_DIR, "af_heart.bin");
  mkdirSync(dirname(voicePath), { recursive: true });
  writeFileSync(voicePath, Buffer.alloc(REAL_VOICE_PACK_ROWS * STYLE_DIMENSION * 4));
  const runtimeRoot = join(root, ...ONNX_RUNTIME_DIR.split("/"));
  const loader = writeStandIn(join(runtimeRoot, "dist", "index.js"));
  const binding = writeStandIn(
    join(runtimeRoot, "bin", "napi-v6", process.platform, process.arch, "onnxruntime_binding.node"),
  );

  return {
    version: ONNX_SPEECH_VERSION,
    path: modelPath,
    sha256: hashFile(modelPath),
    provider: ONNX_PROVIDER,
    files: [modelPath, voicePath, loader, binding].map((path) => ({
      path,
      sha256: hashFile(path),
      bytes: statSync(path).size,
    })),
  };
}

/** One real file at `path`, so the marker's existence check has something to find. */
function writeStandIn(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `stand-in for a test, written by setup/testing/toolchain.ts\n`);
  return path;
}
