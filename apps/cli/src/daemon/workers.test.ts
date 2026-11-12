/**
 * What each job kind becomes, and what it refuses to become.
 *
 * A factory runs in the daemon, in process, at the moment a job leaves the queue, so this is where
 * the last gate before Chrome starts lives (ADR 0018, layer 4). The tests below are about that
 * gate as much as about the argv: an engine file that drifted is restored *here*, a video with no
 * captions is refused *here*, and a machine `xplainer setup` never prepared is refused with the one
 * command that fixes it rather than with an `ENOENT` from `spawn`.
 *
 * **What every worker case asserts is D1.** The command is the *interpreter* — `process.execPath`
 * — and the first argument is this package's own worker entry, never a `#!/usr/bin/env node`
 * shim, which measured exit `127` under `PATH=/usr/bin:/bin`. `env` carries the state directory
 * and nothing else: `runner.ts` merges it into the child's environment, where a `PATH` entry would
 * reach Chrome and ffmpeg as well as the worker.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { readScaffoldTemplate, scaffoldVideo, videoPaths } from "@xplainer/render-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJobRequest, writeJobRequest } from "../job-request.js";
import { recordTestToolchain } from "../setup/testing/toolchain.js";
import type { JobRecord } from "./job-store.js";
import { makeJobRecord } from "./testing/records.js";
import { videoLockPath } from "./video-lock.js";
import { selfIdentity } from "./worker-identity.js";
import { createWorkerRegistry } from "./workers.js";

const roots: string[] = [];
let root = "";
let stateDir = "";

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "xplainer-workers-"));
  roots.push(directory);
  return directory;
}

/** A record shaped exactly as the store writes one, with only the fields a factory reads set. */
function record(jobId: number, jobType: JobRecord["job_type"], slug: string | null): JobRecord {
  return makeJobRecord({ job_id: jobId, job_type: jobType, video_id: slug });
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

/**
 * A machine where `xplainer setup` has run: the marker and its two acquisitions, which the factory
 * reads before it builds a spec. There is no `node_modules`: the render worker reads nothing from
 * the workspace's own install.
 */
function pretendSetUp(): void {
  recordTestToolchain({ stateDir });
}

beforeEach(() => {
  root = temporaryRoot();
  stateDir = temporaryRoot();
});

afterEach(() => {
  for (const directory of roots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("the render worker", () => {
  it("is this build's own entry, told only where the workspace and the job are", () => {
    narratedVideo("demo");
    pretendSetUp();
    writeJobRequest(root, 1, { job_type: "explainer_render", slug: "demo" });

    const spec = createWorkerRegistry({ root, stateDir }).explainer_render?.(
      record(1, "explainer_render", "demo"),
    );

    expect(spec?.command).toBe(process.execPath);
    expect(spec?.args.slice(-2)).toEqual([root, "1"]);
    expect(spec?.args.at(-3)).toMatch(/[\\/]workers[\\/]render\.(ts|js)$/);
    expect(spec?.cwd).toBe(root);
    // The fifth field is the video's write lock, asserted for what it does further down.
    expect(typeof spec?.release).toBe("function");
  });

  /**
   * The worker reads `chrome.path` out of `toolchain.json`, so it has to be told which state
   * directory this daemon is using — and told nothing else: `runner.ts` merges `env` into the
   * child's environment, where a `PATH` entry would reach Chrome and ffmpeg as well.
   */
  it("tells the worker this daemon's state directory, and puts nothing on its PATH", () => {
    narratedVideo("demo");
    pretendSetUp();
    writeJobRequest(root, 1, { job_type: "explainer_render", slug: "demo" });

    const spec = createWorkerRegistry({ root, stateDir }).explainer_render?.(
      record(1, "explainer_render", "demo"),
    );

    expect(spec?.env).toEqual({ XPLAINER_STATE_DIR: stateDir });
  });

  it("needs no node_modules in the workspace: the renderer bundles against its own install", () => {
    narratedVideo("demo");
    pretendSetUp();
    writeJobRequest(root, 1, { job_type: "explainer_render", slug: "demo" });

    expect(existsSync(join(root, "node_modules"))).toBe(false);
    expect(() =>
      createWorkerRegistry({ root, stateDir }).explainer_render?.(
        record(1, "explainer_render", "demo"),
      ),
    ).not.toThrow();
  });

  it("restores an engine-owned file that drifted, before the render is built", () => {
    narratedVideo("demo");
    pretendSetUp();
    writeJobRequest(root, 1, { job_type: "explainer_render", slug: "demo" });
    const shell = join(videoPaths(root, "demo").source, "Video.tsx");
    writeFileSync(shell, "// hand-edited through write_source_to");

    createWorkerRegistry({ root, stateDir }).explainer_render?.(
      record(1, "explainer_render", "demo"),
    );

    expect(readFileSync(shell)).toEqual(readScaffoldTemplate("Video.tsx"));
  });

  it("refuses a video whose captions are missing, before Chrome is started", () => {
    narratedVideo("demo");
    pretendSetUp();
    writeJobRequest(root, 1, { job_type: "explainer_render", slug: "demo" });
    rmSync(videoPaths(root, "demo").captions);

    expect(() =>
      createWorkerRegistry({ root, stateDir }).explainer_render?.(
        record(1, "explainer_render", "demo"),
      ),
    ).toThrow(/captions/);
  });

  /**
   * The gate `toolchain.json` exists for, asked at the one moment it can still be reported.
   *
   * Nothing else on this machine says whether the browser a render draws every frame with is here:
   * the daemon never downloads, so a machine where `setup` has not run renders nothing and the only
   * question is whether it says so now or three minutes into a job.
   */
  it("refuses a machine where setup has never run", () => {
    narratedVideo("demo");
    pretendSetUp();
    rmSync(join(stateDir, "toolchain.json"));
    writeJobRequest(root, 1, { job_type: "explainer_render", slug: "demo" });

    expect(() =>
      createWorkerRegistry({ root, stateDir }).explainer_render?.(
        record(1, "explainer_render", "demo"),
      ),
    ).toThrow(/xplainer setup/);
  });

  /** A recorded artefact that has been cleaned away is a different repair from a missing marker. */
  it("refuses when a path the marker recorded is no longer on this machine", () => {
    narratedVideo("demo");
    const marker = recordTestToolchain({ stateDir });
    pretendSetUp();
    rmSync(marker.chrome.path);
    writeJobRequest(root, 1, { job_type: "explainer_render", slug: "demo" });

    expect(() =>
      createWorkerRegistry({ root, stateDir }).explainer_render?.(
        record(1, "explainer_render", "demo"),
      ),
    ).toThrow(/no longer on this machine/);
  });
});

/**
 * AC-A6 (ii), ADR 0031 §Note, 2026-11-12, D12: what a job needs of the toolchain is decided by its
 * kind. A render pipes every frame into ffmpeg, so a job that reaches the factory on a machine that
 * names none fails *here*, before a worker or a browser is started and before the video's lock is
 * taken — and a still, which encodes nothing, is built on that same machine.
 */
describe("ffmpeg, by job kind", () => {
  /** Run `body` with `XPLAINER_FFMPEG` set to `value` — or unset — and put it back afterwards. */
  function withFfmpegOverride(value: string | undefined, body: () => void): void {
    const before = process.env.XPLAINER_FFMPEG;
    if (value === undefined) {
      delete process.env.XPLAINER_FFMPEG;
    } else {
      process.env.XPLAINER_FFMPEG = value;
    }
    try {
      body();
    } finally {
      if (before === undefined) {
        delete process.env.XPLAINER_FFMPEG;
      } else {
        process.env.XPLAINER_FFMPEG = before;
      }
    }
  }

  it("refuses a render and builds a still where neither the marker nor XPLAINER_FFMPEG names one", () => {
    narratedVideo("demo");
    recordTestToolchain({ stateDir, ffmpeg: false });
    writeJobRequest(root, 1, { job_type: "explainer_render", slug: "demo" });
    writeJobRequest(root, 2, { job_type: "explainer_still", slug: "demo", frame: 0, scale: 1 });
    const registry = createWorkerRegistry({ root, stateDir });

    withFfmpegOverride(undefined, () => {
      expect(() => registry.explainer_render?.(record(1, "explainer_render", "demo"))).toThrow(
        /records no ffmpeg/,
      );
      expect(existsSync(videoLockPath(root, "demo"))).toBe(false);

      const still = registry.explainer_still?.(record(2, "explainer_still", "demo"));
      expect(still?.command).toBe(process.execPath);
      expect(still?.args.at(-3)).toMatch(/[\\/]workers[\\/]render\.(ts|js)$/);
      still?.release?.();
    });
  });

  it("builds a render on an executable XPLAINER_FFMPEG alone, and refuses one naming nothing", () => {
    narratedVideo("demo");
    recordTestToolchain({ stateDir, ffmpeg: false });
    writeJobRequest(root, 1, { job_type: "explainer_render", slug: "demo" });
    const registry = createWorkerRegistry({ root, stateDir });

    withFfmpegOverride(join(stateDir, "no-such-ffmpeg"), () => {
      expect(() => registry.explainer_render?.(record(1, "explainer_render", "demo"))).toThrow(
        /XPLAINER_FFMPEG names .*no-such-ffmpeg, which is not an executable file/,
      );
    });
    const named = join(stateDir, "named-ffmpeg");
    writeFileSync(named, "#!/bin/sh\nexit 0\n");
    chmodSync(named, 0o755);
    withFfmpegOverride(named, () => {
      const spec = registry.explainer_render?.(record(1, "explainer_render", "demo"));
      // The override reaches the worker by inheritance from this process, never through `env`.
      expect(spec?.env).toEqual({ XPLAINER_STATE_DIR: stateDir });
      spec?.release?.();
    });
  });

  it("refuses a render whose recorded ffmpeg has been replaced, as stale", () => {
    narratedVideo("demo");
    const marker = recordTestToolchain({ stateDir });
    writeFileSync(marker.ffmpeg?.path ?? "", "a different binary, put here after setup\n");
    writeJobRequest(root, 1, { job_type: "explainer_render", slug: "demo" });

    withFfmpegOverride(undefined, () => {
      expect(() =>
        createWorkerRegistry({ root, stateDir }).explainer_render?.(
          record(1, "explainer_render", "demo"),
        ),
      ).toThrow(/replaced since setup checked it/);
    });
  });
});

describe("the still worker", () => {
  it("is the same render worker, which reads the frame and the scale off the request", () => {
    narratedVideo("demo");
    pretendSetUp();
    writeJobRequest(root, 1, { job_type: "explainer_still", slug: "demo", frame: 12, scale: 1 });

    const spec = createWorkerRegistry({ root, stateDir }).explainer_still?.(
      record(1, "explainer_still", "demo"),
    );

    expect(spec?.command).toBe(process.execPath);
    expect(spec?.args.slice(-2)).toEqual([root, "1"]);
    expect(spec?.args.at(-3)).toMatch(/[\\/]workers[\\/]render\.(ts|js)$/);
    expect(spec?.cwd).toBe(root);
    expect(spec?.env).toEqual({ XPLAINER_STATE_DIR: stateDir });
    expect(typeof spec?.release).toBe("function");
    // What the worker will act on is the document, not anything in its argv.
    expect(readJobRequest(root, 1, "explainer_still")).toMatchObject({ frame: 12, scale: 1 });
  });
});

describe("the narrate worker", () => {
  it("is this build's own entry, told only where the workspace and the job are", () => {
    writeJobRequest(root, 4, { job_type: "explainer_narrate", slug: "demo", dry_run: false });

    const spec = createWorkerRegistry({ root, stateDir }).explainer_narrate?.(
      record(4, "explainer_narrate", "demo"),
    );

    expect(spec?.command).toBe(process.execPath);
    expect(spec?.args.slice(-2)).toEqual([root, "4"]);
    expect(spec?.args.at(-3)).toMatch(/narrate\.(ts|js)$/);
    expect(spec?.cwd).toBe(root);
  });

  /**
   * `--import` takes a **module specifier**, and an absolute Windows path is one with the scheme
   * `c:`: Node rejects `--import C:\\repo\\hook.ts` with ERR_UNSUPPORTED_ESM_URL_SCHEME before it
   * runs a line. Every other spawned child in this repository passes the hook as a `file://` URL;
   * this call site was the last one still passing the bare path, and it is the one a `serve`
   * running from its own sources reaches on the first narration job.
   *
   * The hook branch is the one this test reaches, and unconditionally: `narrateWorkerCommand()`
   * picks the compiled entry by asking for `../workers/narrate.js` relative to **its own module**,
   * which under Vitest is `src/daemon/workers.ts` and so resolves to `src/workers/narrate.js` — a
   * file this package does not have and a build never puts there. `dist/workers/narrate.js` is
   * reached only when the module itself is `dist/daemon/workers.js`, which no test run loads.
   */
  it("spells the ts hook as a file URL, so a Windows daemon can spawn narration at all", () => {
    expect(existsSync(new URL("../workers/narrate.js", import.meta.url))).toBe(false);
    writeJobRequest(root, 4, { job_type: "explainer_narrate", slug: "demo", dry_run: true });

    const args =
      createWorkerRegistry({ root, stateDir }).explainer_narrate?.(
        record(4, "explainer_narrate", "demo"),
      )?.args ?? [];

    expect(args[0]).toBe("--import");
    expect(args[1]).toMatch(/^file:\/\/\/.*ts-source-hook\.ts$/);
    expect(new URL(String(args[1])).protocol).toBe("file:");
  });

  /**
   * The worker resolves its speech route out of `<state>/toolchain.json` (`workers/speech.ts`), and
   * the state directory is a *setting* rather than a fact about the machine: `serve --state-dir`
   * moves it, and all three settings travel in argv on every platform because Task Scheduler's
   * `<Exec>` action has no environment map. So the daemon has to tell the worker where its own state
   * is — a worker left to resolve it would read the platform-default marker on exactly the
   * supervised machines the flag exists for, and narrate against a container while a daemon two
   * directories away had acquired an engine.
   */
  it("tells the narration worker which state directory this daemon is using", () => {
    writeJobRequest(root, 4, { job_type: "explainer_narrate", slug: "demo", dry_run: false });

    const spec = createWorkerRegistry({ root, stateDir }).explainer_narrate?.(
      record(4, "explainer_narrate", "demo"),
    );

    expect(spec?.env).toEqual({ XPLAINER_STATE_DIR: stateDir });
  });

  it("needs no installed workspace: narration is this package's own code", () => {
    writeJobRequest(root, 4, { job_type: "explainer_narrate", slug: "demo", dry_run: true });

    expect(() =>
      createWorkerRegistry({ root, stateDir }).explainer_narrate?.(
        record(4, "explainer_narrate", "demo"),
      ),
    ).not.toThrow();
  });
});

/**
 * The hazard ADR 0024 §Scope names — "Two writers to one video directory is a corrupted output that
 * neither process reports" — reaches the workspace because `xplainer mcp` was handed this same
 * registry over the same root while deliberately not holding the state directory's lock
 * (ADR 0024 §Note, 2026-09-07). The exclusion is therefore keyed by the video.
 *
 * A "second process" here is a lock file naming a **live** pid with its real start token, which is
 * scenario `[E]` of `spikes/p1-s1-ownership.mjs`: the one input the classifier calls held. Writing
 * it is how a single test process can stand in for the two that meet in production.
 */
describe("the video write lock", () => {
  /** Put a lock on `slug` that names a process the classifier will call alive. */
  function heldByALiveProcess(slug: string): string {
    const path = videoLockPath(root, slug);
    mkdirSync(join(root, "locks"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        format_version: 1,
        ...selfIdentity(),
        boot_nonce: "held-by-someone-else",
        hostname: "elsewhere",
        acquired_at: "2026-09-07T00:00:00.000Z",
        slug,
        job_type: "explainer_render",
        job_id: 99,
      }),
    );
    return path;
  }

  it("is taken by the factory and given back by release()", () => {
    narratedVideo("demo");
    pretendSetUp();
    writeJobRequest(root, 1, { job_type: "explainer_render", slug: "demo" });

    const spec = createWorkerRegistry({ root, stateDir }).explainer_render?.(
      record(1, "explainer_render", "demo"),
    );

    expect(existsSync(videoLockPath(root, "demo"))).toBe(true);
    spec?.release?.();
    expect(existsSync(videoLockPath(root, "demo"))).toBe(false);
  });

  it("refuses a render of a video another live process is already writing", () => {
    narratedVideo("demo");
    pretendSetUp();
    heldByALiveProcess("demo");
    writeJobRequest(root, 1, { job_type: "explainer_render", slug: "demo" });

    expect(() =>
      createWorkerRegistry({ root, stateDir }).explainer_render?.(
        record(1, "explainer_render", "demo"),
      ),
    ).toThrow(/is being written by another process/);
  });

  it("refuses a narrate of that same video, because both write under one slug", () => {
    heldByALiveProcess("demo");
    writeJobRequest(root, 4, { job_type: "explainer_narrate", slug: "demo", dry_run: true });

    expect(() =>
      createWorkerRegistry({ root, stateDir }).explainer_narrate?.(
        record(4, "explainer_narrate", "demo"),
      ),
    ).toThrow(/is being written by another process/);
  });

  it("lets a different video through: the exclusion is per video, not per workspace", () => {
    narratedVideo("other");
    pretendSetUp();
    heldByALiveProcess("demo");
    writeJobRequest(root, 2, { job_type: "explainer_render", slug: "other" });

    expect(() =>
      createWorkerRegistry({ root, stateDir }).explainer_render?.(
        record(2, "explainer_render", "other"),
      ),
    ).not.toThrow();
  });

  /**
   * Taken **after** every refusal above, so a job that is refused for a missing caption file does
   * not leave a lock behind that would refuse the retry it just told the agent to make.
   */
  it("is not taken by a job the gates above it refuse", () => {
    narratedVideo("demo");
    pretendSetUp();
    writeJobRequest(root, 1, { job_type: "explainer_render", slug: "demo" });
    rmSync(videoPaths(root, "demo").captions);

    expect(() =>
      createWorkerRegistry({ root, stateDir }).explainer_render?.(
        record(1, "explainer_render", "demo"),
      ),
    ).toThrow(/captions/);
    expect(existsSync(videoLockPath(root, "demo"))).toBe(false);
  });
});

describe("a job whose two halves disagree", () => {
  it("is refused when there is no request document at all", () => {
    expect(() =>
      createWorkerRegistry({ root, stateDir }).explainer_render?.(
        record(9, "explainer_render", "demo"),
      ),
    ).toThrow(/no request document/);
  });

  it("is refused when the record and the request name different videos", () => {
    narratedVideo("demo");
    pretendSetUp();
    writeJobRequest(root, 1, { job_type: "explainer_render", slug: "other" });

    expect(() =>
      createWorkerRegistry({ root, stateDir }).explainer_render?.(
        record(1, "explainer_render", "demo"),
      ),
    ).toThrow(/recorded against video "demo" but its request document names "other"/);
  });

  it("is refused when the record names no video", () => {
    writeJobRequest(root, 1, { job_type: "explainer_render", slug: "demo" });

    expect(() =>
      createWorkerRegistry({ root, stateDir }).explainer_render?.(
        record(1, "explainer_render", null),
      ),
    ).toThrow(/names no video/);
  });
});
