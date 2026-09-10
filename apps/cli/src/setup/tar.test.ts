/**
 * The tar reader, against a real npm tarball first and hostile ones after.
 *
 * `fixtures/npm-package-fixture.tgz` was written by `npm pack` — that is, by node-tar, which is the
 * writer whose output this reader will actually meet, since every tarball `setup` fetches comes off
 * the npm registry. It carries the shape that matters: a single `package/` root, a `dist/` of
 * JavaScript, a `script/install.js` that must never be extracted, and **three** `bin/napi-v6`
 * platform subtrees, so the selection this reader exists for can be proved rather than asserted.
 *
 * The synthesised archives below exist for the cases no ordinary archiver will produce.
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
import { afterEach, describe, expect, it } from "vitest";
import { ArchiveRefusal, sha256Of } from "./archive.js";
import { assertTarballArtefact, extractTarGz, type TarHeader, type TarSelector } from "./tar.js";
import { buildTarGz, type TarMemberSpec } from "./testing/tar-builder.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "npm-package-fixture.tgz");
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
    const summary = await extractTarGz(FIXTURE, destination, everything);

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
    const summary = await extractTarGz(FIXTURE, destination, (header) => {
      const inside = everything(header);
      if (inside === null) {
        return null;
      }
      return inside === "package.json" || wanted.some((prefix) => inside.startsWith(prefix))
        ? inside
        : null;
    });

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
    await extractTarGz(FIXTURE, destination, everything);
    expect(statSync(join(destination, "dist", "index.js")).mode & 0o777).toBe(0o644);
  });
});

describe("what the reader refuses", () => {
  it("refuses a member that climbs out of the destination", async () => {
    const archive = writeArchive(
      buildTarGz([{ name: "package/../../escaped.txt", contents: "no" }]),
    );
    await expect(extractTarGz(archive, join(scratchDir(), "out"), (h) => h.name)).rejects.toThrow(
      /climbs out of the directory/,
    );
  });

  it("refuses an absolute member name", async () => {
    const archive = writeArchive(buildTarGz([{ name: "/etc/passwd", contents: "no" }]));
    await expect(extractTarGz(archive, join(scratchDir(), "out"), (h) => h.name)).rejects.toThrow(
      /is an absolute path/,
    );
  });

  it("refuses a member type it does not write, and names the pin that cannot have one", async () => {
    const archive = writeArchive(
      buildTarGz([{ name: "package/link", contents: "package/real", typeflag: "2" }]),
    );
    const refusal = extractTarGz(archive, join(scratchDir(), "out"), everything);
    await expect(refusal).rejects.toThrow(ArchiveRefusal);
    await expect(refusal).rejects.toThrow(/type "2"/);
    await expect(refusal).rejects.toThrow(/pinned by digest/);
  });

  it("refuses a header whose checksum does not match its bytes", async () => {
    const archive = writeArchive(
      buildTarGz([{ name: "package/a.txt", contents: "x", checksumOverride: 1 }]),
    );
    await expect(extractTarGz(archive, join(scratchDir(), "out"), everything)).rejects.toThrow(
      /checksum is 1 /,
    );
  });

  it("refuses a header that is not ustar", async () => {
    const archive = writeArchive(
      buildTarGz([{ name: "package/a.txt", contents: "x", magicOverride: "gnutar" }]),
    );
    await expect(extractTarGz(archive, join(scratchDir(), "out"), everything)).rejects.toThrow(
      /rather than "ustar"/,
    );
  });

  it("refuses an archive that ends without a trailer, which a digest cannot catch", async () => {
    const archive = writeArchive(buildTarGz([{ name: "package/a.txt", contents: "x" }], false));
    await expect(extractTarGz(archive, join(scratchDir(), "out"), everything)).rejects.toThrow(
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
    await expect(extractTarGz(archive, join(scratchDir(), "out"), collapse)).rejects.toThrow(
      /already been written to/,
    );
  });

  it("refuses a GNU base-256 size field rather than decoding one it has no archive to test", async () => {
    const rawSize = Buffer.alloc(12);
    rawSize.writeUInt8(0x80, 0);
    rawSize.writeUInt8(1, 11);
    const member: TarMemberSpec = { name: "package/a.txt", contents: "x", rawSize };
    const archive = writeArchive(buildTarGz([member]));
    const refusal = extractTarGz(archive, join(scratchDir(), "out"), everything);
    await expect(refusal).rejects.toThrow(ArchiveRefusal);
    await expect(refusal).rejects.toThrow(/GNU base-256 encoded/);
  });
});

describe("assertTarballArtefact", () => {
  it("accepts the two spellings a gzipped tarball is published under", () => {
    expect(() => assertTarballArtefact("https://registry.npmjs.org/x/-/x-1.0.0.tgz")).not.toThrow();
    expect(() => assertTarballArtefact("https://example.test/x.tar.gz?token=1")).not.toThrow();
  });

  it("refuses a zip, before a byte of it is fetched", () => {
    expect(() => assertTarballArtefact("https://example.test/x.zip")).toThrow(/is not a .tgz/);
  });
});
