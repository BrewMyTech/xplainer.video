// SPDX-License-Identifier: MIT
// The acceptance test for one built ffmpeg: what it says about itself, and
// three real encodes.
//
//   node infra/ffmpeg/smoke.mjs <path/to/ffmpeg> [--json <report.json>]
//
// Exits 0 when every gate passes, 1 otherwise. The VideoToolbox encode is
// reported and never gates: a hosted macOS runner is a virtual machine and may
// have no video encoder to open, which says nothing about the binary.
//
// THE PROBE is the one `xplainer setup` runs on an acquired ffmpeg
// (spike/setup-design/DESIGN.md §5.4): version, licence class, and that every
// component the renderer names is compiled in. Plus one check of our own: that
// nothing but the system's libraries is linked dynamically.
//
// ENCODE A is the probe's own smoke encode (§5.5): two 64x64 RGBA frames of
// zeros and a file of 48 kHz silence, through libx264 and aac into mp4.
//
// ENCODE B is the renderer's argv, copied from encodeArgs() in
// apps/cli/src/render/encode.ts: PNG frames on stdin, a 24 kHz 16-bit WAV like
// the one narration writes, the BT.709 filter graph, libx264 CRF 18, aac, and
// +faststart. Its output is checked box by box — moov before mdat, the colour
// tags on the avc1 sample entry, a High-profile avcC, two video samples — and
// it is run twice, because ADR 0031 relies on libx264 reproducing its own bytes.
// If encodeArgs() changes, change ENCODE B here to match.
//
// ENCODE C is h264_videotoolbox, informational.
//
// Node built-ins only, so it runs on a bare runner with nothing installed.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));

