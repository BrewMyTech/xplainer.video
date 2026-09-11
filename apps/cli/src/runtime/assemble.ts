/**
 * The assembler: how the two payloads are built.
 *
 * **Payload 1 — `assembleRuntime()`.** A relocatable directory, laid out the way npm lays one out
 * so that the npm inside it can read it:
 *
 * ```
 * <out>/bin/node                                  a copy of process.execPath
 * <out>/bin/npm                                   npm's own shim, copied beside it
 * <out>/lib/node_modules/@xplainer/…              each workspace package's `files` allowlist
 * <out>/lib/node_modules/…                        the transitive closure of the runtime deps
 * <out>/lib/node_modules/npm/                     npm itself, 17 MB measured
 * <out>/runtime.manifest.json                     every path, hash, version and the launch contract
 * ```
 *
 * Three rules it enforces rather than assumes, each one a failure some earlier shape of this
 * artefact actually had:
 *
 * 1. **A workspace package contributes exactly its `files` allowlist.** A `dist`-only payload dies
 *    at load — measured: `Cannot find module '…/@xplainer/protocol/schemas/manifest.json'`, because
 *    `protocol`'s allowlist ships `schemas` and a hand-written file list did not. Defining the
 *    payload *by the allowlist* is what makes "reachable at run time" and "present in the published
 *    tarball" the same set, and {@link assembleRuntime} refuses to copy a file the allowlist does
 *    not name.
 * 2. **No path inside the artefact is absolute.** Every manifest entry is payload-relative, and the
 *    launch contract is too. A payload is moved for a living; a manifest that named the build
 *    machine would describe a directory that no longer exists.
 * 3. **The interpreter is only copied from a host that has one.** `process.execPath` inside a
 *    packaged Electron application is the Electron binary, and inside a single-executable build it
 *    is the sealed executable. Both are refused by name — `manifest.ts`'s {@link classifyHost} —
 *    rather than copied into a `bin/node` that would open a window or unpack itself.
 *
 * **npm travels with payload 1 and is never imported.** It is not in the daemon's dependency
 * closure and nothing in `src/` requires it; it exists so that `setup --workspace` has a real
 * package manager on a machine whose whole premise is that it has no Node. That is what makes the
 * documented first-run fallback more than a sentence.
 *
 * **Payload 2 — `assembleWorkspace()`.** A real `npm ci` of `@xplainer/render-core`'s
 * `template/package.json` against the `package-lock.json` committed beside it, into a staging
 * directory. It does **not** copy the repository's hoisted tree: measured, that yields react 19.2.8
 * against the template's 19.2.3, tailwind 4.2.0 against 4.0.0 and zod 4.5.4 where Remotion requires
 * 4.3.6 — and `remotion versions` exits `1` on the last of those, so the copied tree is one
 * Remotion's own guard rejects.
 *
 * `npm ci`, never `npm install`: `ci` requires the lockfile to be in sync with `package.json` and
 * removes `node_modules` first, while `install` may rewrite the lockfile on a user's machine and
 * silently defeat the determinism the lockfile was committed for.
 *
 * **`<runtime>/bin` goes on the install subprocess's `PATH`, and on nothing else.** npm runs
 * lifecycle scripts through `sh -c` and third-party scripts call bare `node` — `esbuild`'s
 * `postinstall` is `node install.js` — so an install driven by payload 1's npm under a scrubbed
 * `PATH` exits `127` and leaves no workspace at all. The fix is scoped to the one child process:
 * `PATH=<runtime>/bin:<inherited PATH>` for the install, and nothing else changed. It does not
 * contradict D1's refusal to put `<runtime>/bin` on a render worker's `PATH`, whose stated ground
 * was leaking an interpreter onto the `PATH` of Chrome and ffmpeg; the install subprocess spawns
 * neither, and every script it does spawn wants exactly the interpreter it is being given.
 *
 * **Payload 2 is built on the platform it targets.** `@remotion/compositor-<platform>` is a
 * platform-specific optional dependency, so a tree installed on the wrong host produces renders
 * that fail at spawn. The manifest records the platform, and `verify` refuses it elsewhere.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  classifyHost,
  describeHost,
  type HostDescription,
  isPayloadPath,
  type LaunchContract,
  MANIFEST_VERSION,
  type ManifestPackage,
  PAYLOAD_BIN_DIR,
  PAYLOAD_LIB_DIR,
  PAYLOAD_NPM_CLI,
  RUNTIME_MANIFEST_FILE,
  RUNTIME_ROOT_PACKAGE,
  type RuntimeManifest,
  scanTree,
  templateDirectory,
  toPayloadPath,
  WORKSPACE_MANIFEST_FILE,
  type WorkspaceManifest,
} from "./manifest.js";

/** npm ships this whatever a `files` allowlist says, and `version.ts` reads it at startup. */
const ALWAYS_SHIPPED = new Set(["package.json"]);

