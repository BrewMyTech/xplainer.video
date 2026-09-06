#!/usr/bin/env node
/**
 * Put the end-user licence inside the tarball, and prove the manifest agrees
 * with it.
 *
 * Run from a publishable member's package root as its `prepack` script.
 *
 * The problem this solves is concrete. `LICENSE` and `NOTICE` live at the repository
 * root and the repository is private, so a user who runs `npm i @xplainer/cli`
 * receives a manifest that REFERENCES a licence and no licence text — and a
 * reference to a file that does not ship is worse than no reference at all,
 * because the reader cannot find the terms they are supposed to be accepting.
 * npm auto-includes a root `LICENSE*` file from the package directory, so the
 * fix is to have one there.
 *
 * Each package keeps a committed copy so the file is present whether or not a
 * lifecycle script ran; this script re-copies it from the root at pack time so
 * six copies of a legal document cannot drift apart into six different licences.
 *
 * It also checks `license` in the manifest. SPDX has no identifier for a custom
 * licence, and npm's documented spelling for one carried in the package is
 * `SEE LICENSE IN <filename>`. `UNLICENSED` — the value every one of these
 * packages used to carry — means the opposite of what is intended here: it
 * grants the user no right to run the software at all.
 *
 * Exit codes:
 *   0  the copy is in place and the manifest declares it
 *   1  the root licence is missing, or the manifest declares something else
 */

import { copyFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/** The licence file, and the `license` value that must point at it. */
// Apache-2.0 requires the NOTICE file to travel with the work (section 4(d)),
// so both files are synced and both must be listed in "files".
const LICENCE_FILES = ["LICENSE", "NOTICE"];
const EXPECTED_LICENSE_FIELD = "Apache-2.0";

/** Walk up from `start` to the directory holding `pnpm-workspace.yaml`. */
function findWorkspaceRoot(start) {
  let directory = start;
  for (;;) {
    if (existsSync(path.join(directory, "pnpm-workspace.yaml"))) {
      return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

const packageRoot = process.cwd();
const workspaceRoot = findWorkspaceRoot(packageRoot);

if (!workspaceRoot) {
  console.error(`sync-license: no pnpm-workspace.yaml above ${packageRoot}`);
  process.exit(1);
}

for (const LICENCE_FILE of LICENCE_FILES) {
  const source = path.join(workspaceRoot, LICENCE_FILE);
  if (!existsSync(source)) {
    console.error(`sync-license: ${source} is missing`);
    process.exit(1);
  }

  const manifestPath = path.join(packageRoot, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  if (manifest.private === true) {
    console.error(
      `sync-license: ${manifest.name} is private and is not published; remove its prepack script`,
    );
    process.exit(1);
  }

  if (manifest.license !== EXPECTED_LICENSE_FIELD) {
    console.error(
      `sync-license: ${manifest.name} declares license ${JSON.stringify(manifest.license)}, expected ${JSON.stringify(EXPECTED_LICENSE_FIELD)}`,
    );
    process.exit(1);
  }

  if (!(manifest.files ?? []).includes(LICENCE_FILE)) {
    console.error(
      `sync-license: ${manifest.name} does not list ${LICENCE_FILE} in "files", so the text would not ship`,
    );
    process.exit(1);
  }

  const destination = path.join(packageRoot, LICENCE_FILE);
  const before = existsSync(destination) ? readFileSync(destination) : undefined;
  copyFileSync(source, destination);

  const drifted = before !== undefined && !before.equals(readFileSync(destination));
  if (drifted) {
    console.warn(
      `sync-license: ${manifest.name}'s committed ${LICENCE_FILE} had drifted from the root copy and was refreshed — commit the result`,
    );
  }

  console.log(`sync-license: ${manifest.name} ships ${LICENCE_FILE} (${EXPECTED_LICENSE_FIELD})`);
}
