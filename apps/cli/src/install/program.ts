/**
 * Where an install gets the program it registers, decided in one place.
 *
 * The plan's §2.1 gives four sources and one rule — "One resolver,
 * `apps/cli/src/install/program.ts`, recording its answer in `daemon.json` as `program_source`" —
 * and this is it. The four are tried **in a fixed order**, and there is deliberately no registry to
 * add a fifth to: a supervisor artefact, a launcher and a `daemon.json` record are all written from
 * one answer, so the set of answers is a closed union in `daemon/daemon-state.ts` and the branches
 * that produce them are the four `switch` arms below.
 *
 * | `program_source` | Chosen when | This phase |
 * |---|---|---|
 * | `explicit` | `install --program <absolute path>` | verbatim, after a preflight |
 * | `sea-binary` | `install --from-binary <path>` | accepted and refused: nothing stages a SEA yet |
 * | `package-manager` | asked for by name | not implemented: nothing is published yet |
 * | `runtime-dir` | **always, unless overridden** | the phase-2 default |
 *
 * **Why the two unimplemented sources are branches rather than absences.** Both are reachable —
 * `--from-binary` is a flag a user can type, and a `daemon.json` written by a future release can
 * name either — so the choice is between a refusal that says which phase implements it and a
 * fall-through that silently installs the *default* program under somebody else's name. The second
 * would record `runtime-dir` in a file whose whole job is to say where the program came from.
 *
 * **What a publish changes here, and it is one branch.** `package-manager` gains a body that
 * locates the globally installed package and hands its directory to the same stager. The assembler,
 * the launch contract, the renderers, the update transaction and the consistency check are
 * untouched, because none of them asks where the payload came from — which is the property §2.1
 * claims and this file is where it is either true or false.
 *
 * **The resolver answers with paths, not with an argument vector.** A `LaunchSpec` is built by
 * `runtime/launch-spec.ts` and by nothing else (D1), so what comes out of here is the interpreter
 * and the entry file that spec — and the stable launcher in `install/launcher.ts` — will name.
 */

import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ProgramSource } from "../daemon/daemon-state.js";
import { PRECONDITION_UNMET_EXIT_CODE } from "../daemon/exit-codes.js";
import { NOT_IMPLEMENTED_EXIT_CODE } from "../not-implemented.js";
import {
  RUNTIME_MANIFEST_FILE,
  type RuntimeManifest,
  readRuntimeManifest,
} from "../runtime/manifest.js";
import { listStagedRuntimes, stagedRuntimeRoot } from "./stage.js";

/** Why the resolver refused. One value per distinguishable condition, never a catch-all. */
export type ProgramRefusalReason =
  | "not-absolute"
  | "missing"
  | "not-a-payload"
  | "nothing-staged"
  | "ambiguous"
  | "unimplemented";

/**
 * The resolver will not name a program, and nothing has been written.
 *
 * `unimplemented` carries `2` — "this command exists but does nothing yet", the meaning
 * `not-implemented.ts` already fixed — and every other reason carries ADR 0020's `3`, because each
 * of them is a precondition of installing that was knowable before a single artefact was rendered.
 */
export class ProgramRefusal extends Error {
  /** Which condition stopped the resolution. */
  readonly reason: ProgramRefusalReason;
  /** The code a command exits with when it reports this refusal. */
  readonly exitCode: number;

  constructor(reason: ProgramRefusalReason, message: string) {
    super(message);
    this.name = "ProgramRefusal";
    this.reason = reason;
    this.exitCode =
      reason === "unimplemented" ? NOT_IMPLEMENTED_EXIT_CODE : PRECONDITION_UNMET_EXIT_CODE;
  }
}

/** The program an install registers, and where it came from. */
export type ResolvedProgram = {
  /** The value that goes into `daemon.json`'s `program_source`. */
  source: ProgramSource;
  /** The file a supervisor starts: `<runtime>/bin/node`, or the explicit program itself. */
  executable: string;
  /**
   * The CLI entry {@link ResolvedProgram.executable} is given, or `null` when the executable *is*
   * the CLI.
   *
   * Two fields rather than one argv because D1's whole point is that the interpreter is named
   * explicitly: a payload's `dist/bin.js` begins `#!/usr/bin/env node` and a machine with no Node
   * on its `PATH` — the machine this design exists for — cannot run it any other way.
   */
  entry: string | null;
  /** The staged payload-1 directory, or `null` for a source that is not one. */
  runtimeDir: string | null;
  /** The staged payload's manifest, or `null` for a source that has none. */
  manifest: RuntimeManifest | null;
};

/** What {@link resolveProgram} weighs. */
export type ProgramRequest = {
  /** The durable state directory, under which `runtime/` holds the staged payloads. */
  stateDir: string;
  /**
   * The source to use, when the caller already knows it.
   *
   * An installer takes it from the flags; the update transaction takes it from the `daemon.json`
   * the previous install wrote, so an upgrade cannot silently change how the program is found.
   * Omitted, it is implied by the flags below.
   */
  source?: ProgramSource | undefined;
  /** `install --program <absolute path>`. */
  program?: string | undefined;
  /** `install --from-binary <path>`. */
  fromBinary?: string | undefined;
  /**
   * A staged payload-1 directory to use, rather than whichever one is staged.
   *
   * The installer passes the directory it has just staged and the updater passes the new one, so
   * neither depends on there being exactly one.
   */
  runtimeDir?: string | undefined;
};

