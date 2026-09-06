#!/usr/bin/env node
/**
 * Publish contract gate.
 *
 * Runs `npm pack --dry-run --json` in every publishable workspace member and
 * checks the exact file list npm would put in the tarball, plus the bytes of
 * the JavaScript inside it. A tarball is the only thing a user ever receives,
 * so it is the only thing worth checking.
 *
 * WHY PACK OUTPUT AND NOT THE WORKING TREE. `.gitignore` and the npm `files`
 * allowlist are different filters, and only npm's opinion decides what ships.
 * `packages/protocol` demonstrates it: `.gitignore` has `__pycache__/`, so git
 * has never seen those directories, and `files: ["dist","schemas","python"]`
 * takes `python/` wholesale, so the `.pyc` files ride into the tarball anyway.
 * A check written against `git ls-files` sees nothing wrong. This one does not
 * ask the working tree what ships; it asks npm.
 *
 * Checks, one rule per thing that can go wrong:
 *
 *   Per file in the tarball    no source maps, no TypeScript source (a .d.ts is
 *                              not source), nothing under a `src/` directory,
 *                              no tests or fixtures, no Python bytecode.
 *   Per shipped .js            no `sourceMappingURL` comment left behind.
 *   Per package                LICENSE and NOTICE are IN the tarball, and the
 *                              `license` field carries the SPDX identifier.
 *   Per package                every file that MUST ship as readable source is
 *                              present and byte-identical to its source.
 *   Whole workspace            the publishable set is exactly the declared six.
 *
 * Exit codes:
 *   0  nothing leaks
 *   1  at least one leak, licence gap, or publishable-set drift
 *   2  the checker could not run (no workspace root, npm pack failed, a member
 *      has not been built, a manifest cannot be read)
 *
 * SCOPE, STATED HONESTLY. The packages are Apache-2.0 and the source is meant
 * to be readable, so this gate is NOT a secrecy measure and must not be
 * described as one. It exists because a tarball is a contract: it must carry
 * the licence and attribution the manifest claims, it must not carry test
 * scaffolding or build leftovers, and the publishable roster must not drift
 * silently. A stray source map still matters, not because it reveals source
 * but because it points at paths that do not exist on a user's disk.
 * The `.d.ts` files ship a complete, precise specification of every export,
 * because that is what a consumer's `tsc` needs. The three assets that are
 * genuinely hard to reproduce — the JSON Schemas, SKILL.md, and the Remotion
 * scaffold templates — ship as readable text BY PRODUCT NECESSITY, and are
 * asserted present below rather than hidden. What actually restricts a reader
 * is the licence itself, not this script.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Directories that hold workspace members, mirroring `pnpm-workspace.yaml`. */
const MEMBER_ROOTS = ["apps", "packages", "services"];

/**
 * The licence, and the value every published manifest must carry.
 *
 * `Apache-2.0` is an SPDX identifier, so the manifest names the licence directly
 * rather than pointing at a file. Two strings this replaces, neither a synonym:
 * `UNLICENSED`, which tells a user they have NO right to run the software, and
 * `SEE LICENSE IN LICENSE-BINARY`, the proprietary free-to-use licence that
 * preceded the switch to open source (ADR 0021, superseded by ADR 0022).
 *
 * Both files are checked because Apache-2.0 requires it: section 4(d) obliges
 * anyone redistributing the work to carry the NOTICE file with it, so a tarball
 * shipping LICENSE alone is not compliant with the licence it claims.
 */
const LICENCE_FILE = "LICENSE";
const NOTICE_FILE = "NOTICE";
const EXPECTED_LICENSE = "Apache-2.0";

/**
 * The publishable set, declared rather than discovered.
 *
 * Discovery alone cannot catch drift: a member that silently lost `private:
 * true` would just be discovered as publishable and checked, and a member that
 * silently gained it would just disappear from the run. Both lists are written
 * out instead, and the checker fails if the workspace on disk disagrees with
 * either — in either direction. Adding or removing a member is a deliberate
 * edit here.
 */
