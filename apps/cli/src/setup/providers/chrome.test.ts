/**
 * The browser provider: which artefact, which digest, what is refused before a byte moves, and what
 * a re-run is allowed to reuse.
 *
 * The transport itself — `HEAD`, `Range` resume, streaming SHA-256, the named refusals — is
 * `download.test.ts`'s subject and is driven against a real loopback server there. What this file
 * is about is the join: that the URL fetched and the digest checked are both **this platform's
 * row's**, that a platform the manifest has no reviewed row for produces a sentence rather than a
 * download of unreviewed bytes, and that a tree already on disk is used only once its own record
 * says it is the archive that digest admitted. The acquisitions run against the same loopback
 * server, with a zip built here in the Chrome for Testing layout.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import process from "node:process";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readAcquired } from "../acquired.js";
import { sha256Of } from "../archive.js";
import {
  type BrowserArtefact,
  parseToolchainManifest,
  probeHost,
  type RecordedBrowserArtefact,
  selectBrowserArtefact,
  speechPlatformKey,
  type ToolchainManifest,
} from "../manifest.js";
import { committedManifestPath } from "../source.js";
import {
  ARTEFACT_ROUTES,
  type ArtefactServer,
  startArtefactServer,
} from "../testing/artefact-server.js";
import { buildZip } from "../testing/zip-builder.js";
import {
  acquireChrome,
  CHROME_DIR_NAME,
  CHROME_PROVIDER,
  ChromeRefusal,
  chromeDestination,
  chromeRequest,
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

/** Every entry under `directory`, sorted, so "nothing was committed" is one comparison. */
function listing(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory).sort() : [];
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

describe("acquireChrome, refusing before anything is fetched", () => {
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
});

