/**
 * The tar reader, against two real tarballs first and hostile ones after.
 *
 * `fixtures/npm-package-fixture.tgz` was written by `npm pack` — that is, by node-tar, which is the
 * writer whose output this reader meets for every npm package `setup` fetches. It carries the shape
 * that matters there: a single `package/` root, a `dist/` of JavaScript, a `script/install.js` that
 * must never be extracted, and **three** `bin/napi-v6` platform subtrees, so the selection this
 * reader exists for can be proved rather than asserted.
 *
 * `fixtures/ffmpeg-build-fixture.tar.xz` stands in for a BtbN FFmpeg build, and is the subset of xz
 * those builds use: one stream, `FORMAT_XZ`, `CHECK_CRC64`, LZMA2, around a GNU-magic tar with a
 * single root holding `bin/`, `LICENSE.txt` and `doc/` in BtbN's order. It was generated once, with
 * Python 3.11's `tarfile` and `lzma` (2,848 bytes; `xz -lvv` reads one stream, one block, CRC64),
 * by this script run as `python3 -I make.py ffmpeg-build-fixture.tar.xz`:
 *
 * ```python
 * import io, lzma, sys, tarfile
 * root = "ffmpeg-fixture-linuxarm64-gpl"
 * members = [
 *     (f"{root}/", None, 0o755),
 *     (f"{root}/bin/", None, 0o755),
 *     (f"{root}/bin/ffmpeg", b"".join(b"ffmpeg fixture body, line %06d\n" % i for i in range(6000)), 0o755),
 *     (f"{root}/bin/ffprobe", b"ffprobe fixture\n", 0o755),
 *     (f"{root}/LICENSE.txt", b"GNU GENERAL PUBLIC LICENSE, a stand-in for the fixture\n", 0o644),
 *     (f"{root}/doc/", None, 0o755),
 *     (f"{root}/doc/faq.html", b"<p>fixture</p>\n", 0o644),
 * ]
 * buffer = io.BytesIO()
 * with tarfile.open(fileobj=buffer, mode="w", format=tarfile.GNU_FORMAT) as tar:
 *     for name, body, mode in members:
 *         info = tarfile.TarInfo(name.rstrip("/"))
 *         info.mtime, info.uid, info.gid, info.uname, info.gname, info.mode = 1793404800, 0, 0, "", "", mode
 *         if body is None:
 *             info.type = tarfile.DIRTYPE
 *             tar.addfile(info)
 *         else:
 *             info.size = len(body)
 *             tar.addfile(info, io.BytesIO(body))
 * data = lzma.compress(buffer.getvalue(), format=lzma.FORMAT_XZ, check=lzma.CHECK_CRC64)
 * open(sys.argv[1], "wb").write(data)
 * ```
 *
 * The synthesised archives below exist for the cases no ordinary archiver will produce, and the last
 * suite is the real 128.7 MB linux-arm64 pin, gated because it downloads it.
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
import { loadavg, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ArchiveRefusal, sha256Of } from "./archive.js";
import { acquireArtefact } from "./download.js";
import {
  assertTarballArtefact,
  extractTar,
  type TarExtractOptions,
  type TarHeader,
  type TarSelector,
} from "./tar.js";
import { buildTarGz, type TarMemberSpec } from "./testing/tar-builder.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "npm-package-fixture.tgz");
const XZ_FIXTURE = join(HERE, "fixtures", "ffmpeg-build-fixture.tar.xz");
const GZIP: TarExtractOptions = { decompressor: "gzip" };
const XZ: TarExtractOptions = { decompressor: "xz" };
const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scratchDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "xplainer-tar-"));
  scratch.push(directory);
  return directory;
}

function writeArchive(bytes: Buffer): string {
  const file = join(scratchDir(), "artefact.tgz");
  writeFileSync(file, bytes);
  return file;
}

/** Everything, with `package/` stripped — the rule every npm selector starts from. */
const everything: TarSelector = (header: TarHeader) =>
  header.name.startsWith("package/") ? header.name.slice("package/".length) : null;

function tree(root: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...tree(join(root, entry.name), name));
    } else {
      found.push(name);
    }
  }
  return found.sort();
}

