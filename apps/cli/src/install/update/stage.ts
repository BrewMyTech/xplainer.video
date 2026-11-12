/**
 * Where version B comes from, and the pre-drain precondition that decides whether it may be used.
 *
 * Two things live here because they are the same half of the transaction: **everything that happens
 * before anything is written**. ADR 0020's rule for every degraded path — "probe before writing; on
 * refusal, write nothing, exit with the documented code, and print the one command that fixes it" —
 * is what this file is for, and ADR 0031's D2 (a) is the refusal it carries.
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
 * ## The precondition is two clauses, and refusal-only
 *
 * 1. **The installed and incoming runtimes read the same `toolchain.json` format, and it is the
 *    one this build's `setup` writes.** ADR 0031's cut (§Note, 2026-11-12, D2 (a)) moved the marker
 *    from format 1 — which records a workspace — to format 2, which records an `ffmpeg` and no
 *    workspace. A daemon on one side of it reads the other side's marker as a missing toolchain,
 *    and a rollback across it would land on exactly that daemon, so crossing the cut in either
 *    direction is a reinstall. A payload built before the cut declares no format and reads as
 *    format 1, and so does an installed runtime whose manifest this build cannot read. **Two
 *    format-1 runtimes agree with each other and are still refused**: the marker they would read
 *    next is the one this build's `setup` writes, which is format 2, so an update between them
 *    would install a daemon nothing this build records can serve.
 * 2. **The marker satisfies the incoming runtime's own `toolchain` requirements**, as
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
 * **The template-pin clause left with payload 2** (ADR 0031 §Note, 2026-11-12, D7). ADR 0027's
 * decision A refused an update whose two runtimes pinned different render-workspace trees, because
 * that workspace survived updates and no render could tell. No render reads a workspace tree any
 * more, so there are no pins to compare and nothing for them to break.
 *
 * **Every refusal names the command that ends it.** Across the cut that is the reinstall —
 * `xplainer daemon uninstall`, `xplainer setup`, `xplainer daemon install` — and nothing here runs
 * it. A marker the incoming runtime cannot use names `xplainer setup`, which is what writes one.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRECONDITION_UNMET_EXIT_CODE } from "../../daemon/exit-codes.js";
import { ASSEMBLED_TOOLCHAIN, assembleRuntime } from "../../runtime/assemble.js";
import {
  PRE_CUT_TOOLCHAIN_FORMAT,
  type RuntimeManifest,
  readRuntimeManifest,
} from "../../runtime/manifest.js";
import {
  checkToolchain,
  REINSTALL_ACROSS_THE_CUT,
  TOOLCHAIN_FORMAT_VERSION,
  toolchainMarkerPath,
} from "../../setup/toolchain.js";
import { type StageOutcome, stageRuntime } from "../stage.js";

/** Why the precondition refused. One value per distinguishable condition, never a catch-all. */
export type PreconditionReason =
  /** `--from` and `--build` both, neither, or a `--from` that does not exist. */
  | "incoming-unresolved"
  | "format-differs"
  /** The two runtimes agree, on a format this build's `setup` does not write. */
  | "format-unsupported"
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

/** What {@link requireCompatibleUpdate} was asked to weigh. */
export type CompatibilityRequest = {
  /** The staged runtime the daemon is installed from — A, and the rollback target. */
  installedRuntimeDir: string;
  /** The payload-1 directory the update would switch to — B. */
  incomingRuntimeDir: string;
  /**
   * How a refusal names B, when that is not "the incoming runtime at `incomingRuntimeDir`" — a
   * payload that has not been assembled yet has no directory to name.
   */
  incomingDescription?: string | undefined;
  /** The daemon's state directory, whose `toolchain.json` both runtimes read. */
  stateDir: string;
  /**
   * The incoming payload's manifest, when the caller has already read it — or only its `toolchain`
   * block, which is all the precondition asks, when the payload has not been assembled yet.
   */
  incomingManifest?: Pick<RuntimeManifest, "toolchain"> | null | undefined;
  /** The installed payload's manifest, when the caller has already read it. */
  installedManifest?: RuntimeManifest | null | undefined;
};

/** The two clauses, and what they agreed on. */
export type CompatibilityVerdict = {
  /** The `toolchain.json` format both runtimes read, which is one by the time this is returned. */
  format: number;
};

