/**
 * Reading the one archive format the toolchain artefacts arrive in, and unpacking it into staging.
 *
 * Every artefact `setup` fetches is a **zip**: Chrome for Testing publishes
 * `chrome-headless-shell-<platform>.zip`, `remotion.media` publishes
 * `chromium-headless-shell-<platform>-<version>.zip`, and the speech bundles are named the same
 * way. So the reader here is a zip reader, an archive whose extension says anything else is a
 * named refusal rather than a branch that guesses, and nothing in this package shells out to
 * `unzip` — a Debian slim image has no `unzip`, and GNU `tar` cannot read a zip at all.
 *
 * **Why this is written rather than depended on.** `@xplainer/cli` is the one published
 * application and its production dependency list is copied wholesale into payload 1 by
 * `runtime build`; a new runtime dependency is a change to that payload, to the publish contract
 * and to what an installer carries, for about two hundred lines of a fully specified format. The
 * reader is deliberately small: it reads the **central directory** — the authoritative index a zip
 * ends with — and never the local headers, whose sizes may live in a trailing data descriptor.
 *
 * **What it refuses, and why each one is real rather than defensive.**
 * An entry name that escapes the destination (`../`, an absolute path, a Windows drive or a
 * backslash separator) is refused before anything is written, because an archive fetched over the
 * network that can write outside the directory it was unpacked into is the classic zip-slip. A
 * CRC-32 that does not match the bytes is refused, because the SHA-256 covers the archive and the
 * CRC covers each member, and a decompressor that produced the wrong bytes is not a file to leave
 * on disk. A method other than stored or deflate is refused by number.
 *
 * **Modes and symlinks are preserved**, because Chrome's own archives need both: the shell is
 * `0755` and its macOS framework carries symlinks. The rules are the ones `@remotion/renderer`'s
 * own extractor applies to the same archives — mode from the high half of
 * `externalFileAttributes`, `0644`/`0755` where a zip carries none, `__MACOSX/` skipped — so an
 * artefact unpacked here and one unpacked by Remotion are the same tree.
 */

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";

/** Why an archive was refused. One value per distinguishable condition, never a catch-all. */
export type ArchiveRefusalReason =
  | "not-a-zip"
  | "unsupported-entry"
  | "unsafe-entry"
  | "corrupt-entry";

/** The archive will not be unpacked, and the destination holds nothing this call made. */
export class ArchiveRefusal extends Error {
  readonly reason: ArchiveRefusalReason;
  /** The entry the refusal is about, where it is about one. */
  readonly entry: string | undefined;

  constructor(reason: ArchiveRefusalReason, message: string, entry?: string) {
    super(message);
    this.name = "ArchiveRefusal";
    this.reason = reason;
    this.entry = entry;
  }
}

/** One member of an archive, as the central directory describes it. */
export type ZipEntry = {
  /** The name exactly as recorded, `/`-separated on every platform. */
  name: string;
  /** 0 (stored) or 8 (deflate); anything else is refused before it is read. */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  /** Unix permission bits, or `null` where the archive carries none. */
  mode: number | null;
  isDirectory: boolean;
  isSymlink: boolean;
  /** Byte offset of this member's local header. */
  localHeaderOffset: number;
};

/** What {@link extractZip} unpacked. */
export type ExtractionSummary = {
  files: number;
  directories: number;
  symlinks: number;
  /** Total uncompressed bytes written, so a caller can report a size without walking the tree. */
  bytes: number;
};

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_LOCATOR = 0x07064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;
const ZIP64_MARKER = 0xffffffff;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

/** The default modes a zip with no unix attributes gets, matching Remotion's own extractor. */
const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIRECTORY_MODE = 0o755;