describe("the committed fixture tarball", () => {
  it("is the archive its own digest names, so an edit to it fails here", () => {
    expect(sha256Of(readFileSync(FIXTURE))).toBe(
      "588c29764e057f421a97fa2b5dc13f0101e1f6fd9d13b5c406b60f2f57e073fe",
    );
  });

  it("unpacks whole, exactly as npm packed it", async () => {
    const destination = join(scratchDir(), "unpacked");
    const summary = await extractTar(FIXTURE, destination, everything, GZIP);

    expect(summary.files).toBe(10);
    expect(summary.skipped).toBe(0);
    expect(tree(destination)).toEqual([
      "bin/napi-v6/darwin/arm64/libfixture.1.dylib",
      "bin/napi-v6/darwin/arm64/native.node",
      "bin/napi-v6/linux/x64/libfixture.so.1",
      "bin/napi-v6/linux/x64/native.node",
      "bin/napi-v6/win32/x64/fixture.dll",
      "bin/napi-v6/win32/x64/native.node",
      "dist/binding.js",
      "dist/index.js",
      "package.json",
      "script/install.js",
    ]);
    expect(JSON.parse(readFileSync(join(destination, "package.json"), "utf8")).name).toBe(
      "fixture-native-package",
    );
  });

  it("takes one platform out of three, which is the whole reason the selector exists", async () => {
    const destination = join(scratchDir(), "one-platform");
    const wanted = ["dist/", "bin/napi-v6/linux/x64/"];
    const summary = await extractTar(
      FIXTURE,
      destination,
      (header) => {
        const inside = everything(header);
        if (inside === null) {
          return null;
        }
        return inside === "package.json" || wanted.some((prefix) => inside.startsWith(prefix))
          ? inside
          : null;
      },
      GZIP,
    );

    expect(summary.files).toBe(5);
    expect(summary.skipped).toBe(5);
    expect(tree(destination)).toEqual([
      "bin/napi-v6/linux/x64/libfixture.so.1",
      "bin/napi-v6/linux/x64/native.node",
      "dist/binding.js",
      "dist/index.js",
      "package.json",
    ]);
    // The `postinstall` script is the member whose absence is the point: it is the file that would
    // fetch 183 MB of CUDA binaries from a third feed, and nothing here ever writes it to disk.
    expect(existsSync(join(destination, "script"))).toBe(false);
  });

  it("keeps the mode the archive recorded", async () => {
    const destination = join(scratchDir(), "modes");
    await extractTar(FIXTURE, destination, everything, GZIP);
    expect(statSync(join(destination, "dist", "index.js")).mode & 0o777).toBe(0o644);
  });
});

describe("what the reader refuses", () => {
  it("refuses a member that climbs out of the destination", async () => {
    const archive = writeArchive(
      buildTarGz([{ name: "package/../../escaped.txt", contents: "no" }]),
    );
    await expect(
      extractTar(archive, join(scratchDir(), "out"), (h) => h.name, GZIP),
    ).rejects.toThrow(/climbs out of the directory/);
  });

  it("refuses an absolute member name", async () => {
    const archive = writeArchive(buildTarGz([{ name: "/etc/passwd", contents: "no" }]));
    await expect(
      extractTar(archive, join(scratchDir(), "out"), (h) => h.name, GZIP),
    ).rejects.toThrow(/is an absolute path/);
  });

  it("refuses a member type it does not write, and names the pin that cannot have one", async () => {
    const archive = writeArchive(
      buildTarGz([{ name: "package/link", contents: "package/real", typeflag: "2" }]),
    );
    const refusal = extractTar(archive, join(scratchDir(), "out"), everything, GZIP);
    await expect(refusal).rejects.toThrow(ArchiveRefusal);
    await expect(refusal).rejects.toThrow(/type "2"/);
    await expect(refusal).rejects.toThrow(/pinned by digest/);
  });

  it("refuses a header whose checksum does not match its bytes", async () => {
    const archive = writeArchive(
      buildTarGz([{ name: "package/a.txt", contents: "x", checksumOverride: 1 }]),
    );
    await expect(extractTar(archive, join(scratchDir(), "out"), everything, GZIP)).rejects.toThrow(
      /checksum is 1 /,
    );
  });

  it("refuses a header that is not ustar", async () => {
    const archive = writeArchive(
      buildTarGz([{ name: "package/a.txt", contents: "x", magicOverride: "gnutar" }]),
    );
    await expect(extractTar(archive, join(scratchDir(), "out"), everything, GZIP)).rejects.toThrow(
      /rather than "ustar"/,
    );
  });

  it("refuses an archive that ends without a trailer, which a digest cannot catch", async () => {
    const archive = writeArchive(buildTarGz([{ name: "package/a.txt", contents: "x" }], false));
    await expect(extractTar(archive, join(scratchDir(), "out"), everything, GZIP)).rejects.toThrow(
      /ended without a tar trailer/,
    );
  });

  it("refuses two members that the selector would land on one path", async () => {
    const archive = writeArchive(
      buildTarGz([
        { name: "package/dist/a.js", contents: "first" },
        { name: "package/lib/a.js", contents: "second" },
      ]),
    );
    // A selector that collapses two directories: the later member would silently win.
    const collapse: TarSelector = (header) => header.name.split("/").slice(-1)[0] ?? null;
    await expect(extractTar(archive, join(scratchDir(), "out"), collapse, GZIP)).rejects.toThrow(
      /already been written to/,
    );
  });

  it("refuses a GNU base-256 size field rather than decoding one it has no archive to test", async () => {
    const rawSize = Buffer.alloc(12);
    rawSize.writeUInt8(0x80, 0);
    rawSize.writeUInt8(1, 11);
    const member: TarMemberSpec = { name: "package/a.txt", contents: "x", rawSize };
    const archive = writeArchive(buildTarGz([member]));
    const refusal = extractTar(archive, join(scratchDir(), "out"), everything, GZIP);
    await expect(refusal).rejects.toThrow(ArchiveRefusal);
    await expect(refusal).rejects.toThrow(/GNU base-256 encoded/);
  });
});

