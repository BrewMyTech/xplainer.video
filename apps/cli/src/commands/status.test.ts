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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { MCP_CONTRACT_VERSION } from "@xplainer/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { writeCredential } from "../config/credentials.js";
import { userConfigPath, writeUserConfigValue } from "../config/user-config.js";
import { waitForReadyLine } from "../daemon/ready.js";
import { DAEMON_STATE_FILE, STATE_DIR_ENV, stateDirLayout } from "../daemon/state-dir.js";
import { CHILD_SERVE, type SpawnedChild, spawnEntry } from "../daemon/testing/spawn-child.js";
import { TOKEN_FILE } from "../daemon/token.js";
import type { CliIo } from "../io.js";
import { SETTING_FLAGS } from "../runtime/launch-spec.js";
import { recordTestToolchain } from "../setup/testing/toolchain.js";
import { TOOLCHAIN_MISSING, toolchainMarkerPath } from "../setup/toolchain.js";
import { ELEVENLABS_API_KEY_ENV, TTS_PROVIDER_ENV } from "../tts/index.js";
import { TEST_API_KEY } from "../tts/testing/elevenlabs-fixture.js";
import { CLI_VERSION } from "../version.js";
import {
  createStatusCommand,
  DAEMON_URL_ENV,
  STATUS_REPORT_VERSION,
  type StatusReport,
} from "./status.js";

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

/**
 * Run `status` against `stateDir`, recording everything a user would have seen.
 *
 * `env` sets — or, with `undefined`, removes — variables for this one invocation, and every one of
 * them is put back afterwards, so a case about a shell's speech settings neither leaks into the
 * next case nor depends on what the shell running the suite exported.
 */
