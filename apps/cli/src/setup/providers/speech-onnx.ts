/**
 * The `onnx` speech provider: everything the in-process synthesiser needs, and nothing else.
 *
 * This is the route that removes the container, the Python closure and the GPL question at once —
 * `.omc/plans/ralplan-speech-onnx.md` §1 — and it acquires **four** artefacts, each pinned by
 * digest and each fetched from its own upstream home, because D2 says we host nothing:
 *
 * | Artefact | Bytes | From |
 * |---|---|---|
 * | `onnx/model_quantized.onnx` (Kokoro-82M int8, Apache-2.0) | 92,361,055 | HuggingFace, at a pinned revision |
 * | `voices/af_heart.bin` (a `[510,1,256]` style tensor) | 522,240 | the same revision |
 * | `onnxruntime-node` 1.29.0 (MIT) | 111,735,068 | the npm registry |
 * | `onnxruntime-common` 1.29.0 (MIT) | 66,604 | the npm registry |
 *
 * ## D7 — why the runtime is acquired rather than depended on
 *
 * Every number below was measured on 2026-09-10 and none of it is inference from a README.
 *
 * **1. Depending on `onnxruntime-node` puts five platforms in payload 1.** It declares **no
 * `optionalDependencies`**: one package carries every platform's binaries under `bin/napi-v6/`,
 * 296,273,872 bytes unpacked — `darwin/arm64` 88,043,128, `linux/x64` 45,116,232,
 * `linux/arm64` 24,932,672, `win32/x64` 66,310,760, `win32/arm64` 71,871,080.
 * `runtime/assemble.ts` builds payload 1 out of `@xplainer/cli`'s **runtime dependency closure**,
 * so all five would travel in every payload and sit in every user's global `node_modules`. What it
 * would *not* change is `@xplainer/cli`'s own npm tarball: `package.json`'s `files` allowlist is
 * `dist/**` plus `LICENSE` and `NOTICE`, and a dependency is never inside a tarball. The spike's
 * note that it would is the one thing in it this module corrects.
 *
 * **2. Depending on it also downloads 183 MB at install, which `AC-1d` forbids.** Its
 * `package.json` declares `"postinstall": "node ./script/install"`, and `script/install-metadata.js`
 * lists `'linux/x64': ['cuda12']` — the CUDA execution-provider binaries, which are *not* bundled
 * because they are too large for the registry. The script fetches
 * `Microsoft.ML.OnnxRuntime.Gpu.Linux` from `api.nuget.org`; that package's own `Content-Length` is
 * **191,730,792 bytes**. So `npm i -g @xplainer/cli` on the commonest server platform would pull
 * 183 MB of GPU runtime nobody asked for, from a third feed, during an install — which is precisely
 * what ADR 0005 and `AC-1d` exist to prevent, and which cannot be turned off from here because the
 * flag (`--onnxruntime-node-install=skip`) lives in the *user's* npm invocation.
 *
 * **3. Microsoft's per-platform release archives cannot be used, and this was checked rather than
 * assumed.** `onnxruntime-linux-x64-1.29.0.tgz` (10.6 MB) contains `include/`, `lib/cmake/`,
 * `lib/pkgconfig/`, `lib/libonnxruntime.so.1.29.0` (28,497,752 bytes) and
 * `libonnxruntime_providers_shared.so` — and **no `onnxruntime_binding.node`**. The N-API binding
 * exists only inside the npm package. Nor could the two be mixed: the release library is a
 * different build from the npm one (28.5 MB against 44.7 MB on the same platform and version), and
 * a binding is compiled against the library it ships beside.
 *
 * **So the runtime is the npm tarball, fetched once and unpacked for this platform only.** The
 * trade, stated plainly: the same 111,735,068 bytes cross the wire either way — the registry serves
 * a tarball and there is no per-file URL and no way to seek into a gzip stream, and in any case
 * `download.ts` verifies the whole archive's digest before a byte of it is unpacked, which is the
 * order ADR 0005 requires — but what stays on disk is one platform instead of five, no CUDA
 * package is fetched from anywhere, payload 1 and the publish contract are untouched, and there is
 * no `postinstall` in the picture at all. On darwin-arm64 that is 88 MB kept out of 296 MB
 * available.
 *
 * **What is extracted, and why the JS glue comes too.** `bin/napi-v6/<platform>/<arch>/` is the
 * native half; `dist/` (22 KB) is Microsoft's own loader and it is taken **verbatim** rather than
 * reimplemented, because `dist/binding.js` is the file that knows to `require`
 * `../bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node` and to hand
 * `initOrtOnce` the `Tensor` constructor out of `onnxruntime-common`. Reimplementing that is a
 * private contract between two of somebody else's files, and it would be reimplemented again at
 * every version bump. `onnxruntime-common` is therefore acquired too, into
 * `runtime/node_modules/onnxruntime-common/`, which is where Node's own resolution looks when
 * `runtime/onnxruntime-node/dist/index.js` asks for it — so the loader works unmodified with no
 * `NODE_PATH`, no symlink and no dependency declared anywhere.
 *
 * Proven, not assumed: the trimmed tree loads through `createRequire` and runs the pinned model on
 * the pinned voice, answering `waveform[1,33600]` and `durations[1,9]` — 1.400 s of 24 kHz audio,
 * peak 0.4160, 740 ms — which is the signature `.omc/artifacts/spike-speech-onnx.md` records.
 *
 * **The redundant macOS library is kept, deliberately.** `bin/napi-v6/darwin/arm64/` ships
 * `libonnxruntime.1.dylib` and `libonnxruntime.1.29.0.dylib`, which are **byte-identical**
 * (both `3e4c6390…`), and `otool -L` shows the binding loading only `@rpath/libonnxruntime.1.dylib`
 * with `LC_RPATH = @loader_path`. Dropping the other would save 41,878,000 bytes on macOS and it is
 * not done: the extraction rule is then "this platform's subtree, verbatim" with no exception, so a
 * version bump cannot quietly leave a runtime that unpacks and will not load. The measurement is
 * here so that anyone who wants those 42 MB back has it in front of them rather than having to
 * rediscover it.
 *
 * **darwin-x64 is refused by name.** The package ships five platform subtrees and `darwin/x64` is
 * not one of them, so an Intel Mac has no ONNX runtime at all — not a slow one, none. That is a
 * sentence a user meets before anything is fetched, and it is why this route reports itself
 * *unavailable* there and lets `providers/speech.ts` carry on to the next one.
 *
 * ## One voice, and why not several
 *
 * `af_heart` and nothing else. A voice is 522,240 bytes — `510 × 256 × 4`, one style vector per
 * token position — so the cost of a second is trivial and that is not the argument. The argument is
 * that **nothing can select one**: the tool contract is eight fixed tools with fixed schemas
 * (`AC-9b`), `explainer_narrate` takes no voice, and a voice no caller can name is 0.5 MB of
 * unreachable bytes plus a digest somebody has to review. Adding one later is two lines in
 * {@link ONNX_VOICES} and a reviewed digest, on a `setup` that is re-runnable by design — so the
 * cost of starting with one is a re-run, and the cost of starting with five is five reviews for a
 * feature that does not exist.
 *
 * ## The layout, and what the marker records
 *
 * ```
 * <toolchain>/speech-onnx-<version>/
 *   model_quantized.onnx                                  a plain file, no archive
 *   voices/af_heart.bin                                   a plain file, no archive
 *   runtime/onnxruntime-node/                             one atomic rename, with its own receipt
 *     package.json  dist/  bin/napi-v6/<platform>/<arch>/
 *   runtime/node_modules/onnxruntime-common/              one atomic rename, with its own receipt
 *     package.json  dist/
 * ```
 *
 * `toolchain.json`'s `speech.path` is **the model graph**, because it is the one artefact whose
 * absence means there is no speech at all and the field is what every existing reader — the install
 * preflight's existence check, `setup/toolchain.ts`'s gate — already looks at. The rest of the
 * component is `speech.files`, the optional array added to the schema for this: the model, the
 * voice, every file in this platform's `bin/napi-v6` subtree, and one witness inside each of the
 * two committed trees. A witness is enough for a tree because a tree arrives in one `rename`; a
 * per-file inventory of a whole `dist/` would be a tree inventory, which the schema's own wording
 * says the field is not.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ToolchainComponent, ToolchainFile } from "@xplainer/protocol";
import { hashFile } from "../../runtime/manifest.js";
import { type AcquiredExpectation, stageAcquired, verifyAcquired } from "../acquired.js";
import { type ArchiveFormat, acquireArtefact, acquireFile, WORK_DIR_NAME } from "../download.js";
import { type HostProbe, probeHost, speechPlatformKey } from "../manifest.js";
import { assertTarballArtefact, extractTarGz, type TarSelector } from "../tar.js";

/** The `provider` token the marker records for this route. */
export const ONNX_PROVIDER = "onnx";

