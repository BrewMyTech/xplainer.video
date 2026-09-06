/**
 * Behavioural proof for the Remotion argv builders (plan §4 S2.2, deviation D-4).
 *
 * These assertions are exact-array comparisons rather than `toContain` checks:
 * flag order and flag spelling are the contract inherited from
 * `explainer_mcp.py:416-419` and `:442-446`, and a silently reordered or
 * renamed flag is the failure this file exists to catch.
 */

import { describe, expect, it } from "vitest";
import {
  COMPOSITION_ID,
  DEFAULT_STILL_FRAME,
  DEFAULT_STILL_SCALE,
  entryPoint,
  REMOTION_BIN,
  renderArgs,
  stillArgs,
} from "./args.js";

describe("entryPoint", () => {
  it("places a video's entry point under videos/<slug>/index.ts", () => {
    expect(entryPoint("how-tls-works")).toBe("videos/how-tls-works/index.ts");
  });
});

describe("renderArgs", () => {
  it("builds the exact render argv the reference implementation shells out", () => {
    expect(
      renderArgs({
        slug: "how-tls-works",
        output: "/w/out/how-tls-works/explainer.mp4",
        publicDir: "/w/public/how-tls-works",
      }),
    ).toEqual([
      "render",
      "videos/how-tls-works/index.ts",
      "Explainer",
      "/w/out/how-tls-works/explainer.mp4",
      "--public-dir=/w/public/how-tls-works",
    ]);
  });

  it("keeps a path containing a space as one argument instead of quoting it", () => {
    const argv = renderArgs({
      slug: "demo",
      output: "/My Videos/out/explainer.mp4",
      publicDir: "/My Videos/public/demo",
    });

    expect(argv).toHaveLength(5);
    expect(argv[3]).toBe("/My Videos/out/explainer.mp4");
    expect(argv[4]).toBe("--public-dir=/My Videos/public/demo");
  });
});

describe("stillArgs", () => {
  it("defaults to frame 90 at scale 0.5, as the reference tool signature does", () => {
    expect(
      stillArgs({
        slug: "how-tls-works",
        output: "/w/out/how-tls-works/frame-90.png",
        publicDir: "/w/public/how-tls-works",
      }),
    ).toEqual([
      "still",
      "videos/how-tls-works/index.ts",
      "Explainer",
      "/w/out/how-tls-works/frame-90.png",
      "--frame=90",
      "--scale=0.5",
      "--public-dir=/w/public/how-tls-works",
    ]);
    expect(DEFAULT_STILL_FRAME).toBe(90);
    expect(DEFAULT_STILL_SCALE).toBe(0.5);
  });

  it("passes an explicit frame and scale through in the reference flag order", () => {
    expect(
      stillArgs({
        slug: "demo",
        output: "/w/out/demo/frame-240.png",
        publicDir: "/w/public/demo",
        frame: 240,
        scale: 0.25,
      }),
    ).toEqual([
      "still",
      "videos/demo/index.ts",
      "Explainer",
      "/w/out/demo/frame-240.png",
      "--frame=240",
      "--scale=0.25",
      "--public-dir=/w/public/demo",
    ]);
  });
});

describe("the pinned CLI contract", () => {
  it("targets the local remotion binary, never npx, and the Explainer composition", () => {
    expect(REMOTION_BIN).toBe("remotion");
    expect(COMPOSITION_ID).toBe("Explainer");
    expect(renderArgs({ slug: "demo", output: "o.mp4", publicDir: "p" })).not.toContain("npx");
  });
});