async function status(
  stateDir: string,
  args: readonly string[] = [],
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<Invocation> {
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

  const overrides: Record<string, string | undefined> = { ...env, [STATE_DIR_ENV]: stateDir };
  const previous = new Map(Object.keys(overrides).map((name) => [name, process.env[name]]));
  const assign = (values: ReadonlyMap<string, string | undefined>): void => {
    for (const [name, value] of values) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
  assign(new Map(Object.entries(overrides)));
  let exitCode: number | undefined;
  try {
    await createStatusCommand(io).parseAsync([...args], { from: "user" });
  } catch (error) {
    if (!(error instanceof ExitSignal)) {
      throw error;
    }
    exitCode = error.code;
  } finally {
    assign(previous);
  }

  return { exitCode, stdout: out.join(""), stderr: err.join("") };
}

/**
 * A real daemon on an ephemeral port, already past its ready line, on a machine where setup has
 * run — so `ok` on its `/healthz` means healthy rather than "this fixture forgot the toolchain",
 * which is what `serve.test.ts`'s fixture does for the same reason.
 */
async function daemonOn(stateDir: string): Promise<{ child: SpawnedChild; port: number }> {
  recordTestToolchain({ stateDir });
  const child = spawnEntry(CHILD_SERVE, ["--port", "0"], { [STATE_DIR_ENV]: stateDir });
  children.push(child.process);
  const ready = await waitForReadyLine(child.process, { timeoutMs: 20_000 });
  return { child, port: ready.port };
}

/** Run `status --json` and parse the one object it wrote. */
async function statusJson(
  stateDir: string,
  args: readonly string[] = [],
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<{ report: StatusReport; exitCode: number | undefined; stdout: string }> {
  const invocation = await status(stateDir, ["--json", ...args], env);
  return {
    report: JSON.parse(invocation.stdout) as StatusReport,
    exitCode: invocation.exitCode,
    stdout: invocation.stdout,
  };
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
    const { port } = await daemonOn(stateDir);
    // Two state directories, which is what the condition actually describes: a daemon holds the
    // port, and *this* record's token is not its token. Corrupting the running daemon's own token
    // file would no longer produce it — the daemon follows that file, so that it can pick up an
    // `xplainer token rotate` without a restart (ADR 0020 §Security R-SEC-8) — and a simulation
    // that leans on the daemon *not* reading its own credential was never the shape of the fault.
    const intruded = stateDirectory();
    writeFileSync(join(intruded, DAEMON_STATE_FILE), JSON.stringify({ format_version: 1, port }));
    writeFileSync(join(intruded, TOKEN_FILE), "a-token-that-daemon-never-minted\n");

    const { stdout, exitCode } = await status(intruded);

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

/**
 * `--json` is the surface `apps/desktop`'s discovery shells out to rather than reimplementing
 * state-directory resolution, so what it must never make a caller do is parse a sentence. Every
 * case here asserts the **condition code**, and the daemons are real: a stubbed `/healthz` would
 * assert the one thing this command exists not to trust.
 */
describe("xplainer status --json", () => {
  /**
   * The story's own verification, end to end: a real daemon started with all three settings under
   * a throwaway state directory, whose `status --json` reports each of them and whose socket and
   * token are really at the given paths. Without the read-back this would be a report of what
   * somebody intended rather than of what the process used.
   */
  it("reports the three settings a real daemon was started with", async () => {
    const stateDir = stateDirectory();
    const decoyStateDir = stateDirectory();
    const tokenFile = join(stateDir, "delivered-token");
    const socket = join(stateDir, "run", "x.sock");

    const child = spawnEntry(
      CHILD_SERVE,
      [
        "--port",
        "0",
        SETTING_FLAGS.stateDir,
        stateDir,
        SETTING_FLAGS.tokenFile,
        tokenFile,
        SETTING_FLAGS.socket,
        socket,
      ],
      { [STATE_DIR_ENV]: decoyStateDir },
    );
    children.push(child.process);
    const ready = await waitForReadyLine(child.process, { timeoutMs: 20_000 });

    const { report, exitCode } = await statusJson(stateDir);

    expect(exitCode).toBeUndefined();
    expect(report.schema_version).toBe(STATUS_REPORT_VERSION);
    expect(report.condition).toBe("ready");
    expect(report.exit_code).toBe(0);
    expect(report.state_dir).toBe(stateDir);
    expect(report.daemon.token_file).toBe(tokenFile);
    expect(report.daemon.socket_path).toBe(socket);
    expect(report.daemon.port).toBe(ready.port);
    expect(report.health?.contract_version).toBe(MCP_CONTRACT_VERSION);
    expect(report.health?.version).toBe(CLI_VERSION);
    // Reported, and true: both files are where the report says they are.
    expect(existsSync(tokenFile)).toBe(true);
    expect(existsSync(socket)).toBe(true);
    expect(ready.socket).toBe(socket);
  }, 30_000);

  /** R-SEC-6 on the reporting surface too: the path is the fact, the value never appears. */
  it("carries the token's path and never the token itself", async () => {
    const stateDir = stateDirectory();
    await daemonOn(stateDir);
    const token = readFileSync(join(stateDir, TOKEN_FILE), "utf8").trim();

    const { stdout, report } = await statusJson(stateDir);

    expect(report.daemon.token_file).toBe(join(stateDir, TOKEN_FILE));
    expect(token.length).toBeGreaterThan(0);
    expect(stdout).not.toContain(token);
  }, 30_000);

  /**
   * "Nothing answered" is two different situations and only one of them is a problem to
   * investigate: a machine with no daemon installed needs an install, and the desktop's `absent`
   * outcome is exactly that. The two state files are what tells them apart.
   */
  it("says absent when nothing has ever bound here, and unreachable when something has", async () => {
    const nothing = await statusJson(stateDirectory());
    expect(nothing.report.condition).toBe("absent");
    expect(nothing.report.exit_code).toBe(4);
    expect(nothing.exitCode).toBe(4);

    const recorded = stateDirectory();
    writeFileSync(
      stateDirLayout(recorded).daemonState,
      JSON.stringify({ format_version: 1, port: 1, contract_version: MCP_CONTRACT_VERSION }),
    );
    const gone = await statusJson(recorded);
    expect(gone.report.condition).toBe("unreachable");
    expect(gone.report.probe.http_status).toBeNull();
    expect(gone.report.probe.error).not.toBeNull();
  }, 30_000);

  /** One HTTP status, two conditions, because the remedies have nothing in common. */
  it("tells a refused token apart from having no token to present", async () => {
    const held = stateDirectory();
    const { port } = await daemonOn(held);
    // The same two-directory arrangement the prose case above uses, and for the same reason.
    const intruded = stateDirectory();
    writeFileSync(join(intruded, DAEMON_STATE_FILE), JSON.stringify({ format_version: 1, port }));
    writeFileSync(join(intruded, TOKEN_FILE), "a-token-that-daemon-never-minted\n");
    const refused = await statusJson(intruded);
    expect(refused.report.condition).toBe("unauthorized");
    expect(refused.report.probe.http_status).toBe(401);

    const untokened = stateDirectory();
    await daemonOn(untokened);
    rmSync(join(untokened, TOKEN_FILE));
    const empty = await statusJson(untokened);
    expect(empty.report.condition).toBe("token_absent");
    expect(empty.report.probe.http_status).toBe(401);
  }, 30_000);

  /**
   * A latched breaker is not "not answering": no supervisor is going to start this daemon until
   * `xplainer daemon restart` clears it, so the remedy is a command rather than an investigation.
   */
  it("says stalled when the breaker is latched, and carries the words it latched", async () => {
    const stateDir = stateDirectory();
    writeFileSync(
      stateDirLayout(stateDir).daemonState,
      JSON.stringify({
        format_version: 1,
        port: 1,
        stalled: { at: "2026-09-06T00:00:00.000Z", reason: "five failed starts in a row" },
      }),
    );

    const { report } = await statusJson(stateDir);

    expect(report.condition).toBe("stalled");
    expect(report.daemon.stalled).toEqual({
      at: "2026-09-06T00:00:00.000Z",
      reason: "five failed starts in a row",
    });
  });

  /**
   * Compatibility is a relation between a daemon and the shim asking, so this command reports the
   * daemon's contract version and never decides for a caller whose own version it does not know.
   */
  it("reports the daemon's contract version rather than a verdict about it", async () => {
    const stateDir = stateDirectory();
    await daemonOn(stateDir);

    const { report } = await statusJson(stateDir);

    expect(report.health?.contract_version).toBe(MCP_CONTRACT_VERSION);
    expect(report.condition).toBe("ready");
  }, 30_000);

  /** A state file that cannot be read has no report to write, so stdout stays empty. */
  it("writes nothing to stdout when it exits 11 instead", async () => {
    const stateDir = stateDirectory();
    writeFileSync(stateDirLayout(stateDir).daemonState, "{ half a state file");

    const { exitCode, stdout } = await status(stateDir, ["--json"]);

    expect(exitCode).toBe(11);
    expect(stdout).toBe("");
  });
});

/**
 * The speech line: what this machine narrates with, read through the same resolver the narration
 * worker asks. Every case asserts the three things spec §6 fixes beside the line itself — the
 * condition and the exit code are what they would be with no speech settings at all, and the key
 * appears in nothing written — because a status that changed its verdict over a voice, or printed
 * the key it was reporting on, would be worse than no line.
 *
 * The shell's two speech variables are cleared for every case unless the case sets them, so the
 * suite says the same thing on a machine whose owner exported `ELEVENLABS_API_KEY`.
 */
describe("xplainer status and speech", () => {
  const unset = { [TTS_PROVIDER_ENV]: undefined, [ELEVENLABS_API_KEY_ENV]: undefined };

  /** A state directory configured for ElevenLabs, with or without a stored key. */
  function elevenLabsMachine(withKey: boolean): string {
    const stateDir = stateDirectory();
    writeUserConfigValue(stateDir, "tts.provider", "elevenlabs");
    if (withKey) {
      writeCredential(stateDir, "tts.elevenlabs.api_key", TEST_API_KEY);
    }
    return stateDir;
  }

  /** The lines between `socket:` and `probing:`, which is where spec §6 puts speech. */
  function speechBlock(stdout: string): string[] {
    const lines = stdout.split("\n");
    const socket = lines.findIndex((line) => line.startsWith("socket:"));
    // The toolchain block follows speech, so it is where the speech block ends.
    const toolchain = lines.findIndex((line) => line.startsWith("toolchain:"));
    return lines.slice(socket + 1, toolchain);
  }

  it("reports kokoro by default, and says the route is the job log's to tell", async () => {
    const stateDir = stateDirectory();

    const prose = await status(stateDir, [], unset);
    const json = await statusJson(stateDir, [], unset);

    expect(speechBlock(prose.stdout)).toEqual([
      "speech:          kokoro (default) — the route is chosen per narration; see the job log",
    ]);
    expect(json.report.speech).toEqual({
      provider: "kokoro",
      provider_origin: "default",
      voice: null,
      model: null,
      api_key: null,
      api_key_origin: null,
    });
    expect(prose.exitCode).toBe(4);
    expect(json.report.condition).toBe("absent");
    expect(json.report.schema_version).toBe(STATUS_REPORT_VERSION);
  });

  it("reports ElevenLabs, its defaults and a stored key — by presence only", async () => {
    const stateDir = elevenLabsMachine(true);

    const prose = await status(stateDir, [], unset);
    const json = await statusJson(stateDir, [], unset);

    expect(speechBlock(prose.stdout)).toEqual([
      "speech:          elevenlabs — voice JBFqnCBsd6RMkjVDRZzb (default), model " +
        "eleven_multilingual_v2 (default); provider from config.json",
      "                 api key: set (credentials.json)",
    ]);
    expect(json.report.speech).toEqual({
      provider: "elevenlabs",
      provider_origin: "config",
      voice: "JBFqnCBsd6RMkjVDRZzb",
      model: "eleven_multilingual_v2",
      api_key: "set",
      api_key_origin: "credentials",
    });
    expect(prose.exitCode).toBe(4);
    expect(json.report.condition).toBe("absent");
    expect(prose.stdout + prose.stderr + json.stdout).not.toContain(TEST_API_KEY);
  });

  it("says narration will be refused when ElevenLabs has no key", async () => {
    const stateDir = elevenLabsMachine(false);
    writeUserConfigValue(stateDir, "tts.elevenlabs.model", "eleven_flash_v2_5");

    const prose = await status(stateDir, [], unset);
    const json = await statusJson(stateDir, [], unset);

    expect(speechBlock(prose.stdout)).toEqual([
      "speech:          elevenlabs — voice JBFqnCBsd6RMkjVDRZzb (default), model " +
        "eleven_flash_v2_5 (config.json); provider from config.json",
      "                 api key: NOT SET — narration will be refused; run " +
        "`xplainer config set tts.elevenlabs.api_key`",
    ]);
    expect(json.report.speech).toMatchObject({
      model: "eleven_flash_v2_5",
      api_key: "unset",
      api_key_origin: null,
    });
    expect(prose.exitCode).toBe(4);
    expect(json.report.condition).toBe("absent");
  });

  /** A supervised daemon does not inherit the shell, so a shell-only setting is flagged. */
  it("flags settings taken from this shell's environment, and still never prints the key", async () => {
    const stateDir = stateDirectory();
    const shell = { [TTS_PROVIDER_ENV]: "elevenlabs", [ELEVENLABS_API_KEY_ENV]: TEST_API_KEY };

    const prose = await status(stateDir, [], shell);
    const json = await statusJson(stateDir, [], shell);

    expect(speechBlock(prose.stdout)).toEqual([
      "speech:          elevenlabs — voice JBFqnCBsd6RMkjVDRZzb (default), model " +
        "eleven_multilingual_v2 (default); provider from XPLAINER_TTS_PROVIDER",
      "                 api key: set (ELEVENLABS_API_KEY)",
      "                 ⚠ XPLAINER_TTS_PROVIDER and ELEVENLABS_API_KEY are taken from this " +
        "shell's environment, which a supervised daemon does not inherit — store them with " +
        "`xplainer config set`",
    ]);
    expect(json.report.speech).toMatchObject({
      provider_origin: "environment",
      api_key: "set",
      api_key_origin: "environment",
    });
    expect(prose.exitCode).toBe(4);
    expect(json.report.condition).toBe("absent");
    expect(prose.stdout + prose.stderr + json.stdout).not.toContain(TEST_API_KEY);
  });

  /** `status` is what a user runs to find out what is wrong, so a bad file is a line. */
  it("reports an unreadable config.json as unknown without failing", async () => {
    const stateDir = stateDirectory();
    writeFileSync(userConfigPath(stateDir), "{ half a document");

    const prose = await status(stateDir, [], unset);
    const json = await statusJson(stateDir, [], unset);

    const block = speechBlock(prose.stdout);
    expect(block).toHaveLength(1);
    expect(
      block[0]?.startsWith(
        `speech:          unknown — ${userConfigPath(stateDir)} cannot be read (it is not valid JSON`,
      ),
      block[0],
    ).toBe(true);
    expect(prose.stderr).toBe("");
    expect(json.report.speech).toBeNull();
    expect(prose.exitCode).toBe(4);
    expect(json.report.condition).toBe("absent");
  });

  it("leaves a ready daemon ready whatever the speech settings say", async () => {
    const stateDir = elevenLabsMachine(false);
    await daemonOn(stateDir);

    const prose = await status(stateDir, [], unset);
    const json = await statusJson(stateDir, [], unset);

    expect(prose.exitCode).toBeUndefined();
    expect(prose.stdout).toContain("running and healthy");
    expect(prose.stdout).toContain("api key: NOT SET");
    expect(json.report.condition).toBe("ready");
    expect(json.report.exit_code).toBe(0);
    expect(json.report.speech?.api_key).toBe("unset");
  }, 30_000);
});

/**
 * ADR 0031 §Note, 2026-11-12, D10: the toolchain block, and `/healthz`'s `reason`. The condition is
 * untouched — an answering daemon is `ready` in this command's closed set — and a degraded one says
 * so through `health`, with the toolchain block naming what is wrong.
 */
describe("xplainer status — the toolchain", () => {
  it("prints what the marker records, and reports the gate's verdict as /healthz gives it", async () => {
    const stateDir = stateDirectory();
    await daemonOn(stateDir);

    const prose = await status(stateDir, [], { XPLAINER_FFMPEG: undefined });
    const { report } = await statusJson(stateDir, [], { XPLAINER_FFMPEG: undefined });

    expect(prose.stdout).toContain("toolchain:       ready to render");
    expect(prose.stdout).toMatch(/\n {2}browser: {7}157\.0\.8103\.50 \(manifest\)\n/);
    expect(prose.stdout).toMatch(
      /\n {2}ffmpeg: {8}.+, no publisher \(named with --ffmpeg-path\), provider path\n/,
    );
    expect(prose.stdout).toMatch(/\n {2}speech: {8}docker \(/);
    expect(report.health).toMatchObject({ status: "ok", reason: null });
    expect(report.toolchain).toMatchObject({
      ok: true,
      reason: null,
      path: toolchainMarkerPath(stateDir),
      browser: { version: "157.0.8103.50", provider: "manifest" },
      ffmpeg: { provider: "path", publisher: null },
      speech: { provider: "docker" },
    });

    rmSync(toolchainMarkerPath(stateDir));
    const degraded = await statusJson(stateDir, [], { XPLAINER_FFMPEG: undefined });
    const degradedProse = await status(stateDir, [], { XPLAINER_FFMPEG: undefined });

    expect(degraded.report.condition).toBe("ready");
    expect(degraded.report.health).toMatchObject({ status: "degraded", reason: TOOLCHAIN_MISSING });
    expect(degraded.report.toolchain).toMatchObject({
      ok: false,
      reason: TOOLCHAIN_MISSING,
      browser: null,
      ffmpeg: null,
    });
    expect(degradedProse.stdout).toContain(`toolchain:       ${TOOLCHAIN_MISSING} — `);
    expect(degradedProse.stdout).toContain("running, degraded (toolchain_missing)");
    expect(degradedProse.stdout).not.toContain("running and healthy");
  }, 30_000);
});
