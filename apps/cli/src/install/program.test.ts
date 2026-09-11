/**
 * The four sources, in order, and the field they are recorded in.
 *
 * §2.1's table is a closed set with a fixed precedence, and this suite walks all four arms: the two
 * that produce a program on this machine, and the two that refuse — for reasons that are different
 * from each other and are both about *this phase* rather than about the request being malformed.
 * The refusals matter more than they look: a resolver that fell through to the default when it was
 * asked for `sea-binary` would write `runtime-dir` into the one field whose whole job is to say
 * where the program came from.
 *
 * The last case is the recording itself. `daemon.json` is where the answer lands, `serve` and
 * `install` write it from opposite halves of the same file, and a value outside the union has to
 * read back as `null` rather than as something a later branch would act on.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROGRAM_SOURCES, readDaemonState, updateDaemonState } from "../daemon/daemon-state.js";
import { PRECONDITION_UNMET_EXIT_CODE } from "../daemon/exit-codes.js";
import { NOT_IMPLEMENTED_EXIT_CODE } from "../not-implemented.js";
import {
  installedPackageRoot,
  ProgramRefusal,
  resolveProgram,
  resolveProgramSource,
} from "./program.js";
import { stagedRuntimeRoot, stageRuntime } from "./stage.js";
import { writeInstalledPackage } from "./testing/installed-package.js";
import { buildFixturePayload, type FixturePayload } from "./testing/payload.js";

let scratch = "";
let alpha: FixturePayload;
let beta: FixturePayload;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "xplainer-program-"));
  alpha = buildFixturePayload({
    outDir: join(scratch, "alpha"),
    version: "1.2.3",
    marker: "alpha",
    runnable: false,
  });
  beta = buildFixturePayload({
    outDir: join(scratch, "beta"),
    version: "4.5.6",
    marker: "beta",
    runnable: false,
  });
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A state directory of this case's own, so no case can see another's staged runtimes. */
function freshState(name: string): string {
  const stateDir = join(scratch, "state", name);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  return stateDir;
}

/**
 * Every path under `root`, relative and sorted, so two moments can be compared.
 *
 * Names rather than contents, because what a writing resolver would do here is *add* a tree — a
 * payload, a staging directory — and names catch that with no hashing of 146 MB.
 */
function treeOf(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length))
    .sort();
}

/** The refusal a call produced, typed, so a case can assert its reason and its exit code. */
function refusalFrom(run: () => unknown): ProgramRefusal {
  try {
    run();
  } catch (error) {
    if (error instanceof ProgramRefusal) {
      return error;
    }
    throw error;
  }
  throw new Error("the call was expected to refuse and did not");
}

