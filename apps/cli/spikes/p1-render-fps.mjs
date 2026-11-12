#!/usr/bin/env node
/**
 * The P0-6 gate, re-measured on the shipped renderer: capture + encode fps on a busy scene.
 *
 * The Phase 0 spike measured the owned pipeline's throughput on a machine other sessions kept at a
 * one-minute load average of 4.7 to 14.4, and on the animated stress scene the macOS margin was
 * thin: 21.6 to 25.8 fps live against a 20 fps bar, and 18.3 fps on one capture-only run. ADR 0031
 * makes an idle-machine re-measure a Phase 1 gate, and this script is that measurement. It drives
 * the **product's own worker** — `dist/workers/render.js`, spawned exactly as `daemon/workers.ts`
 * spawns it — rather than a copy of its loop, so what it times is what a user's render does.
 *
 *     pnpm turbo build --filter @xplainer/cli
 *     node apps/cli/dist/bin.js setup --state-dir "$STATE" \
 *       --manifest apps/cli/src/setup/toolchain.manifest.json --tts-url http://127.0.0.1:8880
 *     node apps/cli/spikes/p1-render-fps.mjs --marker "$STATE/toolchain.json" [--runs 3] [--scene animated|skeleton]
 *
 * **The browser and the encoder are the ones `setup` recorded**, read out of the marker `--marker`
 * names and handed to the worker exactly as a daemon's state directory hands them: the marker is
 * copied into this run's own state directory, so the worker launches its `chrome.path` and pipes
 * into its `ffmpeg.path` — Chrome for Testing 157.0.8103.50 and this platform's pinned FFmpeg since
 * ADR 0031's note of 2026-11-12 (D4, D6). `--tts-url` is there only because a marker records speech
 * or it is not a valid document; nothing here narrates, and no server need answer. An
 * `XPLAINER_FFMPEG` in this shell still wins, as it would in a daemon's, and the worker's own first
 * line — printed per run — says which of the two it used. The previous form took a browser from
 * `XPLAINER_CHROME`, wrote a marker naming Chrome 149 and left the encoder to the worker's `PATH`
 * and Homebrew lookups, which no longer exist.
 *
 * The scene is the spike's animated stress scene, ported onto `@xplainer/motion`: springs, eased
 * transforms at fractional pixels, a rotated `<Img>`, gradients, shadows, an SVG dash and Tailwind
 * utilities, 491 frames over four segments with boundaries at 148, 178 and 328. `skeleton` renders
 * the scaffold with an empty `Scenes.tsx` instead. Inputs are synthetic and written by this script —
 * a 220 Hz tone stands in for narration, and a gradient PNG for the image — so it needs no ffmpeg of
 * its own: our macOS build decodes and encodes only what a render needs, and has no `lavfi`.
 *
 * It prints, per run: the loop fps (first progress line to the `done` line, which is what the
 * spike's "loop" covered — setFrame, capture and the encoder's tail), the total fps (spawn to exit,
 * Chrome launch and bundling included), and the one-minute load average before and after. It exits
 * `1` if any run's loop fps is under `--bar` (default 20, the macOS bar), so it is a gate and not a
 * demo. It is plain Node, outside the build, and needs a built `dist/`.
 */

import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, cpus, loadavg, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { crc32, deflateSync } from "node:zlib";
import { materialiseWorkspace, scaffoldVideo, videoPaths } from "@xplainer/render-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist");
const WORKER = join(DIST, "workers", "render.js");

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    scene: { type: "string", default: "animated" },
    bar: { type: "string", default: "20" },
    keep: { type: "boolean", default: false },
    marker: { type: "string" },
  },
});

const FPS = 30;
const FRAMES = 491;
const TOTAL_MS = Math.round((FRAMES * 1000) / FPS);
const SLUG = "fps";
const SEGMENTS = [
  {
    id: "hook",
    from: 0,
    frames: 148,
    text: "Your build was already broken before the first test ran.",
  },
  { id: "beat", from: 148, frames: 30, text: null },
  {
    id: "cause",
    from: 178,
    frames: 150,
    text: "The cache keeps a stale bundle, and every worker reads it.",
  },
  {
    id: "fix",
    from: 328,
    frames: 163,
    text: "Hash the inputs, so a changed file means a fresh build.",
  },
];

