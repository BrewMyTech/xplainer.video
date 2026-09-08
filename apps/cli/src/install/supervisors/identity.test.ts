/**
 * The three-row consistency check, and the one row that has to come from a real process.
 *
 * Two halves, and the split is the same one every supervisor story here makes.
 *
 * **Rows 1 and 2 and the comparison are asserted from one machine**, because both are reads: row 1
 * is `daemon.json` and row 2 is one supervisor query whose *answer* is the input. The systemd answer
 * used below is not invented — `__fixtures__/systemctl-show-loaded.txt` is the literal stdout of
 * `systemctl --user show -p ExecStart -p Environment -p WorkingDirectory --value xplainer.service`
 * against a real user manager in `infra/e2e/Dockerfile.systemd`, and
 * `__fixtures__/systemctl-show-defaults.txt` is the same query against a unit that sets neither
 * `Environment=` nor `WorkingDirectory=`, which is where the parser's two edge cases live.
 *
 * **Row 3 is asserted against a real `xplainer serve`.** A digest computed by the code under test
 * and compared with itself would prove nothing; what has to be true is that a daemon which was
 * *launched* advertises a value another process can recompute from the launch. So the cases below
 * spawn the real command through `daemon/testing/child-serve.ts`, read `/healthz` over the wire, and
 * recompute the digest from the argv, the settings and the working directory that child was given.
 *
 * The five scenarios T17 names are each one case here: a hand-edited `daemon.json`, an artefact
 * rewritten and never reloaded, an artefact rewritten *and* reloaded but not restarted, a
 * settings-only change, and — on macOS — the same failures with no row 2 at all.
 */

import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { describeStatus } from "../../commands/daemon.js";
import { readDaemonState, readRuntimeState, updateDaemonState } from "../../daemon/daemon-state.js";
import { waitForReadyLine } from "../../daemon/ready.js";
import { testIpcEndpoint } from "../../daemon/testing/platform.js";
import {
  CHILD_SERVE,
  type SpawnedChild,
  spawnEntry,
  untilGone,
} from "../../daemon/testing/spawn-child.js";
import { TOKEN_FILE } from "../../daemon/token.js";
import { type LaunchSpec, SETTING_FLAGS } from "../../runtime/launch-spec.js";
import { recordTestToolchain } from "../../setup/testing/toolchain.js";
import { WORKSPACE_DIR_NAME } from "../../workspace-root.js";
import { daemonStatus, loadedConfigurationQuery, type StatusProbe } from "../lifecycle.js";
import type { ProbeCommand, ProbeResult, ProbeRunner } from "../preflight.js";
import { writeToolchainMarker } from "../testing/toolchain.js";
import { readUpdateStatus } from "../update/recover.js";
import type { SupervisorEnvironment } from "./artefact.js";
import {
  checkIdentity,
  expectedLoaded,
  identityDigest,
  type LaunchIdentity,
  readDesired,
  readLoaded,
  readResponding,
} from "./identity.js";

/** How long a real `serve` gets to print its ready line here. */
const READY_MS = 20_000;

const scratch: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
    await untilGone(child.pid ?? 0, 5_000).catch(() => undefined);
  }
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scratchDirectory(prefix = "xp-id-"): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(directory);
  return directory;
}

function fixture(name: string): string {
  return readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), "utf8");
}

/** One supervisor answer, in the shape `preflight.ts` produces. */
function answered(stdout: string): ProbeResult {
  return { started: true, status: 0, stdout, stderr: "" };
}

/** A launch spec pointing into `runtimeDir`, of the shape `buildLaunchSpec` emits. */
function specFor(
  runtimeDir: string,
  stateDir: string,
  socket: string,
  joinPath: (...parts: string[]) => string = join,
): LaunchSpec {
  const executable = joinPath(runtimeDir, "bin", "node");
  const entry = joinPath(runtimeDir, "lib", "node_modules", "@xplainer", "cli", "dist", "bin.js");
  const tokenFile = joinPath(stateDir, TOKEN_FILE);
  return {
    executable,
    argv: [
      entry,
      "serve",
      "--port",
      "8787",
      SETTING_FLAGS.stateDir,
      stateDir,
      SETTING_FLAGS.tokenFile,
      tokenFile,
      SETTING_FLAGS.socket,
      socket,
    ],
    settings: { stateDir, tokenFile, socket },
    cwd: stateDir,
  };
}

