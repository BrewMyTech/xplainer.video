/**
 * A job record of the shape the store writes, for tests that need one without running a worker.
 *
 * Reconciliation's inputs are records left behind by a daemon that is *gone*, so most of them
 * cannot be produced by the runner in the same process. Building them explicitly is the only way to
 * assert what happens to a `running` record whose owner died, whose worker is a stranger, or whose
 * `format_version` is from next year.
 */

import { spawnSync } from "node:child_process";
import process from "node:process";
import { JOB_RECORD_FORMAT_VERSION, type JobRecord } from "../job-store.js";
import { selfIdentity } from "../worker-identity.js";

/** A `queued` record owned by this process, with every field the store requires. */
export function makeJobRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    format_version: JOB_RECORD_FORMAT_VERSION,
    job_id: 1,
    job_type: "explainer_render",
    status: "queued",
    video_id: "how-dns-works",
    output_dir: null,
    created_at: "2026-09-06T00:00:00.000Z",
    started_at: null,
    finished_at: null,
    exit_code: null,
    error: null,
    error_code: null,
    workers_uncertain: false,
    owner: { ...selfIdentity(), run_id: "test-run" },
    workers: [],
    log: [],
    ...overrides,
  };
}

/** An owner triple naming a process that is certainly not running. */
export function deadOwner(pid: number): JobRecord["owner"] {
  return {
    pid,
    start_time: "Thu Jan  1 00:00:00 1970",
    boot_id: selfIdentity().boot_id,
    run_id: "a-previous-run",
  };
}

/** The pid of a child that has already exited, which is a real "gone". */
export function exitedPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  });
  return Number(child.stdout);
}
