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
 *   Per shipped file           no `sourceMappingURL` comment left behind in a
 *                              `.js`, and nowhere the name of the private
 *                              repository the hosted tier moved to.
 *   Per package                LICENSE, NOTICE and README.md are IN the
 *                              tarball, and the manifest carries the SPDX
 *                              licence, the homepage, the repository (with the
 *                              member's `directory`) and the author.
 *   Per package                every file that MUST ship as readable source is
 *                              present and byte-identical to its source.
 *   Whole workspace            the publishable set is exactly the declared seven.
 *
 * EVERY RULE CARRIES ITS OWN NEGATIVE TEST, and they run first, on every
 * invocation — see SELF_TESTS. A gate whose rules cannot be shown to fire is
 * indistinguishable from a gate that passes vacuously, and this one guards a
 * publish that cannot be taken back. The tests live in this file rather than in
 * a member's `vitest` suite for one reason: `pnpm verify` runs `turbo test`
 * over the members and then runs THIS script, so a test that lives here cannot
 * be skipped, cannot be forgotten when the rule list grows (an uncovered rule
 * is a hard failure), and cannot drift out of sync with the rules it tests.
 *
 * Exit codes:
 *   0  nothing leaks
 *   1  at least one leak, licence or metadata gap, publishable-set drift, or a
 *      rule that failed its own negative test
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

import { Buffer } from "node:buffer";
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
 * The page npm renders, and the three manifest fields that make it useful.
 *
 * Without a `README.md` the npm page for a package renders blank, which for
 * `@xplainer/cli` is the page a human reads before deciding to install a daemon
 * on their machine. `homepage`, `repository` and `author` are what turn that
 * page from an anonymous tarball into something with a provenance a reader can
 * follow; `repository.directory` is what makes "view source" land in the right
 * member of a monorepo rather than at its root.
 *
 * npm auto-includes a package-root `README.md` regardless of the `files`
 * allowlist, so the check below is not about the allowlist — it is about the
 * file existing at all. Not one of the packages that existed then had one until
 * the first publish was being prepared.
 */
const README_FILE = "README.md";
const EXPECTED_HOMEPAGE = "https://xplainer.video";
const EXPECTED_REPOSITORY = "https://github.com/BrewMyTech/xplainer.video";
const EXPECTED_AUTHOR = "Rishav Anand <rishav@brewmytech.com>";

/**
 * The name of the private repository the hosted tier moved to (ADR 0023).
 *
 * It must not appear in anything a stranger downloads. This is phase-0 gate 1
 * re-asserted where it can be checked mechanically — against what npm actually
 * ships rather than against the working tree — because the working-tree form of
 * the check has a blind spot the tarball form does not: generated output.
 * Twelve JSON Schema `description` strings carried the name, and the generated
 * TypeScript and pydantic derived from them carried it into `dist/`, so a grep
 * over hand-written source would have reported the repository clean.
 */
const PRIVATE_REPOSITORY_NAME = "xplainer-hosted";

/**
 * A path into the private reference implementation (ADR 0002, ADR 0006, ADR 0007).
 *
 * `~/projects/max` is where this product's behaviour was first written down, and
 * early schema descriptions and docblocks cited it by path and line — provenance
 * that is precise, useful in review, and meaningless to a stranger, because the
 * repository it names is not one they can open.
 *
 * It is a SECOND rule rather than another spelling of the one above, and the
 * reason is the miss it exists to close. That rule matches a repository NAME;
 * this one matches a PATH, and nothing matched a path until 2026-09-09. Twelve
 * schema `description` strings cited the reference implementation, ten were
 * scrubbed by hand in one pass, and the two naming `narrate.py` survived it —
 * reaching `schemas`, `python/**\/*.py` and `dist/**\/*.d.ts`, all three of
 * which `@xplainer/protocol` ships. A hand-scrubbed class comes back; a matched
 * one does not.
 *
 * Anchored on a token boundary so `minmax/`, `@scope/max/` and the like are not
 * matches, and written as a pattern rather than a literal because the leak is
 * the shape `max/<anything>`, not one file that happened to be cited twice.
 *
 * It fails CLOSED, and the cases where that is wrong are known rather than
 * discovered: `Math.max/2`, `the max/min ratio` and `throughput in max/sec` all
 * match and none is a leak. A minified bundle dividing by a `.max` property is
 * the one that could redden a correct publish. That is a spurious red, not a
 * missed leak, and `EXEMPTIONS` is where it is answered — deliberately, with the
 * path written down, rather than by loosening the pattern until it stops
 * catching the thing it exists for.
 */
const PRIVATE_REFERENCE_PATH = /(^|[^A-Za-z0-9_@/-])max\/[A-Za-z0-9_.-]/;

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
  { dir: "packages/alias", name: "xplainer" },
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
  {
    id: "no-private-repository-name",
    label: `the private repository's name ("${PRIVATE_REPOSITORY_NAME}") in the tarball`,
    detail:
      "The hosted tier was relocated to a private repository (ADR 0023) and its name has no " +
      "business in a public artefact: it names something a reader cannot open, and it is the " +
      "one string in the split that a stranger should never have received. Fix it at the " +
      "source the file was generated from — a schema description, a comment — never by " +
      "patching dist/.",
    appliesTo: () => true,
    matches: (text) => text.includes(PRIVATE_REPOSITORY_NAME),
  },
  {
    id: "no-private-reference-path",
    label: "a path into the private reference implementation in the tarball",
    detail:
      "A `max/...` path cites the private reference implementation this product was derived " +
      "from (ADR 0002). It names a file a reader cannot open, and the line numbers beside it " +
      "are provenance for us and noise for them. Keep the claim the sentence makes and drop " +
      'the coordinate: "mirrors the reference implementation" says everything a consumer ' +
      "can act on. Fix it at the source the file was generated from — a schema description, a " +
      "docblock — never by patching dist/.",
    appliesTo: () => true,
    matches: (text) => PRIVATE_REFERENCE_PATH.test(text),
  },
];