/** pins.env as an object: KEY=value lines, comments and blanks skipped. */
function readPins() {
  const pins = {};
  for (const line of readFileSync(join(here, "pins.env"), "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) pins[match[1]] = match[2];
  }
  return pins;
}

const args = process.argv.slice(2);
const ffmpeg = args[0];
const jsonIndex = args.indexOf("--json");
const jsonPath = jsonIndex === -1 ? undefined : args[jsonIndex + 1];
if (!ffmpeg || ffmpeg.startsWith("--") || (jsonIndex !== -1 && !jsonPath)) {
  process.stderr.write("usage: node smoke.mjs <path/to/ffmpeg> [--json <report.json>]\n");
  process.exit(2);
}

const pins = readPins();
const results = [];
let failed = false;

function check(name, ok, detail = "", gating = true) {
  results.push({ name, ok, gating, detail });
  if (!ok && gating) failed = true;
  const mark = ok ? "pass" : gating ? "FAIL" : "info";
  process.stdout.write(`${mark}  ${name}${detail === "" ? "" : `: ${detail}`}\n`);
}

function run(argv, input) {
  const result = spawnSync(ffmpeg, argv, { input, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  return {
    status: result.status,
    stdout: result.stdout ? result.stdout.toString("utf8") : "",
    stderr: result.stderr ? result.stderr.toString("utf8") : "",
    error: result.error,
  };
}

function lastLines(text, count = 6) {
  return text.trim().split("\n").slice(-count).join(" | ");
}

// --- the probe ---------------------------------------------------------------

/** Rows of a component listing after its `---` rule, as { flags, name }. */
function listing(flag) {
  const out = run(["-hide_banner", flag]).stdout.split("\n");
  const rule = out.findIndex((line) => /^\s*-+\s*$/.test(line));
  return out
    .slice(rule + 1)
    .map((line) => /^\s*(\S+)\s+(\S+)/.exec(line))
    .filter((match) => match !== null)
    .map((match) => ({ flags: match[1], names: match[2].split(",") }));
}

function has(rows, name, test = () => true) {
  return rows.some((row) => row.names.includes(name) && test(row.flags));
}

const version = run(["-hide_banner", "-version"]);
check("runs", version.status === 0, version.error ? String(version.error) : "");
const versionLine = /^ffmpeg version (\S+)/m.exec(version.stdout);
check(
  "version",
  versionLine !== null && versionLine[1] === pins.FFMPEG_VERSION,
  versionLine ? versionLine[1] : "no version line",
);
for (const library of ["avcodec", "avformat"]) {
  const triple = new RegExp(
    `^lib${library}\\s+(\\d+)\\.\\s*\\d+\\.\\s*\\d+\\s*/\\s*(\\d+)\\.\\s*\\d+\\.\\s*\\d+`,
    "m",
  ).exec(version.stdout);
  check(`lib${library} >= 60`, triple !== null && Number(triple[2]) >= 60, triple?.[0] ?? "");
}

const buildconf = run(["-hide_banner", "-buildconf"]).stdout;
for (const flag of ["--enable-gpl", "--enable-libx264", "--enable-videotoolbox"]) {
  check(`buildconf has ${flag}`, buildconf.includes(flag));
}
for (const flag of ["--enable-version3", "--enable-nonfree"]) {
  check(`buildconf lacks ${flag}`, !buildconf.includes(flag));
}

const licence = run(["-hide_banner", "-L"]).stdout.replace(/\s+/g, " ");
check(
  "licence is GPL version 2 or later",
  /GNU General Public License as published by the Free Software Foundation; either version 2 of the License, or \(at your option\) any later version/.test(
    licence,
  ),
);

const encoders = listing("-encoders");
check(
  "encoder libx264",
  has(encoders, "libx264", (flags) => flags.startsWith("V")),
);
check(
  "encoder aac, not experimental",
  has(encoders, "aac", (flags) => flags.startsWith("A") && flags[3] === "."),
);
check(
  "encoder h264_videotoolbox compiled in",
  has(encoders, "h264_videotoolbox", (flags) => flags.startsWith("V")),
);
const muxers = listing("-muxers");
check(
  "muxer mp4",
  has(muxers, "mp4", (flags) => flags.includes("E")),
);
const demuxers = listing("-demuxers");
for (const name of ["image2pipe", "png_pipe", "rawvideo", "wav"]) {
  check(
    `demuxer ${name}`,
    has(demuxers, name, (flags) => flags.includes("D")),
  );
}
const decoders = listing("-decoders");
for (const name of ["png", "rawvideo", "pcm_s16le"]) {
  check(`decoder ${name}`, has(decoders, name));
}
const filters = listing("-filters");
for (const name of ["scale", "format", "setparams", "aresample"]) {
  check(
    `filter ${name}`,
    filters.some((row) => row.flags !== "" && row.names[0] === name),
  );
}

// x264 and zlib are linked in statically; the only dynamic dependencies allowed
// are the system's own, which every Mac has.
const linked = spawnSync("otool", ["-L", ffmpeg], { encoding: "utf8" });
const libraries = (linked.stdout ?? "")
  .split("\n")
  .slice(1)
  .map((line) => line.trim().split(" ")[0])
  .filter((path) => path !== "");
check(
  "links only /usr/lib and /System/Library",
  linked.status === 0 &&
    libraries.length > 0 &&
    libraries.every((path) => path.startsWith("/usr/lib/") || path.startsWith("/System/Library/")),
  libraries.join(" "),
);

// --- inputs --------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), "xplainer-ffmpeg-smoke-"));

function wav(sampleRate, seconds) {
  const samples = Math.round(sampleRate * seconds);
  const data = samples * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data, 40);
  return Buffer.concat([header, Buffer.alloc(data)]);
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** An opaque 64x64 RGB gradient, shifted by `phase` so two frames differ. */
function png(phase) {
  const size = 64;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const rows = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3);
    for (let x = 0; x < size; x++) {
      rows[row + 1 + x * 3] = (x * 4 + phase) & 0xff;
      rows[row + 2 + x * 3] = (y * 4) & 0xff;
      rows[row + 3 + x * 3] = ((x + y) * 2 + phase) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const frames = join(work, "frames.rgba");
writeFileSync(frames, Buffer.alloc(64 * 64 * 4 * 2));
const silence48 = join(work, "silence-48k.wav");
writeFileSync(silence48, wav(48_000, 0.1));
const narration = join(work, "narration-24k.wav");
writeFileSync(narration, wav(24_000, 0.2));
const pngFrames = Buffer.concat([png(0), png(37)]);

// --- the MP4 reader ------------------------------------------------------------

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "udta"]);
/** Bytes between a sample entry's header and its first child box. */
const SAMPLE_ENTRY_FIELDS = { avc1: 78, mp4a: 28 };

/** Every box in `buffer[start, end)`, recursively, as { type, start, body, end, path }. */
function walk(buffer, start, end, path = []) {
  const found = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    let body = offset + 8;
    if (size === 1) {
      size = Number(buffer.readBigUInt64BE(offset + 8));
      body = offset + 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < 8 || offset + size > end) break;
    const box = { type, start: offset, body, end: offset + size, path: [...path, type] };
    found.push(box);
    if (CONTAINERS.has(type)) {
      found.push(...walk(buffer, body, box.end, box.path));
    } else if (type === "stsd") {
      found.push(...walk(buffer, body + 8, box.end, box.path));
    } else if (type in SAMPLE_ENTRY_FIELDS) {
      found.push(...walk(buffer, body + SAMPLE_ENTRY_FIELDS[type], box.end, box.path));
    }
    offset = box.end;
  }
  return found;
}

/** What the checks need from one MP4: top-level order, and per track its codec facts. */
function describe(file) {
  const buffer = readFileSync(file);
  const all = walk(buffer, 0, buffer.length);
  const top = all.filter((box) => box.path.length === 1).map((box) => box.type);
  const tracks = all
    .filter((box) => box.type === "trak")
    .map((trak) => {
      const inside = all.filter((box) => box.start > trak.start && box.end <= trak.end);
      const find = (type) => inside.find((box) => box.type === type);
      const hdlr = find("hdlr");
      const stsz = find("stsz");
      const avcC = find("avcC");
      const colr = find("colr");
      const track = {
        handler: hdlr ? buffer.toString("latin1", hdlr.body + 8, hdlr.body + 12) : undefined,
        entry: inside.find((box) => box.type in SAMPLE_ENTRY_FIELDS)?.type,
        samples: stsz ? buffer.readUInt32BE(stsz.body + 8) : undefined,
      };
      if (avcC) track.profile = buffer[avcC.body + 1];
      if (colr && buffer.toString("latin1", colr.body, colr.body + 4) === "nclx") {
        track.colour = {
          primaries: buffer.readUInt16BE(colr.body + 4),
          transfer: buffer.readUInt16BE(colr.body + 6),
          matrix: buffer.readUInt16BE(colr.body + 8),
          fullRange: (buffer[colr.body + 10] & 0x80) !== 0,
        };
      }
      return track;
    });
  return { top, tracks, sha256: createHash("sha256").update(buffer).digest("hex") };
}

function encode(argv, input) {
  const output = argv[argv.length - 1];
  const result = run(argv, input);
  let size = 0;
  try {
    size = statSync(output).size;
  } catch {
    size = 0;
  }
  return {
    ok: result.status === 0 && size > 0,
    status: result.status,
    size,
    stderr: result.stderr,
  };
}

// --- ENCODE A: the setup probe's smoke encode ---------------------------------

const outA = join(work, "a.mp4");
const a = encode([
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "rawvideo",
  "-pix_fmt",
  "rgba",
  "-s",
  "64x64",
  "-framerate",
  "30",
  "-i",
  frames,
  "-i",
  silence48,
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-f",
  "mp4",
  outA,
]);
check(
  "encode A (setup smoke: rawvideo + wav -> libx264/aac mp4)",
  a.ok,
  a.ok ? `${a.size} bytes` : `exit ${a.status}: ${lastLines(a.stderr)}`,
);
if (a.ok) {
  const shape = describe(outA);
  const video = shape.tracks.find((track) => track.handler === "vide");
  const audio = shape.tracks.find((track) => track.handler === "soun");
  check(
    "encode A tracks",
    video?.entry === "avc1" && video.samples === 2 && audio?.entry === "mp4a",
    JSON.stringify(shape.tracks),
  );
}

// --- ENCODE B: the renderer's argv, twice --------------------------------------

/** encodeArgs() in apps/cli/src/render/encode.ts, for `fps`, `audio` and `output`. */
function rendererArgs(fps, audio, output) {
  const videoFilter =
    "[0:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p," +
    "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv[v]";
  const audioFilter = "[1:a]aresample=48000[a]";
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "image2pipe",
    "-c:v",
    "png",
    "-framerate",
    String(fps),
    "-i",
    "pipe:0",
    "-i",
    audio,
    "-filter_complex",
    `${videoFilter};${audioFilter}`,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    "-ac",
    "1",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    output,
  ];
}

