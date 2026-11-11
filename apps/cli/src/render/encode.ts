/**
 * The encoder: a spawned `ffmpeg` that takes PNG frames on stdin and the narration as a second
 * input, and writes one fast-start MP4.
 *
 * **ffmpeg is only ever a separate process.** Nothing here links it, bundles it or ships it; it is
 * found on this machine ({@link resolveFfmpeg}) and spoken to over a pipe. One process does the
 * whole job — decode the PNGs, convert RGB to limited-range BT.709 4:2:0, encode H.264 with
 * libx264, resample the narration to 48 kHz, encode AAC and mux — because each of those as a
 * separate step costs a copy of the video and agrees with nothing about timing.
 *
 * **The colour tags are set in the filter graph, not as output options.** Given as
 * `-color_primaries`/`-color_trc` output options they were written as `unknown`, with no `colr`
 * box, when the frames came through this graph (ffmpeg 8.1, measured in the Phase 0 spike).
 *
 * **PNG bytes go to ffmpeg as Chrome produced them.** Decoding them in Node and sending raw frames
 * made Node the bottleneck at a third of the speed and wrote the identical file, so the capture
 * loop writes each screenshot straight to stdin and waits for `drain` only when `write()` says the
 * pipe is full.
 *
 * **The output appears whole or not at all.** ffmpeg writes `.explainer.mp4.partial-<pid>` beside
 * the target and the file is renamed onto `explainer.mp4` only after ffmpeg exits 0, so a reader
 * never sees half an MP4 and a failed or cancelled render leaves the previous one in place.
 */

import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, posix, win32 } from "node:path";
import process from "node:process";
import { RenderError } from "./render-error.js";

/** The variable that names an ffmpeg explicitly, ahead of everything else. */
export const FFMPEG_ENV = "XPLAINER_FFMPEG";

/**
 * Where ffmpeg is installed on a Mac and on a Linux box with a hand-built one, looked at after
 * `PATH`. A launchd or systemd daemon's `PATH` contains neither, so a Homebrew ffmpeg that works
 * in a terminal is invisible to the daemon without them.
 */
export const WELL_KNOWN_FFMPEG: readonly string[] = [
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
];

/** How much of ffmpeg's stderr is kept for a failure message. */
const STDERR_TAIL_CHARS = 4_000;

/** Where {@link resolveFfmpeg} looks, so a test can say what the machine has. */
export type FfmpegLookup = {
  /** The environment `XPLAINER_FFMPEG` and `PATH` are read from. */
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  /** Whether `path` is a file this process could run. */
  isExecutable: (path: string) => boolean;
};