/**
 * ============================================================================
 * MANIFEST RULES — what `package.json` must say about the published package.
 * ============================================================================
 *
 * Separate from the file rules because they read the manifest rather than the
 * tarball's file list, and separate from each other because they fail
 * independently: adding `homepage` and forgetting `repository` is the obvious
 * mistake and it is silent — npm publishes a package with a blank sidebar
 * without a word of complaint.
 *
 * `check` returns the sentence to print, or `null` when the manifest is fine.
 * It takes the roster entry too, because `repository.directory` is the one
 * field whose correct value differs per member.
 */
const MANIFEST_RULES = [
  {
    id: "license-is-spdx",
    check: (manifest) =>
      manifest.license === EXPECTED_LICENSE
        ? null
        : `package.json "license" is ${JSON.stringify(manifest.license)}, expected ` +
          `${JSON.stringify(EXPECTED_LICENSE)}. "UNLICENSED" tells npm and every consumer ` +
          "that no right to use the software is granted at all, which is the opposite of the " +
          `grant in ${LICENCE_FILE}.`,
  },
  {
    id: "homepage-is-the-product-site",
    check: (manifest) =>
      manifest.homepage === EXPECTED_HOMEPAGE
        ? null
        : `package.json "homepage" is ${JSON.stringify(manifest.homepage)}, expected ` +
          `${JSON.stringify(EXPECTED_HOMEPAGE)}. It is the link npm puts in the page's ` +
          "sidebar, and a missing one leaves the package looking unattributed.",
  },
  {
    id: "repository-names-this-repo-and-member",
    check: (manifest, member) => {
      const declared = manifest.repository;
      if (declared === undefined || declared === null || typeof declared !== "object") {
        return (
          'package.json has no "repository" object. Without it npm shows no source link, and ' +
          "a reader of a published tarball has nowhere to go to read what they installed."
        );
      }
      if (normaliseRepositoryUrl(declared.url) !== EXPECTED_REPOSITORY) {
        return (
          `package.json "repository.url" is ${JSON.stringify(declared.url)}, expected ` +
          `${JSON.stringify(EXPECTED_REPOSITORY)} (a "git+" prefix and a ".git" suffix are ` +
          "the conventional spelling and are accepted)."
        );
      }
      if (declared.directory !== member.dir) {
        return (
          `package.json "repository.directory" is ${JSON.stringify(declared.directory)}, ` +
          `expected ${JSON.stringify(member.dir)}. This is a monorepo, so without the ` +
          "directory every package's source link lands on the repository root instead of on " +
          "the member a reader is looking at."
        );
      }
      return null;
    },
  },
  {
    id: "author-is-the-owner",
    check: (manifest) =>
      manifest.author === EXPECTED_AUTHOR
        ? null
        : `package.json "author" is ${JSON.stringify(manifest.author)}, expected the string ` +
          `${JSON.stringify(EXPECTED_AUTHOR)}. One spelling across every one of them, so the npm ` +
          "author page collects them rather than splitting them across near-identical names.",
  },
];

