/**
 * A RIFF/WAVE reader and writer, narrow on purpose (roadmap P1-2,
 * docs/ROADMAP.md).
 *
 * The reference implementation gets this from Python's `wave` module
 * (`narrate.py:91-109`). Node has no equivalent in its standard library, and
 * the job here is small enough that a dependency would cost more than it saves:
 * decode one `fmt `/`data` pair, concatenate frames, write a 44-byte header.
 * That is roughly a hundred lines, it is exercised by real Kokoro output, and
 * it keeps a package that already ships to npm free of another transitive tree.
 *
 * **It reads 16-bit integer PCM and nothing else.** Kokoro's
 * `/dev/captioned_speech` answers `response_format: "wav"` with exactly that,
 * and a reader that silently accepted µ-law, IEEE float or
 * `WAVE_FORMAT_EXTENSIBLE` would go on to concatenate frames whose zero value
 * is not silence — producing a track that plays as clicks between segments
 * rather than failing. So every other encoding is refused by name.
 *
 * Chunks other than `fmt ` and `data` (`LIST`, `fact`, and whatever a future
 * server adds) are skipped, with the RIFF word-alignment padding byte honoured,
 * because ignoring an unknown chunk is what the container format is for.
 *
 * **A chunk size of `0xffffffff` means "to the end of the payload".** An encoder
 * that writes the header before it knows the length has no size to put there,
 * so it writes the all-ones sentinel and lets the file end where it ends. That
 * is not a corner case here: `kokoro-fastapi` builds its response with a
 * streaming writer and answers `/dev/captioned_speech` with `RIFF ffffffff …
 * LIST … data ffffffff` even for `stream: false`, so reading that sentinel as a
 * length is what makes every live narration fail with "claims 4294967295 bytes".
 * It is honoured only as "everything that is left", and a size that is merely
 * *too large* still fails — a truncated download must not be read as a short
 * take.
 */

import { NarrationError } from "./errors.js";

/** `wFormatTag` for uncompressed integer PCM. The only value this reader accepts. */
const PCM_FORMAT_TAG = 1;

/** The only sample depth this reader accepts, in bits. */
const PCM_BITS_PER_SAMPLE = 16;

/** Bytes before the `data` chunk's payload in the header `encodeWav` writes. */
const HEADER_BYTES = 44;

/** Size of the canonical `fmt ` chunk body, in bytes. */
const FMT_CHUNK_BYTES = 16;

/**
 * The size a streaming writer puts in a chunk header when it does not yet know
 * the length. Read as "everything that is left", never as a byte count.
 */
const UNKNOWN_CHUNK_SIZE = 0xffff_ffff;

/** The PCM parameters two segments must agree on before their frames can be joined. */
export type PcmFormat = {
  /** Interleaved channel count. Kokoro sends 1. */
  readonly channels: number;
  /** Bytes per sample per channel. Always 2 here — this reader is 16-bit only. */
  readonly sampleWidth: number;
  /** Samples per second. */
  readonly sampleRate: number;
};

/** One decoded WAV: its format, and the raw interleaved frames of its `data` chunk. */
export type WavAudio = {
  readonly format: PcmFormat;
  /** The `data` chunk payload verbatim — no resampling, no conversion. */
  readonly data: Buffer;
};

/** Bytes one frame occupies: one sample on every channel. */
export function pcmFrameBytes(format: PcmFormat): number {
  return format.channels * format.sampleWidth;
}

/**
 * How long `byteLength` bytes of `format` frames play for, in milliseconds.
 *
 * This is the *only* way a segment's spoken length is obtained. Deriving it
 * from the last word's `end_time` instead would silently drop whatever Kokoro
 * renders after it, and the track would then be longer than `timings.json` says
 * it is.
 */
export function pcmDurationMs(format: PcmFormat, byteLength: number): number {
  return (byteLength / pcmFrameBytes(format) / format.sampleRate) * 1000;
}

/**
 * Whole samples of silence that fit in `ms` at `sampleRate`, truncated
 * (`narrate.py:100`).
 *
 * Truncating rather than rounding is copied deliberately: the planner and the
 * track builder both call this, so the milliseconds the plan reports and the
 * samples the track contains are the same arithmetic and cannot drift apart by
 * an accumulated fraction of a sample.
 */
export function silenceSamples(sampleRate: number, ms: number): number {
  return Math.max(0, Math.trunc((sampleRate * ms) / 1000));
}

/** `samples` of silence: zeroed frames, which is what 0 means in signed PCM. */
export function silentFrames(format: PcmFormat, samples: number): Buffer {
  return Buffer.alloc(Math.max(0, samples) * pcmFrameBytes(format));
}

/** Whether two segments' audio can be concatenated without conversion. */
export function samePcmFormat(a: PcmFormat, b: PcmFormat): boolean {
  return (
    a.channels === b.channels && a.sampleWidth === b.sampleWidth && a.sampleRate === b.sampleRate
  );
}

