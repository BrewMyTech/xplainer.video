/**
 * Boot reconciliation: making every poll terminate across a restart.
 *
 * [ADR 0024](../../../../docs/adr/0024-durable-jobs-and-boot-reconciliation.md) §Boot
 * reconciliation is the whole contract of this file. After acquiring ownership and **before**
 * binding, `serve` reads every job record, and any job in `queued` or `running` whose recorded pid
 * is not alive, or whose recorded machine boot differs from this one, is rewritten to `error`,
 * `exit_code: null`, `error_code: "daemon_restarted"`, a `finished_at`, and a final output line
 * naming what happened. The agent's next `explainer_job` poll therefore gets a terminal, explained,
 * retryable answer — "not a `404`, and not a `running` that never advances".
 *
 * Three things this file is careful about, each because the record says so:
 *
 * **A recorded pid is not an identity.** Killing is conditional on the process still being the one
 * that was recorded, decided by {@link classifyWorker} on the whole tuple. Only a `ours` verdict is
 * signalled. On a laptop that rebooted overnight, "the pid that was ffmpeg at 03:12 is somebody's
 * editor at 09:00".
 *
 * **Uncertain ownership isolates the retry; it does not block it, and it does not license a kill.**
 * A job with at least one worker the daemon could not positively identify is *also* marked `error` —
 * an agent must never be left polling — but the record carries `workers_uncertain: true`, the final
 * output line names it, and the job's output directory is **quarantined** so a retry writes to a
 * fresh directory rather than one a possible survivor may still hold open. Blocking the retry
 * instead "converts an unkillable stray process into a permanent denial of service for that video".
 *
 * **An unknown format version is not corruption.** A record written by a *newer* daemon is never
 * rewritten — ADR 0025's rollback step depends on newer state surviving a downgrade — but it is
 * still *reported* as `error`/`daemon_restarted`, in memory only, so the agent holding its id gets
 * an answer. Unparseable files are quarantined to `jobs/corrupt/` by the store and reported
 * `internal`; one bad record must never stop a daemon from starting.
 */

import { existsSync, renameSync } from "node:fs";
import type { JobErrorCode } from "@xplainer/protocol";
import type { JobRecord, JobStore } from "./job-store.js";
import { appendLogLine, JOB_RECORD_FORMAT_VERSION } from "./job-store.js";
import { type GroupTarget, terminateGroup } from "./process-group.js";
import { classifyWorker, machineBootId, selfIdentity } from "./worker-identity.js";

/** An output directory moved aside because a worker of uncertain identity may still hold it. */
export type QuarantinedDirectory = {
  job_id: number;
  from: string;
  to: string;
};

/** What one boot reconciliation did. Every field is something a `status` command can report. */
export type ReconcileOutcome = {
  /** The records the runner should hold in memory afterwards, including the untouched newer ones. */
  records: JobRecord[];
  /** Jobs rewritten to a terminal state on disk. */
  reconciled: number[];
  /** Jobs left `queued` or `running` because their owner is demonstrably still alive. */
  left: number[];
  /** Jobs reported terminal in memory but deliberately not rewritten, being newer than this build. */
  newerFormat: number[];
  /** Worker leaders that were positively identified and signalled. */
  killed: number[];
  /** Jobs whose output directory was moved aside. */
  quarantined: QuarantinedDirectory[];
  /** Files the store moved to `jobs/corrupt/` on the way in. */
  corrupt: string[];
};

/** What {@link reconcileJobs} needs that is not the store. */
export type ReconcileOptions = {
  /** The clock, injected so a test can assert an exact `finished_at`. */
  now?: () => Date;
  /** How long a recognised worker gets on `SIGTERM` before its group is killed. */
  killGraceMs?: number;
};

const DAEMON_RESTARTED: JobErrorCode = "daemon_restarted";

function isPending(record: JobRecord): boolean {
  return record.status === "queued" || record.status === "running";
}

/**
 * Move a job's output directory aside so a retry cannot collide with a possible survivor.
 *
 * The name carries the job id and the timestamp because the alternative — deleting it — throws away
 * the partial audio or video a user may want, and ADR 0024 §Consequences leaves "who owns the
 * partial artefacts a killed render leaves" to a later prune rather than to this moment.
 */
function quarantineOutputDirectory(record: JobRecord, at: Date): QuarantinedDirectory | null {
  const from = record.output_dir;
  if (from === null || !existsSync(from)) {
    return null;
  }
  const to = `${from}.quarantined-${record.job_id}-${at.getTime()}`;
  renameSync(from, to);
  return { job_id: record.job_id, from, to };
}

