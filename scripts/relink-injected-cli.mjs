/**
 * Re-hardlink `apps/cli`'s published surface into its injected copy under `node_modules/.pnpm`.
 *
 * **This exists because pnpm's own mechanism does not cover a new file, and the recovery is not
 * obvious.** `sync-injected-deps-after-scripts=build` propagates *edits* to files that existed at
 * install time, because those are hardlinked into the injected copy and written through. A file the
 * build creates for the first time never appears, and no form of `pnpm install` adds it — measured
 * on pnpm 11.25.0, three times in one day, each time surfacing as `apps/desktop` or
 * `packages/alias` failing to load `@xplainer/cli` with `Cannot find module` naming a file the
 * failing test does not import.
 *
 * **Hardlinks, not `cp -R`.** An earlier recovery copied the tree, which restores the missing file
 * and silently breaks the propagation that did work: the next version bump left the copy reporting
 * the old version, because its `package.json` was no longer the same inode. `linkSync` is what pnpm
 * itself does, so edits keep flowing and only new files need this.
 *
 * CI never needs it: there `dist/` does not exist at install time, so the injected copy is
 * materialised from the build with every file present.
 */

import { existsSync, linkSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

const SOURCE = "apps/cli";
/** The `files` allowlist, plus the manifest npm always ships. */
const PUBLISHED = ["package.json", "dist", "LICENSE", "NOTICE", "README.md"];

function injectedCopies() {
  const root = join("node_modules", ".pnpm");
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root)
    .filter((entry) => entry.startsWith("@xplainer+cli@file+apps+cli"))
    .map((entry) => join(root, entry, "node_modules", "@xplainer", "cli"))
    .filter((path) => existsSync(dirname(path)));
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
  mkdirSync(dirname(to), { recursive: true });
  linkSync(from, to);
  return 1;
}

const copies = injectedCopies();
if (copies.length === 0) {
  process.stdout.write(
    "relink-injected-cli: no injected copy of @xplainer/cli found; nothing to do.\n",
  );
  process.exit(0);
}
for (const copy of copies) {
  rmSync(copy, { recursive: true, force: true });
  mkdirSync(copy, { recursive: true });
  let linked = 0;
  for (const entry of PUBLISHED) {
    linked += linkTree(join(SOURCE, entry), join(copy, entry));
  }
  process.stdout.write(`relink-injected-cli: hardlinked ${String(linked)} file(s) into ${copy}\n`);
}