/** The directory name, under the toolchain directory, one acquisition commits itself under. */
export const ONNX_DIR_NAME = "speech-onnx";

/**
 * The HuggingFace repository the weights come from, and the commit that is pinned.
 *
 * A revision and never a branch: `resolve/main` is a moving target, and ADR 0005's whole premise is
 * that what `setup` fetches is reviewed. Apache-2.0 both for the Kokoro architecture and for these
 * exported weights, which is the licence fact the whole plan turns on (§1).
 */
export const KOKORO_REPO = "onnx-community/Kokoro-82M-v1.0-ONNX-timestamped";

/** The pinned commit. `.omc/artifacts/spike-speech-onnx.md` measured against exactly this one. */
export const KOKORO_REVISION = "dd4401a9add81ac692d20e240d22ec9dda82cc29";

/** The ONNX Runtime release both npm packages are at. MIT. */
export const ONNX_RUNTIME_VERSION = "1.29.0";

/**
 * The component's `version`: the model line, the pinned revision and the runtime, in one string.
 *
 * One string because the marker records one, and it names all three because all three decide what
 * is on the disk — a component whose version said only `1.0` could not distinguish a tree acquired
 * before a runtime bump from one acquired after. The schema's rule is that a version is compared as
 * a string and never parsed, which is what makes a composite one legitimate here. It is also the
 * directory suffix, so the digest-and-pin identity is visible in the path.
 */
