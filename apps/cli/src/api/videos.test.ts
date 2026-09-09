/**
 * The library the desktop lists, over a real workspace on disk.
 *
 * Every fact asserted here is one the window shows — is there a film, how long is it, what can be
 * played — and every one of them is produced by the real `explainer_list` and the real filesystem,
 * so a test passing here is a claim about what a user would see rather than about a fixture.
 */

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { videoPaths } from "@xplainer/render-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  pretendNarrated,
  send,
  startApiHarness,
  stopHarnesses,
  writeRenderedMp4,
  writeStill,
} from "./testing/harness.js";
import { type ApiVideo, createWorkspaceLibrary, isVideoSlug } from "./videos.js";

/** `packages/protocol/schemas/`, from this file rather than from a hard-coded depth. */
const SCHEMAS = fileURLToPath(new URL("../../../../packages/protocol/schemas/", import.meta.url));

afterEach(stopHarnesses);

async function library(): Promise<ApiHarness> {
  return startApiHarness();
}

async function videos(harness: ApiHarness): Promise<ApiVideo[]> {
  const answer = await send({ port: harness.server.port }, "/api/videos");
  expect(answer.status).toBe(200);
  return (JSON.parse(answer.body) as { videos: ApiVideo[] }).videos;
}

describe("the slug this surface accepts", () => {
  it("is exactly schemas/slug.json's pattern", async () => {
    const schema = JSON.parse(readFileSync(join(SCHEMAS, "slug.json"), "utf8")) as {
      pattern: string;
    };
    const pattern = new RegExp(schema.pattern);
    const harness = await library();

    for (const slug of ["demo", "a", "0-9-x", "a".repeat(64)]) {
      expect(pattern.test(slug), slug).toBe(true);
      expect(isVideoSlug(slug), slug).toBe(true);
      // A slug the contract allows reaches the library and is answered "no such video", not
      // "not a slug".
      const answer = await send({ port: harness.server.port }, `/api/videos/${slug}`);
      expect([slug, answer.status]).toEqual([slug, 404]);
    }
    for (const slug of ["Demo", "-demo", "de%20mo", "a".repeat(65)]) {
      expect(pattern.test(decodeURIComponent(slug)), slug).toBe(false);
      expect(isVideoSlug(decodeURIComponent(slug)), slug).toBe(false);
      const answer = await send({ port: harness.server.port }, `/api/videos/${slug}`);
      expect([slug, answer.status]).toEqual([slug, 400]);
      expect(JSON.parse(answer.body)).toMatchObject({ error: { code: "INVALID_SLUG" } });
    }
    // A dot-segment never reaches a handler at all, in either spelling: the URL is resolved before
    // the router matches, so `..` is not refused by this route — there is nothing at that path to
    // refuse. Asserted because it is the property the traversal question actually turns on.
    for (const climb of ["..", "%2e%2e"]) {
      expect([
        climb,
        (await send({ port: harness.server.port }, `/api/videos/${climb}`)).status,
      ]).toEqual([climb, 404]);
    }
    // A traversal smuggled inside one segment does reach the handler — and is refused there,
    // which is why the pattern is checked before anything is built out of a slug.
    const smuggled = await send({ port: harness.server.port }, "/api/videos/..%2f..%2fetc");
    expect(smuggled.status).toBe(400);
    expect(JSON.parse(smuggled.body)).toMatchObject({ error: { code: "INVALID_SLUG" } });
  });
});

