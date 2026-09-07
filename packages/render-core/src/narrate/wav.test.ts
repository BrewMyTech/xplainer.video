import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NarrationError } from "./errors.js";
import {
  decodeWav,
  encodeWav,
  type PcmFormat,
  pcmDurationMs,
  pcmFrameBytes,
  samePcmFormat,
  silenceSamples,
  silentFrames,
} from "./wav.js";

/**
 * The RIFF reader is the one place this port touches a binary format, so it is
 * tested against WAV files this repository did not write: the two fixtures were
 * produced by Python's standard-library `wave` module, the same encoder the
 * reference implementation reads and writes with. A reader tested only against
 * its own writer proves that two bugs agree.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures");
const NARRATE_FIXTURES = join(FIXTURES, "narrate");

/** Kokoro's format, and the fixtures': mono 16-bit at 24 kHz. */
const KOKORO_FORMAT: PcmFormat = { channels: 1, sampleWidth: 2, sampleRate: 24000 };

function fixture(name: string): Buffer {
  return readFileSync(join(NARRATE_FIXTURES, name));
}

/** A `fmt `/`data` WAV built by hand, so a header field can be made wrong on purpose. */
function handBuiltWav(options: {
  tag: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  data: Buffer;
}): Buffer {
  const header = Buffer.alloc(44);
  const blockAlign = options.channels * (options.bitsPerSample / 8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + options.data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(options.tag, 20);
  header.writeUInt16LE(options.channels, 22);
  header.writeUInt32LE(options.sampleRate, 24);
  header.writeUInt32LE(options.sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(options.bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(options.data.length, 40);
  return Buffer.concat([header, options.data]);
}

describe("decodeWav, against WAVs written by Python's wave module", () => {
  it("reads the format and every frame of the hook fixture", () => {
    const audio = decodeWav(fixture("hook.wav"));

    expect(audio.format).toEqual(KOKORO_FORMAT);
    // 2.35 s at 24 kHz, mono, two bytes per sample.
    expect(audio.data.length).toBe(56400 * 2);
    expect(pcmDurationMs(audio.format, audio.data.length)).toBeCloseTo(2350, 6);
  });

  it("reads the cause fixture, whose length differs", () => {
    const audio = decodeWav(fixture("cause.wav"));

    expect(audio.format).toEqual(KOKORO_FORMAT);
    expect(audio.data.length).toBe(18000 * 2);
  });

  it("returns the sample values, not silence", () => {
    const audio = decodeWav(fixture("hook.wav"));

    // The fixture is a sine, so some sample in the first millisecond is non-zero.
    const firstMs = audio.data.subarray(0, 48);
    expect([...firstMs].some((byte) => byte !== 0)).toBe(true);
  });

  it("skips a chunk it does not know, honouring the RIFF padding byte", () => {
    const canonical = fixture("cause.wav");
    const body = Buffer.from("xplainer", "ascii");
    const list = Buffer.alloc(8);
    list.write("LIST", 0, "ascii");
    // An odd size, so the reader must step over the pad byte to find `fmt `.
    list.writeUInt32LE(body.length - 1, 4);
    const withList = Buffer.concat([
      canonical.subarray(0, 12),
      list,
      body.subarray(0, body.length - 1),
      Buffer.alloc(1),
      canonical.subarray(12),
    ]);
    withList.writeUInt32LE(withList.length - 8, 4);

    expect(decodeWav(withList)).toEqual(decodeWav(canonical));
  });
});

/**
 * Rebuild a canonical WAV the way `kokoro-fastapi` writes one: the sizes it did not know when it
 * wrote the header left at the all-ones sentinel, and a `LIST` chunk between `fmt ` and `data`.
 *
 * The layout is copied from a live container's answer to `POST /dev/captioned_speech` with
 * `stream: false` — `RIFF ffffffff WAVE`, `fmt ` 16, `LIST` 26, `data ffffffff` — which is the
 * shape every real narration decodes.
 */
function streamingWav(canonical: Buffer): Buffer {
  const audio = decodeWav(canonical);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(0xffff_ffff, 4);
  head.write("WAVE", 8, "ascii");

  const fmt = Buffer.from(canonical.subarray(12, 36));

  const listBody = Buffer.alloc(26);
  listBody.write("INFOISFT", 0, "ascii");
  const list = Buffer.alloc(8);
  list.write("LIST", 0, "ascii");
  list.writeUInt32LE(listBody.length, 4);

  const dataHeader = Buffer.alloc(8);
  dataHeader.write("data", 0, "ascii");
  dataHeader.writeUInt32LE(0xffff_ffff, 4);

  return Buffer.concat([head, fmt, list, listBody, dataHeader, audio.data]);
}

describe("decodeWav, against the streaming header Kokoro actually sends", () => {
  it("reads a data chunk sized 0xffffffff to the end of the payload", () => {
    const canonical = fixture("cause.wav");

    const streamed = decodeWav(streamingWav(canonical));

    expect(streamed).toEqual(decodeWav(canonical));
  });

  it("keeps the LIST chunk between fmt and the sentinel-sized data out of the audio", () => {
    const canonical = fixture("hook.wav");
    const streaming = streamingWav(canonical);

    const streamed = decodeWav(streaming);

    expect(streamed.format).toEqual(KOKORO_FORMAT);
    expect(streamed.data.length).toBe(decodeWav(canonical).data.length);
    // The whole payload minus the 12-byte RIFF head, the 24-byte `fmt ` chunk, the 34-byte `LIST`
    // chunk and the 8-byte `data` header: nothing of the container leaked into the samples.
    expect(streamed.data.length).toBe(streaming.length - 12 - 24 - 34 - 8);
  });
});

describe("decodeWav refuses what it cannot honestly read", () => {
  it("refuses bytes that are not RIFF/WAVE", () => {
    expect(() => decodeWav(Buffer.from("this is a JSON error body, not audio"))).toThrow(
      /RIFF\/WAVE header/,
    );
  });

  it("refuses a payload too short to hold a header", () => {
    expect(() => decodeWav(Buffer.from("RIFF"))).toThrow(/too short/);
  });

  it("refuses IEEE float PCM, whose zero frame is silence but whose bytes are not ours", () => {
    const float = handBuiltWav({
      tag: 3,
      channels: 1,
      sampleRate: 24000,
      bitsPerSample: 32,
      data: Buffer.alloc(64),
    });

    expect(() => decodeWav(float)).toThrow(/format tag is 3/);
  });

  it("refuses 8-bit PCM, where a zeroed frame is full-scale negative rather than silence", () => {
    const eightBit = handBuiltWav({
      tag: 1,
      channels: 1,
      sampleRate: 24000,
      bitsPerSample: 8,
      data: Buffer.alloc(64),
    });

    expect(() => decodeWav(eightBit)).toThrow(/8-bit/);
  });

  it("refuses a chunk whose declared size runs past the end of the payload", () => {
    const truncated = Buffer.from(fixture("cause.wav").subarray(0, 200));

    expect(() => decodeWav(truncated)).toThrow(/only \d+ remain/);
  });

  it("still refuses a size that is merely too large, so a truncated download is not read short", () => {
    const truncated = Buffer.from(fixture("cause.wav").subarray(0, 200));
    // One byte below the sentinel: a real length, and a wrong one. Only 0xffffffff means "to the
    // end", so this stays the truncation it is.
    truncated.writeUInt32LE(0xffff_fffe, 40);

    expect(() => decodeWav(truncated)).toThrow(/claims 4294967294 bytes but only \d+ remain/);
  });

  it("throws a NarrationError carrying WAV_UNREADABLE", () => {
    try {
      decodeWav(Buffer.from("not a wav at all"));
      expect.unreachable("decodeWav accepted a non-WAV payload");
    } catch (error) {
      expect(error).toBeInstanceOf(NarrationError);
      expect((error as NarrationError).code).toBe("WAV_UNREADABLE");
    }
  });
});

describe("encodeWav", () => {
  it("round-trips a fixture through the writer without changing a byte of audio", () => {
    const original = decodeWav(fixture("hook.wav"));
    const rewritten = decodeWav(encodeWav(original));

    expect(rewritten.format).toEqual(original.format);
    expect(Buffer.compare(rewritten.data, original.data)).toBe(0);
  });

  it("writes a 44-byte header and nothing else before the samples", () => {
    const data = Buffer.alloc(200);
    const encoded = encodeWav({ format: KOKORO_FORMAT, data });

    expect(encoded.length).toBe(44 + data.length);
    expect(encoded.toString("ascii", 0, 4)).toBe("RIFF");
    expect(encoded.readUInt32LE(4)).toBe(36 + data.length);
    expect(encoded.toString("ascii", 8, 12)).toBe("WAVE");
    expect(encoded.toString("ascii", 36, 40)).toBe("data");
    expect(encoded.readUInt32LE(40)).toBe(data.length);
  });
});

describe("sample arithmetic", () => {
  it("truncates silence to whole samples, as the reference implementation does", () => {
    // 24000 * 620 / 1000 lands exactly; a rate that does not is truncated down.
    expect(silenceSamples(24000, 620)).toBe(14880);
    expect(silenceSamples(44100, 1)).toBe(44);
    expect(silenceSamples(24000, -5)).toBe(0);
  });

  it("makes silence out of zeroed frames of the right width", () => {
    const buffer = silentFrames(KOKORO_FORMAT, 10);

    expect(buffer.length).toBe(10 * pcmFrameBytes(KOKORO_FORMAT));
    expect([...buffer].every((byte) => byte === 0)).toBe(true);
  });

  it("measures duration from the byte count, not from any timestamp", () => {
    expect(pcmDurationMs(KOKORO_FORMAT, 24000 * 2)).toBe(1000);
    expect(pcmDurationMs({ ...KOKORO_FORMAT, channels: 2 }, 24000 * 2 * 2)).toBe(1000);
  });

  it("compares formats field by field", () => {
    expect(samePcmFormat(KOKORO_FORMAT, { ...KOKORO_FORMAT })).toBe(true);
    expect(samePcmFormat(KOKORO_FORMAT, { ...KOKORO_FORMAT, sampleRate: 22050 })).toBe(false);
  });
});