export const ONNX_SPEECH_VERSION: string = `kokoro-1.0-${KOKORO_REVISION.slice(0, 8)}-ort-${ONNX_RUNTIME_VERSION}`;

/** What to fetch, what it must hash to, and how long it is. Reviewed values, never recorded ones. */
export type PinnedArtefact = AcquiredExpectation;

/** The model graph. int8, and the one export that emits `pred_dur` — hence this whole plan. */
export const ONNX_MODEL: PinnedArtefact = {
  url: huggingFaceUrl("onnx/model_quantized.onnx"),
  sha256: "c0c02b3299fd97c34ea92a98e6d41eaa1a739c8f77bf685aac34bd7b34c1132c",
  size: 92_361_055,
};

/** The voices acquired, keyed by the name they keep on disk. Exactly one — see the docblock. */
export const ONNX_VOICES: Readonly<Record<string, PinnedArtefact>> = {
  "af_heart.bin": {
    url: huggingFaceUrl("voices/af_heart.bin"),
    sha256: "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b",
    size: 522_240,
  },
};

/** The npm tarball carrying the native binding and Microsoft's own loader. */
export const ONNX_RUNTIME_PACKAGE: PinnedArtefact = {
  url: `https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-${ONNX_RUNTIME_VERSION}.tgz`,
  sha256: "cfdfb45ec4044b1fdca43e5d2e180fb6817e649ff8ad1e0dfc90e18e51b67037",
  size: 111_735_068,
};

