/**
 * `xplainer token rotate`, driven through the real commander program.
 *
 * What a *user* sees is an exit code, two streams and what is on disk afterwards, so this file
 * builds the real program with a recording `CliIo` — the shape `program.test.ts` set and
 * `runtime.test.ts` reuses — and asserts against those over a real state directory. Nothing is
 * substituted: the rotation is `daemon/token.ts`'s, the record is `daemon.json`'s, and the files
 * are read back off the filesystem.
 *
 * The rotation's own rules — the window, the atomic replace, the grace file's protection — are
 * asserted in `daemon/token.test.ts`. What is left here is the part only the command owns: the
 * precedence its two path flags take, the exit code each refusal carries, that `daemon.json` learns
 * about the window, and that **no token value is ever printed**.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDaemonState } from "../daemon/daemon-state.js";
import { PRECONDITION_UNMET_EXIT_CODE, USAGE_EXIT_CODE } from "../daemon/exit-codes.js";
import { STATE_FILE_MODE } from "../daemon/state-dir.js";
import { loadOrMintToken, previousTokenPath, TOKEN_FILE } from "../daemon/token.js";
import type { CliIo } from "../io.js";
import { createProgram } from "../program.js";

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

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "xplainer-token-cmd-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("xplainer token rotate", () => {
  it("writes a new token, keeps the old one, and says until when", async () => {
    const path = join(scratch, TOKEN_FILE);
    const before = loadOrMintToken(path, scratch);

    const { stdout, stderr, exitCode } = await run(["token", "rotate", "--state-dir", scratch]);

    expect(stderr).toBe("");
    expect(exitCode).toBeUndefined();
    expect(readFileSync(path, "utf8").trim()).not.toBe(before.value);
    expect(stdout).toContain(`wrote a new bearer token to ${path}`);
    expect(stdout).toContain("the previous token keeps working until");
    expect(stdout).toContain(previousTokenPath(path));
  });

  /**
   * R-SEC-6 in one assertion. The value is in the file and nowhere else — not in the sentence a
   * user just put in their scrollback, and not in the record `status --json` prints.
   */
  it("prints neither value, and puts neither in daemon.json", async () => {
    const path = join(scratch, TOKEN_FILE);
    const before = loadOrMintToken(path, scratch);

    const { stdout } = await run(["token", "rotate", "--state-dir", scratch]);
    const after = readFileSync(path, "utf8").trim();

    expect(stdout).not.toContain(before.value);
    expect(stdout).not.toContain(after);
    const record = readFileSync(join(scratch, "daemon.json"), "utf8");
    expect(record).not.toContain(before.value);
    expect(record).not.toContain(after);
  });

  /** The window is what `daemon status` reports, so it has to reach the durable record. */
  it("records the window in daemon.json as two instants and a path", async () => {
    const path = join(scratch, TOKEN_FILE);
    loadOrMintToken(path, scratch);

    await run(["token", "rotate", "--state-dir", scratch, "--grace", "600"]);
    const rotation = readDaemonState(scratch).token_rotation;

    expect(rotation).not.toBeNull();
    expect(rotation?.previous_token_file).toBe(previousTokenPath(path));
    const opened = Date.parse(rotation?.rotated_at ?? "");
    const closes = Date.parse(rotation?.grace_until ?? "");
    expect(closes - opened).toBe(600_000);
  });

  /** `--grace 0` is the answer to a leak: the record says so, and no grace file is left. */
  it("records a window of no length, and leaves no grace file, for --grace 0", async () => {
    const path = join(scratch, TOKEN_FILE);
    loadOrMintToken(path, scratch);

    const { stdout } = await run(["token", "rotate", "--state-dir", scratch, "--grace", "0"]);
    const rotation = readDaemonState(scratch).token_rotation;

    expect(rotation?.previous_token_file).toBeNull();
    expect(rotation?.grace_until).toBe(rotation?.rotated_at);
    expect(stdout).toContain("locked out now");
  });

  /**
   * The file this command rewrites has to be the file the daemon reads, so `--token-file` takes the
   * same precedence over the state directory that `serve --token-file` does.
   */
  it("rotates the file --token-file names rather than the one in the state directory", async () => {
    const elsewhere = join(scratch, "secrets-token");
    const inState = join(scratch, TOKEN_FILE);
    const kept = loadOrMintToken(inState, scratch);
    const moved = loadOrMintToken(elsewhere, scratch);

    await run(["token", "rotate", "--state-dir", scratch, "--token-file", elsewhere]);

    expect(readFileSync(elsewhere, "utf8").trim()).not.toBe(moved.value);
    expect(readFileSync(inState, "utf8").trim()).toBe(kept.value);
  });

  /** Nothing to rotate: exit `3`, with nothing written and the command that mints one named. */
  it("exits 3 and writes nothing when there is no token", async () => {
    const { stdout, stderr, exitCode } = await run(["token", "rotate", "--state-dir", scratch]);

    expect(exitCode).toBe(PRECONDITION_UNMET_EXIT_CODE);
    expect(stdout).toBe("");
    expect(stderr).toContain("there is nothing to rotate and nothing has been written");
    expect(stderr).toContain("xplainer serve");
    expect(readDaemonState(scratch).token_rotation).toBeNull();
  });

  /** A token that exists and cannot be used is the other refusal, and it is not this one. */
  it("exits 12 for a token file that holds nothing", async () => {
    writeFileSync(join(scratch, TOKEN_FILE), "\n", { mode: STATE_FILE_MODE });

    const { stderr, exitCode } = await run(["token", "rotate", "--state-dir", scratch]);

    expect(exitCode).toBe(12);
    expect(stderr).toContain("it holds no token");
  });

  /** A window is a weakening with a deadline; commander's own code is what a rejected one takes. */
  it("exits 1 for a grace window longer than a day", async () => {
    loadOrMintToken(join(scratch, TOKEN_FILE), scratch);

    const { stderr, exitCode } = await run([
      "token",
      "rotate",
      "--state-dir",
      scratch,
      "--grace",
      "90000",
    ]);

    expect(exitCode).toBe(USAGE_EXIT_CODE);
    expect(stderr).toContain("between 0 and 86400 seconds");
  });
});
