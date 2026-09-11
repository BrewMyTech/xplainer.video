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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROGRAM_SOURCES, readDaemonState, updateDaemonState } from "../daemon/daemon-state.js";
import { PRECONDITION_UNMET_EXIT_CODE } from "../daemon/exit-codes.js";
import { NOT_IMPLEMENTED_EXIT_CODE } from "../not-implemented.js";
import { ProgramRefusal, resolveProgram } from "./program.js";
import { stageRuntime } from "./stage.js";
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
   * Reworded 2026-09-11. This case used to be "because nothing is published yet", and asserted
   * only that the message contained "published" — which it would have gone on satisfying while
   * saying something false, because `@xplainer/cli` and `xplainer` reached npm at `0.0.1` that
   * morning and the refusal still told users nothing was published. What is actually unimplemented
   * is the branch that locates a global install, so that is what the message has to say, and the
   * refusal has to name the two commands that work in the meantime.
   */
  it("refuses `package-manager`, because the locator is unwritten — not because nothing is published", () => {
    const refusal = refusalFrom(() =>
      resolveProgram({ stateDir: freshState("published"), source: "package-manager" }),
    );
    expect(refusal.reason).toBe("unimplemented");
    expect(refusal.exitCode).toBe(NOT_IMPLEMENTED_EXIT_CODE);
    expect(refusal.message).toContain("the locator for it is not written yet");
    expect(refusal.message).toContain("xplainer runtime build --out <dir>");
    // The retired claim, pinned absent: it was false the moment 0.0.1 was published.
    expect(refusal.message).not.toContain("nothing is published yet");
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