/** The workspace globs `pnpm-workspace.yaml` declares, which is where a package directory is found. */
const WORKSPACE_GROUPS = ["apps", "packages", "services"] as const;

/**
 * A refusal: the assembler will not build this payload, and it has written nothing it can be
 * blamed for.
 *
 * Every one names the condition and the command that fixes it, because a build that stops has to
 * leave a user with a next step rather than a stack trace.
 */
export class AssemblyRefusal extends Error {
  /** Which condition stopped the build. */
  readonly reason: AssemblyRefusalReason;

  constructor(reason: AssemblyRefusalReason, message: string) {
    super(message);
    this.name = "AssemblyRefusal";
    this.reason = reason;
  }
}

/**
 * The conditions the assembler refuses on.
 *
 * A closed set rather than a message a caller greps, because `commands/runtime.ts` maps them onto
 * the exit-code table: every one of them is a precondition that was knowable before anything was
 * written **except** `install-failed`, which is npm having run and failed for its own reasons — the
 * same shape as `connect`'s vendor-CLI row, and the same exit code.
 */
export type AssemblyRefusalReason =
  | "host"
  | "output-dir"
  | "no-checkout"
  | "no-npm"
  | "no-allowlist"
  | "unresolved-dependency"
  | "unbuilt-entry"
  | "malformed-manifest"
  | "template"
  | "runtime-payload"
  | "install-failed"
  | "install-incomplete";

/** What {@link assembleRuntime} was asked to build. */
export type AssembleRuntimeOptions = {
  /** Where the payload goes. Created if missing; it must be empty or absent. */
  outDir: string;
  /** The checkout to read packages from. Defaults to the one this module is running inside. */
  repoRoot?: string | undefined;
  /** The package whose closure is copied. Defaults to {@link RUNTIME_ROOT_PACKAGE}. */
  rootPackage?: string | undefined;
  /** The host to classify. Defaults to this process; supplied by tests for the two it refuses. */
  host?: HostDescription | undefined;
};

/** What one {@link assembleRuntime} call produced. */
export type AssembledRuntime = {
  /** The payload's root. */
  outDir: string;
  /** Where the manifest was written. */
  manifestPath: string;
  /** The manifest that was written. */
  manifest: RuntimeManifest;
};

/** What {@link assembleWorkspace} was asked to build. */
export type AssembleWorkspaceOptions = {
  /** The staging directory the install lands in. Created if missing; empty or absent. */
  outDir: string;
  /** The template to install. Defaults to the one inside `@xplainer/render-core`. */
  templateDir?: string | undefined;
  /**
   * A payload-1 directory to run the install from.
   *
   * Given one, the install uses **that** payload's `bin/node` and its bundled npm, with
   * `<runtime>/bin` prepended to the child's `PATH` and nothing else changed. Omitted, the install
   * uses whatever `npm` the build machine has — which is the checkout-or-runner half of the same
   * decision.
   */
  runtimeDir?: string | undefined;
  /** The environment the install subprocess inherits. Defaults to this process's. */
  env?: NodeJS.ProcessEnv | undefined;
};

/** What one {@link assembleWorkspace} call produced. */
export type AssembledWorkspace = {
  outDir: string;
  manifestPath: string;
  manifest: WorkspaceManifest;
};

/**
 * Build payload 1 into `outDir` and return the manifest that describes it.
 *
 * The whole payload is copied before a single hash is taken, and the manifest is the last file
 * written, so a payload whose manifest exists is a payload whose assembly finished.
 */