/**
 * `systemctl --user show`'s answer for a spec, in the exact shape the container measured.
 *
 * Written out here rather than produced by the code under test: a comparison whose two sides came
 * from the same function would agree about a format that is wrong. The literal bytes this mimics are
 * in `__fixtures__/systemctl-show-loaded.txt` and are asserted separately below.
 */
function systemdShow(spec: LaunchSpec): string {
  return [
    `{ path=${spec.executable} ; argv[]=${[spec.executable, ...spec.argv].join(" ")} ; ` +
      "ignore_errors=no ; start_time=[Tue 2026-09-08 03:26:34 UTC] ; stop_time=[n/a] ; pid=154 ; " +
      "code=(null) ; status=0/0 }",
    `XPLAINER_STATE_DIR=${spec.settings.stateDir} XPLAINER_TOKEN_FILE=${spec.settings.tokenFile}`,
    spec.cwd,
    "",
  ].join("\n");
}

/** `Get-ScheduledTask`'s answer for a spec, in the three `Key=value` lines the query composes. */
function taskShow(spec: LaunchSpec, argumentLine: string): string {
  return [
    `Execute=${spec.executable}`,
    `Arguments=${argumentLine}`,
    `WorkingDirectory=${spec.cwd}`,
    "",
  ].join("\n");
}

/** A supervisor seam that answers the loaded-configuration query with `output` and nothing else. */
function loadedRunner(output: string): ProbeRunner {
  return (command: ProbeCommand): ProbeResult => {
    const spelled = `${command.program} ${command.argv.join(" ")}`;
    if (spelled.includes("show -p ExecStart") || spelled.includes("$action")) {
      return answered(output);
    }
    if (spelled.includes("print-disabled")) {
      return answered("\tdisabled services = {\n\t}\n");
    }
    if (spelled.includes("is-system-running")) {
      return answered("running\n");
    }
    return answered("");
  };
}

/** A `/healthz` seam that advertises exactly these two identity fields. */
function respondingProbe(runId: string, digest: string): () => Promise<StatusProbe> {
  return () =>
    Promise.resolve({
      kind: "ok",
      body: {
        status: "ok",
        version: "1.2.3",
        contract_version: "1",
        run_id: runId,
        runtime_digest: digest,
      },
    });
}

/** One `GET /healthz` with the bearer token, over `node:http` rather than `fetch`. */
function getHealthz(port: number, token: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const call = request(
      {
        host: "127.0.0.1",
        port,
        path: "/healthz",
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve(JSON.parse(body) as Record<string, unknown>);
        });
      },
    );
    call.on("error", reject);
    call.end();
  });
}

/** Start a real `serve` with the three settings as flags, and wait for its ready line. */
async function serveWith(
  stateDir: string,
  settings: { tokenFile: string; socket: string },
): Promise<{ child: SpawnedChild; port: number; token: string; argv: string[] }> {
  const args = [
    "--port",
    "0",
    SETTING_FLAGS.stateDir,
    stateDir,
    SETTING_FLAGS.tokenFile,
    settings.tokenFile,
    SETTING_FLAGS.socket,
    settings.socket,
  ];
  const child = spawnEntry(CHILD_SERVE, args, {});
  children.push(child.process);
  const ready = await waitForReadyLine(child.process, { timeoutMs: READY_MS });
  return {
    child,
    port: ready.port,
    token: readFileSync(settings.tokenFile, "utf8").trim(),
    // `process.argv` inside that child: the interpreter, the entry, then the words above. The
    // `--import` hook is an exec argument and never reaches `argv`.
    argv: [process.execPath, CHILD_SERVE, ...args],
  };
}