describe("GET /api/videos", () => {
  it("answers with an empty library before anything has been created", async () => {
    const harness = await library();

    expect(await videos(harness)).toEqual([]);
  });

  it("reports what each video has, and every artefact it can serve", async () => {
    const harness = await library();
    await harness.backend.explainer_create({ slug: "how-dns-works" });
    pretendNarrated(harness, "how-dns-works");
    writeRenderedMp4(harness, "how-dns-works", 3_000_000);
    writeStill(harness, "how-dns-works", 100);
    writeStill(harness, "how-dns-works", 9);

    const listed = await videos(harness);

    expect(listed).toHaveLength(1);
    const video = listed[0];
    expect(video).toMatchObject({
      slug: "how-dns-works",
      has_narration: true,
      rendered: true,
      seconds: 2,
      size_mb: 2.9,
    });
    // Ordered: the film, then the stills by frame number, then what narration produced. `frame-9`
    // comes before `frame-100`, which sorting the names as strings would get backwards.
    expect(video?.artefacts.map((artefact) => [artefact.kind, artefact.name])).toEqual([
      ["video", "explainer.mp4"],
      ["still", "frame-9.png"],
      ["still", "frame-100.png"],
      ["narration", "narration.wav"],
      ["captions", "captions.json"],
      ["timings", "timings.json"],
    ]);
    expect(video?.artefacts[0]).toMatchObject({
      url: "/api/videos/how-dns-works/artefacts/explainer.mp4",
      content_type: "video/mp4",
      bytes: 3_000_000,
    });
    expect(Date.parse(video?.artefacts[0]?.modified_at ?? "")).toBeGreaterThan(0);
  });

  it("never sends a path on this machine, which is what the artefact URL replaces", async () => {
    const harness = await library();
    await harness.backend.explainer_create({ slug: "paths" });
    writeRenderedMp4(harness, "paths", 64);

    const answer = await send({ port: harness.server.port }, "/api/videos");

    expect(answer.body).not.toContain(harness.root);
    expect(JSON.parse(answer.body)).toMatchObject({
      videos: [{ slug: "paths", rendered: true, has_narration: false, seconds: null }],
    });
    // `ExplainerListOutput` carries `mp4` as a path on the machine that answered. This surface
    // does not.
    expect(Object.keys((JSON.parse(answer.body) as { videos: object[] }).videos[0] ?? {})).toEqual([
      "slug",
      "has_narration",
      "rendered",
      "seconds",
      "size_mb",
      "artefacts",
    ]);
  });

  it("reports a video that has produced nothing yet with an empty artefact list", async () => {
    const harness = await library();
    await harness.backend.explainer_create({ slug: "fresh" });

    expect(await videos(harness)).toEqual([
      {
        slug: "fresh",
        has_narration: false,
        rendered: false,
        seconds: null,
        size_mb: null,
        artefacts: [],
      },
    ]);
  });
});

describe("GET /api/videos/:slug", () => {
  it("answers with the same entry the library carries", async () => {
    const harness = await library();
    await harness.backend.explainer_create({ slug: "one" });
    await harness.backend.explainer_create({ slug: "two" });
    writeRenderedMp4(harness, "two", 128);

    const answer = await send({ port: harness.server.port }, "/api/videos/two");
    const listed = (await videos(harness)).find((video) => video.slug === "two");

    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual(listed);
  });

  it("answers 404 NO_SUCH_VIDEO for a slug nothing has been created for", async () => {
    const harness = await library();

    const answer = await send({ port: harness.server.port }, "/api/videos/absent");

    expect(answer.status).toBe(404);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { code: "NO_SUCH_VIDEO" } });
  });
});

describe("the workspace library", () => {
  it("opens an artefact by name and nothing else", async () => {
    const harness = await library();
    await harness.backend.explainer_create({ slug: "guarded" });
    writeRenderedMp4(harness, "guarded", 16);
    const opened = createWorkspaceLibrary({ root: harness.root });

    expect(opened.open("guarded", "explainer.mp4")?.path).toBe(
      videoPaths(harness.root, "guarded").mp4,
    );
    // Nothing here is joined onto a path, so a name that climbs is simply not in the enumeration.
    for (const name of ["../../../etc/passwd", "..", ".", "explainer.mp4/../explainer.mp4"]) {
      expect([name, opened.open("guarded", name)]).toEqual([name, null]);
    }
    expect(opened.open("../guarded", "explainer.mp4")).toBe(null);
    expect(opened.artefacts("../guarded")).toEqual([]);
  });

  it("answers for the workspace as it is now, not as it was at the last listing", async () => {
    const harness = await library();
    await harness.backend.explainer_create({ slug: "moving" });
    const opened = createWorkspaceLibrary({ root: harness.root });
    writeRenderedMp4(harness, "moving", 16);

    expect(opened.artefacts("moving").map((artefact) => artefact.name)).toEqual(["explainer.mp4"]);

    rmSync(videoPaths(harness.root, "moving").mp4);

    expect(opened.artefacts("moving")).toEqual([]);
    expect(opened.open("moving", "explainer.mp4")).toBe(null);
  });
});
