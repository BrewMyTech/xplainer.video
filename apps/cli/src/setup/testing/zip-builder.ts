/**
 * A minimal zip writer, for the archives no ordinary archiver will produce.
 *
 * The happy path is anchored on a **real** archive — `fixtures/toolchain-fixture.zip`, written by
 * the system `zip`, carrying a directory, a symlink, an executable and both compression methods —
 * because a reader checked only against its own writer proves that the two agree and nothing else.
 * What that anchor cannot supply is a *hostile* archive: an entry named `../../etc/passwd`, a
 * symlink pointing out of the tree, a member whose CRC does not match its bytes, a compression
 * method nothing uses. Every one of those has to be built deliberately, and this is the smallest
 * thing that builds them.
 *
 * Stored entries only, which is all a refusal case needs. Nothing here ships:
 * `tsconfig.build.json` excludes `src/**\/testing/**`.
 */

import { crc32 } from "node:zlib";

/** One member to write. */
export type ZipMemberSpec = {
  /** The name exactly as it should appear in the archive, including any `../` under test. */
  name: string;
  /** The member's bytes, or the link target where `symlink` is set. */
  contents: string | Buffer;
  /** Unix permission bits. Defaults to `0644` for a file and `0755` for a directory. */
  mode?: number;
  /** Write the entry as a symlink whose target is `contents`. */
  symlink?: boolean;
  /** Write the entry as a directory. `contents` is then ignored. */
  directory?: boolean;
  /** Record a CRC-32 other than the one the bytes have — the corrupt-member case. */
  crcOverride?: number;
  /** Record a compression method other than stored, without compressing — the unsupported case. */
  methodOverride?: number;
};

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const UNIX_MADE_BY = (3 << 8) | 20;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

/** Build a zip archive in memory. */
export function buildZip(members: ZipMemberSpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.name, "utf8");
    const body = member.directory
      ? Buffer.alloc(0)
      : Buffer.isBuffer(member.contents)
        ? member.contents
        : Buffer.from(member.contents, "utf8");
    const crc = member.crcOverride ?? crc32(body);
    const method = member.methodOverride ?? 0;
    const mode = member.mode ?? (member.directory ? 0o755 : 0o644);
    const kind = member.directory ? S_IFDIR : member.symlink ? S_IFLNK : S_IFREG;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(UNIX_MADE_BY, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(((kind | mode) >>> 0) * 0x10000, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDirectory, end]);
}