/** The pure-JavaScript half the loader requires by name. No native code, no install script. */
export const ONNX_COMMON_PACKAGE: PinnedArtefact = {
  url: `https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-${ONNX_RUNTIME_VERSION}.tgz`,
  sha256: "9b56a571348dc0e980f939b88989864946148d8500cbd0957534975389a1743b",
  size: 66_604,
};

/**
 * The `<platform>/<arch>` subtrees `onnxruntime-node` 1.29.0 actually ships.
 *
 * Listed from the archive rather than assumed from `package.json`'s `"os"` field, which claims all
 * three operating systems and says nothing about architectures: there is **no `darwin/x64`**, so a
 * platform this set does not name has no runtime and the route says so.
 */
export const ONNX_RUNTIME_PLATFORMS: readonly string[] = [
  "darwin/arm64",
  "linux/arm64",
  "linux/x64",
  "win32/arm64",
  "win32/x64",
];

/** Where each acquisition lands under the component directory, `/`-separated. */
const MODEL_FILE = "model_quantized.onnx";
const RUNTIME_COMMON_DIR = "runtime/node_modules/onnxruntime-common";

/**
 * The two locations a **reader** of the marker has to know, exported for that one caller.
 *
 * `setup/speech-locate.ts` turns a recorded `onnx` component back into the three paths the
 * synthesiser takes, and the marker records only the model as `path` — so the voice pack and the
 * runtime are found by this layout. They are exported rather than restated there because a layout
 * written down twice is a layout that drifts: this module is what puts the files here, and a rename
 * of either directory then breaks the reader at compile time instead of at the first narration.
 */
export const ONNX_VOICES_DIR = "voices";
export const ONNX_RUNTIME_DIR = "runtime/onnxruntime-node";

/** The loader's own entry, and the witness for the tree it is in. */
const RUNTIME_NODE_ENTRY = "dist/index.js";

/** `onnxruntime-common`'s CommonJS entry, which is the condition the loader resolves. */
const RUNTIME_COMMON_ENTRY = "dist/cjs/index.js";

/** Why this machine has no ONNX speech route. */
export type OnnxUnavailableReason = "unsupported-platform";

/**
 * The ONNX route is not available here, and nothing was fetched.
 *
 * The same shape as `DockerUnavailable`, and for the same reason `providers/speech.ts` needs it to
 * be: an *absent* route falls through to the next one, a *failed* route raises. A platform with no
 * published binding is an absence — there is nothing on this machine to fix — so it is this class
 * and not an error.
 */
export class OnnxUnavailable extends Error {
  readonly reason: OnnxUnavailableReason;

  constructor(reason: OnnxUnavailableReason, message: string) {
    super(message);
    this.name = "OnnxUnavailable";
    this.reason = reason;
  }
}

/** The acquisition was attempted and did not complete; nothing incomplete has been recorded. */
export class OnnxSpeechRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnnxSpeechRefusal";
  }
}

/** What {@link acquireSpeechOnnx} was asked to do. */
export type AcquireOnnxOptions = {
  /** Where acquisitions live on this machine — `<state>/toolchain`, as `setup` resolves it. */
  toolchainDir: string;
  probe?: HostProbe | undefined;
  log?: (line: string) => void;
  /**
   * The four pinned artefacts, so a test can point them at a loopback server.
   *
   * A parameter and not a constant read at the call site, because every failure this provider owes
   * a name to — a digest that does not match, a resume the server did not honour, a partial that is
   * deleted rather than resumed onto — is a *server* behaviour, and this package's rule is that
   * those are proved against `setup/testing/artefact-server.ts` and never against a double.
   */
  pins?: OnnxPins | undefined;
};

