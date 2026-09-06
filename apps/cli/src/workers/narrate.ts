/**
 * The `explainer_narrate` worker: one narration run, in its own process.
 *
 * Spawned by `daemon/workers.ts` with two arguments — the workspace root and the job id — and
 * nothing else. Everything it needs it reads back from disk: the request document says which video
 * and whether this is a dry run, and the video's public directory holds the narration spec the
 * backend wrote there. Passing the arguments rather than reading them would mean the worker acted
 * on a copy of what was recorded instead of on the record itself.
 *
 * It is a separate process for two reasons, both of them properties of the daemon rather than of
 * narration: `serve` has to keep answering `/healthz` and `explainer_job` while a segment is being
 * synthesised, and a `SIGTERM` mid-run has to reach one killable process group exactly like a
 * render does.
 *
 * Everything it prints is the job's log tail — the runner captures both streams into the bounded
 * `log` of the record — so the lines are written for someone reading a failed poll.
 */

import { readFileSync } from "node:fs";
import process from "node:process";
import type { Narration } from "@xplainer/protocol";
import { narrate, videoPaths } from "@xplainer/render-core";
import { readJobRequest } from "../job-request.js";
import { resolveSpeech } from "./speech.js";

/** Read the narration spec `explainer_narrate` recorded for this video. */
function readNarration(path: string): Narration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} is not readable as a narration spec (${String(error)}).`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { segments?: unknown }).segments)
  ) {
    throw new Error(`${path} does not describe a narration: it has no segments array.`);
  }
  return parsed as Narration;
}

async function main(): Promise<void> {
  const [root, jobIdText] = process.argv.slice(2);
  if (root === undefined || jobIdText === undefined) {
    throw new Error("usage: narrate <workspace-root> <job-id>");
  }
  const jobId = Number(jobIdText);
  if (!Number.isInteger(jobId)) {
    throw new Error(`job id must be a whole number, not ${JSON.stringify(jobIdText)}.`);
  }

  const request = readJobRequest(root, jobId, "explainer_narrate");
  const video = videoPaths(root, request.slug);
  const narration = readNarration(video.narrationSpec);

  // A dry run must not construct a synthesiser at all: resolving one would report a Kokoro URL
  // that is never contacted, or fail on a fixture directory the run does not need.
  const speech = request.dry_run ? null : resolveSpeech();
  process.stdout.write(
    `[xplainer] narrating ${request.slug}: ${narration.segments.length} segment(s) from ` +
      `${speech === null ? "an estimated dry run — no speech server was contacted" : speech.source}\n`,
  );

  const result = await narrate({
    narration,
    outDir: video.publicDir,
    dryRun: request.dry_run,
    ...(speech === null ? {} : { client: speech.synthesiser }),
  });

  process.stdout.write(
    `[xplainer] wrote ${result.audioPath}, ${result.timingsPath} and ${result.captionsPath}\n`,
  );
  process.stdout.write(
    `[xplainer] mode ${result.mode}: ${result.timings.segments.length} segment(s), ` +
      `${result.timings.durationInFrames} frames at ${result.timings.fps} fps ` +
      `(${(result.timings.totalMs / 1000).toFixed(2)} s)\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[xplainer] narration failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