describe("the name prefix, which only POSIX ustar has", () => {
  it("joins a POSIX ustar header's prefix onto its name", async () => {
    const archive = writeArchive(
      buildTarGz([{ name: "a.txt", prefix: "package/deep", contents: "x" }]),
    );
    const destination = join(scratchDir(), "out");

    await extractTar(archive, destination, everything, GZIP);

    expect(tree(destination)).toEqual(["deep/a.txt"]);
  });

  /**
   * A GNU header (`ustar  \0`) keeps the access and change times at offset 345, where POSIX keeps
   * the prefix, so reading them as a prefix would put an octal timestamp at the front of the name.
   */
  it("reads no prefix from a GNU header, where those bytes are the access and change times", async () => {
    const archive = writeArchive(
      buildTarGz([
        { name: "package/a.txt", gnu: true, prefix: "15123456701\u000015123456702", contents: "x" },
      ]),
    );
    const names: string[] = [];

    await extractTar(
      archive,
      join(scratchDir(), "out"),
      (header) => {
        names.push(header.name);
        return null;
      },
      GZIP,
    );

    expect(names).toEqual(["package/a.txt"]);
  });
});

/** The xz fixture's one root, which every selector over it strips. */
const XZ_ROOT = "ffmpeg-fixture-linuxarm64-gpl/";

/** Everything in the xz fixture, with its root stripped. */
const everythingXz: TarSelector = (header) =>
  header.name.startsWith(XZ_ROOT) && header.name !== XZ_ROOT
    ? header.name.slice(XZ_ROOT.length)
    : null;

/** A copy of the xz fixture with one change, for the streams the decoder must refuse. */
function xzVariant(change: (bytes: Buffer) => Buffer): string {
  const file = join(scratchDir(), "artefact.tar.xz");
  writeFileSync(file, change(Buffer.from(readFileSync(XZ_FIXTURE))));
  return file;
}

async function refusalOf(promise: Promise<unknown>): Promise<ArchiveRefusal> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveRefusal);
    return error as ArchiveRefusal;
  }
  throw new Error("the extraction was expected to refuse and did not");
}

