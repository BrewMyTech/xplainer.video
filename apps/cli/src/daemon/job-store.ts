/**
 * One JSON file per job, under the exclusively-owned state directory.
 *
 * [ADR 0024](../../../../docs/adr/0024-durable-jobs-and-boot-reconciliation.md) §Durability decides
 * that job records outlive the process that wrote them, and its note of 2026-09-06 §Storage shape
 * settles the shape: **one JSON file per job under `jobs/`, written temp-then-`rename`**, with
 * `node:sqlite` rejected. Measured, WAL is almost exactly twice as cheap per durable record —
 * 3.684 ms against 7.339 ms — and the note states that plainly rather than burying it. What decided
 * against it is a rule this file has to keep: §An unknown format version is not corruption requires
 * that a record written by a **newer** daemon is left untouched, because ADR 0025's rollback step
 * depends on newer state surviving a downgrade. That rule is *per record*, and SQLite has one
 * schema for the whole file: "one file per job makes 'leave this one alone' expressible; one
 * database does not."
 *
 * So {@link JobStore.load} tells three conditions apart, exactly as that section requires, and
 * never collapses them into one "corrupt" bucket:
 *
 * - **Unparseable, or missing the fields that make it a job record — corruption.** Move the file to
 *   `jobs/corrupt/`, leave a terminal tombstone in its place when enough of it survived to say what
 *   kind of job it was, and carry on. One bad record must never stop a daemon from starting, and
 *   its id is never handed out again.
 * - **A `format_version` newer than this daemon understands — a rollback signal.** Leave the record
 *   *untouched* on disk and report it, so the newer daemon that wrote it still finds its own state.
 * - **A version older than the current one** is read as-is. There is exactly one version today, so
 *   there is no migration to write and none is pretended.
 *
 * The log is a bounded tail rather than a whole transcript: {@link JOB_LOG_LINE_CAP} lines, oldest
 * dropped first. ADR 0020 requires "a bounded log tail" of a job whose process died, and ADR 0008
 * gives `explainer_job` an `output_lines` argument "so a polling agent does not re-read a large log
 * on every call". The cap is that argument's own schema default, from
 * `packages/protocol/schemas/tools/explainer_job.input.json` — pinned to it by a test rather than
 * chosen here — so the record keeps what a default poll asks for and a render's ten thousand
 * progress lines can never turn one job record into the thing that fills a laptop.
 */