/**
 * ============================================================================
 * PRESENCE RULES — the three files that have to be in every tarball.
 * ============================================================================
 *
 * npm auto-includes `README*` and `LICENSE*`/`LICENCE*` from a package root but
 * NOT a hyphenated name: verified on npm 11.19.0, a package-root
 * `LICENSE-BINARY` alongside `files: ["dist"]` does not ship, and the same file
 * named in `files` does. So the licence rules pass only once each manifest names
 * the file or a prepack copies it in, while the README rule fails only when the
 * file does not exist at all.
 *
 * Three rules rather than one loop over three names, because they fail
 * independently and for different reasons — naming one in `files` and
 * forgetting the other is the obvious mistake, and it is silent.
 *
 * `sameAsRoot` marks the two that are copies of a repository-root file: one
 * copy of a legal document per published package must not drift into as many
 * different documents.
 */
const PRESENCE_RULES = [
  {
    id: "license-in-tarball",
    file: LICENCE_FILE,
    sameAsRoot: true,
    label: `${LICENCE_FILE} is not in the tarball`,
    detail:
      "A user who installs this package receives no grant of any kind. npm does not " +
      `auto-include a hyphenated licence filename, so ${LICENCE_FILE} must be named in the ` +
      'manifest "files" array or copied into the package by a prepack script.',
    driftLabel: `${LICENCE_FILE} differs from the repository root copy`,
    driftDetail:
      "Two different grants would be shipping under one name. Copy the root file rather than " +
      "maintaining a second one.",
  },
  {
    id: "notice-in-tarball",
    file: NOTICE_FILE,
    sameAsRoot: true,
    label: `${NOTICE_FILE} is not in the tarball`,
    detail:
      `${EXPECTED_LICENSE} section 4(d) requires the NOTICE file to travel with the work. ` +
      `Shipping ${LICENCE_FILE} without it means the package does not satisfy the licence it ` +
      `declares. Name ${NOTICE_FILE} in the manifest "files" array.`,
    driftLabel: `${NOTICE_FILE} differs from the repository root copy`,
    driftDetail:
      "Attribution would vary by package. Copy the root file rather than maintaining a second " +
      "one.",
  },
  {
    id: "readme-in-tarball",
    file: README_FILE,
    sameAsRoot: false,
    label: `${README_FILE} is not in the tarball`,
    detail:
      "The package's npm page renders blank, which is the page a human reads before deciding " +
      "to install this. npm auto-includes a package-root README.md regardless of the " +
      `"files" allowlist, so this means there is no ${README_FILE} in the package at all.`,
  },
];

/**
 * `git+https://…/x.git`, `https://…/x.git` and `https://…/x` are the same
 * repository, and npm normalises between them. Comparing the raw string would
 * make the rule fail on the conventional spelling, so it is normalised first.
 */
