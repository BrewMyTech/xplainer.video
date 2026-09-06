/**
 * The seam between a tool call and the process that carries it out.
 *
 * The interesting cases are all failures. A request document that is missing, damaged, or about a
 * different kind of job is the one thing standing between "this job failed and said why" and "this
 * job rendered something nobody asked for", so each of those is a named refusal rather than a
 * default.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { jobRequestPath, readJobRequest, writeJobRequest } from "./job-request.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "xplainer-request-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("writeJobRequest and readJobRequest", () => {
  it("round-trips each of the three request shapes", () => {
    const root = temporaryRoot();

    writeJobRequest(root, 1, { job_type: "explainer_narrate", slug: "demo", dry_run: true });
    writeJobRequest(root, 2, { job_type: "explainer_still", slug: "demo", frame: 90, scale: 0.5 });
    writeJobRequest(root, 3, { job_type: "explainer_render", slug: "demo" });

    expect(readJobRequest(root, 1, "explainer_narrate")).toEqual({
      job_type: "explainer_narrate",
      slug: "demo",
      dry_run: true,
    });
    expect(readJobRequest(root, 2, "explainer_still")).toEqual({
      job_type: "explainer_still",
      slug: "demo",
      frame: 90,
      scale: 0.5,
    });
    expect(readJobRequest(root, 3, "explainer_render")).toEqual({
      job_type: "explainer_render",
      slug: "demo",
    });
  });

  it("names the job and the file when there is no request document", () => {
    const root = temporaryRoot();

    expect(() => readJobRequest(root, 7, "explainer_render")).toThrow(
      /job 7 has no request document at .*job-000007\.json/,
    );
  });

  it("refuses a damaged document rather than guessing what it meant", () => {
    const root = temporaryRoot();
    writeJobRequest(root, 1, { job_type: "explainer_render", slug: "demo" });
    writeFileSync(jobRequestPath(root, 1), "{ not json");

    expect(() => readJobRequest(root, 1, "explainer_render")).toThrow(/not readable JSON/);
  });

  it("refuses a document that describes a different kind of job", () => {
    const root = temporaryRoot();
    writeJobRequest(root, 1, { job_type: "explainer_render", slug: "demo" });

    expect(() => readJobRequest(root, 1, "explainer_still")).toThrow(
      /does not describe a explainer_still job/,
    );
  });

  it("refuses a still whose frame or scale is missing, because a default here is a guess", () => {
    const root = temporaryRoot();
    writeFileSync(
      jobRequestPath(
        (() => {
          writeJobRequest(root, 1, { job_type: "explainer_render", slug: "demo" });
          return root;
        })(),
        1,
      ),
      JSON.stringify({ job_type: "explainer_still", slug: "demo" }),
    );

    expect(() => readJobRequest(root, 1, "explainer_still")).toThrow(/does not describe/);
  });
});