const ANIMATED_SCENES = `import { AbsoluteFill, Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "@xplainer/motion";
import type { SceneMap } from "./Video";

const Hook = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 12 } });
  const drift = interpolate(frame, [0, 148], [0, 37.3]);
  return (
    <AbsoluteFill className="flex items-center justify-center bg-linear-to-br from-indigo-950 to-slate-900">
      <h1 className="text-8xl font-bold tracking-tight text-white" style={{ transform: \`translate(\${drift}px, \${(1 - enter) * 300}px) scale(\${0.6 + enter * 0.4})\` }}>
        Already broken
      </h1>
      <div className="absolute h-64 w-64 rounded-3xl bg-fuchsia-500/70 shadow-2xl" style={{ left: 200 + frame * 3.17, top: 180, transform: \`rotate(\${frame * 1.3}deg)\` }} />
    </AbsoluteFill>
  );
};

const Beat = () => {
  const frame = useCurrentFrame();
  const pulse = interpolate(frame, [0, 15, 30], [0.2, 1, 0.2], { easing: Easing.inOut(Easing.sin) });
  return (
    <AbsoluteFill className="flex items-center justify-center bg-slate-950">
      <div className="h-40 w-40 rounded-full bg-emerald-400" style={{ opacity: pulse, transform: \`scale(\${pulse * 2})\` }} />
    </AbsoluteFill>
  );
};

const Cause = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill className="flex items-center justify-center bg-zinc-900 p-24">
      <div className="grid grid-cols-3 gap-8">
        {["cache", "bundle", "worker", "startup", "stale", "read"].map((label, index) => {
          const enter = spring({ frame: frame - index * 7, fps, config: { damping: 14, stiffness: 120 } });
          return (
            <div key={label} className="rounded-2xl bg-slate-800 px-12 py-10 text-5xl font-semibold text-sky-100 shadow-xl" style={{ opacity: enter, transform: \`translateY(\${(1 - enter) * 80.5}px)\` }}>
              {label}
            </div>
          );
        })}
      </div>
      <svg className="absolute" width="1920" height="1080" style={{ inset: 0 }}>
        <title>dash</title>
        <path d="M 100 900 C 500 200, 1400 1000, 1820 180" fill="none" stroke="#f59e0b" strokeWidth="6" strokeDasharray="2400" strokeDashoffset={2400 - frame * 16} />
      </svg>
    </AbsoluteFill>
  );
};

const Fix = () => {
  const frame = useCurrentFrame();
  const zoom = interpolate(frame, [0, 163], [1, 1.35], { easing: Easing.bezier(0.4, 0, 0.2, 1) });
  return (
    <AbsoluteFill className="flex items-center justify-center bg-black">
      <Img src={staticFile("media/gradient.png")} className="rounded-3xl shadow-2xl" style={{ width: 800, height: 450, transform: \`scale(\${zoom}) rotate(\${frame * 0.21}deg)\` }} />
      <p className="absolute text-4xl text-amber-200" style={{ top: 120, left: 240 + frame * 0.37, letterSpacing: frame * 0.01 }}>
        Fractional drift tests subpixel text
      </p>
    </AbsoluteFill>
  );
};

export const scenes: SceneMap = { hook: Hook, beat: Beat, cause: Cause, fix: Fix };
`;

function fail(message) {
  process.stderr.write(`p1-render-fps: ${message}\n`);
  process.exit(2);
}