/** The four artefacts, as one value a caller can substitute whole. */
export type OnnxPins = {
  model: PinnedArtefact;
  voices: Readonly<Record<string, PinnedArtefact>>;
  runtime: PinnedArtefact;
  common: PinnedArtefact;
  /**
   * The runtime tarball's platform key, when a test needs one its fixture actually carries.
   *
   * Defaults to the host's. It exists so the extraction rule — one platform out of five — can be
   * exercised on a machine that is only ever one of them.
   */
  platform?: string | undefined;
};

/** The pinned set this build ships. */
export const ONNX_PINS: OnnxPins = {
  model: ONNX_MODEL,
  voices: ONNX_VOICES,
  runtime: ONNX_RUNTIME_PACKAGE,
  common: ONNX_COMMON_PACKAGE,
};

/** What one acquisition produced, in the shape `toolchain.json` records. */
export type AcquiredSpeechOnnx = {
  component: ToolchainComponent;
  /** The component directory, which is what a re-run finds already committed. */
  destination: string;
  /** Whether this call fetched anything, or found every artefact already there and verified. */
  fetched: boolean;
};

/**
 * Acquire the model, the voice and this platform's runtime, or refuse having recorded nothing.
 *
 * Idempotent in the way `setup` needs: a re-run over a complete component **re-verifies** it and
 * records what it checked, and a re-run over a partial one finishes the artefacts that are missing.
 * The distinction that matters is that no branch here records a digest it did not observe this run
 * — the two plain files are re-hashed against their reviewed digests, and each committed tree is
 * judged by `acquired.ts` against the digest its own receipt says it was admitted on.
 */
export async function acquireSpeechOnnx(options: AcquireOnnxOptions): Promise<AcquiredSpeechOnnx> {
  const log = options.log ?? ((): void => {});
  const probe = options.probe ?? probeHost();
  const pins = options.pins ?? ONNX_PINS;
  const platform = pins.platform ?? runtimePlatformKey(probe);
  const destination = join(options.toolchainDir, `${ONNX_DIR_NAME}-${ONNX_SPEECH_VERSION}`);
  mkdirSync(destination, { recursive: true });
  // One work directory for all four acquisitions, rather than the default sibling-of-each: the
  // four destinations are at three different depths, so the default would scatter partials — one
  // inside `voices/`, one beside the component — and a user looking for what a failed run left
  // would have to know the layout to find it. It is inside the component, so every commit is still
  // a `rename` on one filesystem.
  const workDir = join(destination, WORK_DIR_NAME);

  let fetched = false;
  const files: ToolchainFile[] = [];

  const modelPath = join(destination, MODEL_FILE);
  fetched = (await admitFile(pins.model, modelPath, "model", workDir, log, files)) || fetched;

  for (const [name, voice] of Object.entries(pins.voices)) {
    const voicePath = join(destination, ONNX_VOICES_DIR, name);
    fetched = (await admitFile(voice, voicePath, `voice ${name}`, workDir, log, files)) || fetched;
  }

  const runtimeRoot = join(destination, ...ONNX_RUNTIME_DIR.split("/"));
  const nativeDir = `bin/napi-v6/${platform}`;
  fetched =
    (await admitTree({
      artefact: pins.runtime,
      destination: runtimeRoot,
      label: `onnxruntime-node ${ONNX_RUNTIME_VERSION} (${platform})`,
      select: npmSelector(["dist/", `${nativeDir}/`], ["package.json"]),
      witnesses: (root) => [RUNTIME_NODE_ENTRY, ...nativeWitnesses(root, nativeDir)],
      workDir,
      log,
      files,
    })) || fetched;

  const commonRoot = join(destination, ...RUNTIME_COMMON_DIR.split("/"));
  fetched =
    (await admitTree({
      artefact: pins.common,
      destination: commonRoot,
      label: `onnxruntime-common ${ONNX_RUNTIME_VERSION}`,
      select: npmSelector(["dist/"], ["package.json"]),
      witnesses: () => [RUNTIME_COMMON_ENTRY],
      workDir,
      log,
      files,
    })) || fetched;

  assertComponentFiles(files, destination);
  return {
    component: {
      version: ONNX_SPEECH_VERSION,
      path: modelPath,
      sha256: pins.model.sha256,
      provider: ONNX_PROVIDER,
      files,
    },
    destination,
    fetched,
  };
}

