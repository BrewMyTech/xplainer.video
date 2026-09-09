/**
 * One job's progress, from the events the daemon actually sends.
 *
 * The daemon's stream carries **the poll's own document**: every `job` event is an
 * `ExplainerJobOutput`, byte for byte what `GET /api/jobs/:id` would answer at that moment, and an
 * `end` event says which job finished and how. So there is no progress *percentage* here and this
 * module does not invent one — the contract carries a state, timestamps and the tail of the child's
 * output, and a bar drawn from a guess would be a bar that lies about how far along a render is.
 * What a window can honestly show is the state, how long it has been in it, and what the job last
 * said.
 *
 * A reducer rather than a component's `setState` pile, so the whole of "what the screen shows while
 * a render runs" is asserted against events a real job really emitted.
 */

import type { JobEventMessage } from "../../shared/ipc";

/** The five states a job is always in exactly one of. `JobState` in `@xplainer/protocol`. */
export const JOB_STATES = ["queued", "running", "done", "error", "cancelled"] as const;

/** One of {@link JOB_STATES}. */
export type JobStatus = (typeof JOB_STATES)[number];

/** One `job` event's document, read down to the fields a progress screen shows. */
export type JobSnapshot = {
  jobId: number;
  /** `explainer_narrate`, `explainer_still` or `explainer_render`. */
  jobType: string;
  status: JobStatus;
  /** The failure sentence, or `null` unless the status is `error`. */
  error: string | null;
  /** When it left the queue, as the daemon's ISO-8601 string, or `null` while it is queued. */
  startedAt: string | null;
  /** When it stopped, or `null` while it is queued or running. */
  finishedAt: string | null;
  /** The tail of what the job wrote, in the order it wrote it. */
  lines: string[];
};

/** One job a window is following, and everything it knows about it. */
export type JobWatch = {
  /** The subscription id the main process answered with, so two renders do not share a stream. */
  subscription: number;
  /** The video this job is about. */
  slug: string;
  /** The verb that queued it, for a heading a user can read before the first event arrives. */
  verb: string;
  /** The last document the stream carried, or `null` before the first event. */
  snapshot: JobSnapshot | null;
  /** Whether the stream has ended — which happens once, after the last `job` event. */
  ended: boolean;
  /** What went wrong with the stream itself, as opposed to with the job. */
  streamError: string | null;
};

/** A watch with nothing in it yet, which is what a window has between the `202` and the first event. */
export function beginWatch(options: {
  subscription: number;
  slug: string;
  verb: string;
}): JobWatch {
  return { ...options, snapshot: null, ended: false, streamError: null };
}

/**
 * Apply one event to one watch.
 *
 * An event for another subscription is not this watch's business and leaves it untouched, which is
 * what makes two renders followed at once two independent rows rather than one flickering between
 * them.
 */
export function applyJobEvent(watch: JobWatch, event: JobEventMessage): JobWatch {
  if (event.subscription !== watch.subscription) {
    return watch;
  }
  if (event.kind === "error") {
    return { ...watch, ended: true, streamError: String(event.data) };
  }
  if (event.kind === "end") {
    return { ...watch, ended: true };
  }
  const snapshot = readJob(event.data);
  return snapshot === null ? watch : { ...watch, snapshot };
}

/** Read a `job` event's document, or `null` when it is not one. */
export function readJob(value: unknown): JobSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const fields = value as Record<string, unknown>;
  const status = fields.status;
  if (typeof fields.job_id !== "number" || !isJobStatus(status)) {
    return null;
  }
  const output = fields.output;
  const lines =
    typeof output === "object" &&
    output !== null &&
    Array.isArray((output as { lines?: unknown }).lines)
      ? (output as { lines: unknown[] }).lines.filter(
          (line): line is string => typeof line === "string",
        )
      : [];
  return {
    jobId: fields.job_id,
    jobType: typeof fields.job_type === "string" ? fields.job_type : "",
    status,
    error: typeof fields.error === "string" ? fields.error : null,
    startedAt: typeof fields.started_at === "string" ? fields.started_at : null,
    finishedAt: typeof fields.finished_at === "string" ? fields.finished_at : null,
    lines,
  };
}

/** How long this job has been running, in seconds, or `null` when it has not started. */
export function elapsedSeconds(snapshot: JobSnapshot, now: number): number | null {
  if (snapshot.startedAt === null) {
    return null;
  }
  const started = Date.parse(snapshot.startedAt);
  if (Number.isNaN(started)) {
    return null;
  }
  const finished = snapshot.finishedAt === null ? now : Date.parse(snapshot.finishedAt);
  const end = Number.isNaN(finished) ? now : finished;
  return Math.max(0, (end - started) / 1000);
}

/** One line a progress row shows: what this job is, and where it has got to. */
export function describeWatch(watch: JobWatch, now: number): string {
  if (watch.streamError !== null) {
    return `the stream failed: ${watch.streamError}`;
  }
  const snapshot = watch.snapshot;
  if (snapshot === null) {
    return "queued — waiting for the daemon's first event";
  }
  const elapsed = elapsedSeconds(snapshot, now);
  const timing = elapsed === null ? "" : ` · ${elapsed.toFixed(1)} s`;
  if (snapshot.status === "error") {
    return `error${timing} — ${snapshot.error ?? "the job gave no reason"}`;
  }
  return `${snapshot.status}${timing}`;
}

/** Whether an unvalidated value is one of the five states. */
function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === "string" && (JOB_STATES as readonly string[]).includes(value);
}
