/**
 * `toolchain.json` — what `setup` acquired, and the one gate every render passes first.
 *
 * The document itself is a checked contract (`packages/protocol/schemas/toolchain.json`) and this
 * module is the only place in the CLI that writes it and the only place that judges it. Three
 * surfaces read what is written here and none of them owns it: `daemon install`'s read-only
 * preflight (`install/preflight.ts`, whose `parseToolchainMarker` is the one reader both use),
 * `daemon update`'s compatibility check, and the daemon itself, at two points.
 *
 * **The gate exists because the daemon never downloads.** ADR 0005 makes acquisition a visible,
 * interruptible user step and ADR 0020 §Degraded paths makes its absence a *reported* condition
 * rather than a failure: "a several-hundred-megabyte fetch is an explicit, interruptible step and
 * not something a background service does on someone's tethered connection". So a daemon whose
 * toolchain is gone must say so at the two moments it can be observed — when a render job leaves
 * the queue, and on `/healthz` — instead of letting `spawn` produce an `ENOENT` inside a worker
 * whose log tail is the only evidence anybody gets.
 *
 * **Two reasons, and they are different repairs.** {@link TOOLCHAIN_MISSING} is "what setup
 * recorded is not here": no marker at all, a marker that cannot be read, a recorded path that has
 * been cleaned away, an `ffmpeg` a caller requires and the marker does not record.
 * {@link TOOLCHAIN_STALE} is "what setup recorded is here and is the wrong thing": a marker from a
 * newer build, an `ffmpeg` whose size is no longer the size `setup` recorded, or one whose
 * libavcodec is below the floor this build encodes with.
 *
 * **Both shapes either side of ADR 0031's cut are read, and judged the same way** (§Note,
 * 2026-11-12, D1). A version-1 marker records a workspace and no `ffmpeg`, a version-2 marker the
 * reverse; the workspace is not judged at all, because no render reads it. Whether a missing
 * `ffmpeg` stops anything is the **caller's** question, through {@link ToolchainCheck.requireFfmpeg}:
 * the schema leaves the component optional, and what a job needs is decided at the gate (D12).
 *
 * **Every check here is a `stat` or a read, never a hash and never a spawn.** `/healthz` asks it on
 * every request, so a replaced binary is caught by its size and not by re-hashing a hundred
 * megabytes, and a recorded libavcodec is compared without running the executable it describes.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import process from "node:process";
import type { Toolchain, ToolchainComponent, ToolchainFfmpeg } from "@xplainer/protocol";
import { writeJsonDurably } from "../daemon/durable-write.js";
import {
  componentPaths,
  parseToolchainMarker,
  TOOLCHAIN_FORMAT_VERSION,
  toolchainMarkerPath,
} from "../install/preflight.js";

export { componentPaths, TOOLCHAIN_FORMAT_VERSION, toolchainMarkerPath };

/** The `reason` `/healthz` reports when what `setup` recorded is not on this machine. */
export const TOOLCHAIN_MISSING = "toolchain_missing";

/** The `reason` `/healthz` reports when what is on this machine is no longer the right thing. */
export const TOOLCHAIN_STALE = "toolchain_stale";

/**
 * The oldest libavcodec major this build encodes with: FFmpeg 6.0.
 *
 * A code constant and not a manifest field, because it is a fact about the argv this build hands
 * the encoder rather than about any artefact. A runtime records it in its own manifest's
 * `toolchain` block so that `daemon update` can judge a marker against the runtime it would
 * install rather than against the one doing the asking.
 */
export const FFMPEG_MIN_LIBAVCODEC = 60;

/** One of the two conditions this gate distinguishes. */
export type ToolchainReason = typeof TOOLCHAIN_MISSING | typeof TOOLCHAIN_STALE;

/**
 * What the gate found.
 *
 * A discriminated union rather than a record with a nullable reason, so a caller that has checked
 * `ok` has the marker and a caller that has not has a sentence: "degraded, and there is no reason"
 * is not a state this module can be in.
 */