const PUBLISHABLE_MEMBERS = [
  { dir: "apps/cli", name: "@xplainer/cli" },
  { dir: "packages/mcp-server", name: "@xplainer/mcp-server" },
  { dir: "packages/protocol", name: "@xplainer/protocol" },
  { dir: "packages/render-core", name: "@xplainer/render-core" },
  { dir: "packages/skill", name: "@xplainer/skill" },
  { dir: "packages/tts-client", name: "@xplainer/tts-client" },
];

/**
 * Members that must stay unpublished. `private: true` is the only thing stopping them.
 *
 * `apps/api`, `apps/web` and `services/media-service` used to be listed here.
 * They were the whole `hosted` tier and have been relocated to the private
 * BrewMyTech/xplainer-hosted repository, so they are no longer workspace
 * members on disk and `checkRoster` below would report them as roster drift.
 */
const PRIVATE_MEMBERS = [
  { dir: "apps/desktop", name: "@xplainer/desktop" },
  { dir: "packages/config", name: "@xplainer/config" },
  { dir: "services/tts-sidecar", name: "@xplainer/tts-sidecar" },
];

/** File extensions that are compiled output a consumer executes. */
const JS_EXTENSIONS = [".js", ".mjs", ".cjs"];

/** Declaration files. These are NOT source, and are meant to ship. */
const DECLARATION_EXTENSIONS = [".d.ts", ".d.mts", ".d.cts"];

/** TypeScript source extensions. A `.d.ts` ends with one of these too, hence the second test. */
const TYPESCRIPT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

/** Directory names that mean "this is test scaffolding, not product". */
const TEST_DIRECTORIES = new Set([
  "test",
  "tests",
  "__tests__",
  "fixtures",
  "__fixtures__",
  "__snapshots__",
  "__mocks__",
]);

const endsWithOneOf = (path, suffixes) => suffixes.some((suffix) => path.endsWith(suffix));

const segmentsOf = (path) => path.split("/");

const basenameOf = (path) => segmentsOf(path).at(-1) ?? path;

/**
 * The rules, one per failure mode, each with an `id` an exemption can name.
 *
 * Every rule is written against the tarball-relative path npm reports. None of
 * them is a catch-all: a rule that fired on "anything that looks like source"
 * would fire on the files in MUST_SHIP_FILES below, which have to ship.
 */
const FILE_RULES = [
  {
    id: "no-source-map",
    label: "source map in the tarball",
    detail:
      "A .js.map names every original source file and ships the identifier table and the " +
      "position mappings, and it undoes minification completely — a map that points at " +
      "build-machine paths is noise in a user's stack trace. Keep producing maps, archive them as a CI artefact " +
      "keyed by version so daemon stack traces stay symbolicatable, and keep them out of " +
      "the tarball.",
    matches: (path) => path.endsWith(".map"),
  },
  {
    id: "no-typescript-source",
    label: "TypeScript source in the tarball",
    detail:
      "Raw .ts/.tsx is the source, not the product. A .d.ts is exempt by definition: it is " +
      "the API specification a consumer's tsc requires.",
    matches: (path) =>
      endsWithOneOf(path, TYPESCRIPT_EXTENSIONS) && !endsWithOneOf(path, DECLARATION_EXTENSIONS),
  },
  {
    id: "no-src-directory",
    label: "src/ path in the tarball",
    detail: "Nothing under a src/ directory belongs in a tarball; dist/ is what ships.",
    matches: (path) => segmentsOf(path).includes("src"),
  },
  {
    id: "no-tests-or-fixtures",
    label: "test or fixture in the tarball",
    detail:
      "Tests and golden fixtures describe internal behaviour and expected outputs, and no " +
      "consumer runs them.",
    matches: (path) => {
      if (
        segmentsOf(path)
          .slice(0, -1)
          .some((segment) => TEST_DIRECTORIES.has(segment))
      ) {
        return true;
      }
      const base = basenameOf(path);
      return base.includes(".test.") || base.includes(".spec.") || base.endsWith(".golden");
    },
  },
  {
    id: "no-python-bytecode",
    label: "Python bytecode in the tarball",
    detail:
      "__pycache__ holds build-machine artefacts pinned to one CPython version. They can go " +
      "stale against the .py file beside them, and git never sees them because .gitignore " +
      "excludes them and the npm allowlist does not.",
    matches: (path) =>
      segmentsOf(path).includes("__pycache__") || path.endsWith(".pyc") || path.endsWith(".pyo"),
  },
];

