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
 * newer build, an `ffmpeg` whose size is no longer the size `setup` recorded, one that has lost its
 * execute bit, or one whose libavcodec is below the floor this build encodes with.
 *
 * **Both shapes either side of ADR 0031's cut are read, and judged the same way** (§Note,
 * 2026-11-12, D1). A version-1 marker records a workspace and no `ffmpeg`, a version-2 marker the
 * reverse; the workspace is not judged at all, because no render reads it. Whether a missing
 * `ffmpeg` stops anything is the **caller's** question, through {@link ToolchainCheck.requireFfmpeg}:
 * the schema leaves the component optional, and what a job needs is decided at the gate (D12).
 *
 * **What a job needs is decided by its kind** ({@link checkJobToolchain}, D12). A still draws one
 * frame and encodes nothing, so it needs the browser and speech the marker records and nothing about
 * ffmpeg — a recorded one that is gone or replaced does not stop it; a render also needs an encoder
 * — an `XPLAINER_FFMPEG` naming an executable by its absolute path, or else a valid `ffmpeg` in the
 * marker. The call (`backend.ts`), the worker factory (`daemon/workers.ts`) and `/healthz` all ask
 * that one function, so a tool call cannot be accepted for a job the factory then refuses, and
 * `/healthz` is degraded exactly when a render would be refused. `daemon status` takes `/healthz`'s
 * answer when the daemon gives one, because the override is the daemon's environment and not the
 * shell's that runs the status command.
 *
 * **Every check here is a `stat` or a read, never a hash and never a spawn.** `/healthz` asks it on
 * every request, so a replaced binary is caught by its size and not by re-hashing a hundred
 * megabytes, and a recorded libavcodec is compared without running the executable it describes.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import process from "node:process";
