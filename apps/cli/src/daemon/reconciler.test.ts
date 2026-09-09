/**
 * What a boot does to the records the last run left behind.
 *
 * Every case here is a sentence from ADR 0024, and the two that are easiest to get wrong are the
 * pair around identity: a live pid whose token **differs** is a positively identified stranger and
 * is left alone *with certainty*, while a live pid whose token **cannot be read** is the uncertain
 * case that sets `workers_uncertain` and quarantines the output directory. Both branches are
 * asserted, because the record requires both and they differ only in what could be proven.
 *
 * Every case here runs on all three platforms and none of them is conditional, which was not true
 * before 2026-09-09: `worker-identity.ts` read no start token on Windows, so a live pid there was
 * always `uncertain` and the two cases below that turn on a token — the kill and the stranger —
 * could not have passed. They were never run there to find out. `daemon-windows.yml` now runs this
 * file on `windows-latest`, and the token a case records as "somebody else's" comes from
 * {@link foreignStartToken} so that it is the shape this machine really produces.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { createJobStore } from "./job-store.js";
import { reconcileJobs } from "./reconciler.js";
import { foreignStartToken } from "./testing/platform.js";
import { deadOwner, exitedPid, makeJobRecord } from "./testing/records.js";
import { untilGone } from "./testing/spawn-child.js";
import { identify, isAlive, machineBootId, selfIdentity } from "./worker-identity.js";

/**
 * How long a case that records a real worker's identity is given.
 *
 * Vitest's default of 5 s is a macOS number: the identity probe there is a `ps` at about 4.5 ms.
 * On Windows the same probe is a `powershell.exe` start, so a case that records one worker and then
 * reconciles it pays two of them in seconds rather than milliseconds, and the default would fail it
 * for the machine rather than for the code.
 */
const PROBE_BUDGET_MS = 30_000;

const scratch: string[] = [];
const strays: number[] = [];

function stateDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "xplainer-reconcile-"));
  scratch.push(dir);
  return dir;
}

