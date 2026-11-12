/**
 * Where version B comes from, and the pre-drain precondition that decides whether it may be used.
 *
 * Two things live here because they are the same half of the transaction: **everything that happens
 * before anything is written**. ADR 0020's rule for every degraded path — "probe before writing; on
 * refusal, write nothing, exit with the documented code, and print the one command that fixes it" —
 * is what this file is for, and the plan's D9 as amended by §1.3d decision A is the refusal it
 * carries.
 *
 * ## The source of version B is explicit
 *
 * `--from <runtime dir>`, or a freshly assembled payload (T2). Never "whatever is on `PATH` now":
 * the whole reason `daemon update` exists is that ADR 0025 §Part one measured a package manager
 * replacing the *global* CLI while the supervisor kept executing the **pinned copy under the state
 * directory** — so an updater that resolved its own replacement from `PATH` would be reasoning from
 * the one fact the record establishes as unreliable.
 *
 * **The second half of that argument expired on 2026-09-11 and the conclusion did not.** It used to
 * read "there is no registry route this phase, and `install/program.ts` already refuses
 * `package-manager` by name for the same reason: nothing is published." Both clauses are now false
 * — `xplainer` is on npm and `daemon install` builds its own payload from an installed copy. What
 * survives is why this module still takes a payload rather than finding one: `--build` assembles
 * from *this program's own checkout*, and `--from <dir>` names a payload a caller already has.
 * Neither resolves anything off `PATH`, which is the property the paragraph above is about.
 *
 * What the publish *did* change is one line in `transaction.ts`: its guard refused every
 * `program_source` but `runtime-dir`, which silently closed `daemon update` for every npm-installed
 * machine until `package-manager` was admitted beside it. Both are staged payload-1 runtimes,
 * content-addressed in the same place; `explicit` and `sea-binary` are not, and are still refused.
 *
 * ## The precondition is three clauses, and refusal-only
 *
 * 1. **The installed and incoming runtimes read the same `toolchain.json` format.** ADR 0031's cut
 *    (§Note, 2026-11-12, D2 (a)) moved the marker from format 1 — which records a workspace — to
 *    format 2, which records an `ffmpeg` and no workspace. A daemon on one side of it reads the
 *    other side's marker as a missing toolchain, and a rollback across it would land on exactly
 *    that daemon, so crossing the cut in either direction is a reinstall. A payload built before
 *    the cut declares no format and reads as format 1, and so does an installed runtime whose
 *    manifest this build cannot read.
 * 2. **The two runtimes' template pins are identical** — pins, never the template package's own
 *    `version`, which is `1.0.0` and need not change when a pin does. ADR 0027's decision A, and it
 *    leaves with payload 2: the workspace those pins resolve survives updates by design, so an
 *    update that changed them would report success and break the next render.
 * 3. **The marker satisfies the incoming runtime's own `toolchain` requirements**, as
 *    `setup/toolchain.ts`'s `checkToolchain` judges them — its `ffmpeg` recorded, present, the size
 *    `setup` recorded, and at or above the libavcodec floor that runtime encodes with. This takes
 *    the place of the two clauses that re-hashed the installed workspace against both runtimes'
 *    pins: no render reads the workspace any more, and update readiness is only a `200` while a
 *    degraded `/healthz` is a `200` as well — so an update to a runtime the marker cannot serve
 *    would report success over a daemon that answers and cannot render, the failure class the
 *    plan's principle P2 exists for. Only the incoming runtime's requirements are asked, because it
 *    is the one that reads the marker next; clause 1 is what keeps the rollback target reading the
 *    same format of the same file.
 *
 * **There is no paired path (D9).** Staging a matching payload 2 beside the new runtime does not
 * let the update proceed. That route made the workspace part of an update without making it part of
 * the transaction — this transaction retains and journals exactly one payload — so a failed
 * readiness rolled payload 1 back and left B's workspace in place, which is a daemon that answers
 * and cannot render with every rollback assertion passing. Refusal keeps one payload transactional,
 * and the paired stage-and-switch is recorded as the successor's work.
 *
 * **Every refusal names the command that ends it.** Across the cut that is the reinstall —
 * `xplainer daemon uninstall`, `xplainer setup`, `xplainer daemon install` — and nothing here runs
 * it. A pin change names the new runtime's own interpreter and entry, because `xplainer` in
 * `<state>/bin` is the stable launcher and it `exec`s the **installed** runtime, which carries A's
 * template. A marker the incoming runtime cannot use names `xplainer setup`, which is what writes
 * one.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRECONDITION_UNMET_EXIT_CODE } from "../../daemon/exit-codes.js";
import { assembleRuntime } from "../../runtime/assemble.js";
import {
  PAYLOAD_LIB_DIR,
  PRE_CUT_TOOLCHAIN_FORMAT,
  type RuntimeManifest,
  readRuntimeManifest,
  runtimeToolchainFormat,
} from "../../runtime/manifest.js";
import {
  checkToolchain,
  REINSTALL_ACROSS_THE_CUT,
  toolchainMarkerPath,
} from "../../setup/toolchain.js";
import { type StageOutcome, stageRuntime } from "../stage.js";

/** The package whose `template/` directory declares the workspace's pins. */
export const TEMPLATE_PACKAGE = "@xplainer/render-core";