export function assembleRuntime(options: AssembleRuntimeOptions): AssembledRuntime {
  const host = options.host ?? describeHost();
  const kind = classifyHost(host);
  if (kind !== "node") {
    throw new AssemblyRefusal(
      "host",
      `runtime build needs a plain Node interpreter to copy, and this process is ${kind}: ` +
        `${host.execPath} is not a Node binary, so copying it would produce a payload whose ` +
        `bin/node is not an interpreter. Run runtime build from node itself.`,
    );
  }

  const repoRoot = options.repoRoot ?? findCheckout();
  const rootPackage = options.rootPackage ?? RUNTIME_ROOT_PACKAGE;
  requireEmptyDirectory(options.outDir, "runtime build --out");

  const libDir = join(options.outDir, ...PAYLOAD_LIB_DIR.split("/"));
  const binDir = join(options.outDir, PAYLOAD_BIN_DIR);
  mkdirSync(libDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  const interpreterName = process.platform === "win32" ? "node.exe" : "node";
  const interpreter = join(binDir, interpreterName);
  copyFileSync(host.execPath, interpreter, constants.COPYFILE_FICLONE);
  chmodSync(interpreter, 0o755);

  const npm = copyNpm(host.execPath, options.outDir);
  const packages = [...copyClosure({ repoRoot, rootPackage, libDir }), npm.entry];
  packages.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  const entryPath = entryFor(repoRoot, rootPackage, packages);
  if (!existsSync(join(options.outDir, ...entryPath.split("/")))) {
    throw new AssemblyRefusal(
      "unbuilt-entry",
      `${rootPackage}'s entry is missing from the payload at ${entryPath}: its \`bin\` field ` +
        `names a file the \`files\` allowlist ships out of \`dist/\`, and nothing built it. Run ` +
        `\`pnpm --filter ${rootPackage} build\` and try again.`,
    );
  }

  const launch: LaunchContract = {
    interpreter: `${PAYLOAD_BIN_DIR}/${interpreterName}`,
    entry: entryPath,
    npm_cli: PAYLOAD_NPM_CLI,
    argv: [`${PAYLOAD_BIN_DIR}/${interpreterName}`, entryPath],
  };
  const scan = scanTree(options.outDir, { exclude: [RUNTIME_MANIFEST_FILE] });
  // Rule two, enforced rather than assumed. `scanTree` cannot produce an absolute path, but a
  // `packages[].path` is built out of a package **name** and the launch contract is composed here,
  // so either can escape the payload if a name does. A manifest that names something outside the
  // artefact describes a directory the machine it is copied to does not have.
  for (const path of [
    launch.interpreter,
    launch.entry,
    launch.npm_cli,
    ...packages.map((entry) => entry.path),
    ...scan.files.map((file) => file.path),
    ...scan.links.map((link) => link.path),
  ]) {
    if (!isPayloadPath(path)) {
      throw new AssemblyRefusal(
        "malformed-manifest",
        `the manifest would name ${path}, which is not a path inside the payload. No path inside ` +
          `the artefact may be absolute or escape it: a payload is moved for a living, and a ` +
          `manifest that names the build machine describes a directory that is no longer there.`,
      );
    }
  }

  const manifest: RuntimeManifest = {
    kind: "runtime",
    manifest_version: MANIFEST_VERSION,
    created_at: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node_version: process.version,
    npm_version: npm.version,
    host: kind,
    launch,
    packages,
    files: scan.files,
    links: scan.links,
  };
  const manifestPath = writeManifestFile(options.outDir, RUNTIME_MANIFEST_FILE, manifest);
  return { outDir: options.outDir, manifestPath, manifest };
}

/**
 * Build payload 2 into `outDir` by running a real `npm ci` of the template, and describe the tree
 * it produced.
 */
export function assembleWorkspace(options: AssembleWorkspaceOptions): AssembledWorkspace {
  const templateDir = options.templateDir ?? templateDirectory();
  const manifestSource = join(templateDir, "package.json");
  const lockSource = join(templateDir, "package-lock.json");
  for (const file of [manifestSource, lockSource]) {
    if (!existsSync(file)) {
      throw new AssemblyRefusal(
        "template",
        `${file} does not exist, and payload 2 is defined as an \`npm ci\` of the template's own ` +
          `package.json against the lockfile committed beside it.`,
      );
    }
  }
  requireEmptyDirectory(options.outDir, "runtime build --workspace --out");
  mkdirSync(options.outDir, { recursive: true });
  copyFileSync(manifestSource, join(options.outDir, "package.json"));
  copyFileSync(lockSource, join(options.outDir, "package-lock.json"));

  const install = installCommand(options.runtimeDir);
  const result = spawnSync(install.command, install.args, {
    cwd: options.outDir,
    encoding: "utf8",
    env: installEnvironment(options.env ?? process.env, options.runtimeDir),
  });
  if (result.status !== 0) {
    const detail = [result.stdout ?? "", result.stderr ?? ""].join("").trim();
    throw new AssemblyRefusal(
      "install-failed",
      `\`npm ci\` in ${options.outDir} exited ${String(result.status ?? result.signal)}:\n${detail}`,
    );
  }

  const pins = declaredPins(manifestSource);
  const resolved = resolvedVersions(join(options.outDir, "node_modules"));
  const remotionEntry = remotionEntryPath(options.outDir);
  if (remotionEntry === null) {
    throw new AssemblyRefusal(
      "install-incomplete",
      `the install in ${options.outDir} produced no @remotion/cli entry, so nothing in it could ` +
        `render. Its \`bin\` field is what names that file, and the package is missing from the tree.`,
    );
  }

  const scan = scanTree(options.outDir, { exclude: [WORKSPACE_MANIFEST_FILE] });
  const manifest: WorkspaceManifest = {
    kind: "workspace",
    manifest_version: MANIFEST_VERSION,
    created_at: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node_version: process.version,
    npm_version: npmVersionOf(install, options),
    installer: "npm ci",
    pins,
    resolved,
    remotion_entry: remotionEntry,
    files: scan.files,
    links: scan.links,
  };
  const manifestPath = writeManifestFile(options.outDir, WORKSPACE_MANIFEST_FILE, manifest);
  return { outDir: options.outDir, manifestPath, manifest };
}

/**
 * The Remotion CLI entry inside an installed workspace, workspace-relative, or `null`.
 *
 * Resolution goes through `@remotion/cli`'s own `bin` field rather than through the `.bin` shim,
 * which is the difference D1 turns on: the shim is a symlink to a file whose first line is
 * `#!/usr/bin/env node`, so exec'ing it needs a `node` on `PATH`. Naming the real file lets a
 * caller spawn `<runtime>/bin/node <entry>` and never depend on the machine having an interpreter.
 */
export function remotionEntryPath(workspaceRoot: string): string | null {
  const packageDir = join(workspaceRoot, "node_modules", "@remotion", "cli");
  const manifestFile = join(packageDir, "package.json");
  if (!existsSync(manifestFile)) {
    return null;
  }
  const manifest = readJson(manifestFile);
  const bin = manifest.bin;
  const target =
    typeof bin === "string"
      ? bin
      : typeof bin === "object" && bin !== null
        ? (bin as Record<string, unknown>).remotion
        : undefined;
  if (typeof target !== "string") {
    return null;
  }
  const entry = join(packageDir, target);
  return existsSync(entry) ? toPayloadPath(relative(workspaceRoot, entry)) : null;
}

/** The checkout this process is running inside, found by the marker every worktree has. */
export function findCheckout(from: string = dirname(fileURLToPath(import.meta.url))): string {
  let directory = from;
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) {
      return realpathSync(directory);
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new AssemblyRefusal(
        "no-checkout",
        `no pnpm-workspace.yaml above ${from}: \`runtime build\` assembles a payload out of a ` +
          `checkout's own packages, so it runs from a checkout or a runner, never from an ` +
          `installed payload.`,
      );
    }
    directory = parent;
  }
}

