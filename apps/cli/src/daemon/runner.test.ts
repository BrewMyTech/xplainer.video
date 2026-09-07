/**
 * The five things above the job store, against a worker that is a `node -e` script.
 *
 * The properties asserted here are the contract's, not the implementation's: that `enqueue` does not
 * hand back an id until the record is on disk (ADR 0024 §Durability of the write itself), that an
 * agent polling `explainer_job` sees `queued → running → done` in that order (roadmap P1-5), that
 * `output_lines` bounds the tail (ADR 0008), that cancelling takes the worker's whole process group
 * with it (ADR 0024 §Scope), and that a drain leaves nothing `queued` or `running` behind
 * (ADR 0024 §Drain on planned restart).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobState } from "@xplainer/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createJobStore, type JobRecord, type JobStore } from "./job-store.js";
import {
  createJobRunner,
  JobNotFoundError,
  type JobRunner,
  NotAcceptingJobsError,
} from "./runner.js";
import {
  type FakeWorkerConfig,
  fakeWorkerRegistry,
  fakeWorkerSpec,
} from "./testing/fake-worker.js";
import { isAlive, selfIdentity } from "./worker-identity.js";

const scratch: string[] = [];
const started: JobRunner[] = [];

function stateDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "xplainer-runner-"));
  scratch.push(dir);
  return dir;
}

function runnerOn(
  config: FakeWorkerConfig = {},
  overrides: { workers?: ReturnType<typeof fakeWorkerRegistry> } = {},
): { runner: JobRunner; store: JobStore } {
  const store = createJobStore(stateDirectory());
  const runner = createJobRunner({
    store,
    owner: { ...selfIdentity(), run_id: "a-test-run" },
    workers: overrides.workers ?? fakeWorkerRegistry(config),
    logFlushIntervalMs: 25,
    killGraceMs: 200,
  });
  started.push(runner);
  return { runner, store };
}

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise<void>((done) => {
      setTimeout(done, 10);
    });
  }
  return false;
}

afterEach(async () => {
  // Drain before the directories go: a runner with a job still queued would otherwise start it
  // after the test ended and write a record into a directory that no longer exists.
  for (const runner of started.splice(0)) {
    await runner.drain(0);
  }
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("enqueue", () => {
  it("returns the id only once the record is on disk", async () => {
    const { runner, store } = runnerOn({ lines: 1 });

    const jobId = await runner.enqueue({ job_type: "explainer_render", video_id: "how-dns-works" });

    // Read the file rather than the runner's memory: this is the assertion that a `SIGKILL` on the
    // next line could not lose the job the caller now holds an id for.
    const persisted = JSON.parse(readFileSync(store.pathOf(jobId), "utf8")) as JobRecord;
    expect(persisted.job_id).toBe(jobId);
    expect(persisted.status).toBe("queued");
    expect(persisted.video_id).toBe("how-dns-works");
    expect(runner.get({ job_id: jobId }).status).toBe("queued");
  });

  it("numbers jobs from one and keeps them apart", async () => {
    const { runner } = runnerOn({ lines: 1 });

    const first = await runner.enqueue({ job_type: "explainer_still" });
    const second = await runner.enqueue({ job_type: "explainer_render" });

    expect([first, second]).toEqual([1, 2]);
    expect(runner.get({ job_id: first }).job_type).toBe("explainer_still");
  });
});

describe("polling a job", () => {
  it("shows queued, then running, then done", async () => {
    const { runner } = runnerOn({ lines: 2, lifeMs: 150 });
    const seen: JobState[] = [];

    const jobId = await runner.enqueue({ job_type: "explainer_render" });
    const record = (): JobState => {
      const status = runner.get({ job_id: jobId }).status;
      if (seen.at(-1) !== status) {
        seen.push(status);
      }
      return status;
    };

    expect(await until(() => record() === "done")).toBe(true);
    expect(seen).toEqual(["queued", "running", "done"]);
    expect(runner.get({ job_id: jobId }).exit_code).toBe(0);
    expect(runner.get({ job_id: jobId }).error_code).toBeNull();
    expect(runner.get({ job_id: jobId }).finished_at).not.toBeNull();
  });

  it("bounds the returned tail by output_lines", async () => {
    const { runner } = runnerOn({ lines: 50 });

    const jobId = await runner.enqueue({ job_type: "explainer_render" });
    await until(() => runner.get({ job_id: jobId }).status === "done");
    await until(() => runner.get({ job_id: jobId, output_lines: 60 }).output.lines.length >= 50);

    expect(runner.get({ job_id: jobId, output_lines: 3 }).output.lines).toEqual([
      "line 48",
      "line 49",
      "line 50",
    ]);
    expect(runner.tail(jobId, 2)).toEqual(["line 49", "line 50"]);
  });

  it("captures stderr alongside stdout", async () => {
    const { runner } = runnerOn({ lines: 1, stderrLines: 1 });

    const jobId = await runner.enqueue({ job_type: "explainer_render" });
    await until(() => runner.get({ job_id: jobId }).status === "done");
    await until(() => runner.get({ job_id: jobId }).output.lines.includes("stderr 1"));

    expect(runner.get({ job_id: jobId }).output.lines).toContain("line 1");
    expect(runner.get({ job_id: jobId }).output.lines).toContain("stderr 1");
  });

  it("raises for an id it has never seen, rather than inventing one", () => {
    const { runner } = runnerOn();

    expect(() => runner.get({ job_id: 404 })).toThrow(JobNotFoundError);
  });
});

describe("a worker that fails", () => {
  it("becomes error with the exit code and the failure class of its kind", async () => {
    const { runner } = runnerOn({ exitCode: 3 });

    const render = await runner.enqueue({ job_type: "explainer_render" });
    const narrate = await runner.enqueue({ job_type: "explainer_narrate" });
    await until(() => runner.get({ job_id: narrate }).status === "error");

    expect(runner.get({ job_id: render }).status).toBe("error");
    expect(runner.get({ job_id: render }).exit_code).toBe(3);
    expect(runner.get({ job_id: render }).error_code).toBe("render_failed");
    expect(runner.get({ job_id: narrate }).error_code).toBe("tts_failed");
  });

  it("fails honestly when no worker is registered for the kind", async () => {
    const { runner } = runnerOn({}, { workers: { explainer_render: () => fakeWorkerSpec() } });

    const jobId = await runner.enqueue({ job_type: "explainer_narrate" });
    await until(() => runner.get({ job_id: jobId }).status === "error");

    const job = runner.get({ job_id: jobId });
    expect(job.error_code).toBe("internal");
    expect(job.error).toContain("explainer_narrate");
    expect(job.output.lines.join(" ")).toContain("no worker is registered");
  });

  it("reports a command that cannot be started instead of hanging", async () => {
    const { runner } = runnerOn(
      {},
      {
        workers: {
          explainer_render: () => ({
            command: join(tmpdir(), "definitely-not-a-command"),
            args: [],
          }),
        },
      },
    );

    const jobId = await runner.enqueue({ job_type: "explainer_render" });
    await until(() => runner.get({ job_id: jobId }).status === "error");

    expect(runner.get({ job_id: jobId }).error_code).toBe("internal");
  });
});

describe("cancel", () => {
  it("tears down the worker's whole process group", async () => {
    const { runner } = runnerOn({ lines: 1, lifeMs: 60_000, grandchild: true });

    const jobId = await runner.enqueue({ job_type: "explainer_render" });
    expect(
      await until(() =>
        runner.get({ job_id: jobId }).output.lines.some((line) => line.startsWith("grandchild ")),
      ),
    ).toBe(true);
    const announced = runner
      .get({ job_id: jobId })
      .output.lines.find((line) => line.startsWith("grandchild "));
    const grandchild = Number((announced ?? "").replace("grandchild ", ""));
    expect(isAlive(grandchild)).toBe(true);

    expect(await runner.cancel(jobId)).toBe(true);

    expect(runner.get({ job_id: jobId }).status).toBe("cancelled");
    expect(runner.get({ job_id: jobId }).error_code).toBe("cancelled");
    // The leader alone would have left this one behind, which is the orphaned Chrome ADR 0024 names.
    expect(await until(() => !isAlive(grandchild))).toBe(true);
  });

  it("cancels a job that has not started yet", async () => {
    const { runner, store } = runnerOn({ lines: 1, lifeMs: 5_000 });
    const first = await runner.enqueue({ job_type: "explainer_render" });
    const second = await runner.enqueue({ job_type: "explainer_render" });
    await until(() => runner.get({ job_id: first }).status === "running");

    expect(await runner.cancel(second)).toBe(true);

    expect(runner.get({ job_id: second }).status).toBe("cancelled");
    expect(runner.get({ job_id: second }).started_at).toBeNull();
    expect(store.read(second)?.status).toBe("cancelled");
    await runner.drain(0);
  });

  it("is false for a job that has already finished", async () => {
    const { runner } = runnerOn({ lines: 1 });
    const jobId = await runner.enqueue({ job_type: "explainer_render" });
    await until(() => runner.get({ job_id: jobId }).status === "done");

    expect(await runner.cancel(jobId)).toBe(false);
  });
});

describe("drain", () => {
  it("stops the running job and marks everything queued daemon_shutdown", async () => {
    const { runner, store } = runnerOn({ lines: 1, lifeMs: 60_000 });
    const running = await runner.enqueue({ job_type: "explainer_render" });
    const waiting = await runner.enqueue({ job_type: "explainer_still" });
    expect(await until(() => runner.get({ job_id: running }).status === "running")).toBe(true);
    const workerPid = store.read(running)?.workers[0]?.pid ?? 0;

    await runner.drain(50);

    expect(runner.get({ job_id: running }).status).toBe("error");
    expect(runner.get({ job_id: running }).error_code).toBe("daemon_shutdown");
    expect(runner.get({ job_id: waiting }).status).toBe("error");
    expect(runner.get({ job_id: waiting }).error_code).toBe("daemon_shutdown");
    expect(await until(() => !isAlive(workerPid))).toBe(true);
    expect(store.read(waiting)?.error_code).toBe("daemon_shutdown");
  });

  it("lets a job that finishes inside the budget finish", async () => {
    const { runner } = runnerOn({ lines: 1, lifeMs: 50 });
    const jobId = await runner.enqueue({ job_type: "explainer_render" });
    await until(() => runner.get({ job_id: jobId }).status === "running");

    await runner.drain(5_000);

    expect(runner.get({ job_id: jobId }).status).toBe("done");
  });

  it("refuses new work afterwards", async () => {
    const { runner } = runnerOn({ lines: 1 });

    await runner.drain(0);

    await expect(runner.enqueue({ job_type: "explainer_render" })).rejects.toBeInstanceOf(
      NotAcceptingJobsError,
    );
  });
});

/**
 * `WorkerSpec.release` is how the per-video write lock of `daemon/video-lock.ts` reaches the one
 * place every terminal outcome passes through. What matters is not that it is *called* but that it
 * is called on **every** path a job can end on — a lock a crashed render never gave back would
 * refuse that video for the life of the daemon, which is worse than the race it exists to prevent.
 */
