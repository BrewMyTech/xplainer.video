/**
 * The one test that renders a real video (roadmap P1-1 local half, P1-2).
 *
 * It drives the whole product path in one go — `explainer_create`, `explainer_narrate`,
 * `explainer_still`, `explainer_render` — through the real backend, the real job runner and the
 * real spawned workers, and then asserts the MP4 with `ffprobe` and `ffmpeg` rather than with
 * anything this repository wrote. Nothing about the picture is taken on trust: a render that
 * "succeeded" and produced a silent, wrongly-timed or 300-frame placeholder file is exactly the
 * failure ADR 0018 exists for, and every one of those looks like success from inside Node.
 *
 * **The two claims it makes, and how.**
 *
 *   1. *A finished 1920×1080 @ 30 fps MP4 with audio.* From `ffprobe`: the video stream's
 *      dimensions, its frame rate and its codec, the presence of an AAC audio stream, and the
 *      duration within 100 ms of `timings.json`'s own `totalMs`.
 *   2. *Every scene duration derives from `timings.json` (P1-2).* Two mechanical proofs, because
 *      one of them alone can be satisfied by accident:
 *      - the container's frame count equals `timings.durationInFrames` exactly, which no
 *        hand-written duration in the composition could produce; and
 *      - the picture changes **on** each segment boundary frame and is steady either side of it.
 *        The scaffolded `Scenes.tsx` is deliberately empty, so `Video.tsx` draws its `MissingScene`
 *        marker — the segment's own id, in the middle of the frame — for every segment. Sampling a
 *        crop of that band at `from - 2`, `from - 1`, `from` and `from + 1` therefore reads the
 *        marker directly, and the change across the boundary is compared against the frame-to-frame
 *        noise on either side of it rather than against a threshold chosen here.
 *
 * **The only substitution is the speech server**, through `XPLAINER_TTS_FIXTURE`: recorded WAVs
 * and word spans, measured by the shipping narration port. Remotion is real, Chrome is real (it may
 * be downloaded on the first run, which is why the budget below is generous), the argv comes from
 * `@xplainer/render-core`'s builders, and the workspace is the template's own.
 *
 * **`XPLAINER_SKIP_RENDER_TEST=1` is the only way to skip it**, for a developer without ffmpeg or
 * without the patience. CI does not set it: a render pipeline whose render is never run in CI is a
 * render pipeline that breaks silently.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { RenderBackend } from "@xplainer/mcp-server";
import type { ExplainerJobOutput, Timings } from "@xplainer/protocol";
import { remotionBinary, stillOutput, videoPaths } from "@xplainer/render-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalBackend } from "../backend.js";
import { createJobStore } from "../daemon/job-store.js";
import { createJobRunner, type JobRunner } from "../daemon/runner.js";
import { selfIdentity } from "../daemon/worker-identity.js";
import { createWorkerRegistry } from "../daemon/workers.js";
import { TTS_FIXTURE_ENV } from "./speech.js";
import { type NarrationFixture, writeNarrationFixture } from "./testing/narration-fixture.js";

/** The only supported skip. CI does not set it. */
const SKIPPED = process.env.XPLAINER_SKIP_RENDER_TEST === "1";

/** A short script: two spoken segments around a silent beat, so there are two real boundaries. */
const FIXTURES: readonly NarrationFixture[] = [
  {
    id: "hook",
    text: "Your build was already broken.",
    seconds: 1.2,
    frequency: 220,
    words: [
      { word: "Your", start_time: 0.05, end_time: 0.3 },
      { word: "build", start_time: 0.32, end_time: 0.6 },
      { word: "was", start_time: 0.62, end_time: 0.8 },
      { word: "already", start_time: 0.82, end_time: 1.05 },
      { word: "broken.", start_time: 1.07, end_time: 1.18 },
    ],
  },
  { id: "beat", holdSeconds: 0.5 },
  {
    id: "cause",
    text: "It still is.",
    seconds: 0.8,
    frequency: 330,
    words: [
      { word: "It", start_time: 0.05, end_time: 0.25 },
      { word: "still", start_time: 0.27, end_time: 0.5 },
      { word: "is.", start_time: 0.52, end_time: 0.76 },
    ],
  },
];

/**
 * The band of the frame the `MissingScene` marker occupies.
 *
 * `Video.tsx`'s placeholder centres the segment id in a box with 200px of bottom padding, so it
 * lands around y = 440 in a 1080-high frame, horizontally centred. The crop is deliberately well
 * above the caption track, which sits against the bottom edge and changes *within* a segment as
 * well as across one — cropping it in would make "the picture changed" mean nothing — and narrow
 * enough that the words themselves are a real share of it rather than a few per cent of a
 * full-width band.
 */
