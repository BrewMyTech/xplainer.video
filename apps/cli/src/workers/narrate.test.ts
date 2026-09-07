/**
 * `explainer_narrate` end to end: a tool call, a real spawned worker, three files on disk.
 *
 * Everything between the call and the files is the shipping path — the backend writes the spec and
 * the request document, the runner spawns a child in its own process group, the child reads both
 * back and drives `@xplainer/render-core`'s narration port. The only substitution is the *server*:
 * `XPLAINER_TTS_FIXTURE` points at recorded WAVs and word spans, so the timings are measured from
 * real PCM frames rather than invented. There is no `vi.mock` here and there is nothing to mock:
 * a double in place of the port would leave `timings.json` — the one document every scene duration
 * comes from — unasserted.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { RenderBackend } from "@xplainer/mcp-server";
import type { ExplainerJobOutput, Timings } from "@xplainer/protocol";
import { decodeWav, GAP_MS, LEAD_IN_MS, pcmDurationMs, TAIL_MS } from "@xplainer/render-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalBackend } from "../backend.js";
import { createJobStore } from "../daemon/job-store.js";
import { createJobRunner, type JobRunner } from "../daemon/runner.js";
import { selfIdentity } from "../daemon/worker-identity.js";
import { createWorkerRegistry } from "../daemon/workers.js";
import { TTS_FIXTURE_ENV } from "./speech.js";
import { type NarrationFixture, writeNarrationFixture } from "./testing/narration-fixture.js";

/** The three-segment script: a spoken hook, a silent beat that holds, and a spoken close. */
const FIXTURES: readonly NarrationFixture[] = [
  {
    id: "hook",
    text: "What if your build was already broken?",
    seconds: 2.35,
    frequency: 220,
    words: [
      { word: "What", start_time: 0.05, end_time: 0.28 },
      { word: "if", start_time: 0.3, end_time: 0.42 },
      { word: "your", start_time: 0.44, end_time: 0.63 },
      { word: "build", start_time: 0.65, end_time: 0.95 },
      { word: "was", start_time: 1.05, end_time: 1.2 },
      { word: "already", start_time: 1.22, end_time: 1.62 },
      { word: "broken", start_time: 1.64, end_time: 2.0 },
      { word: "?", start_time: 2.0, end_time: 2.1 },
    ],
  },
  { id: "beat", holdSeconds: 1 },
  {
    id: "cause",
    text: "It was.",
    holdSeconds: 2,
    seconds: 0.75,
    frequency: 330,
    words: [
      { word: "It", start_time: 0.06, end_time: 0.3 },
      { word: "was", start_time: 0.32, end_time: 0.6 },
      { word: ".", start_time: 0.6, end_time: 0.68 },
    ],
  },
];

const directories: string[] = [];
let root = "";
let fixtureDir = "";
let runner: JobRunner;
let backend: RenderBackend;

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/** Poll the runner the way an agent polls `explainer_job`, until the job is terminal. */
async function waitForJob(jobId: number, timeoutMs = 60_000): Promise<ExplainerJobOutput> {
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
      setTimeout(done, 50);
    });
  }
}

beforeEach(() => {
  root = temporaryDirectory("xplainer-narrate-workspace-");
  fixtureDir = temporaryDirectory("xplainer-narrate-fixture-");
  const store = createJobStore(temporaryDirectory("xplainer-narrate-state-"));
  runner = createJobRunner({
    store,
    owner: { ...selfIdentity(), run_id: "narrate-test" },
    workers: createWorkerRegistry({ root }),
  });
  backend = createLocalBackend({ runner, root });
});

afterEach(async () => {
  await runner.drain(0);
  delete process.env[TTS_FIXTURE_ENV];
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("the narrate worker", () => {
  it("measures recorded speech into narration.wav, timings.json and captions.json", async () => {
    const narration = writeNarrationFixture(fixtureDir, FIXTURES);
    // The daemon passes its own environment to every worker, so this is how a fixture-backed
    // daemon is configured — not a seam this test invented.
    process.env[TTS_FIXTURE_ENV] = fixtureDir;
    await backend.explainer_create({ slug: "demo" });

    const queued = await backend.explainer_narrate({ slug: "demo", narration });
    const finished = await waitForJob(queued.job_id);

    expect(finished.status).toBe("done");
    expect(finished.exit_code).toBe(0);
    expect(finished.output.lines.join("\n")).toContain(`recorded speech from ${fixtureDir}`);

    const publicDir = join(root, "public", "demo");
    const timings = JSON.parse(readFileSync(join(publicDir, "timings.json"), "utf8")) as Timings;
    const captions = JSON.parse(readFileSync(join(publicDir, "captions.json"), "utf8")) as {
      text: string;
    }[];
    const track = decodeWav(readFileSync(join(publicDir, "narration.wav")));

    expect(timings.fps).toBe(30);
    expect(timings.audio).toBe("narration.wav");
    expect(timings.segments.map((segment) => segment.id)).toEqual(["hook", "beat", "cause"]);
    // Every offset is measured, not chosen: the track really is as long as timings.json says.
    expect(pcmDurationMs(track.format, track.data.length)).toBeCloseTo(timings.totalMs, 0);
    expect(timings.durationInFrames).toBe(Math.round((timings.totalMs / 1000) * timings.fps));
    // The silent beat holds for its full second, and the segments are laid end to end.
    expect(timings.segments[0]?.startMs).toBe(LEAD_IN_MS);
    expect(timings.segments[1]?.endMs).toBe((timings.segments[1]?.startMs ?? 0) + 1000 + GAP_MS);
    expect(timings.totalMs - (timings.segments[2]?.endMs ?? 0)).toBe(TAIL_MS);
    expect(captions.map((caption) => caption.text.trim())).toEqual([
      "What",
      "if",
      "your",
      "build",
      "was",
      "already",
      "broken?",
      "It",
      "was.",
    ]);
  }, 90_000);

  it("labels a dry run and contacts no speech server at all", async () => {
    const narration = writeNarrationFixture(fixtureDir, FIXTURES);
    // Deliberately not set: a dry run must not need one.
    await backend.explainer_create({ slug: "demo" });

    const queued = await backend.explainer_narrate({ slug: "demo", narration, dry_run: true });
    const finished = await waitForJob(queued.job_id);

    expect(finished.status).toBe("done");
    const lines = finished.output.lines.join("\n");
    expect(lines).toContain("no speech server was contacted");
    expect(lines).toContain("mode dry_run");
  }, 90_000);

  it("fails the job, not the tool call, when the fixture has no clip for a segment", async () => {
    writeNarrationFixture(fixtureDir, FIXTURES);
    process.env[TTS_FIXTURE_ENV] = fixtureDir;
    await backend.explainer_create({ slug: "demo" });

    const queued = await backend.explainer_narrate({
      slug: "demo",
      narration: { segments: [{ id: "hook", text: "a line nobody recorded" }] },
    });
    const finished = await waitForJob(queued.job_id);

    expect(finished.status).toBe("error");
    expect(finished.error_code).toBe("tts_failed");
    expect(finished.output.lines.join("\n")).toContain("no recorded speech");
  }, 90_000);
});
