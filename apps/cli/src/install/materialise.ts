/**
 * Build a payload-1 artefact out of an installed `@xplainer/cli`.
 *
 * **This is a separate module so that `install/program.ts` has no path to the assembler at all.**
 * The resolver's contract is that asking it a question costs nothing — "Nothing here writes, so a
 * refusal leaves a machine exactly as it was" — and when the materialising lived inside it, that
 * contract was false and `connect/spawn.ts` paid for it: a command that resolves a program only to
 * write one line into an agent's configuration assembled and staged ~174 MB to do it. Moving the
 * write out fixed the symptom; moving it to its own *module* is what makes the property structural.
 * A text scan over `program.ts` could be defeated by one level of indirection — measured: extracting
 * a helper named `impliedSource` and returning it left every test passing — whereas an import graph
 * cannot be. `program.ts` importing this module is the thing to refuse in review.
 *
 * **The payload is assembled outside `<state>/runtime/`, and that is a correction.** The first
 * version built it under that directory behind `STAGE_TEMP_PREFIX`, reasoning that
 * `listStagedRuntimes` filters the prefix so a leftover could never be mistaken for a staged
 * runtime. Both halves were true and the conclusion was wrong: the filter meant nothing in the
 * product — and nothing in the *test* written to catch a leak — could see a payload left behind, so
 * a failed install kept 146 MB while reporting that everything it wrote had been undone, and
 * `removeCreatedDirectories` could not remove `<state>/runtime` because the orphan was inside it. A
 * temp directory outside the state tree is visible to nobody by construction rather than by filter,
 * and the caller's `finally` is the only thing that has to be right.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRECONDITION_UNMET_EXIT_CODE } from "../daemon/exit-codes.js";
import { assembleRuntime } from "../runtime/assemble.js";
import { RUNTIME_ROOT_PACKAGE } from "../runtime/manifest.js";
import { installedPackageRoot } from "./program.js";

/** Why a payload could not be built, and nothing was left behind. */
export type MaterialiseRefusalReason = "not-installed" | "not-a-payload";

/** The build will not happen, and the machine is as it was found. */
export class MaterialiseRefusal extends Error {
  readonly reason: MaterialiseRefusalReason;
  readonly exitCode: number;
  /**
   * The temp directory this refusal removed on its way out, or `null` if it never made one.
   *
   * Reported for the same reason {@link InstallRefusal} carries `undone`: a refusal that claims to
   * have left nothing behind should say what it took away. It is also the only way to *check* that
   * claim from outside — the caller never receives a handle on this path, so the alternative was
   * counting `xplainer-materialise-*` directories in the shared `os.tmpdir()`, which answered for
   * whatever else was running beside the test and passed alone while failing in the full suite.
   */
  readonly discarded: string | null;

  constructor(reason: MaterialiseRefusalReason, message: string, discarded: string | null = null) {
    super(message);
    this.name = "MaterialiseRefusal";
    this.reason = reason;
    this.exitCode = PRECONDITION_UNMET_EXIT_CODE;
    this.discarded = discarded;
  }
}

/** What {@link materialiseProgramPayload} needs. */
export type MaterialiseOptions = {
  /**
   * Where the installed package is, as a function rather than a path.
   *
   * A function because the caller is what knows: `commands/daemon.ts` passes
   * {@link installedPackageRoot} explicitly, so this is a seam a product call site uses rather than
   * one only tests reach. The earlier shape took a path and defaulted to the locator, which meant
   * the field was dead in production and alive only in the suite — a test hook wearing a seam's
   * clothes.
   */
  locateInstall: () => string | null;
};

/** A payload built out of an installed package, and the directory the caller must remove. */
export type MaterialisedPayload = {
  /** The assembled payload-1 directory, ready to hand to `installDaemon` as its `payloadDir`. */
  payloadDir: string;
  /**
   * Remove the payload. **The caller must call this in a `finally`.**
   *
   * Returned rather than done here because the payload's whole purpose is to outlive this call —
   * `stageRuntime` copies out of it — so the lifetime belongs to whoever staged it. It is
   * idempotent and never throws: a cleanup that threw would replace a real error with a tidying-up
   * one, and `maxRetries` is Node's own remedy for the Windows case where an antivirus scanner or a
   * lingering handle answers `EBUSY` on a directory this size, which this repository has already
   * learned in `install/testing/scratch.ts` and `daemon/testing/spawn-child.ts`.
   */
  discard: () => void;
};

/**
 * Assemble a payload out of the installed package the locator names.
 *
 * @throws {MaterialiseRefusal} `not-installed` when the locator finds nothing, `not-a-payload` when
 * the install will not assemble. Both leave nothing behind.
 */
export function materialiseProgramPayload(options: MaterialiseOptions): MaterialisedPayload {
  const root = options.locateInstall();
  if (root === null) {
    throw new MaterialiseRefusal(
      "not-installed",
      "there is no installed `xplainer` to build a payload from: no " +
        `\`node_modules/${RUNTIME_ROOT_PACKAGE}\` above this module, which is what a checkout and ` +
        "a staged payload both look like. Assemble one instead — " +
        "`xplainer runtime build --out <dir>` then `xplainer daemon install --runtime <dir>`.",
    );
  }

  const outDir = mkdtempSync(join(tmpdir(), "xplainer-materialise-"));
  const discard = (): void => {
    try {
      rmSync(outDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch {
      // A temp directory the OS collects. Never worth replacing a real error over.
    }
  };

  try {
    assembleRuntime({
      outDir: join(outDir, "payload"),
      repoRoot: root,
      rootPackage: RUNTIME_ROOT_PACKAGE,
    });
  } catch (error) {
    discard();
    // `not-a-payload` carries exit 3, which is faithful for every failure the assembler is designed
    // to produce: `commands/runtime.ts`'s `runtimeRefusalExitCode` maps every reason to 3 except
    // `install-failed`, which is payload 2's npm run and unreachable here. It flattens a raw I/O
    // failure, which the table would call 70 — so the underlying text passes through verbatim,
    // because a reader who is out of disk needs to see `ENOSPC` rather than a code.
    throw new MaterialiseRefusal(
      "not-a-payload",
      `the install at ${root} could not be assembled into a payload: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      outDir,
    );
  }

  return { payloadDir: join(outDir, "payload"), discard };
}

/** Kept so the one product call site can pass the locator explicitly rather than relying on a default. */
export { installedPackageRoot };
