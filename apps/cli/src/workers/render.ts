/**
 * The `explainer_still` and `explainer_render` worker: one picture, or one MP4, in its own process.
 *
 * Spawned by `daemon/workers.ts` with two arguments — the workspace root and the job id — and the
 * daemon's state directory in `XPLAINER_STATE_DIR`. Everything else is read back from disk: the
 * request document says which video, which kind of job, and for a still which frame at which
 * scale; `toolchain.json` says which browser `xplainer setup` acquired.
 *
 * The pipeline is four steps, each failing by name:
 *
 *   1. bundle the video into a per-job directory under `out/<slug>/`  (`BUNDLE_FAILED`)
 *   2. start the recorded headless shell over a CDP pipe               (`CHROME_LAUNCH_FAILED`)
 *   3. open the bundle and step it one frame at a time                 (`PAGE_ERROR`, `READINESS_TIMEOUT`, …)
 *   4. a still is one PNG; a render pipes every PNG into a spawned
 *      ffmpeg, which muxes the narration and writes the MP4           (`FFMPEG_NOT_FOUND`, `ENCODE_FAILED`)
 *
 * **What it prints is the job's log.** stdout carries a start line, a progress line at least every
 * fifteen frames — `{"event":"progress","frame":n,"of":N,"captureFps":x}` — and a final
 * `{"event":"done",…}`; a failure is one `<CODE>: <sentence>` on stderr and a non-zero exit, which
 * the runner records as `render_failed`.
 *
 * **A signal is a cancellation, and it leaves nothing behind.** `SIGTERM` and `SIGINT` — the
 * daemon's drain and an agent's cancel both arrive as a `SIGTERM` to the whole process group —
 * kill ffmpeg and Chrome, wait for both, remove the partial MP4, the browser profile and the
 * bundle directory, and exit non-zero, well inside the two seconds the runner gives the group
 * before it sends `SIGKILL`.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import type { Timings } from "@xplainer/protocol";
import { stillOutput, videoPaths } from "@xplainer/render-core";
import { STATE_DIR_ENV } from "../daemon/state-dir.js";
import { type JobRequest, jobRequestPath, readJobRequest } from "../job-request.js";
import { bundleVideo } from "../render/bundle.js";
import { openVideoPage } from "../render/capture.js";
import { type Chrome, launchChrome } from "../render/cdp.js";
import { assertLibx264, type Encoder, findFfmpeg, startEncoder } from "../render/encode.js";
import { RenderError } from "../render/render-error.js";
import { readToolchainMarker } from "../setup/toolchain.js";

/** A progress line is printed at least this often, in frames. */
export const PROGRESS_EVERY_FRAMES = 15;

/** The exit code of a worker stopped by a signal: the shell's 128 + SIGTERM. */
const SIGNALLED_EXIT_CODE = 143;

/** What has to be undone if the worker is stopped part-way. */
const live: { chrome: Chrome | null; encoder: Encoder | null; paths: Set<string> } = {
  chrome: null,
  encoder: null,
  paths: new Set(),
};
let stopping = false;

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

function chromePath(): string {
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
  return marker.chrome.path;
}

function readTimings(path: string): Timings {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Timings;
  } catch (error) {
    throw new RenderError("RENDER_FAILED", `${path} is not readable (${String(error)}).`);
  }
}

/** Remove everything a stopped or failed run made, ignoring what is already gone. */
async function cleanUp(): Promise<void> {
  const { chrome, encoder } = live;
  live.chrome = null;
  live.encoder = null;
  await Promise.all([encoder?.abort(), stopping ? chrome?.kill() : chrome?.close()]);
  for (const path of live.paths) {
    rmSync(path, { recursive: true, force: true });
  }
  live.paths.clear();
}

async function onSignal(signal: NodeJS.Signals): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  // Nothing the main path does after this point is reported: Chrome and ffmpeg are about to be
  // killed under it, and the failures that causes are this signal, not a defect.
  await cleanUp().catch(() => undefined);
  process.stderr.write(
    `RENDER_CANCELLED: the worker received ${signal} and stopped; nothing was written.\n`,
  );
  process.exit(SIGNALLED_EXIT_CODE);
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
  const executable = chromePath();
  const still = request.job_type === "explainer_still" ? request : null;

  // Refused before anything is bundled or launched: a render that would fail at the encoder should
  // fail in the first second, not after every frame has been captured.
  const ffmpeg = still === null ? findFfmpeg() : null;
  if (ffmpeg !== null) {
    await assertLibx264(ffmpeg);
  }
  say(
    `[xplainer] ${still === null ? "rendering" : `still of frame ${still.frame} at scale ${still.scale} for`} ` +
      `${request.slug} (job ${jobId}) with ${executable}${ffmpeg === null ? "" : ` and ${ffmpeg}`}`,
  );

  mkdirSync(video.out, { recursive: true });
  const bundleDir = join(video.out, `.render-${jobId}`);
  live.paths.add(bundleDir);
  const bundle = await bundleVideo({ root, slug: request.slug, outDir: bundleDir, log: say });
  say(
    `[xplainer] bundled in ${Math.round(bundle.durationMs)} ms (${bundle.candidates} Tailwind candidates)`,
  );

  const chrome = await launchChrome({ executable, log: say });
  live.chrome = chrome;
  say(`[xplainer] chrome ${chrome.pid} started with profile ${chrome.userDataDir}`);
  const page = await openVideoPage({
    chrome,
    url: bundle.url,
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
    const png = await page.capture(still.frame);
    output = stillOutput(video, still.frame);
    const partial = `${output}.partial-${process.pid}`;
    live.paths.add(partial);
    writeFileSync(partial, png);
    renameSync(partial, output);
    live.paths.delete(partial);
  } else {
    const timings = readTimings(video.timings);
    const encoder = startEncoder({
      ffmpeg: ffmpeg ?? "ffmpeg",
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
        const seconds = (performance.now() - loopStarted) / 1000;
        event({
          event: "progress",
          frame: done,
          of: total,
          captureFps: Math.round((done / seconds) * 100) / 100,
        });
      }
    }
    await encoder.finish();
    live.encoder = null;
    output = video.mp4;
  }

  await cleanUp();
  if (stopping) {
    return;
  }
  event({
    event: "done",
    output,
    bytes: statSync(output).size,
    durationMs: Math.round(performance.now() - started),
  });
}

// `on`, not `once`: a second signal during the cleanup must meet this handler, which ignores it,
// rather than Node's default, which would end the process before the partial is removed.
process.on("SIGTERM", (signal) => {
  void onSignal(signal);
});
process.on("SIGINT", (signal) => {
  void onSignal(signal);
});

main().catch(async (error: unknown) => {
  if (stopping) {
    return;
  }
  await cleanUp().catch(() => undefined);
  const message =
    error instanceof RenderError
      ? error.message
      : `RENDER_FAILED: ${error instanceof Error ? error.message : String(error)}`;
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
