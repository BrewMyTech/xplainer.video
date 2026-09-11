/**
 * `xplainer daemon install`'s refusals: the exit code and the sentence a user actually gets.
 *
 * **This file exists because one arm of that action was unreachable from every other suite.** The
 * install verb reads `installedPackageRoot()`, whose answer depends on whether *this module* sits
 * inside a `node_modules` — in a checkout it is always `null`, so the argument-free route is not
 * taken here at all, and the branch that turns a failed assemble into an exit code had no caller in
 * the suite and no assertion. It was also wrong: `MaterialiseRefusal` fell past every arm to
 * `throw error`, commander's `parseAsync` rejected, and a user out of disk got the class printed as
 * a stack trace — `exitCode: 3` visible *inside* the dump — and a real exit code of `1`.
 *
 * So the mapping is a pure function (`describeInstallRefusal`) asserted over real constructed
 * refusals, and the wiring is asserted by driving the real commander program to the one refusal a
 * checkout can reach. The lifecycle verbs themselves are `install/lifecycle.test.ts`'s and the
 * install's own phases are `install/install.test.ts`'s; what is left here is the command.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRECONDITION_UNMET_EXIT_CODE } from "../daemon/exit-codes.js";
import { STATE_DIR_ENV } from "../daemon/state-dir.js";
import { InstallRefusal } from "../install/install.js";
import { MaterialiseRefusal } from "../install/materialise.js";
import type { CliIo } from "../io.js";
import { createProgram } from "../program.js";
import { describeInstallRefusal } from "./daemon.js";

/** Thrown in place of `process.exit`, carrying the code the command asked for. */
class ExitSignal extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`exit ${code}`);
    this.name = "ExitSignal";
    this.code = code;
  }
}

/** What one invocation produced. */
type Invocation = { exitCode: number | undefined; stdout: string; stderr: string };

/** Run `xplainer <argv…>` through the real program and collect what a user would have seen. */
async function run(argv: string[]): Promise<Invocation> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    writeOut(text) {
      out.push(text);
    },
    writeErr(text) {
      err.push(text);
    },
    exit(code): never {
      throw new ExitSignal(code);
    },
  };

  let exitCode: number | undefined;
  try {
    await createProgram(io).parseAsync(argv, { from: "user" });
  } catch (error) {
    if (!(error instanceof ExitSignal)) {
      throw error;
    }
    exitCode = error.code;
  }
  return { exitCode, stdout: out.join(""), stderr: err.join("") };
}

let scratch = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "xplainer-daemon-cmd-"));
  previousStateDir = process.env[STATE_DIR_ENV];
  // The command resolves its own state directory, and it must not be this machine's real one.
  process.env[STATE_DIR_ENV] = join(scratch, "state");
  mkdirSync(join(scratch, "state"), { recursive: true, mode: 0o700 });
});

afterEach(() => {
  if (previousStateDir === undefined) {
    delete process.env[STATE_DIR_ENV];
  } else {
    process.env[STATE_DIR_ENV] = previousStateDir;
  }
  rmSync(scratch, { recursive: true, force: true });
});

describe("describeInstallRefusal", () => {
  it("maps a payload that would not assemble onto its documented exit code", () => {
    const refusal = new MaterialiseRefusal(
      "not-a-payload",
      "the install at /x could not be assembled into a payload: ENOSPC: no space left on device",
    );

    const described = describeInstallRefusal(refusal);

    expect(described).not.toBeNull();
    expect(described?.exitCode).toBe(PRECONDITION_UNMET_EXIT_CODE);
    // The underlying cause survives, because a reader who is out of disk needs to see `ENOSPC`
    // rather than a code — and one line, because there is nothing to roll back.
    expect(described?.lines).toEqual([
      "xplainer daemon install: the install at /x could not be assembled into a payload: " +
        "ENOSPC: no space left on device\n",
    ]);
  });

  it("names what a refused install put back, one line each", () => {
    const refusal = new InstallRefusal("verify", 4, "the daemon never answered", [
      "deregistered xplainer.service",
      "removed the runtime staged at /s/runtime/0.0.1-abc",
    ]);

    expect(describeInstallRefusal(refusal)).toEqual({
      exitCode: 4,
      lines: [
        "xplainer daemon install: the daemon never answered\n",
        "  rolled back: deregistered xplainer.service\n",
        "  rolled back: removed the runtime staged at /s/runtime/0.0.1-abc\n",
      ],
    });
  });

  /**
   * The `null` arm is what the caller must rethrow, and it is the reason this function answers with
   * `null` rather than with a default: a class nobody mapped is a defect, and swallowing it into
   * exit `70` with a generic sentence is how the `MaterialiseRefusal` hole stayed invisible.
   */
  it("answers null for anything it does not map, so the caller rethrows", () => {
    expect(describeInstallRefusal(new Error("something else"))).toBeNull();
    expect(describeInstallRefusal(new TypeError("x is not a function"))).toBeNull();
    expect(describeInstallRefusal("a string")).toBeNull();
    expect(describeInstallRefusal(undefined)).toBeNull();
  });
});

describe("xplainer daemon install", () => {
  /**
   * The wiring, through the real program: a state directory with no `toolchain.json` refuses in the
   * read-only preflight, and the arm above is what turns that into the code and the sentence. It is
   * the one refusal a checkout can reach — `installedPackageRoot()` answers `null` here, so no
   * payload is built and nothing is assembled to fail.
   */
  it("exits 3 and names `xplainer setup` when the machine has no setup marker", async () => {
    const result = await run(["daemon", "install"]);

    expect(result.exitCode).toBe(PRECONDITION_UNMET_EXIT_CODE);
    expect(result.stderr).toContain("xplainer daemon install:");
    expect(result.stderr).toContain("xplainer setup");
    // A refusal is written to stderr and nothing is claimed on stdout.
    expect(result.stdout).toBe("");
  });
});
