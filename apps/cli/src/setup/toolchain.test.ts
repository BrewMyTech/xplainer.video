/**
 * The gate every render passes, asserted against real documents on disk.
 *
 * Each case here is a machine state a user can actually be in — setup never run, an artefact
 * cleaned away, a marker written before the cut, an ffmpeg replaced or too old — and what is
 * asserted is the *reason* and the *repair*, because those are what `/healthz` reports and what the
 * refusal on a job record tells someone to do. Nothing is stubbed: the marker is written by the
 * writer under test and read back by the reader under test, and every recorded ffmpeg is a real file
 * whose real size is what the gate stats.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { Toolchain, ToolchainFfmpeg } from "@xplainer/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { hashFile } from "../runtime/manifest.js";
import { recordTestToolchain } from "./testing/toolchain.js";
import {
  checkToolchain,
  FFMPEG_MIN_LIBAVCODEC,
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

/** A state directory, which is all a caller of the gate holds. */
function machine(): { stateDir: string } {
  return { stateDir: temporaryDirectory("xplainer-toolchain-state-") };
}

/**
 * A recorded ffmpeg over a real file under the state directory, in the shape the provider records.
 *
 * The executable is `files[0]` and its `bytes` are its real size, which is the one fact about it the
 * gate reads; a case about a replaced binary rewrites the file and leaves the record alone.
 */
function recordedFfmpeg(stateDir: string, libavcodec = "62.11.100"): ToolchainFfmpeg {
  const path = join(stateDir, "toolchain", "ffmpeg-9.0.2", "ffmpeg");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "a stand-in for the ffmpeg setup acquired\n");
  const sha256 = hashFile(path);
  return {
    version: "9.0.2",
    path,
    sha256,
    provider: "manifest",
    files: [{ path, sha256, bytes: statSync(path).size }],
    libavcodec,
    licence: "GPL-2.0-or-later",
    publisher: "xplainer.video",
    probe: { version: ["ffmpeg version 9.0.2"], buildconf: ["--enable-gpl"], license: ["GPL"] },
  };
}

/** The marker as a version-1 build wrote it: a `workspace`, no `ffmpeg`, `format_version` 1. */
function versionOneDocument(marker: Toolchain): Record<string, unknown> {
  return {
    format_version: 1,
    created_at: marker.created_at,
    chrome: marker.chrome,
    speech: marker.speech,
    workspace: { platform: hostPlatformKey(), version: "1.0.0" },
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

  it("writes version 2, with no workspace", () => {
    const where = machine();
    recordTestToolchain(where);

    const onDisk = JSON.parse(readFileSync(toolchainMarkerPath(where.stateDir), "utf8")) as Record<
      string,
      unknown
    >;

    expect(TOOLCHAIN_FORMAT_VERSION).toBe(2);
    expect(onDisk.format_version).toBe(2);
    expect(onDisk).not.toHaveProperty("workspace");
  });

  /**
   * ADR 0031 §Note, 2026-11-12, D1: a version-1 marker is a valid shape describing an incomplete
   * toolchain, not a corrupt document. Its `workspace` is not read, because nothing judges it.
   */
  it("reads a version-1 marker, workspace and all, as the two components it records", () => {
    const where = machine();
    const marker = recordTestToolchain(where);
    writeFileSync(toolchainMarkerPath(where.stateDir), JSON.stringify(versionOneDocument(marker)));

    expect(readToolchainMarker(where.stateDir)).toEqual({
      format_version: 1,
      created_at: marker.created_at,
      chrome: marker.chrome,
      speech: marker.speech,
    });
  });

  it("keeps a recorded ffmpeg through the writer and the validating reader", () => {
    const where = machine();
    const marker = recordTestToolchain(where);
    const ffmpeg = recordedFfmpeg(where.stateDir);

    writeToolchainMarker(where.stateDir, { ...marker, ffmpeg });

    expect(readToolchainMarker(where.stateDir)?.ffmpeg).toEqual(ffmpeg);
  });

  /**
   * Present and malformed rejects the whole document, for the reason `files` does: a reader that
   * dropped a component it could not parse would judge a render against a toolchain without it.
   */
  it("refuses a marker whose ffmpeg is not one, rather than reading it without one", () => {
    const where = machine();
    const marker = recordTestToolchain(where);
    const ffmpeg = recordedFfmpeg(where.stateDir);
    const broken: readonly Record<string, unknown>[] = [
      { ...ffmpeg, files: [] },
      { ...ffmpeg, libavcodec: "62" },
      { ...ffmpeg, probe: { version: [], buildconf: [] } },
      { ...ffmpeg, licence: "" },
    ];

    for (const value of broken) {
      writeFileSync(
        toolchainMarkerPath(where.stateDir),
        JSON.stringify({ ...marker, ffmpeg: value }),
      );
      expect(readToolchainMarker(where.stateDir), JSON.stringify(value)).toBeNull();
    }
  });
});