function normaliseRepositoryUrl(url) {
  if (typeof url !== "string") {
    return null;
  }
  return url
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
}

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
  {
    package: "@xplainer/render-core",
    path: "template/package-lock.json",
    why: "Pinned dependency resolution consumed by setup through npm ci.",
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

  // --- The G2P data files, read verbatim at runtime ------------------------
  //
  // src/g2p/ resolves these relative to import.meta.url, so dist/g2p/*.js needs
  // its own copy beside it; copy-g2p-data.mjs puts one there at build time. Two
  // of the three are read on the first narration of a process and the third is
  // a licence, so a minifier or formatter reaching any of them either changes a
  // pronunciation or breaks an attribution.
  {
    package: "@xplainer/render-core",
    path: "dist/g2p/data/lexicon.txt",
    identicalTo: "src/g2p/data/lexicon.txt",
    why: "The curated domain lexicon, parsed line by line at runtime.",
  },
  {
    package: "@xplainer/render-core",
    path: "dist/g2p/data/cmudict.dict",
    identicalTo: "src/g2p/data/cmudict.dict",
    why: "CMUdict, parsed line by line at runtime; the vendored copy is upstream verbatim.",
  },
  {
    package: "@xplainer/render-core",
    path: "dist/g2p/data/cmudict.LICENSE",
    identicalTo: "src/g2p/data/cmudict.LICENSE",
    why:
      "CMUdict is 2-clause BSD and clause 1 requires the notice and disclaimer to travel with " +
      "the source. The dictionary is in this tarball, so its licence has to be too.",
  },
  {
    package: "@xplainer/render-core",
    path: "dist/g2p/data/kokoro-tokenizer.json",
    identicalTo: "src/g2p/data/kokoro-tokenizer.json",
    why:
      "Kokoro's 115-symbol vocabulary, read at runtime to refuse a phoneme the model would " +
      "silently drop. Reformatting it is harmless; replacing it is not, so the bytes are pinned.",
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
  {
    package: "@xplainer/render-core",
    dir: "template",
    why:
      "The Remotion workspace copied onto the user's machine. A file added here has to ship " +
      "the day it is added or the scaffolded workspace is incomplete on a user's disk and " +
      "renders nothing — and the five files named individually above could not catch a sixth.",
  },
];

/** Directories never walked when checking a must-ship tree. */
const TREE_SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".turbo", "__pycache__"]);

/**
 * The id under which the MUST_SHIP_FILES mechanism is self-tested.
 *
 * It is not a rule in any of the three tables — it is one function,
 * {@link inspectMustShipFile} — but it fails in the same way a rule does and it
 * is the sole remaining guard on the files that must ship byte-identical (ADR
 * 0022 says so in as many words), so it is held to the same standard: show it
 * firing.
 */
const MUST_SHIP_RULE_ID = "must-ship-file";

/** The same, for the MUST_SHIP_TREES mechanism: a whole directory, nothing dropped. */
const MUST_SHIP_TREE_RULE_ID = "must-ship-tree";

/**
 * ============================================================================
 * SELF-TESTS — the negative test each rule has to pass before it is trusted.
 * ============================================================================
 *
 * Two samples per rule: one value that violates it and one that does not. The
 * runner asserts the rule fires on the first and stays silent on the second,
 * and it fails when a rule has NO entry here — so the table cannot fall behind
 * the rule list.
 *
 * Both halves earn their place. Without the violating sample a rule that had
 * been broken into a permanent `false` would report a clean tarball forever,
 * which is the exact failure mode ADR 0023 recorded for the tier check when its
 * real-graph half went vacuous. Without the clean sample a rule that had been
 * widened into a permanent `true` would fail a correct publish, which is
 * noisier but gets "fixed" by weakening the rule.
 *
 * Samples are shaped by the rule's kind: a tarball path for a FILE_RULE,
 * `{ path, text }` for a CONTENT_RULE, `{ manifest, member }` for a
 * MANIFEST_RULE, and `{ entry, shipped, files }` for the must-ship mechanism.
 */
const SELF_TEST_MEMBER = { dir: "packages/example", name: "@xplainer/example" };

const SELF_TEST_MANIFEST = {
  name: SELF_TEST_MEMBER.name,
  license: EXPECTED_LICENSE,
  homepage: EXPECTED_HOMEPAGE,
  repository: {
    type: "git",
    url: `git+${EXPECTED_REPOSITORY}.git`,
    directory: SELF_TEST_MEMBER.dir,
  },
  author: EXPECTED_AUTHOR,
};

