/**
 * Render preflight — the cheapest of the gates that keep a broken video from
 * shipping as a plausible-looking file (ADR 0018, layer 4).
 *
 * The defect this exists for: a render whose narration was never produced, or
 * whose composition shell was hand-edited, used to succeed. Remotion drew the
 * frames, ffmpeg wrote the container, the job reported done, and the MP4 was
 * silent. Nothing in the pipeline noticed, because nothing looked.
 *
 * This module looks, before Remotion is spawned. It is deliberately pure: it
 * spawns no process, renders nothing, imports no Remotion package and writes
 * no file, which is what lets it live in a scaffold-phase package and be
 * unit-tested against a temp directory today. Roadmap phase 1 wires
 * `assertRenderable()` into the job runner in front of `renderArgs()` and
 * `stillArgs()`; the failure then costs a second instead of the minutes a
 * doomed render would have taken.
 *
 * Purity is also why `ENGINE_FILE_ALTERED` is reported rather than repaired
 * here. The repair belongs to `scaffoldVideo()`, which already owns writing
 * engine files from templates; a checker that silently rewrote the caller's
 * workspace would be a surprising thing to call.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_OWNED_FILES, readScaffoldTemplate } from "./scaffold/index.js";

/** The narration timings file, read from the render's `--public-dir`. */
const TIMINGS_FILE = "timings.json";

/** The word-level captions file, read from the render's `--public-dir`. */
const CAPTIONS_FILE = "captions.json";

/** The agent's scene entry point, in the video source directory. */
const SCENES_FILE = "Scenes.tsx";

export type PreflightCode =
  /** No `timings.json`: the video has never been narrated. */
  | "NARRATION_MISSING"
  /** `timings.json` exists but is not JSON, or is not the shape `Timings` describes. */
  | "NARRATION_UNREADABLE"
  /** No `captions.json`. */
  | "CAPTIONS_MISSING"
  /** `captions.json` exists but is not a JSON array. */
  | "CAPTIONS_UNREADABLE"
  /** `captions.json` parses to `[]`: the caption track would render blank. */
  | "CAPTIONS_EMPTY"
  /** `timings.json` names no audio track, or the file it names is absent. */
  | "AUDIO_MISSING"
  /** The audio file exists but is zero bytes: the render would be silent. */
  | "AUDIO_EMPTY"
  /** No `Scenes.tsx`: the composition shell has nothing to import. */
  | "SCENES_MISSING"
  /** An engine-owned file is missing or has drifted from its template. */
  | "ENGINE_FILE_ALTERED";

/**
 * `error` fails the job. `warning` is recorded in the job output and the render
 * proceeds — currently only `ENGINE_FILE_ALTERED`, which `scaffoldVideo()`
 * repairs rather than blocks on.
 */
export type PreflightSeverity = "error" | "warning";

export type PreflightProblem = {
  code: PreflightCode;
  severity: PreflightSeverity;
  /** The file the problem is about. */
  path: string;
  /** What is wrong, then the one action that fixes it. */
  message: string;
};

/** Thrown by `assertRenderable()`. Carries every blocking problem, not just the first. */
export class PreflightError extends Error {
  readonly code = "PREFLIGHT_FAILED";
  readonly problems: readonly PreflightProblem[];

  constructor(problems: readonly PreflightProblem[]) {
    super(
      `this video cannot be rendered yet:\n${problems.map((p) => `  - ${p.message}`).join("\n")}`,
    );
    this.name = "PreflightError";
    this.problems = problems;
  }
}

type ParsedTimings = { audio?: unknown };

