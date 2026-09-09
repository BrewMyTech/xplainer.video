/**
 * The seven discovery outcomes, against a real daemon driven into each state.
 *
 * Every assertion below runs a real `xplainer` — through a real payload layout, spawned the way
 * decision D10 spawns it — against a state directory this test put into the state it is about.
 * Nothing is mocked and nothing is stubbed: `ready` is a daemon whose toolchain marker the CLI's
 * own fixture writer wrote, `unauthorized` is a second state directory recording a port a daemon
 * that is not its own holds, `occupied` is a second process holding the recorded port, and
 * `disabled` is a supervisor that answers the documented query with "switched off".
 *
 * The waits are long because the arrangements are real: a daemon start, a `/healthz` probe that
 * times out when nothing is there, and a supervisor query are all seconds rather than milliseconds.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import process from "node:process";
import { afterAll, describe, expect, it } from "vitest";
import {
  DiscoveryRefusal,
  discover,
  handOffToInstall,
  launcherPath,
  mayStartDaemon,
  parseDaemonReport,
  resolveCliProgram,
  spawnDaemon,
} from "./discovery";
import {
  amendDaemonState,
  cleanUpFixtures,
  holdPort,
  payloadResources,
  programFor,
  recordToolchain,
  SCHEDULED_TASKS_SHIM_FILES,
  SWITCHED_OFF_STATE,
  scheduledTasksShim,
  startDaemon,
  switchedOffEnvironment,
  temporaryDirectory,
} from "./testing/live-daemon";

/** A daemon start, a status command and a probe timeout all fit inside this. */
const CASE_TIMEOUT_MS = 60_000;

afterAll(async () => {
  await cleanUpFixtures();
}, CASE_TIMEOUT_MS);

/**
 * Whether `127.0.0.1:port` can be bound right now.
 *
 * The installer's preflight asks the same question of the same port with the same syscall, and
 * answers exit `7` when it cannot — so this is the observable the handoff is about, not a proxy
 * for it.
 */
async function bindable(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

/** The environment a discovery runs its child with: this machine's, pointed at a test's own state. */
function environmentFor(stateDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...extra, XPLAINER_STATE_DIR: stateDir };
}

describe("resolveCliProgram", () => {
  it("runs the packaged payload before an install has written a launcher", () => {
    const resources = payloadResources();
    const stateDir = temporaryDirectory();
    const program = resolveCliProgram({ resourcesPath: resources, stateDir });

    expect(program.kind).toBe("payload");
    expect(program.executable).toContain("xplainer-runtime");
    expect(program.leadingArgs).toHaveLength(1);
  });

  it("refuses by name when there is no launcher and no payload either", () => {
    const empty = temporaryDirectory();
    try {
      resolveCliProgram({ resourcesPath: empty });
      expect.unreachable("a resources directory with no payload cannot resolve a program");
    } catch (error) {
      expect(error).toBeInstanceOf(DiscoveryRefusal);
      expect((error as DiscoveryRefusal).reason).toBe("payload-unavailable");
      expect((error as DiscoveryRefusal).message).toMatch(/carries no runtime\.manifest\.json/);
    }
  });

  it(
    "switches to the stable launcher once install has written it, and the launcher is what runs",
    async () => {
      const resources = payloadResources();
      const stateDir = temporaryDirectory();
      const witness = writeLauncher(resources, stateDir);

      const program = resolveCliProgram({ resourcesPath: resources, stateDir });
      expect(program.kind).toBe("launcher");
      expect(program.executable).toBe(launcherPath(stateDir));

      // The launcher is not merely selected: it is what the discovery command goes through, and it
      // records that it ran before it execs the interpreter behind it.
      const discovery = await discover({
        resourcesPath: resources,
        stateDir,
        env: environmentFor(stateDir),
      });
      expect(discovery.program.kind).toBe("launcher");
      expect(existsSync(witness)).toBe(true);
      expect(discovery.report.stateDir).toBe(stateDir);
    },
    CASE_TIMEOUT_MS,
  );
});