describe("what a factory took, given back when the job ends", () => {
  /** A fake registry whose specs carry a release recorder. */
  function registryWithRelease(
    config: FakeWorkerConfig,
    released: number[],
  ): ReturnType<typeof fakeWorkerRegistry> {
    const inner = fakeWorkerRegistry(config);
    const wrap = (jobType: keyof typeof inner) => (record: JobRecord) => {
      const spec = inner[jobType]?.(record);
      if (spec === undefined) {
        throw new Error(`the fake registry has no ${String(jobType)}`);
      }
      return {
        ...spec,
        release: (): void => {
          released.push(record.job_id);
        },
      };
    };
    return {
      explainer_render: wrap("explainer_render"),
      explainer_still: wrap("explainer_still"),
      explainer_narrate: wrap("explainer_narrate"),
    };
  }

  it("releases once when the worker exits cleanly", async () => {
    const released: number[] = [];
    const { runner } = runnerOn({}, { workers: registryWithRelease({ lines: 1 }, released) });
    const jobId = await runner.enqueue({ job_type: "explainer_render", video_id: "demo" });

    expect(await until(() => runner.get({ job_id: jobId }).status === "done")).toBe(true);
    expect(released).toEqual([jobId]);
  });

  it("releases when the worker fails", async () => {
    const released: number[] = [];
    const { runner } = runnerOn(
      {},
      { workers: registryWithRelease({ lines: 1, exitCode: 3 }, released) },
    );
    const jobId = await runner.enqueue({ job_type: "explainer_render", video_id: "demo" });

    expect(await until(() => runner.get({ job_id: jobId }).status === "error")).toBe(true);
    expect(released).toEqual([jobId]);
  });

  it("releases when the job is cancelled", async () => {
    const released: number[] = [];
    const { runner } = runnerOn(
      {},
      { workers: registryWithRelease({ lines: 1, lifeMs: 60_000 }, released) },
    );
    const jobId = await runner.enqueue({ job_type: "explainer_render", video_id: "demo" });
    expect(await until(() => runner.get({ job_id: jobId }).status === "running")).toBe(true);

    await runner.cancel(jobId);

    expect(await until(() => released.length === 1)).toBe(true);
    expect(runner.get({ job_id: jobId }).status).toBe("cancelled");
  });

  it("releases when the daemon drains out from under a running job", async () => {
    const released: number[] = [];
    const { runner } = runnerOn(
      {},
      { workers: registryWithRelease({ lines: 1, lifeMs: 60_000 }, released) },
    );
    const jobId = await runner.enqueue({ job_type: "explainer_render", video_id: "demo" });
    expect(await until(() => runner.get({ job_id: jobId }).status === "running")).toBe(true);

    await runner.drain(50);

    expect(released).toEqual([jobId]);
    expect(runner.get({ job_id: jobId }).error_code).toBe("daemon_shutdown");
  });
});

describe("the state directory", () => {
  it("keeps one file per job under jobs/", async () => {
    const { runner, store } = runnerOn({ lines: 1 });

    const jobId = await runner.enqueue({ job_type: "explainer_render" });

    expect(existsSync(join(store.paths.jobs, "job-000001.json"))).toBe(true);
    expect(store.pathOf(jobId).startsWith(store.paths.jobs)).toBe(true);
  });
});
