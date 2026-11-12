/**
 * Reading a tarball — gzipped or xz-compressed — and writing out only the members this machine has
 * a use for.
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
 * {@link extractTar} takes a function from an archive member to the path it should land at, or to
 * `null`, and a skipped member costs one `subarray` walk past its body.
 *
 * **Two decompressors, and only the second is a dependency.** The npm registry serves gzip, which
 * `node:zlib` decodes. Both Linux FFmpeg pins — BtbN's `linux64` and `linuxarm64` builds — are
 * published **only** as `.tar.xz`, and Node has no xz decoder, so xz is `xz-decompress@0.2.3`: MIT,
 * no dependencies, no install script, XZ Embedded compiled to WebAssembly and inlined, owner-approved
 * and audited in [ADR 0031](../../../../docs/adr/0031-an-owned-renderer-replaces-remotion-ffmpeg-encodes.md)'s
 * note of 2026-11-12, which also carries its measurement on the real 128.7 MB linux-arm64 pin. The tar
 * parser below is the same for both; only the bytes it is handed differ.
 *
 * **Decoding can stop at the last member a caller wants** (`stopAfter`). The archive's digest is
 * verified before a byte of it is decoded (`download.ts`), so nothing after that member can change
 * what was written, and a build whose binary comes first need not inflate the documentation behind
 * it. What stopping gives up is the trailer check below, which exists only to notice a file changed
 * on disk *after* that verification. **An xz decoder is one per process and is not reentrant**:
 * `xz-decompress` instantiates one WebAssembly module and serialises every stream through a lock
 * that only a finished, failed or **cancelled** stream gives back — so an extraction that stops early
 * cancels the stream before it returns, or the next xz extraction in the process would wait for
 * ever.
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
import xzDecompress from "xz-decompress";
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

/** How a tarball's one compressed stream is decoded: gzip for an npm package, xz for an FFmpeg build. */
export type TarDecompressor = "gzip" | "xz";

/** How {@link extractTar} reads its archive. */
export type TarExtractOptions = {
  decompressor: TarDecompressor;
  /**
   * Archive member names — as the archive records them — after which decoding may stop.
   *
   * Once every one has been passed, the stream is cancelled and the extraction returns. It is an
   * economy and nothing more: a name the archive lacks costs the early stop, and whether a member
   * arrived is still the caller's to check, exactly as it is without this option.
   */
  stopAfter?: readonly string[];
};

/** What {@link extractTar} wrote. */
export type TarExtractionSummary = {
  files: number;
  directories: number;
  /** Members the selector walked past, which for a multi-platform package is most of them. */
  skipped: number;
  /** Total bytes written, so a caller can report a size without walking the tree. */
  bytes: number;
};

/**
 * Unpack the members `select` names out of a tarball.
 *
 * The destination is created; nothing else about it is assumed, because every caller hands it a
 * staging directory it is about to `rename` and would delete if this throws.
 */
