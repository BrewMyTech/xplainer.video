/**
 * These tests are about the rule, not about the transport.
 *
 * `server.test.ts` proves the guard is wired into the registration and that an
 * agent gets the `ENGINE_OWNED_PATH` answer over a real MCP client. What is
 * proved here is what the rule actually is: which paths it refuses, which it
 * lets through, that a batch is refused whole, and that it stays tied to
 * `@xplainer/protocol`'s list rather than a list written in this package.
 */

import { ENGINE_OWNED_FILES } from "@xplainer/protocol";
import { describe, expect, it } from "vitest";
import { assertAgentOwnedPaths, EngineOwnedPathError } from "./put-source-guard.js";

/** An `explainer_put_source` argument object naming the given paths. */
function write(...paths: string[]): Record<string, unknown> {
  return { slug: "demo", files: paths.map((path) => ({ path, content: "x" })) };
}

/** Run the guard and return the error it threw, or `undefined` if it allowed the call. */
function refusal(input: Record<string, unknown>): EngineOwnedPathError | undefined {
  try {
    assertAgentOwnedPaths(input);
    return undefined;
  } catch (error) {
    if (error instanceof EngineOwnedPathError) {
      return error;
    }
    throw error;
  }
}

describe("assertAgentOwnedPaths", () => {
  it("refuses every engine-owned file the protocol reserves", () => {
    for (const reserved of ENGINE_OWNED_FILES) {
      const error = refusal(write(reserved));
      expect(error, `${reserved} should be refused`).toBeInstanceOf(EngineOwnedPathError);
      expect(error?.rejected).toEqual([reserved]);
      expect(error?.code).toBe("ENGINE_OWNED_PATH");
    }
  });

  it("allows the agent's own files, including a scene component named after an engine one", () => {
    expect(() =>
      assertAgentOwnedPaths(
        write("Scenes.tsx", "scenes/Intro.tsx", "scenes/Root.tsx", "scenes/Video.tsx", "lib/at.ts"),
      ),
    ).not.toThrow();
  });

  it("refuses the whole batch, so a partial write can never land", () => {
    const error = refusal(write("Scenes.tsx", "Video.tsx", "scenes/Intro.tsx"));

    expect(error).toBeInstanceOf(EngineOwnedPathError);
    // Nothing in the guard writes, and nothing downstream is reached: the
    // agent's two legitimate files are rejected along with the reserved one.
    expect(error?.rejected).toEqual(["Video.tsx"]);
  });

  it("names every offending path at once, so one retry is enough", () => {
    const error = refusal(write("Video.tsx", "Root.tsx", "Video.tsx"));

    expect(error?.rejected).toEqual(["Video.tsx", "Root.tsx"]);
    expect(error?.message).toContain('"Video.tsx", "Root.tsx"');
  });

  it("resolves traversal before matching, so a dressed-up path cannot slip through", () => {
    for (const dressed of ["./Video.tsx", "scenes/../Video.tsx", "../Video.tsx", "Video.tsx/"]) {
      expect(refusal(write(dressed)), `${dressed} should be refused`).toBeInstanceOf(
        EngineOwnedPathError,
      );
    }
  });

  it("folds case, because macOS and Windows would resolve video.tsx to the engine's Video.tsx", () => {
    // A case-sensitive guard refuses `Video.tsx`, waves `video.tsx` through, and the
    // engine shell is overwritten anyway on any case-insensitive filesystem — which is
    // the default on both macOS and Windows. The render then succeeds and ships silent,
    // the exact failure this boundary exists to prevent.
    for (const variant of ["video.tsx", "VIDEO.TSX", "ViDeO.tSx", "root.tsx", "captions.TSX"]) {
      expect(refusal(write(variant)), `${variant} should be refused`).toBeInstanceOf(
        EngineOwnedPathError,
      );
    }
  });

  it("reports a refused path exactly as the caller wrote it", () => {
    // Case folding decides the verdict; it must not rewrite what we echo back, or the
    // agent is told to stop writing a file it never named.
    expect(refusal(write("video.tsx"))?.rejected).toEqual(["video.tsx"]);
  });

  it("still allows an agent file whose name merely differs in case from a scene path", () => {
    // Only the five top-level reserved names fold. Nesting is untouched: `scenes/video.tsx`
    // is the agent's own component and stays writable.
    expect(refusal(write("scenes/video.tsx", "scenes/Video.tsx"))).toBeUndefined();
  });

  it("tells the agent what to do instead, and that nothing was written", () => {
    const error = refusal(write("Video.tsx"));

    expect(error?.message).toContain("Scenes.tsx");
    expect(error?.message).toContain("Nothing was written.");
    expect(error?.engineOwned).toEqual([...ENGINE_OWNED_FILES]);
  });

  it("leaves a malformed call to the backend, because reporting it is not this guard's job", () => {
    expect(() => assertAgentOwnedPaths({ slug: "demo" })).not.toThrow();
    expect(() => assertAgentOwnedPaths({ slug: "demo", files: "Video.tsx" })).not.toThrow();
    expect(() =>
      assertAgentOwnedPaths({ slug: "demo", files: [null, 7, { path: 3 }, {}] }),
    ).not.toThrow();
  });
});
