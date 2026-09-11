/**
 * What a payload is, written down: the shapes `runtime build` produces and `runtime verify` reads.
 *
 * Two artefacts are described here and they are deliberately different documents.
 *
 * **Payload 1 — the runtime.** A relocatable directory carrying its own interpreter, the workspace
 * packages as their `files` allowlists publish them, the transitive closure of the five runtime
 * dependencies, and npm. Its manifest is {@link RuntimeManifest}, written as
 * {@link RUNTIME_MANIFEST_FILE}.
 *
 * **Payload 2 — the render workspace.** A real `npm ci` of `@xplainer/render-core`'s
 * `template/package.json` against the lockfile committed beside it. Its manifest is
 * {@link WorkspaceManifest}, written as {@link WORKSPACE_MANIFEST_FILE}, and it records **every
 * resolved version** rather than only the pins, because the whole point of building it is that the
 * repository's hoisted tree is not the tree the template declares.
 *
 * Three properties are structural rather than conventional, and each one is a rule some earlier
 * shape of this artefact broke:
 *
 * 1. **No path inside a manifest is absolute.** A payload is moved — out of the checkout, into an
 *    installer, into `<state>/runtimes/<digest>/` — so a manifest that named a build machine's
 *    directory would describe a tree that no longer exists. Every path here is payload-relative
 *    with `/` separators on every platform, and {@link isPayloadPath} is the predicate the
 *    assembler and the verifier both apply.
 * 2. **The platform and the interpreter's architecture are recorded.**
 *    `@remotion/compositor-<platform>` is a platform-specific optional dependency, so payload 2 is
 *    only valid on the host it was built on; and `runtime build` copies `process.execPath`, so
 *    payload 1 carries the build host's own architecture. Recording both is what lets `verify`
 *    refuse a wrong-host payload by name instead of leaving a user with a spawn error.
 * 3. **Symlinks are a separate list from files.** npm materialises `node_modules/.bin/remotion` as
 *    a symlink to `@remotion/cli/remotion-cli.js`; it has no contents to hash and its *target* is
 *    the thing that can go wrong. Hashing the file it points at would silently pass a link that had
 *    been repointed, so links carry their target and are compared as targets.
 *
 * The manifests are read back by {@link readRuntimeManifest} and {@link readWorkspaceManifest},
 * which validate rather than cast: a manifest is data that arrives from disk, and the file being a
 * `.json` says nothing about its shape.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import process from "node:process";

/** Payload 1's manifest, written at the root of the payload. */
export const RUNTIME_MANIFEST_FILE = "runtime.manifest.json";

/** Payload 2's manifest, written at the root of the installed workspace. */
export const WORKSPACE_MANIFEST_FILE = "workspace.manifest.json";

/** Where payload 1 puts the interpreter and npm's shim, payload-relative. */
export const PAYLOAD_BIN_DIR = "bin";

/** Where payload 1 puts every package, payload-relative — npm's own layout, so npm can read it. */
export const PAYLOAD_LIB_DIR = "lib/node_modules";

/** The npm entry inside payload 1, payload-relative. Spawned, never imported. */
export const PAYLOAD_NPM_CLI = "lib/node_modules/npm/bin/npm-cli.js";

/** The version stamped into every manifest this module writes. */
export const MANIFEST_VERSION = 1;

/**
 * The package whose runtime dependency closure payload 1 is.
 *
 * **It lives here rather than beside the assembler, and that placement is load-bearing.** Four
 * modules need to know which package a payload is the closure of — the assembler, the launch-spec
 * builder, the resolver in `install/program.ts` and the materialiser — and only one of them writes
 * a payload. While this constant was exported from `runtime/assemble.ts`, importing the name pulled
 * the whole 146 MB writer into the resolver's import closure, which is the one module whose
 * contract is that asking it a question costs nothing. `install/program.test.ts` walks that closure
 * and asserts the assembler is not in it; this constant is why it can.
 */
export const RUNTIME_ROOT_PACKAGE = "@xplainer/cli";

/**
 * Which interpreter is running this assembler.
 *
 * `process.execPath` is what payload 1 copies, and inside a packaged Electron application it is the
 * **Electron** binary, not a Node one: copying it would produce a payload whose `bin/node` opens a
 * window. A future single-executable host has the same problem from the other direction — its
 * `execPath` is the sealed executable, and the Node it embeds is not a file on disk at all. So the
 * host is classified before anything is copied and a non-Node host is refused by name.
 */
export type RuntimeHost = "node" | "electron" | "sea";

