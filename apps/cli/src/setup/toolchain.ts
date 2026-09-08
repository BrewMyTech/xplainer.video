/**
 * `toolchain.json` — what `setup` acquired, and the one gate every render passes first.
 *
 * The document itself is a checked contract (`packages/protocol/schemas/toolchain.json`) and this
 * module is the only place in the CLI that writes it and the only place that judges it. Three
 * surfaces read what is written here and none of them owns it: `daemon install`'s read-only
 * preflight (`install/preflight.ts`), `daemon update`'s compatibility check, and — added by this
 * story — the daemon itself, at two points.
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
 * been cleaned away, a workspace with no Remotion in it. {@link TOOLCHAIN_STALE} is "what setup
 * recorded is here and is the wrong thing": a workspace resolved for another platform, or one whose
 * installed Remotion no longer matches the template this build ships. The second is exactly the
 * skew decision D2 was written for — round 3's staleness check compared only the Remotion version,
 * which is identical on both sides of the skew that made `remotion versions` exit `1` — so the
 * comparison here is over **every** pin the template declares, not over one package.
 *
 * **The workspace is checked from its own manifest, never re-hashed.** `runtime verify --workspace`
 * re-hashes a payload and refuses anything the manifest does not describe, which is right for an
 * artefact and wrong for a live workspace: `videos/`, `public/` and `out/` are files the manifest
 * has never described and never should. So this gate reads `workspace.manifest.json` and compares
 * its recorded resolution against the template's pins, and leaves re-hashing to the command whose
 * subject is the payload.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import type { Toolchain, ToolchainComponent } from "@xplainer/protocol";
import { writeJsonDurably } from "../daemon/durable-write.js";
import { TOOLCHAIN_FORMAT_VERSION, toolchainMarkerPath } from "../install/preflight.js";
import { WORKSPACE_MANIFEST_FILE } from "../runtime/manifest.js";
import { readTemplatePins } from "../runtime/verify.js";
import { readWorkspaceResolution } from "./providers/workspace.js";

export { TOOLCHAIN_FORMAT_VERSION, toolchainMarkerPath };

/** The `reason` `/healthz` reports when what `setup` recorded is not on this machine. */
export const TOOLCHAIN_MISSING = "toolchain_missing";

/** The `reason` `/healthz` reports when what is on this machine is no longer the right thing. */
export const TOOLCHAIN_STALE = "toolchain_stale";

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

/** Where the gate looks. Both paths are resolved by the caller, never by this module. */
export type ToolchainCheck = {
  /** The daemon's state directory — `<state>/toolchain.json` is the marker. */
  stateDir: string;
  /** The shared Remotion workspace root, as `workspace-root.ts` resolved it. */
  workspaceRoot: string;
};

/**
 * Read `<state>/toolchain.json`, or `null` where there is no readable marker.
 *
 * Shape is validated rather than cast, because this is data arriving from disk and the file being
 * a `.json` says nothing about what is in it. A marker written by a **newer** build is returned
 * rather than refused: its `format_version` is reported by the gate, which is the rollback signal
 * the schema asks for and not corruption.
 */
export function readToolchainMarker(stateDir: string): Toolchain | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(toolchainMarkerPath(stateDir), "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const document = parsed as Record<string, unknown>;
  const chrome = asComponent(document.chrome);
  const speech = asComponent(document.speech);
  const workspace = asWorkspace(document.workspace);
  if (
    typeof document.format_version !== "number" ||
    typeof document.created_at !== "string" ||
    chrome === null ||
    speech === null ||
    workspace === null
  ) {
    return null;
  }
  return {
    format_version: document.format_version,
    created_at: document.created_at,
    chrome,
    speech,
    workspace,
  };
}

function asComponent(value: unknown): ToolchainComponent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const fields = ["version", "path", "sha256", "provider"] as const;
  for (const field of fields) {
    if (typeof entry[field] !== "string" || entry[field] === "") {
      return null;
    }
  }
  return {
    version: entry.version as string,
    path: entry.path as string,
    sha256: entry.sha256 as string,
    provider: entry.provider as string,
  };
}

function asWorkspace(value: unknown): Toolchain["workspace"] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.platform !== "string" || typeof entry.version !== "string") {
    return null;
  }
  if (entry.platform === "" || entry.version === "") {
    return null;
  }
  return { platform: entry.platform, version: entry.version };
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

