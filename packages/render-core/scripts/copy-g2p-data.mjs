#!/usr/bin/env node
/**
 * Third step of `@xplainer/render-core`'s `build`, and the exact counterpart of
 * `copy-templates.mjs`.
 *
 * `src/g2p/` reads three committed data files at runtime — the curated lexicon,
 * CMUdict, and Kokoro's tokenizer — resolving them relative to
 * `import.meta.url`. None of the three is TypeScript, so `tsc` will not emit
 * them into `dist/`, and the built `dist/g2p/*.js` needs its own copy sitting
 * beside it in `dist/g2p/data/`. This script puts one there and fails the build
 * if any file is missing, rather than leaving `phonemise()` to throw `ENOENT` on
 * a user's machine the first time they narrate.
 *
 * `cmudict.LICENSE` is copied for a different reason from the other three: it is
 * not read at runtime at all. The 2-clause BSD licence CMUdict ships under
 * requires that redistribution "retain the above copyright notice, this list of
 * conditions and the following disclaimer", and the dictionary travels in this
 * package's tarball, so its licence has to travel beside it.
 *
 * Written in Node rather than `cp -R` for the same reason `copy-templates.mjs`
 * is: AC-1 requires the workspace to build on Windows as well.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The four files, named individually rather than globbed. A glob would silently
 * ship whatever somebody left in the directory, and it would silently stop
 * shipping a file that was renamed.
 */
const EXPECTED = ["lexicon.txt", "cmudict.dict", "cmudict.LICENSE", "kokoro-tokenizer.json"];

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const source = join(packageRoot, "src", "g2p", "data");
const destination = join(packageRoot, "dist", "g2p", "data");

if (!existsSync(source)) {
  console.error(`copy-g2p-data: data directory is missing: ${source}`);
  process.exit(1);
}

mkdirSync(destination, { recursive: true });

const present = new Set(readdirSync(source));
const missing = EXPECTED.filter((name) => !present.has(name));

if (missing.length > 0) {
  console.error(`copy-g2p-data: missing file(s) in ${source}: ${missing.join(", ")}`);
  process.exit(1);
}

for (const name of EXPECTED) {
  copyFileSync(join(source, name), join(destination, name));
}

console.log(`copy-g2p-data: copied ${EXPECTED.length} data files to ${destination}`);
