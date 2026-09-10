/**
 * A minimal tar writer, for the archives no ordinary archiver will produce.
 *
 * The happy path is anchored on a **real** archive — `fixtures/npm-package-fixture.tgz`, written by
 * `npm pack` and therefore by node-tar, the writer whose output the reader will actually meet —
 * because a reader checked only against its own writer proves that the two agree and nothing else.
 * What that anchor cannot supply is a *hostile* archive: a member named `../../etc/passwd`, a
 * header whose checksum does not match its bytes, a member type this reader refuses, a stream that
 * stops in the middle. Every one of those has to be built deliberately, and this is the smallest
 * thing that builds them.
 *
 * Nothing here ships: `tsconfig.build.json` excludes `src/**\/testing/**`.
 */

import { gzipSync } from "node:zlib";

/** One member to write. */
export type TarMemberSpec = {
  /** The name exactly as it should appear in the archive, including any `../` under test. */
  name: string;
  /** The member's bytes. Ignored for a directory. */
  contents?: string | Buffer;
  /** Unix permission bits. Defaults to `0644` for a file and `0755` for a directory. */
  mode?: number;
  /** The typeflag, so a member type the reader refuses can be written on purpose. `0` by default. */
  typeflag?: string;
  /** Record a header checksum other than the one the bytes have — the corrupt-header case. */
  checksumOverride?: number;
  /** Write a magic other than `ustar` — the not-a-tarball case. */
  magicOverride?: string;
  /**
   * Write these twelve bytes as the size field, before the checksum is computed over them.
   *
   * The one way to build a GNU base-256 size field — high bit of the first byte set — that a reader
   * meets as a *size* problem rather than as a checksum problem. Editing an archive by hand cannot
   * produce it, because the checksum guards the field.
   */
  rawSize?: Buffer;
};

/** One tar block. */
const BLOCK = 512;

/** Where the checksum field is, which is also the range the checksum itself treats as spaces. */
const CHECKSUM_AT = 148;
const CHECKSUM_LENGTH = 8;

/**
 * Build a tar archive in memory, without the two-block trailer.
 *
 * Separate from {@link buildTarGz} so a test can prove that a stream ending without a trailer is
 * refused — which is the one truncation a digest cannot catch, because the digest is of the
 * compressed file and a caller can hand this reader a file that was verified and then edited.
 */
export function buildTar(members: readonly TarMemberSpec[], trailer = true): Buffer {
  const blocks: Buffer[] = [];
  for (const member of members) {
    const body =
      member.contents === undefined
        ? Buffer.alloc(0)
        : Buffer.isBuffer(member.contents)
          ? member.contents
          : Buffer.from(member.contents, "utf8");
    const typeflag = member.typeflag ?? "0";
    const mode = member.mode ?? (typeflag === "5" ? 0o755 : 0o644);
    blocks.push(header(member, body.length, mode, typeflag));
    if (body.length > 0) {
      blocks.push(body, Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK));
    }
  }
  if (trailer) {
    blocks.push(Buffer.alloc(BLOCK * 2));
  }
  return Buffer.concat(blocks);
}

/** The same, gzipped, which is what every reader in this package is handed. */
export function buildTarGz(members: readonly TarMemberSpec[], trailer = true): Buffer {
  return gzipSync(buildTar(members, trailer));
}

/** One ustar header block, with the checksum computed last so an override can replace it. */
function header(member: TarMemberSpec, size: number, mode: number, typeflag: string): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(member.name, 0, 100, "utf8");
  writeOctal(block, 100, 8, mode);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  if (member.rawSize === undefined) {
    writeOctal(block, 124, 12, size);
  } else {
    member.rawSize.copy(block, 124, 0, 12);
  }
  writeOctal(block, 136, 12, 0);
  block.write(" ".repeat(CHECKSUM_LENGTH), CHECKSUM_AT, CHECKSUM_LENGTH, "utf8");
  block.write(typeflag, 156, 1, "utf8");
  block.write(member.magicOverride ?? "ustar\0", 257, 8, "utf8");
  block.write("00", 263, 2, "utf8");
  const sum = member.checksumOverride ?? checksum(block);
  // The field is six octal digits, a NUL and a space — the form GNU tar writes and every reader
  // accepts, and the reason the seventh and eighth bytes are not digits.
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, CHECKSUM_AT, CHECKSUM_LENGTH, "utf8");
  return block;
}

/** A numeric field: octal, NUL-terminated, zero-padded — POSIX's own spelling. */
function writeOctal(block: Buffer, at: number, length: number, value: number): void {
  block.write(`${value.toString(8).padStart(length - 1, "0")}\0`, at, length, "utf8");
}

/** The unsigned sum of every header byte, with the checksum field read as spaces. */
function checksum(block: Buffer): number {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += block[index] ?? 0;
  }
  return sum;
}
