/**
 * The workspace provider: payload 2, materialised on the machine that will render with it.
 *
 * Two routes, and decision D3 requires both to be real:
 *
 * - **copy** — a payload 2 already staged on this machine (`xplainer runtime build --workspace`) is
 *   copied into the workspace. Offline and fast; the route a checkout or a CI runner takes.
 * - **resolve** — `template/package.json` and the lockfile committed beside it are installed with
 *   the npm payload 1 carries, or with this machine's own where there is no payload. Needs a
 *   network; the route a desktop user's first run takes, on a machine whose whole premise is that
 *   it has no Node.
 *
 * Round 3 named the second route and shipped no package manager, so it did not exist. Payload 1
 * now carries npm (D3, 17 MB measured), and the two ends of the pinned resolution run the **same
 * command**: `npm ci`, never `npm install` (D11). `ci` requires the lockfile to be in sync and
 * removes `node_modules` first, which is what reproducibility means here; `install` may rewrite the
 * lockfile on a user's machine and silently defeat it.
 *
 * **The lockfile has to be in the workspace before npm is invoked.** `npm ci` in a directory with
 * no `package-lock.json` exits `EUSAGE`, so `materialiseWorkspace()` copies it in with the rest of
 * the template — `package-lock.json` is a member of `WORKSPACE_FILES` for exactly this reason — and
 * this module refuses to spawn npm if either file is somehow absent, rather than letting npm report
 * a usage error a user cannot act on.
 *
 * **npm is spawned as a *script* under an explicit *interpreter*, on both routes and on every
 * platform.** The payload route has always done that — `<runtime>/bin/node` plus `npm-cli.js` — and
 * the resolve route used to spawn npm's own launcher instead, `npm` or `npm.cmd` according to the
 * platform. On Windows that never worked *at all*: since the CVE-2024-27980 fix (Node
 * ≥18.20.2/20.12.2/21.7.3, so every version this build supports) libuv's `uv_spawn` refuses a
 * `.bat`/`.cmd` application outright unless `UV_PROCESS_WINDOWS_VERBATIM_ARGUMENTS` is set, and
 * Node sets that only for `shell: true` or `windowsVerbatimArguments: true`. The rejection is in
 * libuv rather than in JS, which is why `spawnSync("npm.cmd", …)` came back as `EINVAL` carrying
 * neither a `status` nor a `signal` — **no process was created** — and why `setup` then exited `70`,
 * the unexpected-throw bucket. `shell: true` is not the fix: it hands the whole argv to `cmd.exe` to
 * re-parse, which is the quoting hazard the CVE fix exists for and which any workspace path holding
 * a space walks straight into. So the resolve route *locates* an `npm-cli.js` too
 * ({@link locateNpmCli}) and refuses by name when it cannot find one, rather than spawning a
 * launcher that one of the three platforms cannot spawn.
 *
 * **`<runtime>/bin` goes on the install subprocess's `PATH` and on nothing else (D8).** Measured by
 * both reviewers: `npm ci` from payload 1 under a scrubbed `PATH` exits **127**, because npm runs
 * lifecycle scripts through `sh -c` and `esbuild`'s `postinstall` calls bare `node`. The prepend is
 * scoped to that one child, for the duration of one install, and is composed with
 * {@link delimiter} rather than a literal `:` because Windows separates with `;`.
 *
 * **This does not reopen D1.** D1 refused `PATH` injection for *render workers* on one stated
 * ground — it leaks an interpreter onto the `PATH` of everything the worker spawns, Chrome and
 * ffmpeg included. The installer spawns neither. It spawns npm, which spawns `sh -c` package
 * scripts, and every one of those *wants* the interpreter it is being given. `--ignore-scripts` is
 * rejected: it also exits `0` today, and it makes the workspace's completeness depend on no package
 * in a 268-package tree ever needing its install script.
 *
 * **Both routes end at the same two checks**, before anything is recorded: `.bin/remotion`
 * resolves, and `workspace.manifest.json`'s resolved versions match the template's pins. The second
 * is decision D2's other half — round 3's staleness check compared only the Remotion version, which
 * is identical on both sides of the skew that made `remotion versions` exit `1`.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { materialiseWorkspace } from "@xplainer/render-core";
import {
  DAEMON_INTERNAL_EXIT_CODE,
  PRECONDITION_UNMET_EXIT_CODE,
} from "../../daemon/exit-codes.js";
import { remotionEntryPath } from "../../runtime/assemble.js";
import {
  hashFile,
  MANIFEST_VERSION,
  type ManifestFile,
  type ManifestLink,
  PAYLOAD_BIN_DIR,
  PAYLOAD_NPM_CLI,
  RUNTIME_MANIFEST_FILE,
  scanTree,
  templateDirectory,
  WORKSPACE_MANIFEST_FILE,
  type WorkspaceManifest,
} from "../../runtime/manifest.js";
import { readTemplatePins } from "../../runtime/verify.js";

/** The environment variable naming a payload 2 already staged on this machine. */
export const WORKSPACE_PAYLOAD_ENV = "XPLAINER_WORKSPACE_PAYLOAD";