/** `seconds` of a 220 Hz sine, mono 16-bit at 24 kHz: the narration's stand-in. */
function sineWav(seconds) {
  const rate = 24_000;
  const frames = Math.round(rate * seconds);
  const data = Buffer.alloc(frames * 2);
  for (let n = 0; n < frames; n += 1) {
    data.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 220 * n) / rate)), n * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** One PNG chunk: length, type, data and the CRC-32 over type and data. */
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** An 8-bit RGB gradient, `width` by `height`: the scene's rotated `<Img>`. */
function gradientPng(width, height) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      row[1 + x * 3] = Math.round((255 * x) / (width - 1));
      row[2 + x * 3] = Math.round((255 * y) / (height - 1));
      row[3 + x * 3] = 160;
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Synthetic timings, captions, narration and image for one 491-frame video. */
function writeInputs(publicDir) {
  const toMs = (frame) => Math.round((frame * 1000) / FPS);
  const timings = {
    fps: FPS,
    durationInFrames: FRAMES,
    totalMs: TOTAL_MS,
    audio: "narration.wav",
    segments: SEGMENTS.map((segment, index) => ({
      id: segment.id,
      index,
      startMs: toMs(segment.from),
      endMs: toMs(segment.from + segment.frames),
      from: segment.from,
      durationInFrames: segment.frames,
    })),
  };
  const captions = [];
  for (const segment of SEGMENTS) {
    if (segment.text === null) {
      continue;
    }
    const words = segment.text.split(" ");
    const start = toMs(segment.from) + 80;
    const span = toMs(segment.from + segment.frames) - start - 120;
    words.forEach((word, index) => {
      const startMs = start + Math.round((span * index) / words.length);
      const endMs = start + Math.round((span * (index + 1)) / words.length) - 20;
      captions.push({
        text: index === 0 ? word : ` ${word}`,
        startMs,
        endMs,
        timestampMs: Math.round((startMs + endMs) / 2),
        confidence: null,
      });
    });
  }
  mkdirSync(join(publicDir, "media"), { recursive: true });
  writeFileSync(join(publicDir, "timings.json"), `${JSON.stringify(timings, null, 2)}\n`);
  writeFileSync(join(publicDir, "captions.json"), `${JSON.stringify(captions, null, 2)}\n`);
  writeFileSync(join(publicDir, "narration.wav"), sineWav(TOTAL_MS / 1000));
  writeFileSync(join(publicDir, "media", "gradient.png"), gradientPng(800, 450));
}

/**
 * The marker `setup` wrote, read for what it says and copied into this run's state directory.
 *
 * Copied rather than referenced, so the worker reads it exactly as a daemon's worker does — from
 * `<XPLAINER_STATE_DIR>/toolchain.json` — and this run can never write into the state directory it
 * came from. Its browser and its ffmpeg are required: a marker without an ffmpeg can still serve a
 * still, and this measures renders.
 */
function adoptMarker(markerFile, stateDir) {
  if (!markerFile || !existsSync(markerFile)) {
    fail(
      "--marker must name a toolchain.json `xplainer setup` wrote: run `node apps/cli/dist/bin.js " +
        "setup --state-dir <dir> --manifest apps/cli/src/setup/toolchain.manifest.json --tts-url " +
        "http://127.0.0.1:8880` and pass --marker <dir>/toolchain.json",
    );
  }
  const marker = JSON.parse(readFileSync(markerFile, "utf8"));
  if (!existsSync(marker.chrome?.path ?? "") || !existsSync(marker.ffmpeg?.path ?? "")) {
    fail(
      `${markerFile} does not record a browser and an ffmpeg that are on this machine; run setup ` +
        "again without --skip-ffmpeg",
    );
  }
  copyFileSync(markerFile, join(stateDir, "toolchain.json"));
  return marker;
}