/** Where that package keeps the manifest the pins are read from. */
export const TEMPLATE_MANIFEST = "template/package.json";

/** Why the precondition refused. One value per distinguishable condition, never a catch-all. */
export type PreconditionReason =
  | "template-unreadable"
  | "format-differs"
  | "pins-differ"
  | "toolchain-unsatisfied";

/**
 * A precondition of updating was not met, and nothing has been staged or drained.
 *
 * It carries ADR 0020's `3` — the constant `exit-codes.ts` already exports — because every
 * condition here is knowable before a single byte is written, which is the shape that record gives
 * code `3`. No new code is invented: D9 says so in as many words.
 */
export class UpdatePrecondition extends Error {
  readonly reason: PreconditionReason;
  readonly exitCode: number = PRECONDITION_UNMET_EXIT_CODE;

  constructor(reason: PreconditionReason, message: string) {
    super(message);
    this.name = "UpdatePrecondition";
    this.reason = reason;
  }
}

/** Where a runtime's `template/package.json` is inside a payload, or `null` when it carries none. */
function templateManifestPath(
  runtimeDir: string,
  manifest: RuntimeManifest | null = null,
): string | null {
  const fromManifest = manifest?.packages.find((entry) => entry.name === TEMPLATE_PACKAGE);
  const candidates = [
    ...(fromManifest === undefined ? [] : [join(runtimeDir, ...fromManifest.path.split("/"))]),
    join(runtimeDir, ...PAYLOAD_LIB_DIR.split("/"), ...TEMPLATE_PACKAGE.split("/")),
  ];
  for (const candidate of candidates) {
    const file = join(candidate, ...TEMPLATE_MANIFEST.split("/"));
    if (existsSync(file)) {
      return file;
    }
  }
  return null;
}

/**
 * The pins a runtime's own template declares — `dependencies` and `devDependencies` in one map.
 *
 * Deliberately the same two fields `runtime/verify.ts`'s `readTemplatePins()` reads, and
 * deliberately **not** that function: it reads the template of the CLI *this process is running
 * from*, which is neither of the two runtimes being compared here. Same document, two other copies.
 *
 * @throws {UpdatePrecondition} when the payload carries no template, or one that cannot be read.
 * A runtime whose pins cannot be established cannot be compared, and an update that skipped the
 * comparison would be the unchecked upgrade D9 exists to refuse.
 */