const selfTestManifest = (overrides) => ({
  manifest: { ...SELF_TEST_MANIFEST, ...overrides },
  member: SELF_TEST_MEMBER,
});

const SELF_TESTS = [
  // --- FILE_RULES ---------------------------------------------------------
  {
    rule: "no-source-map",
    violating: "dist/index.js.map",
    clean: "dist/index.js",
  },
  {
    rule: "no-typescript-source",
    violating: "dist/index.ts",
    // A .d.ts ends with `.ts` too, and it is the one thing this rule must let
    // through: it is the API specification a consumer's tsc requires.
    clean: "dist/index.d.ts",
  },
  {
    rule: "no-src-directory",
    violating: "src/index.js",
    // Only a whole path segment counts. `src-helpers` merely starts with it.
    clean: "dist/src-helpers/index.js",
  },
  {
    rule: "no-tests-or-fixtures",
    violating: "dist/scaffold.test.js",
    clean: "dist/scaffold.js",
  },
  {
    rule: "no-tests-or-fixtures",
    violating: "python/tests/test_models.py",
    clean: "python/xplainer_protocol/models.py",
  },
  {
    rule: "no-python-bytecode",
    violating: "python/xplainer_protocol/__pycache__/models.cpython-313.pyc",
    clean: "python/xplainer_protocol/models.py",
  },

  // --- CONTENT_RULES ------------------------------------------------------
  {
    rule: "no-source-mapping-url",
    // Assembled from parts, like the rule itself, so this file's own text is
    // not a match when the repository is grepped for the comment.
    violating: {
      path: "dist/index.js",
      text: `export {};\n//# ${"sourceMappingURL"}=index.js.map\n`,
    },
    clean: { path: "dist/index.js", text: "export {};\n" },
  },
  {
    rule: "no-private-repository-name",
    violating: {
      path: "dist/index.d.ts",
      text: `/** Relocated to BrewMyTech/${PRIVATE_REPOSITORY_NAME}. */\n`,
    },
    clean: { path: "dist/index.d.ts", text: "/** Relocated to a private repository. */\n" },
  },
  {
    rule: "no-private-reference-path",
    violating: {
      path: "dist/index.d.ts",
      text: "/** Field defaults mirror max/.explainers/scripts/narrate.py:191-196. */\n",
    },
    clean: {
      path: "dist/index.d.ts",
      text: "/** Field defaults mirror the reference implementation. */\n",
    },
  },

  // --- MANIFEST_RULES -----------------------------------------------------
  {
    rule: "license-is-spdx",
    violating: selfTestManifest({ license: "UNLICENSED" }),
    clean: selfTestManifest({}),
  },
  {
    rule: "homepage-is-the-product-site",
    violating: selfTestManifest({ homepage: undefined }),
    clean: selfTestManifest({}),
  },
  {
    rule: "repository-names-this-repo-and-member",
    violating: selfTestManifest({ repository: undefined }),
    // The conventional `git+…​.git` spelling npm normalises must be accepted.
    clean: selfTestManifest({}),
  },
  {
    rule: "repository-names-this-repo-and-member",
    // The failure that matters in a monorepo: right repository, wrong member,
    // so every package's "view source" link lands on the root.
    violating: selfTestManifest({
      repository: { type: "git", url: EXPECTED_REPOSITORY, directory: "packages/somewhere-else" },
    }),
    clean: selfTestManifest({
      repository: { type: "git", url: EXPECTED_REPOSITORY, directory: SELF_TEST_MEMBER.dir },
    }),
  },
  {
    rule: "author-is-the-owner",
    violating: selfTestManifest({ author: { name: "Rishav Anand" } }),
    clean: selfTestManifest({}),
  },

  // --- PRESENCE_RULES -----------------------------------------------------
  {
    rule: "license-in-tarball",
    violating: ["dist/index.js", "NOTICE", "README.md"],
    clean: ["dist/index.js", "LICENSE", "NOTICE", "README.md"],
  },
  {
    rule: "license-in-tarball-matches-root",
    violating: { packageText: "Apache License, Version 2.0", rootText: "All rights reserved." },
    clean: { packageText: "Apache License, Version 2.0", rootText: "Apache License, Version 2.0" },
  },
  {
    rule: "notice-in-tarball",
    // The obvious mistake: LICENSE named in `files`, NOTICE forgotten. §4(d)
    // makes that non-compliant with the licence the manifest itself declares.
    violating: ["dist/index.js", "LICENSE", "README.md"],
    clean: ["dist/index.js", "LICENSE", "NOTICE", "README.md"],
  },
  {
    rule: "notice-in-tarball-matches-root",
    violating: { packageText: "Copyright 2026 Someone Else", rootText: "Copyright 2026 xplainer" },
    clean: { packageText: "Copyright 2026 xplainer", rootText: "Copyright 2026 xplainer" },
  },
  {
    rule: "readme-in-tarball",
    violating: ["dist/index.js", "LICENSE", "NOTICE"],
    clean: ["dist/index.js", "LICENSE", "NOTICE", "README.md"],
  },

  // --- The must-ship mechanism --------------------------------------------
  {
    rule: MUST_SHIP_RULE_ID,
    violating: {
      entry: { path: "SKILL.md", why: "…" },
      shipped: ["dist/index.js"],
      files: { "SKILL.md": "prose" },
    },
    clean: {
      entry: { path: "SKILL.md", why: "…" },
      shipped: ["SKILL.md", "dist/index.js"],
      files: { "SKILL.md": "prose" },
    },
  },
  {
    rule: MUST_SHIP_RULE_ID,
    // The anti-transformation half: it ships, but a build step rewrote it.
    violating: {
      entry: { path: "dist/skills/SKILL.md", identicalTo: "SKILL.md", why: "…" },
      shipped: ["dist/skills/SKILL.md"],
      files: { "SKILL.md": "prose", "dist/skills/SKILL.md": "prose, minified" },
    },
    clean: {
      entry: { path: "dist/skills/SKILL.md", identicalTo: "SKILL.md", why: "…" },
      shipped: ["dist/skills/SKILL.md"],
      files: { "SKILL.md": "prose", "dist/skills/SKILL.md": "prose" },
    },
  },
  {
    rule: MUST_SHIP_TREE_RULE_ID,
    // The case the per-file entries above cannot catch: a file added to the
    // tree on disk that the tarball does not carry.
    violating: {
      tree: { dir: "schemas", why: "…" },
      shipped: ["schemas/manifest.json"],
      listing: ["manifest.json", "tools/explainer_create.input.json"],
    },
    clean: {
      tree: { dir: "schemas", why: "…" },
      shipped: ["schemas/manifest.json", "schemas/tools/explainer_create.input.json"],
      listing: ["manifest.json", "tools/explainer_create.input.json"],
    },
  },
];

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