import type { Toolchain, ToolchainComponent, ToolchainFfmpeg } from "@xplainer/protocol";
import { readDaemonState } from "../daemon/daemon-state.js";
import { writeJsonDurably } from "../daemon/durable-write.js";
import {
  componentPaths,
  parseToolchainMarker,
  TOOLCHAIN_FORMAT_VERSION,
  toolchainMarkerPath,
} from "../install/preflight.js";
import {
  FFMPEG_ENV,
  ffmpegOverrideRefusal,
  isExecutableFile,
  readFfmpegOverride,
} from "../render/encode.js";
import {
  PRE_CUT_TOOLCHAIN_FORMAT,
  readRuntimeManifest,
  runtimeToolchainFormat,
} from "../runtime/manifest.js";

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
   * Leave the recorded `ffmpeg` out of the judgement altogether — its files, its size, its execute
   * bit and its libavcodec — for a caller that will not spawn it: a still, which encodes nothing,
   * and a render whose encoder is an `XPLAINER_FFMPEG` override (D12). Wins over
   * {@link requireFfmpeg}.
   */
  ignoreFfmpeg?: boolean | undefined;
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

  const ffmpeg = check.ignoreFfmpeg === true ? undefined : marker.ffmpeg;
  const recorded: readonly (readonly [string, ToolchainComponent | ToolchainFfmpeg])[] = [
    ["chrome", marker.chrome],
    ["speech", marker.speech],
    ...(ffmpeg === undefined ? [] : [["ffmpeg", ffmpeg] as const]),
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

  if (ffmpeg !== undefined) {
    const stale = staleFfmpeg(ffmpeg, check.ffmpegMinLibavcodec ?? FFMPEG_MIN_LIBAVCODEC);
    if (stale !== null) {
      return { ok: false, reason: TOOLCHAIN_STALE, marker, detail: stale };
    }
  } else if (check.requireFfmpeg === true && check.ignoreFfmpeg !== true) {
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
 * `null` when it is both. Two `stat`s and a read, and no execution, because `/healthz` asks on
 * every request: the execute bit is the worker's own question (`render/encode.ts`), asked here so a
 * binary that lost it is refused at the call rather than by a worker after the browser started.
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
  if (!isExecutableFile(ffmpeg.path)) {
    return (
      `the ffmpeg at ${ffmpeg.path} is not an executable file any more — it has lost the execute ` +
      "bit setup found it with — and a render spawns it. Run `xplainer setup`."
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

/** Which of the two kinds of job a toolchain is judged for: a still encodes nothing (D12). */
export type ToolchainJob = "still" | "render";

/** Where the job-kind gate looks, and for which kind of job. */
export type JobToolchainCheck = {
  stateDir: string;
  job: ToolchainJob;
  /**
   * The environment `XPLAINER_FFMPEG` is read from — the daemon's own, which is what its render
   * workers inherit. Defaults to this process's.
   */
  env?: Readonly<Record<string, string | undefined>> | undefined;
};

/**
 * Judge this machine's toolchain for one kind of job (ADR 0031 §Note, 2026-11-12, D12).
 *
 * A **still** needs the browser and speech the marker records, and nothing about ffmpeg: it encodes
 * nothing, so a recorded ffmpeg that is gone, replaced or too old does not stop it. A **render**
 * needs an encoder too, and either one will do: an `XPLAINER_FFMPEG` naming an executable file by
 * its absolute path — the worker spawns that and never the recorded one, so the recorded one is not
 * judged — or, with no override, an `ffmpeg` the marker records and that is still the file `setup`
 * probed. An override the worker would refuse is refused here instead, with the worker's sentence
 * ({@link ffmpegOverrideRefusal}), before a browser starts.
 */
export function checkJobToolchain(check: JobToolchainCheck): ToolchainStatus {
  if (check.job === "still") {
    return checkToolchain({ stateDir: check.stateDir, ignoreFfmpeg: true });
  }
  const named = readFfmpegOverride(check.env ?? process.env);
  if (named === null) {
    return checkToolchain({ stateDir: check.stateDir, requireFfmpeg: true });
  }
  const status = checkToolchain({ stateDir: check.stateDir, ignoreFfmpeg: true });
  const refusal = status.ok ? ffmpegOverrideRefusal(named) : null;
  if (refusal !== null) {
    return {
      ok: false,
      reason: TOOLCHAIN_MISSING,
      marker: status.marker,
      detail: `${refusal} A render spawns the ffmpeg ${FFMPEG_ENV} names.`,
    };
  }
  return status;
}

/** {@link checkJobToolchain} as a refusal: the marker when the job can run, a sentence when not. */
export function assertJobToolchainReady(check: JobToolchainCheck): Toolchain {
  const status = checkJobToolchain(check);
  if (!status.ok) {
    throw new Error(status.detail);
  }
  return status.marker;
}

/** One recorded component, as the two status commands print it. */
export type ToolchainComponentSummary = {
  version: string;
  provider: string;
  path: string;
};

/** The recorded ffmpeg, as the two status commands print it: what it is and whose it is. */
export type ToolchainFfmpegSummary = ToolchainComponentSummary & {
  licence: string;
  /** Who published it, or `null` for one named with `setup --ffmpeg-path`, which nobody vouches for. */
  publisher: string | null;
  libavcodec: string;
};

/**
 * An `XPLAINER_FFMPEG` set where a status command runs: a fact about that shell, reported beside the
 * marker's verdict and never folded into it.
 */
export type ToolchainOverrideSummary = {
  /** What the variable names. */
  path: string;
  /** The sentence a render gate would refuse it with, or `null` where it names an executable. */
  refusal: string | null;
};

/**
 * The toolchain as `xplainer status` and `daemon status` report it (ADR 0031 §Note, 2026-11-12,
 * D10): the render gate's verdict on **this machine's marker** — {@link checkJobToolchain} for a
 * render, at stat depth, with no override — what the marker records, component by component, and,
 * separately, an `XPLAINER_FFMPEG` the shell asking has set.
 */
export type ToolchainSummary = {
  /** `<state>/toolchain.json`. */
  path: string;
  /**
   * Whether the marker alone admits a render — what `/healthz` answers for a daemon that has no
   * `XPLAINER_FFMPEG`, which is every supervised one.
   */
  ok: boolean;
  /** `toolchain_missing` or `toolchain_stale` — `/healthz`'s own `reason` — or `null`. */
  reason: ToolchainReason | null;
  /** The gate's sentence when it refuses; what was checked when it does not. */
  detail: string;
  browser: ToolchainComponentSummary | null;
  ffmpeg: ToolchainFfmpegSummary | null;
  speech: ToolchainComponentSummary | null;
  /** `XPLAINER_FFMPEG` in the environment the summary was asked with, or `null` where it is unset. */
  override: ToolchainOverrideSummary | null;
};

/**
 * Judge and describe the toolchain, for a status report.
 *
 * **The verdict is the marker's alone**, never the asking shell's. A status command runs in one
 * environment and the daemon in another — a supervised daemon is started by launchd, systemd or Task
 * Scheduler and inherits no shell's `XPLAINER_FFMPEG` — so a verdict that consulted `env` described
 * a daemon nobody was running: `ready to render` beside `ffmpeg: not recorded`, and a `daemon
 * status` saying `ready` while `/healthz` said `degraded`. `env` is read only to report a set
 * override as a fact of its own ({@link ToolchainSummary.override}); what the *daemon* decides is
 * `/healthz`'s answer, which the status commands report when there is one.
 */
export function summariseToolchain(
  stateDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ToolchainSummary {
  const status = checkJobToolchain({ stateDir, job: "render", env: {} });
  const named = readFfmpegOverride(env);
  const marker = status.marker;
  const component = (recorded: ToolchainComponent | undefined): ToolchainComponentSummary | null =>
    recorded === undefined
      ? null
      : { version: recorded.version, provider: recorded.provider, path: recorded.path };
  return {
    path: toolchainMarkerPath(stateDir),
    ok: status.ok,
    reason: status.reason,
    detail: status.ok
      ? `${toolchainMarkerPath(stateDir)} records a browser, speech and an ffmpeg, every file it ` +
        "names is still there, and the ffmpeg is still the one setup probed"
      : status.detail,
    browser: component(marker?.chrome),
    ffmpeg:
      marker?.ffmpeg === undefined
        ? null
        : {
            version: marker.ffmpeg.version,
            provider: marker.ffmpeg.provider,
            path: marker.ffmpeg.path,
            licence: marker.ffmpeg.licence,
            publisher: marker.ffmpeg.publisher ?? null,
            libavcodec: marker.ffmpeg.libavcodec,
          },
    speech: component(marker?.speech),
    override: named === null ? null : { path: named, refusal: ffmpegOverrideRefusal(named) },
  };
}

/**
 * The `toolchain:` block both status commands print, one component to a line.
 *
 * `probed` is a URL `xplainer status` was told to ask — `--url` or `XPLAINER_DAEMON_URL`, which may
 * name another machine: the block is read from this machine's state directory whatever was probed,
 * so it says so rather than reading as that daemon's verdict.
 */
export function toolchainLines(summary: ToolchainSummary, probed: string | null = null): string[] {
  const { browser, ffmpeg, speech, override } = summary;
  const verdict = summary.ok ? "ready to render" : `${String(summary.reason)} — ${summary.detail}`;
  const lines = [
    `toolchain:       ${verdict}${
      probed === null
        ? ""
        : ` (read from this machine's toolchain.json; the daemon at ${probed} judges its own, ` +
          "on the daemon: line)"
    }`,
    `  browser:       ${browser === null ? "not recorded" : `${browser.version} (${browser.provider})`}`,
    `  ffmpeg:        ${
      ffmpeg === null
        ? "not recorded — stills only, every render is refused; run `xplainer setup`"
        : `${ffmpeg.version}, ${ffmpeg.licence}, ${
            ffmpeg.publisher === null
              ? "no publisher (named with --ffmpeg-path)"
              : `published by ${ffmpeg.publisher}`
          }, provider ${ffmpeg.provider}`
    }`,
    `  speech:        ${speech === null ? "not recorded" : `${speech.provider} (${speech.version})`}`,
  ];
  if (override !== null) {
    lines.push(
      `  ${FFMPEG_ENV}: ${override.path} — set in this shell, so a daemon started from it ` +
        `${
          override.refusal === null
            ? "renders with that file and not the recorded one"
            : `refuses every render: ${override.refusal}`
        }; a supervised daemon never inherits it`,
    );
  }
  return lines;
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

// ── ADR 0031's cut, as seen from the installed daemon ──────────────────────────────────────────

/**
 * The three commands that carry an installed daemon across the cut, in order (§Note, 2026-11-12,
 * D2). Printed and never run: whether to reinstall is the owner's step (Q3).
 */
export const REINSTALL_ACROSS_THE_CUT: readonly string[] = [
  "xplainer daemon uninstall",
  "xplainer setup",
  "xplainer daemon install",
];

/** Which `toolchain.json` format the daemon installed in a state directory reads, if there is one. */
export type InstalledDaemonFormat =
  | { installed: false }
  | {
      installed: true;
      /** `daemon.json`'s `runtime_dir`: the staged runtime the supervisor executes. */
      runtimeDir: string;
      /** Its manifest's `toolchain.format`, or format 1 when it has none or cannot be read. */
      format: number;
      /** Why its manifest could not be read, or `null` when it was. */
      unreadable: string | null;
    };

/**
 * Ask the installed daemon's own runtime which marker format it reads.
 *
 * **Through `daemon.json`'s `runtime_dir`, and never "whichever runtime is staged"**, for the reason
 * `commands/update.ts`'s `stagedRuntimeVersion` gives: an update stages a second runtime beside the
 * first, and only the registration says which of the two the supervisor runs. No `runtime_dir` is
 * no installed daemon — a machine that only ever ran `serve` in a terminal runs this very build.
 *
 * **A recorded runtime whose manifest cannot be read is format 1**, and says why. It is installed,
 * so something will start it, and the one thing a build that cannot read it can be sure of is that
 * it is not a runtime that wrote down which format it reads — which every one from before the cut
 * is. Treating it as current would be the one answer here that can break a daemon.
 *
 * @throws {StateFileUnreadableError} when `daemon.json` exists and cannot be read (exit `11`).
 */
export function installedDaemonFormat(stateDir: string): InstalledDaemonFormat {
  const runtimeDir = readDaemonState(stateDir).runtime_dir;
  if (runtimeDir === null) {
    return { installed: false };
  }
  try {
    const format = runtimeToolchainFormat(readRuntimeManifest(runtimeDir));
    return { installed: true, runtimeDir, format, unreadable: null };
  } catch (error) {
    const unreadable = error instanceof Error ? error.message : String(error);
    return { installed: true, runtimeDir, format: PRE_CUT_TOOLCHAIN_FORMAT, unreadable };
  }
}

/**
 * Why `command` must not run under the daemon installed in `stateDir`, or `null` when it may.
 *
 * `setup` and `update` both write a marker of this build's format — `update` because its first step
 * *is* `setup` — and a daemon that reads another format would then read the machine's record as
 * missing: a runtime from before the cut requires the `workspace` a version-2 marker no longer
 * carries. No update can move that daemon across, so the sentence ends in the reinstall and runs
 * none of it (§Note, 2026-11-12, D2 (b) and (c)). No daemon installed is no refusal.
 *
 * @throws {StateFileUnreadableError} when `daemon.json` exists and cannot be read (exit `11`).
 */
export function crossingTheCutRefusal(stateDir: string, command: string): string | null {
  const installed = installedDaemonFormat(stateDir);
  if (!installed.installed || installed.format === TOOLCHAIN_FORMAT_VERSION) {
    return null;
  }
  const which =
    installed.unreadable === null
      ? `runs the runtime at ${installed.runtimeDir}, which reads toolchain.json format ` +
        `${String(installed.format)}`
      : `records the runtime at ${installed.runtimeDir}, whose manifest cannot be read ` +
        `(${installed.unreadable}), so it is treated as a runtime from before the cut, which ` +
        `reads toolchain.json format ${String(PRE_CUT_TOOLCHAIN_FORMAT)}`;
  return (
    `${command}: the daemon installed in ${stateDir} ${which}, and this xplainer writes format ` +
    `${String(TOOLCHAIN_FORMAT_VERSION)}. A marker that daemon cannot read is a toolchain it ` +
    "reports as missing, and no update can carry an installed daemon from one format to the " +
    "other: crossing it is a reinstall. Nothing was run and nothing was written. Reinstall the " +
    "daemon with the xplainer you mean it to run:\n\n" +
    `${REINSTALL_ACROSS_THE_CUT.map((line) => `  ${line}`).join("\n")}\n`
  );
}
