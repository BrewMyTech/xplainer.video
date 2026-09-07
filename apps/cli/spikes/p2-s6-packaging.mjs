#!/usr/bin/env node
/**
 * Spike P2-S6 — packaging: what a relocated `xplainer` payload resolves at run time.
 *
 * P2-S6 is the phase-2 packaging comparison — the spike that decides how this phase ships the
 * runtime, beside `docs/ROADMAP.md`'s P2-S4 and P2-S5, whose own roadmap row lands with the rest of
 * the phase-2 records. `apps/cli/packaging/README.md` is the *record* half of its answer: the
 * single-executable (SEA) recipe and the five measurements made against it, with their dates. This
 * script is the *live* half. It exits `0` when every expectation held and non-zero when one did
 * not, so it is a check and not a demo:
 *
 *     node apps/cli/spikes/p2-s6-packaging.mjs
 *
 * It is plain Node with no dependencies and it is deliberately **not** part of the build
 * (`tsconfig.json` and `tsconfig.build.json` both `include` only `src`), in the shape
 * `spikes/p1-s1-ownership.mjs` set. Unlike that spike it does need `dist/` — a packaging check over
 * an unbuilt payload would be a check over nothing — so it refuses with the one command that fixes
 * it rather than guessing.
 *
 * WHAT IT DOES NOT ASSERT, AND WHY.
 *
 * The obvious spike here freezes today's defects: assert that the CommonJS bundle still fails, that
 * `import.meta.url` is still emptied at six named source locations, that a `dist`-only payload
 * still dies at load. Every one of those assertions breaks by *improving* — a future esbuild that
 * supports top-level `await` in `cjs`, a Node that accepts an ESM SEA main, a refactor that moves
 * one of the six lines. Those three measurements are therefore **recorded** in
 * `apps/cli/packaging/README.md`, with their dates and their verbatim output, so a later reader
 * finds the measurement instead of repeating it. Nothing here asserts them.
 *
 * WHAT IT ASSERTS, AND WHY THOSE.
 *
 * These are the properties that must keep holding whatever the six sites become, and each one is
 * asserted against the **assembled artefact** rather than against a source location:
 *
 *   1. Every path the built payload resolves at run time exists inside the artefact. That is the
 *      general form of the `ERR_MODULE_NOT_FOUND` the README records: a payload assembled from the
 *      `files` allowlists must be able to reach every module and every data file it opens.
 *   2. Nothing the payload resolves inside a workspace package falls outside that package's `files`
 *      allowlist. A path that is reachable only because the repository is beside it is a path that
 *      is gone once the package is published.
 *   3. No `.ts` source is resolved out of a package's build output, and none is among the
 *      arguments the payload spawns. `daemon/workers.ts` has a TypeScript fallback for the
 *      narration worker that exists for Vitest; a payload that reached it would be a payload that
 *      cannot narrate once published, and it would do so silently. The rule names `dist/` rather
 *      than every `.ts` because `render-core`'s `template/remotion.config.ts` is shipped on
 *      purpose — it is copied into a user's workspace, whose own toolchain compiles it — so it is
 *      reported as data rather than asserted away.
 *   4. The artefact answers `--version` with no `node` on `PATH` and — separately — with no
 *      environment at all, which is the whole premise of shipping an interpreter.
 *
 * HOW "RESOLVED AT RUN TIME" IS MEASURED, RATHER THAN ASSUMED.
 *
 * Node's ESM and CommonJS loaders both read module sources through the public `node:fs`
 * `readFileSync`, so one `fs` hook records the entire module graph *and* every data file the
 * payload opens, in one list, without naming a single source site. The hook is installed with
 * `--import` into every process the exercise runs: the probe, and the narration worker the probe's
 * own `WorkerSpec` names.
 *
 * Measured, and the reason the hook is a generated `.cjs` file rather than part of this module: a
 * builtin's ES-module facade snapshots its exports when it is first imported, so patching
 * `node:fs` after any `import … from "node:fs"` has run is invisible to every later named import.
 * A CommonJS preload touches only `require("node:fs")` and is therefore installed before the facade
 * exists.
 *
 * WHAT THE EXERCISE IS. The probe runs inside the artefact, under a `PATH` that resolves nothing,
 * and drives the four production paths that resolve files relative to a module:
 *
 *   * it imports every shipped `.js` module of every `@xplainer` package in the payload, which is
 *     how `@xplainer/protocol/schemas/manifest.json` gets reached from `mcp-server`;
 *   * it materialises a workspace, which copies `render-core`'s `template/` files;
 *   * it scaffolds one video, which reads `render-core`'s six `dist/scaffold/templates/*.txt`;
 *   * it builds the real narration `WorkerSpec` and runs it, so the worker entry is resolved and
 *     spawned exactly as the daemon spawns it — by the payload's own interpreter, on a machine with
 *     no other one.
 *
 * PLATFORM. POSIX. The `env -i` half shells out to `/bin/sh`, as `spikes/p1-s1-ownership.mjs` does
 * for `ps`; Windows packaging is `docs/adr/0024`'s and P2-S5's business, not this one's.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The package whose runtime dependency closure is the payload. */
