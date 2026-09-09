/**
 * The progress stream, watched while a real job runs.
 *
 * The worker is a `node -e` child that writes two lines and exits, so the transitions the stream
 * reports — `queued`, `running`, `done` — are transitions of a real process, and the frames are
 * read off the socket as they arrive rather than after the response has ended. That ordering is the
 * whole point of the route: a window has to learn a render finished *while it is still open*.
 */

import { afterEach, describe, expect, it } from "vitest";
import { fakeWorkerRegistry } from "../daemon/testing/fake-worker.js";
import { END_EVENT, JOB_EVENT } from "./events.js";
import type { ApiJobQueued } from "./jobs.js";
import {
  type ApiHarness,
  openSse,
  send,
  startApiHarness,
  stopHarnesses,
} from "./testing/harness.js";

afterEach(stopHarnesses);

const NARRATION = {
  voice: "af_heart",
  segments: [{ id: "one", text: "The first thing that happens." }],
};

/** Queue one narration job through the route a client would use. */
async function queue(harness: ApiHarness, slug: string): Promise<ApiJobQueued> {
  await harness.backend.explainer_create({ slug });
  const answer = await send({ port: harness.server.port }, `/api/videos/${slug}/narrate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ narration: NARRATION }),
  });
  expect(answer.status).toBe(202);
  return JSON.parse(answer.body) as ApiJobQueued;
}

describe("GET /api/jobs/:id/events", () => {
  it("reports a job from queued to done and then closes by itself", async () => {
    const harness = await startApiHarness({
      workers: fakeWorkerRegistry({ lines: 2, lifeMs: 80 }),
      pollIntervalMs: 15,
    });
    const queued = await queue(harness, "watched");

    const stream = await openSse({ port: harness.server.port }, queued.events);
    const ended = await stream.waitFor(END_EVENT);
    await stream.ended;

    expect(stream.status).toBe(200);
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    expect(stream.headers["cache-control"]).toBe("no-cache");
    const documents = stream.frames.filter((frame) => frame.event === JOB_EVENT);
    const states = documents.map((frame) => (JSON.parse(frame.data) as { status: string }).status);
    // The states the job passed through *while this client was watching*, in lifecycle order: a
    // client that subscribed after the worker had already started sees the stream from there.
    // `running` is always among them — the worker lives 80 ms — and `done` is always last.
    const lifecycle = ["queued", "running", "done"];
    expect(states).toContain("running");
    expect(states.at(-1)).toBe("done");
    expect(states.map((state) => lifecycle.indexOf(state))).toEqual(
      [...states.map((state) => lifecycle.indexOf(state))].sort((a, b) => a - b),
    );
    // No two consecutive frames carry the same document. Two `running` frames are not a repetition:
    // the second one carries a line of output the first did not, which is what a progress view is
    // reading.
    expect(documents.map((frame) => frame.data)).toEqual([
      ...new Set(documents.map((frame) => frame.data)),
    ]);
    expect(
      (JSON.parse(documents.at(-1)?.data ?? "{}") as { output: { lines: string[] } }).output.lines,
    ).toEqual(["line 1", "line 2"]);
    expect(JSON.parse(ended.data)).toEqual({ job_id: queued.job_id, status: "done" });
    // The stream is the last thing to happen: the server closed it, the client did not.
    expect(stream.isEnded()).toBe(true);
  });

  it("carries the same document GET /api/jobs/:id answers with", async () => {
    const harness = await startApiHarness({ pollIntervalMs: 15 });
    const queued = await queue(harness, "same");

    const stream = await openSse({ port: harness.server.port }, queued.events);
    const first = await stream.waitFor(JOB_EVENT);
    const polled = await send({ port: harness.server.port }, queued.job);
    stream.close();

    expect(JSON.parse(first.data)).toEqual(JSON.parse(polled.body));
    expect(first.id).toBe("0");
  });

  it("closes immediately for a job that has already finished", async () => {
    const harness = await startApiHarness({
      workers: fakeWorkerRegistry({ lines: 1 }),
      pollIntervalMs: 15,
    });
    const queued = await queue(harness, "finished");
    // Wait for the worker to have exited, through the route a client polls.
    const deadline = Date.now() + 10_000;
    while (
      Date.now() < deadline &&
      harness.runner.get({ job_id: queued.job_id }).status !== "done"
    ) {
      await new Promise<void>((done) => {
        setTimeout(done, 10);
      });
    }

    const stream = await openSse({ port: harness.server.port }, queued.events);
    await stream.ended;

    expect(stream.frames.map((frame) => frame.event)).toEqual([JOB_EVENT, END_EVENT]);
    expect(JSON.parse(stream.frames[0]?.data ?? "{}")).toMatchObject({ status: "done" });
  });

  it("keeps a silent stream alive with a comment rather than an event", async () => {
    // A worker that says nothing and stays alive: after it starts, the job's document stops
    // changing, so the only thing that can arrive is the keep-alive. This is the long render with
    // no output — the case a client would otherwise have no way to tell from a dead connection.
    const harness = await startApiHarness({
      workers: fakeWorkerRegistry({ lines: 0, lifeMs: 10_000 }),
      pollIntervalMs: 10,
      heartbeatMs: 30,
    });
    const queued = await queue(harness, "quiet");

    const stream = await openSse({ port: harness.server.port }, queued.events);
    await stream.waitFor(JOB_EVENT);
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && stream.comments.length === 0) {
      await new Promise<void>((done) => {
        setTimeout(done, 10);
      });
    }
    const frames = stream.frames.length;
    stream.close();

    expect(stream.comments.length).toBeGreaterThan(0);
    expect(stream.comments[0]?.startsWith(":")).toBe(true);
    // A comment is not an event: nothing was reported as having happened to the job.
    expect(stream.frames).toHaveLength(frames);
    expect(
      stream.frames.every(
        (frame) => (JSON.parse(frame.data) as { status: string }).status !== "done",
      ),
    ).toBe(true);
  });

  it("answers 404 as an HTTP status, not as a stream that says error", async () => {
    const harness = await startApiHarness();

    const answer = await send({ port: harness.server.port }, "/api/jobs/99/events");

    expect(answer.status).toBe(404);
    expect(answer.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(answer.body)).toMatchObject({ error: { code: "NO_SUCH_JOB" } });
  });

  it("answers 400 for an id that is not a job number", async () => {
    const harness = await startApiHarness();

    const answer = await send({ port: harness.server.port }, "/api/jobs/nine/events");

    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { code: "INVALID_JOB_ID" } });
  });

  it("lets the daemon carry on when a client hangs up mid-stream", async () => {
    const harness = await startApiHarness({ pollIntervalMs: 10 });
    const queued = await queue(harness, "abandoned");

    const stream = await openSse({ port: harness.server.port }, queued.events);
    await stream.waitFor(JOB_EVENT);
    stream.close();

    // The next request is answered, and the one after it: a stream nobody is reading has not left
    // the daemon writing into a socket that is gone.
    expect((await send({ port: harness.server.port }, "/healthz")).status).toBe(200);
    expect((await send({ port: harness.server.port }, queued.job)).status).toBe(200);
  });
});