/**
 * `<platform>/<arch>` as `onnxruntime-node` keys its `bin/napi-v6` subtrees, or a refusal.
 *
 * Node's own spelling, which is also the spelling `dist/binding.js` composes its `require` path
 * from — `${process.platform}/${process.arch}` — so there is no translation table here and there
 * must not be one: a key this function invented would resolve to a subtree the loader then looked
 * for somewhere else.
 */
export function runtimePlatformKey(probe: HostProbe): string {
  const key = `${probe.platform}/${probe.arch}`;
  if (!ONNX_RUNTIME_PLATFORMS.includes(key)) {
    throw new OnnxUnavailable(
      "unsupported-platform",
      `onnxruntime-node ${ONNX_RUNTIME_VERSION} publishes no native binding for ` +
        `${speechPlatformKey(probe)}. It ships ${ONNX_RUNTIME_PLATFORMS.join(", ")} and nothing ` +
        "else — notably no darwin/x64 — so the in-process speech path cannot run here at all, " +
        "rather than running slowly. Nothing was downloaded.",
    );
  }
  return key;
}

/** Which members of an npm tarball are wanted, and where they land. */
function npmSelector(prefixes: readonly string[], exact: readonly string[]): TarSelector {
  return (header) => {
    // npm publishes every member under a single `package/` root, which is stripped here rather
    // than by a `--strip-components` flag nobody would see.
    const inside = header.name.startsWith("package/") ? header.name.slice("package/".length) : null;
    if (inside === null || inside === "") {
      return null;
    }
    if (exact.includes(inside) || prefixes.some((prefix) => inside.startsWith(prefix))) {
      return inside;
    }
    return null;
  };
}

/** Every file in this platform's native subtree, as tree-relative witnesses. */
function nativeWitnesses(root: string, nativeDir: string): string[] {
  const absolute = join(root, ...nativeDir.split("/"));
  if (!existsSync(absolute)) {
    throw new OnnxSpeechRefusal(
      `${ONNX_RUNTIME_PACKAGE.url} matched its reviewed digest and does not contain ` +
        `${nativeDir}, so this build's platform table and that archive's contents disagree. ` +
        "Nothing was recorded.",
    );
  }
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `${nativeDir}/${entry.name}`)
    .sort();
}

/**
 * Admit one plain file: fetch it, or re-verify the one that is already there.
 *
 * A committed file that fails its reviewed digest is **refused and named**, never deleted and
 * refetched. `download.ts` deletes a *partial* on a mismatch because resuming onto wrong bytes
 * would re-download the same mismatch for ever; a file that has already been committed is a
 * different thing — it is what a render reads — and a digest that stopped matching means it was
 * changed after it was checked. Removing 92 MB of somebody's file on a guess about why is not
 * setup's decision to take.
 */
async function admitFile(
  artefact: PinnedArtefact,
  destination: string,
  label: string,
  workDir: string,
  log: (line: string) => void,
  files: ToolchainFile[],
): Promise<boolean> {
  if (existsSync(destination)) {
    const bytes = statSync(destination).size;
    const digest = bytes === artefact.size ? hashFile(destination) : null;
    if (digest !== artefact.sha256) {
      throw new OnnxSpeechRefusal(
        `speech: ${destination} is ${bytes} bytes hashing to ` +
          `${digest ?? "(not hashed: the length already disagrees)"} and the pinned ${label} is ` +
          `${artefact.size} bytes at ${artefact.sha256}. It has been changed since setup ` +
          `acquired it, so nothing was recorded. Remove ${destination} and run setup again.`,
      );
    }
    log(`speech: ${label} already acquired and verified at ${destination}`);
    files.push({ path: destination, sha256: artefact.sha256, bytes: artefact.size });
    return false;
  }
  log(`speech: ${artefact.url}`);
  log(`speech: expecting sha256 ${artefact.sha256} (${artefact.size} bytes)`);
  await acquireFile({ request: artefact, destination, workDir });
  files.push({ path: destination, sha256: artefact.sha256, bytes: artefact.size });
  return true;
}