const ROOT_PACKAGE = "@xplainer/cli";

/** Where the artefact puts the interpreter and the packages, per plan §2.1's layout. */
const BIN_DIR = "bin";
const LIB_DIR = join("lib", "node_modules");

/** npm ships this whatever `files` says, and `version.ts` reads it at startup. */
const ALWAYS_SHIPPED = new Set(["package.json"]);

/** The video the probe scaffolds and narrates. */
const SLUG = "spike";
const JOB_ID = 1;

/**
 * Two real sentences, because a dry run still measures them. Placeholder text would produce word
 * spans of a shape no synthesiser returns, which is the failure `scripts/e2e/render.mjs` avoids the
 * same way.
 */
const NARRATION = {
  voice: "af_heart",
  fps: 30,
  segments: [
    { id: "one", text: "A packaged runtime carries its own interpreter and its own data files." },
    { id: "two", text: "This spike proves every one of those files is still reachable." },
  ],
};

const SELF = fileURLToPath(import.meta.url);

function out(line) {
  process.stdout.write(`${line}\n`);
}

function quote(text) {
  return text
    .trimEnd()
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n");
}

let failures = 0;

function expect(label, actual, wanted) {
  const ok = actual === wanted;
  if (!ok) {
    failures += 1;
  }
  out(
    `    ${ok ? "PASS" : "FAIL"}  ${label}: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`,
  );
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The checkout this spike is part of, found by the marker every worktree has. */
function findRepoRoot() {
  let dir = dirname(SELF);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return realpathSync(dir);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`no pnpm-workspace.yaml above ${SELF}; run this from a checkout.`);
    }
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot();

/** Every workspace package by name, so `workspace:*` dependencies resolve to a directory. */
function workspacePackages() {
  const found = new Map();
  for (const group of ["apps", "packages", "services"]) {
    const base = join(REPO_ROOT, group);
    if (!existsSync(base)) {
      continue;
    }
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const manifest = join(base, entry.name, "package.json");
      if (!entry.isDirectory() || !existsSync(manifest)) {
        continue;
      }
      const name = readJson(manifest).name;
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
 * `realpathSync` is what turns pnpm's symlink farm into the one real directory to copy.
 */
function findPackageDir(fromDir, name) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) {
      return realpathSync(candidate);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** npm's `files` globs, in the subset the workspace actually uses. */
function globToRegExp(pattern) {
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
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
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
function allowlistMatcher(patterns) {
  const globs = [];
  const prefixes = [];
  for (const pattern of patterns) {
    if (/[*?]/.test(pattern)) {
      globs.push(globToRegExp(pattern));
    } else {
      prefixes.push(pattern.replace(/\/+$/, ""));
    }
  }
  return (relativePath) => {
    const path = relativePath.split(sep).join("/");
    if (ALWAYS_SHIPPED.has(path)) {
      return true;
    }
    return (
      prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)) ||
      globs.some((glob) => glob.test(path))
    );
  };
}

/** Every file under `dir`, package-relative, skipping the trees npm never packs. */
function listFiles(dir, base = dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      listFiles(full, base, found);
    } else if (entry.isFile()) {
      found.push(relative(base, full));
    }
  }
  return found;
}