const digestsB = [];
for (const attempt of [1, 2]) {
  const outB = join(work, `b${attempt}.mp4`);
  const b = encode(rendererArgs(30, narration, outB), pngFrames);
  check(
    `encode B${attempt} (renderer argv: png on stdin + wav, BT.709 graph, +faststart)`,
    b.ok,
    b.ok ? `${b.size} bytes` : `exit ${b.status}: ${lastLines(b.stderr)}`,
  );
  if (!b.ok) continue;
  const shape = describe(outB);
  digestsB.push(shape.sha256);
  if (attempt === 1) {
    const video = shape.tracks.find((track) => track.handler === "vide");
    const audio = shape.tracks.find((track) => track.handler === "soun");
    check(
      "encode B moov before mdat",
      shape.top.includes("moov") && shape.top.indexOf("moov") < shape.top.indexOf("mdat"),
      shape.top.join(" "),
    );
    check(
      "encode B video: avc1, High profile, 2 samples",
      video?.entry === "avc1" && video.profile === 100 && video.samples === 2,
      JSON.stringify(video),
    );
    check(
      "encode B colour: BT.709 primaries/transfer/matrix, limited range",
      video?.colour?.primaries === 1 &&
        video.colour.transfer === 1 &&
        video.colour.matrix === 1 &&
        video.colour.fullRange === false,
      JSON.stringify(video?.colour),
    );
    check("encode B audio: mp4a", audio?.entry === "mp4a", JSON.stringify(audio));
  }
}
check(
  "encode B is byte-identical across two runs",
  digestsB.length === 2 && digestsB[0] === digestsB[1],
  digestsB.join(" "),
);

// --- ENCODE C: VideoToolbox, informational --------------------------------------

const outC = join(work, "c.mp4");
const c = encode([
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "rawvideo",
  "-pix_fmt",
  "rgba",
  "-s",
  "64x64",
  "-framerate",
  "30",
  "-i",
  frames,
  "-c:v",
  "h264_videotoolbox",
  "-b:v",
  "1M",
  "-pix_fmt",
  "yuv420p",
  "-f",
  "mp4",
  outC,
]);
check(
  "encode C (h264_videotoolbox on this host)",
  c.ok,
  c.ok ? `${c.size} bytes` : `exit ${c.status}: ${lastLines(c.stderr, 3)}`,
  false,
);

rmSync(work, { recursive: true, force: true });

const report = {
  ffmpeg,
  sha256: createHash("sha256").update(readFileSync(ffmpeg)).digest("hex"),
  host: `${process.platform}-${process.arch}`,
  passed: !failed,
  encodeB_sha256: digestsB[0],
  results,
};
if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${failed ? "SMOKE FAILED" : "SMOKE PASSED"}  ${ffmpeg}\n`);
process.exit(failed ? 1 : 0);