/**
 * Decide where this install's program comes from, in §2.1's order.
 *
 * @throws {ProgramRefusal} when the chosen source cannot name a program that exists. Nothing here
 * writes, so a refusal leaves a machine exactly as it was.
 */
export function resolveProgram(request: ProgramRequest): ResolvedProgram {
  switch (request.source ?? impliedSource(request)) {
    case "explicit":
      return explicitProgram(request);
    case "sea-binary":
      throw new ProgramRefusal(
        "unimplemented",
        "`--from-binary` names a single executable, and staging one is phase 4: nothing in this " +
          "phase produces a SEA, so an install that recorded `sea-binary` would name a program " +
          "no update could ever replace. Install from a runtime directory instead — " +
          "`xplainer runtime build --out <dir>`, then `xplainer daemon install`.",
      );
    case "package-manager":
      throw new ProgramRefusal(
        "unimplemented",
        "`package-manager` is the source a published `@xplainer/cli` gets, and nothing is " +
          "published yet: this phase's whole delivery route is a runtime directory assembled " +
          "from a local checkout. The branch that locates a global install hands its directory " +
          "to the same stager, so nothing else changes when it arrives.",
      );
    case "runtime-dir":
      return runtimeDirProgram(request);
  }
}

/** Which source the flags ask for, when the caller has not said. */
function impliedSource(request: ProgramRequest): ProgramSource {
  if (request.program !== undefined) {
    return "explicit";
  }
  if (request.fromBinary !== undefined) {
    return "sea-binary";
  }
  return "runtime-dir";
}

/**
 * `install --program <absolute path>`, taken verbatim.
 *
 * Absolute because a supervisor artefact carries no working directory a relative path could be
 * resolved against on the machine that reads it back — systemd requires an absolute `ExecStart=`
 * and a `.plist`'s `ProgramArguments[0]` is resolved by `launchd`, not by the shell that installed
 * it. Existing because ADR 0020's rule for every degraded path is "probe before writing".
 */
function explicitProgram(request: ProgramRequest): ResolvedProgram {
  const program = request.program;
  if (program === undefined || program.trim() === "") {
    throw new ProgramRefusal(
      "missing",
      "the `explicit` program source was asked for and `--program` names nothing. The source is " +
        "the flag: there is no default program to fall back to that would still be `explicit`.",
    );
  }
  if (!isAbsolute(program)) {
    throw new ProgramRefusal(
      "not-absolute",
      `--program ${program} is relative, and a supervisor resolves the program it is given ` +
        `against nothing: systemd requires an absolute \`ExecStart=\`, and a LaunchAgent's ` +
        `argv[0] is resolved by launchd rather than by this shell. Give the whole path.`,
    );
  }
  if (!isFile(program)) {
    throw new ProgramRefusal(
      "missing",
      `--program ${program} does not name a file on this machine, so registering it would ` +
        `install a daemon that cannot start. Nothing was written.`,
    );
  }
  return { source: "explicit", executable: program, entry: null, runtimeDir: null, manifest: null };
}

/**
 * The phase-2 default: a payload-1 artefact staged under `<state>/runtime/`.
 *
 * Given a directory, that one is used. Given none, the staged runtimes are listed and exactly one
 * is an answer — two is a question only the caller can settle, and it is asked rather than guessed,
 * because installing the wrong one produces a daemon that starts, answers `/healthz` and runs the
 * wrong code.
 */
function runtimeDirProgram(request: ProgramRequest): ResolvedProgram {
  const chosen = request.runtimeDir ?? soleStagedRuntime(request.stateDir);
  let manifest: RuntimeManifest;
  try {
    manifest = readRuntimeManifest(chosen);
  } catch (error) {
    throw new ProgramRefusal(
      "not-a-payload",
      `${chosen} is not a runtime this daemon can be installed from: its ` +
        `${RUNTIME_MANIFEST_FILE} ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const executable = join(chosen, ...manifest.launch.interpreter.split("/"));
  const entry = join(chosen, ...manifest.launch.entry.split("/"));
  for (const [what, path] of [
    ["interpreter", executable],
    ["entry", entry],
  ] as const) {
    if (!isFile(path)) {
      throw new ProgramRefusal(
        "not-a-payload",
        `${chosen} records its ${what} at ${path}, and there is no file there. A runtime is ` +
          `installed by naming both, so a payload missing either would be registered as a daemon ` +
          `that fails at exec time with nothing to read.`,
      );
    }
  }
  return { source: "runtime-dir", executable, entry, runtimeDir: chosen, manifest };
}

/** The one staged runtime, or a refusal naming what is there instead. */
function soleStagedRuntime(stateDir: string): string {
  const staged = listStagedRuntimes(stateDir);
  const first = staged[0];
  if (first === undefined) {
    throw new ProgramRefusal(
      "nothing-staged",
      `no runtime is staged under ${stagedRuntimeRoot(stateDir)}, and this phase's default ` +
        `install runs the daemon out of one. Build a payload with ` +
        `\`xplainer runtime build --out <dir>\` and install from it.`,
    );
  }
  if (staged.length > 1) {
    throw new ProgramRefusal(
      "ambiguous",
      `${staged.length} runtimes are staged under ${stagedRuntimeRoot(stateDir)} ` +
        `(${staged.map((entry) => entry.slot).join(", ")}), and installing the wrong one ` +
        `produces a daemon that starts, answers /healthz and runs code nobody chose. Name one.`,
    );
  }
  return first.path;
}

/** Whether `path` names a regular file this process can stat. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
