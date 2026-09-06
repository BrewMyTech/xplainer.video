#!/usr/bin/env node
/**
 * Suppression gate (plan T20; acceptance criteria AC-15e and AC-15f).
 *
 * One grep, in one place: `apps/`, `packages/` and `services/` may not contain
 * any of the five suppressions AC-15e names — `as any`, the two TypeScript
 * directive comments, a Biome ignore comment and a ruff `# noqa`. The literal
 * spellings are in `PATTERNS` below and appear nowhere else in this file, which
 * is deliberate: written out in a comment they are suppressions themselves, and
 * Biome's own `noTsIgnore` rule says so. Every hit is printed with its file,
 * line and column, and the exit status is 1 if the count is anything other than
 * zero.
 *
 * WHY THIS EXISTS. `isolatedDeclarations` and the stricter `biome.json` are the
 * highest-friction rules in this repository, and both have the same escape
 * hatch: annotate the error away instead of the value. A suppression satisfies
 * every other gate — `turbo build`, `turbo lint` and `turbo typecheck` all go
 * green over an `as any` — so without this check the strict settings would
 * ratchet the *comments* rather than the types. If a gate is wrong, the fix is
 * to change the gate deliberately, which is a diff a reviewer sees.
 *
 * WHY IT IS AN EQUALITY WITH ZERO AND NOT A RATCHET. Measured on this tree, the
 * count is zero across all five patterns. A baseline file would only invite the
 * count to be edited upwards one line at a time.
 *
 * WHY A SCRIPT AND NOT AN INLINE GREP. The same command runs in `pnpm verify`
 * and as its own CI step, and two copies of a grep drift. `AC-2c` avoids that
 * failure mode by having exactly one copy of its pattern; so does this. It uses
 * nothing but the Node standard library and reads no build output, so CI can run
 * it before `pnpm install --frozen-lockfile` and get an answer in seconds.
 *
 * WHY `as any` IS CHECKED IN TYPESCRIPT FILES ONLY. It is TypeScript syntax. In
 * a `.mjs` or `.py` file the same three characters can only be English prose in
 * a comment, and reporting those would be a false failure with no fix but a
 * reword. The other four patterns are distinctive enough to check everywhere.
 *
 * WHAT IS NOT SCANNED. Generated and installed output — `node_modules/`,
 * `dist/`, `out/`, `build/`, `release/`, `coverage/`, `__pycache__/` and every
 * dot-directory (`.turbo/`, `.venv/`, `.pytest_cache/`, `.ruff_cache/`). The
 * list mirrors `.gitignore`'s Node and Python sections rather than reading it,
 * so the answer does not change with the state of the ignore file. `scripts/`
 * is outside the three roots, which is what lets this file name the patterns it
 * bans without banning itself.
 *
 * Exit codes:
 *   0  no suppressions
 *   1  at least one suppression (the contract violation)
 *   2  the checker could not run (no workspace root, a missing root directory,
 *      an argument it does not take)
 *  70  internal error
 *
 * `1` is the only code a violation produces, because AC-15f asserts exactly
 * that; `2` and `70` follow the precedent set by `check-publish-contract.mjs`
 * and `check-docs-contract.mjs`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE_FILE = "pnpm-workspace.yaml";

/** The three directories AC-15e names. All of them must exist. */
const ROOTS = ["apps", "packages", "services"];

/** Files worth reading: the hand-written source languages of this workspace. */
const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".py",
  ".ts",
  ".tsx",
]);

/** Where `as any` is syntax rather than prose. */
const TYPESCRIPT_EXTENSIONS = new Set([".cts", ".mts", ".ts", ".tsx"]);

/** Installed or generated trees. Dot-directories are skipped by name shape, not by list. */
const SKIPPED_DIRECTORIES = new Set([
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "release",
]);

/**
 * The five forbidden patterns. `extensions` narrows a pattern to the files where
 * it can mean what the rule means; omitted, the pattern applies everywhere.
 */