/**
 * The payload-relative entry the root package's `bin` field names.
 *
 * Read off `bin` rather than hard-coded as `dist/bin.js`, for the same reason D1 resolves Remotion
 * through its `bin` field: the manifest is a launch contract, and a contract that guesses the file
 * it launches is a contract that goes stale the first time the entry moves.
 */
function entryFor(repoRoot: string, rootPackage: string, packages: ManifestPackage[]): string {
  const copied = packages.find((entry) => entry.name === rootPackage);
  if (copied === undefined) {
    throw new AssemblyRefusal("unbuilt-entry", `${rootPackage} was not copied into the payload.`);
  }
  // Where the root package's own manifest is, which is the only thing the `bin` field can be read
  // off. A checkout answers from the workspace globs; a global npm install answers from ordinary
  // `node_modules` resolution, and `findPackageDir` is the same walk `copyClosure` just used, so
  // the directory the entry is read from is the directory the payload was copied from.
  const directory =
    workspacePackages(repoRoot).get(rootPackage) ?? findPackageDir(repoRoot, rootPackage);
  if (directory === null || directory === undefined) {
    throw new AssemblyRefusal(
      "unbuilt-entry",
      `${rootPackage} has no directory in ${repoRoot}: it is neither a workspace package there ` +
        `nor resolvable from its \`node_modules\`, so there is no manifest to read a \`bin\` off.`,
    );
  }
  const bin = readJson(join(directory, "package.json")).bin;
  const target =
    typeof bin === "string"
      ? bin
      : typeof bin === "object" && bin !== null
        ? Object.values(bin as Record<string, unknown>)[0]
        : undefined;
  if (typeof target !== "string") {
    throw new AssemblyRefusal(
      "unbuilt-entry",
      `${rootPackage} declares no \`bin\`, so the payload has no entry to launch. The launch ` +
        `contract is read off that field and cannot be guessed.`,
    );
  }
  return `${copied.path}/${toPayloadPath(target).replace(/^\.\//, "")}`;
}