/**
 * The three facts {@link classifyHost} reads, as data rather than as globals.
 *
 * Taking them as an argument is what makes the Electron and SEA branches testable on a machine that
 * has neither: the classification is a pure function over a description, and the only thing
 * {@link describeHost} adds is where the description comes from.
 */
export type HostDescription = {
  /** The running executable — `process.execPath`. */
  execPath: string;
  /** `process.versions.electron`, or `undefined` under plain Node. */
  electronVersion: string | undefined;
  /** `require("node:sea").isSea()`, or `false` where the module is unavailable. */
  isSea: boolean;
};

/** Classify a host from its description. Electron is checked first: a SEA build can embed either. */
export function classifyHost(host: HostDescription): RuntimeHost {
  if (host.electronVersion !== undefined) {
    return "electron";
  }
  if (host.isSea) {
    return "sea";
  }
  return "node";
}

/** {@link HostDescription} for the process that is running now. */
export function describeHost(): HostDescription {
  return {
    execPath: process.execPath,
    electronVersion: process.versions.electron,
    isSea: detectSingleExecutable(),
  };
}

/**
 * `node:sea`'s own answer, or `false` on a host that does not have the module.
 *
 * There is no `process.versions.sea` — measured on Node 24.20.0, the version table has no such key
 * — so the module is the only source of this fact. It is reached through `createRequire` rather
 * than imported statically because this same file has to load under a host that may not ship it,
 * and a missing builtin at import time is a crash before any refusal could be printed.
 */
function detectSingleExecutable(): boolean {
  try {
    const sea = createRequire(import.meta.url)("node:sea") as { isSea?: () => boolean };
    return typeof sea.isSea === "function" ? sea.isSea() : false;
  } catch {
    return false;
  }
}

/** One regular file in a payload. */
export type ManifestFile = {
  /** Payload-relative, `/`-separated, never absolute. */
  path: string;
  /** Lower-case hex SHA-256 of the file's bytes. */
  sha256: string;
  /** Size in bytes, so a truncation is named as a truncation rather than as a hash mismatch. */
  bytes: number;
  /** Whether any execute bit is set. Meaningless on Windows, recorded as `false` there. */
  executable: boolean;
};

/** One symbolic link in a payload, compared by target and never by the bytes at the far end. */
export type ManifestLink = {
  /** Payload-relative, `/`-separated, never absolute. */
  path: string;
  /** Exactly what `readlink(2)` returned, unresolved. */
  target: string;
};

/** One package inside a payload, with the directory it was installed at. */
export type ManifestPackage = {
  /** Payload-relative directory, `/`-separated. */
  path: string;
  /** The name from its `package.json`. */
  name: string;
  /** The version from its `package.json`. */
  version: string;
  /** True when it is a workspace package copied through its own `files` allowlist. */
  workspace: boolean;
};

/**
 * How a caller runs this payload — every path payload-relative.
 *
 * This is the contract D1 exists to make explicit: the CLI and the Remotion CLI are both started as
 * `<payload>/<interpreter> <entry>`, never by exec'ing a file whose `#!/usr/bin/env node` shebang
 * needs a `node` on `PATH` that a machine built for this design does not have.
 */
export type LaunchContract = {
  /** The interpreter, e.g. `bin/node` — `bin/node.exe` on Windows. */
  interpreter: string;
  /** The CLI entry, e.g. `lib/node_modules/@xplainer/cli/dist/bin.js`. */
  entry: string;
  /** npm's own entry, spawned by `setup --workspace` and never imported by the daemon. */
  npm_cli: string;
  /** `[interpreter, entry]` — the argv prefix, spelled out so no caller has to reassemble it. */
  argv: string[];
};

/** Payload 1's manifest. */
export type RuntimeManifest = {
  kind: "runtime";
  manifest_version: number;
  /** ISO-8601, for a human reading two payloads side by side. Not compared by `verify`. */
  created_at: string;
  /** `process.platform` of the build host. */
  platform: string;
  /** `process.arch` of the **interpreter that was copied** (§1.3d B). */
  arch: string;
  /** The interpreter's own version, e.g. `v24.20.0`. */
  node_version: string;
  /** The npm that travelled inside the payload. */
  npm_version: string;
  /** Which host assembled it. Always `node`: the other two are refused. */
  host: RuntimeHost;
  launch: LaunchContract;
  packages: ManifestPackage[];
  files: ManifestFile[];
  links: ManifestLink[];
};