import { type Dirent, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { ExplainerJobOutput, JobErrorCode, JobState, JobType } from "@xplainer/protocol";
import { ensureStateDirectory, writeJsonDurably } from "./durable-write.js";
import { type StateDirLayout, stateDirLayout } from "./state-dir.js";
import { type ProcessIdentity, selfIdentity } from "./worker-identity.js";

/** The version every record this daemon writes carries. */
export const JOB_RECORD_FORMAT_VERSION = 1;

/**
 * How many trailing output lines a record keeps.
 *
 * This is `output_lines`' `default` in `schemas/tools/explainer_job.input.json`, and
 * `job-store.test.ts` reads that schema and asserts the two are equal, so the number cannot drift
 * away from the contract it comes from.
 */
export const JOB_LOG_LINE_CAP = 60;

/** What `explainer_job` returns when the caller does not say. The same schema default. */
export const DEFAULT_OUTPUT_LINES = 60;

/** The daemon run that owns a record: the identity triple plus which acquisition it was. */
export type JobOwner = ProcessIdentity & {
  /** The owning acquisition's `boot_nonce`, so two runs of the same pid are told apart. */
  run_id: string;
};

/** A worker process the daemon spawned, recorded so reconciliation can decide about it. */
export type RecordedWorker = ProcessIdentity & {
  /**
   * The process group the daemon put it in, which is the handle that reaches its children too.
   * `null` on a platform where a group cannot be signalled as a unit.
   */
  pgid: number | null;
};

/** One job, as it lives on disk. */
export type JobRecord = {
  format_version: number;
  job_id: number;
  job_type: JobType;
  status: JobState;
  /** The video this job is for, or `null` for a job that names no video yet. */
  video_id: string | null;
  /** The directory the job writes into, quarantined if a worker survives it unidentified. */
  output_dir: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  error: string | null;
  error_code: JobErrorCode | null;
  /** Set when reconciliation could not decide about at least one recorded worker. */
  workers_uncertain: boolean;
  owner: JobOwner;
  workers: RecordedWorker[];
  /** The bounded tail, oldest line first. */
  log: string[];
};

/** What one pass over `jobs/` found. */
export type LoadedJobs = {
  /** Every record this daemon can read, in job-id order. */
  records: JobRecord[];
  /** Files moved to `jobs/corrupt/` during this load, by their original name. */
  corrupt: string[];
  /** Job ids whose `format_version` is newer than this daemon's, left untouched on disk. */
  newer: number[];
};

/** The store, as the reconciler and the runner use it. */
export type JobStore = {
  /** Where everything this store touches lives. */
  paths: StateDirLayout;
  /** Read every record, quarantining what cannot be parsed. */
  load(): LoadedJobs;
  /** Write one record durably. Returns once a `SIGKILL` could no longer lose it. */
  put(record: JobRecord): void;
  /** Read one record, or `undefined` if there is no file for that id. */
  read(jobId: number): JobRecord | undefined;
  /** The lowest id no record has used, derived from the files themselves. */
  nextJobId(): number;
  /** The file a job's record lives in. */
  pathOf(jobId: number): string;
};

const JOB_FILE_PATTERN = /^job-(\d+)\.json$/;

const JOB_STATES: readonly JobState[] = ["queued", "running", "done", "error", "cancelled"];
const JOB_TYPES: readonly JobType[] = ["explainer_narrate", "explainer_render", "explainer_still"];

function jobFileName(jobId: number): string {
  return `job-${String(jobId).padStart(6, "0")}.json`;
}

/**
 * Is this parsed JSON a job record?
 *
 * Deliberately a shape check rather than a schema validation: the fields below are the ones every
 * later step dereferences, and a file missing one of them cannot be reported as a job at all, which
 * is what makes it corruption rather than a version difference.
 */
function isJobRecord(value: unknown): value is JobRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<JobRecord>;
  return (
    typeof candidate.format_version === "number" &&
    typeof candidate.job_id === "number" &&
    typeof candidate.job_type === "string" &&
    JOB_TYPES.includes(candidate.job_type) &&
    typeof candidate.status === "string" &&
    JOB_STATES.includes(candidate.status) &&
    Array.isArray(candidate.log) &&
    typeof candidate.owner === "object" &&
    candidate.owner !== null
  );
}

/**
 * Turn what is left of an unreadable record into a terminal one, when enough of it survived.
 *
 * ADR 0024 §An unknown format version is not corruption asks for a quarantined record to be
 * "reported as `error` with `error_code: \"internal\"`". That needs a `job_type`, because the
 * contract requires one — and a file whose bytes are damaged may no longer carry it. So the
 * tombstone is written when the type can be **read** from what parsed, and never guessed: telling
 * an agent to retry `explainer_render` for what was in fact a narration would be a worse answer
 * than the "no such job" it gets otherwise. The id is spent either way, because
 * {@link JobStore.nextJobId} counts the quarantine.
 */
function salvageTombstone(parsed: unknown, jobId: number, quarantinedTo: string): JobRecord | null {
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const candidate = parsed as Partial<JobRecord>;
  const jobType = candidate.job_type;
  if (typeof jobType !== "string" || !JOB_TYPES.includes(jobType)) {
    return null;
  }
  const at = new Date().toISOString();
  return {
    format_version: JOB_RECORD_FORMAT_VERSION,
    job_id: jobId,
    job_type: jobType,
    status: "error",
    video_id: typeof candidate.video_id === "string" ? candidate.video_id : null,
    output_dir: typeof candidate.output_dir === "string" ? candidate.output_dir : null,
    created_at: typeof candidate.created_at === "string" ? candidate.created_at : at,
    started_at: null,
    finished_at: at,
    exit_code: null,
    error: `This job's record could not be read and was quarantined to ${quarantinedTo}. Retry the call.`,
    error_code: "internal",
    workers_uncertain: false,
    owner: { ...selfIdentity(), run_id: "quarantine" },
    workers: [],
    log: [`[xplainer] the record was unreadable and was moved to ${quarantinedTo}.`],
  };
}

