/**
 * The `bundle` route, and the warm-cache defect it used to carry.
 *
 * Until 2026-09-10 this provider skipped the download **and the verification** whenever its
 * destination directory already existed, and then recorded `sha256: entry.sha256` — the digest the
 * manifest had merely told it — for a tree nothing on this machine had ever checked. The first case
 * below is that defect, written the way it actually bites: a manifest claiming a digest for a
 * directory that is already there.
 *
 * Nothing is published to the real delivery hostname in this phase, so every case here serves the
 * archive from `setup/testing/artefact-server.ts`. The host constraint that keeps a *published*
 * bundle on `cdn.xplainer.video` lives in `parseToolchainManifest`, and this provider is handed an
 * already-parsed manifest — so a loopback URL here is exercising the acquisition and not evading a
 * check that belongs to the document.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { ACQUIRED_FILE, readAcquired } from "../acquired.js";
import { sha256Of } from "../archive.js";
import type { HostProbe, ToolchainManifest } from "../manifest.js";
import {
  ARTEFACT_ROUTES,
  type ArtefactServer,
  startArtefactServer,
} from "../testing/artefact-server.js";
import { buildZip } from "../testing/zip-builder.js";
import {
  acquireSpeechBundle,
  BUNDLE_DIGEST_IN_NAME,
  BUNDLE_DIR_NAME,
  bundleDestination,
  SpeechBundleRefusal,
} from "./speech-bundle.js";

const BUNDLE_VERSION = "0.4.2";

/** A bundle shaped like the ones phase 4 will publish: an executable and a file beside it. */
const BUNDLE = buildZip([
  { name: "kokoro-fastapi", contents: "#!/bin/sh\necho speech\n", mode: 0o755 },
  { name: "README", contents: "the speech bundle\n" },
]);

const scratch: string[] = [];
const servers: ArtefactServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scratchDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "xplainer-bundle-"));
  scratch.push(directory);
  return directory;
}

async function serve(body: Buffer): Promise<ArtefactServer> {
  const server = await startArtefactServer(body);
  servers.push(server);
  return server;
}

const probe: HostProbe = {
  platform: process.platform,
  arch: process.arch,
  osRelease: null,
  glibc: null,
};

const platformKey = `${probe.platform}-${probe.arch}`;

function manifest(url: string, sha256: string, size: number): ToolchainManifest {
  return {
    format_version: 1,
    chrome: { remotion: "4.0.495", version: "149.0.7790.0", expected: {} },
    speech: {
      [platformKey]: { status: "recorded", version: BUNDLE_VERSION, url, sha256, size },
    },
  };
}

describe("the warm-cache defect", () => {
  it("refuses a directory that is already there and carries no record of what it is", async () => {
    const toolchainDir = scratchDir();
    const server = await serve(BUNDLE);
    const digest = sha256Of(BUNDLE);
    const document = manifest(server.url(ARTEFACT_ROUTES.good), digest, BUNDLE.length);
    // Exactly what the defect needed: something already under the name this acquisition commits to.
    const destination = bundleDestination(toolchainDir, BUNDLE_VERSION, digest);
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, "kokoro-fastapi"), "not the reviewed bundle\n");

    const refusal = acquireSpeechBundle({ manifest: document, toolchainDir, probe });
    await expect(refusal).rejects.toThrow(SpeechBundleRefusal);
    await expect(refusal).rejects.toThrow(/does not exist/);
    // Nothing was fetched, and — the point — no digest was recorded for a tree nothing checked.
    expect(server.requests).toHaveLength(0);
  });

  it("names the destination after the digest, so a re-published artefact is not served from cache", async () => {
    const toolchainDir = scratchDir();
    const server = await serve(BUNDLE);
    const digest = sha256Of(BUNDLE);
    const document = manifest(server.url(ARTEFACT_ROUTES.good), digest, BUNDLE.length);

    const acquired = await acquireSpeechBundle({ manifest: document, toolchainDir, probe });

    expect(acquired.destination).toBe(
      join(
        toolchainDir,
        `${BUNDLE_DIR_NAME}-${BUNDLE_VERSION}-${digest.slice(0, BUNDLE_DIGEST_IN_NAME)}`,
      ),
    );
    // The same version with a different digest is a different directory, so the cache the first
    // acquisition left cannot answer for it — which is the half of the defect that outlived a
    // republish.
    const other = bundleDestination(toolchainDir, BUNDLE_VERSION, "f".repeat(64));
    expect(other).not.toBe(acquired.destination);
    expect(existsSync(other)).toBe(false);
  });

  it("commits a record inside the tree, carrying the digest it was admitted on", async () => {
    const toolchainDir = scratchDir();
    const server = await serve(BUNDLE);
    const digest = sha256Of(BUNDLE);
    const document = manifest(server.url(ARTEFACT_ROUTES.good), digest, BUNDLE.length);

    const acquired = await acquireSpeechBundle({ manifest: document, toolchainDir, probe });
    const record = readAcquired(acquired.destination);

    expect(acquired.fetched).toBe(true);
    expect(record?.sha256).toBe(digest);
    expect(record?.size).toBe(BUNDLE.length);
    expect(record?.files.map((file) => file.path)).toEqual(["kokoro-fastapi"]);
    expect(acquired.component.sha256).toBe(digest);
    expect(acquired.component.path).toBe(join(acquired.destination, "kokoro-fastapi"));
    expect(acquired.component.files?.[0]?.sha256).toBe(
      sha256Of(readFileSync(join(acquired.destination, "kokoro-fastapi"))),
    );
  });

  it("re-verifies a warm cache instead of trusting it, and fetches nothing", async () => {
    const toolchainDir = scratchDir();
    const server = await serve(BUNDLE);
    const digest = sha256Of(BUNDLE);
    const document = manifest(server.url(ARTEFACT_ROUTES.good), digest, BUNDLE.length);
    const first = await acquireSpeechBundle({ manifest: document, toolchainDir, probe });
    const before = server.requests.length;

    const second = await acquireSpeechBundle({ manifest: document, toolchainDir, probe });

    expect(second.fetched).toBe(false);
    expect(second.destination).toBe(first.destination);
    expect(second.component).toEqual(first.component);
    expect(server.requests.length).toBe(before);
  });

  it("refuses a warm cache whose executable has changed since it was acquired", async () => {
    const toolchainDir = scratchDir();
    const server = await serve(BUNDLE);
    const digest = sha256Of(BUNDLE);
    const document = manifest(server.url(ARTEFACT_ROUTES.good), digest, BUNDLE.length);
    const acquired = await acquireSpeechBundle({ manifest: document, toolchainDir, probe });
    writeFileSync(join(acquired.destination, "kokoro-fastapi"), "#!/bin/sh\necho something else\n");

    await expect(acquireSpeechBundle({ manifest: document, toolchainDir, probe })).rejects.toThrow(
      /changed since it was acquired/,
    );
  });

  it("refuses a warm cache whose record names a different artefact", async () => {
    const toolchainDir = scratchDir();
    const server = await serve(BUNDLE);
    const digest = sha256Of(BUNDLE);
    const document = manifest(server.url(ARTEFACT_ROUTES.good), digest, BUNDLE.length);
    const acquired = await acquireSpeechBundle({ manifest: document, toolchainDir, probe });
    const before = readAcquired(acquired.destination);
    writeFileSync(
      join(acquired.destination, ACQUIRED_FILE),
      JSON.stringify({ ...before, sha256: "0".repeat(64) }),
    );

    await expect(acquireSpeechBundle({ manifest: document, toolchainDir, probe })).rejects.toThrow(
      /Same name, different artefact/,
    );
  });
});
