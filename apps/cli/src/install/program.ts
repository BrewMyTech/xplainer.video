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
 * | `package-manager` | the caller says so, having built a payload out of an installed package | labels the staged payload; never builds one |
 * | `runtime-dir` | the default | a payload somebody else staged |
 *
 * **Why the one unimplemented source is a branch rather than an absence.** `--from-binary` is a
 * flag a user can type and a `daemon.json` written by a future release can name `sea-binary`, so
 * the choice is between a refusal that says which phase implements it and a fall-through that
 * silently installs the *default* program under somebody else's name. The second would record
 * `runtime-dir` in a file whose whole job is to say where the program came from.
 *
 * **Every arm of this module is a question, and none of them writes.** `package-manager` used to
 * refuse because nothing was published, and when the publish made it reachable it was implemented
 * *here* — locating an install, assembling ~174 MB and staging it, inside a function whose contract
 * says "Nothing here writes". The cost landed on a caller nobody was thinking about:
 * `connect/spawn.ts` resolves a program in order to write one line into an agent's configuration,
 * and began building a payload to do it. So the building moved out, to
 * {@link materialiseProgramPayload} and the command that calls it, and `package-manager` here is
 * only a **label** on a payload the caller already staged. Keep it that way: the property that
 * makes this module safe to call is that asking it a question costs nothing.
 *
 * **The resolver answers with paths, not with an argument vector.** A `LaunchSpec` is built by
 * `runtime/launch-spec.ts` and by nothing else (D1), so what comes out of here is the interpreter
 * and the entry file that spec — and the stable launcher in `install/launcher.ts` — will name.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProgramSource } from "../daemon/daemon-state.js";
import { PRECONDITION_UNMET_EXIT_CODE } from "../daemon/exit-codes.js";
import { NOT_IMPLEMENTED_EXIT_CODE } from "../not-implemented.js";
import {
  RUNTIME_MANIFEST_FILE,
  RUNTIME_ROOT_PACKAGE,
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
  | "unimplemented"
  /**
   * `package-manager` was asked for and this build is not running out of an installed package.
   *
   * Its own reason rather than `missing`, because the two lead to opposite advice: `missing` is a
   * path that should have existed, and this is a machine where the source does not apply at all —
   * a checkout, or a payload already staged, neither of which has a `node_modules/@xplainer/cli`
   * above it to copy.
   */
  | "not-installed";

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
  switch (request.source ?? resolveProgramSource(request)) {
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
      return packageManagerProgram(request);
    case "runtime-dir":
      return runtimeDirProgram(request);
  }
}

/**
 * Which source the flags ask for, when the caller has not said. **Pure: it touches no filesystem.**
 *
 * That purity is the whole of a defect this function briefly had. It was made to probe for an
 * installed package and answer `package-manager` when it found one — which reads as a property of
 * `xplainer daemon install` and is in fact a property of **every** caller of {@link resolveProgram}
 * that omits `runtimeDir`. `connect/spawn.ts` is one, so `xplainer connect claude --spawn` began
 * assembling and permanently staging a ~174 MB payload as a side effect of writing one line into an
 * agent's configuration — measured, 4.2 s and 174 MB — on exactly the machine that command exists
 * for, since ADR 0020 prints it as the remediation where there is no supervisor to install a daemon
 * under and `installedPackageRoot()` is non-null precisely there.
 *
 * So the decision of *whether to build a payload out of an installed package* belongs to the
 * command that can also arrange the rollback for it, and `package-manager` is now **chosen by a
 * caller and never inferred here**. `commands/daemon.ts` asks {@link installedPackageRoot}, calls
 * {@link materialiseProgramPayload}, and passes the result as an ordinary `payloadDir` — which is
 * also how it inherits the journal undo that branch already pushes.
 */
