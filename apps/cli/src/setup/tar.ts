/**
 * Reading a gzipped tarball, and writing out only the members this machine has a use for.
 *
 * `archive.ts` opens by saying that every artefact `setup` fetches is a zip, and until the ONNX
 * speech route that was true. It is no longer: **ONNX Runtime's Node binding exists only inside the
 * `onnxruntime-node` npm tarball**, and the npm registry serves `.tgz` and nothing else. That is
 * not a preference and it was checked rather than assumed — Microsoft's own per-platform release
 * archives (`onnxruntime-osx-arm64-1.29.0.tgz` and its three siblings) carry the C shared library,
 * the headers and the CMake package, and **no `onnxruntime_binding.node`** (listed on 2026-09-10;
 * `onnxruntime-linux-x64-1.29.0.tgz` holds `lib/libonnxruntime.so.1.29.0`, `include/`, `lib/cmake/`
 * and nothing else). So there is no zip anywhere that contains what the runtime needs, and this
 * reader is the alternative to a new runtime dependency in the one published application.
 *
 * **Why a reader and not `tar`.** The same argument `archive.ts` makes for zip, plus one more that
 * only applies here. Shelling out to the system archiver would put the safety property in somebody
 * else's hands: GNU tar, bsdtar and Windows' `tar.exe` disagree about flags, about
 * `--strip-components`, and about what they do with an absolute member name. This reader refuses an
 * unsafe name through {@link safeJoin} — literally the same function the zip reader uses, because
 * it is the same rule — and it writes nothing it has not first accepted.
 *
 * **What "refuse before writing" means for a tar, which has no index.** A zip ends with a central
 * directory, so `extractZip` can judge every member before it creates a file. A tar is a stream of
 * headers interleaved with bodies and has no index at all, so the honest property here is narrower:
 * every member is judged **before that member is opened**, and the whole extraction goes into a
 * staging directory that `acquireArtefact` deletes unless the extraction returns. A refusal
 * therefore still commits nothing, which is the property that actually matters; what it cannot
 * promise is that no byte was written under the staging name before the refusal.
 *
 * **It streams, and that is a measurement rather than a style.** `gunzipSync` on
 * `onnxruntime-node-1.29.0.tgz` would hold 111,735,068 compressed bytes and 296,334,136
 * decompressed ones in two live Buffers at once; this parser holds one 64 KiB read chunk, one
 * 512-byte header and an open file descriptor. `setup` is a command a user watches, on a machine
 * whose narration worker already peaks near 750 MB, so a third of a gigabyte held to copy 42 MB out
 * of an archive is a cost with nothing to buy.
 *
 * **The selector is the point of the module.** Callers do not extract a tarball here — they extract
 * the members they name. `onnxruntime-node` ships every platform in one package (five `napi-v6`
 * subtrees, 296 MB unpacked), and the whole reason the runtime is an acquired component rather than
 * a dependency is that a machine should hold its own platform and no other. So
 * {@link extractTarGz} takes a function from an archive member to the path it should land at, or to
 * `null`, and a skipped member costs one `subarray` walk past its body.
 *
 * **Every member type but a file and a directory is refused by name**, and the reason it is safe to
 * be that strict is that every tarball this reader is pointed at is **pinned by digest**. An entry
 * type this build does not know therefore cannot appear in an archive that was reviewed — it can
 * only mean the pin moved, which is a reviewed change and one a test would meet first. Measured on
 * the two pinned archives, 2026-09-10: 43 and 193 members, every one typeflag `0`, `ustar`
 * magic, no `prefix` field in use, longest name 60 characters. A pax extended header, a hardlink,
 * a device node or a GNU long name would all be new facts about a file we have a digest for.
 */