/** What {@link admitTree} needs, named rather than a five-argument list. */
type AdmitTreeOptions = {
  artefact: PinnedArtefact;
  destination: string;
  label: string;
  select: TarSelector;
  /** The tree-relative witnesses, computed from the staged tree once it exists. */
  witnesses: (root: string) => readonly string[];
  /** Where the partial and the staging tree live — one directory for the whole component. */
  workDir: string;
  log: (line: string) => void;
  files: ToolchainFile[];
};

/**
 * Admit one npm tarball's selected subtree: unpack it, or re-verify the tree already there.
 *
 * The warm path is `acquired.ts`'s, which is the whole of the fix for the defect that route was
 * carrying: a populated destination is judged against the digest **its own receipt says it was
 * admitted on**, and a receipt that is missing, unreadable or names a different artefact is a
 * refusal rather than a free pass.
 */
async function admitTree(options: AdmitTreeOptions): Promise<boolean> {
  const { artefact, destination, label, files } = options;
  if (existsSync(destination)) {
    const verdict = verifyAcquired(destination, artefact);
    if (!verdict.ok) {
      throw new OnnxSpeechRefusal(`speech: ${verdict.detail}`);
    }
    options.log(`speech: ${label} already acquired and verified at ${destination}`);
    files.push(...verdict.files);
    return false;
  }
  options.log(`speech: ${artefact.url}`);
  options.log(`speech: expecting sha256 ${artefact.sha256} (${artefact.size} bytes)`);
  const archive: ArchiveFormat = {
    assert: assertTarballArtefact,
    extract: (tarball, staging) => extractTarGz(tarball, staging, options.select),
  };
  const outcome = await acquireArtefact({
    request: artefact,
    destination,
    archive,
    workDir: options.workDir,
    stage: (staging) => {
      const record = stageAcquired(staging, artefact, options.witnesses(staging));
      for (const file of record.files) {
        files.push({
          path: join(destination, ...file.path.split("/")),
          sha256: file.sha256,
          bytes: file.bytes,
        });
      }
    },
  });
  options.log(
    `speech: ${label} unpacked ${outcome.extraction.files} files ` +
      `(${outcome.extraction.bytes} bytes) out of the archive`,
  );
  return true;
}

/**
 * The runtime assertion the schema deliberately does not make.
 *
 * `files` is optional on `ToolchainComponent` because most routes acquire one artefact, and making
 * it conditional on `provider` would have needed a JSON-Schema conditional — the one construct the
 * codegen splitter handles badly. So the constraint lives here, beside the provider that knows how
 * many artefacts its own route has: a component recorded with fewer than the model, one voice and
 * two runtime witnesses is an incomplete component, and recording one would defeat the existence
 * check the field exists for.
 */
function assertComponentFiles(files: readonly ToolchainFile[], destination: string): void {
  const minimum = 4;
  if (files.length < minimum) {
    throw new OnnxSpeechRefusal(
      `speech: ${destination} accounts for only ${files.length} of the at least ${minimum} files ` +
        "the ONNX route is made of — a model, a voice, this platform's native binding and the " +
        "loader. A marker recording fewer would pass an existence check that had stopped meaning " +
        "anything. Nothing was recorded.",
    );
  }
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) {
      throw new OnnxSpeechRefusal(
        `speech: ${file.path} would be recorded twice, so two of this component's parts resolved ` +
          "to one path. Nothing was recorded.",
      );
    }
    seen.add(file.path);
  }
}

/** One file in the pinned HuggingFace repository, at the pinned revision. */
function huggingFaceUrl(path: string): string {
  return `https://huggingface.co/${KOKORO_REPO}/resolve/${KOKORO_REVISION}/${path}`;
}
