/**
 * The two paths this app names, pinned against the builders `@xplainer/cli` publishes.
 *
 * Every other route is followed from what the daemon answered, so these two are the whole surface
 * on which the window and the daemon could ever disagree about a URL — and a disagreement here is a
 * `404` a user finds rather than a build that fails. Importing the CLI's own builders and comparing
 * makes the two one edit apart.
 */

import { enqueuePath as cliEnqueuePath, videosPath } from "@xplainer/cli";
import { describe, expect, it } from "vitest";
import { ENQUEUE_VERBS, enqueuePath, isEnqueueVerb, VIDEOS_PATH } from "./daemon-api";

describe("the verbs this app builds a route for", () => {
  it("is the closed set, and nothing off the IPC boundary widens it", () => {
    expect(ENQUEUE_VERBS).toEqual(["still", "render"]);
    expect(isEnqueueVerb("render")).toBe(true);
    // `explainer_narrate` takes a document a window cannot compose, so it is not offered — and a
    // message that asked for it anyway would not reach a path builder.
    expect(isEnqueueVerb("narrate")).toBe(false);
    expect(isEnqueueVerb("../../healthz")).toBe(false);
    expect(isEnqueueVerb(7)).toBe(false);
  });
});

describe("the paths this app names", () => {
  it("agrees with @xplainer/cli about where the library is", () => {
    expect(VIDEOS_PATH).toBe(videosPath());
  });

  it("agrees with @xplainer/cli about where a still and a render are queued", () => {
    expect(enqueuePath("a-slug", "still")).toBe(cliEnqueuePath("a-slug", "still"));
    expect(enqueuePath("a-slug", "render")).toBe(cliEnqueuePath("a-slug", "render"));
  });

  it("escapes the slug the same way, so a name is never a second path segment", () => {
    // A slug is `schemas/slug.json`'s pattern and could not need this, but the value reaches both
    // builders from a listing rather than from a literal — so both escape, or neither is safe.
    expect(enqueuePath("a/b", "render")).toBe(cliEnqueuePath("a/b", "render"));
    expect(enqueuePath("a/b", "render")).not.toContain("a/b");
  });
});
