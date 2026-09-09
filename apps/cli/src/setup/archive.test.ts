/**
 * The zip reader, against a real archive first and hostile ones after.
 *
 * `fixtures/toolchain-fixture.zip` was written by the system `zip` and carries every shape the
 * Chrome and speech artefacts do: directory entries, a deflated member, stored members, an
 * executable bit and a relative symlink. It is the anchor, because a reader checked only against
 * this package's own writer would prove that the two agree and nothing more. The synthesised
 * archives below exist for the cases no ordinary archiver will produce.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ArchiveRefusal, extractZip, readZipEntries, safeJoin, sha256Of } from "./archive.js";
import { buildZip } from "./testing/zip-builder.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "toolchain-fixture.zip");
const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scratchDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "xplainer-archive-"));
  scratch.push(directory);
  return directory;
}

function writeArchive(bytes: Buffer): string {
  const file = join(scratchDir(), "artefact.zip");
  writeFileSync(file, bytes);
  return file;
}

describe("the committed fixture archive", () => {
  it("is the archive its own digest names, so an edit to it fails here", () => {
    expect(sha256Of(readFileSync(FIXTURE))).toBe(
      "396f7b6b4ff26a3b66603b1a9414dc2246d85702c5682c83085681676ecc375c",
    );
  });

  it("is read as the system zip wrote it: two methods, two directories and a symlink", () => {
    const entries = readZipEntries(readFileSync(FIXTURE));
    const byName = new Map(entries.map((entry) => [entry.name, entry]));

    expect(entries).toHaveLength(7);
    expect(byName.get("toolchain-fixture/")?.isDirectory).toBe(true);
    expect(byName.get("toolchain-fixture/nested/")?.isDirectory).toBe(true);
    expect(byName.get("toolchain-fixture/shell")?.mode).toBe(0o755);
    expect(byName.get("toolchain-fixture/shell")?.method).toBe(0);
    expect(byName.get("toolchain-fixture/nested/notes.txt")?.method).toBe(8);
    expect(byName.get("toolchain-fixture/nested/shell-link")?.isSymlink).toBe(true);
    expect(byName.get("toolchain-fixture/ABOUT")?.uncompressedSize).toBe(35);
  });

  it("unpacks to a tree whose executable runs and whose symlink resolves", () => {
    const destination = join(scratchDir(), "unpacked");

    const summary = extractZip(FIXTURE, destination);

    expect(summary).toEqual({ files: 4, directories: 2, symlinks: 1, bytes: 4476 });
    const root = join(destination, "toolchain-fixture");
    expect(readFileSync(join(root, "ABOUT"), "utf8")).toBe("xplainer toolchain fixture archive\n");
    expect(readFileSync(join(root, "nested", "blob.bin")).length).toBe(4096);
    expect(readlinkSync(join(root, "nested", "shell-link"))).toBe("../shell");
    expect(lstatSync(join(root, "nested", "shell-link")).isSymbolicLink()).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(join(root, "shell")).mode & 0o777).toBe(0o755);
      // The whole point of preserving the mode: the artefact has to be runnable afterwards, and it
      // is run through the symlink, so both properties are asserted by one execution.
      const ran = spawnSync(join(root, "nested", "shell-link"), [], { encoding: "utf8" });
      expect(ran.status).toBe(0);
      expect(ran.stdout).toBe("fixture-shell 1.0.0\n");
    }
  });

  it("leaves the mode alone under a restrictive umask", () => {
    // `writeFileSync`'s mode is masked by the umask; the explicit `chmod` after it is what makes
    // this pass. Windows has neither, so there the assertion is that the file arrived at all.
    const previous = process.platform === "win32" ? 0 : process.umask(0o077);
    try {
      const destination = join(scratchDir(), "unpacked");
      extractZip(FIXTURE, destination);
      const shell = join(destination, "toolchain-fixture", "shell");
      if (process.platform === "win32") {
        expect(existsSync(shell)).toBe(true);
      } else {
        expect(statSync(shell).mode & 0o777).toBe(0o755);
      }
    } finally {
      if (process.platform !== "win32") {
        process.umask(previous);
      }
    }
  });
});

describe("an archive that would write outside the directory it is unpacked into", () => {
  it("is refused by name, before anything is written", () => {
    const archive = writeArchive(
      buildZip([
        { name: "good/ABOUT", contents: "fine" },
        { name: "../../../../../../tmp/xplainer-pwn", contents: "not fine" },
      ]),
    );
    const destination = join(scratchDir(), "unpacked");

    expect(() => extractZip(archive, destination)).toThrow(ArchiveRefusal);
    try {
      extractZip(archive, destination);
      expect.unreachable("a climbing entry must refuse");
    } catch (error) {
      expect((error as ArchiveRefusal).reason).toBe("unsafe-entry");
      expect((error as ArchiveRefusal).entry).toBe("../../../../../../tmp/xplainer-pwn");
    }
    expect(existsSync("/tmp/xplainer-pwn")).toBe(false);
  });

  it("refuses an absolute name, a drive letter and a backslash separator too", () => {
    expect(() => safeJoin("/dest", "/etc/passwd")).toThrow(/absolute path/);
    expect(() => safeJoin("/dest", "C:/Windows/system32/x")).toThrow(/absolute path/);
    expect(() => safeJoin("/dest", "a\\..\\..\\b")).toThrow(/backslash/);
    expect(() => safeJoin("/dest", "")).toThrow(/empty name/);
    expect(safeJoin("/dest", "./a/./b")).toBe(join("/dest", "a", "b"));
  });

  it("refuses a symlink that lands outside, and keeps the relative ones that land inside", () => {
    const escaping = writeArchive(
      buildZip([
        { name: "root/", contents: "", directory: true },
        { name: "root/link", contents: "../../../../etc", symlink: true, mode: 0o777 },
      ]),
    );
    const inside = writeArchive(
      buildZip([
        { name: "root/", contents: "", directory: true },
        { name: "root/deep/", contents: "", directory: true },
        { name: "root/file", contents: "target" },
        { name: "root/deep/link", contents: "../file", symlink: true, mode: 0o777 },
      ]),
    );
    const destination = join(scratchDir(), "unpacked");

    expect(() => extractZip(escaping, join(scratchDir(), "escaping"))).toThrow(
      /lands outside the unpacked tree/,
    );
    expect(extractZip(inside, destination).symlinks).toBe(1);
    expect(readFileSync(join(destination, "root", "deep", "link"), "utf8")).toBe("target");
  });
});

describe("an archive whose bytes do not add up", () => {
  it("refuses a member whose CRC-32 does not match what it inflated to", () => {
    const archive = writeArchive(
      buildZip([{ name: "root/data", contents: "eight...", crcOverride: 0x0badc0de }]),
    );

    try {
      extractZip(archive, join(scratchDir(), "unpacked"));
      expect.unreachable("a wrong CRC must refuse");
    } catch (error) {
      expect((error as ArchiveRefusal).reason).toBe("corrupt-entry");
      expect((error as ArchiveRefusal).message).toContain("badc0de");
    }
  });

  it("refuses a compression method it does not implement, by number", () => {
    const archive = writeArchive(
      buildZip([{ name: "root/data", contents: "stored, but labelled bzip2", methodOverride: 12 }]),
    );

    expect(() => extractZip(archive, join(scratchDir(), "unpacked"))).toThrow(
      /compression method 12/,
    );
  });

  it("refuses a file with no central directory at all", () => {
    const archive = writeArchive(Buffer.from("this is not an archive, it is a sentence"));

    expect(() => extractZip(archive, join(scratchDir(), "unpacked"))).toThrow(/not a zip archive/);
  });

  it("refuses a truncated archive rather than unpacking the part that survived", () => {
    const whole = readFileSync(FIXTURE);
    const archive = writeArchive(whole.subarray(0, whole.length - 40));

    expect(() => extractZip(archive, join(scratchDir(), "unpacked"))).toThrow(ArchiveRefusal);
  });

  it("refuses a zip64 member rather than reading its saturated 32-bit size", () => {
    const bytes = buildZip([{ name: "root/big", contents: "not actually four gigabytes" }]);
    // The central directory's compressed-size field, saturated the way a >4 GiB member's is.
    const central = bytes.length - 22 - (46 + "root/big".length);
    bytes.writeUInt32LE(0xffffffff, central + 20);

    expect(() => extractZip(writeArchive(bytes), join(scratchDir(), "unpacked"))).toThrow(
      /zip64 extended information/,
    );
  });

  it("refuses an archive whose central directory names more entries than it holds", () => {
    const bytes = buildZip([{ name: "root/data", contents: "one" }]);
    // The entry count lives in the last two 16-bit fields before the sizes; claiming two entries
    // where one was written is what a partially rewritten archive looks like.
    bytes.writeUInt16LE(2, bytes.length - 22 + 8);
    bytes.writeUInt16LE(2, bytes.length - 22 + 10);

    expect(() => extractZip(writeArchive(bytes), join(scratchDir(), "unpacked"))).toThrow(
      /central directory ends after 1 of 2 entries/,
    );
  });
});