const PATTERNS = [
  { name: "as any", regex: /\bas\s+any\b/g, extensions: TYPESCRIPT_EXTENSIONS },
  { name: "@ts-ignore", regex: /@ts-ignore\b/g },
  { name: "@ts-expect-error", regex: /@ts-expect-error\b/g },
  { name: "biome-ignore", regex: /biome-ignore\b/g },
  { name: "# noqa", regex: /#\s*noqa\b/gi },
];

/** A reported source line longer than this is truncated; the location is the useful part. */
const MAX_EXCERPT = 120;

class UsageError extends Error {}

/**
 * Locate the workspace root by walking up for `pnpm-workspace.yaml`, first from
 * the working directory (the `pnpm check:no-suppressions` case) and then from
 * this file's own location (a direct `node scripts/check-no-suppressions.mjs`
 * from anywhere). Same shape as `check-docs-contract.mjs` and `check-tiers.mjs`.
 */
function findWorkspaceRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const start of [process.cwd(), resolve(here, "..")]) {
    let dir = resolve(start);
    for (;;) {
      if (existsSync(join(dir, WORKSPACE_FILE))) {
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

/** Posix-style path relative to the root, so a diagnostic reads the same on every platform. */
function displayPath(root, file) {
  return relative(root, file).split(sep).join("/");
}

/**
 * Every source file under `directory`, depth first and sorted, so two runs on
 * the same tree print the same lines in the same order. Symbolic links are not
 * followed: the only ones in this workspace point into `node_modules`.
 */
function collectFiles(directory, found) {
  const entries = readdirSync(directory, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      collectFiles(path, found);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      found.push(path);
    }
  }
  return found;
}

/** Every suppression in one file, as `{ line, column, name, excerpt }` records. */
function scanFile(path) {
  const extension = extname(path);
  const applicable = PATTERNS.filter(
    (pattern) => pattern.extensions === undefined || pattern.extensions.has(extension),
  );
  if (applicable.length === 0) {
    return [];
  }
  const hits = [];
  const lines = readFileSync(path, "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    for (const pattern of applicable) {
      for (const match of line.matchAll(pattern.regex)) {
        hits.push({
          line: index + 1,
          column: match.index + 1,
          name: pattern.name,
          excerpt: excerpt(line),
        });
      }
    }
  }
  hits.sort((a, b) => a.line - b.line || a.column - b.column);
  return hits;
}

function excerpt(line) {
  const trimmed = line.trim();
  return trimmed.length > MAX_EXCERPT ? `${trimmed.slice(0, MAX_EXCERPT - 1)}…` : trimmed;
}

function main(argv) {
  if (argv.length > 0) {
    throw new UsageError(
      `unexpected argument(s): ${argv.join(" ")}. This checker takes none; it reads ` +
        `${ROOTS.join(", ")} and reports every suppression it finds.`,
    );
  }
  const root = findWorkspaceRoot();
  if (root === null) {
    throw new UsageError(`no ${WORKSPACE_FILE} found above the working directory.`);
  }

  const files = [];
  for (const name of ROOTS) {
    const directory = join(root, name);
    if (!existsSync(directory) || !statSync(directory).isDirectory()) {
      throw new UsageError(
        `${name}/ is missing from ${root}. AC-15e names all three of ${ROOTS.join(", ")}, so a ` +
          "missing one means this checker is pointed at the wrong tree, not that it passed.",
      );
    }
    collectFiles(directory, files);
  }

  let total = 0;
  let dirty = 0;
  for (const file of files) {
    const hits = scanFile(file);
    if (hits.length === 0) {
      continue;
    }
    dirty += 1;
    total += hits.length;
    const shown = displayPath(root, file);
    for (const hit of hits) {
      process.stdout.write(
        `no-suppressions: ${shown}:${hit.line}:${hit.column}: ${hit.name}: ${hit.excerpt}\n`,
      );
    }
  }

  if (total > 0) {
    process.stderr.write(
      `\nno-suppressions: ${total} suppression(s) in ${dirty} file(s). The count this repository ` +
        "asserts is zero (AC-15e), so every line above is new. Fix the type or the rule rather " +
        "than annotating the error away; if a gate is genuinely wrong, change the gate — that is " +
        "a diff a reviewer can see.\n",
    );
    return 1;
  }

  process.stdout.write(
    `no-suppressions: ${files.length} source file(s) in ${ROOTS.join(", ")} checked for ` +
      `${PATTERNS.map((pattern) => pattern.name).join(", ")}; none found.\n`,
  );
  return 0;
}

let exitCode;
try {
  exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`no-suppressions: ${error.message}\n`);
    exitCode = 2;
  } else {
    process.stderr.write(
      `no-suppressions: internal error\n${error instanceof Error ? error.stack : String(error)}\n`,
    );
    exitCode = 70;
  }
}
process.exitCode = exitCode;
