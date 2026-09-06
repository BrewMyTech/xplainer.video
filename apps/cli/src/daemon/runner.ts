/**
 * The job runner: one worker at a time, in its own process group, written down at every step.
 *
 * This is the seam [ADR 0008](../../../../docs/adr/0008-async-job-model-poll-and-progress-no-agent-webhooks.md)
 * left open — "the queue implementation is deliberately not decided by this ADR … the local job
 * runner is a phase-1 deliverable" — implemented under
 * [ADR 0024](../../../../docs/adr/0024-durable-jobs-and-boot-reconciliation.md)'s durability rules.
 * {@link JobRunner} is deliberately small: `enqueue`, `get`, `tail`, `cancel` and `drain` are the
 * five things the eight tools and the shutdown path need, and nothing above this interface knows
 * that a job is a child process.
 *
 * **`enqueue` returns only after the record is durable.** ADR 0024 §Durability of the write itself:
 * "An agent must never hold an identifier for a job that no restart can find; returning the id
 * first and writing 'shortly after' reintroduces the `404` this record exists to remove, in a
 * window narrow enough that it will only ever be hit in production."
 *
 * **The record is written on every state transition, and on a timer while a worker talks.** The
 * transitions are the correctness requirement; the timer is what makes a `SIGKILL` mid-render leave
 * behind a log tail worth reading rather than an empty one. Measured in ADR 0024's note, a durable
 * write costs 7.3 ms on macOS, so it belongs on transitions and on a {@link LOG_FLUSH_INTERVAL_MS}
 * timer — never per line, which is what a render's thousands of progress lines would cost.
 *
 * **One job at a time.** ADR 0024 §Drain on planned restart speaks of "the running job" in the
 * singular and gives it a 20-second checkpoint budget; a render saturates a laptop's CPU anyway, so
 * a serial queue is the honest shape and the one the drain was written against. `queued` is a real
 * state rather than a formality: {@link JobRunner.enqueue} returns before the worker is started, so
 * an agent that polls immediately observes `queued → running → done` in that order.
 *
 * **A job kind with no worker fails as a job, not as a tool call.** The registry is keyed by job
 * type, and the real narrate, still and render workers are wired in with the backend. Until then a
 * missing worker is reported through the same channel every other failure uses — a terminal record with
 * `error_code: "internal"` and a sentence saying which kind has no worker — because an agent
 * holding a `job_id` must always be able to poll it to a conclusion.
 */

import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";
import type {
  ExplainerJobInput,
  ExplainerJobOutput,
  JobErrorCode,
  JobType,
} from "@xplainer/protocol";
import {
  appendLogLine,
  DEFAULT_OUTPUT_LINES,
  JOB_RECORD_FORMAT_VERSION,
  type JobOwner,
  type JobRecord,
  type JobStore,
  toJobOutput,
} from "./job-store.js";
import { type GroupTarget, groupOf, terminateGroup } from "./process-group.js";
import { identify } from "./worker-identity.js";

/** How often a running job's log tail is made durable, on top of its state transitions. */
export const LOG_FLUSH_INTERVAL_MS = 2_000;

/** What ADR 0024 §Drain on planned restart gives an in-flight job to reach a checkpoint. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 20_000;

/** How to start one job's worker. Everything host-specific lives behind this. */
export type WorkerSpec = {
  command: string;
  args: readonly string[];
  cwd?: string;
  /** Added to the daemon's own environment rather than replacing it. */
  env?: Readonly<Record<string, string>>;
};

/** Builds the command for one job. Called once, when the job leaves the queue. */
export type WorkerFactory = (record: JobRecord) => WorkerSpec;

/** Which job kinds this daemon can actually run. */
export type WorkerRegistry = Readonly<Partial<Record<JobType, WorkerFactory>>>;

/** What a tool passes to {@link JobRunner.enqueue}. */
export type EnqueueRequest = {
  job_type: JobType;
  /** The video this job belongs to, when it has one. */
  video_id?: string | null;
  /** The directory the worker writes into, which reconciliation may quarantine. */
  output_dir?: string | null;
};

/**
 * The five operations above the job store.
 *
 * `explainer_narrate`, `explainer_still` and `explainer_render` call {@link enqueue};
 * `explainer_job` is {@link get}; the `SIGTERM` handler calls {@link drain}.
 */