const RULE_IDS = new Set(FILE_RULES.map((rule) => rule.id));

/**
 * Rules that need the file's bytes rather than its name.
 *
 * Read from the package directory at the path npm reported, which is the same
 * file npm would have put in the tarball.
 */
const CONTENT_RULES = [
  {
    id: "no-source-mapping-url",
    label: "sourceMappingURL comment in shipped JavaScript",
    detail:
      "A shipped .js pointing at a map that is not in the tarball produces a 404 in every " +
      "consumer's debugger, and a shipped .js pointing at a map that IS in the tarball " +
      "defeats the point of excluding source. Strip the comment when the map is excluded.",
    appliesTo: (path) => endsWithOneOf(path, JS_EXTENSIONS),
    // Assembled from parts so this file's own text is not a match when grepped.
    matches: (text) =>
      text.includes(`//# ${"sourceMappingURL"}=`) || text.includes(`//@ ${"sourceMappingURL"}=`),
  },
];

/**
 * ============================================================================
 * EXEMPTIONS — files permitted to break a rule above.
 * ============================================================================
 *
 * Every entry names ONE package, ONE exact path, the exact rule ids it is
 * excused from, and why. There are no globs and no patterns here on purpose: a
 * pattern quietly widens as the tree grows, and the next file to slip through
 * would slip through in silence.
 *
 * An entry that no longer excuses anything is a hard failure, not a shrug. A
 * stale exemption is a hole nobody is watching.
 */
const EXEMPTIONS = [
  {
    package: "@xplainer/render-core",
    path: "template/remotion.config.ts",
    rules: ["no-typescript-source"],
    why:
      "template/ is not our source. It is the Remotion workspace copied onto the user's " +
      "machine, which their videos render inside, so it has to arrive as readable, editable " +
      "TypeScript. Compiling or obfuscating it breaks rendering.",
  },
];

/**
 * ============================================================================
 * MUST SHIP AS READABLE SOURCE — asserted present, and asserted untransformed.
 * ============================================================================
 *
 * The rules above stop the wrong things shipping. These positive assertions
 * stop the RIGHT things being removed or mangled by a future minification or
 * obfuscation step. Every file here is read at runtime, or by an agent, as
 * text; transforming it does not make the product harder to copy, it makes the
 * product stop working.
 *
 * `identicalTo` is the anti-obfuscation assertion: the shipped copy must be
 * byte-for-byte the file it was copied from. A minifier, obfuscator or
 * formatter that reached these would change the bytes, and this fails.
 */
