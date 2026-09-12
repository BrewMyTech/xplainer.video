/**
 * Re-hardlink every injected workspace package's published surface into its copy under
 * `node_modules/.pnpm`.
 *
 * **This exists because pnpm's own mechanism does not cover a new file, and the recovery is not
 * obvious.** `sync-injected-deps-after-scripts=build` propagates *edits* to files that existed at
 * install time, because those are hardlinked into the injected copy and written through. A file the
 * build creates for the first time never appears, and no form of `pnpm install` adds it — measured
 * on pnpm 11.25.0, four times now, each surfacing as a consumer failing to load a package with
 * `Cannot find module` naming a file the failing test does not import.
 *
 * **It used to handle `apps/cli` alone, and that was the wrong shape.** The first three times were
 * all `@xplainer/cli`, so the script hardcoded it; the fourth was `@xplainer/protocol` gaining
 * `dist/generated/tool-input-schemas.js`, and the tool that existed to fix exactly this could not.
 * Nothing about the defect is specific to one member, so neither is this any more: it discovers
 * every injected `@xplainer/*` copy and relinks each from the workspace directory its own directory
 * name already names.
 *
 * **Hardlinks, not `cp -R`.** An earlier recovery copied the tree, which restores the missing file
 * and silently breaks the propagation that did work: the next version bump left the copy reporting
 * the old version, because its `package.json` was no longer the same inode. `linkSync` is what pnpm
 * itself does, so edits keep flowing and only new files need this.
 *
 * CI never needs it: there `dist/` does not exist at install time, so the injected copy is
 * materialised from the build with every file present.
 */

import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

/** Files npm ships whatever `files` says, so they are linked even when it does not list them. */
const ALWAYS = ["package.json", "LICENSE", "NOTICE", "README.md"];

/**
 * One injected copy: where it lives, and the workspace directory it was injected from.
 *
 * pnpm encodes the source path in the directory name — `@xplainer+protocol@file+packages+protocol`
 * — so the mapping back is the name itself rather than a lookup that could disagree with it. A
 * trailing `_<hash>` appears when a package is injected at more than one dependency shape; it is
 * not part of the path.
 */
function injectedCopies() {
  const root = join("node_modules", ".pnpm");
  if (!existsSync(root)) {
    return [];
  }
  const copies = [];
  for (const entry of readdirSync(root)) {
    const match = /^@xplainer\+([^@]+)@file\+([^_]+)/.exec(entry);
    if (match === null) {
      continue;
    }
    const [, name, encodedPath] = match;
    const source = encodedPath.split("+").join("/");
    const copy = join(root, entry, "node_modules", "@xplainer", name);
    if (existsSync(source) && existsSync(dirname(copy))) {
      copies.push({ copy, source, name });
    }
  }
  return copies;
}

/**
 * What this package publishes, from its own `files` list rather than a guess held here.
 *
 * **`files` holds globs, and this deliberately links the directory rather than the pattern.**
 * Every member spells its build output `dist/**\/*.js`, which names no file on disk: passing it
 * to `existsSync` answers false, and a first version of this function therefore linked the four
 * always-shipped files and silently skipped every `dist` — leaving each injected copy emptier than
 * the problem it was called to fix, with no error. Truncating at the first wildcard turns each
 * pattern back into the directory it walks, so `dist/**\/*.js` and `python/**\/*.py` become `dist`
 * and `python`. That over-links a little — a `.map` beside a `.js` — which costs nothing in a
 * `node_modules` copy and is the safe direction to be wrong in.
 */
function publishedSurface(source) {
  let declared = [];
  try {
    const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    declared = Array.isArray(manifest.files) ? manifest.files : [];
  } catch {
    declared = [];
  }
  if (declared.length === 0) {
    // No `files` field means npm publishes the whole directory, and `@xplainer/config` is exactly
    // that — it ships `tsconfig/`, which no list here would have guessed. Mirror npm rather than
    // invent a surface: everything except the one directory that is never published.
    return readdirSync(source).filter((entry) => entry !== "node_modules");
  }
  const roots = declared.map((pattern) => {
    const wildcard = pattern.search(/[*?[]/);
    const literal = wildcard === -1 ? pattern : pattern.slice(0, wildcard);
    return literal.replace(/\/+$/, "");
  });
  return [...new Set([...ALWAYS, ...roots])].filter((entry) => entry.length > 0);
}

function linkTree(from, to) {
  if (!existsSync(from)) {
    return 0;
  }
  if (statSync(from).isDirectory()) {
    let linked = 0;
    for (const entry of readdirSync(from)) {
      linked += linkTree(join(from, entry), join(to, entry));
    }
    return linked;
  }
  // **Files only, and after the directory branch.** Two `files` entries can name the same file —
  // `@xplainer/protocol` lists both `python/**\/*.py` and `python/xplainer_protocol/py.typed`, and
  // truncating the first at its wildcard makes them overlap, which would throw EEXIST and abort the
  // run half-way. An earlier version put this check at the top of the function, where it also
  // matched *directories*: an injected copy that already had a `dist/` was reported as complete
  // while every new file under it was skipped, so the tool for the missing-file defect silently
  // refused to fix one. Found when `@xplainer/cli` gained `dist/setup/star.js` and six alias tests
  // failed against a copy this script had just called up to date.
  if (existsSync(to)) {
    return 0;
  }
  mkdirSync(dirname(to), { recursive: true });
  linkSync(from, to);
  return 1;
}

const copies = injectedCopies();
if (copies.length === 0) {
  process.stdout.write("relink-injected: no injected @xplainer/* copy found; nothing to do.\n");
  process.exit(0);
}

const only = process.argv.slice(2);
let touched = 0;
for (const { copy, source, name } of copies) {
  if (only.length > 0 && !only.includes(name)) {
    continue;
  }
  // **Additive, and never `rmSync` the copy first.** An earlier version cleared the directory and
  // relinked whatever it computed, so a surface it computed wrongly was destructive rather than
  // merely incomplete: `@xplainer/config` declares no `files`, the computation answered with the
  // four always-shipped names, and the `tsconfig/` every member extends was deleted — breaking
  // every package's typecheck to repair one missing file. The defect this script exists for is a
  // file that never arrived, so linking only what is missing is sufficient, and the worst a wrong
  // answer can now do is nothing.
  mkdirSync(copy, { recursive: true });
  let linked = 0;
  for (const entry of publishedSurface(source)) {
    linked += linkTree(join(source, entry), join(copy, entry));
  }
  touched += 1;
  process.stdout.write(
    `relink-injected: @xplainer/${name} — linked ${String(linked)} missing file(s) from ${source}\n`,
  );
}
if (touched === 0) {
  process.stdout.write(`relink-injected: nothing matched ${only.join(", ")}.\n`);
}