describe("the identity digest", () => {
  const base: LaunchIdentity = {
    argv: ["/rt/bin/node", "/rt/lib/bin.js", "serve", "--port", "8787"],
    settings: { stateDir: "/state", tokenFile: "/state/token", socket: "/state/ipc/x.sock" },
    cwd: "/state",
    runtimeDigest: "abc123def456",
  };

  it("is stable for identical inputs and moves for every one of the four", () => {
    expect(identityDigest(base)).toBe(identityDigest({ ...base }));
    const moved = [
      { ...base, argv: [...base.argv, "--bind", "::1"] },
      { ...base, settings: { ...base.settings, stateDir: "/other" } },
      { ...base, settings: { ...base.settings, tokenFile: "/other/token" } },
      { ...base, settings: { ...base.settings, socket: "/other/x.sock" } },
      { ...base, cwd: "/other" },
      { ...base, runtimeDigest: "def456abc123" },
      { ...base, runtimeDigest: null },
    ];
    const digests = new Set([identityDigest(base), ...moved.map(identityDigest)]);
    expect(digests.size).toBe(moved.length + 1);
  });

  /**
   * Criterion 5, at the level of the function: a settings-only change over *identical* runtime bytes
   * is a different identity. That is what makes row 3 sufficient on macOS, where it is the only row.
   */
  it("separates a settings-only change from an unchanged payload", () => {
    const before = identityDigest(base);
    const after = identityDigest({
      ...base,
      settings: { ...base.settings, socket: "/state/ipc/moved.sock" },
    });
    expect(after).not.toBe(before);
    expect(base.runtimeDigest).toBe("abc123def456");
  });

  /** The fields are labelled, so a value that moved between two of them is not the same document. */
  it("does not confuse a value in one field with the same value in another", () => {
    const asCwd = identityDigest({ ...base, cwd: "/shared", settings: { ...base.settings } });
    const asSocket = identityDigest({
      ...base,
      settings: { ...base.settings, socket: "/shared" },
    });
    expect(asCwd).not.toBe(asSocket);
  });
});

