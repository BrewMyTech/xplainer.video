/**
 * Where the workspace is, decided once from an environment and a path.
 *
 * Two callers depend on this answer being the same one — `daemon/start.ts` builds the worker
 * registry over it and `commands/serve.ts` builds the backend over it — so the resolution is a
 * pure function and is asserted as one, with the environment passed in rather than mutated.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkspaceRoot, VIDEOS_DIR_ENV, WORKSPACE_DIR_NAME } from "./workspace-root.js";

describe("resolveWorkspaceRoot", () => {
  it("defaults to a workspace directory inside the state directory", () => {
    expect(resolveWorkspaceRoot("/state", {})).toBe(join("/state", WORKSPACE_DIR_NAME));
  });

  it("takes XPLAINER_VIDEOS_DIR when it names something", () => {
    expect(resolveWorkspaceRoot("/state", { [VIDEOS_DIR_ENV]: "/videos" })).toBe("/videos");
  });

  it("ignores a blank override rather than resolving to an empty path", () => {
    for (const blank of ["", "   "]) {
      expect(resolveWorkspaceRoot("/state", { [VIDEOS_DIR_ENV]: blank })).toBe(
        join("/state", WORKSPACE_DIR_NAME),
      );
    }
  });
});
