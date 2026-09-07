/**
 * What a queued job was actually asked to do, written where its worker can read it.
 *
 * `daemon/job-store.ts` records a job's *lifecycle* — its id, its state, its owner, its log tail —
 * and deliberately nothing else: ADR 0008 dropped the reference implementation's `command` field
 * because a host path in a poll answer is a leak on a hosted backend, and ADR 0024's record shape
 * followed. So the arguments an agent passed to `explainer_narrate`, `explainer_still` or
 * `explainer_render` have nowhere to live inside the record, and the worker — a separate process,
 * started later, by a registry that never saw the tool call — has to learn them from somewhere.
 *
 * This is that somewhere: one small JSON document per job under `<workspace>/requests/`, written by
 * the backend and read by `daemon/workers.ts` when the job leaves the queue. Both sides derive the
 * path from the workspace root alone, which is what lets the registry be built in
 * `daemon/start.ts`, before any backend exists.
 *
 * **The write happens after `enqueue()` resolves, and that is ordered, not lucky.** The runner
 * starts a queued job from a `setImmediate` callback, which runs in the event loop's check phase —
 * after the microtask queue has drained, and therefore after the `await enqueue(...)` continuation
 * that writes this file has run to completion. A missing document is still handled rather than
 * assumed away: {@link readJobRequest} throws, the registry's factory propagates, and the runner
 * turns that into a terminal `error`/`internal` record an agent can poll to a conclusion.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JobType } from "@xplainer/protocol";

/** Where the request documents live, under the workspace root. */
export const REQUESTS_DIR = "requests";

/** `explainer_narrate`'s arguments, with `dry_run` already defaulted. */
export type NarrateJobRequest = {
  job_type: "explainer_narrate";
  slug: string;
  /** Estimate silence instead of calling the TTS server. */
  dry_run: boolean;
};

/** `explainer_still`'s arguments, with `frame` and `scale` already defaulted from the schema. */
export type StillJobRequest = {
  job_type: "explainer_still";
  slug: string;
  frame: number;
  scale: number;
};

/** `explainer_render`'s arguments. The tool takes only a slug. */
export type RenderJobRequest = {
  job_type: "explainer_render";
  slug: string;
};

/** One queued job's arguments, discriminated by the job type the record also carries. */
export type JobRequest = NarrateJobRequest | StillJobRequest | RenderJobRequest;

/** The request shape that goes with one job type, so a reader is narrowed by what it asked for. */
export type JobRequestFor<T extends JobType> = Extract<JobRequest, { job_type: T }>;

/** A request document that is missing, unreadable, or not about the job that asked for it. */
export class JobRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobRequestError";
  }
}

/** The file job `jobId`'s request document lives in. */
export function jobRequestPath(root: string, jobId: number): string {
  return join(root, REQUESTS_DIR, `job-${String(jobId).padStart(6, "0")}.json`);
}

/**
 * Write one job's request document, creating `requests/` if this is the first job.
 *
 * @returns the path written
 */
export function writeJobRequest(root: string, jobId: number, request: JobRequest): string {
  const path = jobRequestPath(root, jobId);
  mkdirSync(join(root, REQUESTS_DIR), { recursive: true });
  writeFileSync(path, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  return path;
}

/**
 * Every field any of the three request shapes can carry, all optional and all unknown.
 *
 * Written out rather than derived from the union: an intersection of the three would collapse
 * `job_type` to `never`, and reading a parsed JSON document is exactly the place where the fields
 * must be *checked* rather than assumed.
 */
type ParsedRequest = {
  job_type?: unknown;
  slug?: unknown;
  dry_run?: unknown;
  frame?: unknown;
  scale?: unknown;
};

/** Whether `value` is a request for a job of `jobType`, checked field by field. */
function isRequestFor(value: unknown, jobType: JobType): value is JobRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as ParsedRequest;
  if (candidate.job_type !== jobType || typeof candidate.slug !== "string") {
    return false;
  }
  if (jobType === "explainer_narrate") {
    return typeof candidate.dry_run === "boolean";
  }
  if (jobType === "explainer_still") {
    return typeof candidate.frame === "number" && typeof candidate.scale === "number";
  }
  return true;
}

/**
 * Read job `jobId`'s request document back.
 *
 * @param jobType the type the job record carries, which the document must agree with — a mismatch
 *   means the two halves of one job have drifted apart, and building a worker from the wrong half
 *   would render the wrong thing rather than fail
 * @throws JobRequestError when the document is missing, unparseable, or does not describe a
 *   `jobType` job
 */
export function readJobRequest<T extends JobType>(
  root: string,
  jobId: number,
  jobType: T,
): JobRequestFor<T> {
  const path = jobRequestPath(root, jobId);
  if (!existsSync(path)) {
    throw new JobRequestError(
      `job ${jobId} has no request document at ${path}, so there is nothing to tell the ` +
        `${jobType} worker to do. Retry the call.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new JobRequestError(
      `job ${jobId}'s request document ${path} is not readable JSON (${String(error)}). ` +
        "Retry the call.",
    );
  }
  if (!isRequestFor(parsed, jobType)) {
    throw new JobRequestError(
      `job ${jobId}'s request document ${path} does not describe a ${jobType} job. Retry the call.`,
    );
  }
  // `isRequestFor` has just proved the discriminant equals `jobType` and that the fields that go
  // with it are present, which is exactly what `JobRequestFor<T>` says; the union-to-member step is
  // the one thing a type predicate over a generic cannot express.
  return parsed as JobRequestFor<T>;
}