const MARKER_WIDTH = 1000;
const MARKER_HEIGHT = 220;
const MARKER_CROP = `crop=${MARKER_WIDTH}:${MARKER_HEIGHT}:460:340`;

/** Grey pixels one marker band contains. */
const MARKER_SIZE = MARKER_WIDTH * MARKER_HEIGHT;

/**
 * How far apart two grey levels must be before the pixel counts as changed.
 *
 * The MP4 is lossy, so two frames drawing the *same* picture decode to slightly different pixels.
 * That difference is a handful of levels; the marker is near-white text on a near-black ground, so
 * a pixel the text moved off or onto changes by well over a hundred. Anything between the two is a
 * gap this threshold sits in the middle of.
 */
const CHANGED_LEVEL = 32;

const directories: string[] = [];
let root = "";
let runner: JobRunner;
let backend: RenderBackend;
let timings: Timings;
let ffmpeg = "";
let ffprobe = "";

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/** The first of `candidates` that exists, or the bare name for whatever is on `PATH`. */
function resolveTool(name: string, override: string | undefined): string {
  if (override !== undefined && override.trim() !== "") {
    return override.trim();
  }
  const homebrew = `/opt/homebrew/bin/${name}`;
  return existsSync(homebrew) ? homebrew : name;
}

/** Poll the runner the way an agent polls `explainer_job`, until the job is terminal. */
async function waitForJob(jobId: number, timeoutMs: number): Promise<ExplainerJobOutput> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = runner.get({ job_id: jobId, output_lines: 60 });
    if (state.status !== "queued" && state.status !== "running") {
      return state;
    }
    if (Date.now() > deadline) {
      throw new Error(`job ${jobId} never finished: ${JSON.stringify(state)}`);
    }
    await new Promise<void>((done) => {
      setTimeout(done, 250);
    });
  }
}

/** One `ffprobe -show_entries` field, as the string ffprobe prints. */
function probe(args: readonly string[]): string {
  return execFileSync(ffprobe, ["-v", "error", ...args], { encoding: "utf8" }).trim();
}

/**
 * One stream field, asked for one at a time.
 *
 * `ffprobe` prints `-show_entries stream=a,b` in the *stream's* field order rather than in the
 * order asked for, so a multi-field query compares a list against an order nothing guarantees.
 */
function probeStream(mp4: string, stream: string, entry: string): string {
  return probe([
    "-select_streams",
    stream,
    "-show_entries",
    `stream=${entry}`,
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    mp4,
  ]);
}

/**
 * One frame's marker band, as raw grey pixels.
 *
 * Piped as raw video rather than through a file so the bytes measured are the bytes ffmpeg
 * produced, and `-fps_mode passthrough` so the one selected frame is not duplicated to fill a rate.
 */
function markerBand(mp4: string, frame: number): Buffer {
  const raw = execFileSync(
    ffmpeg,
    [
      "-v",
      "error",
      "-i",
      mp4,
      "-vf",
      `select=eq(n\\,${frame}),${MARKER_CROP},format=gray`,
      "-fps_mode",
      "passthrough",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-",
    ],
    { maxBuffer: 8 * MARKER_SIZE },
  );
  expect(raw.length, `frame ${frame} produced no image`).toBe(MARKER_SIZE);
  return raw;
}

/** The share of the marker band whose grey level moved by more than {@link CHANGED_LEVEL}. */
function changedShare(a: Buffer, b: Buffer): number {
  let changed = 0;
  for (let index = 0; index < MARKER_SIZE; index += 1) {
    if (Math.abs((a[index] ?? 0) - (b[index] ?? 0)) > CHANGED_LEVEL) {
      changed += 1;
    }
  }
  return changed / MARKER_SIZE;
}