describe("checkToolchain", () => {
  it("passes a machine where setup has run", () => {
    const where = machine();
    recordTestToolchain(where);

    const status = checkToolchain(where);

    expect(status.ok).toBe(true);
    expect(status.reason).toBeNull();
    expect(status.marker?.format_version).toBe(TOOLCHAIN_FORMAT_VERSION);
  });

  /**
   * Nothing goes red at the cut: a marker written before it records everything a still and a render
   * needed then, and whether a missing ffmpeg stops a job is the caller's to say.
   */
  it("passes a version-1 marker, and one with no ffmpeg, unless the caller requires ffmpeg", () => {
    const where = machine();
    const marker = recordTestToolchain(where);

    expect(checkToolchain(where).ok).toBe(true);
    writeFileSync(toolchainMarkerPath(where.stateDir), JSON.stringify(versionOneDocument(marker)));
    expect(checkToolchain(where).ok).toBe(true);

    const required = checkToolchain({ ...where, requireFfmpeg: true });
    expect(required.reason).toBe(TOOLCHAIN_MISSING);
    expect(required.detail).toContain("records no ffmpeg");
    expect(required.detail).toContain("xplainer setup");
  });

  it("passes a recorded ffmpeg that is still the file setup recorded and new enough", () => {
    const where = machine();
    const marker = recordTestToolchain(where);
    writeToolchainMarker(where.stateDir, { ...marker, ffmpeg: recordedFfmpeg(where.stateDir) });

    expect(checkToolchain(where).ok).toBe(true);
    expect(checkToolchain({ ...where, requireFfmpeg: true }).ok).toBe(true);
  });

  it("reports toolchain_missing naming a recorded ffmpeg that was cleaned away", () => {
    const where = machine();
    const marker = recordTestToolchain(where);
    const ffmpeg = recordedFfmpeg(where.stateDir);
    writeToolchainMarker(where.stateDir, { ...marker, ffmpeg });
    rmSync(ffmpeg.path);

    // Missing whatever the caller asked: a recorded component that is gone is never "ready".
    const status = checkToolchain(where);

    expect(status.reason).toBe(TOOLCHAIN_MISSING);
    expect(status.detail).toContain(`ffmpeg (${ffmpeg.path})`);
  });

  /** The stat-only drift check: a replaced binary is a different size, and nothing is hashed. */
  it("reports toolchain_stale when the ffmpeg on disk is not the size setup recorded", () => {
    const where = machine();
    const marker = recordTestToolchain(where);
    const ffmpeg = recordedFfmpeg(where.stateDir);
    writeToolchainMarker(where.stateDir, { ...marker, ffmpeg });
    writeFileSync(ffmpeg.path, "a different binary, put here after setup checked the first one\n");

    const status = checkToolchain(where);

    expect(status.reason).toBe(TOOLCHAIN_STALE);
    expect(status.detail).toContain("replaced since setup checked it");
    expect(status.detail).toContain("xplainer setup");
  });

  it("reports toolchain_stale for a recorded libavcodec below the floor", () => {
    const where = machine();
    const marker = recordTestToolchain(where);
    writeToolchainMarker(where.stateDir, {
      ...marker,
      ffmpeg: recordedFfmpeg(where.stateDir, "59.37.100"),
    });

    const status = checkToolchain(where);

    expect(FFMPEG_MIN_LIBAVCODEC).toBe(60);
    expect(status.reason).toBe(TOOLCHAIN_STALE);
    expect(status.detail).toContain("libavcodec 59.37.100");
    expect(status.detail).toContain("libavcodec 60 or newer");
    // The floor is the caller's when it names one: an incoming runtime's own, for `daemon update`.
    expect(checkToolchain({ ...where, ffmpegMinLibavcodec: 59 }).ok).toBe(true);
    expect(checkToolchain({ ...where, ffmpegMinLibavcodec: 63 }).reason).toBe(TOOLCHAIN_STALE);
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

describe("hostPlatformKey", () => {
  it("is Node's own spelling, which is how setup reports this machine", () => {
    expect(hostPlatformKey()).toBe(`${process.platform}-${process.arch}`);
  });
});