describe("acquireChrome, over the loopback server", () => {
  const ROOT = "chrome-headless-shell-test";
  const SHELL = `${ROOT}/chrome-headless-shell`;
  const LICENCE = `${ROOT}/LICENSE.headless_shell`;
  let server: ArtefactServer;
  let archive: Buffer;

  beforeAll(async () => {
    archive = buildZip([
      { name: `${ROOT}/`, contents: "", directory: true },
      { name: SHELL, contents: "#!/bin/sh\necho 'a stand-in headless shell'\n", mode: 0o755 },
      { name: LICENCE, contents: "the licence the shell is distributed under\n" },
      { name: `${ROOT}/ABOUT`, contents: "a Chrome for Testing layout, built for this suite\n" },
    ]);
    server = await startArtefactServer(archive);
  });

  afterAll(async () => {
    await server?.close();
  });

  /** A row for the archive above, at this machine's key, every other platform as committed. */
  function manifestWith(overrides: Partial<RecordedBrowserArtefact> = {}): ToolchainManifest {
    const manifest = committedManifest();
    const row: RecordedBrowserArtefact = {
      status: "recorded",
      version: "157.0.8103.50",
      url: server.url(ARTEFACT_ROUTES.good),
      sha256: sha256Of(archive),
      size: archive.length,
      member: SHELL,
      licence_member: LICENCE,
      publisher: "Google (Chrome for Testing)",
      ...overrides,
    };
    return withBrowsers(manifest, {
      ...manifest.browser.expected,
      [speechPlatformKey(probeHost())]: row,
    });
  }

  /**
   * The digest recorded is the **expected** one, captured at manifest-build time — not a digest of
   * whatever arrived — and the executable recorded is the row's `member`, found by name rather
   * than by searching the tree. The directory carries the archive's digest, as ffmpeg's does, so a
   * re-published archive at an unchanged version cannot be served out of the tree the last one
   * left; and the tree carries its own record of both files it was admitted with.
   */
  it("commits the row's member under a digest-named directory, with its record", async () => {
    const manifest = manifestWith();
    const toolchainDir = temporaryDirectory("xplainer-toolchain-");

    const acquired = await acquireChrome({ manifest, toolchainDir });

    const selection = selectBrowserArtefact(manifest, probeHost());
    expect(acquired.fetched).toBe(true);
    expect(acquired.destination).toBe(chromeDestination(toolchainDir, selection));
    expect(basename(acquired.destination)).toBe(
      `${CHROME_DIR_NAME}-157.0.8103.50-${sha256Of(archive).slice(0, 12)}`,
    );
    expect(acquired.component).toEqual({
      version: "157.0.8103.50",
      path: join(acquired.destination, ROOT, "chrome-headless-shell"),
      sha256: sha256Of(archive),
      provider: CHROME_PROVIDER,
    });
    expect(CHROME_PROVIDER).toBe("manifest");
    const record = readAcquired(acquired.destination);
    expect(record?.sha256).toBe(sha256Of(archive));
    expect(record?.files.map((file) => file.path)).toEqual([SHELL, LICENCE]);
    expect(listing(join(toolchainDir, ".setup"))).toEqual([]);
  });

  /**
   * "A warm cache is re-verified, never trusted": a second run fetches nothing and re-hashes what
   * the first one committed, and a shell that has been changed since is refused by name.
   */
  it("reuses a committed tree only by verifying it, and refuses one whose shell has changed", async () => {
    const manifest = manifestWith();
    const toolchainDir = temporaryDirectory("xplainer-toolchain-");
    const first = await acquireChrome({ manifest, toolchainDir });
    const before = server.requests.length;
    const lines: string[] = [];

    const second = await acquireChrome({ manifest, toolchainDir, log: (line) => lines.push(line) });

    expect(second.fetched).toBe(false);
    expect(server.requests.length).toBe(before);
    expect(second.component).toEqual(first.component);
    expect(lines).toContain(`chrome: already acquired and verified at ${first.destination}`);

    writeFileSync(first.component.path, "#!/bin/sh\n");
    const changed = acquireChrome({ manifest, toolchainDir });
    await expect(changed).rejects.toBeInstanceOf(ChromeRefusal);
    await expect(changed).rejects.toMatchObject({ reason: "cache-unverified" });
    await expect(changed).rejects.toThrow(/has been changed since it was acquired/);
  });

  /**
   * The defect this replaces: a `#!/bin/sh` stub at the directory name an earlier release used was
   * recorded at the reviewed digest without a byte of it checked. A tree from that layout is simply
   * not reused, and a tree at today's name with no record of its own is refused rather than trusted.
   */
  it("never reuses a tree it did not commit: an older layout, or one with no record", async () => {
    const manifest = manifestWith();
    const toolchainDir = temporaryDirectory("xplainer-toolchain-");
    const stub = join(
      toolchainDir,
      `${CHROME_DIR_NAME}-157.0.8103.50`,
      ROOT,
      "chrome-headless-shell",
    );
    mkdirSync(join(stub, ".."), { recursive: true });
    writeFileSync(stub, "#!/bin/sh\n");
    chmodSync(stub, 0o755);

    const acquired = await acquireChrome({ manifest, toolchainDir });

    expect(acquired.fetched).toBe(true);
    expect(acquired.component.path).not.toBe(stub);

    const unrecorded = temporaryDirectory("xplainer-toolchain-");
    const destination = chromeDestination(unrecorded, selectBrowserArtefact(manifest, probeHost()));
    mkdirSync(join(destination, ROOT), { recursive: true });
    writeFileSync(join(destination, SHELL), "#!/bin/sh\n");
    chmodSync(join(destination, SHELL), 0o755);
    const refusal = acquireChrome({ manifest, toolchainDir: unrecorded });
    await expect(refusal).rejects.toMatchObject({ reason: "cache-unverified" });
    await expect(refusal).rejects.toThrow(/\.acquired\.json does not exist/);
  });

  /**
   * ADR 0031's note of 2026-11-12, D4: one publisher, one version and "an in-archive licence
   * everywhere". The row names both files, and an archive that matched its digest and lacks either
   * is refused, with the verified archive and the staging tree both gone.
   */
  it("refuses an archive that lacks the row's member or its licence, committing nothing", async () => {
    const cases: [Partial<RecordedBrowserArtefact>, string, RegExp][] = [
      [{ member: `${ROOT}/missing-shell` }, "member-missing", /does not contain .*missing-shell/],
      [{ licence_member: `${ROOT}/LICENSE.missing` }, "licence-missing", /LICENSE\.missing/],
    ];
    for (const [overrides, reason, message] of cases) {
      const toolchainDir = temporaryDirectory("xplainer-toolchain-");

      const refusal = acquireChrome({ manifest: manifestWith(overrides), toolchainDir });

      await expect(refusal).rejects.toMatchObject({ reason });
      await expect(refusal).rejects.toThrow(message);
      expect(listing(toolchainDir)).toEqual([".setup"]);
      expect(listing(join(toolchainDir, ".setup"))).toEqual([]);
    }
  });

  it.skipIf(process.platform === "win32")(
    "refuses a member that is not an executable file, committing nothing",
    async () => {
      const toolchainDir = temporaryDirectory("xplainer-toolchain-");

      const refusal = acquireChrome({
        manifest: manifestWith({ member: `${ROOT}/ABOUT` }),
        toolchainDir,
      });

      await expect(refusal).rejects.toMatchObject({ reason: "not-executable" });
      expect(listing(toolchainDir)).toEqual([".setup"]);
    },
  );
});
