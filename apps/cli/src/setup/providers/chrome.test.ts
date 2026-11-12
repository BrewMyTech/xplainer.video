/**
 * The browser provider: which artefact, which digest, and what is refused before a byte moves.
 *
 * The transport itself — `HEAD`, `Range` resume, streaming SHA-256, the named refusals — is
 * `download.test.ts`'s subject and is driven against a real loopback server there. What this file
 * is about is the join: that the URL fetched and the digest checked are both **this platform's
 * row's**, and that a platform the manifest has no reviewed row for produces a sentence rather than
 * a download of unreviewed bytes.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
  type BrowserArtefact,
  parseToolchainManifest,
  probeHost,
  speechPlatformKey,
  type ToolchainManifest,
} from "../manifest.js";
import { committedManifestPath } from "../source.js";
import {
  acquireChrome,
  CHROME_DIR_NAME,
  CHROME_PROVIDER,
  chromeRequest,
  findExecutable,
} from "./chrome.js";

const directories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** The reviewed document this repository commits, read the way `setup` reads one. */
function committedManifest(): ToolchainManifest {
  const path = committedManifestPath();
  expect(path, "this checkout has no committed toolchain manifest").not.toBeNull();
  return parseToolchainManifest(readFileSync(path ?? "", "utf8"), path ?? "");
}

/** This machine's row, read straight out of the document rather than through the selector. */
function hostEntry(manifest: ToolchainManifest): {
  key: string;
  url: string;
  sha256: string;
  version: string;
} {
  const key = speechPlatformKey(probeHost());
  const entry = manifest.browser.expected[key];
  expect(entry, `the committed manifest records no browser for ${key}`).toBeDefined();
  expect(entry?.status).toBe("recorded");
  return entry?.status === "recorded"
    ? { key, url: entry.url, sha256: entry.sha256, version: entry.version }
    : { key, url: "", sha256: "", version: "" };
}

/** A manifest whose `browser` block is exactly `expected`, every other block as committed. */
function withBrowsers(
  manifest: ToolchainManifest,
  expected: Record<string, BrowserArtefact>,
): ToolchainManifest {
  return { ...manifest, browser: { expected } };
}

/** An unpacked headless shell already committed at the destination `acquireChrome` will name. */
function pretendAcquired(toolchainDir: string, manifest: ToolchainManifest): string {
  const destination = join(toolchainDir, `${CHROME_DIR_NAME}-${hostEntry(manifest).version}`);
  const inner = join(destination, "chrome-headless-shell-mac-arm64");
  mkdirSync(inner, { recursive: true });
  const executable = join(inner, "chrome-headless-shell");
  writeFileSync(executable, "#!/bin/sh\n");
  chmodSync(executable, 0o755);
  return executable;
}