/**
 * Judge one MUST_SHIP_FILES entry against a tarball.
 *
 * Pure on purpose, so the self-tests can drive it: `shipped` is the set of
 * tarball paths and `bytesOf` reads a package-relative path, returning `null`
 * when it is not on disk. Returns the finding to record, or `null`.
 */
function inspectMustShipFile(entry, shipped, bytesOf) {
  if (!shipped.has(entry.path)) {
    return {
      label: `${entry.path} MUST ship and is missing from the tarball`,
      detail: entry.why,
    };
  }
  if (entry.identicalTo === undefined) {
    return null;
  }
  const shippedBytes = bytesOf(entry.path);
  const sourceBytes = bytesOf(entry.identicalTo);
  if (shippedBytes === null || sourceBytes === null) {
    return {
      label: `${entry.path} cannot be compared against ${entry.identicalTo}`,
      detail: "One of the two is not on disk.",
    };
  }
  if (!shippedBytes.equals(sourceBytes)) {
    return {
      label: `${entry.path} differs from ${entry.identicalTo}`,
      detail:
        `${entry.why} It must ship byte-for-byte; a build step that rewrote it (minifier, ` +
        "obfuscator, formatter) breaks the product.",
    };
  }
  return null;
}

/**
 * Judge one MUST_SHIP_TREES entry against a tarball.
 *
 * Pure for the same reason as {@link inspectMustShipFile}: `listing` is what is
 * on disk under the tree, relative to it, and `shipped` is the tarball's path
 * set. Returns the tree-relative paths that were dropped, which is empty when
 * nothing was.
 */
