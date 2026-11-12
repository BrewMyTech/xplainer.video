/**
 * The `explainer_still` and `explainer_render` worker: one picture, or one MP4, in its own process.
 *
 * Spawned by `daemon/workers.ts` with two arguments — the workspace root and the job id — and the
 * daemon's state directory in `XPLAINER_STATE_DIR`. Everything else is read back from disk: the
 * request document says which video, which kind of job, and for a still which frame at which
 * scale; `toolchain.json` says which browser `xplainer setup` acquired and, for a render, which
 * ffmpeg — unless `XPLAINER_FFMPEG` names one, which wins and is then asked for libx264 here,
 * because nothing else has probed it.
 *
 * The pipeline is four steps, each failing by name:
 *
 *   1. bundle the video into a per-job directory under `out/<slug>/`  (`BUNDLE_FAILED`)
 *   2. start the recorded headless shell over a CDP pipe               (`CHROME_LAUNCH_FAILED`)
 *   3. open the bundle from a loopback server, step it frame by frame (`PAGE_ERROR`, `READINESS_TIMEOUT`, …)
 *   4. a still is one PNG; a render pipes every PNG into a spawned
 *      ffmpeg, which muxes the narration and writes the MP4           (`FFMPEG_NOT_FOUND`, `ENCODE_FAILED`)
 *
 * **A still is the render's frame, not a fresh page's.** The page keeps state across frames, so
 * before capturing frame `n` the worker sets frames `0` to `n - 1` without a screenshot, in the
 * order a render sets them, and logs how long that took.
 *
 * **What it prints is the job's log.** stdout carries a start line, a progress line at least every
 * fifteen frames — `{"event":"progress","frame":n,"of":N,"captureFps":x}` — and a final
 * `{"event":"done",…}`; a failure is one `<CODE>: <sentence>` on stderr and a non-zero exit, which
 * the runner records as `render_failed`. **The `done` event names the encoder**: `ffmpeg` is
 * `{"path","source"}`, `source` being `XPLAINER_FFMPEG` or `toolchain.json`, and `null` for a
 * still. The start line says the same, but the job keeps a bounded tail of sixty lines and a long
 * render's progress lines push it out; the last line is the one that tail always keeps, so it is
 * where a caller — `scripts/e2e/` among them — reads which ffmpeg encoded the MP4.
 *
 * **The page is served, never opened from `file://`.** The worker starts `render/bundle.ts`'s
 * `servePage()` on `127.0.0.1` before it bundles — the bundle's `staticFile()` base is that
 * server's `/<token>/public/` — and closes it with everything else. A `file:` page could show any
 * image the daemon's user can read; an `http:` one cannot load `file:` at all.
 *
 * **A signal is a cancellation, and it leaves nothing behind.** `SIGTERM` and `SIGINT` — the
 * daemon's drain and an agent's cancel both arrive as a `SIGTERM` to the whole process group —
 * kill ffmpeg and Chrome, wait for both, remove the partial MP4, the browser profile and the
 * bundle directory, and exit 143 or 130, well inside the two seconds the runner gives the group
 * before it sends `SIGKILL`. There is one cleanup and everyone awaits it: a signal that lands while
 * a failure is already being cleaned up waits for that cleanup rather than exiting under it.
 *
 * **Once the output is in place, the job has succeeded.** Cleanup after the rename is best-effort —
 * a bundle directory Windows will not let go of yet is a log line, not a failed render — and a
 * signal that arrives then says the output was written rather than that nothing was.
 *
 * **A worker that died without cleaning up is cleaned up after by the next one.** At start, holding
 * the video's write lock (the daemon took it for this job), the worker removes `.render-<job>`
 * directories and `*.partial-<pid>` files that earlier workers for this video left in
 * `out/<slug>/`. Browser profiles a `SIGKILL` left in the temporary directory are not aged out:
 * they are not this video's, and nothing yet says when one is abandoned.
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import type { Timings, Toolchain } from "@xplainer/protocol";
import { stillOutput, videoPaths } from "@xplainer/render-core";
import { STATE_DIR_ENV } from "../daemon/state-dir.js";
import { type JobRequest, jobRequestPath, readJobRequest } from "../job-request.js";
import { bundleVideo, type PageServer, servePage } from "../render/bundle.js";
import { openVideoPage } from "../render/capture.js";
import { type Chrome, launchChrome } from "../render/cdp.js";
import {
  assertLibx264,
  type Encoder,
  findFfmpeg,
  type ResolvedFfmpeg,
  startEncoder,
} from "../render/encode.js";
import { RenderError } from "../render/render-error.js";
import { readToolchainMarker } from "../setup/toolchain.js";

/** A progress line is printed at least this often, in frames. */
export const PROGRESS_EVERY_FRAMES = 15;

