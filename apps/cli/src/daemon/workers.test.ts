/**
 * What each job kind becomes, and what it refuses to become.
 *
 * A factory runs in the daemon, in process, at the moment a job leaves the queue, so this is where
 * the last gate before Chrome starts lives (ADR 0018, layer 4). The tests below are about that
 * gate as much as about the argv: an engine file that drifted is restored *here*, a video with no
 * captions is refused *here*, and a workspace nobody installed is refused with the one command that
 * fixes it rather than with an `ENOENT` from `spawn`.
 *
 * The argv itself is compared against `@xplainer/render-core`'s own builders rather than against a
 * string written here — those builders are what pin the Remotion CLI contract, and a copy of their
 * output in this file would be a second contract that only used to agree.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  readScaffoldTemplate,
  renderArgs,
  scaffoldVideo,
  stillArgs,
  stillOutput,
  videoPaths,
} from "@xplainer/render-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeJobRequest } from "../job-request.js";
import { JOB_RECORD_FORMAT_VERSION, type JobRecord } from "./job-store.js";
import { selfIdentity } from "./worker-identity.js";
import { createWorkerRegistry } from "./workers.js";

const roots: string[] = [];
let root = "";

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "xplainer-workers-"));
  roots.push(directory);
  return directory;
}

/** A record shaped exactly as the store writes one, with only the fields a factory reads set. */
function record(jobId: number, jobType: JobRecord["job_type"], slug: string | null): JobRecord {
  return {
    format_version: JOB_RECORD_FORMAT_VERSION,
    job_id: jobId,
    job_type: jobType,
    status: "queued",
    video_id: slug,
    output_dir: null,
    created_at: "2026-09-06T10:00:00+00:00",
    started_at: null,
    finished_at: null,
    exit_code: null,
    error: null,
    error_code: null,
    workers_uncertain: false,
    owner: { ...selfIdentity(), run_id: "workers-test" },
    workers: [],
    log: [],
  };
}

/** A created video with a narration already measured, which is what a render requires. */
function narratedVideo(slug: string): void {
  const video = videoPaths(root, slug);
  mkdirSync(video.publicDir, { recursive: true });
  mkdirSync(video.out, { recursive: true });
  scaffoldVideo(video.source);
  writeFileSync(
    video.timings,
    JSON.stringify({
      fps: 30,
      durationInFrames: 60,
      totalMs: 2000,
      audio: "narration.wav",
      segments: [],
    }),
  );
  writeFileSync(video.captions, JSON.stringify([{ text: "hi", startMs: 0, endMs: 100 }]));
  writeFileSync(video.audio, Buffer.alloc(64));
}

/** Give the workspace a Remotion CLI, and answer with the path a factory should choose. */
function pretendInstalled(): string {
  const bin = join(root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const binary = join(bin, process.platform === "win32" ? "remotion.cmd" : "remotion");
  writeFileSync(binary, "#!/bin/sh\n");
  return binary;
}

beforeEach(() => {
  root = temporaryRoot();
});

afterEach(() => {
  for (const directory of roots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("the render worker", () => {
  it("is the pinned Remotion CLI with render-core's own argv, run from the workspace root", () => {
    narratedVideo("demo");
    const binary = pretendInstalled();
    writeJobRequest(root, 1, { job_type: "explainer_render", slug: "demo" });

    const spec = createWorkerRegistry({ root }).explainer_render?.(
      record(1, "explainer_render", "demo"),
    );

    const video = videoPaths(root, "demo");
    expect(spec).toEqual({
      command: binary,
      args: renderArgs({ slug: "demo", output: video.mp4, publicDir: video.publicDir }),
      cwd: root,
    });
  });

  it("restores an engine-owned file that drifted, before the render is built", () => {
    narratedVideo("demo");
    pretendInstalled();
    writeJobRequest(root, 1, { job_type: "explainer_render", slug: "demo" });
    const shell = join(videoPaths(root, "demo").source, "Video.tsx");
    writeFileSync(shell, "// hand-edited through write_source_to");

    createWorkerRegistry({ root }).explainer_render?.(record(1, "explainer_render", "demo"));

    expect(readFileSync(shell)).toEqual(readScaffoldTemplate("Video.tsx"));
  });

  it("refuses a video whose captions are missing, before Chrome is started", () => {
    narratedVideo("demo");
    pretendInstalled();
    writeJobRequest(root, 1, { job_type: "explainer_render", slug: "demo" });
    rmSync(videoPaths(root, "demo").captions);

    expect(() =>
      createWorkerRegistry({ root }).explainer_render?.(record(1, "explainer_render", "demo")),
    ).toThrow(/captions/);
  });

  it("refuses a workspace nobody installed, naming the command that fixes it", () => {
    narratedVideo("demo");
    writeJobRequest(root, 1, { job_type: "explainer_render", slug: "demo" });

    expect(() =>
      createWorkerRegistry({ root }).explainer_render?.(record(1, "explainer_render", "demo")),
    ).toThrow(/npm install/);
  });
});

describe("the still worker", () => {
  it("carries the frame and the scale the request recorded", () => {
    narratedVideo("demo");
    const binary = pretendInstalled();
    writeJobRequest(root, 1, { job_type: "explainer_still", slug: "demo", frame: 12, scale: 1 });

    const spec = createWorkerRegistry({ root }).explainer_still?.(
      record(1, "explainer_still", "demo"),
    );

    const video = videoPaths(root, "demo");
    expect(spec).toEqual({
      command: binary,
      args: stillArgs({
        slug: "demo",
        output: stillOutput(video, 12),
        publicDir: video.publicDir,
        frame: 12,
        scale: 1,
      }),
      cwd: root,
    });
  });
});

describe("the narrate worker", () => {
  it("is this build's own entry, told only where the workspace and the job are", () => {
    writeJobRequest(root, 4, { job_type: "explainer_narrate", slug: "demo", dry_run: false });

    const spec = createWorkerRegistry({ root }).explainer_narrate?.(
      record(4, "explainer_narrate", "demo"),
    );

    expect(spec?.command).toBe(process.execPath);
    expect(spec?.args.slice(-2)).toEqual([root, "4"]);
    expect(spec?.args.at(-3)).toMatch(/narrate\.(ts|js)$/);
    expect(spec?.cwd).toBe(root);
  });

  it("needs no installed workspace: narration is this package's own code, not Remotion", () => {
    writeJobRequest(root, 4, { job_type: "explainer_narrate", slug: "demo", dry_run: true });

    expect(() =>
      createWorkerRegistry({ root }).explainer_narrate?.(record(4, "explainer_narrate", "demo")),
    ).not.toThrow();
  });
});

describe("a job whose two halves disagree", () => {
  it("is refused when there is no request document at all", () => {
    expect(() =>
      createWorkerRegistry({ root }).explainer_render?.(record(9, "explainer_render", "demo")),
    ).toThrow(/no request document/);
  });

  it("is refused when the record and the request name different videos", () => {
    narratedVideo("demo");
    pretendInstalled();
    writeJobRequest(root, 1, { job_type: "explainer_render", slug: "other" });

    expect(() =>
      createWorkerRegistry({ root }).explainer_render?.(record(1, "explainer_render", "demo")),
    ).toThrow(/recorded against video "demo" but its request document names "other"/);
  });

  it("is refused when the record names no video", () => {
    writeJobRequest(root, 1, { job_type: "explainer_render", slug: "demo" });

    expect(() =>
      createWorkerRegistry({ root }).explainer_render?.(record(1, "explainer_render", null)),
    ).toThrow(/names no video/);
  });
});