/** The two files `npm ci` reads, and the two this module refuses to run without. */
export const INSTALL_INPUTS = ["package.json", "package-lock.json"] as const;

/** The command, spelled once. `ci`, never `install` (D11). */
export const INSTALL_SUBCOMMAND = "ci";

/** npm's own CLI script, spelled once. This is what gets spawned; a launcher never does. */
export const NPM_CLI_FILE = "npm-cli.js";

/** Where an npm install puts that script, relative to the directory holding its `node_modules`. */
const NPM_CLI_IN_MODULES = ["node_modules", "npm", "bin", NPM_CLI_FILE] as const;

/** Which of the two routes produced a workspace. Recorded, because they are not interchangeable. */
export type WorkspaceRoute = "copy" | "resolve";

/** Why a workspace could not be materialised, one value per distinguishable condition. */
export type WorkspaceRefusalReason =
  | "payload-missing"
  | "payload-wrong-platform"
  | "template-incomplete"
  | "no-package-manager"
  | "install-failed"
  | "install-incomplete"
  | "pin-mismatch";

/** A workspace that was not materialised, with the exit code its condition earns. */
export class WorkspaceRefusal extends Error {
  readonly reason: WorkspaceRefusalReason;
  readonly exitCode: number;

  constructor(reason: WorkspaceRefusalReason, message: string) {
    super(message);
    this.name = "WorkspaceRefusal";
    this.reason = reason;
    this.exitCode =
      reason === "install-failed" ? DAEMON_INTERNAL_EXIT_CODE : PRECONDITION_UNMET_EXIT_CODE;
  }
}

/** What a materialised workspace resolved, read back off its own manifest. */
export type WorkspaceResolution = {
  /** `<platform>-<arch>`, as the manifest records the machine the tree was resolved on. */
  platform: string;
  /**
   * The template pins this workspace was resolved **for**.
   *
   * This, and not `resolved`, is what a later staleness check compares against the template a build
   * ships: `resolved` is what arrived on the machine and `pins` is what it was asked for, and a
   * daemon update that changes a pin changes the second while the first stays exactly as it was.
   */
  pins: Readonly<Record<string, string>>;
  /** Every package the install resolved, by name. */
  resolved: Readonly<Record<string, string>>;
  /** The template package's own version, which the marker records beside the platform. */
  templateVersion: string;
  /** Workspace-relative path of the Remotion CLI entry, resolved through its `bin` field. */
  remotionEntry: string;
};

/** What {@link materialiseRenderWorkspace} was asked to do. */
export type MaterialiseOptions = {
  /** The shared Remotion workspace root. Created if it does not exist. */
  workspaceRoot: string;
  /**
   * A staged payload 2 to copy, or `undefined` to resolve the template instead.
   *
   * Defaults to {@link WORKSPACE_PAYLOAD_ENV} when that names a directory that exists. It is an
   * environment variable and not a flag on purpose: `setup --workspace --from <runtime dir>` is
   * the option §1.3d decision A rejected, and a staged *workspace* payload must not be reachable
   * through a spelling that reads like it.
   */
  payloadDir?: string | undefined;
  /**
   * The payload 1 whose interpreter and npm run the install, or `undefined` for this build's own.
   *
   * `undefined` resolves to {@link hostRuntimeDir}, which is the payload this process is running
   * out of — the one case that matters on a user's machine. In a checkout there is none, and the
   * install runs this process's own interpreter over the `npm-cli.js` {@link locateNpmCli} finds,
   * which is the checkout-or-runner half of the same decision.
   */
  runtimeDir?: string | undefined;
  /** The environment the install subprocess inherits. Defaults to this process's. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Where the provider's progress lines go. Defaults to nowhere. */
  log?: (line: string) => void;
};