/** The exit code of a worker stopped by a signal: the shell's 128 + the signal's number. */
const SIGNALLED_EXIT_CODES: Readonly<Record<"SIGINT" | "SIGTERM", number>> = {
  SIGINT: 130,
  SIGTERM: 143,
};

/** What has to be undone if the worker is stopped part-way, and what it has already finished. */
const live: {
  chrome: Chrome | null;
  encoder: Encoder | null;
  server: PageServer | null;
  paths: Set<string>;
  /** The output, once it is complete and in place. */
  written: string | null;
} = {
  chrome: null,
  encoder: null,
  server: null,
  paths: new Set(),
  written: null,
};
let stopping = false;
let cleaning: Promise<void> | null = null;

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function event(fields: Record<string, unknown>): void {
  say(JSON.stringify(fields));
}

/** The request's job type, read before the typed reader that needs it is called. */
function requestedJobType(root: string, jobId: number): JobRequest["job_type"] {
  const path = jobRequestPath(root, jobId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new RenderError(
      "RENDER_FAILED",
      `job ${jobId}'s request ${path} is unreadable (${String(error)}).`,
    );
  }
  const type =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { job_type?: unknown }).job_type
      : null;
  if (type !== "explainer_still" && type !== "explainer_render") {
    throw new RenderError(
      "RENDER_FAILED",
      `job ${jobId}'s request ${path} is a ${String(type)} job, which this worker does not run.`,
    );
  }
  return type;
}

/** The marker `setup` wrote in this daemon's state directory: the browser's path, and ffmpeg's. */
function recordedToolchain(): Toolchain {
  const stateDir = process.env[STATE_DIR_ENV];
  if (stateDir === undefined || stateDir === "") {
    throw new RenderError(
      "TOOLCHAIN_MISSING",
      `${STATE_DIR_ENV} is not set, so there is no toolchain.json to read the browser from.`,
    );
  }
  const marker = readToolchainMarker(stateDir);
  if (marker === null) {
    throw new RenderError(
      "TOOLCHAIN_MISSING",
      `${stateDir} has no complete toolchain.json, so no browser is recorded. Run \`xplainer setup\`.`,
    );
  }
  return marker;
}

function readTimings(path: string): Timings {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Timings;
  } catch (error) {
    throw new RenderError("RENDER_FAILED", `${path} is not readable (${String(error)}).`);
  }
}

/**
 * Remove everything this run made — the encoder and its partial, the browser and its profile, the
 * page server, the bundle directory — once. Every caller awaits the same promise, so the second
 * one waits for the first to finish rather than finding nothing left to do and exiting under it.
 * Every step is attempted; the first failure is rethrown at the end.
 */
function cleanUp(): Promise<void> {
  cleaning ??= (async () => {
    const { chrome, encoder, server } = live;
    const results = await Promise.allSettled([
      encoder?.abort(),
      stopping ? chrome?.kill() : chrome?.close(),
      server?.close(),
    ]);
    const failures: unknown[] = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    for (const path of live.paths) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
    }
    live.paths.clear();
    if (failures.length > 0) {
      throw failures[0];
    }
  })();
  return cleaning;
}

/**
 * Remove what earlier workers for this video left when they died without cleaning up: `.render-<job>`
 * bundle directories and `*.partial-<pid>` files in `out/<slug>/`. Only safe because the daemon
 * holds this video's write lock for this job, so no other worker is writing there.
 */
