/**
 * Materialising a payload-1 artefact under the state directory, by `temp dir → rename`.
 *
 * The plan's §2.1 gives the phase-2 default install its program from "a B1 artefact staged at
 * `<state>/runtime/<version>-<digest>/`", and this module is the staging half of that sentence: it
 * takes a directory `xplainer runtime build --out` produced, copies it into a **temporary directory
 * inside `<state>/runtime/`**, and only then renames it onto its final name.
 *
 * **Why the temp directory is a sibling and not `<state>/tmp`.** `rename(2)` is atomic only within
 * one filesystem, and a state directory a user has relocated onto another volume with
 * `XPLAINER_STATE_DIR` would otherwise turn the one operation this module rests on into a
 * copy-and-delete that can be interrupted halfway. Staging beside the target keeps the rename a
 * rename, which is what makes the invariant true rather than likely: **a half-copied runtime is
 * never visible under its final name**, because the final name only ever comes into existence as a
 * whole directory. `daemon/durable-write.ts` makes the same argument for a single file, and this is
 * that argument applied to a 160 MB tree.
 *
 * **Why the name is content-addressed.** `<version>-<digest>` is composed from the payload's own
 * manifest: the version of the package whose `bin` entry the launch contract names, and a SHA-256
 * over every file hash, every symlink target and the host facts the payload was built against. Two
 * builds of identical content therefore land in the same slot and the second one copies nothing,
 * while a payload that differs by one byte gets a directory of its own. That is what lets an update
 * stage the new runtime **beside** the running one — the property T15's transaction needs, and the
 * reason nothing here ever writes into a directory a daemon may be executing out of.
 *
 * **Verification happens before the copy, not after it.** {@link verifyRuntimePayload} re-hashes the
 * source against its own manifest, so a truncated or tampered artefact is refused while the state
 * directory still contains nothing this call made. Re-hashing the copy afterwards would answer a
 * question `cpSync` cannot get wrong on its own and would double the cost of every install.
 */