describe("the committed xz fixture, read the way a BtbN build is", () => {
  it("is the archive its own digest names, so an edit to it fails here", () => {
    expect(sha256Of(readFileSync(XZ_FIXTURE))).toBe(
      "a76bab4d7ab03f34f90e284304b95a59feb79212996fc1ea5682f96d1b687363",
    );
  });

  it("unpacks whole through the same parser the gzip route uses", async () => {
    const destination = join(scratchDir(), "unpacked");
    const summary = await extractTar(XZ_FIXTURE, destination, everythingXz, XZ);

    expect(summary).toEqual({ files: 4, directories: 2, skipped: 1, bytes: 198_086 });
    expect(tree(destination)).toEqual(["LICENSE.txt", "bin/ffmpeg", "bin/ffprobe", "doc/faq.html"]);
    const ffmpeg = readFileSync(join(destination, "bin", "ffmpeg"));
    // 198,000 bytes spans several of the decoder's output chunks, so a member body that straddles a
    // chunk boundary is read here and not only in the real-pin suite.
    expect(ffmpeg.length).toBe(198_000);
    expect(ffmpeg.subarray(0, 32).toString()).toBe("ffmpeg fixture body, line 000000");
    expect(ffmpeg.subarray(-7).toString()).toBe("005999\n");
    if (process.platform !== "win32") {
      expect(statSync(join(destination, "bin", "ffmpeg")).mode & 0o777).toBe(0o755);
    }
  });

  it("keeps the two members a provider names, and stops decoding after the second", async () => {
    const destination = join(scratchDir(), "selected");
    const asked: string[] = [];
    const keep: Record<string, string> = {
      [`${XZ_ROOT}bin/ffmpeg`]: "ffmpeg",
      [`${XZ_ROOT}LICENSE.txt`]: "LICENSE.txt",
    };
    const summary = await extractTar(
      XZ_FIXTURE,
      destination,
      (header) => {
        asked.push(header.name);
        return keep[header.name] ?? null;
      },
      { decompressor: "xz", stopAfter: Object.keys(keep) },
    );

    expect(tree(destination)).toEqual(["LICENSE.txt", "ffmpeg"]);
    expect(summary.files).toBe(2);
    // Nothing after LICENSE.txt was asked about, so its header was never decoded: the stop is real.
    expect(asked).toEqual([
      XZ_ROOT,
      `${XZ_ROOT}bin/`,
      `${XZ_ROOT}bin/ffmpeg`,
      `${XZ_ROOT}bin/ffprobe`,
      `${XZ_ROOT}LICENSE.txt`,
    ]);
  });

  it("gives the shared decoder back after an early stop and after a refusal", async () => {
    // `xz-decompress` holds one lock per process; a stopped or failed stream that kept it would
    // leave this third extraction waiting for ever, and the suite's timeout would be the failure.
    await extractTar(XZ_FIXTURE, join(scratchDir(), "first"), everythingXz, {
      decompressor: "xz",
      stopAfter: [`${XZ_ROOT}bin/ffmpeg`],
    });
    await refusalOf(
      extractTar(
        xzVariant((bytes) => bytes.subarray(0, 600)),
        join(scratchDir(), "second"),
        everythingXz,
        XZ,
      ),
    );
    const summary = await extractTar(XZ_FIXTURE, join(scratchDir(), "third"), everythingXz, XZ);
    expect(summary.files).toBe(4);
  });
});

describe("what the xz decoder refuses, by name", () => {
  it("refuses a stream whose CRC64 does not match, though every tar header in it is sound", async () => {
    // The block's check is the eight bytes before the index, and the footer's backward size says
    // where the index starts (xz file format 1.2.1, §2.1.2.2): so every byte of the tar decodes
    // correctly, the trailer is reached, and only the integrity check fails.
    const archive = xzVariant((bytes) => {
      const indexSize = (bytes.readUInt32LE(bytes.length - 12 + 4) + 1) * 4;
      const check = bytes.length - 12 - indexSize - 8;
      bytes.writeUInt8(bytes.readUInt8(check) ^ 0xff, check);
      return bytes;
    });
    const refusal = await refusalOf(
      extractTar(archive, join(scratchDir(), "out"), everythingXz, XZ),
    );
    expect(refusal.reason).toBe("corrupt-stream");
    expect(refusal.message).toMatch(/does not decompress as xz: its compressed data is corrupt/);
  });

  it("refuses a stream that ends before it should", async () => {
    const archive = xzVariant((bytes) => bytes.subarray(0, Math.floor(bytes.length / 2)));
    const refusal = await refusalOf(
      extractTar(archive, join(scratchDir(), "out"), everythingXz, XZ),
    );
    expect(refusal.reason).toBe("corrupt-stream");
    expect(refusal.message).toMatch(/it ends before the xz stream does/);
  });

  it("refuses a gzipped tarball handed to the xz decoder, and an xz one handed to gzip", async () => {
    const asXz = await refusalOf(extractTar(FIXTURE, join(scratchDir(), "a"), everything, XZ));
    expect(asXz.reason).toBe("corrupt-stream");
    expect(asXz.message).toMatch(/it is not an xz stream/);

    const asGzip = await refusalOf(
      extractTar(XZ_FIXTURE, join(scratchDir(), "b"), everything, GZIP),
    );
    expect(asGzip.reason).toBe("corrupt-stream");
    expect(asGzip.message).toMatch(/does not decompress as gzip/);
  });
});

describe("assertTarballArtefact", () => {
  it("accepts the two spellings a gzipped tarball is published under", () => {
    expect(() =>
      assertTarballArtefact("https://registry.npmjs.org/x/-/x-1.0.0.tgz", "gzip"),
    ).not.toThrow();
    expect(() =>
      assertTarballArtefact("https://example.test/x.tar.gz?token=1", "gzip"),
    ).not.toThrow();
  });

  it("accepts the one an xz tarball is published under", () => {
    expect(() =>
      assertTarballArtefact(
        "https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/a/ffmpeg-linuxarm64-gpl-9.0.tar.xz",
        "xz",
      ),
    ).not.toThrow();
  });

  it("refuses a zip, and either tarball handed to the other decoder, before a byte is fetched", () => {
    expect(() => assertTarballArtefact("https://example.test/x.zip", "gzip")).toThrow(
      /is not a .tgz/,
    );
    expect(() => assertTarballArtefact("https://example.test/x.tar.xz", "gzip")).toThrow(
      /is not a .tgz or a .tar.gz/,
    );
    expect(() => assertTarballArtefact("https://example.test/x.tgz", "xz")).toThrow(
      /is not a .tar.xz, which is how a xz tarball is published/,
    );
  });
});