/** Append a line to a record's bounded tail, dropping the oldest when it is full. */
export function appendLogLine(record: JobRecord, line: string): void {
  record.log.push(line);
  if (record.log.length > JOB_LOG_LINE_CAP) {
    record.log.splice(0, record.log.length - JOB_LOG_LINE_CAP);
  }
}

/**
 * Project a record onto the contract `explainer_job` returns.
 *
 * The record holds more than the tool does — the owner triple, the recorded workers, the output
 * directory — and none of it crosses this boundary: ADR 0008 dropped the reference implementation's
 * `command` field because "on a hosted backend that string is the server's own shell invocation",
 * and the same reasoning applies to every host path in a record.
 */
export function toJobOutput(record: JobRecord, outputLines: number): ExplainerJobOutput {
  return {
    job_id: record.job_id,
    job_type: record.job_type,
    status: record.status,
    exit_code: record.exit_code,
    error: record.error,
    error_code: record.error_code,
    started_at: record.started_at,
    finished_at: record.finished_at,
    output: { lines: record.log.slice(-outputLines) },
  };
}

/** Open — and create, if this is a first run — the job store under `stateDir`. */
export function createJobStore(stateDir: string): JobStore {
  const paths = stateDirLayout(stateDir);
  ensureStateDirectory(paths.jobs);

  function pathOf(jobId: number): string {
    return join(paths.jobs, jobFileName(jobId));
  }

  function quarantine(name: string): void {
    ensureStateDirectory(paths.corrupt);
    renameSync(join(paths.jobs, name), join(paths.corrupt, name));
  }

  function read(jobId: number): JobRecord | undefined {
    let raw: string;
    try {
      raw = readFileSync(pathOf(jobId), "utf8");
    } catch {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return isJobRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  function jobFilesIn(directory: string): { name: string; jobId: number }[] {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isFile())
      .flatMap((entry) => {
        const match = JOB_FILE_PATTERN.exec(entry.name);
        const digits = match?.[1];
        return digits === undefined ? [] : [{ name: entry.name, jobId: Number(digits) }];
      })
      .sort((left, right) => left.jobId - right.jobId);
  }

  function jobFiles(): { name: string; jobId: number }[] {
    return jobFilesIn(paths.jobs);
  }

  return {
    paths,
    pathOf,
    read,

    /**
     * The quarantine counts. An id whose record was moved to `jobs/corrupt/` is spent: handing it
     * to a new job would give an agent still holding that number a different job's answers.
     */
    nextJobId(): number {
      const highest = [...jobFiles(), ...jobFilesIn(paths.corrupt)].reduce(
        (max, file) => (file.jobId > max ? file.jobId : max),
        0,
      );
      return highest + 1;
    },

    load(): LoadedJobs {
      const records: JobRecord[] = [];
      const corrupt: string[] = [];
      const newer: number[] = [];

      for (const file of jobFiles()) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(join(paths.jobs, file.name), "utf8"));
        } catch {
          quarantine(file.name);
          corrupt.push(file.name);
          continue;
        }
        if (!isJobRecord(parsed)) {
          quarantine(file.name);
          corrupt.push(file.name);
          const tombstone = salvageTombstone(parsed, file.jobId, join(paths.corrupt, file.name));
          if (tombstone !== null) {
            writeJsonDurably(pathOf(tombstone.job_id), tombstone);
            records.push(tombstone);
          }
          continue;
        }
        if (parsed.format_version > JOB_RECORD_FORMAT_VERSION) {
          newer.push(parsed.job_id);
        }
        records.push(parsed);
      }

      return { records, corrupt, newer };
    },

    put(record: JobRecord): void {
      writeJsonDurably(pathOf(record.job_id), record);
    },
  };
}
