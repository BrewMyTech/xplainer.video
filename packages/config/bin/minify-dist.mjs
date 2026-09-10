#!/usr/bin/env node
/**
 * Publish-output hardening for one workspace member.
 *
 * Run from a member's package root as the last step of its `build` script, so
 * what the tests import is byte-identical to what npm publishes. It does four
 * things to `dist/`, in this order:
 *
 *   1. Deletes every `*.map`. `tsconfig.build.json` sets `sourceMap: false` and
 *      `declarationMap: false`, so a fresh build emits none — but `tsc` never
 *      cleans `dist/`, so maps written by an older build survive forever and
 *      the `files` allowlist is the only thing between them and the tarball.
 *      Deleting them is the belt to that braces.
 *   2. Minifies `dist/**\/*.js` with esbuild: whitespace and syntax, NOT
 *      identifiers (see MANGLE_IDENTIFIERS below). This is what removes ALL
 *      comments from shipped JavaScript, and the comments were the largest
 *      thing being given away — the module headers narrate the design, cite ADR
 *      numbers and name the gaps, so a reader never had to reverse-engineer
 *      anything.
 *   3. Removes the leading file-header comment from `dist/**\/*.d.ts` when it
 *      cites a document that is not published (an ADR number, a plan or spec
 *      section, an acceptance-criterion id, the reference implementation).
 *      Per-symbol JSDoc is left alone: it is the API documentation a caller
 *      needs, and deleting it makes the package worse.
 *
 *      This is why `removeComments` is explicitly FALSE in every
 *      `tsconfig.build.json` rather than true. Under the TypeScript 7 compiler
 *      this workspace pins, `removeComments` strips declaration comments as
 *      well as script comments — measured: it took `apps/cli/dist/server.d.ts`
 *      from 3.7 KB to 678 B and took the doc on `DEFAULT_PORT` ("the port
 *      `xplainer serve` binds when none is given") with it. That is the API
 *      documentation of a package whose licence grants free use, so the blunt
 *      flag is the wrong tool and this targeted pass is the right one.
 *   4. Asserts no `sourceMappingURL` comment survives anywhere in `dist/`.
 *
 * WHAT THIS BUYS, STATED HONESTLY. Shipping JavaScript means shipping readable
 * JavaScript. This removes comments and compresses syntax; it does not remove
 * structure, string literals, exported names, or the call sequence into the
 * dependencies. Anyone who runs `npm pack $(npm view <pkg> dist.tarball)` and a
 * prettifier gets legible logic back in minutes. What it actually raises the
 * bar against is lazy copy-paste, and what it actually removes is the design
 * commentary that would otherwise narrate the implementation to a reader. It is
 * not protection, it adds no legal weight, and the redistribution and
 * resale-as-a-service clauses of LICENSE-BINARY are what do the real work.
 */

import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { transform } from "esbuild";

/**
 * Identifier mangling is OFF.
 *
 * With mangling on, a crash in the long-running `xplainer serve` daemon reaches
 * journald as `at n (…/dist/index.js:1:48213)`, which is not a stack trace
 * anyone can act on. Turning it on is only defensible together with a workflow
 * that archives each release's `.js.map` as a CI artefact and symbolicates
 * production traces against it after the fact — build the map, ship the
 * minified JS, never ship the map. Until that workflow exists, mangling costs
 * crash diagnosis and buys an hour of a determined reader's time.
 *
 * Set XPLAINER_MANGLE=1 to turn it on once that workflow does exist. `keepNames`
 * is tied to the same switch on purpose: it only matters when identifiers are
 * being renamed, and enabling it while they are not injects esbuild's `__name`
 * helper into every module for no benefit at all.
 */
const MANGLE_IDENTIFIERS = process.env.XPLAINER_MANGLE === "1";

/**
 * Files that MUST ship as readable source, with the reason each one cannot be
 * touched. This list is data, and it is checked rather than trusted: anything
 * this script is about to rewrite is matched against it first and a hit is a
 * hard failure, so widening the walk below can never silently mangle one of
 * them.
 *
 * Together these four are the parts of the product that are genuinely hard to
 * reproduce — the schemas ARE the protocol, SKILL.md IS the prompt engineering,
 * the templates ARE the Remotion know-how — and all four are readable by
 * necessity. Whatever is done to the `.js` does not change that.
 */
const READABLE_SOURCE = [
  {
    package: "@xplainer/render-core",
    glob: "template/**",
    why: "The Remotion workspace the user's videos render in. `remotion.config.ts` and `tsconfig.json` here are the user's own project files and must arrive as readable TypeScript.",
  },
  {
    package: "@xplainer/render-core",
    glob: "dist/scaffold/templates/*.txt",
    why: "The six scaffold templates, read verbatim at runtime by dist/scaffold/index.js and written to the user's video directory byte for byte. Scenes.tsx is then the file the agent edits. Stored as .txt precisely so no tool touches their bytes.",
  },
  {
    package: "@xplainer/skill",
    glob: "SKILL.md",
    why: "Prose an agent reads as instructions. Obfuscating prose is not a coherent operation.",
  },
  {
    package: "@xplainer/skill",
    glob: "dist/claude-plugin/skills/xplainer/SKILL.md",
    why: "Build copy of the above, byte-identical by contract (skill/src/build.test.ts asserts it).",
  },
  {
    package: "@xplainer/skill",
    glob: "dist/codex-plugin/skills/xplainer/SKILL.md",
    why: "Build copy of the above, byte-identical by contract (skill/src/build.test.ts asserts it).",
  },
  {
    package: "@xplainer/protocol",
    glob: "schemas/**",
    why: "The published tool contract consumers validate against. By design a complete description of the eight tools.",
  },
];