export type JobRunner = {
  /** Queue a job. Resolves with its `job_id` once the record is durable, before it starts. */
  enqueue(request: EnqueueRequest): Promise<number>;
  /** `explainer_job`: the contract shape, with `output_lines` bounding the returned tail. */
  get(input: ExplainerJobInput): ExplainerJobOutput;
  /** The last `lines` output lines of a job, for a caller that wants only those. */
  tail(jobId: number, lines: number): string[];
  /** Stop a job and its process group. Resolves once the record is terminal and durable. */
  cancel(jobId: number): Promise<boolean>;
  /** Stop accepting, let the running job finish within `timeoutMs`, then hard-stop it. */
  drain(timeoutMs?: number): Promise<void>;
};

/** `explainer_job` was asked about an id this daemon has no record of. */
export class JobNotFoundError extends Error {
  readonly jobId: number;

  constructor(jobId: number) {
    super(`xplainer: no job with id ${jobId}`);
    this.name = "JobNotFoundError";
    this.jobId = jobId;
  }
}

/** The daemon is draining and will not take more work (ADR 0024 §Drain, step 1). */
export class NotAcceptingJobsError extends Error {
  constructor() {
    super("xplainer: the daemon is shutting down and is not accepting new jobs.");
    this.name = "NotAcceptingJobsError";
  }
}

/** What {@link createJobRunner} needs. */
export type CreateJobRunnerOptions = {
  store: JobStore;
  /** This daemon run, stamped into every record it writes. */
  owner: JobOwner;
  /** The records boot reconciliation produced, which the runner serves polls from. */
  records?: readonly JobRecord[];
  /** Which kinds can run. A kind that is absent fails its jobs with a named error. */
  workers?: WorkerRegistry;
  now?: () => Date;
  logFlushIntervalMs?: number;
  killGraceMs?: number;
};

/** Why a running job was stopped, decided before the signal and read after the exit. */
type Termination = "cancelled" | "daemon_shutdown";

type RunningJob = {
  jobId: number;
  child: ChildProcess;
  target: GroupTarget | null;
  /** Resolves once the exit has been recorded durably. */
  settled: Promise<void>;
};

/**
 * Which failure class a worker's non-zero exit belongs to.
 *
 * The enum is small and general by design (ADR 0024 §Extending the `error_code` enum), so the
 * mapping is the job kind: narration failing is `tts_failed` and a picture failing is
 * `render_failed`, which is exactly the branch those two descriptions tell an agent to take.
 */
function failureCodeFor(jobType: JobType): JobErrorCode {
  return jobType === "explainer_narrate" ? "tts_failed" : "render_failed";
}

function positiveLineCount(requested: number | undefined): number {
  const lines = requested ?? DEFAULT_OUTPUT_LINES;
  return Number.isFinite(lines) && lines >= 1 ? Math.trunc(lines) : DEFAULT_OUTPUT_LINES;
}

function isTerminal(record: JobRecord): boolean {
  return record.status === "done" || record.status === "error" || record.status === "cancelled";
}