describe("row 2, the loaded configuration", () => {
  /** Criterion 7's Linux half: the query is the one the plan pins, all three properties. */
  it("asks systemd for ExecStart, Environment and WorkingDirectory, and macOS for nothing", () => {
    const linux = loadedConfigurationQuery({
      kind: "systemd",
      identity: "xplainer.service",
      artefact: "",
      uid: 0,
    });
    expect(`${linux?.program ?? ""} ${linux?.argv.join(" ") ?? ""}`).toBe(
      "systemctl --user show -p ExecStart -p Environment -p WorkingDirectory --value xplainer.service",
    );
    expect(
      loadedConfigurationQuery({
        kind: "launchd",
        identity: "video.xplainer.daemon",
        artefact: "",
        uid: 501,
      }),
    ).toBeNull();
  });

  /** Criterion 7's Windows half: the registered task, its working directory, and not the mirror. */
  it("asks Task Scheduler for the registered task's action, working directory included", () => {
    const windows = loadedConfigurationQuery({
      kind: "task-scheduler",
      identity: "\\xplainer\\tester-daemon",
      artefact: "C:\\Users\\tester\\AppData\\Local\\xplainer\\task.xml",
      uid: 0,
    });
    const spelled = `${windows?.program ?? ""} ${windows?.argv.join(" ") ?? ""}`;
    expect(spelled).toContain("Get-ScheduledTask -TaskName '\\xplainer\\tester-daemon'");
    expect(spelled).toContain("$action.WorkingDirectory");
    expect(spelled).toContain("$action.Execute");
    expect(spelled).toContain("$action.Arguments");
    // The local XML mirror is not consulted: a task that drifted from it is the failure this row
    // exists for, and reading our own file back would report success.
    expect(spelled).not.toContain("task.xml");
  });

  it("parses the bytes a real systemd user manager printed", () => {
    const loaded = readLoaded(
      "systemd",
      "xplainer.service",
      answered(fixture("systemctl-show-loaded.txt")),
    );
    expect(loaded.available).toBe(true);
    expect(loaded.answered).toBe(true);
    expect(loaded.command).toContain("/bin/node ");
    expect(loaded.command).toContain("serve --port 8787 --state-dir");
    // The record around `argv[]` carries a pid and a start time, and neither is configuration: a
    // restart must not read as a mismatch.
    expect(loaded.command).not.toContain("pid=");
    expect(loaded.command).not.toContain("start_time");
    // One assignment per line, unquoted: what the unit was rendered from, not how systemd displays
    // it. The quoting case is the next test.
    expect(loaded.environment).toBe(
      "XPLAINER_STATE_DIR=/home/xplainer/.local/state/xplainer\n" +
        "XPLAINER_TOKEN_FILE=/home/xplainer/.local/state/xplainer/token",
    );
    expect(loaded.cwd).toBe("/home/xplainer/.local/state/xplainer");
  });

  /** The two edge cases the same manager produced: no `Environment=`, no `WorkingDirectory=`. */
  it("keeps an unset environment and a defaulted working directory apart", () => {
    const loaded = readLoaded(
      "systemd",
      "t17b.service",
      answered(fixture("systemctl-show-defaults.txt")),
    );
    expect(loaded.environment).toBe("");
    // systemd prefixes the manager's own default with `!`, which is not part of the path.
    expect(loaded.cwd).toBe("/home/xplainer");
  });

  /**
   * A state directory with a space in its name, which is an ordinary thing to have and which
   * systemd quotes in its display. Comparing the display against the assignments the unit was
   * rendered from would report a mismatch for every such machine.
   */
  it("unquotes an environment systemd had to quote, so a space is not a mismatch", () => {
    const loaded = readLoaded(
      "systemd",
      "sp.service",
      answered(fixture("systemctl-show-spaces.txt")),
    );
    expect(loaded.environment).toBe(
      "XPLAINER_STATE_DIR=/home/xplainer/state with space\n" +
        "XPLAINER_TOKEN_FILE=/home/xplainer/state with space/token",
    );
    expect(loaded.cwd).toBe("/home/xplainer/state with space");

    // And the comparison agrees with a spec built over that same directory, which is the whole
    // point: what row 1 emits and what row 2 displays are now the same document.
    const expected = expectedLoaded(
      "systemd",
      // `posix.join`, because this spec describes the machine the **fixture** came from — a Linux
      // one — rather than the machine running the test. The host separator would compose
      // `\\home\\xplainer\\state with space\\token` on Windows and report a mismatch against a unit
      // that says `/home/...`, which is what `windows-latest` did on 2026-09-08.
      specFor("/rt/1.2.3-aaaa", "/home/xplainer/state with space", "/run/x.sock", posix.join),
    );
    expect(expected.environment).toBe(loaded.environment);
  });

  it("is unavailable on macOS, and says which detector replaces it", () => {
    const loaded = readLoaded("launchd", "video.xplainer.daemon", answered("anything at all"));
    expect(loaded.available).toBe(false);
    expect(loaded.answered).toBe(false);
    expect(loaded.command).toBeNull();
    expect(loaded.detail).toContain("`/healthz`");
    expect(loaded.detail).toContain("D7");
  });

  it("reports a query that did not answer as unanswered rather than as a difference", () => {
    const loaded = readLoaded("systemd", "xplainer.service", {
      started: true,
      status: 1,
      stdout: "",
      stderr: "Failed to get unit: Unit xplainer.service not loaded.\n",
    });
    expect(loaded.available).toBe(true);
    expect(loaded.answered).toBe(false);
    expect(loaded.command).toBeNull();
    expect(loaded.detail).toContain("not loaded");
  });
});