/**
 * Copy an installed package as npm left it.
 *
 * The `filter` is relative to the package root on purpose: an absolute test would match the
 * `node_modules` in pnpm's own store path and copy nothing at all.
 */
function copyTree(source, target) {
  cpSync(source, target, {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
    filter: (path) => !relative(source, path).split(sep).includes("node_modules"),
  });
}

/**
 * The whole artefact, counted.
 *
 * Separate from {@link listFiles} because that one skips `node_modules` — which is right for a
 * package that is about to be published and wrong for a payload whose every dependency lives
 * under exactly that name.
 */
function measure(dir, totals = { files: 0, bytes: 0 }) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      measure(full, totals);
    } else if (entry.isFile()) {
      totals.files += 1;
      totals.bytes += statSync(full).size;
    }
  }
  return totals;
}

/**
 * Assemble the payload: the interpreter, every workspace package's `files` allowlist, and the
 * transitive closure of the external runtime dependencies.
 *
 * Hoisting is not decoration. Two packages in this closure need different `content-type` majors, so
 * a flat `lib/node_modules` would silently give one of them the wrong one; the second version is
 * nested under the package that asked for it, which is what npm's own layout does.
 */
function assemble(root) {
  const lib = join(root, LIB_DIR);
  mkdirSync(join(root, BIN_DIR), { recursive: true });
  mkdirSync(lib, { recursive: true });

  const interpreter = join(root, BIN_DIR, "node");
  copyFileSync(process.execPath, interpreter, constants.COPYFILE_FICLONE);
  chmodSync(interpreter, 0o755);

  const workspace = workspacePackages();
  const claims = new Map();
  const copied = new Set();
  const nested = [];
  const unresolved = [];
  const packages = new Map();
  let externals = 0;

  function installExternal(name, fromDir, hostTarget) {
    const source = findPackageDir(fromDir, name);
    if (source === null) {
      unresolved.push(`${name} from ${relative(REPO_ROOT, fromDir)}`);
      return;
    }
    const hoisted = join(lib, name);
    const claimed = claims.get(hoisted);
    let target;
    if (claimed === undefined || claimed === source) {
      claims.set(hoisted, source);
      target = hoisted;
    } else {
      target = join(hostTarget, "node_modules", name);
      if (claims.get(target) === source) {
        return;
      }
      claims.set(target, source);
      nested.push(
        `${name}@${readJson(join(source, "package.json")).version} under ${relative(lib, hostTarget)}`,
      );
    }
    if (copied.has(target)) {
      return;
    }
    copied.add(target);
    mkdirSync(dirname(target), { recursive: true });
    copyTree(source, target);
    externals += 1;
    const manifest = readJson(join(source, "package.json"));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      installExternal(dependency, source, target);
    }
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
      if (findPackageDir(source, dependency) !== null) {
        installExternal(dependency, source, target);
      }
    }
  }

  function installWorkspace(name) {
    if (packages.has(name)) {
      return;
    }
    const source = workspace.get(name);
    if (source === undefined) {
      throw new Error(`${name} is a workspace dependency with no directory in this checkout.`);
    }
    const manifest = readJson(join(source, "package.json"));
    const patterns = manifest.files ?? [];
    const target = join(lib, name);
    packages.set(name, { source, target, patterns });
    const shipped = allowlistMatcher(patterns);
    for (const path of listFiles(source)) {
      if (!shipped(path)) {
        continue;
      }
      const destination = join(target, path);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(source, path), destination, constants.COPYFILE_FICLONE);
    }
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (workspace.has(dependency)) {
        installWorkspace(dependency);
      } else {
        installExternal(dependency, source, target);
      }
    }
  }

  installWorkspace(ROOT_PACKAGE);

  const { files, bytes } = measure(root);
  return { root, lib, interpreter, packages, externals, nested, unresolved, files, bytes };
}

