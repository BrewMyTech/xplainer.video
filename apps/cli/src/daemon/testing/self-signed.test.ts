/**
 * The DER INTEGER encoder, and the certificates it puts serial numbers into.
 *
 * The serial number is `randomBytes(8)`, so this fixture generates a *distribution* of serials, and
 * one draw in roughly 512 begins `0x00` followed by a byte whose high bit is clear. An encoder that
 * passes that buffer through untouched emits a BER INTEGER with a redundant leading zero, which
 * OpenSSL rejects for the whole certificate with `illegal padding` — a non-deterministic failure
 * that surfaced once on a real run (`serve.test.ts`, daemon-restart windows run 34345911996) and
 * would otherwise reappear at random. The two suites below make the regression deterministic: the
 * first drives {@link minimalInteger} over the adversarial inputs and asserts the exact minimal
 * bytes, and the second generates a thousand certificates and parses each with the same
 * `X509Certificate` the render and TLS paths use.
 */

import { X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import { minimalInteger, selfSignedCertificate } from "./self-signed.js";

/** The bytes of a minimal DER INTEGER: tag `0x02`, length, value. */
function encode(...input: readonly number[]): number[] {
  return [...minimalInteger(Buffer.from(input))];
}

describe("minimalInteger encodes a minimal two's-complement DER INTEGER", () => {
  it("strips a redundant leading zero when the next byte's high bit is clear", () => {
    // 0x00 0x3f -> 0x3f: the leading zero carries no information and is BER, not DER.
    expect(encode(0x00, 0x3f)).toEqual([0x02, 0x01, 0x3f]);
  });

  it("keeps exactly one leading zero when the first significant byte's high bit is set", () => {
    // 0x00 0x80 -> 0x00 0x80: without the zero, 0x80 reads as a negative value.
    expect(encode(0x00, 0x80)).toEqual([0x02, 0x02, 0x00, 0x80]);
  });

  it("encodes an all-zero buffer as a single zero byte", () => {
    expect(encode(0x00)).toEqual([0x02, 0x01, 0x00]);
    expect(encode(0x00, 0x00, 0x00)).toEqual([0x02, 0x01, 0x00]);
  });

  it("prepends a zero to a bare high-bit-set first byte", () => {
    expect(encode(0x80)).toEqual([0x02, 0x02, 0x00, 0x80]);
    expect(encode(0xff, 0x01)).toEqual([0x02, 0x03, 0x00, 0xff, 0x01]);
  });

  it("keeps one zero and no more across a multi-byte high-bit-set value", () => {
    // 0x00 0x80 0x00 0x01: the input's leading zero is stripped and a single fresh one prepended
    // because 0x80's high bit is set, so the minimal form is the same four bytes and no more.
    expect(encode(0x00, 0x80, 0x00, 0x01)).toEqual([0x02, 0x04, 0x00, 0x80, 0x00, 0x01]);
  });

  it("passes an already-minimal positive value through unchanged", () => {
    expect(encode(0x3f, 0x00, 0xff)).toEqual([0x02, 0x03, 0x3f, 0x00, 0xff]);
  });
});

describe("every generated certificate is valid DER OpenSSL accepts", () => {
  it("parses a thousand certificates, whatever serial the random draw produces", () => {
    for (let index = 0; index < 1000; index += 1) {
      const { cert } = selfSignedCertificate({ names: ["192.0.2.10"] });
      // X509Certificate is OpenSSL's parser; a BER serial fails here with `illegal padding`.
      const parsed = new X509Certificate(cert);
      expect(parsed.serialNumber.length).toBeGreaterThan(0);
    }
  });
});
