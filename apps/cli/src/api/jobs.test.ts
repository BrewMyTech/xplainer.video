/**
 * Reading a job over HTTP, and queueing one, against the real runner.
 *
 * The jobs here are real records written by the real `enqueue()` and run by `node -e` children, so
 * "queued" is a durable file and a `202` is a job a restart could still find. What the three
 * enqueueing routes are asserted on is the relay itself: that the arguments a client sent arrive at
 * the tool unchanged, that the slug in the path is the one that decides, and that each of the
 * backend's refusals reaches the client as the status this surface promised for it.
 */

import type { ExplainerJobOutput } from "@xplainer/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { fakeWorkerRegistry } from "../daemon/testing/fake-worker.js";
import { readJobRequest } from "../job-request.js";
import type { ApiJobQueued } from "./jobs.js";
import {
  type ApiHarness,
  pretendInstalled,
  pretendNarrated,
  send,
  startApiHarness,
  stopHarnesses,
} from "./testing/harness.js";

afterEach(stopHarnesses);

/** A daemon whose jobs never start, so a `queued` record stays observable for the whole test. */
async function idle(): Promise<ApiHarness> {
  return startApiHarness();
}

function post(harness: ApiHarness, path: string, body?: string) {
  return send({ port: harness.server.port }, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body }),
  });
}

const NARRATION = {
  voice: "af_heart",
  segments: [{ id: "one", text: "The first thing that happens." }],
};

describe("POST /api/videos/:slug/narrate", () => {
  it("queues a real job and answers 202 with both routes that report on it", async () => {
    const harness = await idle();
    await harness.backend.explainer_create({ slug: "queued" });

    const answer = await post(
      harness,
      "/api/videos/queued/narrate",
      JSON.stringify({ narration: NARRATION }),
    );
    const queued = JSON.parse(answer.body) as ApiJobQueued;

    expect(answer.status).toBe(202);
    expect(queued).toMatchObject({
      job_id: 1,
      status: "queued",
      poll: "explainer_job(job_id=1)",
      job: "/api/jobs/1",
      events: "/api/jobs/1/events",
    });
    expect(queued.what).toContain("queued");
    // The record is the runner's, not this route's invention.
    expect(harness.runner.get({ job_id: queued.job_id }).job_type).toBe("explainer_narrate");
    // And the arguments reached the tool: the spec is on disk for the worker to read.
    expect(readJobRequest(harness.root, queued.job_id, "explainer_narrate")).toMatchObject({
      job_type: "explainer_narrate",
      slug: "queued",
    });
  });

  it("takes the slug from the path, so a body naming another video cannot retarget it", async () => {
    const harness = await idle();
    await harness.backend.explainer_create({ slug: "mine" });
    await harness.backend.explainer_create({ slug: "yours" });

    const answer = await post(
      harness,
      "/api/videos/mine/narrate",
      JSON.stringify({ slug: "yours", narration: NARRATION }),
    );
    const queued = JSON.parse(answer.body) as ApiJobQueued;

    expect(answer.status).toBe(202);
    expect(readJobRequest(harness.root, queued.job_id, "explainer_narrate")).toMatchObject({
      slug: "mine",
    });
  });

  it("answers 404 for a video that was never created", async () => {
    const harness = await idle();

    const answer = await post(
      harness,
      "/api/videos/absent/narrate",
      JSON.stringify({ narration: NARRATION }),
    );

    expect(answer.status).toBe(404);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { code: "NO_SUCH_VIDEO" } });
  });

  it("answers 400 for a narration with nothing to say, as the tool does", async () => {
    const harness = await idle();
    await harness.backend.explainer_create({ slug: "silent" });

    const answer = await post(
      harness,
      "/api/videos/silent/narrate",
      JSON.stringify({ narration: { segments: [] } }),
    );

    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { code: "NO_SEGMENTS" } });
  });

  it("answers 400 for a body that is not a JSON object", async () => {
    const harness = await idle();
    await harness.backend.explainer_create({ slug: "shapes" });

    for (const body of ["[1,2]", "not json", '"a string"', "7"]) {
      const answer = await post(harness, "/api/videos/shapes/narrate", body);
      expect([body, answer.status]).toEqual([body, 400]);
      expect([body, (JSON.parse(answer.body) as { error: { code: string } }).error.code]).toEqual([
        body,
        "INVALID_BODY",
      ]);
    }
  });
});

