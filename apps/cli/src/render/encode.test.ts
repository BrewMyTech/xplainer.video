/**
 * Which ffmpeg a render uses, what it is told, and what happens to the file it writes.
 *
 * `resolveFfmpeg` is a pure function over an environment, the marker's path and a set of files, so
 * its order is asserted against machines described here rather than against this one — including
 * that a `PATH` full of ffmpegs is never consulted. The encoder itself is driven against a **real**
 * ffmpeg, found by the test-only lookup in `setup/testing/toolchain.ts` — frames it generated itself, a WAV the narration port's own
 * encoder wrote — because the property that matters is what lands on disk: an MP4 renamed into
 * place on success, and nothing at all on a failure or an abort.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { DEFAULT_SAMPLE_RATE, encodeWav } from "@xplainer/render-core";
import { afterEach, describe, expect, it } from "vitest";
import { findTestFfmpeg } from "../setup/testing/toolchain.js";
import {
  AUDIO_FILTER,
  assertLibx264,
  encodeArgs,
  FFMPEG_ENV,
  partialPath,
  resolveFfmpeg,
  startEncoder,
  VIDEO_FILTER,
} from "./encode.js";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "xplainer-encode-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A machine with exactly these executables on it, and a marker recording `recorded`. */
function machine(
  files: readonly string[],
  env: Record<string, string | undefined>,
  recorded: string | null = null,
): Parameters<typeof resolveFfmpeg>[0] {
  const present = new Set(files);
  return { env, recorded, isExecutable: (path) => present.has(path) };
}