export type ToolchainStatus =
  | { ok: true; reason: null; marker: Toolchain; detail: null }
  | { ok: false; reason: ToolchainReason; marker: Toolchain | null; detail: string };

/** Where the gate looks, and what the caller needs of it. */
export type ToolchainCheck = {
  /** The daemon's state directory — `<state>/toolchain.json` is the marker. */
  stateDir: string;
  /**
   * Whether a marker that records no `ffmpeg` is incomplete for this caller.
   *
   * `false` by default, which judges exactly what the gate judged before FFmpeg was a component: a
   * still encodes nothing, and a marker written before FFmpeg was acquired is a valid document. An
   * `ffmpeg` the marker *does* record is always checked, whatever this says — a recorded component
   * that is gone or replaced is never "ready". The callers that pass `true` are the ones for which
   * the encoder is the point: a render job (ADR 0031 §Note, 2026-11-12, D12), and `daemon update`
   * judging the marker against an incoming runtime that declares a libavcodec floor (D2).
   */
  requireFfmpeg?: boolean | undefined;
  /**
   * The libavcodec major a recorded `ffmpeg` must reach. Defaults to {@link FFMPEG_MIN_LIBAVCODEC};
   * `daemon update` passes the incoming runtime's own, which is the floor that runtime encodes with.
   */
  ffmpegMinLibavcodec?: number | undefined;
};

/**
 * Read `<state>/toolchain.json`, or `null` where there is no readable marker.
 *
 * Shape is validated rather than cast, because this is data arriving from disk and the file being
 * a `.json` says nothing about what is in it — by `install/preflight.ts`'s `parseToolchainMarker`,
 * so the install preflight and this gate read one document one way. Either side of the cut is
 * accepted: a version-1 marker comes back without its `workspace`, which nothing reads. A marker
 * written by a **newer** build is returned rather than refused: its `format_version` is reported by
 * the gate, which is the rollback signal the schema asks for and not corruption.
 */
export function readToolchainMarker(stateDir: string): Toolchain | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(toolchainMarkerPath(stateDir), "utf8"));
  } catch {
    return null;
  }
  return parseToolchainMarker(parsed);
}

/**
 * Write the marker durably, at `<state>/toolchain.json`.
 *
 * `writeJsonDurably` is the same temp-file-plus-rename-plus-`fsync` every other durable state file
 * in this daemon is written with, and it matters here for the reason it matters there: a marker
 * half-written by a `setup` that was interrupted is a marker `install` would read as corrupt on a
 * machine where the toolchain is in fact fine.
 */
export function writeToolchainMarker(stateDir: string, marker: Toolchain): string {
  const path = toolchainMarkerPath(stateDir);
  writeJsonDurably(path, marker);
  return path;
}

/** `<platform>-<arch>` in Node's own spelling, which is how `setup` reports this machine. */
export function hostPlatformKey(): string {
  return `${process.platform}-${process.arch}`;
}

/**
 * Judge this machine's toolchain: the marker, every path it records, and the FFmpeg it records.
 *
 * The order is the order the repairs are in, and every one of them is `xplainer setup`: a missing
 * marker, a marker whose paths are gone, an FFmpeg that has been replaced or is too old, and — for
 * a caller that requires one — an FFmpeg the marker does not record at all. The sentence says which
 * so the user is not left to diff a file against a directory.
 */