const MUST_SHIP_FILES = [
  // --- The Remotion render workspace, copied to the user's machine ---------
  {
    package: "@xplainer/render-core",
    path: "template/remotion.config.ts",
    why: "Remotion config for the user's own render workspace; read and edited as TypeScript.",
  },
  {
    package: "@xplainer/render-core",
    path: "template/tsconfig.json",
    why: "Compiler settings for the user's render workspace; without it their scenes fail to typecheck.",
  },
  {
    package: "@xplainer/render-core",
    path: "template/package.json",
    why: "Declares the pinned remotion and @remotion/* versions the user's workspace installs.",
  },
  {
    package: "@xplainer/render-core",
    path: "template/tailwind.css",
    why: "Style entrypoint the scaffolded scenes import.",
  },

  // --- Scaffold templates the agent reads, writes and then edits -----------
  //
  // Stored with a .txt extension precisely so neither Biome nor tsc touches
  // their bytes, then read verbatim at runtime by dist/scaffold/index.js via
  // readFileSync relative to import.meta.url. Scenes.tsx is the file the agent
  // subsequently edits. Minified templates produce scene code the agent cannot
  // read or modify, which is the whole product.
  {
    package: "@xplainer/render-core",
    path: "dist/scaffold/templates/Video.tsx.txt",
    identicalTo: "src/scaffold/templates/Video.tsx.txt",
    why: "Scaffold template read verbatim at runtime and edited by the agent.",
  },
  {
    package: "@xplainer/render-core",
    path: "dist/scaffold/templates/Root.tsx.txt",
    identicalTo: "src/scaffold/templates/Root.tsx.txt",
    why: "Scaffold template read verbatim at runtime and edited by the agent.",
  },
  {
    package: "@xplainer/render-core",
    path: "dist/scaffold/templates/Captions.tsx.txt",
    identicalTo: "src/scaffold/templates/Captions.tsx.txt",
    why: "Scaffold template read verbatim at runtime and edited by the agent.",
  },
  {
    package: "@xplainer/render-core",
    path: "dist/scaffold/templates/Scenes.tsx.txt",
    identicalTo: "src/scaffold/templates/Scenes.tsx.txt",
    why: "Scaffold template read verbatim at runtime; this is the file the agent edits.",
  },
  {
    package: "@xplainer/render-core",
    path: "dist/scaffold/templates/types.ts.txt",
    identicalTo: "src/scaffold/templates/types.ts.txt",
    why: "Scaffold template read verbatim at runtime and edited by the agent.",
  },
  {
    package: "@xplainer/render-core",
    path: "dist/scaffold/templates/index.ts.txt",
    identicalTo: "src/scaffold/templates/index.ts.txt",
    why: "Scaffold template read verbatim at runtime and edited by the agent.",
  },

  // --- Prose an agent reads as instructions --------------------------------
  //
  // Obfuscating prose is not a coherent operation. Both plugin copies must stay
  // byte-identical to the one authored SKILL.md, or the two agent surfaces
  // silently disagree about how to drive the tools.
  {
    package: "@xplainer/skill",
    path: "SKILL.md",
    why: "The authored skill prose. An agent reads it as instructions.",
  },
  {
    package: "@xplainer/skill",
    path: "dist/claude-plugin/skills/xplainer/SKILL.md",
    identicalTo: "SKILL.md",
    why: "Claude plugin copy of the skill prose; must match the authored file exactly.",
  },
  {
    package: "@xplainer/skill",
    path: "dist/codex-plugin/skills/xplainer/SKILL.md",
    identicalTo: "SKILL.md",
    why: "Codex plugin copy of the skill prose; must match the authored file exactly.",
  },
];

/**
 * Directories whose every on-disk file must reach the tarball.
 *
 * Named as a tree rather than as a list of files because it grows: a new tool
 * schema has to ship the day it is added, and a per-file list would silently
 * not cover it. This is a "nothing was dropped" assertion, not a permission.
 *
 * packages/skill/schemas/ is deliberately NOT here. Those two vendored plugin
 * manifest schemas are read only by packages/skill/src/build.test.ts; nothing
 * shipped references them, so they are test-time assets and correctly absent
 * from the tarball.
 */
const MUST_SHIP_TREES = [
  {
    package: "@xplainer/protocol",
    dir: "schemas",
    why:
      "The published tool contract. Consumers validate against these, so they are a complete " +
      "description of the tools by design and cannot be withheld.",
  },
];

/** Directories never walked when checking a must-ship tree. */
const TREE_SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".turbo", "__pycache__"]);

// ---------------------------------------------------------------------------

/** Collects findings grouped by rule, so one explanation is printed once, not once per file. */
function createFindings() {
  const groups = new Map();
  return {
    add(id, label, detail, path) {
      const existing = groups.get(id);
      if (existing === undefined) {
        groups.set(id, { label, detail, paths: [path] });
        return;
      }
      existing.paths.push(path);
    },
    note(label, detail) {
      groups.set(`note:${groups.size}`, { label, detail, paths: [] });
    },
    list() {
      return [...groups.values()];
    },
  };
}