/**
 * The `--import` preload that records what a process resolves.
 *
 * Serialised with `Function.prototype.toString`, so it is ordinary reviewed source here and a
 * CommonJS file there. It must stay closure-free: nothing outside this function body survives the
 * round trip, and its only inputs are `process.env`.
 */
function recorderModule() {
  const fs = require("node:fs");
  const promises = require("node:fs/promises");
  const { fileURLToPath: toPath } = require("node:url");
  const append = fs.appendFileSync;
  const log = process.env.P2_S6_LOG;

  const READS = [
    "readFileSync",
    "copyFileSync",
    "createReadStream",
    "openSync",
    "opendirSync",
    "readdirSync",
    "readlinkSync",
    "realpathSync",
  ];
  const PROBES = ["existsSync", "statSync", "lstatSync", "accessSync"];

  function record(api, kind, value) {
    let path;
    if (typeof value === "string") {
      path = value;
    } else if (value instanceof URL) {
      path = value.href;
    } else if (Buffer.isBuffer(value)) {
      path = value.toString("utf8");
    } else {
      return;
    }
    if (path.startsWith("file:")) {
      path = toPath(path);
    }
    append(log, `${JSON.stringify({ api, kind, path, pid: process.pid })}\n`);
  }

  function patch(holder, label, api, kind) {
    const original = holder[api];
    if (typeof original !== "function") {
      return;
    }
    Object.defineProperty(holder, api, {
      value: function recorded(...args) {
        record(`${label}.${api}`, kind, args[0]);
        return original.apply(this, args);
      },
      writable: true,
      configurable: true,
    });
  }

  for (const [api, kind] of [
    ...READS.map((name) => [name, "read"]),
    ...PROBES.map((name) => [name, "probe"]),
  ]) {
    patch(fs, "fs", api, kind);
    patch(promises, "fs/promises", api.replace(/Sync$/, ""), kind);
  }
}

/**
 * The exercise, run by the artefact's own interpreter from outside the artefact.
 *
 * Outside on purpose: a probe living inside the payload would itself be a file no `files` allowlist
 * names, and the first expectation would fail on the harness rather than on the payload.
 */
async function probeModule() {
  try {
    await exercise();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }

  async function exercise() {
    const fs = require("node:fs");
    const path = require("node:path");
    const { pathToFileURL: toUrl } = require("node:url");
    const { spawnSync: spawn } = require("node:child_process");

    const config = JSON.parse(fs.readFileSync(process.env.P2_S6_CONFIG, "utf8"));
    const load = (file) => import(toUrl(file).href);

    const renderCore = await load(path.join(config.renderCoreDist, "index.js"));
    const jobRequest = await load(path.join(config.cliDist, "job-request.js"));
    const workers = await load(path.join(config.cliDist, "daemon", "workers.js"));
    const version = await load(path.join(config.cliDist, "version.js"));

    const workspace = renderCore.materialiseWorkspace(config.workspace);
    const video = renderCore.videoPaths(config.workspace, config.slug);
    const scaffold = renderCore.scaffoldVideo(video.source);

    fs.mkdirSync(video.publicDir, { recursive: true });
    fs.writeFileSync(video.narrationSpec, JSON.stringify(config.narration, null, 2));
    jobRequest.writeJobRequest(config.workspace, config.jobId, {
      job_type: "explainer_narrate",
      slug: config.slug,
      dry_run: true,
    });

    const spec = workers
      .createWorkerRegistry({ root: config.workspace })
      .explainer_narrate({ job_id: config.jobId, video_id: config.slug });
    spec.release();

    const worker = spawn(spec.command, ["--import", toUrl(config.recorder).href, ...spec.args], {
      cwd: spec.cwd,
      encoding: "utf8",
      env: { P2_S6_LOG: process.env.P2_S6_LOG, PATH: config.scrubDir },
    });

    const spawned = new Set(spec.args);
    const imported = [];
    for (const module of config.sweep) {
      if (spawned.has(module)) {
        continue;
      }
      await load(module);
      imported.push(module);
    }

    process.stdout.write(
      `P2S6-RESULT ${JSON.stringify({
        cliVersion: version.CLI_VERSION,
        interpreter: process.execPath,
        workerCommand: spec.command,
        workerArgs: spec.args,
        workerStatus: worker.status,
        workerStdout: worker.stdout ?? "",
        workerStderr: worker.stderr ?? "",
        workspaceCreated: workspace.created,
        scaffoldCreated: scaffold.created,
        importedCount: imported.length,
        audio: video.audio,
        timings: video.timings,
        captions: video.captions,
      })}\n`,
    );
  }
}