/** `{channels, sampleWidth, sampleRate}` rendered for an error message. */
export function describeFormat(format: PcmFormat): string {
  return `${format.channels}ch/${format.sampleWidth * 8}-bit/${format.sampleRate}Hz`;
}

/**
 * Parse a RIFF/WAVE container holding 16-bit integer PCM.
 *
 * @throws NarrationError `WAV_UNREADABLE` on anything else — a truncated file, a
 *   missing `fmt ` or `data` chunk, a compressed encoding, or a sample depth
 *   this reader does not handle. Each message names what was found, because the
 *   caller's next question is always "then what did the server send?".
 */
export function decodeWav(bytes: Buffer): WavAudio {
  if (bytes.length < 12) {
    throw new NarrationError(
      "WAV_UNREADABLE",
      `WAV payload is ${bytes.length} bytes, too short to hold a RIFF header.`,
    );
  }
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new NarrationError(
      "WAV_UNREADABLE",
      "WAV payload does not begin with a RIFF/WAVE header; the server did not answer with a WAV.",
    );
  }

  let format: PcmFormat | undefined;
  let data: Buffer | undefined;
  let offset = 12;

  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const declared = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    // The sentinel is a statement that the length was unknown when the header was written, so the
    // chunk runs to the end of what arrived. Anything else that overruns is a truncated payload.
    const size = declared === UNKNOWN_CHUNK_SIZE ? bytes.length - body : declared;
    if (body + size > bytes.length) {
      throw new NarrationError(
        "WAV_UNREADABLE",
        `WAV chunk "${id}" claims ${declared} bytes but only ${bytes.length - body} remain.`,
      );
    }
    if (id === "fmt ") {
      format = readFmtChunk(bytes, body, size);
    } else if (id === "data") {
      data = bytes.subarray(body, body + size);
    }
    // RIFF pads every chunk body to an even length; the pad byte is not counted
    // in the size field.
    offset = body + size + (size % 2);
  }

  if (format === undefined) {
    throw new NarrationError("WAV_UNREADABLE", 'WAV payload has no "fmt " chunk.');
  }
  if (data === undefined) {
    throw new NarrationError("WAV_UNREADABLE", 'WAV payload has no "data" chunk.');
  }

  const remainder = data.length % pcmFrameBytes(format);
  if (remainder !== 0) {
    throw new NarrationError(
      "WAV_UNREADABLE",
      `WAV data chunk is ${data.length} bytes, not a whole number of ` +
        `${pcmFrameBytes(format)}-byte frames.`,
    );
  }

  return { format, data };
}

/** Read one `fmt ` chunk body, refusing every encoding but 16-bit integer PCM. */
function readFmtChunk(bytes: Buffer, body: number, size: number): PcmFormat {
  if (size < FMT_CHUNK_BYTES) {
    throw new NarrationError(
      "WAV_UNREADABLE",
      `WAV "fmt " chunk is ${size} bytes; ${FMT_CHUNK_BYTES} are needed to describe PCM.`,
    );
  }

  const tag = bytes.readUInt16LE(body);
  if (tag !== PCM_FORMAT_TAG) {
    throw new NarrationError(
      "WAV_UNREADABLE",
      `WAV format tag is ${tag}; this reader handles uncompressed integer PCM ` +
        `(tag ${PCM_FORMAT_TAG}) only.`,
    );
  }

  const bitsPerSample = bytes.readUInt16LE(body + 14);
  if (bitsPerSample !== PCM_BITS_PER_SAMPLE) {
    throw new NarrationError(
      "WAV_UNREADABLE",
      `WAV is ${bitsPerSample}-bit; this reader handles ${PCM_BITS_PER_SAMPLE}-bit samples only, ` +
        "because zeroed frames are silence at that depth and not at every other.",
    );
  }

  const channels = bytes.readUInt16LE(body + 2);
  const sampleRate = bytes.readUInt32LE(body + 4);
  if (channels < 1 || sampleRate < 1) {
    throw new NarrationError(
      "WAV_UNREADABLE",
      `WAV declares ${channels} channels at ${sampleRate} Hz, which cannot be played.`,
    );
  }

  return { channels, sampleWidth: bitsPerSample / 8, sampleRate };
}

/**
 * Write a canonical 44-byte-header WAV around `data` (`narrate.py:104-109`).
 *
 * No `LIST` chunk, no `fact` chunk, no padding: the input is 16-bit PCM, whose
 * frame size is even, so the `data` payload never needs the RIFF alignment byte.
 */
export function encodeWav(audio: WavAudio): Buffer {
  const { format, data } = audio;
  const header = Buffer.alloc(HEADER_BYTES);
  const blockAlign = pcmFrameBytes(format);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(HEADER_BYTES - 8 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(FMT_CHUNK_BYTES, 16);
  header.writeUInt16LE(PCM_FORMAT_TAG, 20);
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(format.sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(format.sampleWidth * 8, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}