/** What one {@link materialiseRenderWorkspace} call produced. */
export type MaterialisedWorkspace = {
  workspaceRoot: string;
  route: WorkspaceRoute;
  resolution: WorkspaceResolution;
  /** `<root>/node_modules/.bin/remotion`, which both routes are required to end with. */
  remotionShim: string;
};

/**
 * Materialise `<workspace>/node_modules`, by whichever of the two routes this machine has.
 *
 * The template files are copied first and by `@xplainer/render-core`'s own `materialiseWorkspace`,
 * so the workspace a `setup` produces and the workspace an `explainer_create` produces are the same
 * five files placed by the same function.
 */
export function materialiseRenderWorkspace(options: MaterialiseOptions): MaterialisedWorkspace {
  const log = options.log ?? ((): void => {});
  const root = options.workspaceRoot;
  const env = options.env ?? process.env;
  const payloadDir = options.payloadDir ?? stagedPayload(env);

  materialiseWorkspace(root);
  for (const name of INSTALL_INPUTS) {
    if (!existsSync(join(root, name))) {
      throw new WorkspaceRefusal(
        "template-incomplete",
        `${join(root, name)} is missing after the template was copied in, and \`npm ${INSTALL_SUBCOMMAND}\` ` +
          `reads both ${INSTALL_INPUTS.join(" and ")}. WORKSPACE_FILES is what places them; this ` +
          "build's @xplainer/render-core is incomplete.",
      );
    }
  }

  const route: WorkspaceRoute = payloadDir === undefined ? "resolve" : "copy";
  if (payloadDir === undefined) {
    resolveTemplate(root, options.runtimeDir ?? hostRuntimeDir(), env, log);
  } else {
    copyStagedPayload(root, payloadDir, log);
  }

  const resolution = readWorkspaceResolution(root);
  if (resolution === null) {
    throw new WorkspaceRefusal(
      "install-incomplete",
      `the ${route} route left no ${WORKSPACE_MANIFEST_FILE} beside an installed tree in ${root}, ` +
        "so nothing describes what was resolved and nothing could be recorded.",
    );
  }

  const shim = remotionShimPath(root);
  if (shim === null) {
    throw new WorkspaceRefusal(
      "install-incomplete",
      `the ${route} route produced no node_modules/.bin/remotion in ${root}. Both routes are ` +
        "required to end with that shim resolving, because it is the one file that proves npm " +
        "linked the CLI rather than merely unpacking it.",
    );
  }

  assertPinsSatisfied(root, resolution);
  log(`workspace: ${route} route, ${Object.keys(resolution.resolved).length} packages resolved`);
  return { workspaceRoot: root, route, resolution, remotionShim: shim };
}

/** A staged payload 2 named by the environment, or `undefined` when there is none. */
function stagedPayload(env: NodeJS.ProcessEnv): string | undefined {
  const named = env[WORKSPACE_PAYLOAD_ENV];
  if (named === undefined || named.trim() === "") {
    return undefined;
  }
  return named;
}

/**
 * Copy a staged payload 2 into the workspace, symlinks and all.
 *
 * `verbatimSymlinks` is load-bearing: npm materialises `node_modules/.bin/remotion` as a **relative
 * symlink** into `@remotion/cli`, and a copy that dereferenced it would produce a `.bin` entry that
 * is a copy of a file whose `#!/usr/bin/env node` shebang then resolves against nothing. The
 * payload's manifest records links as *targets* for the same reason.
 */