/** Build the runner over an already-reconciled store. */
export function createJobRunner(options: CreateJobRunnerOptions): JobRunner {
  const { store, owner } = options;
  const workers: WorkerRegistry = options.workers ?? {};
  const now = options.now ?? (() => new Date());
  const flushIntervalMs = options.logFlushIntervalMs ?? LOG_FLUSH_INTERVAL_MS;

  const records = new Map<number, JobRecord>(
    (options.records ?? []).map((record) => [record.job_id, record]),
  );
  const queue: number[] = [];
  const terminationOf = new Map<number, Termination>();
  let running: RunningJob | null = null;
  let accepting = true;

  function requireRecord(jobId: number): JobRecord {
    const record = records.get(jobId);
    if (record === undefined) {
      throw new JobNotFoundError(jobId);
    }
    return record;
  }

  /** Write a record to disk and keep the in-memory copy the polls are served from in step. */
  function persist(record: JobRecord): void {
    records.set(record.job_id, record);
    store.put(record);
  }

  function finish(
    record: JobRecord,
    outcome: {
      status: JobRecord["status"];
      exit_code: number | null;
      error: string | null;
      error_code: JobErrorCode | null;
    },
  ): void {
    record.status = outcome.status;
    record.exit_code = outcome.exit_code;
    record.error = outcome.error;
    record.error_code = outcome.error_code;
    record.finished_at = now().toISOString();
    persist(record);
  }

  /**
   * Attach the worker's two streams to the record's bounded tail.
   *
   * Lines are split here rather than logged as chunks because the tail is counted in lines and a
   * chunk boundary is not a line boundary; a partial trailing line is held until the rest arrives,
   * and flushed when the stream ends.
   */
  function captureOutput(child: ChildProcess, record: JobRecord, markDirty: () => void): void {
    for (const stream of [child.stdout, child.stderr]) {
      if (stream === null) {
        continue;
      }
      let pending = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        pending += chunk;
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
          appendLogLine(record, pending.slice(0, newline).replace(/\r$/, ""));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
        }
        markDirty();
      });
      stream.on("end", () => {
        if (pending !== "") {
          appendLogLine(record, pending);
          pending = "";
          markDirty();
        }
      });
    }
  }

  function startNext(): void {
    // The drain stops the queue as well as the running job: ADR 0024 §Drain, step 1 is "stop
    // accepting new jobs", and starting the next queued one after hard-stopping the current one
    // would be exactly the thing that never terminates.
    if (!accepting || running !== null || queue.length === 0) {
      return;
    }
    const jobId = queue.shift();
    if (jobId === undefined) {
      return;
    }
    const record = records.get(jobId);
    if (record === undefined || isTerminal(record)) {
      startNext();
      return;
    }

    const factory = workers[record.job_type];
    if (factory === undefined) {
      appendLogLine(
        record,
        `[xplainer] no worker is registered for ${record.job_type} in this build, so the job cannot run.`,
      );
      finish(record, {
        status: "error",
        exit_code: null,
        error: `No worker is registered for ${record.job_type} in this build.`,
        error_code: "internal",
      });
      startNext();
      return;
    }

    let spec: WorkerSpec;
    try {
      spec = factory(record);
    } catch (error) {
      appendLogLine(
        record,
        `[xplainer] the ${record.job_type} worker could not be built: ${String(error)}`,
      );
      finish(record, {
        status: "error",
        exit_code: null,
        error: `The ${record.job_type} worker could not be built: ${String(error)}`,
        error_code: "internal",
      });
      startNext();
      return;
    }

    const child = spawn(spec.command, [...spec.args], {
      // `detached` is what puts the worker in its own process group, which is the handle that
      // reaches the browser and the encoder it will start (ADR 0024 §Scope: … and its children).
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      env: { ...process.env, ...spec.env },
    });

    const target = groupOf(child);
    record.status = "running";
    record.started_at = now().toISOString();
    record.workers = target === null ? [] : [{ ...identify(target.pid), pgid: target.pgid }];
    persist(record);

    let dirty = false;
    const flush = setInterval(() => {
      if (dirty) {
        dirty = false;
        persist(record);
      }
    }, flushIntervalMs);
    flush.unref();

    captureOutput(child, record, () => {
      dirty = true;
    });

    // `spawn` can emit both `error` and `exit` for one failure — an unspawnable command is the
    // usual case — and the record must be written once, by whichever arrives first.
    let concluded = false;

    const settled = new Promise<void>((resolve) => {
      const conclude = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        if (concluded) {
          return;
        }
        concluded = true;
        clearInterval(flush);
        const termination = terminationOf.get(record.job_id);
        terminationOf.delete(record.job_id);
        running = null;

        if (termination === "cancelled") {
          appendLogLine(
            record,
            "[xplainer] the job was cancelled and its process group was stopped.",
          );
          finish(record, {
            status: "cancelled",
            exit_code: exitCode,
            error: "The job was cancelled.",
            error_code: "cancelled",
          });
        } else if (termination === "daemon_shutdown") {
          appendLogLine(record, "[xplainer] the daemon stopped before this job finished.");
          finish(record, {
            status: "error",
            exit_code: exitCode,
            error: "The daemon stopped before this job finished. Retry once it is running again.",
            error_code: "daemon_shutdown",
          });
        } else if (exitCode === 0) {
          finish(record, { status: "done", exit_code: 0, error: null, error_code: null });
        } else {
          const how = exitCode === null ? `signal ${signal ?? "unknown"}` : `exit code ${exitCode}`;
          appendLogLine(record, `[xplainer] the worker ended with ${how}.`);
          finish(record, {
            status: "error",
            exit_code: exitCode,
            error: `The ${record.job_type} worker ended with ${how}.`,
            error_code: failureCodeFor(record.job_type),
          });
        }
        resolve();
        startNext();
      };

      child.once("error", (error) => {
        if (concluded) {
          return;
        }
        concluded = true;
        appendLogLine(record, `[xplainer] the worker could not be started: ${error.message}`);
        clearInterval(flush);
        running = null;
        finish(record, {
          status: "error",
          exit_code: null,
          error: `The ${record.job_type} worker could not be started: ${error.message}`,
          error_code: "internal",
        });
        resolve();
        startNext();
      });
      child.once("exit", conclude);
    });

    running = { jobId: record.job_id, child, target, settled };
  }

  async function stopRunning(termination: Termination): Promise<void> {
    const current = running;
    if (current === null) {
      return;
    }
    terminationOf.set(current.jobId, termination);
    if (current.target !== null) {
      await terminateGroup(current.target, options.killGraceMs);
    } else {
      current.child.kill("SIGKILL");
    }
    await current.settled;
  }

  return {
    async enqueue(request: EnqueueRequest): Promise<number> {
      if (!accepting) {
        throw new NotAcceptingJobsError();
      }
      const jobId = store.nextJobId();
      const record: JobRecord = {
        format_version: JOB_RECORD_FORMAT_VERSION,
        job_id: jobId,
        job_type: request.job_type,
        status: "queued",
        video_id: request.video_id ?? null,
        output_dir: request.output_dir ?? null,
        created_at: now().toISOString(),
        started_at: null,
        finished_at: null,
        exit_code: null,
        error: null,
        error_code: null,
        workers_uncertain: false,
        owner,
        workers: [],
        log: [],
      };

      // Durable first, id second: this line is the one ADR 0024 §Durability of the write itself is
      // about, and everything after it may be lost without breaking the contract.
      persist(record);
      queue.push(jobId);

      // The worker starts on the next turn of the loop, which is what makes `queued` observable to
      // a caller that polls immediately after the tool returns (roadmap P1-5).
      setImmediate(startNext);
      return jobId;
    },

    get(input: ExplainerJobInput): ExplainerJobOutput {
      const record = requireRecord(input.job_id);
      return toJobOutput(record, positiveLineCount(input.output_lines));
    },

    tail(jobId: number, lines: number): string[] {
      return requireRecord(jobId).log.slice(-positiveLineCount(lines));
    },

    async cancel(jobId: number): Promise<boolean> {
      const record = requireRecord(jobId);
      if (isTerminal(record)) {
        return false;
      }
      if (running !== null && running.jobId === jobId) {
        await stopRunning("cancelled");
        return true;
      }
      const queuedAt = queue.indexOf(jobId);
      if (queuedAt >= 0) {
        queue.splice(queuedAt, 1);
      }
      appendLogLine(record, "[xplainer] the job was cancelled before it started.");
      finish(record, {
        status: "cancelled",
        exit_code: null,
        error: "The job was cancelled.",
        error_code: "cancelled",
      });
      return true;
    },

    async drain(timeoutMs: number = DEFAULT_DRAIN_TIMEOUT_MS): Promise<void> {
      accepting = false;

      const current = running;
      if (current !== null) {
        const finishedInTime = await Promise.race([
          current.settled.then(() => true),
          new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
              resolve(false);
            }, timeoutMs);
            timer.unref();
          }),
        ]);
        if (!finishedInTime) {
          await stopRunning("daemon_shutdown");
        }
      }

      // "A queued job has no partial state, so it is always safe to retry" — ADR 0024 §Drain,
      // step 5, which gives queued and running the same code deliberately.
      while (queue.length > 0) {
        const jobId = queue.shift();
        if (jobId === undefined) {
          break;
        }
        const record = records.get(jobId);
        if (record === undefined || isTerminal(record)) {
          continue;
        }
        appendLogLine(record, "[xplainer] the daemon stopped before this job started.");
        finish(record, {
          status: "error",
          exit_code: null,
          error: "The daemon stopped before this job started. Retry once it is running again.",
          error_code: "daemon_shutdown",
        });
      }
    },
  };
}