/** Refuse an output directory that already holds something, before anything is written. */
function requireEmptyDirectory(directory: string, command: string): void {
  if (existsSync(directory) && readdirSync(directory).length > 0) {
    throw new AssemblyRefusal(
      "output-dir",
      `${directory} is not empty. \`${command}\` writes a whole payload and will not merge into ` +
        `one that is already there; remove it or name a different directory.`,
    );
  }
}

/** Where npm lives beside an interpreter, and what it is. */
export type NpmInstallation = {
  /** The Node distribution's root. */
  root: string;
  /** npm's own package directory. */
  directory: string;
  /** `bin/npm-cli.js` inside it — the file that is spawned, never imported. */
  cli: string;
  /** The version it declares. */
  version: string;
};

/**
 * Find the npm that ships beside `execPath`, or refuse by name.
 *
 * Two layouts, both real: `<root>/lib/node_modules/npm` with a `<root>/bin/npm` shim on POSIX, and
 * `<root>/node_modules/npm` with `npm.cmd` beside the executable on Windows. A host with neither is
 * refused rather than yielding a payload that silently cannot install anything, which is the whole
 * failure D3 exists to remove.
 */
export function npmInstallation(execPath: string): NpmInstallation {
  const root = process.platform === "win32" ? dirname(execPath) : dirname(dirname(execPath));
  const candidates = [join(root, "lib", "node_modules", "npm"), join(root, "node_modules", "npm")];
  const directory = candidates.find((candidate) => existsSync(join(candidate, "package.json")));
  if (directory === undefined) {
    throw new AssemblyRefusal(
      "no-npm",
      `npm is not installed beside ${execPath} — looked in ${candidates.join(" and ")}. Payload 1 ` +
        `carries npm so that \`setup --workspace\` has a package manager on a machine with no ` +
        `Node, so a runtime built without it would be one that can never install a workspace.`,
    );
  }
  const version = readJson(join(directory, "package.json")).version;
  return {
    root,
    directory,
    cli: join(directory, "bin", "npm-cli.js"),
    version: typeof version === "string" ? version : "unknown",
  };
}

/**
 * Copy npm — the whole tree and its shim — into payload 1, and describe what travelled.
 *
 * Where npm is found — the two platform layouts, and the refusal for a host with neither — is
 * {@link npmInstallation}'s.
 *
 * **npm's own `node_modules` travels with it**, unlike every other tree this assembler copies. The
 * closure walk resolves an external package's dependencies itself and hoists them, which is right
 * for a tree whose layout this assembler owns; npm's is a **vendored** tree that npm ships as part
 * of itself — 13 MB of the 17 MB measured — and a copy without it is an npm that cannot run. So
 * the filter that keeps a pnpm store symlink out of the payload is deliberately not applied here.
 *
 * The `bin/npm` shim is recreated as a **relative symlink** where that is what the distribution
 * has, rather than dereferenced into a file. Relative is what makes it relocatable, and keeping it
 * a link is what makes `PATH=<runtime>/bin` resolve `npm` to the same entry the launch contract
 * names instead of to a second copy that could drift.
 */
function copyNpm(execPath: string, outDir: string): { version: string; entry: ManifestPackage } {
  const installation = npmInstallation(execPath);
  const { root: nodeRoot, directory: source } = installation;

  const target = join(outDir, ...PAYLOAD_LIB_DIR.split("/"), "npm");
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, mode: constants.COPYFILE_FICLONE });

  const shimDir = process.platform === "win32" ? nodeRoot : join(nodeRoot, "bin");
  const shims = process.platform === "win32" ? ["npm.cmd", "npm.ps1", "npm"] : ["npm"];
  for (const shim of shims) {
    const from = join(shimDir, shim);
    if (!existsSync(from)) {
      continue;
    }
    const to = join(outDir, PAYLOAD_BIN_DIR, shim);
    const link = lstatSync(from).isSymbolicLink() ? readlinkSync(from) : null;
    if (link !== null && !isAbsolute(link)) {
      symlinkSync(link, to);
      continue;
    }
    copyFileSync(from, to, constants.COPYFILE_FICLONE);
    chmodSync(to, 0o755);
  }

  return {
    version: installation.version,
    entry: {
      path: `${PAYLOAD_LIB_DIR}/npm`,
      name: "npm",
      version: installation.version,
      workspace: false,
    },
  };
}