describe("discover", () => {
  it(
    "answers `absent` where nothing is installed and nothing is answering",
    async () => {
      const resources = payloadResources();
      const stateDir = temporaryDirectory();

      const discovery = await discover({
        resourcesPath: resources,
        env: environmentFor(stateDir),
      });

      expect(discovery.outcome).toBe("absent");
      expect(discovery.report.condition).toBe("absent");
      expect(discovery.report.probe.error).not.toBeNull();
      expect(discovery.action).toMatch(/Start one from this app/);
      expect(discovery.program.kind).toBe("payload");

      // Nothing is installed and nothing explains the silence, so this is the one answer that is
      // this app's to act on.
      expect(mayStartDaemon(discovery)).toBe(true);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "answers `ready` for an authenticated /healthz 200, at the URL resolveDaemonUrl agrees on",
    async () => {
      const resources = payloadResources();
      const stateDir = temporaryDirectory();
      const live = await startDaemon({ resources, stateDir });
      recordToolchain(stateDir, join(stateDir, "workspace"));

      const discovery = await discover({
        resourcesPath: resources,
        stateDir,
        env: environmentFor(stateDir),
      });

      expect(discovery.outcome).toBe("ready");
      expect(discovery.report.probe.httpStatus).toBe(200);
      expect(discovery.report.health?.status).toBe("ok");
      // The pure resolver and the CLI's own precedence answered the same origin, from the port
      // `daemon.json` recorded.
      expect(discovery.url).toBe(live.url);
      expect(discovery.url).toBe(discovery.report.probe.url);
      expect(discovery.tokenFile).toBe(live.tokenFile);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "answers `degraded` for a 200 that carries a reason",
    async () => {
      const resources = payloadResources();
      const stateDir = temporaryDirectory();
      // No toolchain marker: the daemon is up, holding the queue, and cannot render — which is the
      // condition ADR 0020 requires it to report rather than discover inside a job.
      await startDaemon({ resources, stateDir });

      const discovery = await discover({
        resourcesPath: resources,
        stateDir,
        env: environmentFor(stateDir),
      });

      expect(discovery.outcome).toBe("degraded");
      expect(discovery.report.probe.httpStatus).toBe(200);
      expect(discovery.report.health?.status).toBe("degraded");
      expect(discovery.detail).not.toBe("");
      expect(discovery.action).toMatch(/setup/);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "answers `incompatible` when the daemon's contract version is not this app's",
    async () => {
      const resources = payloadResources();
      const stateDir = temporaryDirectory();
      await startDaemon({ resources, stateDir });
      recordToolchain(stateDir, join(stateDir, "workspace"));

      const discovery = await discover({
        resourcesPath: resources,
        stateDir,
        contractVersion: "99.0",
        env: environmentFor(stateDir),
      });

      expect(discovery.outcome).toBe("incompatible");
      expect(discovery.report.health?.contractVersion).not.toBe("99.0");
      expect(discovery.detail).toMatch(/this app speaks 99\.0/);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "answers `unauthorized` for a 401 against a token this machine holds",
    async () => {
      const resources = payloadResources();
      const stateDir = temporaryDirectory();
      const live = await startDaemon({ resources, stateDir });
      // Two state directories, which is what this outcome actually describes: a daemon holds the
      // port, and *this* record's token is not its token. Overwriting the running daemon's own
      // token file no longer produces it — the daemon follows that file so that it can pick up an
      // `xplainer token rotate` without a restart (ADR 0020 §Security R-SEC-8) — and a simulation
      // that leans on the daemon *not* reading its own credential was never the shape of the fault.
      const intruded = temporaryDirectory();
      writeFileSync(
        join(intruded, "daemon.json"),
        `${JSON.stringify({ format_version: 1, port: live.port }, null, 2)}\n`,
      );
      writeFileSync(join(intruded, "token"), `${"b".repeat(43)}\n`, { mode: 0o600 });

      const discovery = await discover({
        resourcesPath: resources,
        stateDir: intruded,
        env: environmentFor(intruded),
      });

      expect(discovery.outcome).toBe("unauthorized");
      expect(discovery.report.probe.httpStatus).toBe(401);
      expect(discovery.detail).toMatch(/401/);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "answers `occupied` when the recorded port is held by a foreign pid",
    async () => {
      const resources = payloadResources();
      const stateDir = temporaryDirectory();
      const live = await startDaemon({ resources, stateDir });
      await live.daemon.stop(10_000);
      const holder = holdPort(live.port);
      await waitForListener(live.port);

      try {
        const discovery = await discover({
          resourcesPath: resources,
          stateDir,
          env: environmentFor(stateDir),
        });

        expect(discovery.outcome).toBe("occupied");
        expect(discovery.report.probe.port).toBe(live.port);
        expect(discovery.report.probe.holderPid).toBe(holder.pid);
        expect(discovery.action).toMatch(/exit 10/);
      } finally {
        await holder.release();
      }
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "answers `disabled` when the supervisor says the service is switched off",
    async () => {
      const resources = payloadResources();
      const stateDir = temporaryDirectory();
      const live = await startDaemon({ resources, stateDir });
      await live.daemon.stop(10_000);

      // What an install leaves behind: a registration recorded in `daemon.json`. Without one the
      // CLI asks the supervisor nothing, because `launchctl print-disabled` answers for a label
      // nothing has ever bootstrapped and reporting that as "switched on" would be an answer about
      // a service that does not exist.
      amendDaemonState(stateDir, {
        supervisor_kind: supervisorKind(),
        supervisor_artefact: join(stateDir, "artefact"),
        installed_version: "0.0.0",
      });
      const registered = await discover({
        resourcesPath: resources,
        stateDir,
        env: environmentFor(stateDir),
      });
      const identity = registered.report.supervisorIdentity ?? "";
      expect(identity).not.toBe("");
      expect(registered.outcome).not.toBe("disabled");

      const discovery = await discover({
        resourcesPath: resources,
        stateDir,
        env: environmentFor(stateDir, switchedOffEnvironment(identity)),
      });

      expect(discovery.report.switchState).toBe("off");
      expect(discovery.outcome).toBe("disabled");
      expect(discovery.action).toMatch(/switched off/);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "names the remedy, not `start one`, for a daemon that is installed or latched",
    async () => {
      const resources = payloadResources();
      const stateDir = temporaryDirectory();
      const live = await startDaemon({ resources, stateDir });
      await live.daemon.stop(10_000);

      // Installed and stopped: nothing is answering and nothing holds the port, so the outcome is
      // `absent` — but "start one from this app" is the wrong sentence for a daemon a supervisor
      // already owns.
      amendDaemonState(stateDir, {
        supervisor_kind: supervisorKind(),
        supervisor_artefact: join(stateDir, "artefact"),
      });
      const installed = await discover({
        resourcesPath: resources,
        stateDir,
        env: environmentFor(stateDir),
      });
      expect(installed.outcome).toBe("absent");
      expect(installed.report.condition).toBe("unreachable");
      expect(installed.action).toMatch(/daemon start/);

      // And it is not a daemon this app may start either: a second `serve` over a state directory
      // an installed daemon owns is the exit `10` the handoff exists to avoid, and the remedy the
      // sentence above names is the supervisor's, not this app's.
      expect(mayStartDaemon(installed)).toBe(false);

      // Latched: a `serve` started now would exit 0 without binding, so the remedy is the command
      // that clears the breaker.
      amendDaemonState(stateDir, {
        stalled: { at: new Date().toISOString(), reason: "five failed starts" },
      });
      const latched = await discover({
        resourcesPath: resources,
        stateDir,
        env: environmentFor(stateDir),
      });
      expect(latched.report.condition).toBe("stalled");
      expect(latched.action).toMatch(/daemon restart/);

      // Same answer, same reason: the outcome is `absent`, and spawning here would produce no
      // daemon at all — the sentence a window shows is the whole of what this app can do.
      expect(latched.outcome).toBe("absent");
      expect(mayStartDaemon(latched)).toBe(false);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "asks about a remote daemon with the command that takes a URL, and prefers that origin",
    async () => {
      const resources = payloadResources();
      const remoteState = temporaryDirectory();
      const remote = await startDaemon({ resources, stateDir: remoteState });
      recordToolchain(remoteState, join(remoteState, "workspace"));

      // The token this machine presents is the remote daemon's, because that is what the state
      // directory beside it records: the two are one machine in this test, which is what makes the
      // assertion about *which origin was asked* rather than about credentials.
      const discovery = await discover({
        resourcesPath: resources,
        stateDir: remoteState,
        remoteUrl: remote.url,
        env: environmentFor(remoteState),
      });

      expect(discovery.url).toBe(remote.url);
      expect(discovery.report.probe.url).toBe(remote.url);
      expect(discovery.outcome).toBe("ready");
      // `status --url` has no supervisor half at all, which is why the local command is the one
      // asked about a daemon on this machine.
      expect(discovery.report.switchState).toBe("unknown");
    },
    CASE_TIMEOUT_MS,
  );
});

/**
 * The Windows half of the switched-off arrangement, read from a machine that cannot run it.
 *
 * The three surfaces the CLI's query touches are the two command names it calls, the `-TaskName`
 * it names them with, and the word `readSwitch` reads back. Measured under PowerShell 7.4
 * (`mcr.microsoft.com/powershell:7.4-ubuntu-22.04`, 2026-09-09) with these two scripts in a
 * directory prepended to `PATH` and a competing `ScheduledTasks` module still on `PSModulePath`:
 * `Get-Command Get-ScheduledTask -All` answers `ExternalScript:/exp/bin/Get-ScheduledTask.ps1` and
 * nothing else, and `(Get-ScheduledTask -TaskName '\xplainer\runneradmin-daemon').State` prints
 * `Disabled` and exits `0`.
 */
describe("the switched-off ScheduledTasks shim", () => {
  it("is a script per command the CLI's queries call, answering for a named task", () => {
    const shim = scheduledTasksShim();

    // The file name is the command name: that is the whole of how PowerShell finds it on `PATH`.
    expect(SCHEDULED_TASKS_SHIM_FILES).toEqual({
      getScheduledTask: "Get-ScheduledTask.ps1",
      getScheduledTaskInfo: "Get-ScheduledTaskInfo.ps1",
    });
    for (const script of [shim.getScheduledTask, shim.getScheduledTaskInfo]) {
      // The real cmdlets' own named parameters, so the binder has somewhere to put the query's.
      expect(script).toContain("[string] $TaskName");
      expect(script).toContain("[string] $TaskPath");
      expect(script).toContain("[pscustomobject]@{ TaskName = $TaskName;");
    }
    expect(shim.getScheduledTask).toContain(`State = '${SWITCHED_OFF_STATE}'`);
    expect(shim.getScheduledTaskInfo).toContain("LastTaskResult = 0");
    expect(SWITCHED_OFF_STATE.toLowerCase()).toBe("disabled");
  });
});

describe("spawnDaemon", () => {
  it(
    "starts a daemon, hands over to an installed one, and is gone when it is asked to be",
    async () => {
      const resources = payloadResources();
      const stateDir = temporaryDirectory();
      const first = await spawnDaemon({
        program: programFor(resources),
        args: ["--port", "0"],
        env: environmentFor(stateDir),
      });
      expect(first.kind).toBe("spawned");
      if (first.kind !== "spawned") {
        return;
      }
      expect(first.daemon.port).toBeGreaterThan(0);
      expect(first.daemon.contractVersion).not.toBe("");

      // The spawn-to-install handoff: the app's own daemon is stopped and *gone* before anything
      // else takes the state directory, and the proof it is gone is that a second one can take it.
      const stopped = await first.daemon.stop(15_000);
      expect(stopped.code === 0 || stopped.signal !== null).toBe(true);

      const second = await spawnDaemon({
        program: programFor(resources),
        args: ["--port", "0"],
        env: environmentFor(stateDir),
      });
      expect(second.kind).toBe("spawned");
      if (second.kind === "spawned") {
        await second.daemon.stop(15_000);
      }
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "reattaches rather than starting a second daemon when exit 10 says one is already there",
    async () => {
      const resources = payloadResources();
      const stateDir = temporaryDirectory();
      const live = await startDaemon({ resources, stateDir });

      const second = await spawnDaemon({
        program: programFor(resources),
        args: ["--port", "0"],
        env: environmentFor(stateDir),
      });

      expect(second.kind).toBe("reattach");
      if (second.kind === "reattach") {
        expect(second.exitCode).toBe(10);
        expect(second.message).toMatch(/already owns/);
      }
      // And the daemon that was already there is still the one discovery finds.
      const discovery = await discover({
        resourcesPath: resources,
        stateDir,
        env: environmentFor(stateDir),
      });
      expect(discovery.url).toBe(live.url);
      expect(discovery.report.probe.httpStatus).toBe(200);
    },
    CASE_TIMEOUT_MS,
  );
});

describe("handOffToInstall", () => {
  it(
    "gets this app's daemon off the install's port before the install looks at it",
    async () => {
      const resources = payloadResources();
      const stateDir = temporaryDirectory();
      const live = await startDaemon({ resources, stateDir });

      // What `daemon install` does before it writes anything is bind the port it is about to
      // record — `install/preflight.ts`'s row `7`. A daemon this app spawned holds `serve`'s
      // default port, which is that port, so the installer's own probe is what the handoff has to
      // satisfy. Here the probe is a real bind against the port this app's daemon really holds.
      expect(await bindable(live.port)).toBe(false);

      const order: string[] = [];
      const free = await handOffToInstall({
        stopSpawned: async () => {
          order.push("stop");
          await live.daemon.stop(15_000);
        },
        install: async () => {
          order.push("install");
          return bindable(live.port);
        },
        rediscover: async () => {
          order.push("rediscover");
          const again = await discover({
            resourcesPath: resources,
            stateDir,
            env: environmentFor(stateDir),
          });
          // The app's own daemon is gone, so the answer the window gets afterwards is about the
          // machine rather than about the process this app had just stopped.
          expect(again.report.probe.httpStatus).toBeNull();
        },
      });

      // The install's answer is the handoff's answer, and it is `true`: the port was free by the
      // time the installer looked at it, which is exactly the exit `7` that does not happen.
      expect(free).toBe(true);
      expect(order).toEqual(["stop", "install", "rediscover"]);
    },
    CASE_TIMEOUT_MS,
  );
});

describe("parseDaemonReport", () => {
  const command = "xplainer daemon status --json";

  it("refuses a document that is not one JSON object", () => {
    expect(() => parseDaemonReport("not json", command)).toThrow(DiscoveryRefusal);
    expect(() => parseDaemonReport("[]", command)).toThrow(/wrote a document, not a report/);
  });

  it("refuses a report written by a build newer than this one, rather than guessing", () => {
    try {
      parseDaemonReport(
        JSON.stringify({ schema_version: 2, condition: "ready", state_dir: "/x" }),
        command,
      );
      expect.unreachable("a newer schema version must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(DiscoveryRefusal);
      expect((error as DiscoveryRefusal).reason).toBe("report-too-new");
    }
  });

  it("reads the report off the last line, so a daemon's own log lines cannot confuse it", () => {
    const report = parseDaemonReport(
      `some other line\n${JSON.stringify({
        schema_version: 1,
        condition: "ready",
        exit_code: 0,
        state_dir: "/state",
        daemon: { port: 8787, token_file: "/state/token", supervisor_kind: null },
        probe: { url: "http://127.0.0.1:8787", port: 8787, http_status: 200 },
        health: { status: "ok", contract_version: "1" },
      })}\n`,
      command,
    );

    expect(report.condition).toBe("ready");
    expect(report.recordedPort).toBe(8787);
    expect(report.registered).toBe(false);
    expect(report.switchState).toBe("unknown");
  });
});

/** The supervisor kind this platform's `install` would record. */
function supervisorKind(): string {
  if (process.platform === "darwin") {
    return "launchd";
  }
  return process.platform === "win32" ? "task-scheduler" : "systemd";
}

/** Write the two-line launcher `install` writes, plus a witness line proving it ran. */
function writeLauncher(resources: string, stateDir: string): string {
  const program = resolveCliProgram({ resourcesPath: resources });
  const witness = join(stateDir, "launcher-ran");
  const path = launcherPath(stateDir);
  mkdirSync(join(stateDir, "bin"), { recursive: true });
  const entry = program.leadingArgs[0] ?? "";
  if (process.platform === "win32") {
    writeFileSync(
      path,
      `@echo off\r\necho ran >> "${witness}"\r\n"${program.executable}" "${entry}" %*\r\n`,
    );
  } else {
    writeFileSync(
      path,
      `#!/bin/sh\necho ran >> "${witness}"\nexec "${program.executable}" "${entry}" "$@"\n`,
      { mode: 0o700 },
    );
  }
  return witness;
}

/** Wait until something is listening on a port, so a probe is not racing a `listen`. */
async function waitForListener(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const reached = await new Promise<boolean>((resolve) => {
      const socket = connect({ port, host: "127.0.0.1" }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => {
        resolve(false);
      });
    });
    if (reached || Date.now() > deadline) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
