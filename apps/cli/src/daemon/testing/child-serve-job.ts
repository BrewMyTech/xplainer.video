/**
 * `xplainer serve` with one long job already running when it announces readiness.
 *
 * The `SIGTERM` drain is a property of the **process**: ADR 0024 §Drain on planned restart is six
 * steps between a signal and exit `0`, and the only honest way to assert them is to signal a real
 * `serve` that really has a worker under it. In this phase nothing else can put one there — the
 * three job-shaped tools are still served from the stub backend, so no request reaches the runner —
 * which leaves exactly two gaps: a worker this machine can run without Remotion or a TTS server,
 * and a way to start one. `fake-worker.ts` fills the first; this entry fills the second, through
 * the `ServeSeams` that `program.ts` never passes.
 *
 * **What it does not change is the daemon.** The command is the one `createServeCommand()` builds
 * for the binary, with the real token, the real guard, the real state files, the real shutdown
 * handlers and the real ready line; the seams add a worker registry and a callback, and nothing
 * else. In particular the drain timeout is the shipped 20 s, because a test that shortened it would
 * assert a number no supervisor will ever use.
 *
 * **Everything it says goes to stderr.** ADR 0025 §Part three makes stdout the ready line and
 * nothing else, so the `{"event":"job",…}` line a test reads to learn the job id and the worker's
 * pid must not go there — a child that announced its job on stdout would break the very contract
 * the sibling test asserts.
 */

import process from "node:process";
import { createServeCommand } from "../../commands/serve.js";
import { processIo } from "../../io.js";
import { createJobStore } from "../job-store.js";
import { type FakeWorkerConfig, fakeWorkerRegistry } from "./fake-worker.js";

/** How long to wait for the enqueued job to actually be running before announcing readiness. */
const RUNNING_TIMEOUT_MS = 10_000;

function say(event: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

const workerConfig = JSON.parse(process.env.XPLAINER_TEST_WORKER ?? "{}") as FakeWorkerConfig;

const command = createServeCommand(processIo, {
  workers: fakeWorkerRegistry(workerConfig),
  // Called after both state files are written and before the ready line, so a parent that reads
  // `{"event":"ready"}` is looking at a daemon whose job is already `running` — which is what makes
  // the drain assertion about a drain rather than about a race with one.
  onListening: async (daemon) => {
    const store = createJobStore(daemon.stateDir);
    const jobId = await daemon.runner.enqueue({
      job_type: "explainer_render",
      video_id: "how-dns-works",
    });
    const deadline = Date.now() + RUNNING_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const record = store.read(jobId);
      const worker = record?.workers[0];
      if (record?.status === "running" && worker !== undefined && record.log.length > 0) {
        say({ event: "job", job_id: jobId, worker_pid: worker.pid });
        return;
      }
      await sleep(20);
    }
    say({ event: "job_never_ran", job_id: jobId });
    processIo.exit(70);
  },
});

await command.parseAsync(process.argv.slice(2), { from: "user" });