import { closeSync, createReadStream, existsSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { createGunzip } from "node:zlib";
import { ArchiveRefusal, safeJoin } from "./archive.js";

/** One tar header block. */
const BLOCK = 512;

/** Where each field this reader reads lives in a header block, per POSIX ustar. */
const NAME = { at: 0, length: 100 } as const;
const MODE = { at: 100, length: 8 } as const;
const SIZE = { at: 124, length: 12 } as const;
const CHECKSUM = { at: 148, length: 8 } as const;
const TYPEFLAG = 156;
const MAGIC = { at: 257, length: 6 } as const;
const PREFIX = { at: 345, length: 155 } as const;

/** The typeflags this reader writes. Everything else is a refusal — see the module docblock. */
const REGULAR_FILE = "0";
const DIRECTORY = "5";

/** What the two magics mean: POSIX ustar, and the GNU spelling of the same field. */
const MAGICS: ReadonlySet<string> = new Set(["ustar", "ustar "]);

/** The default mode a member with an unreadable one gets, matching `archive.ts`. */
const DEFAULT_FILE_MODE = 0o644;

/** One member of a tarball, as its own header block describes it. */
export type TarHeader = {
  /** The full name, `/`-separated, with the `prefix` field already joined on where there is one. */
  name: string;
  /** The body's length in bytes. Padding up to the next 512-byte block is not part of it. */
  size: number;
  /** Unix permission bits, masked to the low nine. */
  mode: number;
  /** The raw typeflag character, so a refusal can name what it met. */
  typeflag: string;
  isDirectory: boolean;
};

/**
 * Which members to write, and where.
 *
 * Answer with a **destination-relative** path to write the member there, or `null` to walk past it.
 * The path is checked by {@link safeJoin} whatever it says, because a selector that composed one
 * out of an archive-supplied name would otherwise be a way around the check.
 */
export type TarSelector = (header: TarHeader) => string | null;

/** What {@link extractTarGz} wrote. */
export type TarExtractionSummary = {
  files: number;
  directories: number;
  /** Members the selector walked past, which for a multi-platform package is most of them. */
  skipped: number;
  /** Total bytes written, so a caller can report a size without walking the tree. */
  bytes: number;
};

/**
 * Unpack the members `select` names out of a gzipped tarball.
 *
 * The destination is created; nothing else about it is assumed, because the one caller hands it a
 * staging directory it is about to `rename` and would delete if this throws.
 */
export async function extractTarGz(
  archive: string,
  destination: string,
  select: TarSelector,
): Promise<TarExtractionSummary> {
  const summary: TarExtractionSummary = { files: 0, directories: 0, skipped: 0, bytes: 0 };
  mkdirSync(destination, { recursive: true });

  /** Header bytes seen so far, when a read chunk ended part way through a header block. */
  let pending: Buffer = Buffer.alloc(0);
  /** Body bytes of the current member still to come. */
  let remaining = 0;
  /** Padding bytes after the current member's body still to come. */
  let padding = 0;
  /** The open descriptor for the current member, or `null` while one is being skipped. */
  let sink: number | null = null;
  /** Whether the two-zero-block trailer has been reached; anything after it is not a member. */
  let trailer = false;

  const source = createReadStream(archive).pipe(createGunzip());
  try {
    for await (const raw of source) {
      const chunk = raw as Buffer;
      let cursor = 0;
      while (cursor < chunk.length) {
        if (trailer) {
          // A tarball is padded to a fixed block factor, so the trailer is followed by zeroes that
          // are part of the file and not part of the archive.
          break;
        }
        if (remaining > 0) {
          const take = Math.min(remaining, chunk.length - cursor);
          if (sink !== null) {
            writeSync(sink, chunk, cursor, take);
            summary.bytes += take;
          }
          cursor += take;
          remaining -= take;
          if (remaining === 0 && sink !== null) {
            closeSync(sink);
            sink = null;
          }
          continue;
        }
        if (padding > 0) {
          const take = Math.min(padding, chunk.length - cursor);
          cursor += take;
          padding -= take;
          continue;
        }
        const want = BLOCK - pending.length;
        const take = Math.min(want, chunk.length - cursor);
        const slice = chunk.subarray(cursor, cursor + take);
        pending = pending.length === 0 ? slice : Buffer.concat([pending, slice]);
        cursor += take;
        if (pending.length < BLOCK) {
          continue;
        }
        const block = pending;
        pending = Buffer.alloc(0);
        if (isZeroBlock(block)) {
          trailer = true;
          continue;
        }
        const header = readHeader(block, archive);
        remaining = header.size;
        padding = (BLOCK - (header.size % BLOCK)) % BLOCK;
        sink = admit(header, destination, select, summary);
      }
    }
  } finally {
    if (sink !== null) {
      closeSync(sink);
    }
    source.destroy();
  }

  if (!trailer) {
    throw new ArchiveRefusal(
      "not-a-tarball",
      `${archive} ended without a tar trailer, so the archive is truncated even though its ` +
        "digest was verified — which means the file on disk was changed after it was checked.",
    );
  }
  if (pending.length !== 0 || remaining !== 0) {
    throw new ArchiveRefusal(
      "not-a-tarball",
      `${archive} ended part way through a member: ${pending.length} bytes of a header block and ` +
        `${remaining} bytes of a body were still expected.`,
    );
  }
  return summary;
}

/**
 * Judge one member and open it, or answer `null` for one that is being walked past.
 *
 * A directory is created here and counted; a file gets its descriptor. The order is deliberate:
 * the typeflag is refused before the name is joined, so an unknown member type is reported as
 * itself rather than as whatever its name happened to look like.
 */
function admit(
  header: TarHeader,
  destination: string,
  select: TarSelector,
  summary: TarExtractionSummary,
): number | null {
  if (header.typeflag !== REGULAR_FILE && header.typeflag !== DIRECTORY) {
    throw new ArchiveRefusal(
      "unsupported-entry",
      `${header.name} is a tar member of type ${JSON.stringify(header.typeflag)}, and this ` +
        "reader writes only regular files and directories. Every tarball setup fetches is pinned " +
        "by digest, so a member type this build does not know cannot be in a reviewed archive — " +
        "it means the pin moved.",
      header.name,
    );
  }
  const relative = select(header);
  if (relative === null) {
    summary.skipped += 1;
    return null;
  }
  const target = safeJoin(destination, relative);
  if (header.isDirectory) {
    mkdirSync(target, { recursive: true });
    summary.directories += 1;
    return null;
  }
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) {
    throw new ArchiveRefusal(
      "unsafe-entry",
      `${header.name} would be written to ${target}, which another member of the same archive has ` +
        "already been written to. Two members landing on one path means the selector collapsed " +
        "two distinct files, and the later one would silently win.",
      header.name,
    );
  }
  summary.files += 1;
  return openSync(target, "wx", header.mode);
}