describe("chromeRequest", () => {
  /**
   * The join: the URL and the digest are both what the manifest records for **this platform's
   * key**, the URL already admitted by the allowlist when the document was parsed. A body that
   * hashes to anything else is `download.ts`'s `checksum-mismatch`, which deletes the partial so a
   * wrong body is never resumed onto — and this is what puts the reviewed value in front of it.
   */
  it("fetches this platform's row and checks that row's digest", () => {
    const manifest = committedManifest();
    const expected = hostEntry(manifest);

    const request = chromeRequest(manifest, probeHost());

    expect(request.url).toBe(expected.url);
    expect(request.url).toMatch(/^https:\/\/storage\.googleapis\.com\/chrome-for-testing-public\//);
    expect(request.sha256).toBe(expected.sha256);
    expect(request.size).toBeGreaterThan(0);
  });
});

describe("acquireChrome", () => {
  /**
   * The digest recorded is the **expected** one, captured at manifest-build time — not a digest of
   * whatever arrived. Recording what arrived cannot reject an incorrect-but-intact archive on a
   * first acquisition; it only detects later drift, which is why the field is an input to the
   * download rather than an output of it.
   */
  it("records the manifest's expected digest and the executable it found", async () => {
    const manifest = committedManifest();
    const expected = hostEntry(manifest);
    const toolchainDir = temporaryDirectory("xplainer-toolchain-");
    const executable = pretendAcquired(toolchainDir, manifest);

    const acquired = await acquireChrome({ manifest, toolchainDir });

    expect(acquired.fetched).toBe(false);
    expect(acquired.component.path).toBe(executable);
    expect(acquired.component.sha256).toBe(expected.sha256);
    expect(acquired.component.version).toBe(expected.version);
    expect(acquired.component.provider).toBe(CHROME_PROVIDER);
    expect(CHROME_PROVIDER).toBe("manifest");
  });

  /**
   * "Where no expected digest exists yet for a platform, `setup` says so rather than silently
   * trusting the bytes." The refusal names the URL, so the manifest can be extended with a reviewed
   * value rather than with a guess.
   */
  it("refuses a machine the manifest records no expected digest for, naming the platform", async () => {
    const manifest = committedManifest();
    const emptied = withBrowsers(manifest, {
      "some-other-machine": {
        status: "recorded",
        version: "1",
        url: "https://storage.googleapis.com/chrome-for-testing-public/1/x/y.zip",
        sha256: "0".repeat(64),
        size: 1,
        member: "y/chrome-headless-shell",
        licence_member: "y/LICENSE.headless_shell",
        publisher: "Google (Chrome for Testing)",
      },
    });

    await expect(
      acquireChrome({ manifest: emptied, toolchainDir: temporaryDirectory("xplainer-toolchain-") }),
    ).rejects.toThrow(/records no expected digest/);
  });

  it("refuses an entry the manifest itself records as unavailable, quoting its reason", async () => {
    const manifest = committedManifest();
    const { key, url } = hostEntry(manifest);
    const unavailable = withBrowsers(manifest, {
      [key]: {
        status: "unavailable",
        url,
        reason: "the publisher's CDN answers 400 for this artefact",
      },
    });

    await expect(
      acquireChrome({
        manifest: unavailable,
        toolchainDir: temporaryDirectory("xplainer-toolchain-"),
      }),
    ).rejects.toThrow(/answers 400 for this artefact/);
  });

  it("refuses a committed tree with no headless shell in it, having recorded nothing", async () => {
    const manifest = committedManifest();
    const { version } = hostEntry(manifest);
    const toolchainDir = temporaryDirectory("xplainer-toolchain-");
    mkdirSync(join(toolchainDir, `${CHROME_DIR_NAME}-${version}`, "empty"), {
      recursive: true,
    });

    await expect(acquireChrome({ manifest, toolchainDir })).rejects.toThrow(
      /holds no headless shell executable/,
    );
  });
});

describe("findExecutable", () => {
  it.skipIf(process.platform === "win32")(
    "finds both publishers' spellings, and only an executable file",
    () => {
      const chromeForTesting = temporaryDirectory("xplainer-cft-");
      const shell = join(chromeForTesting, "chrome-headless-shell-mac-arm64");
      mkdirSync(shell, { recursive: true });
      writeFileSync(join(shell, "chrome-headless-shell"), "");
      chmodSync(join(shell, "chrome-headless-shell"), 0o755);

      const playwright = temporaryDirectory("xplainer-pw-");
      writeFileSync(join(playwright, "headless_shell"), "");
      chmodSync(join(playwright, "headless_shell"), 0o755);

      const notExecutable = temporaryDirectory("xplainer-plain-");
      writeFileSync(join(notExecutable, "chrome-headless-shell"), "");
      chmodSync(join(notExecutable, "chrome-headless-shell"), 0o644);

      expect(findExecutable(chromeForTesting)).toBe(join(shell, "chrome-headless-shell"));
      expect(findExecutable(playwright)).toBe(join(playwright, "headless_shell"));
      expect(findExecutable(notExecutable)).toBeNull();
    },
  );

  it("stops at its depth bound rather than crawling an arbitrary tree", () => {
    const root = temporaryDirectory("xplainer-deep-");
    const deep = join(root, "a", "b", "c", "d", "e");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "headless_shell"), "");
    chmodSync(join(deep, "headless_shell"), 0o755);

    expect(findExecutable(root)).toBeNull();
  });
});