export function templatePinsOf(
  runtimeDir: string,
  side: string,
  manifest: RuntimeManifest | null = null,
): Record<string, string> {
  const file = templateManifestPath(runtimeDir, manifest);
  if (file === null) {
    throw new UpdatePrecondition(
      "template-unreadable",
      `the ${side} runtime at ${runtimeDir} carries no ${TEMPLATE_PACKAGE}/${TEMPLATE_MANIFEST}, ` +
        `so the workspace pins it would resolve cannot be read. An update is allowed only when ` +
        `both runtimes pin the same workspace, and a payload that cannot say what it pins cannot ` +
        `be compared. Nothing was staged and nothing was drained.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new UpdatePrecondition(
      "template-unreadable",
      `the ${side} runtime's ${file} could not be read as JSON: ` +
        `${error instanceof Error ? error.message : String(error)}. Nothing was staged and ` +
        `nothing was drained.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UpdatePrecondition(
      "template-unreadable",
      `the ${side} runtime's ${file} is not a JSON object, so it declares no pins. Nothing was ` +
        `staged and nothing was drained.`,
    );
  }
  const document = parsed as Record<string, unknown>;
  const pins: Record<string, string> = {};
  for (const field of ["dependencies", "devDependencies"]) {
    const group = document[field];
    if (typeof group !== "object" || group === null || Array.isArray(group)) {
      continue;
    }
    for (const [name, range] of Object.entries(group as Record<string, unknown>)) {
      if (typeof range === "string") {
        pins[name] = range;
      }
    }
  }
  return pins;
}

/** One package the two templates disagree about. */
export type PinDifference = {
  name: string;
  /** What the installed runtime pins, or `null` when it does not pin it at all. */
  installed: string | null;
  /** What the incoming runtime pins, or `null` when it does not pin it at all. */
  incoming: string | null;
};

/** Every package the two pin maps disagree about, in name order. */
function pinDifferences(
  installed: Record<string, string>,
  incoming: Record<string, string>,
): PinDifference[] {
  const names = [...new Set([...Object.keys(installed), ...Object.keys(incoming)])].sort();
  const differences: PinDifference[] = [];
  for (const name of names) {
    const left = installed[name] ?? null;
    const right = incoming[name] ?? null;
    if (left !== right) {
      differences.push({ name, installed: left, incoming: right });
    }
  }
  return differences;
}

/** What {@link requireCompatibleUpdate} was asked to weigh. */
export type CompatibilityRequest = {
  /** The staged runtime the daemon is installed from — A, and the rollback target. */
  installedRuntimeDir: string;
  /** The payload-1 directory the update would switch to — B. */
  incomingRuntimeDir: string;
  /** The daemon's state directory, whose `toolchain.json` both runtimes read. */
  stateDir: string;
  /** The incoming payload's manifest, when the caller has already read it. */
  incomingManifest?: RuntimeManifest | null | undefined;
  /** The installed payload's manifest, when the caller has already read it. */
  installedManifest?: RuntimeManifest | null | undefined;
  /**
   * How the new runtime's own program is spelled, for the reinstall path the refusal names.
   *
   * The installed launcher cannot run it — it `exec`s A — so the message has to name the incoming
   * payload's interpreter and entry, and the caller has already resolved both.
   */
  incomingProgram: string;
};

/** The three clauses, and what they agreed on. */
export type CompatibilityVerdict = {
  /** The pins both runtimes declare, which are identical by the time this is returned. */
  pins: Record<string, string>;
  /** The `toolchain.json` format both runtimes read, which is one by the time this is returned. */
  format: number;
};

/** A runtime's manifest as the caller passed it, read here when it did not, `null` if unreadable. */
function manifestOf(
  runtimeDir: string,
  given: RuntimeManifest | null | undefined,
): RuntimeManifest | null {
  if (given !== null && given !== undefined) {
    return given;
  }
  try {
    return readRuntimeManifest(runtimeDir);
  } catch {
    return null;
  }
}

/**
 * The marker format a runtime reads: its manifest's `toolchain.format`, or format 1.
 *
 * Format 1 for a payload built before the cut, which declares none, **and** for one whose manifest
 * cannot be read here: such a runtime cannot have said which format it reads, and every runtime
 * that cannot say is one from before the cut. Treating it as current is the one answer that lets an
 * update cross the cut unnoticed.
 */
function formatOf(manifest: RuntimeManifest | null): number {
  return manifest === null ? PRE_CUT_TOOLCHAIN_FORMAT : runtimeToolchainFormat(manifest);
}

/**
 * The three-clause pre-drain check. Returns, or refuses with exit `3` having touched nothing.
 *
 * @throws {UpdatePrecondition}
 */