/** Where a package was copied from and what it was allowed to contribute. */
type CopyPlan = {
  repoRoot: string;
  rootPackage: string;
  libDir: string;
};

/**
 * Copy every workspace package's allowlist and the transitive closure of the external dependencies.
 *
 * Hoisting is not decoration: two packages in this closure can need different majors of the same
 * dependency, so a flat `lib/node_modules` would silently give one of them the wrong one. The
 * second version is nested under the package that asked for it, which is what npm's own layout
 * does and what the npm inside the payload expects to find.
 */
function copyClosure(plan: CopyPlan): ManifestPackage[] {
  const workspace = workspacePackages(plan.repoRoot);
  const claims = new Map<string, string>();
  const copied = new Set<string>();
  const installed: ManifestPackage[] = [];
  const seenWorkspace = new Set<string>();

  const record = (target: string, source: string, isWorkspace: boolean): void => {
    const manifest = readJson(join(source, "package.json"));
    installed.push({
      path: toPayloadPath(join(PAYLOAD_LIB_DIR, relative(plan.libDir, target))),
      name: typeof manifest.name === "string" ? manifest.name : "",
      version: typeof manifest.version === "string" ? manifest.version : "",
      workspace: isWorkspace,
    });
  };

  const installExternal = (name: string, fromDir: string, hostTarget: string): void => {
    const source = findPackageDir(fromDir, name);
    if (source === null) {
      throw new AssemblyRefusal(
        "unresolved-dependency",
        `${name}, required from ${relative(plan.repoRoot, fromDir)}, resolves to nothing in this ` +
          `checkout. Run \`pnpm install --frozen-lockfile\` and try again.`,
      );
    }
    const hoisted = join(plan.libDir, name);
    const claimed = claims.get(hoisted);
    let target: string;
    if (claimed === undefined || claimed === source) {
      claims.set(hoisted, source);
      target = hoisted;
    } else {
      target = join(hostTarget, "node_modules", name);
      if (claims.get(target) === source) {
        return;
      }
      claims.set(target, source);
    }
    if (copied.has(target)) {
      return;
    }
    copied.add(target);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      filter: (path) => !relative(source, path).split(sep).includes("node_modules"),
    });
    record(target, source, false);

    const manifest = readJson(join(source, "package.json"));
    for (const dependency of Object.keys(asDependencyMap(manifest.dependencies))) {
      installExternal(dependency, source, target);
    }
    for (const dependency of Object.keys(asDependencyMap(manifest.optionalDependencies))) {
      if (findPackageDir(source, dependency) !== null) {
        installExternal(dependency, source, target);
      }
    }
  };

  const installWorkspace = (name: string): void => {
    if (seenWorkspace.has(name)) {
      return;
    }
    seenWorkspace.add(name);
    const source = workspace.get(name);
    if (source === undefined) {
      throw new AssemblyRefusal(
        "unresolved-dependency",
        `${name} is declared as a workspace dependency and has no directory in this checkout.`,
      );
    }
    const manifest = readJson(join(source, "package.json"));
    const patterns = asPatternList(manifest.files);
    if (patterns.length === 0) {
      throw new AssemblyRefusal(
        "no-allowlist",
        `${name} declares no \`files\` allowlist. The payload is defined by what each package ` +
          `publishes, so a package with no allowlist has nothing this assembler is permitted to copy.`,
      );
    }
    const target = join(plan.libDir, name);
    const shipped = allowlistMatcher(patterns);
    for (const path of listPackageFiles(source)) {
      if (!shipped(path)) {
        continue;
      }
      const destination = join(target, path);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(source, path), destination, constants.COPYFILE_FICLONE);
    }
    record(target, source, true);

    for (const dependency of Object.keys(asDependencyMap(manifest.dependencies))) {
      if (workspace.has(dependency)) {
        installWorkspace(dependency);
      } else {
        installExternal(dependency, source, target);
      }
    }
  };

  // The root package is a *workspace* package when `repoRoot` is a checkout, and an *installed*
  // one when it is not — which is the whole of what lets this assembler read a payload out of a
  // global npm install as well as out of this repository. It used to call `installWorkspace`
  // unconditionally, so a published layout refused with `unresolved-dependency` ("declared as a
  // workspace dependency and has no directory in this checkout") before copying a byte.
  //
  // The two branches are not merely interchangeable, and the difference is why this is safe.
  // `installWorkspace` copies exactly a package's `files` allowlist, because a checkout holds
  // `src/`, tests and configs that must not travel. An installed package has already had that
  // allowlist applied to it — npm expanded the published tarball — so there is no `src/` there to
  // exclude, and reaching for the `files` field again would be applying it to a tree it had already
  // been applied to.
  //
  // **It is not byte-identical, and the difference is worth naming rather than glossing.** npm
  // ships `package.json`, `README` and `LICENSE` whatever `files` says, so the installed tree of
  // `@xplainer/cli` carries a `README.md` its allowlist does not name (measured: allowlist is
  // `dist/**/*.js`, `dist/**/*.d.ts`, `LICENSE`, `NOTICE`; the installed directory also holds
  // `README.md`). So this route's payload is the allowlist plus a few kilobytes of documentation.
  // That is acceptable — nothing resolves a module through a README — and it is the reason this
  // comment does not claim the two branches produce the same bytes.
  //
  // Nested `node_modules` are not a hazard here either: `installExternal`'s own `cpSync` filter
  // excludes that directory name at any depth, and the closure is walked by its recursive calls
  // instead, so a dependency arrives once at the hoisted position rather than twice.
  if (workspace.has(plan.rootPackage)) {
    installWorkspace(plan.rootPackage);
  } else {
    installExternal(plan.rootPackage, plan.repoRoot, plan.libDir);
  }
  installed.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return installed;
}