/** Whether `path` is a regular file with an execute bit (any file, on Windows). */
export function isExecutableFile(path: string): boolean {
  try {
    const stats = statSync(path);
    return stats.isFile() && (process.platform === "win32" || (stats.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

/**
 * The ffmpeg this render will use: `XPLAINER_FFMPEG`, else the first on `PATH`, else a well-known
 * install directory — or `FFMPEG_NOT_FOUND` naming every place looked and how to fix it.
 *
 * `XPLAINER_FFMPEG` naming something that is not there is a refusal rather than a fall-through:
 * whoever set it meant that file, and quietly using a different ffmpeg would make the variable
 * mean nothing.
 */
export function resolveFfmpeg(lookup: FfmpegLookup): string {
  const named = lookup.env[FFMPEG_ENV]?.trim();
  if (named !== undefined && named !== "") {
    if (lookup.isExecutable(named)) {
      return named;
    }
    throw new RenderError(
      "FFMPEG_NOT_FOUND",
      `${FFMPEG_ENV} names ${named}, which is not an executable file. Point it at an ffmpeg ` +
        "binary, or unset it to use the one on PATH.",
    );
  }

  const windows = lookup.platform === "win32";
  const name = windows ? "ffmpeg.exe" : "ffmpeg";
  const paths = windows ? win32 : posix;
  const pathValue = lookup.env.PATH ?? lookup.env.Path ?? "";
  const directories = pathValue.split(paths.delimiter).filter((entry) => entry !== "");
  for (const directory of directories) {
    const candidate = paths.join(directory, name);
    if (lookup.isExecutable(candidate)) {
      return candidate;
    }
  }
  const wellKnown = windows ? [] : WELL_KNOWN_FFMPEG;
  for (const candidate of wellKnown) {
    if (lookup.isExecutable(candidate)) {
      return candidate;
    }
  }

  const looked = [`${FFMPEG_ENV} (unset)`, "PATH", ...wellKnown].join(", ");
  throw new RenderError(
    "FFMPEG_NOT_FOUND",
    `a render needs ffmpeg and none was found (looked in ${looked}). Install it — ` +
      "`brew install ffmpeg` on macOS, `sudo apt install ffmpeg` on Debian or Ubuntu — or set " +
      `${FFMPEG_ENV} to the path of an ffmpeg binary. \`xplainer setup\` does not acquire ffmpeg ` +
      "in this release.",
  );
}

/** {@link resolveFfmpeg} against this process's environment and this machine's files. */
export function findFfmpeg(): string {
  return resolveFfmpeg({
    env: process.env,
    platform: process.platform,
    isExecutable: isExecutableFile,
  });
}

/**
 * Refuse an ffmpeg that cannot encode H.264 with libx264, before a frame is captured.
 *
 * libx264 is the only H.264 encoder this pipeline uses: it is the one with a CRF, the one that
 * reproduces its own bytes for the same frames, and the one every ffmpeg build configured with
 * `--enable-gpl` carries. A build without it would fail only after every frame had been captured.
 */
export async function assertLibx264(ffmpeg: string): Promise<void> {
  let listing: string;
  try {
    listing = await new Promise<string>((resolve, reject) => {
      execFile(
        ffmpeg,
        ["-hide_banner", "-encoders"],
        { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
        (error, stdout) => {
          if (error !== null) {
            reject(error);
          } else {
            resolve(stdout);
          }
        },
      );
    });
  } catch (error) {
    throw new RenderError(
      "FFMPEG_NOT_FOUND",
      `${ffmpeg} could not be run (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  if (!/^\s*V\S*\s+libx264\s/m.test(listing)) {
    throw new RenderError(
      "FFMPEG_NO_LIBX264",
      `${ffmpeg} has no libx264 encoder, which every render uses. Install an ffmpeg built with ` +
        `--enable-gpl --enable-libx264 (Homebrew's and Debian's both are), or point ${FFMPEG_ENV} ` +
        "at one.",
    );
  }
}

/** What one encode is: the frame rate, the narration track, and the file ffmpeg writes. */
export type EncodeArgsInput = {
  fps: number;
  /** The narration WAV, `public/<slug>/<timings.audio>`. */
  audio: string;
  /** Where ffmpeg writes — the partial file, never the final name. */
  output: string;
};

/** The video half of the filter graph: RGB to limited-range BT.709 4:2:0, tagged on the frames. */
export const VIDEO_FILTER: string =
  "[0:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p," +
  "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv[v]";

/** The audio half: the narration resampled to 48 kHz inside the same process. */
export const AUDIO_FILTER = "[1:a]aresample=48000[a]";

/** ffmpeg's whole argument list for one render. */
export function encodeArgs(input: EncodeArgsInput): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "image2pipe",
    "-c:v",
    "png",
    "-framerate",
    String(input.fps),
    "-i",
    "pipe:0",
    "-i",
    input.audio,
    "-filter_complex",
    `${VIDEO_FILTER};${AUDIO_FILTER}`,
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
    input.output,
  ];
}

/** The partial file one worker process writes before the rename. */
export function partialPath(finalPath: string, pid: number = process.pid): string {
  return join(dirname(finalPath), `.${basename(finalPath)}.partial-${pid}`);
}

/** A running encode. */
export type Encoder = {
  /** The file ffmpeg is writing. */
  partial: string;
  /** Write one PNG; resolves once the pipe has room for the next. */
  write: (png: Buffer) => Promise<void>;
  /** Close stdin, wait for ffmpeg, and rename the partial onto the final path. */
  finish: () => Promise<void>;
  /** Kill ffmpeg now, wait for it, and remove the partial. Safe to call more than once. */
  abort: () => Promise<void>;
};

/** What {@link startEncoder} needs. */
export type StartEncoderOptions = {
  ffmpeg: string;
  fps: number;
  audio: string;
  /** `out/<slug>/explainer.mp4`. Only ever written by a rename. */
  output: string;
};

/**
 * Start ffmpeg, waiting on stdin for the first frame.
 *
 * Started before the browser so its own start-up overlaps Chrome's. Not detached: like Chrome it
 * stays in the worker's process group, which is what the daemon signals.
 */
export function startEncoder(options: StartEncoderOptions): Encoder {
  const partial = partialPath(options.output);
  // A partial left by an earlier process with this pid would make ffmpeg refuse ("already
  // exists"), and it cannot ask: stdin is the frame pipe.
  rmSync(partial, { force: true });
  const child = spawn(
    options.ffmpeg,
    encodeArgs({ fps: options.fps, audio: options.audio, output: partial }),
    { stdio: ["pipe", "ignore", "pipe"] },
  );

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (data: string) => {
    stderr = (stderr + data).slice(-STDERR_TAIL_CHARS);
  });
  let failure: Error | null = null;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      failure ??= error;
      resolve({ code: null, signal: null });
    });
  });
  child.stdin?.on("error", (error: Error) => {
    failure ??= error;
  });

  const encodeFailed = (detail: string): RenderError =>
    new RenderError(
      "ENCODE_FAILED",
      `${options.ffmpeg} ${detail}${stderr.trim() === "" ? "" : `:\n${stderr.trim()}`}`,
    );

  let aborted = false;
  const abort = async (): Promise<void> => {
    aborted = true;
    child.kill("SIGKILL");
    await exited;
    rmSync(partial, { force: true });
  };

  return {
    partial,
    async write(png: Buffer): Promise<void> {
      const stdin = child.stdin;
      if (failure !== null || child.exitCode !== null || stdin === null) {
        await exited;
        throw encodeFailed(
          `stopped accepting frames (${failure?.message ?? `exit ${child.exitCode}`})`,
        );
      }
      if (!stdin.write(png)) {
        await Promise.race([once(stdin, "drain"), exited]);
      }
    },
    async finish(): Promise<void> {
      child.stdin?.end();
      const { code, signal } = await exited;
      if (aborted) {
        return;
      }
      if (code !== 0) {
        rmSync(partial, { force: true });
        throw encodeFailed(
          failure !== null
            ? `failed (${failure.message})`
            : `exited with ${code === null ? `signal ${String(signal)}` : `code ${code}`}`,
        );
      }
      if (!existsSync(partial)) {
        throw encodeFailed("exited 0 and wrote nothing");
      }
      renameSync(partial, options.output);
    },
    abort,
  };
}