/** Read an archive's central directory. The file is read once, in full, by the caller. */
export function readZipEntries(archive: Buffer): ZipEntry[] {
  const end = findEndOfCentralDirectory(archive);
  const entries: ZipEntry[] = [];
  let offset = end.centralDirectoryOffset;
  for (let index = 0; index < end.entryCount; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) {
      throw new ArchiveRefusal(
        "not-a-zip",
        `The central directory ends after ${index} of ${end.entryCount} entries.`,
      );
    }
    const versionMadeBy = archive.readUInt16LE(offset + 4);
    const method = archive.readUInt16LE(offset + 10);
    const crc = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const localHeaderOffset = archive.readUInt32LE(offset + 42);
    const name = archive.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (
      compressedSize === ZIP64_MARKER ||
      uncompressedSize === ZIP64_MARKER ||
      localHeaderOffset === ZIP64_MARKER
    ) {
      // The 32-bit field saturates and the real value moves into a zip64 extra field, which this
      // reader does not parse. Reading the saturated value instead would take a 4 GiB member as a
      // 4 GiB-minus-one one and produce a silently wrong file, so it is refused by name. No
      // toolchain artefact is anywhere near that size; a manifest that recorded one would say so
      // here rather than in the unpacked tree.
      throw new ArchiveRefusal(
        "unsupported-entry",
        `${name} uses zip64 extended information, which this reader does not parse.`,
        name,
      );
    }
    // The high byte of `versionMadeBy` is the source filesystem; only a unix-made archive puts
    // permission bits in the high half of the external attributes.
    const unixMade = versionMadeBy >> 8 === 3;
    const mode = unixMade ? (externalAttributes >>> 16) & 0xffff : null;
    const isSymlink = mode !== null && (mode & S_IFMT) === S_IFLNK;
    const isDirectory =
      name.endsWith("/") || (mode !== null && (mode & S_IFMT) === S_IFDIR) || false;
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      crc32: crc,
      mode: mode === null ? null : mode & 0o7777,
      isDirectory,
      isSymlink,
      localHeaderOffset,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Unpack an archive into a directory that this call creates.
 *
 * The destination is expected to be a **staging** directory — one that nothing else can see yet —
 * because a half-unpacked tree under a name a caller may read is exactly the state
 * `download.ts`'s temp-then-rename exists to make impossible.
 */
export function extractZip(archiveFile: string, destination: string): ExtractionSummary {
  const archive = readFileSync(archiveFile);
  const entries = readZipEntries(archive);
  mkdirSync(destination, { recursive: true });
  const root = resolve(destination);
  const summary: ExtractionSummary = { files: 0, directories: 0, symlinks: 0, bytes: 0 };
  for (const entry of entries) {
    if (entry.name.startsWith("__MACOSX/")) {
      continue;
    }
    const target = safeJoin(destination, entry.name);
    if (entry.isDirectory) {
      mkdirSync(target, { recursive: true, mode: entry.mode ?? DEFAULT_DIRECTORY_MODE });
      summary.directories += 1;
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    const contents = readMember(archive, entry);
    if (entry.isSymlink) {
      const link = contents.toString("utf8");
      assertLinkStaysInside(root, target, link, entry.name);
      symlinkSync(link, target);
      summary.symlinks += 1;
      continue;
    }
    writeFileSync(target, contents, { mode: entry.mode ?? DEFAULT_FILE_MODE });
    // `writeFileSync`'s mode is a creation mode and a umask applies to it, so an executable bit is
    // set explicitly: an artefact unpacked under `umask 077` still has to be runnable.
    chmodSync(target, entry.mode ?? DEFAULT_FILE_MODE);
    summary.files += 1;
    summary.bytes += contents.length;
  }
  return summary;
}

/** The bytes of one member, decompressed and checked against the archive's own CRC-32. */
export function readMember(archive: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > archive.length || archive.readUInt32LE(offset) !== LOCAL_FILE_HEADER) {
    throw new ArchiveRefusal(
      "corrupt-entry",
      `${entry.name} has no local header at offset ${offset}.`,
      entry.name,
    );
  }
  const nameLength = archive.readUInt16LE(offset + 26);
  const extraLength = archive.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > archive.length) {
    throw new ArchiveRefusal(
      "corrupt-entry",
      `${entry.name} claims ${entry.compressedSize} compressed bytes and the archive ends first.`,
      entry.name,
    );
  }
  const raw = archive.subarray(start, end);
  let contents: Buffer;
  if (entry.method === STORED) {
    contents = Buffer.from(raw);
  } else if (entry.method === DEFLATED) {
    try {
      contents = inflateRawSync(raw);
    } catch (error) {
      throw new ArchiveRefusal(
        "corrupt-entry",
        `${entry.name} does not inflate: ${error instanceof Error ? error.message : String(error)}`,
        entry.name,
      );
    }
  } else {
    throw new ArchiveRefusal(
      "unsupported-entry",
      `${entry.name} uses compression method ${entry.method}; this reader does ` +
        `${STORED} (stored) and ${DEFLATED} (deflate).`,
      entry.name,
    );
  }
  if (contents.length !== entry.uncompressedSize) {
    throw new ArchiveRefusal(
      "corrupt-entry",
      `${entry.name} inflated to ${contents.length} bytes and the directory says ` +
        `${entry.uncompressedSize}.`,
      entry.name,
    );
  }
  const found = crc32(contents);
  if (found !== entry.crc32) {
    throw new ArchiveRefusal(
      "corrupt-entry",
      `${entry.name} has CRC-32 ${found.toString(16)} and the directory records ` +
        `${entry.crc32.toString(16)}.`,
      entry.name,
    );
  }
  return contents;
}