/** Every workspace package by name, so a `workspace:*` dependency resolves to a directory. */
function workspacePackages(repoRoot: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const group of WORKSPACE_GROUPS) {
    const base = join(repoRoot, group);
    if (!existsSync(base)) {
      continue;
    }
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const manifestFile = join(base, entry.name, "package.json");
      if (!entry.isDirectory() || !existsSync(manifestFile)) {
        continue;
      }
      const name = readJson(manifestFile).name;
      if (typeof name === "string") {
        found.set(name, join(base, entry.name));
      }
    }
  }
  return found;
}

/**
 * Where `name` resolves from `fromDir`, the way Node resolves it.
 *
 * `realpathSync` is what turns pnpm's symlink farm into the one real directory to copy: without it
 * the payload would carry a link into a store that is not travelling with it.
 */
function findPackageDir(fromDir: string, name: string): string | null {
  let directory = fromDir;
  for (;;) {
    const candidate = join(directory, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) {
      return realpathSync(candidate);
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

/** npm's `files` globs, in the subset this workspace actually uses. */
function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*" && pattern[index + 2] === "/") {
      source += "(?:[^/]+/)*";
      index += 2;
    } else if (char === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += (char ?? "").replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

/**
 * A predicate over a package-relative path: is this file in the published tarball?
 *
 * A pattern with no wildcard names a file or a whole directory, which is npm's own rule and is what
 * makes `"schemas"` ship `schemas/manifest.json`.
 */
export function allowlistMatcher(patterns: readonly string[]): (relativePath: string) => boolean {
  const globs: RegExp[] = [];
  const prefixes: string[] = [];
  for (const pattern of patterns) {
    if (/[*?]/.test(pattern)) {
      globs.push(globToRegExp(pattern));
    } else {
      prefixes.push(pattern.replace(/\/+$/, ""));
    }
  }
  return (relativePath: string): boolean => {
    const path = toPayloadPath(relativePath);
    if (ALWAYS_SHIPPED.has(path)) {
      return true;
    }
    return (
      prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)) ||
      globs.some((glob) => glob.test(path))
    );
  };
}

/** Every file under a package directory, package-relative, skipping the trees npm never packs. */
function listPackageFiles(directory: string, base: string = directory, found: string[] = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      listPackageFiles(full, base, found);
    } else if (entry.isFile()) {
      found.push(relative(base, full));
    }
  }
  return found;
}

/** The `npm ci` invocation, from payload 1 where one was given and from the machine otherwise. */
function installCommand(runtimeDir: string | undefined): { command: string; args: string[] } {
  const args = ["ci", "--no-audit", "--no-fund"];
  if (runtimeDir === undefined) {
    return { command: process.platform === "win32" ? "npm.cmd" : "npm", args };
  }
  const interpreter = join(
    runtimeDir,
    PAYLOAD_BIN_DIR,
    process.platform === "win32" ? "node.exe" : "node",
  );
  const npmCli = join(runtimeDir, ...PAYLOAD_NPM_CLI.split("/"));
  for (const file of [interpreter, npmCli]) {
    if (!existsSync(file)) {
      throw new AssemblyRefusal(
        "runtime-payload",
        `${file} does not exist, so ${runtimeDir} is not a runtime payload this install can be ` +
          `run from. Build one with \`xplainer runtime build --out <dir>\` first.`,
      );
    }
  }
  return { command: interpreter, args: [npmCli, ...args] };
}

