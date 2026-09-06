/**
 * One JSON file per job, and the three conditions a load has to tell apart.
 *
 * ADR 0024 §An unknown format version is not corruption is the section under test: collapsing
 * "unparseable" and "newer than me" into one bucket "would make a **rollback** destroy the jobs it
 * was rolling back to". The two assertions that matter are that a corrupt file is moved aside and
 * the boot continues, and that a newer record is left **byte-identical** on disk.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendLogLine,
  createJobStore,
  DEFAULT_OUTPUT_LINES,
  JOB_LOG_LINE_CAP,
  toJobOutput,
} from "./job-store.js";
import { makeJobRecord } from "./testing/records.js";

const scratch: string[] = [];

function stateDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "xplainer-store-"));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the log line cap", () => {
  /**
   * The cap is not a number chosen here: it is `output_lines`' `default` in the published schema,
   * so a record always holds what a default poll asks for. Reading the schema rather than restating
   * it is what stops the two drifting.
   */
  it("is the `output_lines` default from the protocol schema", () => {
    const schema = JSON.parse(
      readFileSync(
        new URL(
          "../../../../packages/protocol/schemas/tools/explainer_job.input.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { properties: { output_lines: { default: number } } };

    expect(JOB_LOG_LINE_CAP).toBe(schema.properties.output_lines.default);
    expect(DEFAULT_OUTPUT_LINES).toBe(schema.properties.output_lines.default);
  });

  it("drops the oldest lines rather than growing without bound", () => {
    const record = makeJobRecord();

    for (let line = 1; line <= JOB_LOG_LINE_CAP + 10; line += 1) {
      appendLogLine(record, `line ${line}`);
    }

    expect(record.log).toHaveLength(JOB_LOG_LINE_CAP);
    expect(record.log[0]).toBe("line 11");
    expect(record.log.at(-1)).toBe(`line ${JOB_LOG_LINE_CAP + 10}`);
  });
});

describe("toJobOutput", () => {
  it("bounds the returned tail by output_lines and keeps the last ones", () => {
    const record = makeJobRecord({
      status: "done",
      log: Array.from({ length: 50 }, (_, index) => `line ${index + 1}`),
    });

    expect(toJobOutput(record, 3).output.lines).toEqual(["line 48", "line 49", "line 50"]);
  });

  it("returns the contract's fields and none of the record's host detail", () => {
    const record = makeJobRecord({ status: "running", started_at: "2026-09-06T00:00:01.000Z" });

    expect(Object.keys(toJobOutput(record, 1)).sort()).toEqual([
      "error",
      "error_code",
      "exit_code",
      "finished_at",
      "job_id",
      "job_type",
      "output",
      "started_at",
      "status",
    ]);
  });
});

describe("createJobStore", () => {
  it("writes and reads a record, and numbers the next job after the highest file", () => {
    const store = createJobStore(stateDirectory());

    expect(store.nextJobId()).toBe(1);
    store.put(makeJobRecord({ job_id: 1 }));
    store.put(makeJobRecord({ job_id: 7 }));

    expect(store.nextJobId()).toBe(8);
    expect(store.read(7)?.job_id).toBe(7);
    expect(store.read(99)).toBeUndefined();
  });

  it("loads records in job-id order", () => {
    const store = createJobStore(stateDirectory());
    store.put(makeJobRecord({ job_id: 10 }));
    store.put(makeJobRecord({ job_id: 2 }));

    expect(store.load().records.map((record) => record.job_id)).toEqual([2, 10]);
  });

  it("quarantines an unparseable file to jobs/corrupt/ and keeps loading the rest", () => {
    const stateDir = stateDirectory();
    const store = createJobStore(stateDir);
    store.put(makeJobRecord({ job_id: 1 }));
    writeFileSync(join(store.paths.jobs, "job-000002.json"), "{ half a record");

    const loaded = store.load();

    expect(loaded.records.map((record) => record.job_id)).toEqual([1]);
    expect(loaded.corrupt).toEqual(["job-000002.json"]);
    expect(readdirSync(store.paths.corrupt)).toEqual(["job-000002.json"]);
    // The id is spent: handing 2 to a new job would give an agent still holding that number a
    // different job's answers.
    expect(store.nextJobId()).toBe(3);
  });

  it("quarantines a parseable file that is not a job record, and salvages nothing it cannot read", () => {
    const store = createJobStore(stateDirectory());
    writeFileSync(join(store.paths.jobs, "job-000001.json"), JSON.stringify({ hello: "world" }));

    const loaded = store.load();

    expect(loaded.corrupt).toEqual(["job-000001.json"]);
    // No `job_type` survived, and guessing one would tell an agent to retry the wrong tool.
    expect(loaded.records).toEqual([]);
    expect(store.nextJobId()).toBe(2);
  });

  it("leaves a terminal tombstone when the damaged record still says what kind of job it was", () => {
    const store = createJobStore(stateDirectory());
    writeFileSync(
      join(store.paths.jobs, "job-000004.json"),
      JSON.stringify({ job_id: 4, job_type: "explainer_narrate", video_id: "how-dns-works" }),
    );

    const loaded = store.load();

    expect(loaded.corrupt).toEqual(["job-000004.json"]);
    const tombstone = loaded.records[0];
    expect(tombstone?.job_id).toBe(4);
    expect(tombstone?.job_type).toBe("explainer_narrate");
    expect(tombstone?.status).toBe("error");
    expect(tombstone?.error_code).toBe("internal");
    expect(tombstone?.finished_at).not.toBeNull();
    // The original bytes are kept, and the replacement is a record a poll can terminate on.
    expect(readdirSync(store.paths.corrupt)).toEqual(["job-000004.json"]);
    expect(store.read(4)?.error_code).toBe("internal");
  });

  it("reports a newer format_version and leaves the file byte-identical", () => {
    const store = createJobStore(stateDirectory());
    const record = makeJobRecord({ job_id: 3, format_version: 2, status: "running" });
    store.put(record);
    const before = readFileSync(store.pathOf(3), "utf8");

    const loaded = store.load();

    expect(loaded.newer).toEqual([3]);
    expect(loaded.records.map((entry) => entry.job_id)).toEqual([3]);
    expect(readFileSync(store.pathOf(3), "utf8")).toBe(before);
  });
});
