/**
 * Which of the three manifest sources answered, and what happens when none of them does.
 *
 * The published address is a real `fetch` in production, so a loopback server stands in for it here
 * — a real HTTP server on `127.0.0.1`, not a substituted `fetch`, because the thing being asserted
 * is that a document arriving over HTTP is parsed by the same validator a file is.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deliveryPosition, type HostProbe, TOOLCHAIN_MANIFEST_URL } from "./manifest.js";
import {
  COMMITTED_MANIFEST_FILE,
  committedManifestPath,
  loadToolchainManifest,
  MANIFEST_SOURCE_ENV,
  ManifestUnreachable,
} from "./source.js";

const directories: string[] = [];
const servers: Server[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  for (const server of servers.splice(0)) {
    await new Promise<void>((done) => {
      server.close(() => {
        done();
      });
    });
  }
});

/** The reviewed document this repository commits, as bytes. */
function committedBytes(): string {
  return readFileSync(committedManifestPath() ?? "", "utf8");
}

/** A loopback origin serving `body` with `status`, standing in for the published address. */
async function serve(status: number, body: string): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body);
  });
  servers.push(server);
  await new Promise<void>((ready) => {
    server.listen(0, "127.0.0.1", ready);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return `http://127.0.0.1:${port}/toolchain/v1/manifest.json`;
}

describe("loadToolchainManifest", () => {
  it("reads the file --manifest names, and says which source answered", async () => {
    const file = join(temporaryDirectory("xplainer-manifest-"), COMMITTED_MANIFEST_FILE);
    writeFileSync(file, committedBytes());

    const loaded = await loadToolchainManifest({ override: file, env: {} });

    expect(loaded.kind).toBe("override");
    expect(loaded.source).toBe(file);
    expect(loaded.manifest.format_version).toBe(1);
  });

  it("reads the same override from the environment", async () => {
    const file = join(temporaryDirectory("xplainer-manifest-"), COMMITTED_MANIFEST_FILE);
    writeFileSync(file, committedBytes());

    const loaded = await loadToolchainManifest({ env: { [MANIFEST_SOURCE_ENV]: file } });

    expect(loaded.kind).toBe("override");
  });

  /**
   * A reviewer who named a candidate manifest and silently got the published one would be reviewing
   * the wrong document, and every digest in the report would be about bytes they never chose.
   */
  it("does not fall through from an override that failed", async () => {
    await expect(
      loadToolchainManifest({ override: join(temporaryDirectory("x-"), "absent.json"), env: {} }),
    ).rejects.toThrow(/ENOENT|no such file/);
  });

  it("reads the published address over HTTP, validated by the same parser a file is", async () => {
    const url = await serve(200, committedBytes());

    const loaded = await loadToolchainManifest({ url, env: {} });

    expect(loaded.kind).toBe("published");
    expect(loaded.source).toBe(url);
  });

  /**
   * A published document that parses as nothing this build reads is a *publisher* failure, and it
   * is reported on the way past rather than swallowed: the run continues on the reviewed copy, and
   * the reason the published one was passed over travels back with the result so the caller can
   * print it. A fall-back that reported nothing would hide a broken CDN for as long as the local
   * copy kept working.
   */
  it("passes over a published document this build cannot read, and says why", async () => {
    const url = await serve(200, JSON.stringify({ format_version: 99 }));

    const loaded = await loadToolchainManifest({ url, env: {} });

    expect(loaded.kind).toBe("committed");
    expect(loaded.attempts).toHaveLength(1);
    expect(loaded.attempts[0]).toContain("format_version");
  });

  it("refuses a document --manifest named that this build cannot read", async () => {
    const url = await serve(200, JSON.stringify({ format_version: 99 }));

    await expect(loadToolchainManifest({ override: url, env: {} })).rejects.toThrow(
      /format_version/,
    );
  });

  /**
   * Nothing is published to `cdn.xplainer.video` in this phase (§2.5), so this is the path a real
   * `setup` takes today: the address answers with nothing usable and the checkout's own reviewed
   * copy is what carries the run.
   */
  it("falls back to the checkout's committed copy when the published address does not answer", async () => {
    const url = await serve(404, "");

    const loaded = await loadToolchainManifest({ url, env: {} });

    expect(loaded.kind).toBe("committed");
    expect(loaded.source).toBe(committedManifestPath());
  });

  /**
   * What a **published** build meets today: the address answers with nothing usable and there is no
   * committed copy beside a `dist/` that ships `.js` and `.d.ts` only. The refusal names both
   * sources and the flag that supplies a third.
   */
  it("names every source it tried when there is nothing to fall back to", async () => {
    const url = await serve(500, "");

    const failure = await loadToolchainManifest({ url, env: {}, committed: null }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ManifestUnreachable);
    const refusal = failure as ManifestUnreachable;
    expect(refusal.exitCode).toBe(3);
    expect(refusal.attempts).toHaveLength(2);
    expect(refusal.message).toContain("HTTP 500");
    expect(refusal.message).toContain(COMMITTED_MANIFEST_FILE);
    expect(refusal.message).toContain("--manifest");
    expect(refusal.message).toContain(MANIFEST_SOURCE_ENV);
  });

  /**
   * The sources it tried are a diagnosis; the delivery position is the reason. A refusal that gave
   * only the first sends a reader to look for a CDN outage that is not happening — nothing has been
   * published to that address, deliberately, and the message carries `manifest.ts`'s account of it.
   */
  it("carries the delivery position, for the machine that is reading it", async () => {
    const url = await serve(500, "");
    const darwin: HostProbe = {
      platform: "darwin",
      arch: "arm64",
      osRelease: null,
      glibc: null,
    };

    const failure = await loadToolchainManifest({
      url,
      env: {},
      committed: null,
      probe: darwin,
    }).catch((error: unknown) => error);

    const refusal = failure as ManifestUnreachable;
    expect(refusal).toBeInstanceOf(ManifestUnreachable);
    expect(refusal.message).toContain(deliveryPosition(darwin));
    expect(refusal.message).toContain("two routes that work on darwin-arm64");
  });

  /**
   * The same run on Windows, which is the platform §2.5 records as having no route at all. Asserted
   * here rather than only on a Windows runner: a message a machine cannot read is a message that
   * machine's users meet unproved.
   */
  it("tells a Windows reader there is no speech route, and names the milestone", async () => {
    const url = await serve(500, "");
    const windows: HostProbe = { platform: "win32", arch: "x64", osRelease: null, glibc: null };

    const failure = await loadToolchainManifest({
      url,
      env: {},
      committed: null,
      probe: windows,
    }).catch((error: unknown) => error);

    const refusal = failure as ManifestUnreachable;
    expect(refusal.message).toContain("Windows has no working speech route at all this phase");
    expect(refusal.message).toContain("The milestone that closes it is phase 4");
    expect(refusal.message).not.toMatch(/routes that work/);
  });
});

describe("the published address", () => {
  it("is the one hostname infra/terraform provisions", () => {
    expect(TOOLCHAIN_MANIFEST_URL).toBe("https://cdn.xplainer.video/toolchain/v1/manifest.json");
  });
});
