/**
 * Which job kinds this daemon can run, and the exact command each one becomes.
 *
 * `runner.ts` deliberately knows nothing about narration or Remotion: it starts a process group,
 * captures a bounded log tail and writes the record down. Everything host-specific lives behind
 * {@link WorkerSpec}, and this file is the only place that builds one. Three kinds exist, and they
 * are two different shapes:
 *
 * - **`explainer_narrate`** is *this* package's own code in a child process: the narration port
 *   from `@xplainer/render-core`, driven against `@xplainer/tts-client`. It runs out of process
 *   because the daemon must stay answerable while a segment is being synthesised, and because a
 *   `SIGTERM` mid-narration has to reach one killable process group like every other job.
 * - **`explainer_still` and `explainer_render`** are the pinned Remotion CLI, spawned with the argv
 *   `@xplainer/render-core`'s `stillArgs()` / `renderArgs()` build. Not `npx`: `REMOTION_BIN`
 *   records why, and {@link remotionWorker} resolves the workspace's own install.
 *
 * **All three are `<interpreter> <entry file>`, and that is decision D1.**
 * `node_modules/.bin/remotion` is a symlink to a file whose first line is `#!/usr/bin/env node`,
 * so spawning it directly makes
 * the kernel hand it to `/usr/bin/env`, which searches the **child's** `PATH`: measured exit `127`
 * under `PATH=/usr/bin:/bin`, on exactly the machine class this runtime is built for. So the two
 * Remotion workers resolve `@remotion/cli`'s own `bin` entry with `runtime/launch-spec.ts` and run
 * it under `process.execPath` — which is `<runtime>/bin/node` when the daemon came out of a payload
 * — the same shape the narration worker has always had. `PATH` is **not** injected through
 * `WorkerSpec.env`: `runner.ts` would merge it happily, and it would leak an interpreter onto the
 * `PATH` of everything the worker starts, Chrome and ffmpeg included.
 *
 * **The last gate before Chrome starts lives here** (ADR 0018, layer 4). A factory runs in the
 * daemon, in process, at the moment the job leaves the queue — so this is where `scaffoldVideo()`
 * restores an engine-owned file an agent wrote to directly through `write_source_to`, and where
 * `assertRenderable()` refuses a render whose narration or captions are missing. A factory that
 * throws costs a second; the render it stopped would have cost minutes and produced a silent MP4.
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
import {
  assertRenderable,
  REMOTION_BIN,
  renderArgs,
  scaffoldVideo,
  stillArgs,
  stillOutput,
  videoPaths,
  workspaceNotInstalledMessage,
} from "@xplainer/render-core";
import { readJobRequest } from "../job-request.js";
import { findInstalledPackage, type NodeEntry, resolveNodeEntry } from "../runtime/launch-spec.js";
import type { JobRecord } from "./job-store.js";
import type { WorkerRegistry, WorkerSpec } from "./runner.js";
import { acquireVideoWriteLock } from "./video-lock.js";

/** What {@link createWorkerRegistry} needs. */
export type CreateWorkerRegistryOptions = {
  /** The shared Remotion workspace root every job reads and writes under. */
  root: string;
};

/**
 * How to start the narration worker with this build's own sources.
 *
 * Two shapes, chosen by what is actually on disk beside this module. After a build it is
 * `dist/workers/narrate.js` and plain `node` runs it. Under Vitest this module is still
 * `src/daemon/workers.ts`, so the entry is `src/workers/narrate.ts` and the child needs the same
 * `--import` hook every other spawned test child uses — `turbo.json` gives `test` a `dependsOn` of
 * `^build`, the *dependencies'* builds and not this package's, so `dist/` may be absent or stale
 * while the tests run and spawning it would be a green test over code that is not the code.
 *
 * The `.ts` branch is unreachable from a published package: `tsconfig.build.json` excludes
 * `src/**\/testing/**`, so a `dist/` never contains the hook, and it never contains a `.ts` entry
 * to run under it either.
 */
function narrateWorkerCommand(): { command: string; args: string[] } {
  const compiled = fileURLToPath(new URL("../workers/narrate.js", import.meta.url));
  if (existsSync(compiled)) {
    return { command: process.execPath, args: [compiled] };
  }
  const source = fileURLToPath(new URL("../workers/narrate.ts", import.meta.url));
  const hook = fileURLToPath(new URL("./testing/ts-source-hook.ts", import.meta.url));
  if (existsSync(source) && existsSync(hook)) {
    return { command: process.execPath, args: ["--import", hook, source] };
  }
  throw new Error(
    `the narration worker is missing: neither ${compiled} nor ${source} exists. This build is ` +
      "incomplete; reinstall @xplainer/cli.",
  );
}

/**
 * The Remotion CLI for this workspace as an interpreter and an argv, or a refusal naming the one
 * command that fixes it.
 *
 * Resolved per job rather than once, so a workspace installed while the daemon is running starts
 * working without a restart.
 *
 * The package directory is what is looked for, not `node_modules/.bin/remotion`: the shim is the
 * thing D1 removes, and a package present without an entry is a different failure from a package
 * that was never installed — `findInstalledPackage()` answering `null` is the second one, and it is
 * the one a user fixes with `npm install`.
 */
function remotionWorker(root: string, args: readonly string[]): NodeEntry {
  const packageDir = findInstalledPackage(root, "@remotion/cli");
  if (packageDir === null) {
    throw new Error(workspaceNotInstalledMessage(root));
  }
  return resolveNodeEntry(packageDir, REMOTION_BIN, { args });
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
  const { root } = options;

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
        release: lockVideo(slug, "explainer_narrate", record.job_id),
      };
    },

    explainer_still(record: JobRecord): WorkerSpec {
      const request = readJobRequest(root, record.job_id, "explainer_still");
      const slug = agreedSlug(record, request.slug);
      const video = videoPaths(root, slug);
      assertReadyToRender(video.source, video.publicDir);
      const worker = remotionWorker(
        root,
        stillArgs({
          slug,
          output: stillOutput(video, request.frame),
          publicDir: video.publicDir,
          frame: request.frame,
          scale: request.scale,
        }),
      );
      return {
        command: worker.executable,
        args: worker.argv,
        cwd: root,
        release: lockVideo(slug, "explainer_still", record.job_id),
      };
    },

    explainer_render(record: JobRecord): WorkerSpec {
      const request = readJobRequest(root, record.job_id, "explainer_render");
      const slug = agreedSlug(record, request.slug);
      const video = videoPaths(root, slug);
      assertReadyToRender(video.source, video.publicDir);
      const worker = remotionWorker(
        root,
        renderArgs({ slug, output: video.mp4, publicDir: video.publicDir }),
      );
      return {
        command: worker.executable,
        args: worker.argv,
        cwd: root,
        release: lockVideo(slug, "explainer_render", record.job_id),
      };
    },
  } satisfies Readonly<Record<JobType, (record: JobRecord) => WorkerSpec>>;
}