/**
 * The BtbN linux-arm64 pin, as DESIGN §4.1 records it and as the release's own `checksums.sha256`
 * names it (read 2026-11-12). `LICENSE.txt`'s digest and offset were measured by decoding it.
 */
const REAL_PIN = {
  url:
    "https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/autobuild-2026-10-31-12-59/" +
    "ffmpeg-n9.0.2-39-g7adfbe40dc-linuxarm64-gpl-9.0.tar.xz",
  sha256: "6cad88ae5bcec356cfc5d7979a036cc4007128201928a0cf243df3db483276cc",
  size: 128_664_064,
  root: "ffmpeg-n9.0.2-39-g7adfbe40dc-linuxarm64-gpl-9.0/",
  member: {
    sha256: "091fe4df4902fedd20f4d5accab14d02947a531d14d789cc7e8f18b0a808e6d1",
    bytes: 131_591_912,
  },
  licence: {
    sha256: "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903",
    bytes: 35_147,
  },
} as const;

// Downloads 128.7 MB from GitHub and decodes 404 MB of it, so it runs only when asked for:
//   XPLAINER_REAL_FFMPEG_PIN=1 pnpm --filter @xplainer/cli exec vitest run src/setup/tar.test.ts
describe.skipIf(process.env.XPLAINER_REAL_FFMPEG_PIN !== "1")(
  "the real BtbN linux-arm64 pin",
  () => {
    it("downloads against its digest, decodes, and finds bin/ffmpeg at the recorded sha256", async () => {
      const root = scratchDir();
      const destination = join(root, "ffmpeg");
      const keep: Record<string, string> = {
        [`${REAL_PIN.root}bin/ffmpeg`]: "ffmpeg",
        [`${REAL_PIN.root}LICENSE.txt`]: "LICENSE.txt",
      };
      let started = 0;
      let ffmpegDecodedAt = 0;
      let decodeSeconds = 0;
      /** The process's peak RSS once the download is done, so the decode's own share can be read. */
      const peakRssMb = (): number => Math.round(process.resourceUsage().maxRSS / 1024);
      let rssBeforeDecodeMb = 0;
      const outcome = await acquireArtefact({
        request: { url: REAL_PIN.url, sha256: REAL_PIN.sha256, size: REAL_PIN.size },
        destination,
        archive: {
          assert: (url) => assertTarballArtefact(url, "xz"),
          extract: async (archive, staging) => {
            rssBeforeDecodeMb = peakRssMb();
            started = performance.now();
            const summary = await extractTar(
              archive,
              staging,
              (header) => {
                // The member after bin/ffmpeg is bin/ffplay: its header arriving is bin/ffmpeg done.
                if (ffmpegDecodedAt === 0 && header.name === `${REAL_PIN.root}bin/ffplay`) {
                  ffmpegDecodedAt = performance.now();
                }
                return keep[header.name] ?? null;
              },
              { decompressor: "xz", stopAfter: Object.keys(keep) },
            );
            decodeSeconds = (performance.now() - started) / 1000;
            return summary;
          },
        },
      });

      const ffmpeg = readFileSync(join(destination, "ffmpeg"));
      expect(ffmpeg.length).toBe(REAL_PIN.member.bytes);
      expect(sha256Of(ffmpeg)).toBe(REAL_PIN.member.sha256);
      const licence = readFileSync(join(destination, "LICENSE.txt"));
      expect(licence.length).toBe(REAL_PIN.licence.bytes);
      expect(sha256Of(licence)).toBe(REAL_PIN.licence.sha256);
      expect(outcome.extraction.files).toBe(2);
      console.log(
        `real pin: bin/ffmpeg decoded at ${((ffmpegDecodedAt - started) / 1000).toFixed(2)} s; ` +
          `stopped after LICENSE.txt at ${decodeSeconds.toFixed(2)} s; ` +
          `peak RSS of this test process ${rssBeforeDecodeMb} MB before decoding and ` +
          `${peakRssMb()} MB after; load ${loadavg()[0]?.toFixed(2)}`,
      );
    }, 600_000);
  },
);