describe("POST /api/videos/:slug/still and /render", () => {
  it("passes the frame and the scale through to the job the worker will read", async () => {
    const harness = await idle();
    await harness.backend.explainer_create({ slug: "layout" });
    pretendNarrated(harness, "layout");
    pretendInstalled(harness);

    const answer = await post(
      harness,
      "/api/videos/layout/still",
      JSON.stringify({ frame: 42, scale: 0.25 }),
    );
    const queued = JSON.parse(answer.body) as ApiJobQueued;

    expect(answer.status).toBe(202);
    expect(harness.runner.get({ job_id: queued.job_id }).job_type).toBe("explainer_still");
    expect(readJobRequest(harness.root, queued.job_id, "explainer_still")).toMatchObject({
      job_type: "explainer_still",
      slug: "layout",
      frame: 42,
      scale: 0.25,
    });
  });

  it("queues a render from a body that says nothing, because it takes no arguments", async () => {
    const harness = await idle();
    await harness.backend.explainer_create({ slug: "film" });
    pretendNarrated(harness, "film");
    pretendInstalled(harness);

    const answer = await post(harness, "/api/videos/film/render");
    const queued = JSON.parse(answer.body) as ApiJobQueued;

    expect(answer.status).toBe(202);
    expect(harness.runner.get({ job_id: queued.job_id }).job_type).toBe("explainer_render");
  });

  it("answers 409 while the video has never been narrated", async () => {
    const harness = await idle();
    await harness.backend.explainer_create({ slug: "unspoken" });
    pretendInstalled(harness);

    const answer = await post(harness, "/api/videos/unspoken/render");

    expect(answer.status).toBe(409);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { code: "NARRATION_MISSING" } });
  });

  it("answers 503 on a machine where setup has not run", async () => {
    const harness = await idle();
    await harness.backend.explainer_create({ slug: "bare" });
    pretendNarrated(harness, "bare");

    const answer = await post(harness, "/api/videos/bare/render");

    expect(answer.status).toBe(503);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { code: "WORKSPACE_NOT_INSTALLED" } });
  });

  it("answers 503 SHUTTING_DOWN once the daemon has stopped accepting work", async () => {
    const harness = await idle();
    await harness.backend.explainer_create({ slug: "late" });
    await harness.runner.drain(0);

    const answer = await post(
      harness,
      "/api/videos/late/narrate",
      JSON.stringify({ narration: NARRATION }),
    );

    expect(answer.status).toBe(503);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { code: "SHUTTING_DOWN" } });
  });
});

describe("GET /api/jobs/:id", () => {
  it("answers with the document explainer_job answers with, field for field", async () => {
    const harness = await startApiHarness({
      workers: fakeWorkerRegistry({ lines: 2, lifeMs: 50 }),
    });
    await harness.backend.explainer_create({ slug: "watched" });
    const queued = JSON.parse(
      (await post(harness, "/api/videos/watched/narrate", JSON.stringify({ narration: NARRATION })))
        .body,
    ) as ApiJobQueued;

    const answer = await send({ port: harness.server.port }, `/api/jobs/${queued.job_id}`);
    const overHttp = JSON.parse(answer.body) as ExplainerJobOutput;

    expect(answer.status).toBe(200);
    expect(overHttp.job_id).toBe(queued.job_id);
    expect(overHttp.job_type).toBe("explainer_narrate");
    expect(Object.keys(overHttp).sort()).toEqual(
      Object.keys(await harness.backend.explainer_job({ job_id: queued.job_id })).sort(),
    );
  });

  it("answers 404 for a job this daemon has no record of", async () => {
    const harness = await idle();

    const answer = await send({ port: harness.server.port }, "/api/jobs/404");

    expect(answer.status).toBe(404);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { code: "NO_SUCH_JOB" } });
  });

  it("answers 400 for an id that is not a job number", async () => {
    const harness = await idle();

    for (const id of ["abc", "0", "1.5", "-1", "01", "1e3", "%201"]) {
      const answer = await send({ port: harness.server.port }, `/api/jobs/${id}`);
      expect([id, answer.status]).toEqual([id, 400]);
      expect([id, (JSON.parse(answer.body) as { error: { code: string } }).error.code]).toEqual([
        id,
        "INVALID_JOB_ID",
      ]);
    }
  });
});
