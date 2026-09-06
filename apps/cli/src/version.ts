/**
 * The version the binary reports and the server advertises.
 *
 * AC-14a requires `xplainer --version` to print the version in
 * `apps/cli/package.json`, so the number is read from that file at startup
 * rather than restated in a constant that a release would have to remember to
 * bump. The path is resolved relative to this module, and both the source tree
 * (`src/version.ts`) and the build output (`dist/version.js`) sit exactly one
 * directory below the package root, so the same expression is correct under
 * Vitest and under `node dist/bin.js`.
 */

import { readFileSync } from "node:fs";

/** The subset of `package.json` this module depends on. */
type PackageManifest = {
  version?: unknown;
};

function readPackageVersion(): string {
  const manifestUrl = new URL("../package.json", import.meta.url);
  const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as PackageManifest;
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error(
      `@xplainer/cli cannot report a version: ${manifestUrl.pathname} has no "version" string.`,
    );
  }
  return manifest.version;
}

/** The version from `apps/cli/package.json`. */
export const CLI_VERSION: string = readPackageVersion();
