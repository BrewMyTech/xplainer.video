/**
 * The platform rules from ADR 0020 §Port and discovery, asserted on one machine.
 *
 * `resolveStateDir()` takes its environment, platform and home directory as arguments precisely so
 * that the Linux and Windows branches are checkable from macOS. A version that read `process`
 * directly would leave two thirds of this decision untested for ever.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DAEMON_STATE_FILE,
  JOBS_DIR,
  OWNER_LOCK_FILE,
  RUNTIME_STATE_FILE,
  resolveStateDir,
  STATE_DIR_ENV,
  stateDirLayout,
} from "./state-dir.js";

const HOME = "/home/agent";

describe("resolveStateDir", () => {
  it("puts Linux state under XDG_STATE_HOME", () => {
    expect(resolveStateDir({ XDG_STATE_HOME: "/xdg/state" }, "linux", HOME)).toBe(
      "/xdg/state/xplainer",
    );
  });

  it("falls back to ~/.local/state on Linux when XDG_STATE_HOME is unset", () => {
    expect(resolveStateDir({}, "linux", HOME)).toBe(join(HOME, ".local", "state", "xplainer"));
  });

  it("uses the reverse-DNS Application Support directory on macOS", () => {
    expect(resolveStateDir({}, "darwin", HOME)).toBe(
      join(HOME, "Library", "Application Support", "video.xplainer"),
    );
  });

  it("uses LOCALAPPDATA on Windows", () => {
    expect(resolveStateDir({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32", HOME)).toBe(
      join("C:\\Users\\a\\AppData\\Local", "xplainer", "state"),
    );
  });

  it("lets XPLAINER_STATE_DIR override every platform default", () => {
    for (const platform of ["linux", "darwin", "win32"]) {
      expect(resolveStateDir({ [STATE_DIR_ENV]: "/tmp/state" }, platform, HOME)).toBe("/tmp/state");
    }
  });

  it("ignores an empty override rather than resolving to nothing", () => {
    expect(resolveStateDir({ [STATE_DIR_ENV]: "  " }, "darwin", HOME)).toBe(
      join(HOME, "Library", "Application Support", "video.xplainer"),
    );
  });
});

describe("stateDirLayout", () => {
  it("names the ownership artefact, the two state files and the job directory", () => {
    const layout = stateDirLayout("/state");

    expect(layout).toEqual({
      root: "/state",
      lock: join("/state", OWNER_LOCK_FILE),
      daemonState: join("/state", DAEMON_STATE_FILE),
      runtimeState: join("/state", RUNTIME_STATE_FILE),
      jobs: join("/state", JOBS_DIR),
      corrupt: join("/state", JOBS_DIR, "corrupt"),
    });
  });
});