function inspectMustShipTree(tree, shipped, listing) {
  return listing.filter((relativePath) => !shipped.has(`${tree.dir}/${relativePath}`));
}

/**
 * Whether a package's copy of a root-owned file still matches the root's.
 *
 * Pure. `null` for either side means there is nothing to compare — the presence
 * rule above is what reports a missing file, and reporting it twice would read
 * as two problems.
 */
function inspectRootCopy(rule, packageBytes, rootBytes) {
  if (packageBytes === null || rootBytes === null) {
    return null;
  }
  return packageBytes.equals(rootBytes)
    ? null
    : { label: rule.driftLabel, detail: rule.driftDetail };
}

/** The package's own copy of a root-owned file, or null when it is not on disk. */
function bytesOfRootOwnedFile(root, memberDir, file) {
  const diskPath = toDiskPath(root, memberDir, file);
  return existsSync(diskPath) ? readFileSync(diskPath) : null;
}

/** Every rule the self-tests have to cover, by id, with the kind of sample it takes. */
function indexRules() {
  const index = new Map();
  for (const rule of FILE_RULES) {
    index.set(rule.id, { kind: "file", rule });
  }
  for (const rule of CONTENT_RULES) {
    index.set(rule.id, { kind: "content", rule });
  }
  for (const rule of MANIFEST_RULES) {
    index.set(rule.id, { kind: "manifest", rule });
  }
  for (const rule of PRESENCE_RULES) {
    index.set(rule.id, { kind: "presence", rule });
    if (rule.sameAsRoot) {
      index.set(`${rule.id}-matches-root`, { kind: "root-copy", rule });
    }
  }
  index.set(MUST_SHIP_RULE_ID, { kind: "must-ship", rule: null });
  index.set(MUST_SHIP_TREE_RULE_ID, { kind: "must-ship-tree", rule: null });
  return index;
}

/** Whether `rule` reports a problem for `sample`. */
function ruleFires(kind, rule, sample) {
  if (kind === "file") {
    return rule.matches(sample);
  }
  if (kind === "content") {
    return rule.appliesTo(sample.path) && rule.matches(sample.text);
  }
  if (kind === "manifest") {
    return rule.check(sample.manifest, sample.member) !== null;
  }
  if (kind === "presence") {
    return !new Set(sample).has(rule.file);
  }
  if (kind === "root-copy") {
    const toBytes = (text) => (text === null ? null : Buffer.from(text, "utf8"));
    return inspectRootCopy(rule, toBytes(sample.packageText), toBytes(sample.rootText)) !== null;
  }
  if (kind === "must-ship-tree") {
    return inspectMustShipTree(sample.tree, new Set(sample.shipped), sample.listing).length > 0;
  }
  const bytesOf = (path) =>
    Object.hasOwn(sample.files, path) ? Buffer.from(sample.files[path], "utf8") : null;
  return inspectMustShipFile(sample.entry, new Set(sample.shipped), bytesOf) !== null;
}

const describeSample = (sample) => {
  const text = JSON.stringify(sample);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
};

/**
 * Run every rule against its own violating and clean sample.
 *
 * A rule with no self-test is a failure, not an omission: it is the case where
 * this gate would go on reporting clean tarballs after the rule stopped being
 * able to fail, and nobody would know.
 */