export async function extractTar(
  archive: string,
  destination: string,
  select: TarSelector,
  options: TarExtractOptions,
): Promise<TarExtractionSummary> {
  const summary: TarExtractionSummary = { files: 0, directories: 0, skipped: 0, bytes: 0 };
  mkdirSync(destination, { recursive: true });

  /** The `stopAfter` names not yet passed; reaching none of them left is what ends the read. */
  const outstanding = new Set(options.stopAfter ?? []);
  const stopping = outstanding.size > 0;
  /** Whether every `stopAfter` member has been passed, so nothing after it needs decoding. */
  let complete = false;
  /** The name of the member whose body is being read, so its end can be noticed. */
  let current = "";
  const passed = (name: string): void => {
    outstanding.delete(name);
    complete = stopping && outstanding.size === 0;
  };

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

  try {
    for await (const chunk of decompressed(archive, options.decompressor)) {
      let cursor = 0;
      while (cursor < chunk.length && !complete) {
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
          if (remaining === 0) {
            if (sink !== null) {
              closeSync(sink);
              sink = null;
            }
            passed(current);
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
        current = header.name;
        sink = admit(header, destination, select, summary);
        if (remaining === 0) {
          if (sink !== null) {
            closeSync(sink);
            sink = null;
          }
          passed(current);
        }
      }
      if (complete) {
        // Leaving the loop is what cancels the stream: see `decompressed`.
        break;
      }
    }
  } finally {
    if (sink !== null) {
      closeSync(sink);
    }
  }

  if (complete) {
    return summary;
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

/**
 * The archive's one compressed stream, decoded, as `Buffer` chunks.
 *
 * A failure of the **decoder** — not the file read, which is rethrown as itself — is
 * `corrupt-stream`. An error the consumer throws never reaches the `catch` here: leaving a
 * `for await` early returns the generator rather than throwing into it, and that return is what
 * runs the `finally` that cancels an xz stream which has not ended (the module docblock says why
 * it must).
 */
async function* decompressed(
  archive: string,
  decompressor: TarDecompressor,
): AsyncGenerator<Buffer> {
  const file = createReadStream(archive);
  let readError: unknown;
  file.on("error", (error) => {
    readError = error;
  });
  if (decompressor === "gzip") {
    const gunzip = createGunzip();
    file.on("error", (error) => gunzip.destroy(error));
    try {
      for await (const chunk of file.pipe(gunzip)) {
        yield chunk as Buffer;
      }
    } catch (error) {
      throw readError ?? corruptStream(archive, decompressor, error);
    } finally {
      gunzip.destroy();
      file.destroy();
    }
    return;
  }
  // The decoder takes a web stream. Node's `Readable.toWeb` returns one whose declared type is not
  // the one `xz-decompress` names, so the file is handed over through the global constructor.
  const chunks = file[Symbol.asyncIterator]();
  const compressed = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done === true) {
        controller.close();
      } else {
        controller.enqueue(next.value as Buffer);
      }
    },
    async cancel() {
      await chunks.return?.();
    },
  });
  const reader = new xzDecompress.XzReadableStream(compressed).getReader();
  /** Whether the stream ended or failed by itself, so that there is nothing to cancel. */
  let settled = false;
  try {
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (error) {
        settled = true;
        throw readError ?? corruptStream(archive, decompressor, error);
      }
      if (next.done) {
        settled = true;
        return;
      }
      yield Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
    }
  } finally {
    if (!settled) {
      await reader.cancel();
    }
    file.destroy();
  }
}

/**
 * What XZ Embedded's `enum xz_ret` values mean, for the ones that are a refusal.
 *
 * `xz-decompress` reports a failure as `get_next_output failed with error code <n>` and no more, so
 * the sentence a user is shown comes from here.
 */
const XZ_FAILURES: Readonly<Record<string, string>> = {
  "2": "it uses an integrity check this decoder does not implement",
  "3": "the decoder could not allocate the memory it needs",
  "4": "it needs more memory than the decoder allows",
  "5": "it is not an xz stream",
  "6": "it uses xz options this decoder does not implement",
  "7": "its compressed data is corrupt, or an integrity check does not match it",
  "8": "it ends before the xz stream does",
};

/** The refusal for a stream its own decoder would not decode. */
function corruptStream(
  archive: string,
  decompressor: TarDecompressor,
  error: unknown,
): ArchiveRefusal {
  const detail = error instanceof Error ? error.message : String(error);
  const code = /error code (\d+)/.exec(detail)?.[1];
  const meaning =
    decompressor === "xz" && code !== undefined ? (XZ_FAILURES[code] ?? detail) : detail;
  return new ArchiveRefusal(
    "corrupt-stream",
    `${archive} does not decompress as ${decompressor}: ${meaning}. Its digest is checked before ` +
      "it is read, so either the file was changed on disk after that, or the pinned archive is " +
      "itself damaged.",
  );
}

/** The extensions each kind of tarball is published under. npm uses `.tgz`; BtbN, `.tar.xz`. */
const TARBALL_SUFFIXES: Readonly<Record<TarDecompressor, readonly string[]>> = {
  gzip: [".tgz", ".tar.gz"],
  xz: [".tar.xz"],
};

/**
 * Refuse an artefact this reader cannot unpack as `decompressor`, by extension and before it is
 * fetched.
 *
 * The counterpart of `download.ts`'s `assertZipArtefact`, and it exists for the same reason: the
 * check that costs nothing belongs before the hundred megabytes rather than after. The query string
 * is ignored for the same reason too — a URL is allowed to carry one. It is asked about one
 * decompressor rather than about "a tarball", because a `.tar.xz` handed to the gzip decoder would
 * pass a looser check and then fail a hundred megabytes later as a corrupt stream.
 */
export function assertTarballArtefact(url: string, decompressor: TarDecompressor): void {
  const pathname = new URL(url).pathname.toLowerCase();
  const suffixes = TARBALL_SUFFIXES[decompressor];
  if (!suffixes.some((suffix) => pathname.endsWith(suffix))) {
    throw new ArchiveRefusal(
      "not-a-tarball",
      `${url} is not a ${suffixes.join(" or a ")}, which is how a ${decompressor} tarball is ` +
        "published, so it is not the archive this reader was asked to unpack.",
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