/** Read and check one header block. */
function readHeader(block: Buffer, archive: string): TarHeader {
  assertChecksum(block, archive);
  const magic = text(block, MAGIC.at, MAGIC.length);
  if (!MAGICS.has(magic)) {
    throw new ArchiveRefusal(
      "not-a-tarball",
      `${archive} carries a header whose magic is ${JSON.stringify(magic)} rather than "ustar", ` +
        "so it is not a POSIX tar this reader can read.",
    );
  }
  const name = text(block, NAME.at, NAME.length);
  const prefix = text(block, PREFIX.at, PREFIX.length);
  const full = prefix === "" ? name : `${prefix}/${name}`;
  const size = octal(block, SIZE.at, SIZE.length, full, "size");
  const mode = octal(block, MODE.at, MODE.length, full, "mode");
  // A `0` typeflag and a NUL both mean a regular file; the second spelling is what pre-POSIX
  // writers emit and what a name-only header carries.
  const raw = block[TYPEFLAG] ?? 0;
  const typeflag = raw === 0 ? REGULAR_FILE : String.fromCharCode(raw);
  return {
    name: full,
    size,
    mode: (mode & 0o777) === 0 ? DEFAULT_FILE_MODE : mode & 0o777,
    typeflag,
    isDirectory: typeflag === DIRECTORY,
  };
}