/** Locate the workspace root by walking up for `pnpm-workspace.yaml`. */
function findWorkspaceRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const start of [process.cwd(), resolve(here, "..")]) {
    let dir = resolve(start);
    for (;;) {
      if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
        return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  return null;
}

function tryParseArray(text) {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Pull the JSON document out of `npm pack --dry-run --json` stdout.
 *
 * `npm pack --dry-run` DOES run the `prepack` and `postpack` lifecycle scripts
 * (verified on npm 11.19.0), which is exactly what is wanted here — a prepack
 * that copies LICENSE-BINARY into the package must be reflected in the file
 * list, so `--ignore-scripts` is deliberately NOT passed. The cost is that
 * those scripts print to the same stdout ahead of the JSON, so the document is
 * the last balanced array in the stream rather than the whole of it.
 */
function parseNpmPackJson(stdout) {
  const text = stdout.trim();
  const direct = tryParseArray(text);
  if (direct !== null) {
    return direct;
  }
  let index = text.lastIndexOf("[");
  while (index >= 0) {
    const value = tryParseArray(text.slice(index));
    if (value !== null) {
      return value;
    }
    if (index === 0) {
      break;
    }
    index = text.lastIndexOf("[", index - 1);
  }
  return null;
}

function readManifest(root, dir) {
  return JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
}

function toDiskPath(root, dir, tarballPath) {
  return join(root, dir, ...tarballPath.split("/"));
}

/** Every file under `absoluteDir`, as tarball-style relative paths. */
function listTree(absoluteDir) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!TREE_SKIP_DIRECTORIES.has(entry.name)) {
          walk(full);
        }
        continue;
      }
      if (entry.isFile()) {
        found.push(relative(absoluteDir, full).split(sep).join("/"));
      }
    }
  };
  walk(absoluteDir);
  return found.sort((a, b) => a.localeCompare(b));
}

/** Run `npm pack --dry-run --json` in one member and return the file paths it reports. */
async function packMember(root, member) {
  const cwd = join(root, member.dir);
  // On Windows `npm` is a .cmd shim, which child_process refuses to spawn
  // without a shell. Every argument here is a fixed literal, so the shell adds
  // no injection surface.
  const isWindows = process.platform === "win32";
  const { stdout } = await execFileAsync(
    isWindows ? "npm.cmd" : "npm",
    ["pack", "--dry-run", "--json"],
    { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: isWindows },
  );

  const parsed = parseNpmPackJson(stdout);
  if (parsed === null || parsed.length === 0 || !Array.isArray(parsed[0]?.files)) {
    throw new Error(`npm pack produced no readable JSON in ${member.dir}`);
  }
  return parsed[0].files.map((file) => file.path);
}

