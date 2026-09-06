/**
 * A daemon in a child process, so a test can kill it the way an OOM killer does.
 *
 * `SIGKILL` cannot be delivered to the Vitest worker without taking the suite with it, and the two
 * properties this entry exists for are only true of a process that dies without warning:
 *
 * - **`enqueue-then-kill`** — enqueue a job, print its id once {@link JobRunner.enqueue} has
 *   returned (which ADR 0024 §Durability of the write itself makes the moment the record is
 *   durable), and immediately `SIGKILL` this process. Whatever it printed must be on disk
 *   afterwards.
 * - **`run-and-wait`** — start a long fake worker, wait until the record says `running` and its log
 *   has reached the disk, print the job id and the worker's pid, and then stay alive until the
 *   parent kills it. What is left behind is a `running` record with a live, correctly identified
 *   orphan attached to it, which is the input boot reconciliation is written against.
 *
 * It is run as `node --import ./ts-source-hook.ts child-daemon.ts <mode>`; see that hook for why.
 * The state directory comes from `XPLAINER_STATE_DIR` and the fake worker's shape from
 * `XPLAINER_TEST_WORKER`, so the parent controls both without argument quoting.
 */

import process from "node:process";
import { createJobStore } from "../job-store.js";
import { startDaemon } from "../start.js";
import { type FakeWorkerConfig, fakeWorkerRegistry } from "./fake-worker.js";

function say(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

const [mode] = process.argv.slice(2);
const stateDir = process.env.XPLAINER_STATE_DIR;
const workerConfig = JSON.parse(process.env.XPLAINER_TEST_WORKER ?? "{}") as FakeWorkerConfig;

if (stateDir === undefined) {
  process.stderr.write("child-daemon: XPLAINER_STATE_DIR is required\n");
  process.exitCode = 2;
} else {
  const outcome = await startDaemon({
    stateDir,
    workers: fakeWorkerRegistry(workerConfig),
    // Short enough that a log tail reaches the disk before the parent kills this process, which is
    // the difference between proving "a bounded log tail" and proving "an empty one".
    logFlushIntervalMs: 50,
  });

  if (!outcome.started) {
    say({ event: "refused", exit_code: outcome.exitCode, message: outcome.message });
    process.exitCode = outcome.exitCode;
  } else if (mode === "enqueue-then-kill") {
    const jobId = await outcome.daemon.runner.enqueue({
      job_type: "explainer_render",
      video_id: "how-dns-works",
    });
    say({ event: "enqueued", job_id: jobId });
    process.kill(process.pid, "SIGKILL");
  } else if (mode === "run-and-wait") {
    const store = createJobStore(stateDir);
    const jobId = await outcome.daemon.runner.enqueue({
      job_type: "explainer_render",
      video_id: "how-dns-works",
      output_dir: process.env.XPLAINER_TEST_OUTPUT_DIR ?? null,
    });
    let workerPid: number | null = null;
    while (workerPid === null) {
      await sleep(20);
      const persisted = store.read(jobId);
      const worker = persisted?.workers[0];
      if (persisted?.status === "running" && worker !== undefined && persisted.log.length > 0) {
        workerPid = worker.pid;
      }
    }
    say({ event: "running", job_id: jobId, worker_pid: workerPid });
    // A registered signal handler is not enough to hold the event loop open: a process parked on a
    // settled top-level await exits 13 the moment the loop drains. An interval is a real handle,
    // and it is bounded so a stray child can never outlive the run that spawned it.
    let ticks = 0;
    const heartbeat = setInterval(() => {
      ticks += 1;
      if (ticks > 600) {
        clearInterval(heartbeat);
      }
    }, 100);
  } else {
    process.stderr.write(`child-daemon: unknown mode ${String(mode)}\n`);
    process.exitCode = 2;
  }
}
