/**
 * Which ffmpeg a render uses, what it is told, and what happens to the file it writes.
 *
 * `resolveFfmpeg` is a pure function over an environment and a set of files, so its order is
 * asserted against machines described here rather than against this one. The encoder itself is
 * driven against a **real** ffmpeg — frames it generated itself, a WAV the narration port's own
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
import {
  AUDIO_FILTER,
  assertLibx264,
  encodeArgs,
  FFMPEG_ENV,
  findFfmpeg,
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

/** A machine with exactly these executables on it. */
function machine(
  files: readonly string[],
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = "linux",
): Parameters<typeof resolveFfmpeg>[0] {
  const present = new Set(files);
  return { env, platform, isExecutable: (path) => present.has(path) };
}

describe("resolveFfmpeg", () => {
  it("takes XPLAINER_FFMPEG over everything else", () => {
    const lookup = machine(["/custom/ffmpeg", "/usr/bin/ffmpeg"], {
      [FFMPEG_ENV]: "/custom/ffmpeg",
      PATH: "/usr/bin",
    });
    expect(resolveFfmpeg(lookup)).toBe("/custom/ffmpeg");
  });

  it("refuses an XPLAINER_FFMPEG that names nothing, rather than quietly using another", () => {
    const lookup = machine(["/usr/bin/ffmpeg"], { [FFMPEG_ENV]: "/gone/ffmpeg", PATH: "/usr/bin" });
    expect(() => resolveFfmpeg(lookup)).toThrow(
      /^FFMPEG_NOT_FOUND: XPLAINER_FFMPEG names \/gone\/ffmpeg/,
    );
  });

  it("takes the first ffmpeg on PATH, in PATH order", () => {
    const lookup = machine(["/b/ffmpeg", "/c/ffmpeg", "/opt/homebrew/bin/ffmpeg"], {
      PATH: "/a:/b:/c",
    });
    expect(resolveFfmpeg(lookup)).toBe("/b/ffmpeg");
  });

  /** A launchd or systemd daemon's PATH has neither directory, so they are asked after it. */
  it("falls back to /opt/homebrew/bin, then /usr/local/bin, when PATH has none", () => {
    const both = machine(["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"], {
      PATH: "/usr/bin:/bin",
    });
    expect(resolveFfmpeg(both)).toBe("/opt/homebrew/bin/ffmpeg");
    const local = machine(["/usr/local/bin/ffmpeg"], { PATH: "/usr/bin:/bin" });
    expect(resolveFfmpeg(local)).toBe("/usr/local/bin/ffmpeg");
  });

  it("refuses by name when there is no ffmpeg anywhere, saying how to get one", () => {
    let message = "";
    try {
      resolveFfmpeg(machine([], { PATH: "/usr/bin:/bin" }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/^FFMPEG_NOT_FOUND: /);
    expect(message).toContain("XPLAINER_FFMPEG");
    expect(message).toContain("brew install ffmpeg");
    expect(message).toContain("apt install ffmpeg");
    expect(message).toContain("`xplainer setup` does not acquire ffmpeg in this release");
  });

  it("looks for ffmpeg.exe on a Windows Path, and in no Unix directory", () => {
    const lookup = machine(
      ["C:\\tools\\ffmpeg.exe", "/opt/homebrew/bin/ffmpeg"],
      { Path: "C:\\bin;C:\\tools" },
      "win32",
    );
    expect(resolveFfmpeg(lookup)).toMatch(/tools.ffmpeg\.exe$/);
    expect(() =>
      resolveFfmpeg(machine(["/opt/homebrew/bin/ffmpeg"], { Path: "C:\\bin" }, "win32")),
    ).toThrow(/FFMPEG_NOT_FOUND/);
  });
});

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

/** PNG frames ffmpeg drew itself: `count` 64x36 frames of solid colour. */
function pngFrames(ffmpeg: string, count: number): Buffer[] {
  const stream = execFileSync(
    ffmpeg,
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x3366cc:s=64x36:r=30",
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
      await expect(assertLibx264(findFfmpeg())).resolves.toBeUndefined();

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

    it("renames the finished MP4 into place and leaves no partial behind", async () => {
      const ffmpeg = findFfmpeg();
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
      const ffmpeg = findFfmpeg();
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

    it("aborts mid-stream leaving neither the MP4 nor the partial", async () => {
      const ffmpeg = findFfmpeg();
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