describe.skipIf(SKIPPED)("a real render", () => {
  beforeAll(async () => {
    ffmpeg = resolveTool("ffmpeg", process.env.XPLAINER_FFMPEG);
    ffprobe = resolveTool("ffprobe", process.env.XPLAINER_FFPROBE);

    root = temporaryDirectory("xplainer-render-workspace-");
    const fixtureDir = temporaryDirectory("xplainer-render-fixture-");

    // A real workspace needs a real `node_modules`, and installing Remotion into a temporary
    // directory on every test run is not a thing a test may do. This repository already has the
    // pinned Remotion tree installed — `apps/cli` declares it as a devDependency precisely so this
    // test can run — so the workspace gets a `node_modules` that points at it. What is exercised
    // is exactly the shape of an installed workspace: `remotionBinary()` finds
    // `<root>/node_modules/.bin/remotion` on its first try, as it would after `npm install`.
    const installed = remotionBinary(fileURLToPath(new URL(".", import.meta.url)));
    expect(installed, "this repository has no Remotion install to borrow").not.toBeNull();
    symlinkSync(dirname(dirname(installed ?? "")), join(root, "node_modules"), "dir");

    const narration = writeNarrationFixture(fixtureDir, FIXTURES);
    process.env[TTS_FIXTURE_ENV] = fixtureDir;

    const store = createJobStore(temporaryDirectory("xplainer-render-state-"));
    runner = createJobRunner({
      store,
      owner: { ...selfIdentity(), run_id: "render-test" },
      workers: createWorkerRegistry({ root }),
    });
    backend = createLocalBackend({ runner, root });

    await backend.explainer_create({ slug: "demo" });
    const narrated = await waitForJob(
      (await backend.explainer_narrate({ slug: "demo", narration })).job_id,
      120_000,
    );
    expect(narrated.status, narrated.output.lines.join("\n")).toBe("done");

    timings = JSON.parse(readFileSync(videoPaths(root, "demo").timings, "utf8")) as Timings;
  }, 300_000);

  afterAll(async () => {
    await runner?.drain(0);
    delete process.env[TTS_FIXTURE_ENV];
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("renders one frame to a PNG, at the scale explainer_still was given", async () => {
    const queued = await backend.explainer_still({ slug: "demo", frame: 30, scale: 0.5 });
    const finished = await waitForJob(queued.job_id, 600_000);

    expect(finished.status, finished.output.lines.join("\n")).toBe("done");
    const png = stillOutput(videoPaths(root, "demo"), 30);
    expect(existsSync(png)).toBe(true);
    expect(probeStream(png, "v:0", "width")).toBe("960");
    expect(probeStream(png, "v:0", "height")).toBe("540");
  }, 900_000);

  it("renders a 1920x1080, 30 fps, h264 MP4 with AAC audio as long as timings.json says", async () => {
    const queued = await backend.explainer_render({ slug: "demo" });
    const finished = await waitForJob(queued.job_id, 900_000);

    expect(finished.status, finished.output.lines.join("\n")).toBe("done");
    expect(finished.exit_code).toBe(0);

    const mp4 = videoPaths(root, "demo").mp4;
    expect(existsSync(mp4)).toBe(true);

    expect(probeStream(mp4, "v:0", "width")).toBe("1920");
    expect(probeStream(mp4, "v:0", "height")).toBe("1080");
    expect(probeStream(mp4, "v:0", "r_frame_rate")).toBe("30/1");
    expect(probeStream(mp4, "v:0", "codec_name")).toBe("h264");
    // Audio is the half that fails invisibly: a silent MP4 plays, and nothing downstream notices.
    expect(probeStream(mp4, "a:0", "codec_name")).toBe("aac");

    const seconds = Number(probeStream(mp4, "v:0", "duration"));
    expect(Math.abs(seconds * 1000 - timings.totalMs)).toBeLessThan(100);

    // The composition's length is timings.json's, exactly. `Root.tsx` carries a
    // `durationInFrames={300}` placeholder for Studio, so a frame count of 300 — or of anything
    // else — is what a composition that had stopped reading the measured narration would produce.
    expect(Number(probeStream(mp4, "v:0", "nb_frames"))).toBe(timings.durationInFrames);
    expect(timings.durationInFrames).not.toBe(300);
  }, 900_000);

  it("changes scene exactly on the boundary frames timings.json names (P1-2)", () => {
    const mp4 = videoPaths(root, "demo").mp4;
    const boundaries = timings.segments.slice(1).map((segment) => segment.from);
    expect(boundaries).toHaveLength(2);

    for (const [index, from] of boundaries.entries()) {
      const bands = [from - 2, from - 1, from, from + 1].map((frame) => markerBand(mp4, frame));
      const [twoBefore, before, on, after] = bands as [Buffer, Buffer, Buffer, Buffer];

      const across = changedShare(before, on);
      const withinBefore = changedShare(twoBefore, before);
      const withinAfter = changedShare(on, after);
      const noise = Math.max(withinBefore, withinAfter);
      const percent = (share: number): string => `${(share * 100).toFixed(3)}%`;
      const label =
        `boundary ${index} at frame ${from}: across=${percent(across)}, ` +
        `within=${percent(withinBefore)}/${percent(withinAfter)} of the marker band`;

      // The marker changes on the boundary frame — and is steady on either side of it, which is
      // what makes "on this frame" a claim rather than a coincidence of two frames that happened
      // to differ. The second assertion is the one with no number chosen here: the change has to
      // be an order of magnitude larger than the codec noise this very clip produces.
      expect(across, `${label}: the scene did not change on the boundary`).toBeGreaterThan(0.002);
      expect(
        across,
        `${label}: the change is not distinguishable from codec noise`,
      ).toBeGreaterThan(noise * 10);
    }
  }, 300_000);
});