describe("row 3, from a daemon that is actually answering", () => {
  it(
    "advertises the ownership nonce and a digest another process can recompute",
    async () => {
      const stateDir = join(scratchDirectory(), "s");
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const socket = testIpcEndpoint(scratchDirectory("xp-sock-"), "d.sock");
      const tokenFile = join(stateDir, TOKEN_FILE);
      // The subject here is row 3, and a daemon whose toolchain is absent answers `/healthz` with
      // `degraded` (T19) — correct, and a different assertion. Recording one keeps `ok` meaning
      // "this daemon is healthy" rather than "this fixture never ran setup".
      recordTestToolchain({ stateDir, workspaceRoot: join(stateDir, WORKSPACE_DIR_NAME) });
      const started = await serveWith(stateDir, { tokenFile, socket });

      const health = await getHealthz(started.port, started.token);
      expect(health.status).toBe("ok");
      expect(typeof health.run_id).toBe("string");
      expect(typeof health.runtime_digest).toBe("string");

      // `run_id` is the ownership acquisition's `boot_nonce`, which is the value every other record
      // of this run already carries.
      expect(health.run_id).toBe(readRuntimeState(stateDir)?.run_id);

      // And the digest is a function of the launch, recomputed here from what the child was given.
      expect(health.runtime_digest).toBe(
        identityDigest({
          argv: started.argv,
          settings: { stateDir, tokenFile, socket },
          cwd: process.cwd(),
          runtimeDigest: null,
        }),
      );
    },
    READY_MS + 20_000,
  );

  /**
   * Criterion 1's first half, and the one that makes row 3 a *third* row: the snapshot is taken
   * from the process, so editing the file row 1 is read from cannot move it.
   */
  it(
    "does not change when `daemon.json`'s launch spec is edited underneath it",
    async () => {
      const stateDir = join(scratchDirectory(), "s");
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const socket = testIpcEndpoint(scratchDirectory("xp-sock-"), "d.sock");
      const tokenFile = join(stateDir, TOKEN_FILE);

      // A recorded launch spec that is **already** there, and is not the launch that is about to
      // happen. A snapshot that read this file would take its digest from here; the one the plan
      // requires takes it from the process, and the two are different numbers.
      updateDaemonState(stateDir, {
        runtime_dir: "/recorded/1.2.3-aaaaaaaaaaaa",
        launch_spec: specFor("/recorded/1.2.3-aaaaaaaaaaaa", stateDir, socket),
      });
      const recorded = readDesired({ stateDir }).digest;

      const started = await serveWith(stateDir, { tokenFile, socket });
      const before = await getHealthz(started.port, started.token);
      expect(before.runtime_digest).not.toBe(recorded);
      expect(before.runtime_digest).toBe(
        identityDigest({
          argv: started.argv,
          settings: { stateDir, tokenFile, socket },
          cwd: process.cwd(),
          runtimeDigest: null,
        }),
      );

      updateDaemonState(stateDir, {
        runtime_dir: "/somewhere/else/2.0.0-deadbeefcafe",
        launch_spec: specFor("/somewhere/else/2.0.0-deadbeefcafe", stateDir, socket),
      });

      const after = await getHealthz(started.port, started.token);
      expect(after.runtime_digest).toBe(before.runtime_digest);
      expect(after.run_id).toBe(before.run_id);

      // And the comparison sees it, because row 1 moved and row 3 did not.
      const report = checkIdentity({
        kind: "launchd",
        desired: readDesired({ stateDir }),
        loaded: readLoaded("launchd", "video.xplainer.daemon", answered("")),
        responding: readResponding(after),
      });
      expect(report.consistent).toBe(false);
      expect(report.detectors).toEqual(["responding-identity"]);
      expect(report.mismatches.map((entry) => entry.field)).toContain("runtime_digest");
    },
    READY_MS + 20_000,
  );

  /**
   * Criterion 5 against a real process: two daemons over the same bytes, differing in one setting,
   * are two identities — and two runs of the *same* configuration differ only in the run id.
   */
  it(
    "moves for a settings-only change and holds still across a restart",
    async () => {
      const stateDir = join(scratchDirectory(), "s");
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const socketDir = scratchDirectory("xp-sock-");
      const tokenFile = join(stateDir, TOKEN_FILE);

      const first = await serveWith(stateDir, {
        tokenFile,
        socket: testIpcEndpoint(socketDir, "a.sock"),
      });
      const one = await getHealthz(first.port, first.token);
      first.child.process.kill("SIGTERM");
      await untilGone(first.child.process.pid ?? 0, 30_000);

      const second = await serveWith(stateDir, {
        tokenFile,
        socket: testIpcEndpoint(socketDir, "a.sock"),
      });
      const two = await getHealthz(second.port, second.token);
      expect(two.runtime_digest).toBe(one.runtime_digest);
      expect(two.run_id).not.toBe(one.run_id);
      second.child.process.kill("SIGTERM");
      await untilGone(second.child.process.pid ?? 0, 30_000);

      const third = await serveWith(stateDir, {
        tokenFile,
        socket: testIpcEndpoint(socketDir, "b.sock"),
      });
      const three = await getHealthz(third.port, third.token);
      expect(three.runtime_digest).not.toBe(one.runtime_digest);
    },
    3 * (READY_MS + 20_000),
  );
});