function runSelfTests() {
  const problems = [];
  const index = indexRules();
  const covered = new Set();

  for (const test of SELF_TESTS) {
    const entry = index.get(test.rule);
    if (entry === undefined) {
      problems.push(
        `self-test names unknown rule "${test.rule}". Rule ids are: ` +
          `${[...index.keys()].join(", ")}.`,
      );
      continue;
    }
    covered.add(test.rule);
    if (!ruleFires(entry.kind, entry.rule, test.violating)) {
      problems.push(
        `rule "${test.rule}" did NOT fire on ${describeSample(test.violating)}, which violates ` +
          "it. The rule can no longer fail, so every tarball it checks passes vacuously.",
      );
    }
    if (ruleFires(entry.kind, entry.rule, test.clean)) {
      problems.push(
        `rule "${test.rule}" fired on ${describeSample(test.clean)}, which does not violate it. ` +
          "It would fail a correct publish.",
      );
    }
  }

  for (const id of index.keys()) {
    if (!covered.has(id)) {
      problems.push(
        `rule "${id}" has no self-test. Add one to SELF_TESTS: a value that violates the rule ` +
          "and a value that does not.",
      );
    }
  }

  return problems;
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

  // --- Three files that have to be inside the tarball ----------------------
  for (const rule of PRESENCE_RULES) {
    if (ruleFires("presence", rule, tarballPaths)) {
      findings.note(rule.label, rule.detail);
    }
    if (!rule.sameAsRoot) {
      continue;
    }
    const packageCopy = bytesOfRootOwnedFile(root, member.dir, rule.file);
    const rootCopy = existsSync(join(root, rule.file)) ? readFileSync(join(root, rule.file)) : null;
    const drift = inspectRootCopy(rule, packageCopy, rootCopy);
    if (drift !== null) {
      findings.note(drift.label, drift.detail);
    }
  }

  // --- The manifest must say who published this and where it came from -----
  const manifest = readManifest(root, member.dir);
  for (const rule of MANIFEST_RULES) {
    const problem = rule.check(manifest, member);
    if (problem !== null) {
      findings.note(problem, `Rule: ${rule.id}.`);
    }
  }

  // --- Files that must ship, and must ship untransformed -------------------
  const bytesOf = (path) => {
    const diskPath = toDiskPath(root, member.dir, path);
    return existsSync(diskPath) ? readFileSync(diskPath) : null;
  };
  for (const entry of MUST_SHIP_FILES.filter((item) => item.package === member.name)) {
    const problem = inspectMustShipFile(entry, shipped, bytesOf);
    if (problem !== null) {
      findings.note(problem.label, problem.detail);
    }
  }

  // --- Whole directories that must reach the tarball intact ----------------
  for (const tree of MUST_SHIP_TREES.filter((item) => item.package === member.name)) {
    const absoluteDir = join(root, member.dir, tree.dir);
    if (!existsSync(absoluteDir)) {
      findings.note(`${tree.dir}/ MUST ship and does not exist on disk`, tree.why);
      continue;
    }
    for (const relativePath of inspectMustShipTree(tree, shipped, listTree(absoluteDir))) {
      findings.add(
        `${MUST_SHIP_TREE_RULE_ID}:${tree.dir}`,
        `files under ${tree.dir}/ that MUST ship and are missing from the tarball`,
        tree.why,
        `${tree.dir}/${relativePath}`,
      );
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
    process.stderr.write(
      `check-publish-contract: ${NOTICE_FILE} is missing from the repository root, so no ` +
        `package can ship the attribution ${EXPECTED_LICENSE} section 4(d) requires.\n`,
    );
    return 2;
  }

  if (!existsSync(join(root, LICENCE_FILE))) {
    process.stderr.write(
      `check-publish-contract: ${LICENCE_FILE} is missing from the repository root, so there is ` +
        "no licence for the packages to ship.\n",
    );
    return 2;
  }

  // The rules judge themselves before they judge anything else. If one of them
  // cannot fail, nothing it says about a real tarball is worth reading, so this
  // returns rather than continuing on to report a reassuring "clean".
  const selfTestProblems = runSelfTests();
  if (selfTestProblems.length > 0) {
    process.stderr.write(
      "check-publish-contract: the gate failed its own tests, so it was not run against the " +
        "packages.\n",
    );
    for (const problem of selfTestProblems) {
      process.stderr.write(`  x ${problem}\n`);
    }
    return 1;
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
