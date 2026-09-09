/**
 * A self-signed certificate, made in-process, for the tests that need a TLS listener.
 *
 * **This is a test fixture and never a product feature.** `daemon/tls.ts` deliberately has no
 * certificate generation in it: ADR 0020 §Security R-SEC-9 makes the operator supply the pair, and
 * a daemon that minted its own would be offering every client the choice between trusting it
 * blindly and not connecting. What the *tests* need is different — a real `https` listener with a
 * real handshake, on every platform, with no network and no `openssl` on `PATH` — so the fixture
 * builds one here.
 *
 * **Why the DER is written out by hand.** Node can generate a key pair and sign bytes, and it can
 * parse an X.509 certificate, but it cannot make one; the alternatives were spawning `openssl`
 * (present on the two POSIX runners and not dependably on `windows-latest`) or committing a PEM
 * private key to the repository. Both are worse than 100 lines of ASN.1: this one runs identically
 * on all three platforms, expires far enough out that no suite ever fails on the calendar, and puts
 * no key material in git.
 *
 * The certificate is a **CA** (`basicConstraints` `CA:TRUE`, critical) because that is what lets a
 * client pin it as its own trust anchor — `apps/desktop`'s `CertificateTrust.ca` and
 * `node:https`'s `ca:` both verify a self-signed chain root and reject a self-signed leaf — and it
 * carries a `subjectAltName` for every address it is asked for, so a pinning client can verify the
 * name as well as the signature rather than being pushed to `rejectUnauthorized: false`.
 */

import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { join } from "node:path";

const SEQUENCE = 0x30;
const SET = 0x31;
const INTEGER = 0x02;
const BIT_STRING = 0x03;
const OCTET_STRING = 0x04;
const OBJECT_IDENTIFIER = 0x06;
const BOOLEAN = 0x01;
const UTF8_STRING = 0x0c;
const UTC_TIME = 0x17;

/** DER's definite length: one byte below 128, otherwise a count byte and the big-endian bytes. */
function derLength(length: number): Buffer {
  if (length < 0x80) {
    return Buffer.from([length]);
  }
  const bytes: number[] = [];
  let rest = length;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** One DER element: tag, length, value. */
function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(value.length), value]);
}

function sequence(...parts: readonly Buffer[]): Buffer {
  return tlv(SEQUENCE, Buffer.concat([...parts]));
}

/** A `SET OF`, which in a `Name` is the relative distinguished name around each attribute. */
function setOf(...parts: readonly Buffer[]): Buffer {
  return tlv(SET, Buffer.concat([...parts]));
}

/** An `[n] EXPLICIT` wrapper — constructed, so the tag carries `0x20`. */
function explicit(number: number, inner: Buffer): Buffer {
  return tlv(0xa0 | number, inner);
}

/** An `[n] IMPLICIT` primitive, which is how `GeneralName` spells its alternatives. */
function implicit(number: number, content: Buffer): Buffer {
  return tlv(0x80 | number, content);
}

/** An OID in dotted form, base-128 encoded with the first two arcs folded into one byte. */
function objectIdentifier(dotted: string): Buffer {
  const arcs = dotted.split(".").map((arc) => Number(arc));
  const first = arcs[0] ?? 0;
  const second = arcs[1] ?? 0;
  const bytes: number[] = [first * 40 + second];
  for (const arc of arcs.slice(2)) {
    const chunks: number[] = [];
    let rest = arc;
    do {
      chunks.unshift(rest & 0x7f);
      rest = Math.floor(rest / 128);
    } while (rest > 0);
    for (let index = 0; index < chunks.length - 1; index += 1) {
      chunks[index] = (chunks[index] ?? 0) | 0x80;
    }
    bytes.push(...chunks);
  }
  return tlv(OBJECT_IDENTIFIER, Buffer.from(bytes));
}

/**
 * A non-negative INTEGER in **minimal** two's-complement form, which is what DER requires and what
 * OpenSSL enforces: redundant leading `0x00` bytes are stripped (a leading `0x00` is redundant
 * whenever the next byte's high bit is already clear), a single `0x00` is kept only when the first
 * significant byte has its high bit set — so a positive value is never read as negative — and the
 * value zero encodes as a single `0x00`.
 *
 * The serial number is `randomBytes(8)`, so roughly one draw in 512 begins `0x00` followed by a
 * high-bit-clear byte. The earlier encoder passed such a buffer through untouched, producing a BER
 * INTEGER with a redundant leading zero; OpenSSL rejects the whole certificate as
 * `illegal padding`. See {@link ./self-signed.test.ts} for the adversarial cases.
 */
export function minimalInteger(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) {
    start += 1;
  }
  let body = value.subarray(start);
  if (((body[0] ?? 0) & 0x80) !== 0) {
    body = Buffer.concat([Buffer.from([0]), body]);
  }
  return tlv(INTEGER, body);
}