function copyStagedPayload(root: string, payloadDir: string, log: (line: string) => void): void {
  const manifestFile = join(payloadDir, WORKSPACE_MANIFEST_FILE);
  if (!existsSync(manifestFile)) {
    throw new WorkspaceRefusal(
      "payload-missing",
      `${payloadDir} has no ${WORKSPACE_MANIFEST_FILE}, so it is not a staged workspace payload. ` +
        `Build one with \`xplainer runtime build --workspace --out ${payloadDir}\`, or unset ` +
        `${WORKSPACE_PAYLOAD_ENV} to resolve the template over the network instead.`,
    );
  }
  const staged = readWorkspaceResolution(payloadDir);
  if (staged === null) {
    throw new WorkspaceRefusal(
      "payload-missing",
      `${manifestFile} is not a readable workspace manifest, so what is staged at ${payloadDir} ` +
        "cannot be established and nothing was copied.",
    );
  }
  const host = `${process.platform}-${process.arch}`;
  if (staged.platform !== host) {
    throw new WorkspaceRefusal(
      "payload-wrong-platform",
      `${payloadDir} was resolved for ${staged.platform} and this machine is ${host}. ` +
        "@remotion/compositor-<platform> is a platform-specific optional dependency, so a payload " +
        "is only valid on the platform it was built on. Build one here, or unset " +
        `${WORKSPACE_PAYLOAD_ENV} to resolve the template over the network instead.`,
    );
  }

  // Removed first, exactly as `npm ci` removes `node_modules` before it installs (D11). Two
  // reasons, and both are about a *second* run: `cpSync` refuses to write a symlink over one that
  // is already there (`EEXIST` on `.bin/remotion`, measured), and copying a new payload *over* an
  // old tree would leave every package the new one dropped still sitting in it — a workspace that
  // is neither payload, whose manifest describes only one of them.
  log(`workspace: copying the staged payload at ${payloadDir}`);
  rmSync(join(root, "node_modules"), { recursive: true, force: true });
  for (const name of ["node_modules", ...INSTALL_INPUTS, WORKSPACE_MANIFEST_FILE]) {
    const source = join(payloadDir, name);
    if (!existsSync(source)) {
      continue;
    }
    cpSync(source, join(root, name), {
      recursive: true,
      force: true,
      verbatimSymlinks: true,
    });
  }
}

/**
 * Resolve `template/package.json` with npm, and describe the tree that arrived.
 *
 * The invocation is D8's, written out rather than composed, because every part of it is a decision:
 *
 * ```
 * <runtime>/bin/node[.exe] <runtime>/lib/node_modules/npm/bin/npm-cli.js ci
 *   cwd: <workspace>
 *   env: { ...parent, PATH: `<runtime>/bin` + path.delimiter + parent.PATH }
 * ```
 *
 * With no payload it is the **same shape** over this machine's own two pieces — the interpreter
 * already running this code, and whichever `npm-cli.js` {@link locateNpmCli} found beside it — and
 * the environment is the parent's, untouched. Same shape rather than a launcher, because one of the
 * three platforms cannot spawn a launcher at all; the module docblock carries that measurement.
 *
 * ```
 * <process.execPath> <…>/npm/bin/npm-cli.js ci
 *   cwd: <workspace>
 * ```
 */
