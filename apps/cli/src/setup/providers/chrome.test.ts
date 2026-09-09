/**
 * The browser provider: which artefact, which digest, and what is refused before a byte moves.
 *
 * The transport itself — `HEAD`, `Range` resume, streaming SHA-256, the named refusals — is
 * `download.test.ts`'s subject and is driven against a real loopback server there. What this file
 * is about is the join: that the URL fetched is the **pinned Remotion selector's** and the digest
 * checked is the **manifest's expected** one, and that a configuration the manifest has no reviewed
 * entry for produces a sentence rather than a download of unreviewed bytes.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
  chromeDownloadUrl,
  hostChromeSelection,
  parseToolchainManifest,
  probeHost,
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

/** What the pinned Remotion line would download here, and the manifest row that records it. */
function hostEntry(manifest: ToolchainManifest): { key: string; sha256: string } {
  const url = chromeDownloadUrl(hostChromeSelection(probeHost()));
  const found = Object.entries(manifest.chrome.expected).find(([, entry]) => entry.url === url);
  expect(found, `the committed manifest records no entry for ${url}`).toBeDefined();
  const [key, entry] = found ?? ["", { status: "unavailable" as const, reason: "" }];
  expect(entry.status).toBe("recorded");
  return { key, sha256: entry.status === "recorded" ? entry.sha256 : "" };
}

/** An unpacked headless shell already committed at the destination `acquireChrome` will name. */
function pretendAcquired(toolchainDir: string, manifest: ToolchainManifest): string {
  const destination = join(toolchainDir, `${CHROME_DIR_NAME}-${manifest.chrome.version}`);
  const inner = join(destination, "chrome-headless-shell-mac-arm64");
  mkdirSync(inner, { recursive: true });
  const executable = join(inner, "chrome-headless-shell");
  writeFileSync(executable, "#!/bin/sh\n");
  chmodSync(executable, 0o755);
  return executable;
}

describe("chromeRequest", () => {
  /**
   * The join, asserted as two independent halves: the URL is what the **pinned Remotion selector**
   * resolves for this machine, and the digest is what the **manifest** records for that URL. A
   * body that hashes to anything else is `download.ts`'s `checksum-mismatch`, which deletes the
   * partial so a wrong body is never resumed onto — and this is what puts the reviewed value in
   * front of it.
   */
  it("fetches the selector's URL and checks the manifest's digest for it", () => {
    const manifest = committedManifest();
    const probe = probeHost();
    const expected = hostEntry(manifest);

    const request = chromeRequest(manifest, probe);

    expect(request.url).toBe(chromeDownloadUrl(hostChromeSelection(probe)));
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
    expect(acquired.component.version).toBe(manifest.chrome.version);
    expect(acquired.component.provider).toBe(CHROME_PROVIDER);
  });

  /**
   * "Where no expected digest exists yet for a platform, `setup` says so rather than silently
   * trusting the bytes." The refusal names the URL, so the manifest can be extended with a reviewed
   * value rather than with a guess.
   */
  it("refuses a machine the manifest records no expected digest for, naming the URL", async () => {
    const manifest = committedManifest();
    const emptied: ToolchainManifest = {
      ...manifest,
      chrome: {
        ...manifest.chrome,
        expected: {
          "some-other-machine": {
            status: "recorded",
            url: "https://storage.googleapis.com/chrome-for-testing-public/1/x/y.zip",
            sha256: "0".repeat(64),
            size: 1,
          },
        },
      },
    };

    await expect(
      acquireChrome({ manifest: emptied, toolchainDir: temporaryDirectory("xplainer-toolchain-") }),
    ).rejects.toThrow(/records no expected digest/);
  });

  it("refuses an entry the manifest itself records as unavailable, quoting its reason", async () => {
    const manifest = committedManifest();
    const url = chromeDownloadUrl(hostChromeSelection(probeHost()));
    const unavailable: ToolchainManifest = {
      ...manifest,
      chrome: {
        ...manifest.chrome,
        expected: {
          "this-machine": {
            status: "unavailable",
            url,
            reason: "the publisher's CDN answers 400 for this artefact",
          },
        },
      },
    };

    await expect(
      acquireChrome({
        manifest: unavailable,
        toolchainDir: temporaryDirectory("xplainer-toolchain-"),
      }),
    ).rejects.toThrow(/answers 400 for this artefact/);
  });

  it("refuses a committed tree with no headless shell in it, having recorded nothing", async () => {
    const manifest = committedManifest();
    hostEntry(manifest);
    const toolchainDir = temporaryDirectory("xplainer-toolchain-");
    mkdirSync(join(toolchainDir, `${CHROME_DIR_NAME}-${manifest.chrome.version}`, "empty"), {
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
