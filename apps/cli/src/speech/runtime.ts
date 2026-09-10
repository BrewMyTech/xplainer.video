/**
 * The ONNX Runtime seam: the four things this package uses of it, and how one is loaded from a
 * path rather than from `node_modules`.
 *
 * **Why a path and not a dependency** (plan D7). `onnxruntime-node` declares no
 * `optionalDependencies`: one npm package carries every platform's binaries — darwin 85 MB,
 * linux 68 MB, win32 132 MB, 285 MB in total — so depending on it would put three platforms into
 * `@xplainer/cli`'s tarball and into payload 1's closure, and every user would download two they
 * cannot run. So the runtime is a **toolchain component `setup` acquires for the host platform
 * only, pinned by digest, exactly as Chrome is**, and this module is the one place that turns the
 * recorded location into a callable module.
 *
 * **The types are structural, not imported.** There is no `import type` from `onnxruntime-node`
 * here, deliberately: a type-only import would make the package a devDependency of this member and
 * a declaration this package emits would reference it, which is how an "acquired, not depended on"
 * component quietly becomes a dependency again. Declaring the four members this code actually uses
 * costs twenty lines and keeps `package.json` honest — and it is what lets every test below the
 * real-inference one drive a fake runtime instead of a 92 MB model.
 *
 * **Loading is `createRequire`, not `import()`.** `onnxruntime-node` is CommonJS whose entry
 * re-exports `onnxruntime-common` with `__exportStar`; a dynamic `import()` of it gives a namespace
 * whose named exports depend on what cjs-module-lexer could statically see through that re-export,
 * so `Tensor` may or may not be there. `require()` returns `module.exports` itself, which always
 * has both. Node's CJS resolution also handles a *directory* — it reads `package.json`'s `main` —
 * so the recorded location may be either the package directory or an entry file, and neither case
 * needs code here.
 */

import { createRequire } from "node:module";
import { OnnxSpeechError } from "./errors.js";

/** A tensor, as much of one as this package reads back out of a run. */
export type OnnxTensor = {
  /** Row-major shape. `waveform` is `[1, n]`; `durations` is `[1, seq]`. */
  readonly dims: readonly number[];
  /** The values, in whatever typed array matches the tensor's element type. */
  readonly data: ArrayLike<number>;
};

/** The inputs of one `session.run`, by the graph's own input names. */
export type OnnxFeeds = Readonly<Record<string, OnnxTensor>>;

/** A loaded inference session. */
export type OnnxInferenceSession = {
  run(feeds: OnnxFeeds): Promise<Readonly<Record<string, OnnxTensor>>>;
};

/**
 * The runtime module itself.
 *
 * `Tensor` is declared as a constructor over the three element types this code constructs —
 * `int64` from a `BigInt64Array`, `float32` from a `Float32Array` — rather than over the runtime's
 * full union, so passing the wrong pair is a compile error here instead of a `TypeError` inside the
 * addon.
 */
export type OnnxRuntimeModule = {
  readonly InferenceSession: {
    create(
      path: string,
      options?: { executionProviders?: readonly string[] },
    ): Promise<OnnxInferenceSession>;
  };
  readonly Tensor: new (
    type: "int64" | "float32",
    data: BigInt64Array | Float32Array,
    dims: readonly number[],
  ) => OnnxTensor;
};

/** Resolved against this module, so an absolute `location` bypasses it entirely. */
const requireFrom = createRequire(import.meta.url);

/**
 * Load the ONNX Runtime that `setup` acquired at `location`.
 *
 * @param location the package directory or entry file the toolchain recorded
 *
 * @throws {OnnxSpeechError} `RUNTIME_UNAVAILABLE` when nothing loadable is there, or when what
 *   loaded is not a runtime. Both name the location, because the only repair is `xplainer setup`
 *   and the message is the whole of what a reader of a failed job poll gets.
 */
export function loadOnnxRuntime(location: string): OnnxRuntimeModule {
  let loaded: unknown;
  try {
    loaded = requireFrom(location);
  } catch (error) {
    throw new OnnxSpeechError(
      "RUNTIME_UNAVAILABLE",
      `no ONNX Runtime at ${location} (${error instanceof Error ? error.message : String(error)}). ` +
        "Run `xplainer setup` to acquire it for this platform.",
    );
  }
  return assertRuntime(loaded, location);
}

/**
 * Check that `loaded` is a runtime before a session is asked for.
 *
 * Exported so the fake runtimes the tests drive are held to the same shape as the real one: a fake
 * that drifted out of the interface would make every test above it green against a module the
 * production loader would reject.
 */
export function assertRuntime(loaded: unknown, location: string): OnnxRuntimeModule {
  const candidate = loaded as Partial<OnnxRuntimeModule> | null;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof candidate.Tensor !== "function" ||
    typeof candidate.InferenceSession?.create !== "function"
  ) {
    throw new OnnxSpeechError(
      "RUNTIME_UNAVAILABLE",
      `${location} loaded, but it is not an ONNX Runtime: a module with InferenceSession.create ` +
        "and Tensor is needed.",
    );
  }
  return candidate as OnnxRuntimeModule;
}