function resolveTemplate(
  root: string,
  runtimeDir: string | null,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
): void {
  const install = installCommand(runtimeDir);
  log(`workspace: ${install.command} ${install.args.join(" ")} (cwd ${root})`);
  const result = spawnSync(install.command, install.args, {
    cwd: root,
    encoding: "utf8",
    env: installEnvironment(env, runtimeDir),
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = [result.stdout ?? "", result.stderr ?? "", result.error?.message ?? ""]
      .join("")
      .trim();
    throw new WorkspaceRefusal(
      "install-failed",
      `\`npm ${INSTALL_SUBCOMMAND}\` in ${root} exited ` +
        `${String(result.status ?? result.signal ?? "without running")}:\n${detail}`,
    );
  }
  writeWorkspaceManifest(root, install);
}

/**
 * What the resolve route is allowed to assume about the machine it runs on, as arguments.
 *
 * Every field defaults to this process's own answer, and every field exists so that the win32
 * spelling is assertable from a suite running on the other two platforms — the same reason
 * `install/supervisors/`'s three renderers take a platform. The bug this seam was added for
 * reproduced on `win32` and nowhere else, and this package mocks nothing.
 */
export type InstallHost = {
  /** The platform whose spelling of the interpreter is wanted. Defaults to this process's. */
  platform?: NodeJS.Platform | undefined;
  /** The interpreter the resolve route runs npm under. Defaults to `process.execPath`. */
  execPath?: string | undefined;
  /** The `PATH` npm is looked for on, after the interpreter's own layout. Defaults to this process's. */
  path?: string | undefined;
};

/**
 * The interpreter and argv the install runs as: the payload's pair where there is a payload, and
 * this process's own interpreter over a located `npm-cli.js` where there is not.
 *
 * One shape, two sources. The first argument is always npm's CLI script and the command is always
 * an interpreter, because a launcher is not spawnable on Windows and `shell: true` is not an answer
 * — the module docblock carries that measurement.
 */
export function installCommand(
  runtimeDir: string | null,
  host: InstallHost = {},
): {
  command: string;
  args: string[];
} {
  const args = [INSTALL_SUBCOMMAND, "--no-audit", "--no-fund"];
  if (runtimeDir === null) {
    const execPath = host.execPath ?? process.execPath;
    const npmCli = locateNpmCli(host);
    if (npmCli === null) {
      throw new WorkspaceRefusal(
        "no-package-manager",
        `no ${NPM_CLI_FILE} could be found for the resolve route: not beside the interpreter at ` +
          `${execPath}, and not beside any \`npm\` on \`PATH\`. The route spawns npm as ` +
          `\`<interpreter> ${NPM_CLI_FILE} ${INSTALL_SUBCOMMAND}\` — an explicit script under an ` +
          "explicit interpreter — because npm's own launcher cannot be spawned on Windows at all: " +
          "libuv refuses a `.cmd` application without `shell: true`, and `shell: true` re-opens " +
          "the quoting hazard CVE-2024-27980's fix exists for. Install npm beside this " +
          "interpreter, or stage a runtime payload, which carries its own (D3).",
      );
    }
    return { command: execPath, args: [npmCli, ...args] };
  }
  const interpreter = join(runtimeDir, PAYLOAD_BIN_DIR, interpreterName(host.platform));
  const npmCli = join(runtimeDir, ...PAYLOAD_NPM_CLI.split("/"));
  for (const file of [interpreter, npmCli]) {
    if (!existsSync(file)) {
      throw new WorkspaceRefusal(
        "no-package-manager",
        `${file} does not exist, so ${runtimeDir} carries no package manager this install can be ` +
          "run with. A runtime payload carries its own interpreter and its own npm (D3); this one " +
          "does not.",
      );
    }
  }
  return { command: interpreter, args: [npmCli, ...args] };
}

/**
 * The `npm-cli.js` this machine has, or `null` when it has none.
 *
 * **The interpreter's own npm is asked for first, and `PATH` is the fallback.** The route supplies
 * the interpreter explicitly now, so the npm that shipped beside that interpreter is the pair which
 * was tested together — and it is the answer that does not depend on a `PATH` this very route is
 * proved under a scrubbed copy of (D8). `PATH` is still searched, because a Node installed without
 * its own npm is a real machine and a refusal there would be a refusal over something the host can
 * plainly do.
 *
 * Two layouts are tried per directory, and between them they are every npm install this code will
 * meet: `<dir>/node_modules/npm/…`, which is Windows's, and `<dir>/../lib/node_modules/npm/…`,
 * which is the POSIX prefix's. A launcher on `PATH` is also **followed**, because on POSIX `npm` is
 * a symlink onto the script itself and that is the shortest true answer; a launcher whose real path
 * is not the script — a `.cmd`, a Volta or Corepack shim — is rejected rather than spawned, and its
 * directory is searched for the two layouts instead.
 */
export function locateNpmCli(host: InstallHost = {}): string | null {
  for (const candidate of npmCliCandidates(host)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Every `npm-cli.js` worth asking about, in the order the answer is taken from. */
function npmCliCandidates(host: InstallHost): string[] {
  const platform = host.platform ?? process.platform;
  const execPath = host.execPath ?? process.execPath;
  const pathValue = host.path ?? process.env.PATH ?? process.env.Path ?? "";
  const candidates = npmInstallsBeside(dirname(execPath));
  for (const directory of pathValue.split(delimiter)) {
    if (directory.trim() === "") {
      continue;
    }
    for (const name of npmLauncherNames(platform)) {
      const launcher = join(directory, name);
      if (!existsSync(launcher)) {
        continue;
      }
      const real = realPath(launcher);
      if (real !== null && basename(real) === NPM_CLI_FILE) {
        candidates.push(real);
      }
      candidates.push(...npmInstallsBeside(directory));
    }
  }
  return candidates;
}

/** The two layouts an npm install takes beside a directory holding an interpreter's launchers. */
function npmInstallsBeside(binDir: string): string[] {
  return [join(binDir, ...NPM_CLI_IN_MODULES), join(binDir, "..", "lib", ...NPM_CLI_IN_MODULES)];
}

/** The names an `npm` launcher goes by — which is where Windows differs, and why this mattered. */
function npmLauncherNames(platform: NodeJS.Platform): readonly string[] {
  return platform === "win32" ? ["npm.cmd", "npm.exe", "npm.bat", "npm"] : ["npm"];
}

/** `realpathSync` as an answer rather than a throw, for a link this code did not create. */
function realPath(file: string): string | null {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
}

/** `node` or `node.exe`, which is the only place this build spells the difference. */
function interpreterName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "node.exe" : "node";
}

/**
 * The install subprocess's environment: the inherited one, with `<runtime>/bin` leading `PATH`.
 *
 * `delimiter` from `node:path`, never a literal `:` — Windows separates with `;`, and a literal
 * would produce one unusable entry there instead of two usable ones. Nothing else in this process
 * tree is given the interpreter.
 */
export function installEnvironment(
  inherited: NodeJS.ProcessEnv,
  runtimeDir: string | null,
): NodeJS.ProcessEnv {
  if (runtimeDir === null) {
    return inherited;
  }
  const binDir = join(runtimeDir, PAYLOAD_BIN_DIR);
  const existing = inherited.PATH ?? inherited.Path ?? "";
  return {
    ...inherited,
    PATH: existing === "" ? binDir : `${binDir}${delimiter}${existing}`,
  };
}

/**
 * The payload 1 this process is running out of, or `null` in a checkout.
 *
 * Walked from this module's own file rather than from `process.execPath`, because the question is
 * "which payload is this code in", and a payload's interpreter can be borrowed by a caller running
 * a checkout's sources. A directory only answers if it has all three of the files a payload is
 * defined by, so a coincidence of layout cannot be mistaken for one.
 */
export function hostRuntimeDir(
  from: string = fileURLToPath(new URL(".", import.meta.url)),
): string | null {
  let directory = from;
  for (;;) {
    const complete = [
      join(directory, RUNTIME_MANIFEST_FILE),
      join(directory, PAYLOAD_BIN_DIR, interpreterName()),
      join(directory, ...PAYLOAD_NPM_CLI.split("/")),
    ].every((file) => existsSync(file));
    if (complete) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

/** `node_modules/.bin/remotion`, or `null` when npm never linked it. */
export function remotionShimPath(root: string): string | null {
  const name = process.platform === "win32" ? "remotion.cmd" : "remotion";
  const candidate = join(root, "node_modules", ".bin", name);
  return existsSync(candidate) ? candidate : null;
}

/**
 * Describe the tree the resolve route produced, as `workspace.manifest.json`.
 *
 * The document is the one `runtime build --workspace` writes, field for field, because `daemon
 * update`'s compatibility check and `runtime verify --workspace` read whichever of the two routes
 * produced the workspace and must not be able to tell them apart.
 */
function writeWorkspaceManifest(root: string, install: { command: string; args: string[] }): void {
  const remotionEntry = remotionEntryPath(root);
  if (remotionEntry === null) {
    throw new WorkspaceRefusal(
      "install-incomplete",
      `the install in ${root} produced no @remotion/cli entry, so nothing in it could render. ` +
        "Its `bin` field is what names that file, and the package is missing from the tree.",
    );
  }
  const payload = scanWorkspacePayload(root);
  const manifest: WorkspaceManifest = {
    kind: "workspace",
    manifest_version: MANIFEST_VERSION,
    created_at: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node_version: process.version,
    npm_version: npmVersionOf(install),
    installer: `npm ${INSTALL_SUBCOMMAND}`,
    pins: readTemplatePins(),
    resolved: resolvedVersions(join(root, "node_modules")),
    remotion_entry: remotionEntry,
    files: payload.files,
    links: payload.links,
  };
  writeJson(join(root, WORKSPACE_MANIFEST_FILE), manifest);
}

/**
 * Every file and link the payload owns — `node_modules` and the two install inputs, nothing else.
 *
 * The workspace root also holds `videos/`, `public/`, `out/` and three template files, which the
 * payload's manifest has never described and must not start describing: they are the user's work
 * and a manifest that recorded their hashes would report every rendered frame as drift.
 */
function scanWorkspacePayload(root: string): { files: ManifestFile[]; links: ManifestLink[] } {
  const modules = join(root, "node_modules");
  const scan = existsSync(modules) ? scanTree(modules) : { files: [], links: [] };
  const files: ManifestFile[] = scan.files.map((entry) => ({
    ...entry,
    path: `node_modules/${entry.path}`,
  }));
  const links: ManifestLink[] = scan.links.map((entry) => ({
    ...entry,
    path: `node_modules/${entry.path}`,
  }));
  for (const name of INSTALL_INPUTS) {
    const file = join(root, name);
    const stats = lstatSync(file);
    files.push({
      path: name,
      sha256: hashFile(file),
      bytes: stats.size,
      executable: process.platform !== "win32" && (stats.mode & 0o111) !== 0,
    });
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  links.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { files, links };
}

/**
 * The npm that ran the install, by version, read off the package the script belongs to.
 *
 * One reader for both routes, because both now spawn a `npm-cli.js` and `<…>/npm/bin/npm-cli.js`
 * always has npm's own `package.json` two directories up. It used to be two readers, and the second
 * was `spawnSync(install.command, ["--version"])` — a second instance of the bug this file was
 * fixed for on the resolve route, and a second `npm.cmd` that `EINVAL`ed on Windows into a recorded
 * `"unknown"`. There is no spawn here now, which is also 0 ms rather than npm's start-up.
 */
function npmVersionOf(install: { command: string; args: string[] }): string {
  const npmCli = install.args[0];
  if (npmCli === undefined) {
    return "unknown";
  }
  const manifestFile = join(dirname(dirname(npmCli)), "package.json");
  if (!existsSync(manifestFile)) {
    return "unknown";
  }
  const version = readJson(manifestFile).version;
  return typeof version === "string" ? version : "unknown";
}

/**
 * Read back what a materialised workspace resolved, or `null` when it has not been installed.
 *
 * `null` covers every "there is no workspace here" case in one answer — no manifest, an unreadable
 * one, a manifest that is not a workspace manifest — because the repair for all of them is the same
 * command and the gate that calls this has one sentence to print.
 */
export function readWorkspaceResolution(root: string): WorkspaceResolution | null {
  const manifestFile = join(root, WORKSPACE_MANIFEST_FILE);
  if (!existsSync(manifestFile)) {
    return null;
  }
  let document: Record<string, unknown>;
  try {
    document = readJson(manifestFile);
  } catch {
    return null;
  }
  if (document.kind !== "workspace") {
    return null;
  }
  const platform = document.platform;
  const arch = document.arch;
  const remotionEntry = document.remotion_entry;
  if (
    typeof platform !== "string" ||
    typeof arch !== "string" ||
    typeof remotionEntry !== "string"
  ) {
    return null;
  }
  const resolved = asVersionMap(document.resolved);
  const pins = asVersionMap(document.pins);
  if (resolved === null || pins === null) {
    return null;
  }
  return {
    platform: `${platform}-${arch}`,
    pins,
    resolved,
    templateVersion: templateVersion(),
    remotionEntry,
  };
}

/** The template package's own version, which is what the marker records beside the platform. */
export function templateVersion(): string {
  const manifest = readJson(join(templateDirectory(), "package.json"));
  return typeof manifest.version === "string" && manifest.version !== ""
    ? manifest.version
    : "unknown";
}

/** Refuse a workspace the template no longer describes, before anything records it as good. */
function assertPinsSatisfied(root: string, resolution: WorkspaceResolution): void {
  const pins = readTemplatePins();
  for (const name of Object.keys(pins).sort()) {
    const expected = pins[name] as string;
    const found = resolution.resolved[name];
    if (found !== expected) {
      throw new WorkspaceRefusal(
        "pin-mismatch",
        `the workspace at ${root} resolved ${name} ${found ?? "nothing"} and this build's ` +
          `template pins ${expected}. Remotion polices its own tree — \`remotion versions\` exits ` +
          "1 on a skew like this — so a render would fail after the job had started. The " +
          "workspace was left as it is and nothing was recorded.",
      );
    }
  }
}

/** Every package the install resolved, by name and version, read off the tree rather than the lock. */
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
      const name = scope === null ? entry.name : `${scope}/${entry.name}`;
      const version = readJson(manifestFile).version;
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

function asVersionMap(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const map: Record<string, string> = {};
  for (const [name, version] of Object.entries(value as Record<string, unknown>)) {
    if (typeof version !== "string") {
      return null;
    }
    map[name] = version;
  }
  return map;
}

function readJson(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WorkspaceRefusal("install-incomplete", `${file} is not a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
