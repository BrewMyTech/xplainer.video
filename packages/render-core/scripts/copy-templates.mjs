#!/usr/bin/env node
/**
 * Second half of `@xplainer/render-core`'s `build` (plan §4 S2.2).
 *
 * The six scaffold templates are stored as `.txt` so that neither Biome nor
 * `tsc` touches their bytes, which also means `tsc` will not emit them into
 * `dist/`. `src/scaffold/index.ts` resolves them relative to `import.meta.url`,
 * so the built `dist/scaffold/index.js` needs its own copy sitting next to it.
 * This script puts one there, and fails the build if any of the six is
 * missing rather than leaving `scaffoldVideo()` to throw at call time.
 *
 * Written in Node rather than `cp -R` because AC-1 requires the workspace to
 * build on Windows as well as macOS and Linux.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Keep in step with `SCAFFOLD_FILES` in `src/scaffold/index.ts`: the five
 * engine-owned files followed by the agent-owned `Scenes.tsx`. Restated here
 * rather than imported because this script runs against `src/`, before `dist/`
 * is guaranteed to hold anything importable.
 */
const EXPECTED = [
  "index.ts",
  "types.ts",
  "Root.tsx",
  "Captions.tsx",
  "Video.tsx",
  "Scenes.tsx",
].map((name) => `${name}.txt`);

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const source = join(packageRoot, "src", "scaffold", "templates");
const destination = join(packageRoot, "dist", "scaffold", "templates");

if (!existsSync(source)) {
  console.error(`copy-templates: template directory is missing: ${source}`);
  process.exit(1);
}

mkdirSync(destination, { recursive: true });

const present = new Set(readdirSync(source));
const missing = EXPECTED.filter((name) => !present.has(name));

if (missing.length > 0) {
  console.error(`copy-templates: missing template(s) in ${source}: ${missing.join(", ")}`);
  process.exit(1);
}

for (const name of EXPECTED) {
  copyFileSync(join(source, name), join(destination, name));
}

console.log(`copy-templates: copied ${EXPECTED.length} templates to ${destination}`);