/** One render through the worker; resolves with its timings, read off its own stdout. */
function renderOnce(root, stateDir, jobId) {
  return new Promise((resolve, reject) => {
    const spawned = performance.now();
    const child = spawn(process.execPath, [WORKER, root, String(jobId)], {
      env: { ...process.env, XPLAINER_STATE_DIR: stateDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let firstProgress = null;
    let firstFrame = 0;
    let started = null;
    let lastProgress = null;
    let done = null;
    let doneAt = null;
    let buffer = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) {
          break;
        }
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (started === null && line.startsWith("[xplainer] rendering ")) {
          started = line;
        }
        let parsed = null;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed.event === "progress") {
          if (firstProgress === null) {
            firstProgress = performance.now();
            firstFrame = parsed.frame;
          }
          lastProgress = parsed;
        } else if (parsed.event === "done") {
          done = parsed;
          doneAt = performance.now();
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (code) => {
      const exited = performance.now();
      if (code !== 0 || done === null || firstProgress === null) {
        reject(new Error(`worker exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolve({
        loopFps: ((FRAMES - firstFrame) * 1000) / (doneAt - firstProgress),
        totalFps: (FRAMES * 1000) / (exited - spawned),
        totalSeconds: (exited - spawned) / 1000,
        workerCaptureFps: lastProgress?.captureFps ?? null,
        bytes: done.bytes,
        started,
      });
    });
  });
}

async function main() {
  if (!existsSync(WORKER)) {
    fail(`${WORKER} is missing: run \`pnpm turbo build --filter @xplainer/cli\` first`);
  }
  const runs = Number(values.runs);
  const bar = Number(values.bar);
  const scratch = mkdtempSync(join(tmpdir(), "xplainer-fps-"));
  const root = join(scratch, "workspace");
  const stateDir = join(scratch, "state");
  mkdirSync(stateDir, { recursive: true });
  const marker = adoptMarker(values.marker, stateDir);
  materialiseWorkspace(root);
  const video = videoPaths(root, SLUG);
  mkdirSync(video.source, { recursive: true });
  scaffoldVideo(video.source);
  if (values.scene === "animated") {
    writeFileSync(join(video.source, "Scenes.tsx"), ANIMATED_SCENES);
  } else if (values.scene !== "skeleton") {
    fail(`--scene is animated or skeleton, not ${values.scene}`);
  }
  writeInputs(video.publicDir);
  const { writeJobRequest } = await import(join(DIST, "job-request.js"));

  const cores = cpus().length;
  process.stdout.write(
    `p1-render-fps: scene ${values.scene}, ${FRAMES} frames, ${runs} run(s), ${cores} logical CPUs ` +
      `(${availableParallelism()} available), ${process.platform}-${process.arch}, bar ${bar} fps\n` +
      `  browser ${marker.chrome.version} (${marker.chrome.provider}), ffmpeg ` +
      `${marker.ffmpeg.version} (${marker.ffmpeg.provider}, ${marker.ffmpeg.licence}), from ` +
      `${values.marker}\n`,
  );
  const results = [];
  for (let run = 1; run <= runs; run += 1) {
    writeJobRequest(root, run, { job_type: "explainer_render", slug: SLUG });
    const before = loadavg()[0];
    const result = await renderOnce(root, stateDir, run);
    const after = loadavg()[0];
    results.push(result);
    process.stdout.write(
      `  run ${run}: loop ${result.loopFps.toFixed(2)} fps, total ${result.totalFps.toFixed(2)} fps ` +
        `(${result.totalSeconds.toFixed(2)} s), worker captureFps ${result.workerCaptureFps}, ` +
        `${result.bytes} B, load ${before.toFixed(2)} -> ${after.toFixed(2)}\n` +
        `    ${result.started ?? "(the worker printed no start line)"}\n`,
    );
  }
  const loops = results.map((result) => result.loopFps);
  const slowest = Math.min(...loops);
  process.stdout.write(
    `  loop fps ${slowest.toFixed(2)} to ${Math.max(...loops).toFixed(2)}; ` +
      `${slowest >= bar ? "PASS" : "FAIL"} against ${bar}\n`,
  );
  if (values.keep) {
    process.stdout.write(`  kept ${scratch}\n`);
  } else {
    rmSync(scratch, { recursive: true, force: true });
  }
  process.exit(slowest >= bar ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(
    `p1-render-fps: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(2);
});