function readJson(path: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/**
 * Everything wrong with one video, cheapest check first, in a fixed order.
 *
 * @param videoDir  the video's source directory, `<workspace>/videos/<slug>`
 * @param publicDir the directory Remotion serves `staticFile()` from,
 *                  `public/<slug>` — where narration writes `timings.json`,
 *                  `captions.json` and the audio track it names
 * @returns every problem found; an empty array means the render may proceed
 */
export function preflight(videoDir: string, publicDir: string): PreflightProblem[] {
  const problems: PreflightProblem[] = [];

  const timingsPath = join(publicDir, TIMINGS_FILE);
  let timings: ParsedTimings | null = null;

  if (!existsSync(timingsPath)) {
    problems.push({
      code: "NARRATION_MISSING",
      severity: "error",
      path: timingsPath,
      message: `this video has no narration: ${timingsPath} does not exist. Call explainer_narrate(slug) first.`,
    });
  } else {
    const parsed = readJson(timingsPath);
    if (!parsed.ok || !isRecord(parsed.value)) {
      problems.push({
        code: "NARRATION_UNREADABLE",
        severity: "error",
        path: timingsPath,
        message: `${timingsPath} is not readable as narration timings. Re-run explainer_narrate(slug) to rewrite it.`,
      });
    } else {
      timings = parsed.value as ParsedTimings;
    }
  }

  const captionsPath = join(publicDir, CAPTIONS_FILE);
  if (!existsSync(captionsPath)) {
    problems.push({
      code: "CAPTIONS_MISSING",
      severity: "error",
      path: captionsPath,
      message: `this video has no captions: ${captionsPath} does not exist. Call explainer_narrate(slug) first.`,
    });
  } else {
    const parsed = readJson(captionsPath);
    if (!parsed.ok || !Array.isArray(parsed.value)) {
      problems.push({
        code: "CAPTIONS_UNREADABLE",
        severity: "error",
        path: captionsPath,
        message: `${captionsPath} is not readable as a caption array. Re-run explainer_narrate(slug) to rewrite it.`,
      });
    } else if (parsed.value.length === 0) {
      problems.push({
        code: "CAPTIONS_EMPTY",
        severity: "error",
        path: captionsPath,
        message: `${captionsPath} is empty, so the video would render with no caption track. Re-run explainer_narrate(slug).`,
      });
    }
  }

  if (timings !== null) {
    const audio = timings.audio;
    if (typeof audio !== "string" || audio === "") {
      problems.push({
        code: "AUDIO_MISSING",
        severity: "error",
        path: timingsPath,
        message: `${timingsPath} names no audio track, so the video would render silent. Re-run explainer_narrate(slug).`,
      });
    } else {
      const audioPath = join(publicDir, audio);
      const size = sizeOf(audioPath);
      if (size === null) {
        problems.push({
          code: "AUDIO_MISSING",
          severity: "error",
          path: audioPath,
          message: `the narration audio ${timingsPath} names is missing: ${audioPath} does not exist, so the video would render silent. Re-run explainer_narrate(slug).`,
        });
      } else if (size === 0) {
        problems.push({
          code: "AUDIO_EMPTY",
          severity: "error",
          path: audioPath,
          message: `the narration audio is zero bytes: ${audioPath}, so the video would render silent. Re-run explainer_narrate(slug).`,
        });
      }
    }
  }

  const scenesPath = join(videoDir, SCENES_FILE);
  if (!existsSync(scenesPath)) {
    problems.push({
      code: "SCENES_MISSING",
      severity: "error",
      path: scenesPath,
      message: `${scenesPath} does not exist, so the composition has no scenes to place. Call explainer_create(slug) to scaffold it, then write your scenes into it.`,
    });
  }

  for (const name of ENGINE_OWNED_FILES) {
    const path = join(videoDir, name);
    const template = readScaffoldTemplate(name);
    let current: Buffer | null = null;
    try {
      current = readFileSync(path);
    } catch {
      current = null;
    }
    if (current !== null && Buffer.compare(current, template) === 0) continue;
    problems.push({
      code: "ENGINE_FILE_ALTERED",
      severity: "warning",
      path,
      message: `${path} is engine-owned and ${current === null ? "is missing" : "differs from the scaffold template"}; it will be restored. It mounts the narration audio, the caption track and the per-segment sequencing — write your scenes to ${SCENES_FILE} instead.`,
    });
  }

  return problems;
}

/**
 * `preflight()`, but it stops a doomed render instead of describing one.
 *
 * Throws `PreflightError` if anything blocking was found, so a caller that
 * forgets to inspect the return value still cannot ship a silent video.
 *
 * @returns the non-blocking warnings, for the job output
 */
export function assertRenderable(videoDir: string, publicDir: string): PreflightProblem[] {
  const problems = preflight(videoDir, publicDir);
  const blocking = problems.filter((problem) => problem.severity === "error");
  if (blocking.length > 0) throw new PreflightError(blocking);
  return problems;
}