/** A BIT STRING with no unused trailing bits, which is every one this file writes. */
function bitString(value: Buffer): Buffer {
  return tlv(BIT_STRING, Buffer.concat([Buffer.from([0]), value]));
}

/** `YYMMDDHHMMSSZ`, which is UTCTime and is why nothing here may be dated past 2049. */
function utcTime(when: Date): Buffer {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const text =
    `${pad(when.getUTCFullYear() % 100)}${pad(when.getUTCMonth() + 1)}${pad(when.getUTCDate())}` +
    `${pad(when.getUTCHours())}${pad(when.getUTCMinutes())}${pad(when.getUTCSeconds())}Z`;
  return tlv(UTC_TIME, Buffer.from(text, "ascii"));
}

/** A `Name` holding one `CN`, which is all a fixture needs. */
function commonName(value: string): Buffer {
  return sequence(
    setOf(sequence(objectIdentifier("2.5.4.3"), tlv(UTF8_STRING, Buffer.from(value, "utf8")))),
  );
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  const parts = critical
    ? [objectIdentifier(id), tlv(BOOLEAN, Buffer.from([0xff])), tlv(OCTET_STRING, value)]
    : [objectIdentifier(id), tlv(OCTET_STRING, value)];
  return sequence(...parts);
}

/** `subjectAltName`: an IPv4 literal becomes `iPAddress`, anything else `dNSName`. */
function subjectAltName(names: readonly string[]): Buffer {
  return sequence(
    ...names.map((name) =>
      isIPv4(name)
        ? implicit(7, Buffer.from(name.split(".").map((octet) => Number(octet))))
        : implicit(2, Buffer.from(name, "ascii")),
    ),
  );
}

function pem(label: string, der: Buffer): string {
  const body = der.toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${body}${body.endsWith("\n") ? "" : "\n"}-----END ${label}-----\n`;
}

/** What {@link selfSignedCertificate} is asked for. */
export type SelfSignedRequest = {
  /**
   * Every address or name the certificate is valid for.
   *
   * The first is also the `CN`. An IPv4 literal is recorded as an `iPAddress` and everything else
   * as a `dNSName`, which is the distinction a verifying client makes when the URL is an address.
   */
  names: readonly string[];
  /** How long it is valid for. Ten years by default, which outlives any suite. */
  years?: number;
};

/** A certificate and the key that signed it, in PEM, ready for `node:https`. */
export type SelfSignedCertificate = {
  cert: string;
  key: string;
};

/**
 * Generate a P-256 key pair and a self-signed certificate over it.
 *
 * P-256 rather than RSA because the generation is the whole cost — a fresh RSA-2048 key is tens to
 * hundreds of milliseconds and this is called per test — and because `ecdsa-with-SHA256` signatures
 * are already DER, which is exactly what the `signatureValue` BIT STRING wants.
 */
export function selfSignedCertificate(request: SelfSignedRequest): SelfSignedCertificate {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const subject = commonName(request.names[0] ?? "xplainer-test");
  const notBefore = new Date(Date.now() - 60_000);
  const notAfter = new Date(notBefore);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + (request.years ?? 10));

  // `ecdsa-with-SHA256`, whose parameters are absent rather than NULL.
  const algorithm = sequence(objectIdentifier("1.2.840.10045.4.3.2"));

  const tbs = sequence(
    explicit(0, tlv(INTEGER, Buffer.from([2]))),
    minimalInteger(randomBytes(8)),
    algorithm,
    subject,
    sequence(utcTime(notBefore), utcTime(notAfter)),
    subject,
    publicKey.export({ format: "der", type: "spki" }),
    explicit(
      3,
      sequence(
        // CA:TRUE, critical — see this file's header for why a pinned self-signed leaf is not enough.
        extension("2.5.29.19", true, sequence(tlv(BOOLEAN, Buffer.from([0xff])))),
        extension("2.5.29.17", false, subjectAltName(request.names)),
      ),
    ),
  );

  const certificate = sequence(tbs, algorithm, bitString(sign("sha256", tbs, privateKey)));

  return {
    cert: pem("CERTIFICATE", certificate),
    key: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

/** A generated pair, and where it was written. */
export type WrittenCertificate = SelfSignedCertificate & {
  certPath: string;
  keyPath: string;
};

/** {@link selfSignedCertificate}, written into `directory` as `tls.crt` and `tls.key`. */
export function writeSelfSignedCertificate(
  directory: string,
  request: SelfSignedRequest,
): WrittenCertificate {
  const material = selfSignedCertificate(request);
  const certPath = join(directory, "tls.crt");
  const keyPath = join(directory, "tls.key");
  writeFileSync(certPath, material.cert, { mode: 0o600 });
  writeFileSync(keyPath, material.key, { mode: 0o600 });
  return { ...material, certPath, keyPath };
}