/**
 * The install subprocess's environment: the inherited one, with `<runtime>/bin` leading `PATH`.
 *
 * Scoped to this one child on purpose. npm runs lifecycle scripts through `sh -c` and third-party
 * scripts call bare `node`, so an install from a payload under a scrubbed `PATH` exits 127 with
 * `sh: node: command not found` and leaves no workspace at all — on exactly the machine the bundled
 * npm exists for. Nothing else in this process tree gets the interpreter on its `PATH`.
 */
function installEnvironment(
  inherited: NodeJS.ProcessEnv,
  runtimeDir: string | undefined,
): NodeJS.ProcessEnv {
  if (runtimeDir === undefined) {
    return inherited;
  }
  const binDir = join(runtimeDir, PAYLOAD_BIN_DIR);
  const existing = inherited.PATH ?? inherited.Path ?? "";
  const separator = process.platform === "win32" ? ";" : ":";
  return { ...inherited, PATH: existing === "" ? binDir : `${binDir}${separator}${existing}` };
}

/** The npm that ran the install, by version, read from wherever it came from. */
function npmVersionOf(
  install: { command: string; args: string[] },
  options: AssembleWorkspaceOptions,
): string {
  if (options.runtimeDir !== undefined) {
    const manifestFile = join(
      options.runtimeDir,
      ...PAYLOAD_LIB_DIR.split("/"),
      "npm",
      "package.json",
    );
    const version = existsSync(manifestFile) ? readJson(manifestFile).version : undefined;
    return typeof version === "string" ? version : "unknown";
  }
  const probe = spawnSync(install.command, ["--version"], {
    encoding: "utf8",
    env: options.env ?? process.env,
  });
  return probe.status === 0 ? (probe.stdout ?? "").trim() : "unknown";
}

/** The template's declared pins — dependencies and devDependencies, in one map. */
function declaredPins(manifestFile: string): Record<string, string> {
  const manifest = readJson(manifestFile);
  return {
    ...asDependencyMap(manifest.dependencies),
    ...asDependencyMap(manifest.devDependencies),
  };
}

/**
 * Every package the install resolved, by name and version.
 *
 * Read off the tree rather than off the lockfile, because the tree is what will be rendered
 * against: a lockfile records what npm intended and `node_modules` records what arrived, and the
 * only one of those a `remotion versions` call can disagree with is the second.
 */
function resolvedVersions(nodeModules: string): Record<string, string> {
  const resolved: Record<string, string> = {};
  if (!existsSync(nodeModules)) {
    return resolved;
  }
  const visit = (directory: string, scope: string | null): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === ".bin") {
        continue;
      }
      const full = join(directory, entry.name);
      if (scope === null && entry.name.startsWith("@")) {
        visit(full, entry.name);
        continue;
      }
      const manifestFile = join(full, "package.json");
      if (!existsSync(manifestFile)) {
        continue;
      }
      const manifest = readJson(manifestFile);
      const name = scope === null ? entry.name : `${scope}/${entry.name}`;
      const version = manifest.version;
      resolved[name] = typeof version === "string" ? version : "";
      const nested = join(full, "node_modules");
      if (existsSync(nested)) {
        visit(nested, null);
      }
    }
  };
  visit(nodeModules, null);
  return resolved;
}

/** Write a manifest, pretty-printed with a trailing newline so a diff of two payloads reads. */
function writeManifestFile(
  directory: string,
  name: string,
  manifest: RuntimeManifest | WorkspaceManifest,
): string {
  const file = join(directory, name);
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return file;
}

/** Parse a `package.json`, as the object it is. */
function readJson(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AssemblyRefusal("malformed-manifest", `${file} is not a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

/** A `dependencies`-shaped field, as a map of name to range. */
function asDependencyMap(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const map: Record<string, string> = {};
  for (const [name, range] of Object.entries(value as Record<string, unknown>)) {
    if (typeof range === "string") {
      map[name] = range;
    }
  }
  return map;
}

/** A `files` allowlist, as the list of patterns it is. */
function asPatternList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** The size of an assembled payload, for the line `runtime build` prints. */
export function measurePayload(directory: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files += 1;
        bytes += statSync(full).size;
      }
    }
  };
  walk(directory);
  return { files, bytes };
}