/** Check one publishable member. Returns grouped findings. */
function inspectMember(root, member, tarballPaths) {
  const findings = createFindings();
  const shipped = new Set(tarballPaths);

  const exemptions = EXEMPTIONS.filter((entry) => entry.package === member.name);
  const usedExemptions = new Set();

  // --- Rules on the file list ---------------------------------------------
  for (const path of tarballPaths) {
    for (const rule of FILE_RULES) {
      if (!rule.matches(path)) {
        continue;
      }
      const exemption = exemptions.find(
        (entry) => entry.path === path && entry.rules.includes(rule.id),
      );
      if (exemption) {
        usedExemptions.add(`${exemption.path}::${rule.id}`);
        continue;
      }
      findings.add(rule.id, rule.label, rule.detail, path);
    }
  }

  // --- Rules on file contents ---------------------------------------------
  for (const path of tarballPaths) {
    for (const rule of CONTENT_RULES) {
      if (!rule.appliesTo(path)) {
        continue;
      }
      const diskPath = toDiskPath(root, member.dir, path);
      if (!existsSync(diskPath)) {
        findings.add(
          "unreadable",
          "listed in the tarball but not on disk",
          "The contents could not be checked. If a prepack script generates this file, this " +
            "checker has to read a packed tarball rather than the package directory.",
          path,
        );
        continue;
      }
      if (rule.matches(readFileSync(diskPath, "utf8"))) {
        findings.add(rule.id, rule.label, rule.detail, path);
      }
    }
  }

  // --- The licence must be inside the tarball ------------------------------
  //
  // npm auto-includes README* and LICENSE*/LICENCE* from a package root, but
  // NOT a hyphenated name: verified on npm 11.19.0, a package-root
  // LICENSE-BINARY alongside files: ["dist"] does not ship, and the same file
  // named in `files` does. So this passes only once each manifest names it, or
  // a prepack copies it in.
  if (!shipped.has(LICENCE_FILE)) {
    findings.note(
      `${LICENCE_FILE} is not in the tarball`,
      "A user who installs this package receives no grant of any kind. npm does not " +
        `auto-include a hyphenated licence filename, so ${LICENCE_FILE} must be named in the ` +
        'manifest "files" array or copied into the package by a prepack script.',
    );
  } else {
    const shippedLicencePath = toDiskPath(root, member.dir, LICENCE_FILE);
    if (existsSync(shippedLicencePath)) {
      const rootLicence = readFileSync(join(root, LICENCE_FILE));
      if (!readFileSync(shippedLicencePath).equals(rootLicence)) {
        findings.note(
          `${LICENCE_FILE} differs from the repository root copy`,
          "Two different grants would be shipping under one name. Copy the root file rather " +
            "than maintaining a second one.",
        );
      }
    }
  }

  // NOTICE is not decoration. Apache-2.0 section 4(d) obliges anyone who
  // redistributes the work to carry the NOTICE with it, so a tarball shipping
  // LICENSE alone does not comply with the licence its own manifest claims.
  // Checked separately from LICENSE because they fail independently: naming one
  // in `files` and forgetting the other is the obvious mistake, and it is silent.
  if (!shipped.has(NOTICE_FILE)) {
    findings.note(
      `${NOTICE_FILE} is not in the tarball`,
      `${EXPECTED_LICENSE} section 4(d) requires the NOTICE file to travel with the work. ` +
        `Shipping ${LICENCE_FILE} without it means the package does not satisfy the licence ` +
        `it declares. Name ${NOTICE_FILE} in the manifest "files" array.`,
    );
  } else {
    const shippedNoticePath = toDiskPath(root, member.dir, NOTICE_FILE);
    if (existsSync(shippedNoticePath)) {
      const rootNotice = readFileSync(join(root, NOTICE_FILE));
      if (!readFileSync(shippedNoticePath).equals(rootNotice)) {
        findings.note(
          `${NOTICE_FILE} differs from the repository root copy`,
          "Attribution would vary by package. Copy the root file rather than maintaining a " +
            "second one.",
        );
      }
    }
  }

  // --- The manifest must point at that licence -----------------------------
  const manifest = readManifest(root, member.dir);
  if (manifest.license !== EXPECTED_LICENSE) {
    findings.note(
      `package.json "license" is ${JSON.stringify(manifest.license)}`,
      `Expected ${JSON.stringify(EXPECTED_LICENSE)}. "UNLICENSED" tells npm and every ` +
        "consumer that no right to use the software is granted at all, which is the opposite " +
        `of the grant in ${LICENCE_FILE}.`,
    );
  }

  // --- Files that must ship, and must ship untransformed -------------------
  for (const entry of MUST_SHIP_FILES.filter((item) => item.package === member.name)) {
    if (!shipped.has(entry.path)) {
      findings.note(`${entry.path} MUST ship and is missing from the tarball`, entry.why);
      continue;
    }
    if (entry.identicalTo === undefined) {
      continue;
    }
    const shippedPath = toDiskPath(root, member.dir, entry.path);
    const sourcePath = toDiskPath(root, member.dir, entry.identicalTo);
    if (!existsSync(shippedPath) || !existsSync(sourcePath)) {
      findings.note(
        `${entry.path} cannot be compared against ${entry.identicalTo}`,
        "One of the two is not on disk.",
      );
      continue;
    }
    if (!readFileSync(shippedPath).equals(readFileSync(sourcePath))) {
      findings.note(
        `${entry.path} differs from ${entry.identicalTo}`,
        `${entry.why} It must ship byte-for-byte; a build step that rewrote it (minifier, ` +
          "obfuscator, formatter) breaks the product.",
      );
    }
  }

  // --- Whole directories that must reach the tarball intact ----------------
  for (const tree of MUST_SHIP_TREES.filter((item) => item.package === member.name)) {
    const absoluteDir = join(root, member.dir, tree.dir);
    if (!existsSync(absoluteDir)) {
      findings.note(`${tree.dir}/ MUST ship and does not exist on disk`, tree.why);
      continue;
    }
    for (const relativePath of listTree(absoluteDir)) {
      const tarballPath = `${tree.dir}/${relativePath}`;
      if (!shipped.has(tarballPath)) {
        findings.add(
          `must-ship-tree:${tree.dir}`,
          `files under ${tree.dir}/ that MUST ship and are missing from the tarball`,
          tree.why,
          tarballPath,
        );
      }
    }
  }

  // --- The exemption list must still describe reality ----------------------
  for (const exemption of exemptions) {
    for (const ruleId of exemption.rules) {
      if (!RULE_IDS.has(ruleId)) {
        findings.note(
          `exemption for ${exemption.path} names unknown rule "${ruleId}"`,
          `Rule ids are: ${[...RULE_IDS].join(", ")}.`,
        );
        continue;
      }
      if (!usedExemptions.has(`${exemption.path}::${ruleId}`)) {
        findings.note(
          `exemption for ${exemption.path} from "${ruleId}" no longer excuses anything`,
          "The file either stopped shipping or stopped breaking that rule. Delete the entry so " +
            "the allowlist keeps describing what actually ships.",
        );
      }
    }
  }

  return findings.list();
}

