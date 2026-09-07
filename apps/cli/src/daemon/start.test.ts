/**
 * The start-up ordering, proved with real processes.
 *
 * Three of this story's claims are not properties of a function, they are properties of a
 * **process**, and a single-process test cannot make them:
 *
 * - a second `xplainer serve` exits `10` **having written nothing** — which needs a first `serve`
 *   that is genuinely running and a second that genuinely exits;
 * - a record is durable the instant `enqueue()` returns — which needs a `SIGKILL` between that
 *   return and anything else;
 * - a daemon killed mid-render leaves a `running` record with a live orphan attached, and the next
 *   boot turns it into a terminal, explained answer and stops the orphan.
 *
 * So the children here are real: `testing/child-serve.ts` runs the command tree, and
 * `testing/child-daemon.ts` runs a daemon that kills itself. Both are started by
 * `testing/spawn-child.ts` through `testing/ts-source-hook.ts` rather than from `dist/`, so the
 * suite asserts the sources being edited and needs no build (see that file).
 */

import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { OWNERSHIP_REFUSED_EXIT_CODE } from "./exit-codes.js";
import { createJobStore } from "./job-store.js";
import { describeReconciliation, type StartedDaemon, startDaemon } from "./start.js";
import { stateDirLayout } from "./state-dir.js";
import { fakeWorkerRegistry } from "./testing/fake-worker.js";
import {
  CHILD_DAEMON,
  CHILD_SERVE,
  type SpawnedChild,
  spawnEntry,
  untilGone,
} from "./testing/spawn-child.js";
import { isAlive } from "./worker-identity.js";

const scratch: string[] = [];
const children: ChildProcess[] = [];
const daemons: StartedDaemon[] = [];
/** Worker groups a failing test might otherwise leave behind for two minutes. */
const strays: number[] = [];

function stateDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "xplainer-start-"));
  scratch.push(dir);
  return dir;
}

/** Spawn a child entry and register it for teardown, so no test can leave a daemon behind. */
function run(entry: string, args: readonly string[], env: Record<string, string>): SpawnedChild {
  const child = spawnEntry(entry, args, env);
  children.push(child.process);
  return child;
}

/** Size, mtime and content hash of every file under `dir`: the evidence a refusal wrote nothing. */
function snapshot(dir: string): string {
  const entries: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        entries.push(`${relative(dir, path)}/`);
        walk(path);
      } else if (entry.isFile()) {
        const stat = statSync(path);
        const digest = createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
        entries.push(
          `${relative(dir, path)} size=${stat.size} mtimeMs=${stat.mtimeMs} sha256:${digest}`,
        );
      }
    }
  };
  walk(dir);
  return entries.sort().join(" | ");
}