export function resolveProgramSource(request: ProgramRequest): ProgramSource {
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

/**
 * Where this build's own `@xplainer/cli` package is, when it is running out of an installed one.
 *
 * Answers the directory the assembler needs as its `repoRoot` — the one whose
 * `node_modules/@xplainer/cli` is this module's own package — or `null` on a machine where that is
 * not what is happening, which is every checkout and every staged payload.
 *
 * **It is derived from `import.meta.url` and never from `npm root -g`, and that is a measurement
 * rather than a preference.** On a machine with nvm, `npm root -g` answers for whichever Node the
 * `npm` on `PATH` belongs to: asked on 2026-09-11 it named `…/v22.23.1/lib/node_modules` while the
 * `xplainer` being run was installed under `v24.20.0`, so a locator built on it would have
 * assembled a payload out of a tree that did not contain the package doing the assembling — or,
 * more often, found nothing and refused on a machine where the install was right there. This module
 * is inside the package it is looking for, so walking up from itself cannot disagree with itself.
 *
 * `process.argv[1]` is no use either: the unscoped `xplainer` alias rewrites it to the CLI's entry
 * before importing it, so it names the same file on both routes and distinguishes nothing.
 */
export function installedPackageRoot(from: string = fileURLToPath(import.meta.url)): string | null {
  let directory = dirname(from);
  for (;;) {
    const manifestFile = join(directory, "package.json");
    if (isFile(manifestFile)) {
      let name: unknown;
      try {
        name = JSON.parse(readFileSync(manifestFile, "utf8")).name;
      } catch {
        return null;
      }
      if (name !== RUNTIME_ROOT_PACKAGE) {
        return null;
      }
      // `<root>/node_modules/@xplainer/cli` — the assembler resolves the root package from
      // `<root>`, so the answer is the directory above the `node_modules` this package sits in.
      // Found by locating that segment rather than by counting `dirname`s, because the count
      // differs between a scoped package and an unscoped one and a wrong count is a silent
      // mis-copy rather than an error.
      const segments = directory.split(sep);
      const index = segments.lastIndexOf("node_modules");
      if (index <= 0) {
        return null;
      }
      const root = segments.slice(0, index).join(sep);
      if (!isFile(join(root, "node_modules", ...RUNTIME_ROOT_PACKAGE.split("/"), "package.json"))) {
        return null;
      }
      // **A staged payload looks exactly like an install from here, and answering it would be a
      // loop.** A payload's layout is `<payload>/lib/node_modules/@xplainer/cli/…`, so this walk
      // finds the manifest and finds a `node_modules` segment and would answer `<payload>/lib`. An
      // argument-free install run through the stable launcher — which `docs/daemon.md` names as one
      // of the three things `xplainer` on `PATH` can be — would then assemble a payload out of the
      // payload it is running from, and record `program_source: package-manager` for bytes that
      // came from a staged runtime rather than from a registry. That is a false answer in the one
      // field whose whole job is provenance. `runtime.manifest.json` sits beside `lib/` in a
      // payload and in no npm install, so it is the tell.
      // The manifest sits at the payload's own root, and `root` here is its `lib/` — a payload is
      // `<payload>/lib/node_modules/@xplainer/cli/…`, so the walk lands one level below the
      // manifest. Both places are checked because an npm prefix has a `lib/` too and neither it nor
      // its parent ever carries a runtime manifest.
      const payloadTell = [
        join(root, RUNTIME_MANIFEST_FILE),
        join(dirname(root), RUNTIME_MANIFEST_FILE),
      ];
      return payloadTell.some((candidate) => isFile(candidate)) ? null : root;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

/**
 * `package-manager`: label a staged payload as having come from an installed package.
 *
 * **This arm writes nothing, and that is the correction.** It used to locate the install, assemble a
 * ~174 MB payload and stage it — inside a function whose own contract says "Nothing here writes, so
 * a refusal leaves a machine exactly as it was". Three things went wrong at once. `connect/spawn.ts`
 * calls {@link resolveProgram} with no `runtimeDir`, so writing one line into an agent's
 * configuration assembled a payload. The branch of `install.ts` it ran through pushes no journal
 * undo, so a later phase failing left 174 MB staged while the refusal said everything had been
 * undone. And `reused` was hardcoded `true`, so a user was told "already staged" about bytes just
 * copied twice.
 *
 * The materialising half is {@link materialiseProgramPayload}, called by `commands/daemon.ts`, which
 * passes the result as an ordinary `payloadDir`. That routes it through the staging branch that
 * already has a rollback undo and already reports a real {@link StageOutcome}, so all three defects
 * are fixed by where the work happens rather than by patching each symptom.
 */
function packageManagerProgram(request: ProgramRequest): ResolvedProgram {
  return { ...runtimeDirProgram(request), source: "package-manager" };
}