/**
 * The five scenarios, on all three platforms, through the command that reports them.
 *
 * `daemonStatus` is driven with the supervisor and `/healthz` as seams — which is what lets one
 * machine assert Windows' vocabulary and macOS's absence of one — and row 3's *fidelity* is not
 * assumed here: it is established above against a real `serve`. What these cases establish is the
 * comparison: which detector fires, on which platform, for each way a switch can fail.
 */
describe("the three rows, compared", () => {
  /** The runtime the daemon is running out of, and the one an edit points at instead. */
  const SLOT_A = "1.2.3-aaaaaaaaaaaa";
  const SLOT_B = "1.2.3-bbbbbbbbbbbb";

  type Installed = {
    stateDir: string;
    root: string;
    specA: LaunchSpec;
    specB: LaunchSpec;
    /** The digest the daemon that is answering was launched with — spec A's. */
    respondingDigest: string;
    socket: string;
  };

  /** A state directory that looks the way `install` leaves one, with A recorded and running. */
  function installed(kind: "systemd" | "launchd" | "task-scheduler"): Installed {
    const root = scratchDirectory();
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeToolchainMarker(stateDir);
    const socket = join(root, "d.sock");
    const specA = specFor(join(root, "runtime", SLOT_A), stateDir, socket);
    const specB = specFor(join(root, "runtime", SLOT_B), stateDir, socket);
    updateDaemonState(stateDir, {
      port: 8787,
      token_file: specA.settings.tokenFile,
      socket_path: socket,
      supervisor_kind: kind,
      supervisor_artefact: join(root, "artefact"),
      runtime_dir: join(root, "runtime", SLOT_A),
      launch_spec: specA,
      installed_version: "1.2.3",
    });
    const respondingDigest = readDesired({ stateDir }).digest ?? "";
    return { stateDir, root, specA, specB, respondingDigest, socket };
  }

  /** The environment and platform arguments `daemonStatus` needs for one supervisor. */
  function platformArgs(
    kind: "systemd" | "launchd" | "task-scheduler",
    root: string,
  ): {
    platform: NodeJS.Platform;
    environment: SupervisorEnvironment;
    uid: number;
  } {
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    // Every environment carries both Linux system directories, the launchd one included:
    // `probeLinger()` composes `<lingerDir>/<account>` and `probeSupervisor()` stats the booted
    // directory before either looks at the platform, so an environment without them reads the
    // host's real `/var/lib/systemd/linger/$USER` and `/run/systemd/system` whenever this file
    // runs on Linux. The booted one has to exist for the systemd branch to be reachable.
    const lingerDir = join(root, "linger");
    const systemdBooted = join(root, "run-systemd-system");
    mkdirSync(systemdBooted, { recursive: true });
    if (kind === "systemd") {
      return {
        platform: "linux",
        environment: { home, account: "tester", lingerDir, systemdBooted },
        uid: 1000,
      };
    }
    if (kind === "launchd") {
      return {
        platform: "darwin",
        environment: { home, account: "tester", lingerDir, systemdBooted },
        uid: 501,
      };
    }
    return {
      platform: "win32",
      environment: {
        home,
        account: "CORP\\tester",
        localAppData: join(home, "AppData", "Local"),
        systemRoot: join(root, "Windows"),
        lingerDir,
        systemdBooted,
      },
      uid: 0,
    };
  }

  /** What one supervisor would answer when it is holding `spec`, or nothing on macOS. */
  function heldBy(kind: "systemd" | "launchd" | "task-scheduler", spec: LaunchSpec): string {
    if (kind === "systemd") {
      return systemdShow(spec);
    }
    if (kind === "task-scheduler") {
      // Every path in these fixtures is free of spaces, so the command line is the argv joined —
      // the quoting rule itself is `schtasks.ts`'s and is asserted in its own suite.
      return taskShow(spec, spec.argv.join(" "));
    }
    return "";
  }

  /** `daemon status`, with the supervisor holding `held` and `/healthz` advertising `digest`. */
  function statusOf(
    kind: "systemd" | "launchd" | "task-scheduler",
    state: Installed,
    held: LaunchSpec,
    digest: string,
  ) {
    const args = platformArgs(kind, state.root);
    return daemonStatus({
      stateDir: state.stateDir,
      platform: args.platform,
      environment: args.environment,
      uid: args.uid,
      run: loadedRunner(heldBy(kind, held)),
      probe: respondingProbe("run-a", digest),
    });
  }

  const kinds = ["systemd", "launchd", "task-scheduler"] as const;

  it.each(kinds)("reports agreement on %s when nothing has drifted", async (kind) => {
    const state = installed(kind);
    const report = await statusOf(kind, state, state.specA, state.respondingDigest);
    expect(report.identity.mismatches).toEqual([]);
    expect(report.identity.detectors).toEqual([]);
    expect(report.identity.consistent).toBe(true);
    expect(report.health?.runtime_digest).toBe(state.respondingDigest);
  });

  /**
   * Criteria 1 and 2: `daemon.json`'s launch spec is hand-edited to point at another runtime while
   * the supervisor and the daemon both still hold the old one.
   */
  it.each(kinds)("catches a hand-edited launch spec on %s", async (kind) => {
    const state = installed(kind);
    updateDaemonState(state.stateDir, {
      runtime_dir: join(state.root, "runtime", SLOT_B),
      launch_spec: state.specB,
    });

    const report = await statusOf(kind, state, state.specA, state.respondingDigest);
    expect(report.identity.consistent).toBe(false);
    // Row 3 fires everywhere: the process answering was launched from A and the record now says B.
    expect(report.identity.detectors).toContain("responding-identity");
    expect(
      report.identity.mismatches.filter((entry) => entry.detector === "responding-identity"),
    ).toContainEqual(expect.objectContaining({ field: "runtime_digest" }));

    if (kind === "launchd") {
      // macOS has no row 2 at all, so the identity detector is the only one that can fire (D7).
      expect(report.identity.detectors).toEqual(["responding-identity"]);
      expect(report.identity.loaded.available).toBe(false);
    } else {
      expect(report.identity.detectors).toContain("loaded-configuration");
      expect(
        report.identity.mismatches
          .filter((entry) => entry.detector === "loaded-configuration")
          .map((entry) => entry.field),
      ).toContain("command");
    }
  });

  /**
   * Criterion 3: the artefact on disk is rewritten and the supervisor is never asked to reload it.
   * On Linux and Windows that is a desired-versus-loaded mismatch; on macOS the responding detector
   * fires instead, and `daemon status` says which one did.
   */
  it.each(kinds)("catches an artefact rewritten without a reload on %s", async (kind) => {
    const state = installed(kind);
    const args = platformArgs(kind, state.root);
    // The switch, exactly as far as it got: the record and the file both name B, and nothing has
    // told the supervisor or the daemon about it.
    updateDaemonState(state.stateDir, {
      runtime_dir: join(state.root, "runtime", SLOT_B),
      launch_spec: state.specB,
    });
    const adapter = { systemd: "systemd", launchd: "launchd", "task-scheduler": "win32" } as const;
    expect(adapter[kind]).toBeTruthy();

    const report = await daemonStatus({
      stateDir: state.stateDir,
      platform: args.platform,
      environment: args.environment,
      uid: args.uid,
      // The manager still holds A, because nothing reloaded it. Measured: `systemctl show` keeps
      // answering with the cached unit until `daemon-reload` (see the module doc).
      run: loadedRunner(heldBy(kind, state.specA)),
      probe: respondingProbe("run-a", state.respondingDigest),
    });

    expect(report.identity.consistent).toBe(false);
    if (kind === "launchd") {
      expect(report.identity.detectors).toEqual(["responding-identity"]);
    } else {
      expect(report.identity.detectors).toEqual(["loaded-configuration", "responding-identity"]);
    }

    // And the prose names the detector rather than leaving a reader to work it out.
    const prose = describeStatus(report, readUpdateStatus(state.stateDir));
    for (const detector of report.identity.detectors) {
      expect(prose).toContain(`MISMATCH:        ${detector}`);
    }
    expect(prose).toContain("identity:");
  });

  /**
   * Criterion 4: the switch happened and the supervisor was reloaded, but the daemon was never
   * restarted. Row 2 now agrees with row 1 and only the digest can see it — on all three platforms,
   * with both runtimes on the same release version.
   */
  it.each(kinds)("catches a reloaded switch that never restarted on %s", async (kind) => {
    const state = installed(kind);
    updateDaemonState(state.stateDir, {
      runtime_dir: join(state.root, "runtime", SLOT_B),
      launch_spec: state.specB,
    });
    // Both runtimes are release 1.2.3: the release number is not identity, which is the whole
    // reason row 3 carries a digest rather than a version.
    expect(readDaemonState(state.stateDir).installed_version).toBe("1.2.3");

    const report = await statusOf(kind, state, state.specB, state.respondingDigest);
    expect(report.identity.consistent).toBe(false);
    expect(report.identity.detectors).toEqual(["responding-identity"]);
    expect(report.identity.mismatches).toHaveLength(1);
    expect(report.identity.mismatches[0]?.field).toBe("runtime_digest");
    expect(report.identity.mismatches[0]?.found).toBe(state.respondingDigest);
    expect(report.identity.mismatches[0]?.desired).toBe(
      readDesired({ stateDir: state.stateDir }).digest,
    );
  });

  /**
   * Criterion 5: only a setting moved. The interpreter, the entry and the payload are the same
   * bytes, and the identity is still a different identity.
   */
  it.each(kinds)("catches a settings-only change on %s", async (kind) => {
    const state = installed(kind);
    const moved = specFor(
      join(state.root, "runtime", SLOT_A),
      state.stateDir,
      join(state.root, "moved.sock"),
    );
    expect(moved.executable).toBe(state.specA.executable);
    expect(moved.argv[0]).toBe(state.specA.argv[0]);
    updateDaemonState(state.stateDir, { launch_spec: moved });

    const report = await statusOf(kind, state, moved, state.respondingDigest);
    expect(report.identity.detectors).toEqual(["responding-identity"]);
    expect(report.identity.mismatches[0]?.field).toBe("runtime_digest");
    expect(readDesired({ stateDir: state.stateDir }).digest).not.toBe(state.respondingDigest);
  });

  /** A machine with nothing installed is not a machine where everything agrees. */
  it("refuses to call an unreadable comparison a pass", async () => {
    const root = scratchDirectory();
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeToolchainMarker(stateDir);
    const report = await daemonStatus({
      stateDir,
      platform: "darwin",
      environment: {
        home: join(root, "home"),
        account: "tester",
        lingerDir: join(root, "linger"),
        systemdBooted: join(root, "run-systemd-system"),
      },
      uid: 501,
      run: loadedRunner(""),
      probe: () => Promise.resolve({ kind: "unreachable", reason: "ECONNREFUSED" }),
    });
    expect(report.identity.consistent).toBe(false);
    expect(report.identity.mismatches).toEqual([]);
    expect(report.identity.detail).toContain("nothing could be compared");
  });
});