/**
 * Is the daemon that owned this record demonstrably still running?
 *
 * After ownership has been acquired this can only be false, which is why the check is cheap and
 * kept anyway: it states the condition ADR 0024 §Boot reconciliation actually writes, rather than
 * relying on the lock to have made it true, and it is the branch that stops a reconciler from
 * rewriting records out from under a daemon that is somehow still there.
 */
function ownerStillRunning(record: JobRecord, currentBootId: string | null): boolean {
  if (record.owner.pid === selfIdentity().pid) {
    // This process cannot be the owner of a record it has not written yet: ownership was acquired
    // moments ago, so a match here is pid reuse of a dead daemon by us, not a live one.
    return false;
  }
  return (
    classifyWorker(
      { pid: record.owner.pid, start_time: record.owner.start_time, boot_id: record.owner.boot_id },
      currentBootId,
    ) === "ours"
  );
}

/**
 * Read every record, terminate what cannot still be running, and report what was done.
 *
 * Returns the records the runner should start with, so the caller never re-reads the directory it
 * has just rewritten.
 */
export async function reconcileJobs(
  store: JobStore,
  options: ReconcileOptions = {},
): Promise<ReconcileOutcome> {
  const now = options.now ?? (() => new Date());
  const currentBootId = machineBootId();
  const loaded = store.load();
  const newerIds = new Set(loaded.newer);

  const outcome: ReconcileOutcome = {
    records: [],
    reconciled: [],
    left: [],
    newerFormat: [],
    killed: [],
    quarantined: [],
    corrupt: loaded.corrupt,
  };

  for (const record of loaded.records) {
    if (!isPending(record)) {
      outcome.records.push(record);
      continue;
    }

    if (newerIds.has(record.job_id)) {
      // Reported, never rewritten: the daemon that wrote this understands a format this one does
      // not, and a rollback has to find its state where it left it.
      const reported = terminalCopy(record, now(), [
        `[xplainer] this record is format_version ${record.format_version}; this daemon writes ` +
          `format_version ${JOB_RECORD_FORMAT_VERSION}. It is reported as daemon_restarted so the ` +
          "poll terminates, and left untouched on disk so a rollback still finds it.",
      ]);
      outcome.records.push(reported);
      outcome.newerFormat.push(record.job_id);
      continue;
    }

    if (ownerStillRunning(record, currentBootId)) {
      outcome.records.push(record);
      outcome.left.push(record.job_id);
      continue;
    }

    const lines: string[] = [
      `[xplainer] the daemon that owned this job (pid ${record.owner.pid}, run ${record.owner.run_id}) ` +
        "is gone; reconciled at boot.",
    ];
    let uncertain = false;

    for (const worker of record.workers) {
      const verdict = classifyWorker(worker, currentBootId);
      if (verdict === "ours") {
        const target: GroupTarget = { pid: worker.pid, pgid: worker.pgid };
        const teardown = await terminateGroup(target, options.killGraceMs);
        outcome.killed.push(worker.pid);
        lines.push(
          `[xplainer] worker pid ${worker.pid} matched the identity recorded for it and its process ` +
            `group was stopped (${teardown.signal ?? "already gone"}).`,
        );
        continue;
      }
      if (verdict === "stranger") {
        lines.push(
          `[xplainer] pid ${worker.pid} is alive but is not the worker recorded here — the number was ` +
            "reused. It was left alone.",
        );
        continue;
      }
      if (verdict === "uncertain") {
        uncertain = true;
        lines.push(
          `[xplainer] pid ${worker.pid} is alive and its identity could not be established, so it was ` +
            "left alone and this job is marked workers_uncertain.",
        );
      }
    }

    const at = now();
    const reconciled = terminalCopy(record, at, lines);
    reconciled.workers_uncertain = uncertain;

    if (uncertain) {
      const moved = quarantineOutputDirectory(reconciled, at);
      if (moved !== null) {
        outcome.quarantined.push(moved);
        reconciled.output_dir = moved.to;
        appendLogLine(
          reconciled,
          `[xplainer] the output directory was quarantined to ${moved.to} so a retry writes to a ` +
            "fresh one.",
        );
      }
    }

    store.put(reconciled);
    outcome.records.push(reconciled);
    outcome.reconciled.push(record.job_id);
  }

  return outcome;
}

/** The terminal shape ADR 0024 §Boot reconciliation names, as a copy rather than a mutation. */
function terminalCopy(record: JobRecord, at: Date, lines: readonly string[]): JobRecord {
  const copy: JobRecord = {
    ...record,
    status: "error",
    exit_code: null,
    error:
      "The daemon restarted while this job was in flight, so the work was lost. Retry the call.",
    error_code: DAEMON_RESTARTED,
    finished_at: at.toISOString(),
    log: [...record.log],
    workers: [...record.workers],
  };
  for (const line of lines) {
    appendLogLine(copy, line);
  }
  return copy;
}