export function checkToolchain(check: ToolchainCheck): ToolchainStatus {
  const markerPath = toolchainMarkerPath(check.stateDir);
  const marker = readToolchainMarker(check.stateDir);
  if (marker === null) {
    return {
      ok: false,
      reason: TOOLCHAIN_MISSING,
      marker: null,
      detail:
        `${markerPath} is missing or does not record a complete toolchain, so nothing on this ` +
        "machine says the browser and the speech provider a render needs are here. Neither the " +
        "daemon nor an install ever downloads them. Run `xplainer setup`.",
    };
  }
  if (marker.format_version > TOOLCHAIN_FORMAT_VERSION) {
    return {
      ok: false,
      reason: TOOLCHAIN_STALE,
      marker,
      detail:
        `${markerPath} says format_version ${marker.format_version} and this build reads ` +
        `${TOOLCHAIN_FORMAT_VERSION}. The marker was written by a newer xplainer and is left ` +
        "exactly as it is: this is a rollback signal, not corruption. Run `xplainer setup` from " +
        "the runtime that is installed now.",
    };
  }

  const recorded: readonly (readonly [string, ToolchainComponent | ToolchainFfmpeg])[] = [
    ["chrome", marker.chrome],
    ["speech", marker.speech],
    ...(marker.ffmpeg === undefined ? [] : [["ffmpeg", marker.ffmpeg] as const]),
  ];
  // Every recorded path, not only `path`. A component made of several files — the ONNX speech
  // route's model, voice and platform runtime — records them all in `files`, and checking only the
  // one `path` happens to name would report a toolchain as present when the runtime beside it had
  // been cleaned away. `path` is included as well and first, so a marker with no `files` is checked
  // exactly as it always was.
  const gone = recorded
    .flatMap(([name, component]) => componentPaths(component).map((path) => [name, path] as const))
    .filter(([, path]) => !existsSync(path))
    .map(([name, path]) => `${name} (${path})`);
  if (gone.length > 0) {
    return {
      ok: false,
      reason: TOOLCHAIN_MISSING,
      marker,
      detail:
        `${markerPath} records a toolchain whose files are no longer on this machine: ` +
        `${gone.join(", ")}. The marker says setup ran; the paths say what it produced has since ` +
        "been moved or cleaned away. Run `xplainer setup`.",
    };
  }

  if (marker.ffmpeg !== undefined) {
    const stale = staleFfmpeg(marker.ffmpeg, check.ffmpegMinLibavcodec ?? FFMPEG_MIN_LIBAVCODEC);
    if (stale !== null) {
      return { ok: false, reason: TOOLCHAIN_STALE, marker, detail: stale };
    }
  } else if (check.requireFfmpeg === true) {
    return {
      ok: false,
      reason: TOOLCHAIN_MISSING,
      marker,
      detail:
        `${markerPath} records no ffmpeg. Every render pipes its frames to an ffmpeg process and ` +
        "there is no built-in encoder to fall back on, and a marker written before ffmpeg was " +
        "acquired says nothing about one. Run `xplainer setup`.",
    };
  }

  return { ok: true, reason: null, marker, detail: null };
}

/**
 * Why a recorded FFmpeg is not the one `setup` recorded, or not one this build encodes with — or
 * `null` when it is both. Two reads and no execution, because `/healthz` asks on every request.
 */
function staleFfmpeg(ffmpeg: ToolchainFfmpeg, floor: number): string | null {
  const [binary] = ffmpeg.files;
  const size = statSync(binary.path).size;
  if (size !== binary.bytes) {
    return (
      `the ffmpeg at ${binary.path} is ${String(size)} bytes and setup recorded ` +
      `${String(binary.bytes)}: it has been replaced since setup checked it. Run ` +
      "`xplainer setup`."
    );
  }
  const major = Number(ffmpeg.libavcodec.split(".")[0]);
  if (major < floor) {
    return (
      `the ffmpeg at ${ffmpeg.path} is ${ffmpeg.version} (libavcodec ${ffmpeg.libavcodec}) and ` +
      `this build needs libavcodec ${String(floor)} or newer, which is FFmpeg 6.0. Run ` +
      "`xplainer setup`."
    );
  }
  return null;
}

/**
 * Refuse a render whose toolchain is not usable, by name and before anything is spawned.
 *
 * This is the last gate ADR 0018 layer 4 describes and it runs in the worker factory, in the
 * daemon, at the moment the job leaves the queue — so the job fails with this sentence in its own
 * record rather than with an `ENOENT` in a log tail.
 */
export function assertToolchainReady(check: ToolchainCheck): Toolchain {
  const status = checkToolchain(check);
  if (!status.ok) {
    throw new Error(status.detail);
  }
  return status.marker;
}