/**
 * Markers that identify a comment as a reference to a document this repository
 * does not publish. A `.d.ts` file header carrying one of these is a design
 * essay written for a maintainer, not documentation written for a caller.
 */
const INTERNAL_DOC_MARKERS = [
  /\bADR\s*\d{2,}/,
  /\bplan\s*§/,
  /\bspec\s*§/,
  /\bacceptance criteri/i,
  /\bAC-\d/,
  /\bexplainer_mcp\.py/,
  /docs\/ROADMAP/,
  // `.omc/` is this workspace ignored operational state — plans, spikes,
  // handoffs. A path into it names a file no consumer can open, which is the
  // same objection check-publish-contract makes to a `max/` coordinate.
  /\.omc\//,
];

/** Translate the small glob subset used above into an anchored RegExp. */
function globToRegExp(glob) {
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*") {
      if (glob[index + 1] === "*") {
        source += ".*";
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (/[.+?^$(){}|[\]\\]/.test(character)) {
      source += `\\${character}`;
    } else {
      source += character;
    }
  }
  return new RegExp(`${source}$`);
}

const EXEMPT_PATTERNS = READABLE_SOURCE.map((entry) => ({
  ...entry,
  pattern: globToRegExp(entry.glob),
}));

/** The exemption `relative` matches, or undefined. Paths use forward slashes. */
function exemptionFor(relative) {
  return EXEMPT_PATTERNS.find((entry) => entry.pattern.test(relative));
}

/** Every file under `directory`, recursively, as paths relative to `root`. */
function collect(root, directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...collect(root, absolute));
    } else if (entry.isFile()) {
      found.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }
  return found;
}

/**
 * Remove the leading `/** … *\/` block of a declaration file when it cites an
 * unpublished document.
 *
 * Only the block at the very top of the file is considered. That block is the
 * module header — `tsc` emits it before the first declaration and it is
 * attached to no exported symbol — which is exactly where the rationale lives.
 * Everything after it is per-symbol JSDoc and is kept verbatim.
 */
function stripInternalHeader(text) {
  const match = /^\s*\/\*\*[\s\S]*?\*\//.exec(text);
  if (!match) {
    return text;
  }
  const header = match[0];
  if (!INTERNAL_DOC_MARKERS.some((marker) => marker.test(header))) {
    return text;
  }
  return text.slice(match.index + header.length).replace(/^\r?\n/, "");
}

const packageRoot = process.cwd();
const distRoot = path.join(packageRoot, "dist");

let distFiles;
try {
  distFiles = collect(packageRoot, distRoot);
} catch (error) {
  if (error.code === "ENOENT") {
    console.error("minify-dist: no dist/ to harden — run the compiler first");
    process.exit(1);
  }
  throw error;
}

const removedMaps = [];
const minified = [];
const strippedHeaders = [];

for (const relative of distFiles) {
  const absolute = path.join(packageRoot, relative);

  if (relative.endsWith(".map")) {
    rmSync(absolute);
    removedMaps.push(relative);
    continue;
  }

  const isScript = relative.endsWith(".js") || relative.endsWith(".mjs");
  const isDeclaration = relative.endsWith(".d.ts") || relative.endsWith(".d.mts");
  if (!isScript && !isDeclaration) {
    continue;
  }

  const exemption = exemptionFor(relative);
  if (exemption) {
    console.error(
      `minify-dist: refusing to rewrite ${relative}, which ${exemption.package} must ship as readable source: ${exemption.why}`,
    );
    process.exit(1);
  }

  const original = readFileSync(absolute, "utf8");

  if (isDeclaration) {
    const stripped = stripInternalHeader(original);
    if (stripped !== original) {
      writeFileSync(absolute, stripped);
      strippedHeaders.push(relative);
    }
    continue;
  }

  // A shebang is not JavaScript and esbuild's transform API has no reason to
  // keep it. `dist/bin.js` is the `xplainer` binary, so losing it is fatal.
  const shebang = /^#![^\n]*\n/.exec(original);
  const body = shebang ? original.slice(shebang[0].length) : original;

  const result = await transform(body, {
    loader: "js",
    target: "esnext",
    minifyWhitespace: true,
    minifySyntax: true,
    minifyIdentifiers: MANGLE_IDENTIFIERS,
    keepNames: MANGLE_IDENTIFIERS,
    legalComments: "none",
    sourcemap: false,
  });

  writeFileSync(absolute, shebang ? shebang[0] + result.code : result.code);
  minified.push(relative);
}

// Nothing above can produce a sourceMappingURL, which is the point of asserting
// it: this catches a build config that quietly turned sourceMap back on, and it
// is checked against the bytes on disk rather than against the config.
const leaking = collect(packageRoot, distRoot).filter((relative) => {
  if (!/\.(js|mjs|cjs|d\.ts|d\.mts)$/.test(relative)) {
    return false;
  }
  return readFileSync(path.join(packageRoot, relative), "utf8").includes("sourceMappingURL");
});

if (leaking.length > 0) {
  console.error(`minify-dist: sourceMappingURL survived into ${leaking.join(", ")}`);
  process.exit(1);
}

console.log(
  `minify-dist: minified ${minified.length} script(s)${
    MANGLE_IDENTIFIERS ? " with identifier mangling ON" : ""
  }, stripped ${strippedHeaders.length} internal header(s), removed ${removedMaps.length} stale map(s)`,
);