function sweepLeftovers(outDir: string): void {
  let names: string[];
  try {
    names = readdirSync(outDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^\.render-\d+$/.test(name) && !/\.partial-\d+$/.test(name)) {
      continue;
    }
    try {
      rmSync(join(outDir, name), { recursive: true, force: true });
      say(`[xplainer] removed ${name} from ${outDir}, left by an earlier run that did not finish`);
    } catch (error) {
      say(`[xplainer] could not remove ${name} from ${outDir}: ${String(error)}`);
    }
  }
}

async function onSignal(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  // Nothing the main path does after this point is reported: Chrome and ffmpeg are about to be
  // killed under it, and the failures that causes are this signal, not a defect. A cleanup already
  // under way may be waiting on `Browser.close`; killing now cuts that wait short.
  live.chrome?.kill().catch(() => undefined);
  await cleanUp().catch(() => undefined);
  process.stderr.write(
    live.written === null
      ? `RENDER_CANCELLED: the worker received ${signal} and stopped; nothing was written.\n`
      : `RENDER_CANCELLED: the worker received ${signal} while cleaning up, after ${live.written} ` +
          "was written; that file is complete.\n",
  );
  process.exit(SIGNALLED_EXIT_CODES[signal]);
}

async function main(): Promise<void> {
  const [root, jobIdText] = process.argv.slice(2);
  if (root === undefined || jobIdText === undefined) {
    throw new RenderError("RENDER_FAILED", "usage: render <workspace-root> <job-id>");
  }
  const jobId = Number(jobIdText);
  if (!Number.isInteger(jobId)) {
    throw new RenderError(
      "RENDER_FAILED",
      `job id must be a whole number, not ${JSON.stringify(jobIdText)}.`,
    );
  }
  const started = performance.now();
  const jobType = requestedJobType(root, jobId);
  const request = readJobRequest(root, jobId, jobType);
  const video = videoPaths(root, request.slug);
  sweepLeftovers(video.out);
  const toolchain = recordedToolchain();
  const executable = toolchain.chrome.path;
  const still = request.job_type === "explainer_still" ? request : null;

  // Refused before anything is bundled or launched: a render that would fail at the encoder should
  // fail in the first second, not after every frame has been captured. A still encodes nothing, so
  // it asks for no ffmpeg at all.
  const ffmpeg: ResolvedFfmpeg | null =
    still === null ? findFfmpeg(toolchain.ffmpeg?.path ?? null) : null;
  if (ffmpeg?.source === "override") {
    await assertLibx264(ffmpeg.path);
  }
  const encodedWith =
    ffmpeg === null
      ? null
      : {
          path: ffmpeg.path,
          source: ffmpeg.source === "override" ? "XPLAINER_FFMPEG" : "toolchain.json",
        };
  say(
    `[xplainer] ${still === null ? "rendering" : `still of frame ${still.frame} at scale ${still.scale} for`} ` +
      `${request.slug} (job ${jobId}) with ${executable}` +
      `${encodedWith === null ? "" : ` and ${encodedWith.path} (${encodedWith.source})`}`,
  );

  mkdirSync(video.out, { recursive: true });
  const bundleDir = join(video.out, `.render-${jobId}`);
  live.paths.add(bundleDir);
  // Started first, so the bundle's `staticFile()` base can be this server's own address.
  const server = await servePage({ pageDir: bundleDir, publicDir: video.publicDir });
  live.server = server;
  const bundle = await bundleVideo({
    root,
    slug: request.slug,
    outDir: bundleDir,
    log: say,
    publicBase: server.publicBase,
  });
  say(
    `[xplainer] bundled in ${Math.round(bundle.durationMs)} ms (${bundle.candidates} Tailwind ` +
      `candidates), served at ${server.origin}`,
  );

  const chrome = await launchChrome({ executable, log: say });
  live.chrome = chrome;
  say(`[xplainer] chrome ${chrome.pid} started with profile ${chrome.userDataDir}`);
  const page = await openVideoPage({
    chrome,
    url: server.url,
    deviceScaleFactor: still?.scale ?? 1,
    log: say,
  });
  const { metadata } = page;
  say(
    `[xplainer] ${metadata.width}x${metadata.height}, ${metadata.durationInFrames} frames at ` +
      `${metadata.fps} fps`,
  );

  let output: string;
  if (still !== null) {
    if (still.frame >= metadata.durationInFrames) {
      throw new RenderError(
        "FRAME_OUT_OF_RANGE",
        `frame ${still.frame} is past the end of ${request.slug}, whose last frame is ` +
          `${metadata.durationInFrames - 1}.`,
      );
    }
    // The page keeps state from frame to frame — a CSS animation runs from the frame it was first
    // seen on, timers accumulate, Math.random advances — so a still is stepped through every frame
    // the render would have set before it, and shows what the render shows there.
    const preRollStarted = performance.now();
    for (let frame = 0; frame < still.frame; frame += 1) {
      await page.seek(frame);
    }
    if (still.frame > 0) {
      say(
        `[xplainer] pre-rolled frames 0 to ${still.frame - 1} in ` +
          `${Math.round(performance.now() - preRollStarted)} ms`,
      );
    }
    const png = await page.capture(still.frame);
    output = stillOutput(video, still.frame);
    const partial = `${output}.partial-${process.pid}`;
    live.paths.add(partial);
    writeFileSync(partial, png);
    renameSync(partial, output);
    live.paths.delete(partial);
    live.written = output;
  } else {
    // Resolved above for every render; the check is here so no bare `ffmpeg` — a `PATH` lookup by
    // another name — can ever be what is spawned.
    if (ffmpeg === null) {
      throw new RenderError("FFMPEG_NOT_FOUND", "a render reached the encoder with no ffmpeg.");
    }
    const timings = readTimings(video.timings);
    const encoder = startEncoder({
      ffmpeg: ffmpeg.path,
      fps: metadata.fps,
      audio: join(video.publicDir, timings.audio),
      output: video.mp4,
    });
    live.encoder = encoder;
    const total = metadata.durationInFrames;
    const loopStarted = performance.now();
    for (let frame = 0; frame < total; frame += 1) {
      await encoder.write(await page.capture(frame));
      const done = frame + 1;
      if (done % PROGRESS_EVERY_FRAMES === 0 || done === total) {
        // A clock that has not moved yet would make this Infinity, which JSON prints as `null`.
        const fps = done / ((performance.now() - loopStarted) / 1000);
        event({
          event: "progress",
          frame: done,
          of: total,
          captureFps: Number.isFinite(fps) ? Math.round(fps * 100) / 100 : 0,
        });
      }
    }
    await encoder.finish();
    live.encoder = null;
    // A signal during `finish()` aborts it before the rename, and is reported by its own handler.
    if (stopping) {
      return;
    }
    output = video.mp4;
    live.written = output;
  }

  // The output is complete and in place: from here, a cleanup that fails is a line in the log.
  try {
    await cleanUp();
  } catch (error) {
    say(
      `[xplainer] ${output} is written, but cleaning up after it failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (stopping) {
    return;
  }
  event({
    event: "done",
    output,
    bytes: statSync(output).size,
    durationMs: Math.round(performance.now() - started),
    ffmpeg: encodedWith,
  });
}

// `on`, not `once`: a second signal during the cleanup must meet this handler, which ignores it,
// rather than Node's default, which would end the process before the partial is removed.
process.on("SIGTERM", () => {
  void onSignal("SIGTERM");
});
process.on("SIGINT", () => {
  void onSignal("SIGINT");
});

main().catch(async (error: unknown) => {
  if (stopping) {
    return;
  }
  await cleanUp().catch(() => undefined);
  // A signal that arrived during that cleanup waited for it, and reports the job itself.
  if (stopping) {
    return;
  }
  const message =
    error instanceof RenderError
      ? error.message
      : `RENDER_FAILED: ${error instanceof Error ? error.message : String(error)}`;
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