export function requireCompatibleUpdate(request: CompatibilityRequest): CompatibilityVerdict {
  const installedManifest = manifestOf(request.installedRuntimeDir, request.installedManifest);
  const incomingManifest = manifestOf(request.incomingRuntimeDir, request.incomingManifest);
  const installedFormat = formatOf(installedManifest);
  const incomingFormat = formatOf(incomingManifest);
  if (installedFormat !== incomingFormat) {
    throw new UpdatePrecondition(
      "format-differs",
      formatDiffersMessage(installedFormat, incomingFormat, request),
    );
  }

  const installed = templatePinsOf(request.installedRuntimeDir, "installed", installedManifest);
  const incoming = templatePinsOf(request.incomingRuntimeDir, "incoming", incomingManifest);

  const differences = pinDifferences(installed, incoming);
  if (differences.length > 0) {
    throw new UpdatePrecondition("pins-differ", pinsDifferMessage(differences, request));
  }

  // The incoming runtime's own requirements, because it is the one that will read the marker
  // next — and, by clause 1, the rollback target reads the same format of the same file. A runtime
  // that declares no `toolchain` block is from before the cut and asks for no `ffmpeg`.
  const requirement = incomingManifest?.toolchain;
  const status = checkToolchain({
    stateDir: request.stateDir,
    requireFfmpeg: requirement !== undefined,
    ffmpegMinLibavcodec: requirement?.ffmpeg_min_libavcodec,
  });
  if (!status.ok) {
    throw new UpdatePrecondition(
      "toolchain-unsatisfied",
      `the toolchain recorded in ${toolchainMarkerPath(request.stateDir)} does not satisfy the ` +
        `incoming runtime (${status.reason}): ${status.detail} An update's readiness check is a ` +
        `200, and a daemon reporting a degraded toolchain answers 200 as well, so an update to a ` +
        `runtime this marker cannot serve would report success over a daemon that cannot render. ` +
        `Nothing was staged and nothing was drained. Record the toolchain first, then update:\n\n` +
        `  xplainer setup\n`,
    );
  }

  return { pins: installed, format: incomingFormat };
}

/** D2 (a)'s refusal: crossing the cut is a reinstall, in either direction. */
function formatDiffersMessage(
  installed: number,
  incoming: number,
  request: CompatibilityRequest,
): string {
  const direction = incoming > installed ? "forwards" : "backwards";
  return (
    `the installed runtime at ${request.installedRuntimeDir} reads toolchain.json format ` +
    `${String(installed)} and the incoming runtime at ${request.incomingRuntimeDir} reads format ` +
    `${String(incoming)}. That is ADR 0031's cut, crossed ${direction}, and it is one-way for an ` +
    `update: each side reads the other's marker as a missing toolchain, so neither the runtime ` +
    `this would install nor the one it would roll back to could render from the marker on this ` +
    `machine. Crossing it is a reinstall rather than an update. Nothing was staged and nothing ` +
    `was drained. Reinstall the daemon with the xplainer you mean it to run:\n\n` +
    `${REINSTALL_ACROSS_THE_CUT.map((line) => `  ${line}`).join("\n")}\n`
  );
}

/** D9's refusal, in the words §1.3d decision A settles. */
function pinsDifferMessage(
  differences: readonly PinDifference[],
  request: CompatibilityRequest,
): string {
  const rows = differences.map(
    (difference) =>
      `    ${difference.name}: installed ${difference.installed ?? "not pinned"}, ` +
      `incoming ${difference.incoming ?? "not pinned"}`,
  );
  return (
    `the incoming runtime's template pins differ from the installed runtime's, and a ` +
    `pin-changing upgrade is a REINSTALL this phase rather than an update:\n\n` +
    `${rows.join("\n")}\n\n` +
    `The Remotion workspace survives updates by design — it is resolved per platform and costs a ` +
    `full \`npm ci\` — so an update that changed these pins would report success, keep /healthz ` +
    `green and break the next render. Nothing was staged and nothing was drained.\n\n` +
    `Run the reinstall from the NEW runtime's own program, not from ` +
    `\`xplainer\` in this state directory: that launcher execs the INSTALLED runtime, which ` +
    `carries the old template, so \`setup --workspace\` through it would re-resolve the old pins ` +
    `and this update would refuse again.\n\n` +
    `  ${request.incomingProgram} setup --workspace\n` +
    `  ${request.incomingProgram} daemon install --runtime ${request.incomingRuntimeDir}\n`
  );
}