/** Every place the renderer used to search, each holding an ffmpeg it must now never take. */
const SEARCHED_BEFORE = ["/usr/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];

describe("resolveFfmpeg", () => {
  it("takes XPLAINER_FFMPEG over the ffmpeg toolchain.json records", () => {
    const lookup = machine(
      ["/custom/ffmpeg", "/state/toolchain/ffmpeg/ffmpeg"],
      { [FFMPEG_ENV]: "/custom/ffmpeg", PATH: "/usr/bin" },
      "/state/toolchain/ffmpeg/ffmpeg",
    );
    expect(resolveFfmpeg(lookup)).toEqual({ path: "/custom/ffmpeg", source: "override" });
  });

  it("refuses an XPLAINER_FFMPEG that names nothing, rather than quietly using the recorded one", () => {
    const lookup = machine(
      ["/state/toolchain/ffmpeg/ffmpeg"],
      { [FFMPEG_ENV]: "/gone/ffmpeg" },
      "/state/toolchain/ffmpeg/ffmpeg",
    );
    expect(() => resolveFfmpeg(lookup)).toThrow(
      /^FFMPEG_NOT_FOUND: XPLAINER_FFMPEG names \/gone\/ffmpeg/,
    );
  });

  /**
   * The gate stats an override in the daemon's working directory and this worker resolves it from
   * the workspace root, so a relative path would be judged in one place and spawned in another, and
   * a bare `ffmpeg` would be the `PATH` lookup D6 deleted. Here both exist, as relative paths, and
   * are still refused.
   */
  it("refuses an XPLAINER_FFMPEG that is not an absolute path, even one that resolves here", () => {
    for (const named of ["bin/ffmpeg", "ffmpeg"]) {
      const lookup = machine(
        [named, "/state/toolchain/ffmpeg/ffmpeg"],
        { [FFMPEG_ENV]: named },
        "/state/toolchain/ffmpeg/ffmpeg",
      );
      expect(() => resolveFfmpeg(lookup), named).toThrow(
        `FFMPEG_NOT_FOUND: XPLAINER_FFMPEG names ${named}, which is not an absolute path`,
      );
    }
  });

  /**
   * ADR 0031 §Note, 2026-11-12, D6: the recorded ffmpeg is the whole of it once the override is
   * unset. Every directory the renderer used to search holds one here, and none is taken.
   */
  it("takes the ffmpeg toolchain.json records, with an ffmpeg on PATH and in Homebrew ignored", () => {
    const lookup = machine(
      [...SEARCHED_BEFORE, "/state/toolchain/ffmpeg/ffmpeg"],
      { PATH: "/usr/bin:/opt/homebrew/bin:/usr/local/bin" },
      "/state/toolchain/ffmpeg/ffmpeg",
    );
    expect(resolveFfmpeg(lookup)).toEqual({
      path: "/state/toolchain/ffmpeg/ffmpeg",
      source: "marker",
    });
  });

  it("refuses by name when neither names one, however many ffmpegs PATH and Homebrew hold", () => {
    let message = "";
    try {
      resolveFfmpeg(machine(SEARCHED_BEFORE, { PATH: "/usr/bin:/opt/homebrew/bin" }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/^FFMPEG_NOT_FOUND: /);
    expect(message).toContain("neither XPLAINER_FFMPEG nor toolchain.json names one");
    expect(message).toContain("`xplainer setup`");
    expect(message).toContain("`xplainer setup --ffmpeg-path <file>`");
  });

  it("refuses a recorded ffmpeg that is no longer executable, naming setup", () => {
    expect(() => resolveFfmpeg(machine([], {}, "/state/toolchain/ffmpeg/ffmpeg"))).toThrow(
      /^FFMPEG_NOT_FOUND: toolchain\.json records the ffmpeg at \/state\/toolchain\/ffmpeg\/ffmpeg/,
    );
  });
});

/**
 * The ffmpeg this machine has, for the cases that encode. Not finding one is a failure, not a skip:
 * `XPLAINER_SKIP_RENDER_TEST=1` is the one way to skip, and CI installs one and never sets it.
 */
function realFfmpeg(): string {
  const found = findTestFfmpeg();
  if (found === null) {
    throw new Error(
      "no ffmpeg on this machine: install one, point XPLAINER_FFMPEG at one, or set " +
        "XPLAINER_SKIP_RENDER_TEST=1",
    );
  }
  return found;
}

describe("encodeArgs", () => {
  /**
   * The argument list, literally. The colour tags are in the filter graph and nowhere else: as
   * `-color_primaries`/`-color_trc` output options, ffmpeg 8.1 wrote them as `unknown` with no
   * `colr` box when the frames came through this graph.
   */
  it("is the one command every render runs", () => {
    expect(
      encodeArgs({
        fps: 30,
        audio: "/w/public/demo/narration.wav",
        output: "/w/out/demo/.explainer.mp4.partial-7",
      }),
    ).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "image2pipe",
      "-c:v",
      "png",
      "-framerate",
      "30",
      "-i",
      "pipe:0",
      "-i",
      "/w/public/demo/narration.wav",
      "-filter_complex",
      "[0:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv[v];[1:a]aresample=48000[a]",
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
      "/w/out/demo/.explainer.mp4.partial-7",
    ]);
    expect(`${VIDEO_FILTER};${AUDIO_FILTER}`).not.toContain("-color_");
  });

  it("writes beside the target under a hidden, per-process name", () => {
    expect(partialPath(join("/w", "out", "demo", "explainer.mp4"), 42)).toBe(
      join("/w", "out", "demo", ".explainer.mp4.partial-42"),
    );
  });
});

/**
 * PNG frames ffmpeg drew itself: `count` 64x36 frames of solid colour, or of `source` — a lavfi
 * graph — when a test needs frames large enough to fill the pipe.
 */
function pngFrames(
  ffmpeg: string,
  count: number,
  source = "color=c=0x3366cc:s=64x36:r=30",
): Buffer[] {
  const stream = execFileSync(
    ffmpeg,
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      source,
      "-frames:v",
      String(count),
      "-f",
      "image2pipe",
      "-c:v",
      "png",
      "-",
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const frames: Buffer[] = [];
  let start = stream.indexOf(signature);
  while (start >= 0) {
    const next = stream.indexOf(signature, start + signature.length);
    frames.push(stream.subarray(start, next < 0 ? stream.length : next));
    start = next;
  }
  return frames;
}

/** A second of mono 16-bit silence at the narration port's own rate, written by its own encoder. */
function narrationWav(directory: string): string {
  const path = join(directory, "narration.wav");
  writeFileSync(
    path,
    encodeWav({
      format: { channels: 1, sampleWidth: 2, sampleRate: DEFAULT_SAMPLE_RATE },
      data: Buffer.alloc(DEFAULT_SAMPLE_RATE * 2),
    }),
  );
  return path;
}

// A real ffmpeg, so the same switch as the render test: CI installs one and never sets it.
describe.skipIf(process.env.XPLAINER_SKIP_RENDER_TEST === "1")(
  "the encoder, against a real ffmpeg",
  () => {
    it("accepts an ffmpeg with libx264, and refuses one without it by name", async () => {
      await expect(assertLibx264(realFfmpeg())).resolves.toBeUndefined();

      const directory = temporaryDirectory();
      const noX264 = join(directory, "ffmpeg");
      writeFileSync(
        noX264,
        "#!/bin/sh\necho 'Encoders:'\necho ' V....D libx265              libx265 H.265'\n",
      );
      chmodSync(noX264, 0o755);
      await expect(assertLibx264(noX264)).rejects.toMatchObject({ code: "FFMPEG_NO_LIBX264" });
      await expect(assertLibx264(join(directory, "missing"))).rejects.toMatchObject({
        code: "FFMPEG_NOT_FOUND",
      });
    });

    it("refuses an ffmpeg that never answers -encoders, by name and inside its budget", async () => {
      const directory = temporaryDirectory();
      const hangs = join(directory, "ffmpeg");
      writeFileSync(hangs, "#!/bin/sh\nexec sleep 30\n");
      chmodSync(hangs, 0o755);

      const started = performance.now();
      await expect(assertLibx264(hangs, 300)).rejects.toMatchObject({
        code: "FFMPEG_NOT_FOUND",
        message: expect.stringContaining("did not answer `-encoders` within 300 ms"),
      });
      expect(performance.now() - started).toBeLessThan(5_000);
    });

    it("renames the finished MP4 into place and leaves no partial behind", async () => {
      const ffmpeg = realFfmpeg();
      const directory = temporaryDirectory();
      const output = join(directory, "explainer.mp4");
      const encoder = startEncoder({ ffmpeg, fps: 30, audio: narrationWav(directory), output });
      expect(encoder.partial).toBe(partialPath(output));

      for (const png of pngFrames(ffmpeg, 30)) {
        await encoder.write(png);
      }
      await encoder.finish();

      expect(readdirSync(directory).sort()).toEqual(["explainer.mp4", "narration.wav"]);
    });

    it("fails as ENCODE_FAILED with ffmpeg's own words, and removes the partial", async () => {
      const ffmpeg = realFfmpeg();
      const directory = temporaryDirectory();
      const output = join(directory, "explainer.mp4");
      const encoder = startEncoder({
        ffmpeg,
        fps: 30,
        audio: join(directory, "no-such.wav"),
        output,
      });

      const failure = (async () => {
        for (const png of pngFrames(ffmpeg, 5)) {
          await encoder.write(png);
        }
        await encoder.finish();
      })();

      await expect(failure).rejects.toMatchObject({
        code: "ENCODE_FAILED",
        message: expect.stringContaining("no-such.wav"),
      });
      expect(existsSync(output)).toBe(false);
      expect(existsSync(encoder.partial)).toBe(false);
    });

    /**
     * The same failure on frames the size Chrome sends. A 1080p PNG is far past the pipe's
     * buffer, so `write()` waits on `drain` — and when ffmpeg has already gone, that wait ends in
     * the pipe's EPIPE, which must arrive as ENCODE_FAILED with ffmpeg's words, not as itself.
     */
    it("fails as ENCODE_FAILED, not as EPIPE, when ffmpeg dies while the pipe is full", async () => {
      const ffmpeg = realFfmpeg();
      const directory = temporaryDirectory();
      const output = join(directory, "explainer.mp4");
      const frames = pngFrames(ffmpeg, 3, "testsrc2=s=1920x1080:r=30");
      expect(Math.min(...frames.map((frame) => frame.length))).toBeGreaterThan(64 * 1024);
      const encoder = startEncoder({
        ffmpeg,
        fps: 30,
        audio: join(directory, "no-such.wav"),
        output,
      });

      const failure = (async () => {
        for (let frame = 0; frame < 200; frame += 1) {
          await encoder.write(frames[frame % frames.length] ?? Buffer.alloc(0));
        }
        await encoder.finish();
      })();

      await expect(failure).rejects.toMatchObject({
        code: "ENCODE_FAILED",
        message: expect.stringContaining("no-such.wav"),
      });
      expect(existsSync(output)).toBe(false);
    });

    it("aborts mid-stream leaving neither the MP4 nor the partial", async () => {
      const ffmpeg = realFfmpeg();
      const directory = temporaryDirectory();
      const output = join(directory, "explainer.mp4");
      const encoder = startEncoder({ ffmpeg, fps: 30, audio: narrationWav(directory), output });
      for (const png of pngFrames(ffmpeg, 10)) {
        await encoder.write(png);
      }

      await encoder.abort();
      await encoder.finish();

      expect(existsSync(output)).toBe(false);
      expect(existsSync(encoder.partial)).toBe(false);
    });
  },
);
