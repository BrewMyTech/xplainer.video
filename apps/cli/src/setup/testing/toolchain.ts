/**
 * A real `toolchain.json`, for the tests of everything downstream.
 *
 * The gate `setup/toolchain.ts` applies is a judgement over one document and the paths it records,
 * and every caller of it — the worker factory, the backend, `/healthz` — has tests whose subject is
 * something else entirely. This module stands the document up so those tests can say "a machine
 * where setup has run" in one line, without any of them acquiring a browser.
 *
 * **Nothing here is a stub of the thing under test.** The marker written is the version-2 marker
 * `setup` writes, validated by the same reader, and the stand-in files it points at are real files
 * whose real digests are recorded. What is absent is the ~200 MB of bytes, which is the one part no
 * assertion in those suites is about.
 *
 * **The ffmpeg it records is a real one, found by a lookup that exists only here.** The render
 * worker spawns the marker's `ffmpeg.path` and nothing else — `render/encode.ts` no longer searches
 * `PATH` or the Homebrew directories (ADR 0031 §Note, 2026-11-12, D6) — so a suite that renders
 * needs a marker recording an encoder that runs. {@link findTestFfmpeg} is that search, in test code
 * only: `XPLAINER_FFMPEG`, then `PATH`, then `/opt/homebrew/bin` and `/usr/local/bin`, which is
 * what `ci.yml`'s `apt-get install ffmpeg` and a developer's Homebrew provide. The binary is
 * **copied** into the state directory, so a case that removes or replaces `marker.ffmpeg.path`
 * touches a file this suite made and never the machine's own; and it is asked the provider's own
 * probe, so `libavcodec`, the licence and `probe` are what that binary really says. A machine with
 * no ffmpeg at all gets a stand-in, which every gate test is content with and which a real render
 * — gated on `XPLAINER_SKIP_RENDER_TEST` — would fail on by name.
 *
 * `tsconfig.build.json` excludes `src/**\/testing/**`, so none of this compiles into `dist/` or
 * reaches a tarball.
 */

import { chmodSync, copyFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";
import type { Toolchain, ToolchainComponent, ToolchainFfmpeg } from "@xplainer/protocol";
import { FFMPEG_ENV, isExecutableFile } from "../../render/encode.js";
import { hashFile } from "../../runtime/manifest.js";
import { STYLE_DIMENSION } from "../../speech/index.js";
import { CHROME_PROVIDER } from "../providers/chrome.js";
import {
  FFMPEG_PATH_PROVIDER,
  licenceFromBuildconf,
  licenceFromStatement,
  type ProbedFfmpeg,
  probeFfmpeg,
} from "../providers/ffmpeg.js";
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
  /** Override any field of the marker, for a test whose subject is one broken field. */
  overrides?: Partial<Toolchain>;
  /**
   * Whether the marker records an ffmpeg. `true` by default — a machine where setup has run has
   * one — and `false` for the cases whose subject is a marker without it (ADR 0031 §Note,
   * 2026-11-12, D12): a still still works there, and a render is refused.
   */
  ffmpeg?: boolean;
};

/** Where Homebrew and a hand-built install put ffmpeg, asked after `PATH`. Test code only. */
const TEST_FFMPEG_DIRECTORIES: readonly string[] = ["/opt/homebrew/bin", "/usr/local/bin"];

/**
 * A real ffmpeg on this machine, for the suites that encode — or `null` where there is none.
 *
 * The search the renderer itself stopped making, kept here because a test machine is exactly the
 * place where "whatever ffmpeg is installed" is the right answer: `XPLAINER_FFMPEG` when it names an
 * executable, else the first on `PATH`, else the two well-known directories.
 */
export function findTestFfmpeg(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const named = env[FFMPEG_ENV]?.trim();
  if (named !== undefined && named !== "") {
    return isExecutableFile(named) ? named : null;
  }
  const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const directories = (env.PATH ?? env.Path ?? "").split(delimiter).filter((entry) => entry !== "");
  for (const directory of [...directories, ...TEST_FFMPEG_DIRECTORIES]) {
    const candidate = join(directory, name);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** One probe per binary per process: the suites call the writer in every `beforeEach`. */
const probedBinaries = new Map<string, ProbedFfmpeg | null>();

function probedOnce(binary: string): ProbedFfmpeg | null {
  const key = `${binary}:${String(statSync(binary).size)}`;
  if (!probedBinaries.has(key)) {
    try {
      probedBinaries.set(key, probeFfmpeg(binary));
    } catch {
      probedBinaries.set(key, null);
    }
  }
  return probedBinaries.get(key) ?? null;
}

/**
 * The ffmpeg component, over a copy of {@link findTestFfmpeg}'s binary inside the state directory —
 * or over a stand-in where this machine has none that answers the probe.
 *
 * Recorded the way `setup --ffmpeg-path` records one: provider `path`, the copy's own digest, its
 * licence as the binary states it, and no publisher.
 */
export function recordTestFfmpeg(stateDir: string): ToolchainFfmpeg {
  const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const path = join(stateDir, TEST_TOOLCHAIN_DIR, "ffmpeg", name);
  const found = findTestFfmpeg();
  const probed = found === null ? null : probedOnce(found);
  mkdirSync(dirname(path), { recursive: true });
  if (found !== null && probed !== null) {
    copyFileSync(found, path);
  } else {
    writeStandIn(path);
  }
  // Executable either way, as everything setup records as an ffmpeg is: the gate stats the bit.
  chmodSync(path, 0o755);
  const sha256 = hashFile(path);
  const probe = probed?.probe ?? {
    version: ["ffmpeg version stand-in", "libavcodec     62. 11.100 / 62. 11.100"],
    buildconf: ["  configuration:", "    --enable-gpl", "    --enable-libx264"],
    license: ["a stand-in, written by setup/testing/toolchain.ts"],
  };
  return {
    version: probed?.version ?? "stand-in",
    path,
    sha256,
    provider: FFMPEG_PATH_PROVIDER,
    files: [{ path, sha256, bytes: statSync(path).size }],
    libavcodec: probed?.libavcodec ?? "62.11.100",
    licence: licenceFromStatement(probe.license) ?? licenceFromBuildconf(probe.buildconf),
    probe,
  };
}

/**
 * Write a complete, passing toolchain: two stand-in artefacts, a real ffmpeg, and the marker that
 * records them.
 */
export function recordTestToolchain(options: TestToolchainOptions): Toolchain {
  const toolchainDir = join(options.stateDir, TEST_TOOLCHAIN_DIR);
  const chromePath = writeStandIn(join(toolchainDir, "chrome-headless-shell", "headless_shell"));
  const speechPath = writeStandIn(join(toolchainDir, "speech", "docker.json"));

  const marker: Toolchain = {
    format_version: TOOLCHAIN_FORMAT_VERSION,
    created_at: new Date().toISOString(),
    chrome: {
      version: "157.0.8103.50",
      path: chromePath,
      sha256: hashFile(chromePath),
      provider: CHROME_PROVIDER,
    },
    speech: {
      version: KOKORO_IMAGE,
      path: speechPath,
      sha256: hashFile(speechPath),
      provider: "docker",
    },
    ...(options.ffmpeg === false ? {} : { ffmpeg: recordTestFfmpeg(options.stateDir) }),
    ...options.overrides,
  };
  writeToolchainMarker(options.stateDir, marker);
  return marker;
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