// ── The source of version B, and the staging that follows ─────────────────────────────────────

/** Where the incoming payload came from. A closed union, because there is no registry route. */
export type IncomingSourceKind = "path" | "assembled";

/** One resolved source of version B. */
export type IncomingSource = {
  kind: IncomingSourceKind;
  /** The payload-1 directory to stage. */
  payloadDir: string;
  /** A directory this resolution created and the caller must remove, or `null`. */
  temporary: string | null;
  /** How the source is named in the transcript. */
  detail: string;
};

/** What {@link resolveIncomingSource} was asked for. */
export type IncomingSourceRequest = {
  /** `--from <dir>`: a payload-1 directory, exactly as `xplainer runtime build --out` produced it. */
  from?: string | undefined;
  /** `--build`: assemble a fresh payload from this program's own checkout (T2). */
  build?: boolean | undefined;
};

/**
 * Resolve version B, or refuse.
 *
 * Exactly one of the two flags, and never a default: "whatever is on `PATH`" is the answer ADR 0025
 * §Part one measured as wrong, and an updater that guessed would replace the pinned copy with
 * something nobody named.
 *
 * @throws {UpdatePrecondition} when neither source is given, or both are.
 */
export function resolveIncomingSource(request: IncomingSourceRequest): IncomingSource {
  const from = request.from;
  const build = request.build === true;
  if (from !== undefined && build) {
    throw new UpdatePrecondition(
      "template-unreadable",
      "`--from` and `--build` name two different runtimes, and an update installs one. Give one " +
        "of them. Nothing was staged and nothing was drained.",
    );
  }
  if (from !== undefined) {
    if (!existsSync(from)) {
      throw new UpdatePrecondition(
        "template-unreadable",
        `--from ${from} does not exist, so there is no runtime to update to. Nothing was staged ` +
          `and nothing was drained.`,
      );
    }
    return { kind: "path", payloadDir: from, temporary: null, detail: `--from ${from}` };
  }
  if (!build) {
    throw new UpdatePrecondition(
      "template-unreadable",
      "`daemon update` needs the runtime it is updating **to**, named explicitly: `--from <dir>` " +
        "for a payload `xplainer runtime build --out` produced, or `--build` to assemble a fresh " +
        "one from this program's own checkout. There is no default, and deliberately not the CLI " +
        "on PATH: a package manager replaces the global CLI and leaves the pinned copy the " +
        "supervisor executes exactly where it was, which is the fact this command exists for. " +
        "Nothing was staged and nothing was drained.",
    );
  }
  // A temporary directory rather than one under `<state>/runtime/`: that tree holds one directory
  // per *staged* runtime and a build in progress is not one, so putting it there would make a
  // half-assembled payload visible to `install/program.ts`'s resolver.
  const outDir = mkdtempSync(join(tmpdir(), "xplainer-update-build-"));
  try {
    const assembled = assembleRuntime({ outDir });
    return {
      kind: "assembled",
      payloadDir: assembled.outDir,
      temporary: outDir,
      detail: `--build, assembled at ${assembled.outDir}`,
    };
  } catch (error) {
    rmSync(outDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Stage the incoming payload beside the running one.
 *
 * This is ADR 0025's step 2 and its first closed gap: **staging is the hook's work and never the
 * daemon's** — "the daemon must not write the runtime it is executing from". The updater is that
 * hook here, and `install/stage.ts` is the mechanism it uses, unchanged: the directory is named
 * `<version>-<digest>` after the payload's own content, so the new runtime lands **beside** the
 * running one rather than over it, and a half-copied interpreter never appears under a name
 * anything would launch.
 */
export function stageIncomingRuntime(stateDir: string, payloadDir: string): StageOutcome {
  return stageRuntime({ payloadDir, stateDir });
}