/** Payload 2's manifest. */
export type WorkspaceManifest = {
  kind: "workspace";
  manifest_version: number;
  created_at: string;
  /** The platform this tree was installed on. `verify` refuses it anywhere else. */
  platform: string;
  arch: string;
  node_version: string;
  npm_version: string;
  /** The command that produced the tree. `npm ci`, never `npm install` (D11). */
  installer: string;
  /** The template's declared pins, exactly as `template/package.json` states them. */
  pins: Record<string, string>;
  /** Every package the install resolved, by name. This is what a pin skew is detected against. */
  resolved: Record<string, string>;
  /** Workspace-relative path of the Remotion CLI entry, resolved through its `bin` field. */
  remotion_entry: string;
  files: ManifestFile[];
  links: ManifestLink[];
};

/** A manifest on disk that is absent, unreadable, or not the document it claims to be. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

/** Turn a path this platform produced into the `/`-separated form a manifest records. */
export function toPayloadPath(relativePath: string): string {
  return relativePath.split(sep).join("/");
}

/**
 * Is this a payload-relative path — relative, `/`-separated, and inside the payload?
 *
 * A Windows drive letter and a UNC prefix are rejected as well as a leading `/`, because a manifest
 * built on one platform is read on another and `node:path`'s `isAbsolute` answers for the platform
 * doing the asking rather than for the platform that wrote the string.
 */
export function isPayloadPath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.startsWith("\\")) {
    return false;
  }
  if (/^[a-zA-Z]:/.test(path)) {
    return false;
  }
  return !path.split("/").includes("..");
}

/**
 * SHA-256 of a file's bytes, hex.
 *
 * Read in one-megabyte chunks rather than through `readFileSync`, because the largest file in a
 * payload is the interpreter — 116 MB measured — and a verifier that allocates the whole of it is a
 * verifier that fails on a small machine for a reason nobody would guess from the message.
 */
export function hashFile(file: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(file, "r");
  try {
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) {
        return hash.digest("hex");
      }
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(descriptor);
  }
}

/** Everything a directory tree holds, as the two lists a manifest records. */
export type TreeScan = {
  files: ManifestFile[];
  links: ManifestLink[];
};

/** What {@link scanTree} may leave out. */
export type ScanOptions = {
  /**
   * Payload-relative paths to skip.
   *
   * There is exactly one legitimate member: the manifest file itself, which cannot record its own
   * hash. Anything else here would be a hole in the artefact's description.
   */
  exclude?: readonly string[] | undefined;
};

/**
 * Walk `root` and describe every regular file and every symlink under it.
 *
 * `lstat` rather than `stat`, and directories are recursed only when they are real directories: a
 * symlinked directory is recorded as a link and never descended, so a link into a tree that also
 * appears elsewhere in the payload cannot double its size or its hash count.
 *
 * Both lists come back sorted by path, which is what makes "the first mismatch" a stable thing to
 * report rather than an artefact of readdir order.
 */
export function scanTree(root: string, options: ScanOptions = {}): TreeScan {
  const skip = new Set(options.exclude ?? []);
  const files: ManifestFile[] = [];
  const links: ManifestLink[] = [];

  const walk = (directory: string, prefix: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (skip.has(relativePath)) {
        continue;
      }
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        links.push({ path: relativePath, target: readLinkTarget(full) });
        continue;
      }
      if (entry.isDirectory()) {
        walk(full, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const stats = lstatSync(full);
      files.push({
        path: relativePath,
        sha256: hashFile(full),
        bytes: stats.size,
        executable: process.platform !== "win32" && (stats.mode & 0o111) !== 0,
      });
    }
  };

  walk(root, "");
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  links.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { files, links };
}

/**
 * Every payload-relative path under `root`, without hashing anything.
 *
 * `verify` needs this to answer "is there a file here the manifest does not describe", and that
 * question does not need contents: hashing the tree a second time to ask it would double the cost
 * of every verification for an answer that is a set difference.
 */
export function listTree(root: string, options: ScanOptions = {}): string[] {
  const skip = new Set(options.exclude ?? []);
  const found: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (skip.has(relativePath)) {
        continue;
      }
      if (entry.isSymbolicLink() || entry.isFile()) {
        found.push(relativePath);
      } else if (entry.isDirectory()) {
        walk(join(directory, entry.name), relativePath);
      }
    }
  };
  walk(root, "");
  found.sort();
  return found;
}

/** `readlink(2)`, normalised to `/` separators so a manifest reads the same on every platform. */
function readLinkTarget(file: string): string {
  return toPayloadPath(readlinkSync(file));
}