/** A detached sleeper standing in for an orphaned worker of a daemon that is gone. */
function orphanWorker(): { pid: number } {
  const child = spawn(process.execPath, ["-e", "setInterval(function () {}, 1000);"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const pid = child.pid ?? 0;
  strays.push(pid);
  return { pid };
}

afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone, which is what most of these tests are asserting.
    }
  }
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("reconcileJobs", () => {
  it("turns a running job whose daemon is gone into error/daemon_restarted with a log line", async () => {
    const store = createJobStore(stateDirectory());
    store.put(
      makeJobRecord({
        job_id: 1,
        status: "running",
        started_at: "2026-09-06T00:00:00.000Z",
        owner: deadOwner(exitedPid()),
      }),
    );

    const outcome = await reconcileJobs(store, { now: () => new Date("2026-09-06T01:00:00.000Z") });

    expect(outcome.reconciled).toEqual([1]);
    const record = store.read(1);
    expect(record?.status).toBe("error");
    expect(record?.error_code).toBe("daemon_restarted");
    expect(record?.exit_code).toBeNull();
    expect(record?.finished_at).toBe("2026-09-06T01:00:00.000Z");
    expect(record?.workers_uncertain).toBe(false);
    expect(record?.log.at(-1)).toContain("reconciled at boot");
  });

  it("reconciles a queued job too, because a stuck narrate is the same failure as a stuck render", async () => {
    const store = createJobStore(stateDirectory());
    store.put(
      makeJobRecord({ job_id: 4, job_type: "explainer_narrate", owner: deadOwner(exitedPid()) }),
    );

    await reconcileJobs(store);

    expect(store.read(4)?.status).toBe("error");
    expect(store.read(4)?.error_code).toBe("daemon_restarted");
  });

  it("leaves a terminal record exactly as it found it", async () => {
    const store = createJobStore(stateDirectory());
    store.put(
      makeJobRecord({ job_id: 2, status: "done", finished_at: "2026-09-06T00:00:00.000Z" }),
    );
    const before = readFileSync(store.pathOf(2), "utf8");

    const outcome = await reconcileJobs(store);

    expect(outcome.reconciled).toEqual([]);
    expect(readFileSync(store.pathOf(2), "utf8")).toBe(before);
  });

  it(
    "leaves a running job alone while its owning daemon is demonstrably alive",
    async () => {
      const store = createJobStore(stateDirectory());
      const owner = { ...identify(orphanWorker().pid), run_id: "a-live-daemon" };
      store.put(makeJobRecord({ job_id: 3, status: "running", owner }));

      const outcome = await reconcileJobs(store);

      expect(outcome.left).toEqual([3]);
      expect(store.read(3)?.status).toBe("running");
    },
    PROBE_BUDGET_MS,
  );

  it(
    "kills a worker whose identity tuple matches the record",
    async () => {
      const store = createJobStore(stateDirectory());
      const worker = orphanWorker();
      store.put(
        makeJobRecord({
          job_id: 5,
          status: "running",
          owner: deadOwner(exitedPid()),
          workers: [{ ...identify(worker.pid), pgid: worker.pid }],
        }),
      );

      const outcome = await reconcileJobs(store, { killGraceMs: 200 });

      expect(outcome.killed).toEqual([worker.pid]);
      expect(await untilGone(worker.pid)).toBe(true);
      expect(store.read(5)?.workers_uncertain).toBe(false);
      expect(store.read(5)?.log.join(" ")).toContain("its process group was stopped");
    },
    PROBE_BUDGET_MS,
  );

  it(
    "leaves a stranger alone, with certainty, and does not quarantine anything",
    async () => {
      const stateDir = stateDirectory();
      const store = createJobStore(stateDir);
      const worker = orphanWorker();
      const outputDir = join(stateDir, "videos", "how-dns-works");
      mkdirSync(outputDir, { recursive: true });
      store.put(
        makeJobRecord({
          job_id: 6,
          status: "running",
          output_dir: outputDir,
          owner: deadOwner(exitedPid()),
          // The pid is alive, and the token says it is somebody else: pid reuse, positively decided.
          workers: [{ ...identify(worker.pid), start_time: foreignStartToken(), pgid: worker.pid }],
        }),
      );

      const outcome = await reconcileJobs(store);

      expect(outcome.killed).toEqual([]);
      expect(outcome.quarantined).toEqual([]);
      expect(isAlive(worker.pid)).toBe(true);
      expect(store.read(6)?.workers_uncertain).toBe(false);
      expect(store.read(6)?.log.join(" ")).toContain("the number was reused");
      expect(existsSync(outputDir)).toBe(true);
    },
    PROBE_BUDGET_MS,
  );

  it("marks workers_uncertain and quarantines the output directory when identity cannot be read", async () => {
    const stateDir = stateDirectory();
    const store = createJobStore(stateDir);
    const worker = orphanWorker();
    const outputDir = join(stateDir, "videos", "how-dns-works");
    mkdirSync(outputDir, { recursive: true });
    store.put(
      makeJobRecord({
        job_id: 7,
        status: "running",
        output_dir: outputDir,
        owner: deadOwner(exitedPid()),
        // No token was recorded for this worker, so nothing about it can be proven either way.
        workers: [
          { pid: worker.pid, start_time: null, boot_id: machineBootId(), pgid: worker.pid },
        ],
      }),
    );

    const outcome = await reconcileJobs(store);

    expect(outcome.killed).toEqual([]);
    expect(isAlive(worker.pid)).toBe(true);
    const record = store.read(7);
    expect(record?.status).toBe("error");
    expect(record?.workers_uncertain).toBe(true);
    expect(record?.log.join(" ")).toContain("workers_uncertain");
    expect(outcome.quarantined).toHaveLength(1);
    expect(existsSync(outputDir)).toBe(false);
    expect(existsSync(outcome.quarantined[0]?.to ?? "")).toBe(true);
    expect(record?.output_dir).toBe(outcome.quarantined[0]?.to);
  });

  it("reports a newer record as daemon_restarted without rewriting it", async () => {
    const store = createJobStore(stateDirectory());
    store.put(
      makeJobRecord({
        job_id: 8,
        format_version: 99,
        status: "running",
        owner: deadOwner(exitedPid()),
      }),
    );
    const before = readFileSync(store.pathOf(8), "utf8");

    const outcome = await reconcileJobs(store);

    expect(outcome.newerFormat).toEqual([8]);
    expect(outcome.reconciled).toEqual([]);
    expect(readFileSync(store.pathOf(8), "utf8")).toBe(before);
    const reported = outcome.records.find((record) => record.job_id === 8);
    expect(reported?.status).toBe("error");
    expect(reported?.error_code).toBe("daemon_restarted");
    expect(reported?.log.join(" ")).toContain("left untouched on disk");
  });

  it("does not treat this daemon's own pid as a live previous owner", async () => {
    const store = createJobStore(stateDirectory());
    store.put(
      makeJobRecord({
        job_id: 9,
        status: "running",
        owner: { ...selfIdentity(), run_id: "a-previous-run-that-reused-this-pid" },
      }),
    );

    const outcome = await reconcileJobs(store);

    expect(outcome.reconciled).toEqual([9]);
  });
});
