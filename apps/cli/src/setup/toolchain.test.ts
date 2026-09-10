/**
 * The gate every render passes, asserted against real documents on disk.
 *
 * Each case here is a machine state a user can actually be in — setup never run, an artefact
 * cleaned away, a workspace resolved for another platform, a daemon updated past its workspace —
 * and what is asserted is the *reason* and the *repair*, because those are what `/healthz` reports
 * and what the refusal on a job record tells someone to do. Nothing is stubbed: the marker is
 * written by the writer under test and read back by the reader under test.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { WORKSPACE_MANIFEST_FILE } from "../runtime/manifest.js";
import { readTemplatePins } from "../runtime/verify.js";
import { recordTestToolchain, writeTestWorkspaceManifest } from "./testing/toolchain.js";
import {
  checkToolchain,
  firstPinSkew,
  hostPlatformKey,
  readToolchainMarker,
  TOOLCHAIN_FORMAT_VERSION,
  TOOLCHAIN_MISSING,
  TOOLCHAIN_STALE,
  toolchainMarkerPath,
  writeToolchainMarker,
} from "./toolchain.js";

const directories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/** A state directory and a workspace root, the pair every caller of the gate holds. */
function machine(): { stateDir: string; workspaceRoot: string } {
  return {
    stateDir: temporaryDirectory("xplainer-toolchain-state-"),
    workspaceRoot: temporaryDirectory("xplainer-toolchain-workspace-"),
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("the marker", () => {
  it("round-trips through the durable writer and the validating reader", () => {
    const where = machine();

    const written = recordTestToolchain(where);

    expect(readToolchainMarker(where.stateDir)).toEqual(written);
    expect(readFileSync(toolchainMarkerPath(where.stateDir), "utf8").endsWith("\n")).toBe(true);
  });

  it("answers null for a document that is not a complete toolchain, rather than casting it", () => {
    const where = machine();
    recordTestToolchain(where);
    writeFileSync(
      toolchainMarkerPath(where.stateDir),
      JSON.stringify({ format_version: 1, created_at: "now", chrome: { version: "1" } }),
    );

    expect(readToolchainMarker(where.stateDir)).toBeNull();
  });
});

describe("checkToolchain", () => {
  it("passes a machine where setup has run", () => {
    const where = machine();
    recordTestToolchain(where);

    const status = checkToolchain(where);

    expect(status.ok).toBe(true);
    expect(status.reason).toBeNull();
    expect(status.marker?.workspace.platform).toBe(hostPlatformKey());
  });

  it("reports toolchain_missing with `xplainer setup` when there is no marker at all", () => {
    const where = machine();

    const status = checkToolchain(where);

    expect(status.reason).toBe(TOOLCHAIN_MISSING);
    expect(status.detail).toContain("xplainer setup");
  });

  it("reports toolchain_missing naming the component whose file was cleaned away", () => {
    const where = machine();
    const marker = recordTestToolchain(where);
    rmSync(marker.speech.path);

    const status = checkToolchain(where);

    expect(status.reason).toBe(TOOLCHAIN_MISSING);
    expect(status.detail).toContain("speech");
    expect(status.detail).toContain(marker.speech.path);
  });

  /**
   * A component made of several files — the ONNX speech route's model, its voice and this
   * platform's runtime — records them all in `files`, and the gate has to check every one. Checking
   * only `path` would report a toolchain as present on a machine whose runtime had been cleaned
   * away, which is the failure this gate exists to turn into a sentence rather than an `ENOENT`
   * inside a worker.
   */
  it("reports toolchain_missing naming a recorded file that is not the component's own path", () => {
    const where = machine();
    const marker = recordTestToolchain(where);
    const extra = join(where.stateDir, "toolchain", "speech-onnx", "runtime.node");
    mkdirSync(join(extra, ".."), { recursive: true });
    writeFileSync(extra, "a stand-in for this platform's ONNX Runtime\n");
    writeToolchainMarker(where.stateDir, {
      ...marker,
      speech: {
        ...marker.speech,
        files: [
          { path: marker.speech.path, sha256: marker.speech.sha256, bytes: 1 },
          { path: extra, sha256: "0".repeat(64), bytes: 44 },
        ],
      },
    });
    // The component's own `path` is untouched; only the second recorded file goes.
    rmSync(extra);

    const status = checkToolchain(where);

    expect(status.reason).toBe(TOOLCHAIN_MISSING);
    expect(status.detail).toContain(extra);
    expect(status.detail).not.toContain(`${marker.speech.path},`);
  });

  it("keeps the recorded files through the writer and the validating reader", () => {
    const where = machine();
    const marker = recordTestToolchain(where);
    const files = [{ path: marker.speech.path, sha256: marker.speech.sha256, bytes: 12 }];

    writeToolchainMarker(where.stateDir, {
      ...marker,
      speech: { ...marker.speech, files },
    });

    expect(readToolchainMarker(where.stateDir)?.speech.files).toEqual(files);
  });

  /**
   * A `files` array of the wrong shape rejects the whole document rather than being dropped:
   * dropping it would turn a corrupt marker into one recording fewer paths than the component has,
   * and the existence check above would then pass over exactly what it exists to notice.
   */
  it("refuses a marker whose recorded files are the wrong shape", () => {
    const where = machine();
    const marker = recordTestToolchain(where);
    const path = toolchainMarkerPath(where.stateDir);
    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(
      path,
      JSON.stringify({
        ...document,
        speech: { ...marker.speech, files: [{ path: marker.speech.path }] },
      }),
    );

    expect(readToolchainMarker(where.stateDir)).toBeNull();
  });

  it("reports toolchain_missing when the workspace has no manifest beside it", () => {
    const where = machine();
    recordTestToolchain(where);
    rmSync(join(where.workspaceRoot, WORKSPACE_MANIFEST_FILE));

    const status = checkToolchain(where);

    expect(status.reason).toBe(TOOLCHAIN_MISSING);
    expect(status.detail).toContain("xplainer setup --workspace");
  });

  /**
   * `@remotion/compositor-<platform>` is a platform-specific optional dependency, so a workspace
   * copied from another machine is a different artefact even when every declared version matches.
   */
  it("reports toolchain_stale for a workspace resolved on another platform", () => {
    const where = machine();
    recordTestToolchain(where);
    writeTestWorkspaceManifest({ ...where, platform: "sunos", arch: "sparc" });

    const status = checkToolchain(where);

    expect(status.reason).toBe(TOOLCHAIN_STALE);
    expect(status.detail).toContain("sunos-sparc");
    expect(status.detail).toContain("compositor");
  });

  /**
   * Decision D2's skew, from the side a *daemon update* creates it: the tree is intact and the
   * template this build ships now pins something else. Round 3's check compared only the Remotion
   * version, which is identical on both sides of the `zod` skew that made `remotion versions`
   * exit 1 — so what is compared here is every pin the template declares.
   */
  it("reports toolchain_stale for a workspace resolved for a different template", () => {
    const where = machine();
    recordTestToolchain(where);
    writeTestWorkspaceManifest({ ...where, pins: { ...readTemplatePins(), zod: "4.5.4" } });

    const status = checkToolchain(where);

    expect(status.reason).toBe(TOOLCHAIN_STALE);
    expect(status.detail).toContain("zod");
    expect(status.detail).toContain("remotion versions");
  });

  it("treats a marker from a newer build as a rollback signal and leaves it alone", () => {
    const where = machine();
    const marker = recordTestToolchain(where);
    writeToolchainMarker(where.stateDir, {
      ...marker,
      format_version: TOOLCHAIN_FORMAT_VERSION + 7,
    });

    const status = checkToolchain(where);

    expect(status.reason).toBe(TOOLCHAIN_STALE);
    expect(status.detail).toContain("rollback signal");
    expect(readToolchainMarker(where.stateDir)?.format_version).toBe(TOOLCHAIN_FORMAT_VERSION + 7);
  });
});

describe("firstPinSkew", () => {
  it("names the first disagreeing package in name order, and nothing when there is none", () => {
    const pins = { alpha: "1.0.0", zeta: "2.0.0" };

    expect(firstPinSkew({ alpha: "1.0.0", zeta: "2.0.0" }, pins)).toBeNull();
    expect(firstPinSkew({ alpha: "9.9.9", zeta: "0.0.1" }, pins)).toEqual({
      name: "alpha",
      expected: "1.0.0",
      found: "9.9.9",
    });
    expect(firstPinSkew({ zeta: "2.0.0" }, pins)).toEqual({
      name: "alpha",
      expected: "1.0.0",
      found: "nothing",
    });
  });
});

describe("hostPlatformKey", () => {
  it("is Node's own spelling, which is how the marker and the workspace manifest agree", () => {
    expect(hostPlatformKey()).toBe(`${process.platform}-${process.arch}`);
  });
});