/** Read and validate payload 1's manifest. */
export function readRuntimeManifest(payloadDir: string): RuntimeManifest {
  const document = readManifestDocument(join(payloadDir, RUNTIME_MANIFEST_FILE));
  if (document.kind !== "runtime") {
    throw new ManifestError(
      `${join(payloadDir, RUNTIME_MANIFEST_FILE)} says kind ${JSON.stringify(document.kind)}, ` +
        `which is not a runtime payload manifest.`,
    );
  }
  const launch = asRecord(document.launch, "launch");
  return {
    kind: "runtime",
    manifest_version: asNumber(document.manifest_version, "manifest_version"),
    created_at: asString(document.created_at, "created_at"),
    platform: asString(document.platform, "platform"),
    arch: asString(document.arch, "arch"),
    node_version: asString(document.node_version, "node_version"),
    npm_version: asString(document.npm_version, "npm_version"),
    host: asHost(document.host),
    launch: {
      interpreter: asString(launch.interpreter, "launch.interpreter"),
      entry: asString(launch.entry, "launch.entry"),
      npm_cli: asString(launch.npm_cli, "launch.npm_cli"),
      argv: asStringArray(launch.argv, "launch.argv"),
    },
    packages: asPackages(document.packages),
    files: asFiles(document.files),
    links: asLinks(document.links),
  };
}

/** Read and validate payload 2's manifest. */
export function readWorkspaceManifest(workspaceDir: string): WorkspaceManifest {
  const document = readManifestDocument(join(workspaceDir, WORKSPACE_MANIFEST_FILE));
  if (document.kind !== "workspace") {
    throw new ManifestError(
      `${join(workspaceDir, WORKSPACE_MANIFEST_FILE)} says kind ` +
        `${JSON.stringify(document.kind)}, which is not a workspace payload manifest.`,
    );
  }
  return {
    kind: "workspace",
    manifest_version: asNumber(document.manifest_version, "manifest_version"),
    created_at: asString(document.created_at, "created_at"),
    platform: asString(document.platform, "platform"),
    arch: asString(document.arch, "arch"),
    node_version: asString(document.node_version, "node_version"),
    npm_version: asString(document.npm_version, "npm_version"),
    installer: asString(document.installer, "installer"),
    pins: asVersionMap(document.pins, "pins"),
    resolved: asVersionMap(document.resolved, "resolved"),
    remotion_entry: asString(document.remotion_entry, "remotion_entry"),
    files: asFiles(document.files),
    links: asLinks(document.links),
  };
}

/** Read a manifest file into a plain object, or say precisely why it could not be read. */
function readManifestDocument(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new ManifestError(
      `${file} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ManifestError(
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return asRecord(parsed, "the manifest");
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ManifestError(`${field} is not an object.`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ManifestError(`${field} is not a string.`);
  }
  return value;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ManifestError(`${field} is not a finite number.`);
  }
  return value;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ManifestError(`${field} is not a boolean.`);
  }
  return value;
}

function asArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ManifestError(`${field} is not an array.`);
  }
  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  return asArray(value, field).map((entry, index) => asString(entry, `${field}[${index}]`));
}

function asHost(value: unknown): RuntimeHost {
  const host = asString(value, "host");
  if (host !== "node" && host !== "electron" && host !== "sea") {
    throw new ManifestError(`host is ${JSON.stringify(host)}, which is not a known runtime host.`);
  }
  return host;
}

function asVersionMap(value: unknown, field: string): Record<string, string> {
  const record = asRecord(value, field);
  const map: Record<string, string> = {};
  for (const [name, version] of Object.entries(record)) {
    map[name] = asString(version, `${field}.${name}`);
  }
  return map;
}

function asFiles(value: unknown): ManifestFile[] {
  return asArray(value, "files").map((entry, index) => {
    const file = asRecord(entry, `files[${index}]`);
    return {
      path: asString(file.path, `files[${index}].path`),
      sha256: asString(file.sha256, `files[${index}].sha256`),
      bytes: asNumber(file.bytes, `files[${index}].bytes`),
      executable: asBoolean(file.executable, `files[${index}].executable`),
    };
  });
}

function asLinks(value: unknown): ManifestLink[] {
  return asArray(value, "links").map((entry, index) => {
    const link = asRecord(entry, `links[${index}]`);
    return {
      path: asString(link.path, `links[${index}].path`),
      target: asString(link.target, `links[${index}].target`),
    };
  });
}

function asPackages(value: unknown): ManifestPackage[] {
  return asArray(value, "packages").map((entry, index) => {
    const item = asRecord(entry, `packages[${index}]`);
    return {
      path: asString(item.path, `packages[${index}].path`),
      name: asString(item.name, `packages[${index}].name`),
      version: asString(item.version, `packages[${index}].version`),
      workspace: asBoolean(item.workspace, `packages[${index}].workspace`),
    };
  });
}