/** `<platform>-<arch>` in Node's own spelling, which is how the marker records a workspace. */
export function hostPlatformKey(): string {
  return `${process.platform}-${process.arch}`;
}

/**
 * Judge this machine's toolchain: the marker, the two recorded paths, and the workspace.
 *
 * The order is the order the repairs are in. A missing marker is `xplainer setup`; a marker whose
 * paths are gone is the same command; a workspace with no Remotion is `xplainer setup --workspace`;
 * a workspace that is the wrong one is that command too, and the message says which pin disagrees
 * so the user is not left to diff two trees.
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

  const recorded: readonly (readonly [string, ToolchainComponent])[] = [
    ["chrome", marker.chrome],
    ["speech", marker.speech],
  ];
  const gone = recorded
    .filter(([, component]) => !existsSync(component.path))
    .map(([name, component]) => `${name} (${component.path})`);
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

  return checkWorkspace(check.workspaceRoot, marker);
}

/** The workspace half: installed at all, resolved for this machine, and still the template's tree. */
function checkWorkspace(workspaceRoot: string, marker: Toolchain): ToolchainStatus {
  const manifestFile = join(workspaceRoot, WORKSPACE_MANIFEST_FILE);
  const resolution = readWorkspaceResolution(workspaceRoot);
  if (resolution === null) {
    return {
      ok: false,
      reason: TOOLCHAIN_MISSING,
      marker,
      detail:
        `the Remotion workspace at ${workspaceRoot} has no ${WORKSPACE_MANIFEST_FILE} beside an ` +
        "installed tree, so there is nothing to render with. Run `xplainer setup --workspace`.",
    };
  }
  if (resolution.platform !== hostPlatformKey()) {
    return {
      ok: false,
      reason: TOOLCHAIN_STALE,
      marker,
      detail:
        `${manifestFile} records a workspace resolved for ${resolution.platform} and this machine ` +
        `is ${hostPlatformKey()}. @remotion/compositor-<platform> is a platform-specific optional ` +
        "dependency, so that tree cannot render here. Run `xplainer setup --workspace`.",
    };
  }
  if (marker.workspace.platform !== resolution.platform) {
    return {
      ok: false,
      reason: TOOLCHAIN_STALE,
      marker,
      detail:
        `the marker records a ${marker.workspace.platform} workspace and ${manifestFile} records ` +
        `a ${resolution.platform} one. The two describe the same directory and disagree about ` +
        "what is in it. Run `xplainer setup --workspace`.",
    };
  }

  // The manifest's `pins` and not its `resolved`: `pins` is what this workspace was resolved
  // **for**, and a daemon update that changes a template pin changes what this build wants while
  // leaving what is on disk exactly as it was. Comparing the tree instead would re-ask a question
  // `setup` already answered strictly at acquisition (`assertPinsSatisfied`) and would say nothing
  // about the skew this gate exists to catch. Every pin, never only Remotion's — that narrowing is
  // what made round 3's check blind to the `zod` skew `remotion versions` exits 1 on (D2).
  const skew = firstPinSkew(resolution.pins, readTemplatePins());
  if (skew !== null) {
    return {
      ok: false,
      reason: TOOLCHAIN_STALE,
      marker,
      detail:
        `the workspace at ${workspaceRoot} was resolved for ${skew.name} ${skew.found} and this ` +
        `build's template pins ${skew.expected}. Remotion polices its own tree — ` +
        "`remotion versions` exits 1 on a skew like this one — so the render would fail after the " +
        "job had started. Run `xplainer setup --workspace`.",
    };
  }

  return { ok: true, reason: null, marker, detail: null };
}

/** The first pin the installed tree disagrees with, in name order, or `null` when none does. */
export function firstPinSkew(
  resolved: Readonly<Record<string, string>>,
  pins: Readonly<Record<string, string>>,
): { name: string; expected: string; found: string } | null {
  for (const name of Object.keys(pins).sort()) {
    const expected = pins[name] as string;
    const found = resolved[name];
    if (found === undefined) {
      return { name, expected, found: "nothing" };
    }
    if (found !== expected) {
      return { name, expected, found };
    }
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