afterEach(async () => {
  for (const daemon of daemons.splice(0)) {
    await daemon.close();
  }
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  for (const pid of strays.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Gone already, which is what these tests are mostly asserting.
    }
  }
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("a second xplainer serve", () => {
  it(`exits ${OWNERSHIP_REFUSED_EXIT_CODE} and writes nothing while the first one holds the directory`, async () => {
    const stateDir = stateDirectory();
    const first = run(CHILD_SERVE, ["--port", "0"], { XPLAINER_STATE_DIR: stateDir });
    await first.waitForLine("listening on");
    const before = snapshot(stateDir);

    const second = run(CHILD_SERVE, ["--port", "0"], { XPLAINER_STATE_DIR: stateDir });
    const exit = await second.waitForExit();

    expect(exit.code).toBe(OWNERSHIP_REFUSED_EXIT_CODE);
    expect(second.stderr()).toContain("already owns");
    expect(second.stdout()).toBe("");
    // Byte for byte, the same directory: no reconciliation, no rewrite, no signal sent.
    expect(snapshot(stateDir)).toBe(before);
    expect(first.process.exitCode).toBeNull();
  });

  it("records the port and the crash history in daemon.json, and the run in runtime.json", async () => {
    const stateDir = stateDirectory();
    const serving = run(CHILD_SERVE, ["--port", "0"], { XPLAINER_STATE_DIR: stateDir });
    await serving.waitForLine("listening on");

    const layout = stateDirLayout(stateDir);
    const daemonJson = JSON.parse(readFileSync(layout.daemonState, "utf8")) as Record<
      string,
      unknown
    >;
    const runtimeJson = JSON.parse(readFileSync(layout.runtimeState, "utf8")) as Record<
      string,
      unknown
    >;

    expect(Object.keys(daemonJson)).toContain("recentStarts");
    expect(Object.keys(daemonJson)).toContain("port");
    // ADR 0024 §Consequences moved the crash history out of runtime.json, which systemd deletes on
    // every clean stop; this is the assertion that keeps it out.
    expect(Object.keys(runtimeJson)).not.toContain("recentStarts");
    expect(Object.keys(runtimeJson)).not.toContain("stalled");
    expect(runtimeJson.pid).toBe(serving.process.pid);
    expect(readdirSync(layout.jobs)).toEqual([]);
  });

  it("exits 0 rather than restarting for ever once the circuit breaker is latched", async () => {
    const stateDir = stateDirectory();
    writeFileSync(
      join(stateDir, "daemon.json"),
      JSON.stringify({
        format_version: 1,
        stalled: { at: "2026-09-06T00:00:00.000Z", reason: "five failed starts in a row" },
      }),
    );

    const serving = run(CHILD_SERVE, ["--port", "0"], { XPLAINER_STATE_DIR: stateDir });
    const exit = await serving.waitForExit();

    expect(exit.code).toBe(0);
    expect(serving.stderr()).toContain("stalled since");
  });

  it("exits 11 when daemon.json cannot be read", async () => {
    const stateDir = stateDirectory();
    writeFileSync(join(stateDir, "daemon.json"), "{ half a state file");

    const serving = run(CHILD_SERVE, ["--port", "0"], { XPLAINER_STATE_DIR: stateDir });
    const exit = await serving.waitForExit();

    expect(exit.code).toBe(11);
    expect(serving.stderr()).toContain("cannot be read as JSON");
  });
});

describe("a daemon killed the instant a job is enqueued", () => {
  it("leaves the record on disk, and the next boot answers with a terminal state", async () => {
    const stateDir = stateDirectory();
    const child = run(CHILD_DAEMON, ["enqueue-then-kill"], {
      XPLAINER_STATE_DIR: stateDir,
      XPLAINER_TEST_WORKER: JSON.stringify({ lines: 1, lifeMs: 60_000 }),
    });
    const announced = await child.waitForLine('"event":"enqueued"');
    const jobId = (JSON.parse(announced) as { job_id: number }).job_id;
    const exit = await child.waitForExit();

    expect(exit.signal).toBe("SIGKILL");
    // The claim under test: whatever `enqueue()` returned an id for is on disk, with no daemon left
    // to have written it afterwards.
    expect(createJobStore(stateDir).read(jobId)?.job_id).toBe(jobId);

    const outcome = await startDaemon({ stateDir, workers: fakeWorkerRegistry() });
    expect(outcome.started).toBe(true);
    if (outcome.started) {
      daemons.push(outcome.daemon);
      // Never a 404 — `get` would raise `JobNotFoundError` — and never a `running` that an agent
      // would poll for ever.
      const job = outcome.daemon.runner.get({ job_id: jobId });
      expect(job.status).toBe("error");
      expect(job.status).not.toBe("running");
      expect(job.error_code).toBe("daemon_restarted");
      expect(job.finished_at).not.toBeNull();
    }
  });
});

describe("a daemon killed while a job is running", () => {
  it("reconciles the record, bounds its log tail, and stops the orphaned worker", async () => {
    const stateDir = stateDirectory();
    const child = run(CHILD_DAEMON, ["run-and-wait"], {
      XPLAINER_STATE_DIR: stateDir,
      XPLAINER_TEST_WORKER: JSON.stringify({ lines: 3, lifeMs: 120_000, grandchild: true }),
    });
    const announced = await child.waitForLine('"event":"running"');
    const { job_id: jobId, worker_pid: workerPid } = JSON.parse(announced) as {
      job_id: number;
      worker_pid: number;
    };
    strays.push(workerPid);

    child.process.kill("SIGKILL");
    expect((await child.waitForExit()).signal).toBe("SIGKILL");
    expect(isAlive(workerPid)).toBe(true);
    const abandoned = createJobStore(stateDir).read(jobId);
    expect(abandoned?.status).toBe("running");
    const announcedGrandchild = abandoned?.log.find((line) => line.startsWith("grandchild "));
    const grandchild = Number((announcedGrandchild ?? "").replace("grandchild ", ""));
    expect(isAlive(grandchild)).toBe(true);

    const outcome = await startDaemon({
      stateDir,
      workers: fakeWorkerRegistry(),
      killGraceMs: 500,
    });
    expect(outcome.started).toBe(true);
    if (outcome.started) {
      daemons.push(outcome.daemon);
      const { runner, reconciliation } = outcome.daemon;

      expect(reconciliation.reconciled).toEqual([jobId]);
      expect(reconciliation.killed).toEqual([workerPid]);
      expect(await untilGone(workerPid)).toBe(true);
      // The group, not the leader: the browser and the encoder a render starts are the expensive
      // half, and this stands in for them.
      expect(await untilGone(grandchild)).toBe(true);

      // Never a 404 — `get` raises `JobNotFoundError` for an id it has no record of — and never a
      // `running` an agent would poll for ever.
      const job = runner.get({ job_id: jobId, output_lines: 60 });
      expect(job.status).toBe("error");
      expect(job.status).not.toBe("running");
      expect(job.error_code).toBe("daemon_restarted");
      expect(job.exit_code).toBeNull();
      expect(job.finished_at).not.toBeNull();
      // The tail the worker had written before the kill survived, which is the difference between
      // "a bounded log tail" and "an empty one".
      expect(job.output.lines).toContain("line 1");
      expect(job.output.lines.join(" ")).toContain("reconciled at boot");
      expect(runner.get({ job_id: jobId, output_lines: 2 }).output.lines).toHaveLength(2);
    }
  });
});

describe("describeReconciliation", () => {
  it("says nothing when a boot found nothing to reconcile", () => {
    expect(
      describeReconciliation({
        records: [],
        reconciled: [],
        left: [],
        newerFormat: [],
        killed: [],
        quarantined: [],
        corrupt: [],
      }),
    ).toEqual([]);
  });

  it("names every kind of thing it did, so a start-up log explains itself", () => {
    const lines = describeReconciliation({
      records: [],
      reconciled: [1, 2],
      left: [],
      newerFormat: [3],
      killed: [4242],
      quarantined: [{ job_id: 1, from: "/videos/a", to: "/videos/a.quarantined-1-0" }],
      corrupt: ["job-000009.json"],
    }).join("\n");

    expect(lines).toContain("reconciled 2 job(s)");
    expect(lines).toContain("stopped 1 orphaned worker process group(s)");
    expect(lines).toContain("/videos/a.quarantined-1-0");
    expect(lines).toContain("job-000009.json");
    expect(lines).toContain("written by a newer daemon untouched");
  });
});