/**
 * Join an entry name onto a destination, refusing every name that could leave it.
 *
 * The check is on the **name** rather than on the resolved path, and it is done before a single
 * directory is created: `path.resolve` would happily produce a path outside the destination and
 * leave the caller to notice, and a name is refused here whatever the filesystem would have done
 * with it — including on Windows, where a backslash is a separator and `C:` is a root.
 */
export function safeJoin(destination: string, name: string): string {
  if (name === "") {
    throw new ArchiveRefusal("unsafe-entry", "The archive carries an entry with an empty name.");
  }
  if (name.includes("\\")) {
    throw new ArchiveRefusal(
      "unsafe-entry",
      `${name} carries a backslash, which is a path separator on Windows.`,
      name,
    );
  }
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name) || isAbsolute(name)) {
    throw new ArchiveRefusal("unsafe-entry", `${name} is an absolute path.`, name);
  }
  const parts = name.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) {
    throw new ArchiveRefusal(
      "unsafe-entry",
      `${name} climbs out of the directory it would be unpacked into.`,
      name,
    );
  }
  return join(destination, ...parts);
}

/**
 * A symlink may point anywhere **inside** the unpacked tree and nowhere outside it.
 *
 * Chrome's own macOS archives carry relative links that climb — `nested/link` → `../shell` — so a
 * blanket refusal of `..` would refuse the artefacts this exists to unpack. What matters is where
 * the link **lands**: resolved against its own directory, it has to stay under the destination,
 * because a link that escapes is also a door a later entry could be written through.
 */
function assertLinkStaysInside(root: string, target: string, link: string, name: string): void {
  const landing = resolve(dirname(target), link);
  const outside = relative(root, landing);
  if (isAbsolute(link) || outside === ".." || outside.startsWith(`..${sep}`)) {
    throw new ArchiveRefusal(
      "unsafe-entry",
      `${name} is a symlink to ${JSON.stringify(link)}, which lands outside the unpacked tree.`,
      name,
    );
  }
}

type CentralDirectoryEnd = { entryCount: number; centralDirectoryOffset: number };

/**
 * Find the end-of-central-directory record, taking the zip64 one where it is present.
 *
 * A zip is read backwards: the record can be up to 64 KiB from the end because of the archive
 * comment, and the 32-bit fields saturate at `0xffffffff` for archives past 4 GiB or 65 535
 * entries — which the artefacts here are not, but a reader that silently truncated at that
 * boundary would be wrong in a way no test on a small fixture could show.
 */
function findEndOfCentralDirectory(archive: Buffer): CentralDirectoryEnd {
  const minimum = Math.max(0, archive.length - 0x10000 - 22);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) !== END_OF_CENTRAL_DIRECTORY) {
      continue;
    }
    const entryCount = archive.readUInt16LE(offset + 10);
    const centralDirectoryOffset = archive.readUInt32LE(offset + 16);
    if (entryCount === 0xffff || centralDirectoryOffset === 0xffffffff) {
      return readZip64End(archive, offset);
    }
    return { entryCount, centralDirectoryOffset };
  }
  throw new ArchiveRefusal(
    "not-a-zip",
    "The file has no end-of-central-directory record, so it is not a zip archive.",
  );
}

function readZip64End(archive: Buffer, endOffset: number): CentralDirectoryEnd {
  const locator = endOffset - 20;
  if (locator < 0 || archive.readUInt32LE(locator) !== ZIP64_END_LOCATOR) {
    throw new ArchiveRefusal(
      "not-a-zip",
      "The archive says it is zip64 and carries no zip64 end-of-central-directory locator.",
    );
  }
  const recordOffset = Number(archive.readBigUInt64LE(locator + 8));
  if (
    recordOffset + 56 > archive.length ||
    archive.readUInt32LE(recordOffset) !== ZIP64_END_OF_CENTRAL_DIRECTORY
  ) {
    throw new ArchiveRefusal("not-a-zip", "The zip64 end-of-central-directory record is missing.");
  }
  return {
    entryCount: Number(archive.readBigUInt64LE(recordOffset + 32)),
    centralDirectoryOffset: Number(archive.readBigUInt64LE(recordOffset + 48)),
  };
}

/** The SHA-256 of a buffer, lowercase hex — the one digest form recorded anywhere here. */
export function sha256Of(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}
