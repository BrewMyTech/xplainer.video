/**
 * The synthetic `toolchain.json` an install is tested against, and how it reaches a state directory.
 *
 * `install` refuses a machine with no setup marker — ADR 0020 §Ordering, and `preflight.ts`'s
 * `setup-absent` refusal — and `commands/setup.ts` stops being a stub two batches from here (T19).
 * So this story stands one up: a **fixture**, committed under `../__fixtures__/`, conforming to
 * `packages/protocol/schemas/toolchain.json`, pointing at two stand-in files that exist and are
 * never executed.
 *
 * **The committed document's two paths are relative, and that is the one thing about it that is not
 * a real marker.** A real marker's paths are absolute and resolved on the machine it describes —
 * the schema says so, and the preflight's existence check is exactly what catches a marker copied
 * from another machine. A committed file cannot hold an absolute path that exists everywhere, so
 * the document names its neighbours as `./chrome-headless-shell` and `./kokoro-fastapi` and
 * {@link writeToolchainMarker} is what turns it into a real one: it **copies** the two stand-ins
 * into `<state>/acquired/` and rewrites the paths to the copies.
 *
 * Copies rather than references, for two reasons. A test that proves the `setup-paths-gone` refusal
 * has to *remove* one of those files, and it must not be able to remove a file in the repository.
 * And a marker whose paths point outside the state directory would not survive the state directory
 * being moved, which is not what a real one does either.
 *
 * **The recorded `sha256`s are the stand-ins' real digests**, so `toolchain.test.ts` can assert that
 * the fixture still describes the files beside it. A stand-in edited without the marker being
 * updated is a fixture that has rotted, and that is a test failure rather than something to notice
 * later.
 *
 * T19 replaces the fixture with the real marker `xplainer setup` writes. Nothing here ships:
 * `tsconfig.build.json` excludes `src/**\/testing/**`, and `__fixtures__` is one of the directory
 * names `scripts/check-publish-contract.mjs` refuses in a tarball.
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Toolchain } from "@xplainer/protocol";
import { toolchainMarkerPath } from "../preflight.js";

/** `apps/cli/src/install/__fixtures__`, where the marker and its two stand-ins live. */
export const TOOLCHAIN_FIXTURE_DIR = fileURLToPath(new URL("../__fixtures__/", import.meta.url));

/** The committed document itself. */
export const TOOLCHAIN_FIXTURE_FILE = join(TOOLCHAIN_FIXTURE_DIR, "toolchain.json");

/** The subdirectory of a state directory the stand-ins are copied into. */
export const ACQUIRED_DIR = "acquired";

/** The fixture exactly as it is committed, with its two paths still relative. */
export function readToolchainFixture(): Toolchain {
  return JSON.parse(readFileSync(TOOLCHAIN_FIXTURE_FILE, "utf8")) as Toolchain;
}

/** The fixture with its two paths resolved against the directory that holds it. */
export function resolvedToolchainFixture(): Toolchain {
  const fixture = readToolchainFixture();
  return {
    ...fixture,
    chrome: { ...fixture.chrome, path: resolve(TOOLCHAIN_FIXTURE_DIR, fixture.chrome.path) },
    speech: { ...fixture.speech, path: resolve(TOOLCHAIN_FIXTURE_DIR, fixture.speech.path) },
  };
}

/**
 * Materialise the fixture as `<state>/toolchain.json`, with the two stand-ins copied in beside it.
 *
 * `overrides` is shallow and is applied last, which is what lets one case say
 * `{ format_version: … + 7 }` without restating the rest of a document whose whole point is that it
 * is complete.
 */
export function writeToolchainMarker(
  stateDir: string,
  overrides: Partial<Toolchain> = {},
): Toolchain {
  const source = resolvedToolchainFixture();
  const acquired = join(stateDir, ACQUIRED_DIR);
  mkdirSync(acquired, { recursive: true });
  const chromePath = join(acquired, basename(source.chrome.path));
  const speechPath = join(acquired, basename(source.speech.path));
  copyFileSync(source.chrome.path, chromePath);
  copyFileSync(source.speech.path, speechPath);

  const marker: Toolchain = {
    ...source,
    chrome: { ...source.chrome, path: chromePath },
    speech: { ...source.speech, path: speechPath },
    ...overrides,
  };
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(toolchainMarkerPath(stateDir), `${JSON.stringify(marker, null, 2)}\n`);
  return marker;
}