/**
 * The header's own checksum, which is the tar analogue of the zip's per-member CRC-32.
 *
 * Checked for the same reason `archive.ts` checks the CRC: the SHA-256 covers the whole archive and
 * says nothing about which 512 bytes are a header, so a header read at the wrong offset — the one
 * way a streaming parser can go wrong — produces a name and a size out of somebody's file contents.
 * The checksum is the field that catches it, and it catches it before the name is used.
 *
 * Both the unsigned and the signed sum are accepted, because historic writers on platforms with a
 * signed `char` produced the second, and agreeing with the archives that exist matters more than
 * being right about the ones that should.
 */
function assertChecksum(block: Buffer, archive: string): void {
  const declared = octal(block, CHECKSUM.at, CHECKSUM.length, archive, "checksum");
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    const byte =
      index >= CHECKSUM.at && index < CHECKSUM.at + CHECKSUM.length ? 0x20 : (block[index] ?? 0);
    unsigned += byte;
    signed += byte > 0x7f ? byte - 0x100 : byte;
  }
  if (declared !== unsigned && declared !== signed) {
    throw new ArchiveRefusal(
      "corrupt-entry",
      `${archive} carries a tar header whose checksum is ${declared} and whose bytes sum to ` +
        `${unsigned}. A header that does not check out is a header read at the wrong offset, and ` +
        "the name and size in it describe nothing.",
    );
  }
}

/** A NUL-terminated field as a string. */
function text(block: Buffer, at: number, length: number): string {
  const field = block.subarray(at, at + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

/**
 * A numeric field, which POSIX writes as an octal string.
 *
 * GNU's base-256 encoding for values an octal field cannot hold sets the high bit of the first
 * byte, and it is **refused rather than decoded**: a 12-byte octal field reaches 8 GiB and a
 * 8-byte one reaches 2 MiB, so nothing in a pinned npm tarball needs the extension, and a reader
 * that decoded a format it has no archive to test against would be untested code in the one place
 * a wrong answer is a wrong file length.
 */
function octal(block: Buffer, at: number, length: number, entry: string, field: string): number {
  const first = block[at] ?? 0;
  if ((first & 0x80) !== 0) {
    throw new ArchiveRefusal(
      "unsupported-entry",
      `${entry}'s ${field} field is GNU base-256 encoded, which this reader does not decode. No ` +
        "member of a pinned npm tarball is large enough to need it.",
      entry,
    );
  }
  const digits = text(block, at, length).replace(/[\s\0]/g, "");
  if (digits === "") {
    return 0;
  }
  if (!/^[0-7]+$/.test(digits)) {
    throw new ArchiveRefusal(
      "corrupt-entry",
      `${entry}'s ${field} field is ${JSON.stringify(digits)}, which is not an octal number.`,
      entry,
    );
  }
  return Number.parseInt(digits, 8);
}

/** The extensions a gzipped tarball is published under. npm uses the first. */
const TARBALL_SUFFIXES: readonly string[] = [".tgz", ".tar.gz"];

/**
 * Refuse an artefact this reader cannot unpack, by extension and before it is fetched.
 *
 * The counterpart of `download.ts`'s `assertZipArtefact`, and it exists for the same reason: the
 * check that costs nothing belongs before the hundred megabytes rather than after. The query string
 * is ignored for the same reason too — a URL is allowed to carry one.
 */
export function assertTarballArtefact(url: string): void {
  const pathname = new URL(url).pathname.toLowerCase();
  if (!TARBALL_SUFFIXES.some((suffix) => pathname.endsWith(suffix))) {
    throw new ArchiveRefusal(
      "not-a-tarball",
      `${url} is not a ${TARBALL_SUFFIXES.join(" or a ")}, and this reader unpacks nothing else. ` +
        "Every tarball setup fetches is an npm package, and the registry serves them as .tgz.",
    );
  }
}

/** Whether a block is the all-zero one that ends the archive. */
function isZeroBlock(block: Buffer): boolean {
  for (let index = 0; index < block.length; index += 1) {
    if (block[index] !== 0) {
      return false;
    }
  }
  return true;
}
