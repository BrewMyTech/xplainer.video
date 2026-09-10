/**
 * The three rules `routes.ts` is held to, asserted on a bound listener.
 *
 * They are properties of the *mounting*, not of any one route, and each of them is invisible in the
 * route it protects: the guard covers these paths because they were registered after a middleware
 * on `*`, the socket skips it because of which listener accepted the request, and there is no CORS
 * header because nothing ever adds one. ADR 0020 §R-SEC-11 asks for exactly this kind of negative
 * test beside the positive ones — "without them the guard regresses on the first refactor of
 * `createServer()` and nobody notices, because every legitimate client still works".
 *
 * The paths under test are built with the **exported** builders, so this file also proves that what
 * the desktop will construct is what the router registered.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  artefactPath,
  enqueuePath,
  jobEventsPath,
  jobPath,
  videoPath,
  videosPath,
} from "./paths.js";
import {
  type ApiHarness,
  authorized,
  openSse,
  send,
  startApiHarness,
  stopHarnesses,
  writeRenderedMp4,
} from "./testing/harness.js";

afterEach(stopHarnesses);

/** Every route this surface has, named as a client would ask for it. */
const ROUTES: readonly { method: string; path: string }[] = [
  { method: "GET", path: videosPath() },
  { method: "GET", path: videoPath("demo") },
  { method: "GET", path: artefactPath("demo", "explainer.mp4") },
  { method: "POST", path: enqueuePath("demo", "narrate") },
  { method: "POST", path: enqueuePath("demo", "still") },
  { method: "POST", path: enqueuePath("demo", "render") },
  { method: "GET", path: jobPath(1) },
  { method: "GET", path: jobEventsPath(1) },
];

/** A daemon with one video that has been rendered, bound the way `serve` binds one. */
async function guarded(): Promise<ApiHarness> {
  const harness = await startApiHarness({ guard: true, ipc: true, pollIntervalMs: 15 });
  await harness.backend.explainer_create({ slug: "demo" });
  writeRenderedMp4(harness, "demo", 64);
  return harness;
}

describe("the guard in front of the client surface", () => {
  it("refuses every route on TCP without the bearer token", async () => {
    const harness = await guarded();

    for (const route of ROUTES) {
      const answer = await send({ port: harness.server.port }, route.path, {
        method: route.method,
      });
      expect([route.method, route.path, answer.status]).toEqual([route.method, route.path, 401]);
    }
    // And nothing was done on the way to being refused: no job was queued by the three POSTs.
    expect(() => harness.runner.get({ job_id: 1 })).toThrow();
  });

  it("answers every route on TCP with the token", async () => {
    const harness = await guarded();

    for (const route of ROUTES) {
      if (route.path === jobEventsPath(1)) {
        continue;
      }
      const answer = await send({ port: harness.server.port }, route.path, {
        method: route.method,
        headers: authorized(),
      });
      expect([route.path, answer.status === 401]).toEqual([route.path, false]);
    }
  });

  it("answers over the socket with no token at all, because that transport has none", async () => {
    const harness = await guarded();
    const socket = { socketPath: harness.socketPath ?? "" };

    const listed = await send(socket, videosPath());
    const one = await send(socket, videoPath("demo"));
    const bytes = await send(socket, artefactPath("demo", "explainer.mp4"));
    const queued = await send(socket, enqueuePath("demo", "narrate"), {
      method: "POST",
      body: JSON.stringify({ narration: { segments: [{ id: "one", text: "Hello." }] } }),
    });
    const job = await send(socket, jobPath(1));
    const stream = await openSse(socket, jobEventsPath(1));
    stream.close();

    expect([listed.status, one.status, bytes.status]).toEqual([200, 200, 200]);
    expect([queued.status, job.status, stream.status]).toEqual([202, 200, 200]);
  });
});

describe("R-SEC-7", () => {
  it("sends no CORS header on any answer, allowed or refused, with or without an Origin", async () => {
    const harness = await guarded();
    const answers = [
      await send({ port: harness.server.port }, videosPath(), { headers: authorized() }),
      await send({ port: harness.server.port }, videosPath()),
      await send({ port: harness.server.port }, videosPath(), {
        headers: { ...authorized(), Origin: "https://example.com" },
      }),
      await send({ port: harness.server.port }, artefactPath("demo", "explainer.mp4"), {
        headers: { ...authorized(), Origin: "https://example.com" },
      }),
      await send({ socketPath: harness.socketPath ?? "" }, videosPath(), {
        headers: { Origin: "https://example.com" },
      }),
      await send({ port: harness.server.port }, videosPath(), {
        method: "OPTIONS",
        headers: {
          ...authorized(),
          Origin: "https://example.com",
          "Access-Control-Request-Method": "GET",
        },
      }),
    ];

    for (const answer of answers) {
      expect(
        Object.keys(answer.headers).filter((header) => header.startsWith("access-control-")),
      ).toEqual([]);
    }
    // The one with a foreign Origin was refused rather than allowed, which is the guard's own
    // answer and the reason no CORS header is needed in the first place.
    expect(answers[2]?.status).toBe(403);
  });
});

describe("the client surface is optional", () => {
  it("is not registered at all for a server that was given no library", async () => {
    const harness = await startApiHarness({ withoutApi: true });
    await harness.backend.explainer_create({ slug: "demo" });

    for (const route of ROUTES) {
      const answer = await send({ port: harness.server.port }, route.path, {
        method: route.method,
      });
      expect([route.path, answer.status]).toEqual([route.path, 404]);
    }
    // The rest of the application is untouched: this is the shape the hosted media service
    // (relocated to a private repository, ADR 0023) binds.
    expect((await send({ port: harness.server.port }, "/healthz")).status).toBe(200);
  });
});
