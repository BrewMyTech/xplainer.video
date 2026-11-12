/**
 * A real headless shell for the suites that render, acquired the way the product acquires one.
 *
 * `XPLAINER_TEST_CHROME`, when set, names one directly — a developer who already has a headless
 * shell from `xplainer setup` points at it and downloads nothing. Otherwise the shell comes through
 * the product's own `acquireChrome()` and the **committed** manifest, so the bytes a test renders
 * with were admitted on the same reviewed digest a user's are, into
 * `<repo>/node_modules/.cache/xplainer-test-toolchain/` — the one directory CI caches.
 *
 * **A warm cache is re-verified, not trusted**, and by the product rather than by this file:
 * `acquireChrome()` commits the tree under a directory named for the archive's digest, with a record
 * of the executable and the licence inside it, and re-hashes both on every later run. A tree that
 * no longer verifies is refused there as `cache-unverified`, which for a test cache means "refill
 * it", so it is removed and acquired again. A manifest that has moved to another build names
 * another directory. The layout before 2026-11-12 — a directory named for the version alone, and
 * a `.verified.json` this file kept beside it — is never reused, so it is removed rather than left
 * in the directory CI caches.
 *
 * Several suites ask at once on a cold cache, so the acquisition is serialised through a lock file.
 *
 * `tsconfig.build.json` excludes `src/**\/testing/**`; none of this ships.
 */

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { hashFile } from "../../runtime/manifest.js";
import { parseToolchainManifest, probeHost, selectBrowserArtefact } from "../../setup/manifest.js";
import {
  type AcquiredChrome,
  acquireChrome,
  CHROME_DIR_NAME,
  ChromeRefusal,
  chromeDestination,
} from "../../setup/providers/chrome.js";
import { committedManifestPath } from "../../setup/source.js";
import { isExecutableFile } from "../encode.js";

/** The variable naming a headless shell to use instead of acquiring one. */
export const TEST_CHROME_ENV = "XPLAINER_TEST_CHROME";

/** `<repo>/node_modules/.cache/xplainer-test-toolchain`, from this file's own location. */
export const TEST_TOOLCHAIN_CACHE: string = fileURLToPath(
  new URL("../../../../../node_modules/.cache/xplainer-test-toolchain/", import.meta.url),
);

/** How long a lock may sit before it is taken to belong to a run that died holding it. */
const STALE_LOCK_MS = 15 * 60_000;

/** A browser for a test, in the shape `toolchain.json` records one. */
export type TestChrome = { path: string; sha256: string; version: string };

let memo: Promise<TestChrome> | null = null;

/** The headless shell the rendering suites use. Resolved once per test file. */
export function testChrome(): Promise<TestChrome> {
  memo ??= resolveTestChrome();
  return memo;
}

async function resolveTestChrome(): Promise<TestChrome> {
  const named = process.env[TEST_CHROME_ENV]?.trim();
  if (named !== undefined && named !== "") {
    if (!isExecutableFile(named)) {
      throw new Error(`${TEST_CHROME_ENV} names ${named}, which is not an executable file.`);
    }
    return { path: named, sha256: hashFile(named), version: "unrecorded" };
  }
  return withLock(join(TEST_TOOLCHAIN_CACHE, ".lock"), acquireVerified);
}

async function acquireVerified(): Promise<TestChrome> {
  const manifestPath = committedManifestPath();
  if (manifestPath === null) {
    throw new Error(
      "this checkout has no committed toolchain manifest to acquire a test browser with.",
    );
  }
  const manifest = parseToolchainManifest(readFileSync(manifestPath, "utf8"), manifestPath);
  const selection = selectBrowserArtefact(manifest, probeHost());
  const legacy = join(TEST_TOOLCHAIN_CACHE, `${CHROME_DIR_NAME}-${selection.version}`);
  rmSync(legacy, { recursive: true, force: true });
  rmSync(`${legacy}.verified.json`, { force: true });

  let acquired: AcquiredChrome;
  try {
    acquired = await acquireChrome({ manifest, toolchainDir: TEST_TOOLCHAIN_CACHE });
  } catch (error) {
    if (!(error instanceof ChromeRefusal) || error.reason !== "cache-unverified") {
      throw error;
    }
    rmSync(chromeDestination(TEST_TOOLCHAIN_CACHE, selection), { recursive: true, force: true });
    acquired = await acquireChrome({ manifest, toolchainDir: TEST_TOOLCHAIN_CACHE });
  }
  return { path: acquired.component.path, sha256: selection.sha256, version: selection.version };
}

async function withLock<T>(lock: string, work: () => Promise<T>): Promise<T> {
  mkdirSync(TEST_TOOLCHAIN_CACHE, { recursive: true });
  let descriptor: number | null = null;
  while (descriptor === null) {
    try {
      descriptor = openSync(lock, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
          rmSync(lock, { force: true });
        }
      } catch {
        // Released between the open and the stat: the next open decides.
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });
    }
  }
  try {
    return await work();
  } finally {
    closeSync(descriptor);
    rmSync(lock, { force: true });
  }
}