/** Write a serialised function out as the CommonJS preload or entry it has to be. */
function writeModule(file, body, tail) {
  writeFileSync(file, `(${body.toString()})${tail}\n`);
  return file;
}

/** One recorded line, normalised to an absolute path. */
function readLog(file) {
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

function under(path, root) {
  return path === root || path.startsWith(root + sep);
}

/**
 * Is this package-relative path part of the package's compiled output?
 *
 * The distinction the `.ts` expectation turns on. `dist/` is what `tsc` wrote and what the payload
 * executes, so a `.ts` there is source that was meant to be compiled and was not — the shape of
 * `daemon/workers.ts`'s Vitest fallback, which resolves `dist/workers/narrate.ts` and a `.ts`
 * loader hook when the compiled worker is missing. `template/` is the opposite: `remotion.config.ts`
 * is data this payload copies into a user's Remotion workspace, where that workspace's own
 * toolchain compiles it, and it is shipped on purpose by `render-core`'s `files` allowlist.
 */
function isCompiledOutput(relativePath) {
  const path = relativePath.split(sep).join("/");
  return path === "dist" || path.startsWith("dist/");
}

/** Which package in the artefact owns a recorded path, and what it is called there. */
function ownerOf(path, artefact) {
  for (const [name, entry] of artefact.packages) {
    if (under(path, entry.target)) {
      return { name, entry, relativePath: relative(entry.target, path) };
    }
  }
  return null;
}

function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

async function runAll() {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "p2-s6-")));
  out(`P2-S6 packaging spike — ${new Date().toISOString()}`);
  out(`node ${process.version} on ${process.platform}/${process.arch}, scratch root ${scratch}`);
  out(`checkout ${REPO_ROOT}`);

  const built = join(REPO_ROOT, "apps", "cli", "dist", "bin.js");
  if (!existsSync(built)) {
    out("");
    out(`  ${built} does not exist: this spike measures the built payload, not the sources.`);
    out("  Run `pnpm --filter @xplainer/cli build` (or `pnpm build`) and try again.");
    rmSync(scratch, { recursive: true, force: true });
    process.exitCode = 1;
    return;
  }

  try {
    out("");
    out("1. ASSEMBLE — the interpreter, the `files` allowlists, and the dependency closure");
    const artefact = assemble(join(scratch, "runtime"));
    out(
      `  ${artefact.files} files, ${(artefact.bytes / 1024 / 1024).toFixed(1)} MB: ` +
        `${artefact.packages.size} workspace packages, ${artefact.externals} external copies`,
    );
    for (const [name, entry] of artefact.packages) {
      out(`      ${name}: files = ${JSON.stringify(entry.patterns)}`);
    }
    if (artefact.nested.length > 0) {
      out(`      nested rather than hoisted: ${artefact.nested.join(", ")}`);
    }
    expect("every declared dependency resolved", artefact.unresolved.join(", "), "");

    const cliDist = join(artefact.lib, ROOT_PACKAGE, "dist");
    const renderCoreDist = join(artefact.lib, "@xplainer/render-core", "dist");
    const entryPoint = join(cliDist, "bin.js");

    out("");
    out("2. EXERCISE — the payload's own module graph, template files and narration worker");
    const scrubDir = join(scratch, "no-node-here");
    mkdirSync(scrubDir, { recursive: true });
    const log = join(scratch, "resolved.jsonl");
    const recorder = writeModule(join(scratch, "recorder.cjs"), recorderModule, "();");
    const probe = writeModule(join(scratch, "probe.cjs"), probeModule, "();");

    const binaries = new Set();
    for (const [, entry] of artefact.packages) {
      const bin = readJson(join(entry.source, "package.json")).bin;
      for (const target of typeof bin === "string" ? [bin] : Object.values(bin ?? {})) {
        binaries.add(join(entry.target, target));
      }
    }
    const sweep = [];
    for (const [, entry] of artefact.packages) {
      for (const path of listFiles(entry.target)) {
        const file = join(entry.target, path);
        if (path.endsWith(".js") && !binaries.has(file)) {
          sweep.push(file);
        }
      }
    }

    const workspaceRoot = join(scratch, "workspace");
    writeFileSync(
      join(scratch, "probe.json"),
      JSON.stringify({
        cliDist,
        renderCoreDist,
        workspace: workspaceRoot,
        recorder,
        scrubDir,
        slug: SLUG,
        jobId: JOB_ID,
        narration: NARRATION,
        sweep,
      }),
    );

    const probed = run(artefact.interpreter, ["--import", pathToFileURL(recorder).href, probe], {
      cwd: scratch,
      env: { P2_S6_LOG: log, P2_S6_CONFIG: join(scratch, "probe.json"), PATH: scrubDir },
    });
    const line = probed.stdout.split("\n").find((text) => text.startsWith("P2S6-RESULT "));
    if (probed.status !== 0 || line === undefined) {
      out(`  the probe exited ${probed.status} without a result:`);
      out(quote(probed.stderr === "" ? probed.stdout : probed.stderr));
    }
    expect("the probe ran the whole exercise", probed.status, 0);
    const result = line === undefined ? null : JSON.parse(line.slice("P2S6-RESULT ".length));
    if (result === null) {
      out(
        "  the exercise stopped before it finished, so the expectations that read its result are",
      );
      out("  not evaluated below. Node's own resolver refusing a module IS the reachability");
      out('  failure: every module and every `with { type: "json" }` import in the payload has to');
      out("  resolve inside the artefact for the probe to reach its last line at all.");
    } else {
      out(`  ${result.importedCount} shipped modules imported, plus the spawned narration worker`);
      out(`      workspace files written: ${result.workspaceCreated.join(", ")}`);
      out(`      scaffold files written:  ${result.scaffoldCreated.join(", ")}`);
      out(
        `      worker: ${relative(artefact.root, result.workerCommand)} ${result.workerArgs
          .map((argument) =>
            under(argument, artefact.root) ? relative(artefact.root, argument) : argument,
          )
          .join(" ")}`,
      );
      if (result.workerStdout !== "") {
        out(quote(result.workerStdout));
      }
      if (result.workerStatus !== 0) {
        out(quote(result.workerStderr));
      }
      expect("the narration worker ran to completion", result.workerStatus, 0);
      expect("the payload spawns its own interpreter", result.workerCommand, artefact.interpreter);
      expect(
        "the worker wrote the three narration outputs",
        [result.audio, result.timings, result.captions].every((file) => existsSync(file)),
        true,
      );
      expect(
        "no `.ts` is among the arguments the payload spawns",
        result.workerArgs.filter((argument) => argument.endsWith(".ts")).length,
        0,
      );
    }

    out("");
    out("3. ASSERT — every path the payload resolved, against the artefact");
    const records = readLog(log);
    const inside = new Map();
    const outside = [];
    const missingReads = [];
    const missingProbes = [];
    const outsideAllowlist = [];
    const compiledTypescript = [];
    const templateTypescript = new Set();
    for (const record of records) {
      if (under(record.path, REPO_ROOT)) {
        outside.push(record);
        continue;
      }
      if (!under(record.path, artefact.root)) {
        continue;
      }
      const owner = ownerOf(record.path, artefact);
      const key = owner === null ? "external packages" : owner.name;
      inside.set(key, (inside.get(key) ?? 0) + 1);
      if (record.path.endsWith(".ts")) {
        if (owner !== null && isCompiledOutput(owner.relativePath)) {
          compiledTypescript.push(record);
        } else {
          templateTypescript.add(record.path);
        }
      }
      if (!existsSync(record.path)) {
        (record.kind === "read" ? missingReads : missingProbes).push(record);
      }
      if (owner !== null && !allowlistMatcher(owner.entry.patterns)(owner.relativePath)) {
        outsideAllowlist.push(record);
      }
    }
    out(
      `  ${records.length} resolutions recorded across ${new Set(records.map((entry) => entry.pid)).size} processes`,
    );
    for (const [name, count] of [...inside].sort()) {
      out(`      ${count} inside ${name}`);
    }
    for (const path of templateTypescript) {
      out(
        `      shipped TypeScript, copied into a workspace rather than executed: ${relative(artefact.lib, path)}`,
      );
    }
    const problems = [
      ...missingReads,
      ...missingProbes,
      ...compiledTypescript,
      ...outsideAllowlist,
    ];
    for (const record of problems.slice(0, 10)) {
      out(`      ${record.api} ${record.kind} ${record.path}`);
    }
    for (const record of outside.slice(0, 10)) {
      out(
        `      reached back into the checkout: ${record.api} ${relative(REPO_ROOT, record.path)}`,
      );
    }
    expect("every file the payload read exists inside the artefact", missingReads.length, 0);
    expect("nothing the payload owns is looked for and missing", missingProbes.length, 0);
    expect("nothing resolved falls outside a `files` allowlist", outsideAllowlist.length, 0);
    expect(
      "no `.ts` source is resolved out of a package's build output",
      compiledTypescript.length,
      0,
    );
    expect("nothing is resolved from the checkout", outside.length, 0);

    out("");
    out("4. RELOCATE — `--version` with no `node` on `PATH`, and with no environment at all");
    const lookup = run("/bin/sh", ["-c", "command -v node"], { env: { PATH: scrubDir } });
    out(
      `      command -v node under PATH=${scrubDir}: exit ${lookup.status}, stdout ${JSON.stringify(lookup.stdout.trim())}`,
    );
    expect("`node` is not resolvable on that PATH", lookup.status === 0, false);
    const declared = readJson(join(REPO_ROOT, "apps", "cli", "package.json")).version;
    for (const [label, env] of [
      ["PATH resolves nothing", { PATH: scrubDir }],
      ["no environment at all (env -i)", {}],
    ]) {
      const answered = run(artefact.interpreter, [entryPoint, "--version"], { cwd: scratch, env });
      out(
        `      ${label}: exit ${answered.status}, stdout ${JSON.stringify(answered.stdout.trim())}`,
      );
      expect(`the artefact answers --version, ${label}`, answered.stdout.trim(), declared);
      expect(`--version exits 0, ${label}`, answered.status, 0);
    }
    if (result !== null) {
      expect("the version the payload reports is the declared one", result.cliVersion, declared);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  out("");
  out(failures === 0 ? "ALL PACKAGING EXPECTATIONS HELD" : `${failures} EXPECTATION(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

const [mode] = process.argv.slice(2);
if (mode === undefined || mode === "all") {
  await runAll();
} else {
  process.stderr.write("usage: node apps/cli/spikes/p2-s6-packaging.mjs [all]\n");
  process.exitCode = 2;
}
