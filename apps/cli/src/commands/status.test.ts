/**
 * `xplainer status`, against daemons that are really there and daemons that are really not.
 *
 * The command's whole job is to distrust `runtime.json` — ADR 0020 §Port and discovery says it is
 * "never trusted without a liveness check", because on macOS and Windows nothing reaps it — so
 * every case here is defined by the *disagreement* between the files and the port: a daemon that
 * answers, a port that refuses the connection, and a port that answers `401` to our own token,
 * which is the sentence "something is on our port that is not our daemon" and is a different
 * problem from a daemon that is not running.
 *
 * The daemon is a real spawned `serve`; the probe is a real HTTP request. Nothing is stubbed,
 * because a stubbed `/healthz` would assert the one thing this command exists not to trust.
 */

import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { MCP_CONTRACT_VERSION } from "@xplainer/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { waitForReadyLine } from "../daemon/ready.js";
import { STATE_DIR_ENV, stateDirLayout } from "../daemon/state-dir.js";
import { CHILD_SERVE, type SpawnedChild, spawnEntry } from "../daemon/testing/spawn-child.js";
import { TOKEN_FILE } from "../daemon/token.js";
import type { CliIo } from "../io.js";
import { CLI_VERSION } from "../version.js";
import { createStatusCommand, DAEMON_URL_ENV } from "./status.js";

/** Thrown in place of `process.exit`, carrying the code the command asked for. */
class ExitSignal extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`exit ${code}`);
    this.name = "ExitSignal";
    this.code = code;
  }
}

type Invocation = {
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
};

const scratch: string[] = [];
const children: ChildProcess[] = [];

function stateDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "xplainer-status-"));
  scratch.push(dir);
  return dir;
}

/** Run `status` against `stateDir`, recording everything a user would have seen. */
async function status(stateDir: string, args: readonly string[] = []): Promise<Invocation> {
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

  const previous = process.env[STATE_DIR_ENV];
  process.env[STATE_DIR_ENV] = stateDir;
  let exitCode: number | undefined;
  try {
    await createStatusCommand(io).parseAsync([...args], { from: "user" });
  } catch (error) {
    if (!(error instanceof ExitSignal)) {
      throw error;
    }
    exitCode = error.code;
  } finally {
    if (previous === undefined) {
      delete process.env[STATE_DIR_ENV];
    } else {
      process.env[STATE_DIR_ENV] = previous;
    }
  }

  return { exitCode, stdout: out.join(""), stderr: err.join("") };
}