/** A runtime's manifest as the caller passed it, read here when it did not, `null` if unreadable. */
function manifestOf(
  runtimeDir: string,
  given: Pick<RuntimeManifest, "toolchain"> | null | undefined,
): Pick<RuntimeManifest, "toolchain"> | null {
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
function formatOf(manifest: Pick<RuntimeManifest, "toolchain"> | null): number {
  return manifest?.toolchain?.format ?? PRE_CUT_TOOLCHAIN_FORMAT;
}

/**
 * The two-clause pre-drain check. Returns, or refuses with exit `3` having touched nothing.
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
  if (incomingFormat !== TOOLCHAIN_FORMAT_VERSION) {
    throw new UpdatePrecondition(
      "format-unsupported",
      formatUnsupportedMessage(incomingFormat, request),
    );
  }

  // The incoming runtime's own requirements, because it is the one that will read the marker
  // next — and, by clause 1, the rollback target reads the same format of the same file. Clause 1
  // also means it declares a `toolchain` block: one that declares none reads format 1 and was
  // refused above.
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

  return { format: incomingFormat };
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
    `${String(installed)} and ${incomingName(request)} reads format ` +
    `${String(incoming)}. That is ADR 0031's cut, crossed ${direction}, and it is one-way for an ` +
    `update: each side reads the other's marker as a missing toolchain, so neither the runtime ` +
    `this would install nor the one it would roll back to could render from the marker on this ` +
    `machine. Crossing it is a reinstall rather than an update. Nothing was staged and nothing ` +
    `was drained. Reinstall the daemon with the xplainer you mean it to run:\n\n` +
    `${REINSTALL_ACROSS_THE_CUT.map((line) => `  ${line}`).join("\n")}\n`
  );
}

/** B, as a refusal names it. */
function incomingName(request: CompatibilityRequest): string {
  return request.incomingDescription ?? `the incoming runtime at ${request.incomingRuntimeDir}`;
}

/**
 * Clause 1's second half: both runtimes agree, on a format this build's `setup` does not write.
 *
 * Two runtimes from before the cut agree with each other, and the marker on this machine is the
 * one this build's `setup` writes. Updating between them would install a daemon that reads that
 * marker as a missing toolchain, behind a readiness check that answers `200` either way.
 */
function formatUnsupportedMessage(incoming: number, request: CompatibilityRequest): string {
  const side =
    incoming < TOOLCHAIN_FORMAT_VERSION ? "from before ADR 0031's cut" : "newer than this xplainer";
  return (
    `the installed runtime at ${request.installedRuntimeDir} and ${incomingName(request)} ` +
    `both read toolchain.json format ${String(incoming)}, ${side}, ` +
    `and this xplainer's \`setup\` writes format ${String(TOOLCHAIN_FORMAT_VERSION)}. The two agree ` +
    `with each other and not with the marker either of them would read next, so the runtime this ` +
    `would install could not render from anything this xplainer records. Nothing was staged and ` +
    `nothing was drained. Reinstall the daemon with this xplainer:\n\n` +
    `${REINSTALL_ACROSS_THE_CUT.map((line) => `  ${line}`).join("\n")}\n`
  );
}

/**
 * The precondition, asked of the payload `--build` **would** assemble, before it is assembled.
 *
 * `runtime/assemble.ts` writes {@link ASSEMBLED_TOOLCHAIN} into every manifest this build makes,
 * so whether the update would be refused is knowable from the installed side and the marker alone
 * — and asking first spares the ~146 MB a refused `--build` would otherwise assemble and discard.
 * `xplainer update`'s daemon step asks the same question for the same payload.
 *
 * @throws {UpdatePrecondition}
 */
export function requireCompatibleAssembly(request: {
  installedRuntimeDir: string;
  stateDir: string;
}): CompatibilityVerdict {
  return requireCompatibleUpdate({
    ...request,
    // Never read: the manifest is given, and the description is what a refusal names.
    incomingRuntimeDir: "",
    incomingDescription: "the runtime this xplainer assembles",
    incomingManifest: { toolchain: ASSEMBLED_TOOLCHAIN },
  });
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
      "incoming-unresolved",
      "`--from` and `--build` name two different runtimes, and an update installs one. Give one " +
        "of them. Nothing was staged and nothing was drained.",
    );
  }
  if (from !== undefined) {
    if (!existsSync(from)) {
      throw new UpdatePrecondition(
        "incoming-unresolved",
        `--from ${from} does not exist, so there is no runtime to update to. Nothing was staged ` +
          `and nothing was drained.`,
      );
    }
    return { kind: "path", payloadDir: from, temporary: null, detail: `--from ${from}` };
  }
  if (!build) {
    throw new UpdatePrecondition(
      "incoming-unresolved",
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
