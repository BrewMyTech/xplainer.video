/**
 * A real headless shell for the suites that render, acquired the way the product acquires one.
 *
 * `XPLAINER_TEST_CHROME`, when set, names one directly — a developer who already has a headless
 * shell from `xplainer setup` points at it and downloads nothing. Otherwise the shell comes through
 * the product's own `acquireChrome()` and the **committed** manifest, so the bytes a test renders
 * with were admitted on the same reviewed digest a user's are, into
 * `<repo>/node_modules/.cache/xplainer-test-toolchain/` — the one directory CI caches.
 *
 * **A warm cache is re-verified, not trusted.** The archive's digest is checked by `download.ts`
 * during the acquisition and the archive itself is deleted after it is unpacked, so what a cold run
 * records beside the tree is the digest of the executable it unpacked, together with the archive
 * digest it was admitted on. A warm run re-hashes the executable against that record and
 * re-acquires on any disagreement — including a manifest that has since moved to another build.
 *
 * Several suites ask at once on a cold cache, so the acquisition is serialised through a lock file.
 *
 * `tsconfig.build.json` excludes `src/**\/testing/**`; none of this ships.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { hashFile } from "../../runtime/manifest.js";
import { parseToolchainManifest, probeHost, selectChromeArtefact } from "../../setup/manifest.js";
import { acquireChrome, CHROME_DIR_NAME } from "../../setup/providers/chrome.js";
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

/** What a verified acquisition left beside the tree. */
type Verified = { archiveSha256: string; executable: string; executableSha256: string };

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
  const archiveSha256 = selectChromeArtefact(manifest, probeHost()).sha256;
  const destination = join(TEST_TOOLCHAIN_CACHE, `${CHROME_DIR_NAME}-${manifest.chrome.version}`);
  const record = `${destination}.verified.json`;

  if (existsSync(destination) && !stillVerified(record, archiveSha256)) {
    rmSync(destination, { recursive: true, force: true });
    rmSync(record, { force: true });
  }
  const acquired = await acquireChrome({ manifest, toolchainDir: TEST_TOOLCHAIN_CACHE });
  if (acquired.fetched || !existsSync(record)) {
    const verified: Verified = {
      archiveSha256,
      executable: acquired.component.path,
      executableSha256: hashFile(acquired.component.path),
    };
    writeFileSync(record, `${JSON.stringify(verified, null, 2)}\n`);
  }
  return { path: acquired.component.path, sha256: archiveSha256, version: manifest.chrome.version };
}

/** Whether the tree on disk is the one a verified acquisition of `archiveSha256` produced. */
function stillVerified(record: string, archiveSha256: string): boolean {
  if (!existsSync(record)) {
    return false;
  }
  try {
    const verified = JSON.parse(readFileSync(record, "utf8")) as Partial<Verified>;
    return (
      verified.archiveSha256 === archiveSha256 &&
      typeof verified.executable === "string" &&
      existsSync(verified.executable) &&
      hashFile(verified.executable) === verified.executableSha256
    );
  } catch {
    return false;
  }
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