/** A real daemon on an ephemeral port, already past its ready line. */
async function daemonOn(stateDir: string): Promise<{ child: SpawnedChild; port: number }> {
  const child = spawnEntry(CHILD_SERVE, ["--port", "0"], { [STATE_DIR_ENV]: stateDir });
  children.push(child.process);
  const ready = await waitForReadyLine(child.process, { timeoutMs: 20_000 });
  return { child, port: ready.port };
}

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("xplainer status", () => {
  it("reports a running daemon from the two files and a real authenticated /healthz", async () => {
    const stateDir = stateDirectory();
    const { port } = await daemonOn(stateDir);

    const { stdout, exitCode } = await status(stateDir);

    expect(exitCode).toBeUndefined();
    expect(stdout).toContain(`state directory: ${stateDir}`);
    expect(stdout).toContain(`port ${port}`);
    expect(stdout).toContain(`contract ${MCP_CONTRACT_VERSION}`);
    expect(stdout).toContain("running and healthy");
    expect(stdout).toContain(`version ${CLI_VERSION}`);
    expect(stdout).toContain(`pid ${String(children[0]?.pid)}`);
    // The probe is the fact; the file is the hint that led to it.
    expect(stdout).toContain(`probing:         http://127.0.0.1:${port}/healthz`);
    expect(stdout).toContain("port from daemon.json");
  }, 30_000);

  /**
   * A `401` against *our own* token proves the port is bound and proves nothing about readiness,
   * so it must not print the same line as a daemon that is not running.
   */
  it("says something else is on the port when the daemon refuses our token", async () => {
    const stateDir = stateDirectory();
    await daemonOn(stateDir);
    // The daemon holds its token in memory; replacing the file leaves `status` holding a token
    // that daemon never minted, which is exactly the shape of the mismatch this line is for.
    writeFileSync(join(stateDir, TOKEN_FILE), "a-token-that-daemon-never-minted\n");

    const { stdout, exitCode } = await status(stateDir);

    expect(exitCode).toBe(4);
    expect(stdout).toContain("something is on that port that is not this daemon");
    expect(stdout).toContain("401");
    expect(stdout).not.toContain("running and healthy");
  }, 30_000);

  /** The other reading of a 401: not an intruder, just a command with nothing to present. */
  it("says it had no token to present when the token file is missing", async () => {
    const stateDir = stateDirectory();
    const { port } = await daemonOn(stateDir);
    rmSync(join(stateDir, TOKEN_FILE));

    const { stdout, exitCode } = await status(stateDir);

    expect(exitCode).toBe(4);
    expect(stdout).toContain("had no token to present");
    expect(stdout).toContain("(absent or empty)");
    expect(stdout).not.toContain("is not this daemon");
    expect(port).toBeGreaterThan(0);
  }, 30_000);

  it("says a recorded daemon is not answering, and exits 4", async () => {
    const stateDir = stateDirectory();
    writeFileSync(
      stateDirLayout(stateDir).daemonState,
      JSON.stringify({ format_version: 1, port: 1, contract_version: MCP_CONTRACT_VERSION }),
    );

    const { stdout, exitCode } = await status(stateDir);

    expect(exitCode).toBe(4);
    expect(stdout).toContain("not answering");
    expect(stdout).toContain(
      "runtime.json:    absent — no run has bound, or the last one shut down cleanly",
    );
  }, 30_000);

  it("exits 11 when daemon.json exists and cannot be read", async () => {
    const stateDir = stateDirectory();
    writeFileSync(stateDirLayout(stateDir).daemonState, "{ half a state file");

    const { stderr, exitCode } = await status(stateDir);

    expect(exitCode).toBe(11);
    expect(stderr).toContain("cannot be read as JSON");
  });

  it("probes the URL it is given rather than the recorded port", async () => {
    const stateDir = stateDirectory();
    const { port } = await daemonOn(stateDir);
    const other = stateDirectory();
    writeFileSync(
      stateDirLayout(other).daemonState,
      JSON.stringify({
        format_version: 1,
        port: 1,
        token_file: join(stateDir, TOKEN_FILE),
      }),
    );

    const { stdout, exitCode } = await status(other, ["--url", `http://127.0.0.1:${port}`]);

    expect(exitCode).toBeUndefined();
    expect(stdout).toContain("port from configured");
    expect(stdout).toContain("running and healthy");
  }, 30_000);

  it("reports a stalled circuit breaker in the words the breaker latched", async () => {
    const stateDir = stateDirectory();
    writeFileSync(
      stateDirLayout(stateDir).daemonState,
      JSON.stringify({
        format_version: 1,
        port: 1,
        stalled: { at: "2026-09-06T00:00:00.000Z", reason: "five failed starts in a row" },
      }),
    );

    const { stdout, exitCode } = await status(stateDir);

    expect(exitCode).toBe(4);
    expect(stdout).toContain("stalled:         since 2026-09-06T00:00:00.000Z");
    expect(stdout).toContain("five failed starts in a row");
  });

  it("names the daemon URL environment variable in its own help", () => {
    const silent: CliIo = {
      writeOut: () => {},
      writeErr: () => {},
      exit: (code): never => {
        throw new ExitSignal(code);
      },
    };

    expect(createStatusCommand(silent).helpInformation()).toContain(DAEMON_URL_ENV);
  });
});