import { createHash } from "node:crypto";
import { constants, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { type DirectoryFlush, flushDirectory } from "../daemon/durable-write.js";
import { PRECONDITION_UNMET_EXIT_CODE } from "../daemon/exit-codes.js";
import { STATE_DIR_MODE } from "../daemon/state-dir.js";
import {
  type ManifestPackage,
  RUNTIME_MANIFEST_FILE,
  type RuntimeManifest,
  readRuntimeManifest,
} from "../runtime/manifest.js";
import { verifyRuntimePayload } from "../runtime/verify.js";

/** The subdirectory of the state directory that holds one directory per staged runtime. */
export const RUNTIME_STAGE_DIR = "runtime";

/**
 * What an in-flight copy is called.
 *
 * The leading dot keeps it out of a glob, and {@link listStagedRuntimes} skips every name carrying
 * it — so an interrupted stage leaves a directory nothing mistakes for a runtime rather than a
 * half-populated slot.
 */
export const STAGE_TEMP_PREFIX = ".staging-";

/** How much of the SHA-256 goes into a directory name. */
export const RUNTIME_DIGEST_LENGTH = 12;

/** The characters a version may contribute to a directory name. */
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** Why the stager refused. One value per distinguishable condition, never a catch-all. */
export type StageRefusalReason =
  | "not-a-payload"
  | "unverified"
  | "malformed-manifest"
  | "occupied"
  | "copy-failed";

/**
 * The stager will not materialise this payload, and the state directory holds nothing it made.
 *
 * It carries an exit code for the same reason `AssemblyRefusal`'s reasons are a closed set: every
 * condition here is a precondition of writing that was knowable first, which is the shape
 * ADR 0020 §Degraded paths gives code `3`.
 */
export class StageRefusal extends Error {
  /** Which condition stopped the staging. */
  readonly reason: StageRefusalReason;
  /** ADR 0020's "precondition unmet, nothing written". */
  readonly exitCode: number = PRECONDITION_UNMET_EXIT_CODE;

  constructor(reason: StageRefusalReason, message: string) {
    super(message);
    this.name = "StageRefusal";
    this.reason = reason;
  }
}

/** One staged payload-1 directory. */
export type StagedRuntime = {
  /** `<version>-<digest>`, the directory's own name. */
  slot: string;
  /** `<state>/runtime/<slot>`. */
  path: string;
  /** The manifest that describes what is in it. */
  manifest: RuntimeManifest;
};

/** What one {@link stageRuntime} call did. */
export type StageOutcome = StagedRuntime & {
  /**
   * Whether the slot already held this exact payload, so nothing was copied.
   *
   * Staging is idempotent by construction — the name is the content — and an install re-run over an
   * already-staged runtime is the ordinary case rather than an error.
   */
  reused: boolean;
  /** The temporary directory this call copied into, or `null` when nothing was copied. */
  copiedVia: string | null;
  /** What flushing `<state>/runtime/` did, recorded rather than thrown (ADR 0024). */
  flush: DirectoryFlush | null;
};

/** What {@link stageRuntime} needs. */
export type StageRuntimeOptions = {
  /** The payload-1 directory to materialise, exactly as `runtime build --out` produced it. */
  payloadDir: string;
  /** The durable state directory the slot is created under. */
  stateDir: string;
};

/** `<state>/runtime`, the directory one slot per staged runtime lives in. */
export function stagedRuntimeRoot(stateDir: string): string {
  return join(stateDir, RUNTIME_STAGE_DIR);
}

/**
 * The package whose `bin` entry the launch contract names.
 *
 * Found through `launch.entry` rather than by looking `@xplainer/cli` up by name, so the answer is
 * a fact about *this* payload: the assembler takes a `rootPackage` option, and a manifest that says
 * its entry lives in one package while the slot was named after another would be a directory name
 * that describes nothing on disk.
 */
function rootPackageOf(manifest: RuntimeManifest): ManifestPackage {
  let best: ManifestPackage | null = null;
  for (const entry of manifest.packages) {
    if (!manifest.launch.entry.startsWith(`${entry.path}/`)) {
      continue;
    }
    if (best === null || entry.path.length > best.path.length) {
      best = entry;
    }
  }
  if (best === null) {
    throw new StageRefusal(
      "malformed-manifest",
      `the manifest's launch entry ${manifest.launch.entry} lies inside none of the ` +
        `${manifest.packages.length} packages it records, so there is no version to name the ` +
        `staged directory after.`,
    );
  }
  return best;
}

/**
 * A SHA-256 over everything that makes two payloads different, as 12 hex characters.
 *
 * The manifest's `created_at` is deliberately not in it: two builds of the same tree half an hour
 * apart are the same runtime and must land in the same slot, or every rebuild would stage a second
 * copy of 160 MB under a new name. Everything else that a consumer can observe is: the file hashes,
 * the symlink targets, the launch contract, and the platform, architecture and interpreter version
 * the payload was built against — because a payload built on another platform is a different
 * artefact even when its own files hash the same.
 */
export function runtimeDigest(manifest: RuntimeManifest): string {
  const hash = createHash("sha256");
  const lines = [
    `platform ${manifest.platform}`,
    `arch ${manifest.arch}`,
    `node ${manifest.node_version}`,
    `npm ${manifest.npm_version}`,
    `interpreter ${manifest.launch.interpreter}`,
    `entry ${manifest.launch.entry}`,
    ...[...manifest.files]
      .sort((left, right) => (left.path < right.path ? -1 : 1))
      .map((file) => `file ${file.path} ${file.sha256}`),
    ...[...manifest.links]
      .sort((left, right) => (left.path < right.path ? -1 : 1))
      .map((link) => `link ${link.path} ${link.target}`),
  ];
  for (const line of lines) {
    hash.update(`${line}\n`);
  }
  return hash.digest("hex").slice(0, RUNTIME_DIGEST_LENGTH);
}

/** `<version>-<digest>`, the name this payload is staged under. */
export function runtimeSlot(manifest: RuntimeManifest): string {
  const root = rootPackageOf(manifest);
  if (!SAFE_VERSION.test(root.version)) {
    throw new StageRefusal(
      "malformed-manifest",
      `${root.name} declares version ${JSON.stringify(root.version)}, which is not a name a ` +
        `directory can be called on every platform this daemon installs on. A staged runtime is ` +
        `identified by its version and its digest, so the version has to be one.`,
    );
  }
  return `${root.version}-${runtimeDigest(manifest)}`;
}

/**
 * Copy `payloadDir` to `<state>/runtime/<version>-<digest>/`, atomically.
 *
 * The order is the whole point: read the manifest, re-hash the source, compute the name, copy into
 * a sibling temporary directory, `rename` it onto the name. Every failure before the rename leaves
 * the final name absent; the rename itself is the only moment the slot appears, and it appears
 * complete.
 */
export function stageRuntime(options: StageRuntimeOptions): StageOutcome {
  const manifest = readManifest(options.payloadDir);
  const report = verifyRuntimePayload(options.payloadDir);
  if (!report.ok) {
    throw new StageRefusal(
      "unverified",
      `${options.payloadDir} does not match its own ${RUNTIME_MANIFEST_FILE}: ` +
        `${report.failure.reason} at ${report.failure.name} — ${report.failure.detail}. ` +
        `Nothing was staged; rebuild the payload with \`xplainer runtime build\`.`,
    );
  }

  const slot = runtimeSlot(manifest);
  const root = stagedRuntimeRoot(options.stateDir);
  const path = join(root, slot);
  mkdirSync(root, { recursive: true, mode: STATE_DIR_MODE });

  if (existsSync(path)) {
    return { ...confirmStaged(path, slot), reused: true, copiedVia: null, flush: null };
  }

  const temporary = join(root, `${STAGE_TEMP_PREFIX}${slot}.${process.pid}`);
  rmSync(temporary, { recursive: true, force: true });
  try {
    cpSync(options.payloadDir, temporary, {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
    renameSync(temporary, path);
  } catch (error) {
    // The temporary is this call's own and its contents are worth nothing to anybody: a copy that
    // stopped halfway is exactly what must not survive under any name, and the rename failing is
    // the one case where the bytes are all there and the slot still must not appear.
    rmSync(temporary, { recursive: true, force: true });
    throw new StageRefusal(
      "copy-failed",
      `${options.payloadDir} could not be staged at ${path}: ` +
        `${error instanceof Error ? error.message : String(error)}. The temporary copy at ` +
        `${temporary} was removed, so nothing is visible under the runtime's own name.`,
    );
  }

  return {
    slot,
    path,
    manifest,
    reused: false,
    copiedVia: temporary,
    flush: flushDirectory(root),
  };
}

/**
 * Every runtime staged under `stateDir`, in directory order.
 *
 * An in-flight or abandoned {@link STAGE_TEMP_PREFIX} directory is skipped rather than reported,
 * which is the reading half of the invariant the writing half establishes. A slot whose manifest
 * cannot be read is skipped too: this is the question "what can be launched", and a directory that
 * cannot answer it is not a candidate. `xplainer runtime verify` is where a damaged payload is
 * named.
 */
export function listStagedRuntimes(stateDir: string): StagedRuntime[] {
  const root = stagedRuntimeRoot(stateDir);
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(STAGE_TEMP_PREFIX))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const staged: StagedRuntime[] = [];
  for (const name of names.sort()) {
    try {
      staged.push({ slot: name, path: join(root, name), manifest: readManifest(join(root, name)) });
    } catch {
      // Not a payload, or not one any more. This is the question "what can be launched", and a
      // directory that cannot answer it is not a candidate rather than an error.
    }
  }
  return staged;
}

/** Read a payload's manifest, or say that the directory is not a payload. */
function readManifest(payloadDir: string): RuntimeManifest {
  try {
    return readRuntimeManifest(payloadDir);
  } catch (error) {
    throw new StageRefusal(
      "not-a-payload",
      `${payloadDir} is not a payload-1 artefact: its ${RUNTIME_MANIFEST_FILE} ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * A slot that is already there, confirmed to still be the payload its name claims.
 *
 * The name is the content, so a slot whose manifest hashes to a different digest is a directory
 * somebody has edited. Overwriting it silently would replace a runtime a daemon may be executing
 * out of; refusing names the condition and leaves the decision with the caller.
 */
function confirmStaged(path: string, slot: string): StagedRuntime {
  const manifest = readManifest(path);
  const found = runtimeSlot(manifest);
  if (found !== slot) {
    throw new StageRefusal(
      "occupied",
      `${path} already exists and its manifest describes ${found} rather than ${slot}. A staged ` +
        `runtime is named after its own contents, so this directory is not the one its name ` +
        `claims; remove it once nothing is running out of it.`,
    );
  }
  return { slot, path, manifest };
}
