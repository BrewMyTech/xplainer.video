/**
 * The downloader, against a real HTTP server on loopback.
 *
 * Every case here is the server behaving in a particular way — honouring a `Range`, truncating a
 * body, answering `206` for a range nobody asked for, serving a filter page — so the whole suite
 * runs against `testing/artefact-server.ts` and the process's own `fetch`. There is no double in
 * front of the client: ADR 0005's requirement is about what a user is told when a *network* goes
 * wrong, and a stubbed transport cannot go wrong in any of these ways.
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { sha256Of } from "./archive.js";
import {
  type ArtefactRequest,
  acquireArtefact,
  assertZipArtefact,
  DownloadRefusal,
  downloadArtefact,
  PART_SUFFIX,
  redirectTarget,
  WORK_DIR_NAME,
} from "./download.js";
import {
  ARTEFACT_ROUTES,
  type ArtefactServer,
  startArtefactServer,
} from "./testing/artefact-server.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "toolchain-fixture.zip");
const scratch: string[] = [];
let archive: Buffer;
let digest: string;

beforeAll(() => {
  archive = readFileSync(FIXTURE);
  digest = sha256Of(archive);
});

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scratchDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "xplainer-download-"));
  scratch.push(directory);
  return directory;
}

async function withServer<T>(body: (server: ArtefactServer) => Promise<T>): Promise<T> {
  const server = await startArtefactServer(archive);
  try {
    return await body(server);
  } finally {
    await server.close();
  }
}

function request(server: ArtefactServer, route: string): ArtefactRequest {
  return { url: server.url(route), sha256: digest, size: archive.length };
}

async function refusalOf(promise: Promise<unknown>): Promise<DownloadRefusal> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DownloadRefusal);
    return error as DownloadRefusal;
  }
  throw new Error("the call was expected to refuse and did not");
}

describe("fetching an artefact", () => {
  it("HEADs for the length, then GETs the whole body and verifies the digest", async () => {
    await withServer(async (server) => {
      const partFile = join(scratchDir(), `chrome${PART_SUFFIX}`);

      const outcome = await downloadArtefact({
        request: request(server, ARTEFACT_ROUTES.good),
        partFile,
      });

      expect(outcome).toEqual({
        path: partFile,
        bytes: archive.length,
        sha256: digest,
        transfer: "fresh",
        transferred: archive.length,
      });
      expect(sha256Of(readFileSync(partFile))).toBe(digest);
      expect(server.requests.map((entry) => [entry.method, entry.range])).toEqual([
        ["HEAD", null],
        ["GET", null],
      ]);
    });
  });

  it("resumes from a partial download with a Range request, moving only the tail", async () => {
    await withServer(async (server) => {
      const partFile = join(scratchDir(), `chrome${PART_SUFFIX}`);
      const already = 2000;
      writeFileSync(partFile, archive.subarray(0, already));

      const outcome = await downloadArtefact({
        request: request(server, ARTEFACT_ROUTES.good),
        partFile,
      });

      expect(outcome.transfer).toBe("resumed");
      expect(outcome.transferred).toBe(archive.length - already);
      expect(outcome.sha256).toBe(digest);
      expect(readFileSync(partFile).equals(archive)).toBe(true);
      expect(server.requests.at(-1)?.range).toBe(`bytes=${already}-`);
    });
  });

  it("recovers a truncated download on the next attempt, which is the whole point", async () => {
    await withServer(async (server) => {
      const partFile = join(scratchDir(), `chrome${PART_SUFFIX}`);
      const attempt = () =>
        downloadArtefact({ request: request(server, ARTEFACT_ROUTES.flaky), partFile });

      const refusal = await refusalOf(attempt());
      expect(refusal.reason).toBe("short-body");
      expect(refusal.message).toContain("resumes it");
      const kept = statSync(partFile).size;
      expect(kept).toBe(Math.floor(archive.length / 2));

      const outcome = await attempt();

      expect(outcome.transfer).toBe("resumed");
      expect(outcome.transferred).toBe(archive.length - kept);
      expect(readFileSync(partFile).equals(archive)).toBe(true);
      expect(server.requests.filter((entry) => entry.method === "GET").at(-1)?.range).toBe(
        `bytes=${kept}-`,
      );
    });
  });

  it("takes a completed partial without asking the network for it again", async () => {
    await withServer(async (server) => {
      const partFile = join(scratchDir(), `chrome${PART_SUFFIX}`);
      writeFileSync(partFile, archive);

      const outcome = await downloadArtefact({
        request: request(server, ARTEFACT_ROUTES.good),
        partFile,
      });

      expect(outcome).toMatchObject({ transfer: "resumed", transferred: 0, sha256: digest });
      expect(server.requests.map((entry) => entry.method)).toEqual(["HEAD"]);
    });
  });

  it("discards a partial that is not a prefix of the artefact, by digesting it", async () => {
    await withServer(async (server) => {
      const partFile = join(scratchDir(), `chrome${PART_SUFFIX}`);
      const wrong = Buffer.from(archive);
      wrong.writeUInt8(wrong.readUInt8(10) ^ 0xff, 10);
      writeFileSync(partFile, wrong);

      const outcome = await downloadArtefact({
        request: request(server, ARTEFACT_ROUTES.good),
        partFile,
      });

      expect(outcome.transfer).toBe("fresh");
      expect(readFileSync(partFile).equals(archive)).toBe(true);
    });
  });

  it("downloads from a server that refuses HEAD, using the manifest's own length", async () => {
    await withServer(async (server) => {
      const partFile = join(scratchDir(), `chrome${PART_SUFFIX}`);

      const outcome = await downloadArtefact({
        request: request(server, ARTEFACT_ROUTES.noHead),
        partFile,
      });

      expect(outcome.transfer).toBe("fresh");
      expect(outcome.sha256).toBe(digest);
    });
  });

  it("reports progress against the length it is expecting", async () => {
    await withServer(async (server) => {
      const seen: number[] = [];

      await downloadArtefact({
        request: request(server, ARTEFACT_ROUTES.good),
        partFile: join(scratchDir(), `chrome${PART_SUFFIX}`),
        onProgress: (received, total) => {
          expect(total).toBe(archive.length);
          seen.push(received);
        },
      });

      expect(seen.at(-1)).toBe(archive.length);
    });
  });
});

describe("the four failures ADR 0005 makes the downloader responsible for", () => {
  it("names a short body, and keeps the partial so the next attempt resumes", async () => {
    await withServer(async (server) => {
      const partFile = join(scratchDir(), `chrome${PART_SUFFIX}`);

      const refusal = await refusalOf(
        downloadArtefact({ request: request(server, ARTEFACT_ROUTES.truncated), partFile }),
      );

      expect(refusal.reason).toBe("short-body");
      expect(refusal.exitCode).toBe(3);
      expect(statSync(partFile).size).toBe(Math.floor(archive.length / 2));
    });
  });

  it("names a dropped connection as the same resumable condition", async () => {
    await withServer(async (server) => {
      const partFile = join(scratchDir(), `chrome${PART_SUFFIX}`);

      const refusal = await refusalOf(
        downloadArtefact({ request: request(server, ARTEFACT_ROUTES.dropped), partFile }),
      );

      expect(refusal.reason).toBe("short-body");
      expect(existsSync(partFile)).toBe(true);
    });
  });

  it("names a checksum mismatch, and discards the bytes rather than resuming onto them", async () => {
    await withServer(async (server) => {
      const partFile = join(scratchDir(), `chrome${PART_SUFFIX}`);

      const refusal = await refusalOf(
        downloadArtefact({ request: request(server, ARTEFACT_ROUTES.corrupt), partFile }),
      );

      expect(refusal.reason).toBe("checksum-mismatch");
      expect(refusal.message).toContain(digest);
      expect(refusal.message).toContain("nothing was unpacked");
      expect(existsSync(partFile)).toBe(false);
    });
  });

  it("names a resume the server did not honour, and appends nothing to the partial", async () => {
    await withServer(async (server) => {
      const partFile = join(scratchDir(), `chrome${PART_SUFFIX}`);
      const already = archive.subarray(0, 1500);
      writeFileSync(partFile, already);

      const refusal = await refusalOf(
        downloadArtefact({ request: request(server, ARTEFACT_ROUTES.misresume), partFile }),
      );

      expect(refusal.reason).toBe("resume-not-honoured");
      expect(refusal.message).toContain("bytes 0-");
      expect(readFileSync(partFile).equals(already)).toBe(true);
    });
  });

  it("restarts rather than appending when a 200 answers a Range request", async () => {
    await withServer(async (server) => {
      const partFile = join(scratchDir(), `chrome${PART_SUFFIX}`);
      writeFileSync(partFile, archive.subarray(0, 1500));

      const outcome = await downloadArtefact({
        request: request(server, ARTEFACT_ROUTES.ignoresRange),
        partFile,
      });

      expect(outcome.transfer).toBe("restarted");
      expect(outcome.bytes).toBe(archive.length);
      expect(readFileSync(partFile).equals(archive)).toBe(true);
    });
  });

  it("names a proxy that answers with a page instead of the artefact, and quotes it", async () => {
    await withServer(async (server) => {
      const refusal = await refusalOf(
        downloadArtefact({
          request: request(server, ARTEFACT_ROUTES.blocked),
          partFile: join(scratchDir(), `chrome${PART_SUFFIX}`),
        }),
      );

      expect(refusal.reason).toBe("proxy-interception");
      expect(refusal.message).toContain("Your organisation has blocked this category");
    });
  });

  it("names a proxy that intercepts the HEAD too, where there is no page to quote", async () => {
    await withServer(async (server) => {
      const refusal = await refusalOf(
        downloadArtefact({
          request: request(server, ARTEFACT_ROUTES.blockedHead),
          partFile: join(scratchDir(), `chrome${PART_SUFFIX}`),
        }),
      );

      expect(refusal.reason).toBe("proxy-interception");
      expect(refusal.message).toContain("the response carried no body");
      // It refused at the HEAD, so no GET was ever made.
      expect(server.requests.map((entry) => entry.method)).toEqual(["HEAD"]);
    });
  });

  it("names a proxy that demands credentials", async () => {
    await withServer(async (server) => {
      const refusal = await refusalOf(
        downloadArtefact({
          request: request(server, ARTEFACT_ROUTES.proxyAuth),
          partFile: join(scratchDir(), `chrome${PART_SUFFIX}`),
        }),
      );

      expect(refusal.reason).toBe("proxy-interception");
      expect(refusal.message).toContain("407");
    });
  });

  it("names a TLS connection that never reached the origin", async () => {
    await withServer(async (server) => {
      // The server speaks plain HTTP on that port, so an `https:` request gets a handshake that
      // fails — which is what a middlebox answering on 443 looks like from the client.
      const refusal = await refusalOf(
        downloadArtefact({
          request: {
            url: `${server.tlsOrigin}${ARTEFACT_ROUTES.good}`,
            sha256: digest,
            size: archive.length,
          },
          partFile: join(scratchDir(), `chrome${PART_SUFFIX}`),
        }),
      );

      expect(refusal.reason).toBe("proxy-interception");
      expect(refusal.message).toContain("did not reach the origin");
    });
  });

  it("gives up on a socket that has gone silent, rather than hanging setup", async () => {
    await withServer(async (server) => {
      const refusal = await refusalOf(
        downloadArtefact({
          request: request(server, ARTEFACT_ROUTES.stalls),
          partFile: join(scratchDir(), `chrome${PART_SUFFIX}`),
          idleTimeoutMs: 150,
        }),
      );

      expect(refusal.reason).toBe("short-body");
      expect(refusal.message).toContain("no data for 150 ms");
    });
  });

  it("names an artefact that is not there at all", async () => {
    await withServer(async (server) => {
      const refusal = await refusalOf(
        downloadArtefact({
          request: request(server, ARTEFACT_ROUTES.missing),
          partFile: join(scratchDir(), `chrome${PART_SUFFIX}`),
        }),
      );

      expect(refusal.reason).toBe("not-available");
      expect(refusal.message).toContain("404");
    });
  });

  it("refuses a length the server and the manifest disagree about, before the GET", async () => {
    await withServer(async (server) => {
      const refusal = await refusalOf(
        downloadArtefact({
          request: { ...request(server, ARTEFACT_ROUTES.good), size: archive.length + 1 },
          partFile: join(scratchDir(), `chrome${PART_SUFFIX}`),
        }),
      );

      expect(refusal.reason).toBe("checksum-mismatch");
      expect(refusal.message).toContain("different artefact");
      expect(server.requests.map((entry) => entry.method)).toEqual(["HEAD"]);
    });
  });
});

describe("following a redirect", () => {
  it("follows one to the artefact, which is what the arm64 Chrome build's CDN needs", async () => {
    await withServer(async (server) => {
      const outcome = await downloadArtefact({
        request: request(server, ARTEFACT_ROUTES.redirect),
        partFile: join(scratchDir(), `chrome${PART_SUFFIX}`),
      });

      expect(outcome.sha256).toBe(digest);
      expect(server.requests.map((entry) => entry.path)).toEqual([
        ARTEFACT_ROUTES.redirect,
        ARTEFACT_ROUTES.good,
        ARTEFACT_ROUTES.redirect,
        ARTEFACT_ROUTES.good,
      ]);
    });
  });

  it("stops rather than looping for ever", async () => {
    await withServer(async (server) => {
      const refusal = await refusalOf(
        downloadArtefact({
          request: request(server, ARTEFACT_ROUTES.loop),
          partFile: join(scratchDir(), `chrome${PART_SUFFIX}`),
        }),
      );

      expect(refusal.reason).toBe("too-many-redirects");
      expect(server.requests).toHaveLength(6);
    });
  });

  it("refuses a downgrade off https, where a substitution would be made", () => {
    expect(redirectTarget("https://cdn.xplainer.video/a.zip", "/b.zip")).toBe(
      "https://cdn.xplainer.video/b.zip",
    );
    expect(redirectTarget("https://a.example/a.zip", "https://b.example/b.zip")).toBe(
      "https://b.example/b.zip",
    );
    expect(() => redirectTarget("https://a.example/a.zip", "http://b.example/b.zip")).toThrow(
      /not follow a downgrade/,
    );
  });
});

describe("committing an artefact", () => {
  it("unpacks into staging and commits with one rename, leaving no partial behind", async () => {
    await withServer(async (server) => {
      const root = scratchDir();
      const destination = join(root, "chrome");

      const outcome = await acquireArtefact({
        request: request(server, ARTEFACT_ROUTES.good),
        destination,
      });

      expect(outcome.destination).toBe(destination);
      expect(outcome.extraction).toEqual({ files: 4, directories: 2, symlinks: 1, bytes: 4476 });
      expect(outcome.download.sha256).toBe(digest);
      expect(readFileSync(join(destination, "toolchain-fixture", "ABOUT"), "utf8")).toContain(
        "fixture archive",
      );
      // The work directory keeps nothing: no `.part`, and no staging tree.
      const work = join(root, WORK_DIR_NAME);
      expect(existsSync(join(work, `chrome${PART_SUFFIX}`))).toBe(false);
      expect(readdirNames(work)).toEqual([]);
    });
  });

  it("commits nothing when the archive will not unpack", async () => {
    await withServer(async (server) => {
      const root = scratchDir();
      const destination = join(root, "chrome");
      // A digest that matches bytes which are not a zip: the download succeeds and the extraction
      // is what refuses, which is the ordering ADR 0005 requires — verify, then extract.
      const notAnArchive = await startArtefactServer(Buffer.from("not an archive at all"));
      try {
        const refusal = acquireArtefact({
          request: {
            url: notAnArchive.url(ARTEFACT_ROUTES.good),
            sha256: sha256Of(Buffer.from("not an archive at all")),
            size: "not an archive at all".length,
          },
          destination,
        });

        await expect(refusal).rejects.toThrow(/not a zip archive/);
        expect(existsSync(destination)).toBe(false);
        expect(
          readdirNames(join(root, WORK_DIR_NAME)).filter((name) => name.startsWith(".staging-")),
        ).toEqual([]);
      } finally {
        await notAnArchive.close();
      }
      expect(server.requests).toEqual([]);
    });
  });

  it("refuses to write over a destination that already exists", async () => {
    await withServer(async (server) => {
      const root = scratchDir();
      const destination = join(root, "chrome");
      await acquireArtefact({ request: request(server, ARTEFACT_ROUTES.good), destination });

      const refusal = await refusalOf(
        acquireArtefact({ request: request(server, ARTEFACT_ROUTES.good), destination }),
      );

      expect(refusal.reason).toBe("destination-occupied");
    });
  });

  it("refuses an archive format it does not unpack, before it is fetched", () => {
    expect(() =>
      assertZipArtefact("https://cdn.xplainer.video/toolchain/v1/speech.tar.gz"),
    ).toThrow(/only archive format/);
    // remotion.media's own URLs carry a query string, which is not part of the format.
    expect(() =>
      assertZipArtefact("https://remotion.media/chromium-headless-shell-linux-x64-1.zip?clear"),
    ).not.toThrow();
  });
});

function readdirNames(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory) : [];
}