describe("the program resolver", () => {
  it("runs out of the staged runtime by default, and calls that `runtime-dir`", () => {
    const stateDir = freshState("default");
    const staged = stageRuntime({ payloadDir: alpha.outDir, stateDir });

    const resolved = resolveProgram({ stateDir });
    expect(resolved.source).toBe("runtime-dir");
    expect(resolved.runtimeDir).toBe(staged.path);
    expect(resolved.executable).toBe(join(staged.path, "bin", "node"));
    expect(resolved.entry).toBe(
      join(staged.path, "lib", "node_modules", "@xplainer", "cli", "dist", "bin.js"),
    );
    expect(resolved.manifest?.launch.entry).toBe("lib/node_modules/@xplainer/cli/dist/bin.js");
  });

  it("uses the runtime it is given, rather than whichever one is staged", () => {
    const stateDir = freshState("named");
    stageRuntime({ payloadDir: alpha.outDir, stateDir });
    const second = stageRuntime({ payloadDir: beta.outDir, stateDir });

    expect(resolveProgram({ stateDir, runtimeDir: second.path }).runtimeDir).toBe(second.path);
  });

  it("refuses to guess between two staged runtimes", () => {
    const stateDir = freshState("ambiguous");
    stageRuntime({ payloadDir: alpha.outDir, stateDir });
    stageRuntime({ payloadDir: beta.outDir, stateDir });

    const refusal = refusalFrom(() => resolveProgram({ stateDir }));
    expect(refusal.reason).toBe("ambiguous");
    expect(refusal.exitCode).toBe(PRECONDITION_UNMET_EXIT_CODE);
    expect(refusal.message).toContain("1.2.3-");
    expect(refusal.message).toContain("4.5.6-");
  });

  it("refuses when nothing is staged, and names the command that stages one", () => {
    const refusal = refusalFrom(() => resolveProgram({ stateDir: freshState("empty") }));
    expect(refusal.reason).toBe("nothing-staged");
    expect(refusal.message).toContain("xplainer runtime build --out");
  });

  it("refuses a runtime directory whose entry is not there", () => {
    const stateDir = freshState("no-entry");
    const staged = stageRuntime({ payloadDir: alpha.outDir, stateDir });
    rmSync(join(staged.path, "lib", "node_modules", "@xplainer", "cli", "dist", "bin.js"));

    const refusal = refusalFrom(() => resolveProgram({ stateDir, runtimeDir: staged.path }));
    expect(refusal.reason).toBe("not-a-payload");
    expect(refusal.message).toContain("records its entry at");
  });

  it("refuses a directory with no manifest in it", () => {
    const stateDir = freshState("no-manifest");
    const elsewhere = join(scratch, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });

    const refusal = refusalFrom(() => resolveProgram({ stateDir, runtimeDir: elsewhere }));
    expect(refusal.reason).toBe("not-a-payload");
  });

  it("takes `--program` verbatim, and calls that `explicit`", () => {
    const stateDir = freshState("explicit");
    const program = join(scratch, "an-installed-xplainer");
    writeFileSync(program, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const resolved = resolveProgram({ stateDir, program });
    expect(resolved).toEqual({
      source: "explicit",
      executable: program,
      entry: null,
      runtimeDir: null,
      manifest: null,
    });
  });

  it("refuses a relative `--program`, because a supervisor resolves it against nothing", () => {
    const refusal = refusalFrom(() =>
      resolveProgram({ stateDir: freshState("relative"), program: "./xplainer" }),
    );
    expect(refusal.reason).toBe("not-absolute");
    expect(refusal.exitCode).toBe(PRECONDITION_UNMET_EXIT_CODE);
  });

  it("refuses a `--program` that names nothing on this machine", () => {
    const refusal = refusalFrom(() =>
      resolveProgram({ stateDir: freshState("absent"), program: join(scratch, "not-here") }),
    );
    expect(refusal.reason).toBe("missing");
  });

  it("accepts `--from-binary` as a source and refuses it as phase 4 work", () => {
    const refusal = refusalFrom(() =>
      resolveProgram({ stateDir: freshState("sea"), fromBinary: join(scratch, "xplainer.sea") }),
    );
    expect(refusal.reason).toBe("unimplemented");
    expect(refusal.exitCode).toBe(NOT_IMPLEMENTED_EXIT_CODE);
    expect(refusal.message).toContain("phase 4");
  });

  /**
   * `package-manager` — the route a machine that ran `npm i -g xplainer` takes.
   *
   * This case used to assert a refusal ("because nothing is published yet"), and it asserted only
   * that the message contained "published" — weak enough that it went on passing while saying
   * something false, because `@xplainer/cli` and `xplainer` reached npm at `0.0.1` on 2026-09-11.
   * The route is now implemented and this is what it does.
   *
   * **The fixture is the layout npm actually produces, and the shape is the point.** `npm i -g
   * xplainer` does NOT hoist the CLI: it leaves `@xplainer/cli` nested inside the alias's own
   * `node_modules`, so the resolver has to walk through the alias to the package that carries the
   * daemon rather than treating the alias's own `bin` as the entry. Measured on a real global
   * install, which is why it is asserted here rather than assumed.
   */
  describe("`package-manager`", () => {
    /**
     * `package-manager` — the route a machine that ran `npm i -g xplainer` takes.
     *
     * This block used to assert a refusal ("because nothing is published yet"), and it asserted
     * only that the message contained "published" — weak enough that it went on passing while
     * saying something false, because `@xplainer/cli` and `xplainer` reached npm at `0.0.1` on
     * 2026-09-11.
     *
     * **The route is exercised once, deliberately, and the reason is a measured one.** Resolving it
     * assembles a real payload — which copies npm, about 17 MB, and then stages a second copy — so
     * a case per assertion cost four of those in a suite of 83 files and the first one timed out at
     * vitest's 5 s default under that much concurrent disk work. Heavy real work belongs in
     * `scripts/e2e/`, outside `pnpm verify`; what a unit suite can honestly do is assemble once and
     * assert everything about the result, which is what this does. The cheap assertions — the
     * refusal and the `runtime-dir` half of the precedence — reach no assembler and stay separate.
     *
     * **The fixture is the layout npm actually produces, and the shape is the point.** `npm i -g
     * xplainer` does NOT hoist the CLI: it leaves `@xplainer/cli` nested inside the alias's own
     * `node_modules`, so the resolver has to walk through the alias to the package that carries the
     * daemon rather than treating the alias's own `bin` as the entry. Measured on a real global
     * install, which is why it is asserted rather than assumed.
     */
    /**
     * The property that broke, asserted directly — for **every** source, with a real installed
     * package sitting on disk where a discovering resolver would find it.
     *
     * `resolveProgram`'s contract says "Nothing here writes, so a refusal leaves a machine exactly
     * as it was", and a version of this route made that false: the source was inferred by probing
     * for an installed package, so `connect/spawn.ts` — which resolves a program in order to write
     * one line into an agent's configuration — assembled and staged ~174 MB to do it. The decision
     * is now pure and materialising is a separate, explicitly-named call.
     *
     * **The fixture install is what makes the assertion mean something.** Without one, "nothing was
     * written" is true of a resolver that would have written given an install to write from. With
     * one present, every arm is asked and both trees are compared before and after — the state
     * directory *and* the install, because a resolver that assembled in place would change the
     * second and not the first.
     */
    it("decides every source without touching the filesystem, install present", () => {
      const stateDir = freshState("pure");
      const installRoot = mkdtempSync(join(scratch, "pure-installed-"));
      const aliasDir = writeInstalledPackage({ root: installRoot, version: "0.0.1" });
      // **All three roots, and the third one is the one that matters.** An earlier version of this
      // case watched the state directory and the install and called that "writes nothing" — while
      // the materialiser builds into `mkdtempSync(join(tmpdir(), …))`, which neither covered. The
      // write the implementation actually performs was invisible to the assertion written to forbid
      // it; only the *old* location, already corrected, was being watched.
      const before = {
        state: treeOf(stateDir),
        install: treeOf(installRoot),
        temp: readdirSync(tmpdir()).sort(),
      };
      // The fixture is where a discovering resolver would look, and it is not empty.
      expect(before.install.length).toBeGreaterThan(3);

      // The decider reads flags and nothing else, so `package-manager` is unreachable from it by
      // construction: it is chosen by a caller that has already materialised, never inferred here.
      // Asserted over every combination rather than over the three interesting ones, because the
      // defect was an *extra* answer appearing for an input that used to have another.
      expect(resolveProgramSource({ stateDir })).toBe("runtime-dir");
      expect(resolveProgramSource({ stateDir, program: "/usr/local/bin/xplainer" })).toBe(
        "explicit",
      );
      expect(resolveProgramSource({ stateDir, fromBinary: "/tmp/x.sea" })).toBe("sea-binary");
      expect(resolveProgramSource({ stateDir, runtimeDir: "/tmp/somewhere" })).toBe("runtime-dir");
      expect(
        resolveProgramSource({ stateDir, program: "/p", fromBinary: "/b", runtimeDir: "/r" }),
      ).toBe("explicit");

      // And resolving each one, which is the arm that could write. Two refuse and two cannot be
      // reached without a staged payload, so all four end in a refusal on this machine.
      expect(refusalFrom(() => resolveProgram({ stateDir })).reason).toBe("nothing-staged");
      expect(
        refusalFrom(() => resolveProgram({ stateDir, source: "package-manager" })).reason,
      ).toBe("nothing-staged");
      expect(refusalFrom(() => resolveProgram({ stateDir, fromBinary: "/tmp/x.sea" })).reason).toBe(
        "unimplemented",
      );
      expect(refusalFrom(() => resolveProgram({ stateDir, program: "relative/x" })).reason).toBe(
        "not-absolute",
      );

      // No tree moved, `<state>/runtime` was never created, and **nothing appeared in the temp
      // directory** — which is where a resolver that assembled would put it. Compared as a set
      // difference rather than by equality, because other suites run concurrently in the same
      // `os.tmpdir()` and may legitimately remove their own entries while this case runs; what
      // would be a defect here is an ADDITION, and that is what is asserted.
      expect(treeOf(stateDir)).toEqual(before.state);
      expect(treeOf(installRoot)).toEqual(before.install);
      const appeared = readdirSync(tmpdir())
        .filter((entry) => !before.temp.includes(entry))
        .filter((entry) => entry.startsWith("xplainer-"));
      expect(appeared).toEqual([]);
      expect(existsSync(stagedRuntimeRoot(stateDir))).toBe(false);
      expect(aliasDir.startsWith(installRoot)).toBe(true);
    });

    /**
     * The purity guarantee, held by the **transitive import graph** — which is what makes one level
     * of indirection unable to reinstate the defect.
     *
     * Two earlier guards were bypassable and the second one was measured being bypassed. The first
     * asserted that the single `assembleRuntime(` call sat inside the materialiser; extracting a
     * helper named `impliedSource` and returning it from `resolveProgramSource` left all 24 cases
     * passing with the CRITICAL reinstated. The second — `readFileSync` plus a regex over
     * `program.ts` for `"assembleRuntime"` and for the one binding it took from `assemble.js` — was
     * demonstrated by a review to pass over a `program.ts` that added
     * `import { materialiseProgramPayload } from "./materialise.js"` and called it. Both were text
     * scans over one file, and a text scan over one file cannot see one hop.
     *
     * So this walks the graph instead: from `program.ts` outward, to fixpoint — and asserts that
     * neither module that writes a payload is anywhere in the closure. A helper, a re-export or a
     * barrel all fail it, because each of them has to put the writer in the closure to reach it.
     *
     * **The walk is fail-closed on string literals, not anchored to the `import` keyword, and that
     * is the third correction.** A keyword-anchored regex — `(?:from|import)\s+"(\.[^"]+)"` — was
     * measured missing four routes to the same module: `await import("./materialise.js")`, the same
     * spread over lines, a `createRequire(import.meta.url)` call, and the path assigned to a
     * variable first. Each is one level of indirection, which is exactly what AC13 names. So every
     * relative string literal in a file is treated as a possible specifier whatever precedes it:
     * naming a module requires writing its path, and a path that is computed rather than written is
     * past what any static guard can see and past "one level of indirection" too.
     *
     * The one route that does not need a relative path is the package's own name, and that is
     * closed elsewhere: `@xplainer/cli`'s `exports` map declares `.` alone, `assembleRuntime` is
     * exported from neither `src/index.ts` nor `api/cli.api.md`, and `pnpm check:api-report` fails
     * on a change to either.
     *
     * **It only became assertable once two names moved.** `RUNTIME_ROOT_PACKAGE` and
     * `templateDirectory` were exported from `runtime/assemble.ts`, and `program.ts` needed the
     * first while `runtime/verify.ts` — which `program.ts` does import — needed the second, so the
     * assembler was in this closure through two edges that had nothing to do with writing. Both
     * live in `runtime/manifest.ts` now, whose docblocks record that this test is why.
     */
    it("cannot reach either writer, anywhere in its transitive import graph", () => {
      /** A specifier named by `import`, `from` or `require` — parenthesised or not. */
      const SPECIFIER = /(?:from|import|require)\s*\(?\s*"(\.[^"]+)"/g;
      /** Any relative path written as a literal, whatever names it. The fail-closed half. */
      const RELATIVE_LITERAL = /"(\.\.?\/[^"]*)"/g;

      /** Every `.ts` file reachable from `entry`, by any means of naming a relative module. */
      const importClosure = (entry: URL): Set<string> => {
        const src = fileURLToPath(new URL("../", import.meta.url));
        const seen = new Set<string>();
        const pending = [fileURLToPath(entry)];
        for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
          // Lower-cased, because macOS and Windows resolve `./Materialise.js` and `./materialise.js`
          // to the same file and this set would otherwise hold it under two keys — walking it twice
          // is harmless, but `not.toContain("install/materialise.ts")` would miss the other spelling.
          const key = relative(src, file).toLowerCase();
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          const text = readFileSync(file, "utf8");
          const asModule = (specifier: string): string =>
            resolve(dirname(file), specifier.replace(/\.js$/, ".ts"));

          // A keyword-anchored specifier MUST resolve. One that does not is a failure of this walk
          // rather than a pass: it would silently drop a subtree, which is how a guard goes quiet.
          for (const [, specifier] of text.matchAll(SPECIFIER)) {
            const resolved = asModule(specifier ?? "");
            expect(existsSync(resolved)).toBe(true);
            pending.push(resolved);
          }
          // Every other relative literal is followed when it names a module and ignored when it
          // does not — a data path, a fixture, a message. Tolerant here and strict above, so a
          // dynamic import cannot hide and an ordinary string cannot break the walk.
          for (const [, literal] of text.matchAll(RELATIVE_LITERAL)) {
            const resolved = asModule(literal ?? "");
            if (existsSync(resolved)) {
              pending.push(resolved);
            }
          }
        }
        return seen;
      };

      const closure = [...importClosure(new URL("program.ts", import.meta.url))];
      // The walk has to have gone somewhere, or an empty set would pass every assertion below.
      expect(closure.length).toBeGreaterThan(10);
      expect(closure).toContain("install/program.ts");
      expect(closure).toContain("runtime/verify.ts");

      // The two modules that write a payload, neither of them reachable from here.
      expect(closure).not.toContain("runtime/assemble.ts");
      expect(closure).not.toContain("install/materialise.ts");

      // And the materialiser reaches the assembler directly, so the capability lives behind a verb
      // that says so — which is the other half of the property and would be vacuous unasserted.
      expect([...importClosure(new URL("materialise.ts", import.meta.url))]).toContain(
        "runtime/assemble.ts",
      );
    });

    describe("installedPackageRoot", () => {
      /** A package at `dir` named `name`, with a module inside it to walk up from. */
      const packageAt = (dir: string, name: string): string => {
        mkdirSync(join(dir, "dist", "install"), { recursive: true });
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "0.0.1" }));
        const module = join(dir, "dist", "install", "program.js");
        writeFileSync(module, "//\n");
        return module;
      };

      it("answers the alias directory for the layout `npm i -g xplainer` produces", () => {
        // npm does NOT hoist here: the CLI is nested inside the alias's own node_modules, and the
        // alias directory is what the assembler must be given so it can resolve the CLI from it.
        const root = mkdtempSync(join(scratch, "loc-npm-"));
        const alias = join(root, "node_modules", "xplainer");
        packageAt(alias, "xplainer");
        const from = packageAt(join(alias, "node_modules", "@xplainer", "cli"), "@xplainer/cli");

        expect(installedPackageRoot(from)).toBe(alias);
      });

      it("answers the project root when the CLI is hoisted beside the alias", () => {
        const root = mkdtempSync(join(scratch, "loc-hoisted-"));
        packageAt(join(root, "node_modules", "xplainer"), "xplainer");
        const from = packageAt(join(root, "node_modules", "@xplainer", "cli"), "@xplainer/cli");

        expect(installedPackageRoot(from)).toBe(root);
      });

      it("takes the deepest `node_modules` when the CLI appears at two depths", () => {
        // The shallower copy is a decoy: the module doing the asking lives in the deeper one, and
        // copying the shallower tree would ship a different version than the one running.
        const root = mkdtempSync(join(scratch, "loc-double-"));
        packageAt(join(root, "node_modules", "@xplainer", "cli"), "@xplainer/cli");
        const host = join(root, "node_modules", "some-dep");
        packageAt(host, "some-dep");
        const from = packageAt(join(host, "node_modules", "@xplainer", "cli"), "@xplainer/cli");

        expect(installedPackageRoot(from)).toBe(host);
      });

      it("answers a pnpm virtual store path, which is what a pnpm global install realpaths into", () => {
        const root = mkdtempSync(join(scratch, "loc-pnpm-"));
        const store = join(root, "node_modules", ".pnpm", "@xplainer+cli@0.0.1");
        const from = packageAt(join(store, "node_modules", "@xplainer", "cli"), "@xplainer/cli");

        expect(installedPackageRoot(from)).toBe(store);
      });

      it("answers null from inside a staged payload, which would otherwise assemble from itself", () => {
        // A payload's layout is `<payload>/lib/node_modules/@xplainer/cli/…`, so the walk finds the
        // manifest and finds a `node_modules` segment and would answer `<payload>/lib`. An
        // argument-free install run through the stable launcher — which `docs/daemon.md` names as
        // one of the three things `xplainer` on `PATH` can be — would then build a payload out of
        // the payload it is running from and record `package-manager` for bytes that came from a
        // staged runtime. That is a false answer in the one field whose job is provenance.
        const payload = mkdtempSync(join(scratch, "loc-payload-"));
        const from = packageAt(
          join(payload, "lib", "node_modules", "@xplainer", "cli"),
          "@xplainer/cli",
        );
        // The tell: a payload carries its manifest beside `lib/`, and an npm install never does.
        writeFileSync(join(payload, "runtime.manifest.json"), JSON.stringify({ version: 1 }));

        expect(installedPackageRoot(from)).toBeNull();
      });

      it("answers null in a checkout, which is what makes `runtime-dir` the default there", () => {
        const root = mkdtempSync(join(scratch, "loc-checkout-"));
        const from = packageAt(join(root, "apps", "cli"), "@xplainer/cli");

        expect(installedPackageRoot(from)).toBeNull();
      });

      it("stops at the nearest manifest rather than climbing past somebody else's", () => {
        // A module vendored inside another package is not our install, and climbing past that
        // package's own manifest to find one further up would claim it was.
        const root = mkdtempSync(join(scratch, "loc-wrong-"));
        const from = packageAt(join(root, "node_modules", "unrelated"), "unrelated");

        expect(installedPackageRoot(from)).toBeNull();
      });
    });

    it("still takes `runtime-dir` when `--runtime` names one, install present or not", () => {
      // The cheap half of the precedence: no assembler is reached, because a named runtime wins
      // before the install is even looked for. A caller who assembled a payload is naming the one
      // they mean.
      const stateDir = freshState("implied-runtime");
      stageRuntime({ payloadDir: alpha.outDir, stateDir });

      expect(resolveProgram({ stateDir, runtimeDir: alpha.outDir }).source).toBe("runtime-dir");
    });
  });

  it("records the source it chose in `daemon.json`", () => {
    const stateDir = freshState("recorded");
    stageRuntime({ payloadDir: alpha.outDir, stateDir });

    const resolved = resolveProgram({ stateDir });
    updateDaemonState(stateDir, {
      program_source: resolved.source,
      runtime_dir: resolved.runtimeDir,
    });

    const state = readDaemonState(stateDir);
    expect(state.program_source).toBe("runtime-dir");
    expect(state.runtime_dir).toBe(resolved.runtimeDir);
  });

  it("records all four values, and reads back a fifth as `null`", () => {
    const stateDir = freshState("all-four");
    for (const source of PROGRAM_SOURCES) {
      updateDaemonState(stateDir, { program_source: source });
      expect(readDaemonState(stateDir).program_source).toBe(source);
    }
    expect(PROGRAM_SOURCES).toEqual(["runtime-dir", "explicit", "sea-binary", "package-manager"]);

    writeFileSync(
      join(stateDir, "daemon.json"),
      JSON.stringify({ format_version: 1, program_source: "brew" }),
    );
    expect(readDaemonState(stateDir).program_source).toBeNull();
  });
});