/**
 * Verify the workspace on disk matches the declared roster, in both directions.
 * A non-empty result means the publishable set has drifted.
 */
function checkRoster(root) {
  const problems = [];
  const declared = new Map();
  for (const member of PUBLISHABLE_MEMBERS) {
    declared.set(member.dir, { ...member, shouldPublish: true });
  }
  for (const member of PRIVATE_MEMBERS) {
    declared.set(member.dir, { ...member, shouldPublish: false });
  }

  const discovered = new Set();
  for (const memberRoot of MEMBER_ROOTS) {
    const dir = join(root, memberRoot);
    if (!existsSync(dir)) {
      continue;
    }
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) {
        continue;
      }
      const relativeDir = `${memberRoot}/${entry}`;
      if (!statSync(join(root, relativeDir)).isDirectory()) {
        continue;
      }
      if (existsSync(join(root, relativeDir, "package.json"))) {
        discovered.add(relativeDir);
      }
    }
  }

  for (const relativeDir of [...discovered].sort()) {
    if (!declared.has(relativeDir)) {
      problems.push(
        `${relativeDir} is a workspace member this checker does not know about. Add it to ` +
          "PUBLISHABLE_MEMBERS or PRIVATE_MEMBERS in scripts/check-publish-contract.mjs so its " +
          "publish status is a decision and not an accident.",
      );
    }
  }

  for (const [relativeDir, member] of [...declared].sort()) {
    if (!discovered.has(relativeDir)) {
      problems.push(
        `${relativeDir} (${member.name}) is declared here but is not a workspace member on ` +
          "disk. Remove it from the roster if it was deleted or renamed.",
      );
      continue;
    }
    const manifest = readManifest(root, relativeDir);
    if (manifest.name !== member.name) {
      problems.push(
        `${relativeDir} declares name ${JSON.stringify(manifest.name)}, roster says ` +
          `${JSON.stringify(member.name)}.`,
      );
    }
    const isPublishable = manifest.private !== true;
    if (isPublishable && !member.shouldPublish) {
      problems.push(
        `${relativeDir} (${member.name}) is declared PRIVATE here but has lost ` +
          '"private": true, so a publish run would push it to the registry.',
      );
    }
    if (!isPublishable && member.shouldPublish) {
      problems.push(
        `${relativeDir} (${member.name}) is declared PUBLISHABLE here but now sets ` +
          '"private": true, so it would silently stop being published.',
      );
    }
  }

  return problems;
}

