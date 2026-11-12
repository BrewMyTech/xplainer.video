/**
 * Which job kinds this daemon can run, and the exact command each one becomes.
 *
 * `runner.ts` deliberately knows nothing about narration or rendering: it starts a process group,
 * captures a bounded log tail and writes the record down. Everything host-specific lives behind
 * {@link WorkerSpec}, and this file is the only place that builds one. Three kinds exist, and all
 * three are this package's own code in a child process:
 *
 * - **`explainer_narrate`** runs `workers/narrate`: the narration port from
 *   `@xplainer/render-core`, driven against `@xplainer/tts-client`.
 * - **`explainer_still` and `explainer_render`** run `workers/render`: the video bundled with
 *   esbuild, stepped frame by frame in the headless shell `toolchain.json` records, and — for a
 *   render — piped into a spawned ffmpeg. The worker starts Chrome and ffmpeg itself, as plain
 *   children, so both are inside the process group the runner signals.
 *
 * Each runs out of process because the daemon must stay answerable while it works, and because a
 * `SIGTERM` mid-job has to reach one killable process group.
 *
 * **All three are `<interpreter> <entry file>`, and that is decision D1.** The interpreter is
 * `process.execPath` — `<runtime>/bin/node` when the daemon came out of a payload — never a
 * `#!/usr/bin/env node` shim, which the kernel hands to `/usr/bin/env` to search the **child's**
 * `PATH` (measured exit `127` under `PATH=/usr/bin:/bin`). `PATH` is **not** injected through
 * `WorkerSpec.env`: `runner.ts` would merge it happily, and it would leak an interpreter onto the
 * `PATH` of everything the worker starts, Chrome and ffmpeg included.
 *
 * **The last gate before Chrome starts lives here** (ADR 0018, layer 4). A factory runs in the
 * daemon, in process, at the moment the job leaves the queue — so this is where `scaffoldVideo()`
 * restores an engine-owned file an agent wrote to directly through `write_source_to`, and where
 * `assertRenderable()` refuses a render whose narration or captions are missing. A factory that
 * throws costs a second; the render it stopped would have cost minutes and produced a silent MP4.
 *
 * **The toolchain is read here too, and that is where a missing browser stops being a mystery.**
 * `<state>/toolchain.json` is the record `xplainer setup` leaves and the only thing on the machine
 * that says the browser and the speech provider a render needs are present — neither this daemon
 * nor `daemon install` ever downloads (ADR 0005). So `explainer_still` and `explainer_render` read
 * it before they build a `WorkerSpec`, and a missing or stale toolchain is a **named refusal** on
 * the job record rather than an `ENOENT` in a worker whose log tail is the only evidence anybody
 * gets. `setup/toolchain.ts` owns the judgement, by the job's kind — a render also needs an ffmpeg
 * and a still does not — and this file owns the moment it is asked. The render worker then reads
 * the same marker for the browser's path and ffmpeg's, from the state directory this registry hands
 * it in `XPLAINER_STATE_DIR`.
 *
 * **And it is where the video's write lock is taken** (`video-lock.ts`), last, once every refusal
 * above has had its chance — so a job that is going to be refused never takes a lock, and a job
 * that is going to spawn always holds one. `WorkerSpec.release` carries it to the runner, which
 * gives it back when the record reaches a terminal state. The lock exists because ownership of the
 * *store* stopped implying ownership of the *workspace* the moment `xplainer mcp` was given this
 * registry: see ADR 0024 §Note, 2026-09-07.
 */

import { existsSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { JobType } from "@xplainer/protocol";
import { assertRenderable, scaffoldVideo, videoPaths } from "@xplainer/render-core";
import { readJobRequest } from "../job-request.js";
import { assertJobToolchainReady } from "../setup/toolchain.js";
import type { JobRecord } from "./job-store.js";
import type { WorkerRegistry, WorkerSpec } from "./runner.js";
import { STATE_DIR_ENV } from "./state-dir.js";
import { acquireVideoWriteLock } from "./video-lock.js";

/** What {@link createWorkerRegistry} needs. */
export type CreateWorkerRegistryOptions = {
  /** The shared workspace root every job reads and writes under. */
  root: string;
  /**
   * The daemon's state directory, where `xplainer setup` wrote `toolchain.json`.
   *
   * Passed in rather than resolved here, for the reason every other module in `daemon/` takes it as
   * an argument: `serve --state-dir` moves it, and a registry that read the environment would gate
   * renders on a marker in a directory this daemon is not using.
   */
  stateDir: string;
};

/**
 * How to start one of this package's own workers with this build's own sources.
 *
 * Two shapes, chosen by what is actually on disk beside this module. After a build it is
 * `dist/workers/<name>.js` and plain `node` runs it. Under Vitest this module is still
 * `src/daemon/workers.ts`, so the entry is `src/workers/<name>.ts` and the child needs the same
 * `--import` hook every other spawned test child uses — `turbo.json` gives `test` a `dependsOn` of
 * `^build`, the *dependencies'* builds and not this package's, so `dist/` may be absent or stale
 * while the tests run and spawning it would be a green test over code that is not the code.
 *
 * The `.ts` branch is unreachable from a published package: `tsconfig.build.json` excludes
 * `src/**\/testing/**`, so a `dist/` never contains the hook, and it never contains a `.ts` entry
 * to run under it either.
 */
function workerCommand(name: "narrate" | "render"): { command: string; args: string[] } {
  const compiled = fileURLToPath(new URL(`../workers/${name}.js`, import.meta.url));
  if (existsSync(compiled)) {
    return { command: process.execPath, args: [compiled] };
  }
  const source = fileURLToPath(new URL(`../workers/${name}.ts`, import.meta.url));
  // The entry is a path and the hook is a **URL**: `--import` takes a module specifier, and
  // `C:\\Users\\…` parses as one with the scheme `c:`, which Node rejects with
  // ERR_UNSUPPORTED_ESM_URL_SCHEME. `spawn-child.ts` states the same rule for every other spawned
  // test child; this was the last site still passing the bare path, and it is the one a Windows
  // `serve` reaches from its own source tree.
  const hookUrl = new URL("./testing/ts-source-hook.ts", import.meta.url);
  if (existsSync(source) && existsSync(fileURLToPath(hookUrl))) {
    return { command: process.execPath, args: ["--import", hookUrl.href, source] };
  }
  throw new Error(
    `the ${name} worker is missing: neither ${compiled} nor ${source} exists. This build is ` +
      "incomplete; reinstall @xplainer/cli.",
  );
}

/** The narration worker. */
function narrateWorkerCommand(): { command: string; args: string[] } {
  return workerCommand("narrate");
}

/** The still and render worker: one entry for both, which reads the job type off the request. */
function renderWorkerCommand(): { command: string; args: string[] } {
  return workerCommand("render");
}

/**
 * The slug both halves of one job agree on.
 *
 * The record carries `video_id` and the request document carries `slug`, and they are written at
 * different moments by different code. A disagreement means the two halves have drifted apart, and
 * building a worker from either half would then render *something* — for the wrong video — rather
 * than fail, which is the one outcome an agent cannot detect from a poll.
 */
function agreedSlug(record: JobRecord, requestSlug: string): string {
  const slug = record.video_id;
  if (slug === null || slug === "") {
    throw new Error(`job ${record.job_id} names no video, so there is nothing to work on.`);
  }
  if (slug !== requestSlug) {
    throw new Error(
      `job ${record.job_id} is recorded against video "${slug}" but its request document names ` +
        `"${requestSlug}". Retry the call.`,
    );
  }
  return slug;
}

/**
 * Restore the engine-owned shell and refuse an unrenderable video, in that order.
 *
 * The order matters: `preflight()` reports a drifted engine file as a *warning* because
 * `scaffoldVideo()` is what repairs it, so repairing first is what keeps that warning from being
 * reported for a file this call has already put back.
 */
function assertReadyToRender(source: string, publicDir: string): void {
  scaffoldVideo(source);
  assertRenderable(source, publicDir);
}

/**
 * Build the registry the job runner dispatches on.
 *
 * A job type absent from the returned object fails its own jobs with a named error rather than
 * failing the tool call, which is what keeps an agent holding a `job_id` able to poll it to a
 * conclusion. All three are present here; `daemon/start.ts` substitutes a test registry.
 */
export function createWorkerRegistry(options: CreateWorkerRegistryOptions): WorkerRegistry {
  const { root, stateDir } = options;

  /** Take this video's write lock, and hand the runner the way to give it back. */
  function lockVideo(slug: string, jobType: JobType, jobId: number): () => void {
    const lock = acquireVideoWriteLock({ root, slug, jobType, jobId });
    return () => {
      lock.release();
    };
  }

  return {
    explainer_narrate(record: JobRecord): WorkerSpec {
      // Read here as well as in the worker, for its refusals: a job whose request document is
      // missing or disagrees with the record must fail before a process is spawned for it.
      const request = readJobRequest(root, record.job_id, "explainer_narrate");
      const slug = agreedSlug(record, request.slug);
      const { command, args } = narrateWorkerCommand();
      // The worker re-reads the document rather than being handed its fields on the command line,
      // so the arguments it acts on are the ones that were written down.
      return {
        command,
        args: [...args, root, String(record.job_id)],
        cwd: root,
        // **The state directory travels to the worker, because the worker resolves the speech
        // route out of `toolchain.json`** (`workers/speech.ts`, plan S5). This registry already
        // takes `stateDir` as an argument for the reason above — `serve --state-dir` moves it, and
        // all three settings travel in argv on every platform because Task Scheduler's `<Exec>`
        // has no environment map — so a worker left to resolve it for itself would read the
        // *platform default* marker on exactly the supervised machines the flag exists for, and
        // narrate against a container while a daemon two directories away had acquired an engine.
        // This is not the `PATH` injection D1 refuses: that leaks an interpreter onto the `PATH` of
        // everything a worker spawns, and the narration worker spawns nothing.
        env: { [STATE_DIR_ENV]: stateDir },
        release: lockVideo(slug, "explainer_narrate", record.job_id),
      };
    },

    explainer_still(record: JobRecord): WorkerSpec {
      const request = readJobRequest(root, record.job_id, "explainer_still");
      const slug = agreedSlug(record, request.slug);
      const video = videoPaths(root, slug);
      // A still encodes nothing, so a machine with no ffmpeg draws one (ADR 0031 §Note,
      // 2026-11-12, D12).
      assertJobToolchainReady({ stateDir, job: "still" });
      assertReadyToRender(video.source, video.publicDir);
      const { command, args } = renderWorkerCommand();
      return {
        command,
        args: [...args, root, String(record.job_id)],
        cwd: root,
        // The render worker reads `chrome.path` out of `toolchain.json`, from this daemon's state
        // directory rather than the platform default, for the reason the narration worker is told.
        env: { [STATE_DIR_ENV]: stateDir },
        release: lockVideo(slug, "explainer_still", record.job_id),
      };
    },

    explainer_render(record: JobRecord): WorkerSpec {
      const request = readJobRequest(root, record.job_id, "explainer_render");
      const slug = agreedSlug(record, request.slug);
      const video = videoPaths(root, slug);
      // A render pipes every frame into ffmpeg: an executable `XPLAINER_FFMPEG` — this daemon's
      // own environment, which the worker inherits — or a valid `ffmpeg` in the marker, refused
      // here before Chrome starts rather than by the worker after it has (D12).
      assertJobToolchainReady({ stateDir, job: "render" });
      assertReadyToRender(video.source, video.publicDir);
      const { command, args } = renderWorkerCommand();
      return {
        command,
        args: [...args, root, String(record.job_id)],
        cwd: root,
        env: { [STATE_DIR_ENV]: stateDir },
        release: lockVideo(slug, "explainer_render", record.job_id),
      };
    },
  } satisfies Readonly<Record<JobType, (record: JobRecord) => WorkerSpec>>;
}
