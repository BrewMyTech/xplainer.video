/**
 * What the two readers do with a document that is not the one they were promised.
 *
 * `screens.test.tsx` asserts them against what a real daemon really answers, which is the half that
 * matters. This is the other half: a field that is missing, a type that is wrong, an event that
 * belongs to somebody else's stream. Each of those is a shape a *future* daemon could answer with,
 * and the rule is the same one this app applies to a payload manifest — a document is checked, not
 * cast, and an unreadable one produces less on the screen rather than a screen built around
 * `undefined`.
 */

import { describe, expect, it } from "vitest";
import { describeVideo, filmOf, readLibrary, readVideo, stillsOf } from "./library";
import { applyJobEvent, beginWatch, describeWatch, elapsedSeconds, readJob } from "./progress";

describe("readLibrary", () => {
  it("answers an empty library for anything that is not one", () => {
    expect(readLibrary(null)).toEqual([]);
    expect(readLibrary([])).toEqual([]);
    expect(readLibrary({})).toEqual([]);
    expect(readLibrary({ videos: "none" })).toEqual([]);
  });

  it("keeps the entries that are videos and drops the ones that are not", () => {
    const videos = readLibrary({ videos: [{ slug: "kept" }, { slug: 7 }, null, "dropped"] });

    expect(videos.map((video) => video.slug)).toEqual(["kept"]);
    // Every optional field has a value rather than being absent, so a screen never has to tell
    // "this video has no narration" apart from "this daemon did not say".
    expect(videos[0]).toEqual({
      slug: "kept",
      hasNarration: false,
      rendered: false,
      seconds: null,
      sizeMb: null,
      artefacts: [],
    });
  });

  it("drops an artefact that carries no route to fetch it by", () => {
    const video = readVideo({
      slug: "partial",
      artefacts: [
        {
          kind: "video",
          name: "explainer.mp4",
          url: "/api/videos/partial/artefacts/explainer.mp4",
        },
        { kind: "still", name: "frame-1.png" },
        { kind: "still", name: 3, url: "/api/x" },
      ],
    });

    expect(video?.artefacts.map((artefact) => artefact.name)).toEqual(["explainer.mp4"]);
    expect(filmOf(video ?? nowhere())?.url).toBe("/api/videos/partial/artefacts/explainer.mp4");
    expect(stillsOf(video ?? nowhere())).toEqual([]);
    // A missing `content_type` becomes the one every HTTP server falls back to, never `undefined`.
    expect(video?.artefacts[0]?.contentType).toBe("application/octet-stream");
  });

  it("describes a video with the numbers the daemon sent and no others", () => {
    const bare = readVideo({ slug: "bare" });
    const full = readVideo({
      slug: "full",
      has_narration: true,
      rendered: true,
      seconds: 12.34,
      size_mb: 4.5,
    });

    expect(describeVideo(bare ?? nowhere())).toBe("no narration · not rendered");
    expect(describeVideo(full ?? nowhere())).toBe("narrated · 12.3 s · rendered · 4.5 MB");
  });
});

describe("readJob", () => {
  it("refuses a document that is not one job's state", () => {
    expect(readJob(null)).toBeNull();
    expect(readJob({ job_id: "1", status: "running" })).toBeNull();
    expect(readJob({ job_id: 1, status: "nearly-done" })).toBeNull();
  });

  it("reads the five states and the tail of what the job wrote", () => {
    const snapshot = readJob({
      job_id: 4,
      job_type: "explainer_render",
      status: "running",
      output: { lines: ["bundling", 7, "rendering"] },
    });

    expect(snapshot?.status).toBe("running");
    expect(snapshot?.lines).toEqual(["bundling", "rendering"]);
    expect(snapshot?.error).toBeNull();
  });
});

describe("applyJobEvent", () => {
  const watch = beginWatch({ subscription: 2, slug: "a-video", verb: "render" });

  it("ignores an event that belongs to another stream", () => {
    const other = applyJobEvent(watch, {
      subscription: 3,
      kind: "job",
      data: { job_id: 9, status: "done" },
    });

    expect(other).toBe(watch);
  });

  it("ends on `end` and keeps the last state it was told", () => {
    const running = applyJobEvent(watch, {
      subscription: 2,
      kind: "job",
      data: { job_id: 9, status: "running", started_at: "2026-09-08T10:00:00.000Z" },
    });
    const ended = applyJobEvent(running, { subscription: 2, kind: "end", data: null });

    expect(ended.ended).toBe(true);
    expect(ended.snapshot?.status).toBe("running");
    expect(
      elapsedSeconds(ended.snapshot ?? nowhere(), Date.parse("2026-09-08T10:00:03.000Z")),
    ).toBe(3);
  });

  it("keeps a stream's own failure apart from the job's", () => {
    const failed = applyJobEvent(watch, {
      subscription: 2,
      kind: "error",
      data: "the connection ended",
    });

    expect(failed.streamError).toBe("the connection ended");
    expect(failed.snapshot).toBeNull();
    expect(describeWatch(failed, Date.now())).toBe("the stream failed: the connection ended");
  });

  it("says what it is waiting for before the first event arrives", () => {
    expect(describeWatch(watch, Date.now())).toMatch(/waiting for the daemon's first event/);
  });
});

/** A value these assertions never reach: every `readVideo` above answers a document. */
function nowhere(): never {
  throw new Error("the reader answered null for a document it was given.");
}