/** A member that was never built has an empty tarball and would pass vacuously. */
function checkBuilt(root) {
  const missing = [];
  for (const member of PUBLISHABLE_MEMBERS) {
    const manifest = readManifest(root, member.dir);
    const declaresDist = (manifest.files ?? []).some(
      (entry) => entry === "dist" || entry.startsWith("dist/"),
    );
    if (declaresDist && !existsSync(join(root, member.dir, "dist"))) {
      missing.push(member.dir);
    }
  }
  return missing;
}

function renderFinding(finding) {
  const lines = [];
  const count = finding.paths.length;
  lines.push(`  x ${finding.label}${count > 0 ? ` (${count} file${count === 1 ? "" : "s"})` : ""}`);
  lines.push(`      ${finding.detail}`);
  for (const path of finding.paths) {
    lines.push(`      - ${path}`);
  }
  return lines;
}

async function main() {
  const root = findWorkspaceRoot();
  if (root === null) {
    process.stderr.write(
      "check-publish-contract: no pnpm-workspace.yaml found above the working directory.\n",
    );
    return 2;
  }
  if (!existsSync(join(root, NOTICE_FILE))) {
    console.error(
      `check-publish-contract: ${NOTICE_FILE} is missing from the repository root, so no ` +
        `package can ship the attribution ${EXPECTED_LICENSE} section 4(d) requires.`,
    );
    process.exit(2);
  }

  if (!existsSync(join(root, LICENCE_FILE))) {
    process.stderr.write(
      `check-publish-contract: ${LICENCE_FILE} is missing from the repository root, so there is ` +
        "no licence for the packages to ship.\n",
    );
    return 2;
  }

  const rosterProblems = checkRoster(root);

  const unbuilt = checkBuilt(root);
  if (unbuilt.length > 0) {
    process.stderr.write(
      "check-publish-contract: these members ship dist/ but have not been built, so npm pack " +
        `would report an incomplete file list: ${unbuilt.join(", ")}. Run \`pnpm build\` ` +
        "first.\n",
    );
    return 2;
  }

  let packed;
  try {
    packed = await Promise.all(
      PUBLISHABLE_MEMBERS.map(async (member) => ({
        member,
        paths: await packMember(root, member),
      })),
    );
  } catch (error) {
    process.stderr.write(
      `check-publish-contract: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  let failures = 0;
  const lines = [];

  if (rosterProblems.length > 0) {
    failures += rosterProblems.length;
    lines.push("publishable set has drifted:");
    for (const problem of rosterProblems) {
      lines.push(`  x ${problem}`);
    }
  }

  for (const { member, paths } of packed) {
    const findings = inspectMember(root, member, paths);
    if (findings.length === 0) {
      lines.push(`${member.name}: ${paths.length} file(s) in the tarball, clean`);
      continue;
    }
    failures += findings.length;
    lines.push(
      `${member.name}: ${paths.length} file(s) in the tarball, ${findings.length} problem(s)`,
    );
    for (const finding of findings) {
      lines.push(...renderFinding(finding));
    }
  }

  const stream = failures > 0 ? process.stderr : process.stdout;
  stream.write(`${lines.join("\n")}\n`);

  if (failures > 0) {
    stream.write(
      `\ncheck-publish-contract: ${failures} problem(s) across ${PUBLISHABLE_MEMBERS.length} ` +
        "publishable package(s). Every line above is either something a user would receive and " +
        "should not, or something they must receive and would not.\n",
    );
    return 1;
  }

  process.stdout.write(
    `check-publish-contract: ${PUBLISHABLE_MEMBERS.length} publishable package(s) checked; no ` +
      "source, source maps, tests or licence gaps in any tarball.\n",
  );
  return 0;
}

process.exitCode = await main().catch((error) => {
  process.stderr.write(
    `check-publish-contract: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  return 2;
});
