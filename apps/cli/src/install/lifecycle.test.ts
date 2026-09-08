/**
 * The four lifecycle verbs, and the four sentences ADR 0020 requires `daemon status` to say.
 *
 * **What is real here.** The daemon is a **real spawned process**, started out of the launch spec a
 * **real `installDaemon`** recorded, which minted a real bearer token and answered a real
 * authenticated `GET /healthz` over loopback. The port holder in the first sentence is a real
 * listener bound by this test process, named by whatever `lsof` or `ss` this machine has, and the
 * pid in the sentence is asserted to be **this process's own**. The toolchain the third sentence is
 * about is the real setup marker with a real file removed from under it. The one seam is `run` —
 * how a supervisor command reaches the outside world — which `preflight.ts` established as a
 * parameter because three platforms' vocabularies have to be checkable from one machine, and a
 * `Get-ScheduledTask` cannot be run on macOS at all. `install/testing/supervisor-proof.ts`'s
 * companion, `lifecycle-proof.ts`, is where the same queries meet a real launchd and a real systemd.
 *
 * **The sentences are compared with the ADR's own text.** {@link adrSentences} reads
 * `docs/adr/0020-always-running-local-daemon.md`, takes the four quoted strings out of the
 * `daemon status` paragraph and normalises their line wrapping; every assertion below compares a
 * value this package produced with one of those. A sentence reworded in the ADR and not here — or
 * here and not there — fails the suite, which is what "quoted exactly" has to mean to be a check.
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type DaemonStart, readDaemonState, updateDaemonState } from "../daemon/daemon-state.js";
import { DAEMON_UNHEALTHY_EXIT_CODE, PRECONDITION_UNMET_EXIT_CODE } from "../daemon/exit-codes.js";
import { resolveIpcPath } from "../daemon/ipc.js";
import {
  CHILD_SERVE,
  killAndWait,
  removeTree,
  TS_SOURCE_HOOK,
} from "../daemon/testing/spawn-child.js";
import { isAlive } from "../daemon/worker-identity.js";
import { installDaemon } from "./install.js";
import {
  DaemonNotInstalled,
  DEGRADED_TOOLCHAIN_SENTENCE,
  daemonStatus,
  disabledQuery,
  LifecycleRefusal,
  loadedConfigurationQuery,
  logSource,
  NOT_BOOT_PERSISTENT_SENTENCES,
  readSwitch,
  restartDaemon,
  SWITCHED_OFF_SENTENCES,
  startDaemon,
  stopDaemon,
  stoppedAfterFailedStartsSentence,
  tailFile,
} from "./lifecycle.js";
import type { ProbeCommand, ProbeResult, ProbeRunner } from "./preflight.js";
import { runProbe } from "./preflight.js";
import type { SupervisorEnvironment } from "./supervisors/artefact.js";
import { buildFixturePayload } from "./testing/payload.js";
import { ACQUIRED_DIR, writeToolchainMarker } from "./testing/toolchain.js";

/** The budget for a case that stages a payload and starts a real daemon out of it. */
const SPAWN_TIMEOUT_MS = 90_000;

/** How long an install waits for `/healthz` here. Long enough for a spawn, short enough to fail. */
const HEALTH_MS = 20_000;

/** The ADR whose four sentences this file asserts. */
const ADR_0020 = fileURLToPath(
  new URL("../../../../docs/adr/0020-always-running-local-daemon.md", import.meta.url),
);

let payloadDir = "";
let suiteScratch = "";
const scratch: string[] = [];
const children: ChildProcess[] = [];
const listeners: (() => void)[] = [];

beforeAll(() => {
  suiteScratch = realpathSync(mkdtempSync(join(tmpdir(), "xplainer-lifecycle-suite-")));
  payloadDir = buildFixturePayload({
    outDir: join(suiteScratch, "payload"),
    version: "1.2.3",
    marker: "lifecycle",
    extraInterpreters: ["node.exe"],
  }).outDir;
}, 120_000);

afterAll(() => {
  removeTree(suiteScratch);
});

afterEach(async () => {
  // The children are killed **and waited for** before anything is removed. A process that has been
  // signalled still holds every file it had open until the kernel has finished with it, and Windows
  // refuses to unlink a file with an open handle: `windows-latest` answered
  // `EPERM, Permission denied: \\?\C:\Users\RUNNER~1\AppData\Local\Temp\xplainer-lifecycle-…` for
  // five cases here on 2026-09-08. `removeTree` retries on top of that, for the handles a daemon's
  // own descendants may still be closing after their parent has gone.
  await Promise.all(children.splice(0).map((child) => killAndWait(child, 5_000)));
  for (const close of listeners.splice(0)) {
    close();
  }
  for (const directory of scratch.splice(0)) {
    removeTree(directory);
  }
});

/** A throwaway directory that is removed after the test. */
function scratchDirectory(prefix = "xplainer-lifecycle-"): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(directory);
  return directory;
}

/** A state directory with the setup marker already in it, which is what an install requires. */
function installableState(): string {
  const stateDir = join(scratchDirectory(), "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeToolchainMarker(stateDir);
  return stateDir;
}

/** One command as a single line, which is how the assertions below name a sequence. */
function line(command: ProbeCommand): string {
  return `${command.program} ${command.argv.join(" ")}`;
}

/**
 * The four sentences, read out of ADR 0020 itself.
 *
 * The paragraph quotes them one after another after "It must be able to say, in words:", wrapped
 * across source lines; the whitespace is normalised and nothing else is. Everything before that
 * phrase is skipped, because the paragraph's first quotation is `launchctl`'s manual.
 */
function adrSentences(): readonly string[] {
  const text = readFileSync(ADR_0020, "utf8");
  const start = text.indexOf("It must be able to say, in");
  if (start < 0) {
    throw new Error(
      "ADR 0020 no longer introduces the sentences with `It must be able to say, in`",
    );
  }
  const paragraph = text.slice(start, start + 800);
  const quoted = [...paragraph.matchAll(/"([^"]+)"/g)].map((match) =>
    (match[1] ?? "").split(/\s+/).join(" "),
  );
  if (quoted.length < 4) {
    throw new Error(`ADR 0020's status paragraph quotes ${String(quoted.length)} sentences, not 4`);
  }
  return quoted.slice(0, 4);
}

/** What one harness recorded and can be asked to answer differently. */
type LifecycleHarness = {
  run: ProbeRunner;
  /** Every command, in order, as `program arg arg`. */
  commands: string[];
  /** Stop the daemon this harness started, as the supervisor's stop command would. */
  stop(): void;
  /**
   * Kill the daemon outright and wait for it to be gone.
   *
   * The state a `SIGKILL`ed daemon leaves — a stale `runtime.json`, nothing listening — as a fact
   * rather than a race. {@link stop} sends `SIGTERM`, which starts the shipped 20-second drain, so
   * a case that wants "not running" has to either wait out the drain or not ask for one.
   */
  kill(): Promise<void>;
  /** Make the disabled query answer "switched off". */
  switchOff(label: string): void;
};

/**
 * A supervisor that really starts and stops a daemon, and answers the documented queries.
 *
 * The same shape `install.test.ts` established, extended with the three queries this story adds:
 * the start and stop verbs really spawn and signal the process the install recorded, and
 * `lsof`, `ss` and `netstat` are handed to the **real** {@link runProbe}, because naming the pid
 * that holds a port is the one fact ADR 0020's first sentence carries and a recorded answer would
 * be this test agreeing with itself.
 */
function lifecycleHarness(options: { stateDir: string; lingerMarker?: string }): LifecycleHarness {
  const commands: string[] = [];
  let daemon: ChildProcess | null = null;
  let disabledLabel: string | null = null;

  const start = (): void => {
    if (daemon !== null && daemon.exitCode === null && !daemon.killed) {
      return;
    }
    const spec = readDaemonState(options.stateDir).launch_spec;
    if (spec === null) {
      throw new Error("the supervisor was asked to start a daemon before a spec was recorded");
    }
    daemon = spawn(spec.executable, [...spec.argv], {
      cwd: spec.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(daemon);
  };

  const stop = (): void => {
    daemon?.kill("SIGTERM");
    daemon = null;
  };

  const kill = async (): Promise<void> => {
    const child = daemon;
    daemon = null;
    if (child !== null) {
      await killAndWait(child, 5_000);
    }
  };

  const ok: ProbeResult = { started: true, status: 0, stdout: "", stderr: "" };

  const run: ProbeRunner = (command) => {
    const spelled = line(command);
    commands.push(spelled);

    if (["lsof", "ss", "netstat"].includes(command.program)) {
      return runProbe(command);
    }
    if (command.program === "loginctl" && command.argv.includes("enable-linger")) {
      if (options.lingerMarker !== undefined) {
        mkdirSync(join(options.lingerMarker, ".."), { recursive: true });
        writeFileSync(options.lingerMarker, "");
      }
      return ok;
    }
    if (command.program === "launchctl" && command.argv[0] === "print-disabled") {
      const store =
        disabledLabel === null
          ? '\tdisabled services = {\n\t\t"com.apple.Siri.agent" => disabled\n\t}\n'
          : `\tdisabled services = {\n\t\t"${disabledLabel}" => disabled\n\t}\n`;
      return { ...ok, stdout: store };
    }
    if (command.program === "systemctl" && command.argv[0] === "--user") {
      if (command.argv.includes("is-system-running")) {
        return { ...ok, stdout: "running\n" };
      }
      if (command.argv.includes("is-enabled")) {
        return disabledLabel === null
          ? { ...ok, stdout: "enabled\n" }
          : { started: true, status: 1, stdout: "disabled\n", stderr: "" };
      }
      if (command.argv.includes("show")) {
        // Two different `systemctl show` queries reach here: T12's loaded-configuration one, and
        // T13's "how did the last run end". They are told apart by the property asked for, because
        // that is how systemd itself tells them apart.
        return command.argv.includes("Result")
          ? { ...ok, stdout: "success\n0\n" }
          : { ...ok, stdout: "/opt/xplainer/bin/node /opt/xplainer/cli/bin.js serve\n\n/opt\n" };
      }
      if (command.argv.includes("enable") || command.argv.includes("start")) {
        start();
        return ok;
      }
      if (command.argv.includes("disable") || command.argv.includes("stop")) {
        stop();
        return ok;
      }
      return ok;
    }
    if (command.program === "launchctl" && command.argv[0] === "bootstrap") {
      start();
      return ok;
    }
    if (command.program === "launchctl" && command.argv[0] === "kickstart") {
      start();
      return ok;
    }
    if (command.program === "launchctl" && command.argv[0] === "bootout") {
      stop();
      return ok;
    }
    if (command.program === "launchctl" && command.argv[0] === "kill") {
      if (daemon === null) {
        return { started: true, status: 3, stdout: "", stderr: "No such process\n" };
      }
      stop();
      return ok;
    }
    if (spelled.includes("Start-ScheduledTask")) {
      start();
      return ok;
    }
    if (spelled.includes("Stop-ScheduledTask") || spelled.includes("Unregister-ScheduledTask")) {
      stop();
      return ok;
    }
    if (spelled.includes(").State")) {
      return { ...ok, stdout: `${disabledLabel === null ? "Running" : "Disabled"}\n` };
    }
    if (spelled.includes("Get-ScheduledTaskInfo")) {
      return { ...ok, stdout: "LastTaskResult    : 267036\n" };
    }
    return ok;
  };

  return {
    run,
    commands,
    stop,
    kill,
    switchOff: (label) => {
      disabledLabel = label;
    },
  };
}

/** A macOS account and directories, built inside a scratch tree so nothing real is touched. */
function fixtureEnvironment(root: string): SupervisorEnvironment {
  // The two Linux system directories are filled whatever platform the case addresses, because they
  // are what keeps the *host* out of the answer: `probeLinger()` composes `<lingerDir>/<account>`
  // and `probeSupervisor()` stats the booted directory, and a Linux runner executing this file
  // would otherwise read its own `/var/lib/systemd/linger/$USER` and `/run/systemd/system`. The
  // booted directory has to exist for the systemd branch to be reachable, so it is made here.
  const systemdBooted = join(root, "run-systemd-system");
  mkdirSync(systemdBooted, { recursive: true });
  return {
    home: join(root, "home"),
    account: "tester",
    lingerDir: join(root, "linger"),
    systemdBooted,
  };
}

/** Hold a port with a listener that is emphatically not an xplainer daemon. */
async function holdPort(port: number): Promise<void> {
  const server = createServer((_request, response) => {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not a daemon\n");
  });
  await new Promise<void>((ready, failed) => {
    server.once("error", failed);
    server.listen(port, "127.0.0.1", ready);
  });
  listeners.push(() => {
    server.close();
  });
}

/** Five starts in a row that never reached ready, and the latch the breaker writes. */
function latchStall(stateDir: string, at = new Date()): void {
  const recentStarts: DaemonStart[] = Array.from({ length: 5 }, (_unused, index) => {
    const startedAt = new Date(at.getTime() - (5 - index) * 10_000);
    return {
      started_at: startedAt.toISOString(),
      pid: 4000 + index,
      run_id: `run-${String(index)}`,
      ready_at: null,
      // Each run recorded its own end, a second after its own start: the shape the breaker counts
      // now that it no longer infers an end from the next start's timestamp.
      outcome: "failed",
      ended_at: new Date(startedAt.getTime() + 1_000).toISOString(),
      start_time: null,
      boot_id: null,
    };
  });
  updateDaemonState(stateDir, {
    recentStarts,
    stalled: {
      at: at.toISOString(),
      reason: "the last 5 starts each failed before the daemon was ready",
    },
  });
}

describe("the four sentences ADR 0020's `daemon status` paragraph names", () => {
  /**
   * The templates, against the ADR's own text. Two of the four name a platform's surface — Login
   * Items & Extensions is macOS's word for a launchd disable record, and lingering is systemd's —
   * so the ADR's sentence is the one that platform produces, and the other two say the same thing
   * about the surface their user actually has.
   */
  it("are the strings this package builds, word for word", () => {
    const [stopped, switchedOff, degraded, notPersistent] = adrSentences();

    expect(
      stoppedAfterFailedStartsSentence(5, {
        port: 8787,
        pid: 9932,
        detail: "by pid 9932, as `lsof` reports it",
      }),
    ).toBe(stopped);
    expect(SWITCHED_OFF_SENTENCES.launchd).toBe(switchedOff);
    expect(DEGRADED_TOOLCHAIN_SENTENCE).toBe(degraded);
    expect(NOT_BOOT_PERSISTENT_SENTENCES.systemd).toBe(notPersistent);

    // The other two platforms make the same claim about their own surface, and neither mentions a
    // pane or a marker that machine does not have.
    for (const kind of ["systemd", "task-scheduler"] as const) {
      expect(SWITCHED_OFF_SENTENCES[kind]).toContain("you or a policy switched this off");
      expect(SWITCHED_OFF_SENTENCES[kind]).not.toContain("Login Items");
    }
    for (const kind of ["launchd", "task-scheduler"] as const) {
      expect(NOT_BOOT_PERSISTENT_SENTENCES[kind]).toContain("running, but not boot-persistent");
      expect(NOT_BOOT_PERSISTENT_SENTENCES[kind]).not.toContain("lingering");
    }
  });

  /**
   * State one, against a real installed daemon that has been stopped: the breaker's latch, and a
   * real second process holding the recorded port. The pid in the sentence is **this process's**,
   * read back out of whichever of `lsof` or `ss` this machine has — so the sentence is the ADR's
   * with the two numbers this machine actually produced.
   */
  it(
    "says the first one, with the real pid holding the recorded port",
    async () => {
      const root = scratchDirectory();
      const stateDir = installableState();
      const environment = fixtureEnvironment(root);
      const harness = lifecycleHarness({ stateDir });

      await installDaemon({
        stateDir,
        payloadDir,
        port: 0,
        platform: "darwin",
        environment,
        run: harness.run,
        uid: 501,
        healthTimeoutMs: HEALTH_MS,
      });
      const port = readDaemonState(stateDir).port ?? 0;
      expect(port).toBeGreaterThan(0);

      // Stop the daemon the way a supervisor would, then put something else on its port.
      harness.stop();
      await waitUntil(() => !existsSync(join(stateDir, "runtime.json")));
      await holdPort(port);
      latchStall(stateDir);

      const report = await daemonStatus({
        stateDir,
        platform: "darwin",
        environment,
        run: harness.run,
        uid: 501,
      });

      expect(report.condition).toBe("stalled");
      expect(report.exit_code).toBe(DAEMON_UNHEALTHY_EXIT_CODE);
      expect(report.probe.holder_pid).toBe(process.pid);
      const [stopped] = adrSentences();
      const expected = (stopped ?? "")
        .replace("port 8787", `port ${String(port)}`)
        .replace("pid 9932", `pid ${String(process.pid)}`);
      expect(report.sentences).toContainEqual({
        state: "stopped-after-failed-starts",
        text: expected,
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  /**
   * State two, and the one no HTTP response and no file of ours can see: Login Items & Extensions
   * changes launchd's disable store and touches nothing this project owns. It is why
   * `commands/status.ts` cannot reach this condition and why `daemon status` runs the query.
   */
  it(
    "says the second one when the supervisor says the service is switched off",
    async () => {
      const root = scratchDirectory();
      const stateDir = installableState();
      const environment = fixtureEnvironment(root);
      const harness = lifecycleHarness({ stateDir });

      await installDaemon({
        stateDir,
        payloadDir,
        port: 0,
        platform: "darwin",
        environment,
        run: harness.run,
        uid: 501,
        healthTimeoutMs: HEALTH_MS,
      });
      harness.stop();
      await waitUntil(() => !existsSync(join(stateDir, "runtime.json")));
      harness.switchOff("video.xplainer.daemon");

      const report = await daemonStatus({
        stateDir,
        platform: "darwin",
        environment,
        run: harness.run,
        uid: 501,
      });

      expect(report.condition).toBe("disabled");
      expect(report.supervisor.switch.state).toBe("off");
      expect(report.supervisor.switch.query).toBe("launchctl print-disabled gui/501");
      const [, switchedOff] = adrSentences();
      expect(report.sentences).toContainEqual({ state: "switched-off", text: switchedOff });
      expect(report.supervisor.switch.detail).toContain(
        "launchctl enable gui/501/video.xplainer.daemon",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  /**
   * State three, against a daemon that is up and answering. The marker is the real one and the file
   * it names is really removed, which is the condition `xplainer setup` re-acquires. It exits `0`:
   * the daemon is running, and a script that gates on "is it up" must not fail over a missing
   * Chrome — the sentence and `toolchain.missing` are how a reader finds out.
   */
  it(
    "says the third one when the daemon answers and the toolchain is gone",
    async () => {
      const root = scratchDirectory();
      const stateDir = installableState();
      const environment = fixtureEnvironment(root);
      const harness = lifecycleHarness({ stateDir });

      await installDaemon({
        stateDir,
        payloadDir,
        port: 0,
        platform: "darwin",
        environment,
        run: harness.run,
        uid: 501,
        healthTimeoutMs: HEALTH_MS,
      });
      rmSync(join(stateDir, ACQUIRED_DIR, "chrome-headless-shell"), { force: true });

      const report = await daemonStatus({
        stateDir,
        platform: "darwin",
        environment,
        run: harness.run,
        uid: 501,
      });

      expect(report.condition).toBe("degraded");
      expect(report.exit_code).toBe(0);
      expect(report.health?.status).toBe("ok");
      expect(report.toolchain.missing).toHaveLength(1);
      const [, , degraded] = adrSentences();
      expect(report.sentences).toContainEqual({ state: "degraded-toolchain", text: degraded });
    },
    SPAWN_TIMEOUT_MS,
  );

  /**
   * State four, on the platform the sentence is about. The install enables lingering itself — that
   * is the one write ADR 0020 lets it make — and the marker is then removed under it, which is what
   * a site policy that revokes lingering looks like from here: the daemon is running now and will
   * not come back after a reboot with nobody logged in.
   */
  it(
    "says the fourth one when the daemon answers and lingering is not enabled",
    async () => {
      const root = scratchDirectory();
      const stateDir = installableState();
      const environment = fixtureEnvironment(root);
      const marker = join(String(environment.lingerDir), "tester");
      const harness = lifecycleHarness({ stateDir, lingerMarker: marker });

      await installDaemon({
        stateDir,
        payloadDir,
        port: 0,
        platform: "linux",
        environment,
        run: harness.run,
        healthTimeoutMs: HEALTH_MS,
      });
      expect(existsSync(marker)).toBe(true);
      rmSync(marker, { force: true });

      const report = await daemonStatus({
        stateDir,
        platform: "linux",
        environment,
        run: harness.run,
      });

      expect(report.condition).toBe("ready");
      expect(report.exit_code).toBe(0);
      expect(report.boot_persistence.persistent).toBe(false);
      const [, , , notPersistent] = adrSentences();
      expect(report.sentences).toContainEqual({
        state: "not-boot-persistent",
        text: notPersistent,
      });
    },
    SPAWN_TIMEOUT_MS,
  );
});

/**
 * A stand-in daemon on a real port: it answers `/healthz` and counts the TCP connections it was
 * asked over, which is the property under test.
 */
async function healthzListener(): Promise<{ port: number; connections: () => number }> {
  const sockets = new Set<Socket>();
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", version: "1.2.3", port: 0 }));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
  });
  await new Promise<void>((ready, failed) => {
    server.once("error", failed);
    server.listen(0, "127.0.0.1", ready);
  });
  const address = server.address();
  listeners.push(() => {
    for (const socket of sockets) {
      socket.destroy();
    }
    server.close();
  });
  return {
    port: typeof address === "object" && address !== null ? address.port : 0,
    connections: () => sockets.size,
  };
}

describe("daemon status — how the probe reaches the daemon", () => {
  /**
   * The flake this assertion exists for, and its cause. `pnpm --filter @xplainer/cli test` failed
   * three runs in five with **no failing test** — "Test Files 63 passed, Errors 1 error" — moving
   * between `install.test.ts` and this file. The error was always the same:
   *
   *     Error: setTypeOfService EINVAL
   *      ❯ Socket.setTypeOfService node:net:911:13
   *      ❯ writeH1 node:internal/deps/undici/undici:8022:16
   *      ❯ _resume … ❯ Socket.emit node:events:514:28
   *
   * `daemonStatus` polled `/healthz` with the platform's `fetch`; Node's bundled undici keeps the
   * connection and, on the **next** ask, resumes that pooled socket and calls
   * `socket.setTypeOfService()` before writing. `node:net` reports a failed `setsockopt` by
   * *throwing*, and undici writes from inside the socket's own event handler — so a socket the
   * daemon had torn down between two status calls raised an uncaught exception past every
   * `try`/`catch` in this repository and took the Vitest worker with it.
   *
   * The property that removes it is the one asserted here: **a connection per ask**. It is asserted
   * on the default probe — the parameter is deliberately not passed — because the defect was in
   * which client the default is.
   */
  it("opens a new connection for every ask, so no pooled socket is ever resumed", async () => {
    const root = scratchDirectory();
    const stateDir = installableState();
    const daemon = await healthzListener();
    const tokenFile = join(stateDir, "token");
    writeFileSync(tokenFile, "a-token\n", { mode: 0o600 });
    updateDaemonState(stateDir, { port: daemon.port, token_file: tokenFile });
    const harness = lifecycleHarness({ stateDir });

    for (let ask = 0; ask < 3; ask += 1) {
      const report = await daemonStatus({
        stateDir,
        platform: "darwin",
        environment: fixtureEnvironment(root),
        run: harness.run,
        uid: 501,
      });
      expect(report.probe.http_status).toBe(200);
    }

    expect(daemon.connections()).toBe(3);
  });
});

describe("daemon status — the three queries, and nothing that parses launchctl print", () => {
  /**
   * Criterion 3, as a property of what actually ran. `launchctl print` is the one surface whose own
   * manual says "This output is NOT API in any sense at all"; `print-disabled` is a different
   * subcommand with a stable one-label-per-line store, and it is the only `launchctl` read this
   * command makes.
   */
  it(
    "runs print-disabled and never `launchctl print`",
    async () => {
      const root = scratchDirectory();
      const stateDir = installableState();
      const environment = fixtureEnvironment(root);
      const harness = lifecycleHarness({ stateDir });

      await installDaemon({
        stateDir,
        payloadDir,
        port: 0,
        platform: "darwin",
        environment,
        run: harness.run,
        uid: 501,
        healthTimeoutMs: HEALTH_MS,
      });
      harness.commands.length = 0;

      await daemonStatus({
        stateDir,
        platform: "darwin",
        environment,
        run: harness.run,
        uid: 501,
      });

      expect(harness.commands).toContain("launchctl print-disabled gui/501");
      for (const command of harness.commands) {
        expect(command.startsWith("launchctl print ")).toBe(false);
      }
      // Criterion 6, as an allowlist: every command a status ran, with the fact it establishes.
      // Anything else would be a fact coming from somewhere other than `/healthz`, our own files
      // and the documented queries.
      //
      // **Two GUI domains can legitimately appear, and which two depends on the machine.**
      // `askSwitch` asks about the uid this case injects — 501, the ADR's own example — while the
      // preflight's domain probe asks about the uid the *process* has, which is 501 on a macOS
      // runner and 1001 on the Linux one that runs this same file. Pinning both to 501 made this a
      // macOS-only assertion, and it failed on `ubuntu-latest` on 2026-09-08 for that reason and
      // not for anything `daemon status` did.
      const ownDomain = `launchctl print-disabled gui/${String(process.getuid?.() ?? 0)}`;
      const allowed = [
        "launchctl print-disabled gui/501", // the disabled-by-user-or-policy query, and the domain
        ownDomain, // the same query, for the domain this process is actually in
        "lsof", // who holds the recorded port, when it is held
        "ss",
        "netstat",
      ];
      for (const command of harness.commands) {
        expect(allowed.some((prefix) => command.startsWith(prefix))).toBe(true);
      }
      // And the memoised runner asked launchd once **per domain**, not once per caller: two callers
      // asking the same question spend one subprocess, which is the whole point of memoising.
      const disabledQueries = harness.commands.filter((entry) =>
        entry.startsWith("launchctl print-disabled"),
      );
      expect(disabledQueries).toContain("launchctl print-disabled gui/501");
      expect(new Set(disabledQueries).size).toBe(disabledQueries.length);
    },
    SPAWN_TIMEOUT_MS,
  );

  /**
   * The two GUI domains one status can ask about, which is why the allowlist above has room for
   * two — reproduced here rather than left to the machine that happens to run this file.
   *
   * `askSwitch` asks about the uid it was **given**: an installer's, a supervisor's, or this
   * suite's `501`. The preflight's own domain probe asks launchd about the uid this **process**
   * has, because "does this account have a GUI domain at all" is a question about the caller. On a
   * machine where those two differ the status runs two `print-disabled` commands, and that is not
   * a fault: it is one question asked of two domains. `ubuntu-latest` is such a machine — 501
   * injected, 1001 running — and injecting a uid that is deliberately not this process's makes the
   * same divergence appear on any machine.
   */
  it("asks the switch question about the uid it was given, and the domain question about its own", async () => {
    const stateDir = installableState();
    const harness = lifecycleHarness({ stateDir });
    const own = process.getuid?.() ?? 0;
    const injected = own + 4242;
    // A recorded registration, so there is something for the switch query to be about. No daemon is
    // started: what is being observed is which commands a status runs, not what they answer.
    updateDaemonState(stateDir, {
      supervisor_kind: "launchd",
      supervisor_artefact: join(scratchDirectory(), "agent.plist"),
    });

    await daemonStatus({
      stateDir,
      platform: "darwin",
      environment: fixtureEnvironment(scratchDirectory()),
      run: harness.run,
      uid: injected,
    });

    expect(harness.commands).toContain(`launchctl print-disabled gui/${String(injected)}`);
    expect(harness.commands).toContain(`launchctl print-disabled gui/${String(own)}`);
    expect(harness.commands.filter((entry) => entry.startsWith("launchctl print "))).toEqual([]);
  });

  /** Criterion 4: the three queries, spelled as the plan and ADR 0020 name them. */
  it("asks the disabled question with the documented command on each platform", () => {
    expect(
      line(
        disabledQuery({
          kind: "launchd",
          identity: "video.xplainer.daemon",
          artefact: "",
          uid: 501,
        }),
      ),
    ).toBe("launchctl print-disabled gui/501");
    expect(
      line(disabledQuery({ kind: "systemd", identity: "xplainer.service", artefact: "", uid: 0 })),
    ).toBe("systemctl --user is-enabled xplainer.service");
    const windows = line(
      disabledQuery({
        kind: "task-scheduler",
        identity: "\\xplainer\\tester-daemon",
        artefact: "",
        uid: 0,
      }),
    );
    expect(windows).toContain("(Get-ScheduledTask -TaskName '\\xplainer\\tester-daemon').State");
    expect(windows.startsWith("powershell.exe -NoProfile -NonInteractive")).toBe(true);
  });

  /** Criterion 5: the loaded-configuration query, and macOS's documented absence of one (D7). */
  it("reads the loaded configuration where a documented query exists, and nowhere else", () => {
    expect(
      line(
        loadedConfigurationQuery({
          kind: "systemd",
          identity: "xplainer.service",
          artefact: "",
          uid: 0,
        }) ?? { program: "", argv: [] },
      ),
    ).toBe(
      "systemctl --user show -p ExecStart -p Environment -p WorkingDirectory --value xplainer.service",
    );
    const windows = loadedConfigurationQuery({
      kind: "task-scheduler",
      identity: "\\xplainer\\tester-daemon",
      artefact: "",
      uid: 0,
    });
    expect(line(windows ?? { program: "", argv: [] })).toContain("Get-ScheduledTask -TaskName");
    expect(
      loadedConfigurationQuery({
        kind: "launchd",
        identity: "video.xplainer.daemon",
        artefact: "",
        uid: 501,
      }),
    ).toBeNull();
  });

  /** Each supervisor's own vocabulary, mapped to the four values a caller branches on. */
  it("maps each supervisor's own words onto the switch", () => {
    const answered = (stdout: string, status = 0): ProbeResult => ({
      started: true,
      status,
      stdout,
      stderr: "",
    });

    expect(
      readSwitch(
        "launchd",
        "video.xplainer.daemon",
        answered('\tdisabled services = {\n\t\t"video.xplainer.daemon" => disabled\n\t}\n'),
      ).state,
    ).toBe("off");
    expect(
      readSwitch(
        "launchd",
        "video.xplainer.daemon",
        answered('\tdisabled services = {\n\t\t"com.other" => disabled\n\t}\n'),
      ).state,
    ).toBe("on");
    expect(readSwitch("systemd", "xplainer.service", answered("disabled\n", 1)).state).toBe("off");
    expect(readSwitch("systemd", "xplainer.service", answered("masked\n", 1)).state).toBe("off");
    expect(readSwitch("systemd", "xplainer.service", answered("enabled\n")).state).toBe("on");
    expect(
      readSwitch("systemd", "xplainer.service", {
        started: true,
        status: 4,
        stdout: "",
        stderr: "Failed to get unit file state for xplainer.service: not-found\n",
      }).state,
    ).toBe("unregistered");
    expect(readSwitch("task-scheduler", "\\xplainer\\t", answered("Disabled\n")).state).toBe("off");
    expect(readSwitch("task-scheduler", "\\xplainer\\t", answered("Running\n")).state).toBe("on");
    expect(
      readSwitch("task-scheduler", "\\xplainer\\t", {
        started: false,
        status: null,
        stdout: "",
        stderr: "",
      }).state,
    ).toBe("unknown");
  });

  /** With nothing installed there is no service to ask about, and that is a report, not a throw. */
  it(
    "reports an uninstalled machine without asking a supervisor anything",
    async () => {
      const stateDir = installableState();
      const harness = lifecycleHarness({ stateDir });

      const report = await daemonStatus({
        stateDir,
        platform: "darwin",
        environment: fixtureEnvironment(scratchDirectory()),
        run: harness.run,
        uid: 501,
      });

      expect(report.condition).toBe("absent");
      expect(report.supervisor.switch.state).toBe("unregistered");
      expect(report.supervisor.switch.query).toBeNull();
      expect(report.sentences).toEqual([]);
      expect(report.boot_persistence.persistent).toBeNull();
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe("daemon start and daemon stop", () => {
  /**
   * The post-condition is an authenticated `200` and never the start command's exit status: all
   * three supervisors return as soon as they have accepted the request. The stop's post-condition
   * is the mirror image, and the registration survives it — `uninstall` is what removes that.
   */
  it(
    "stops a real installed daemon and starts it again, waiting for each post-condition",
    async () => {
      const root = scratchDirectory();
      const stateDir = installableState();
      const environment = fixtureEnvironment(root);
      const harness = lifecycleHarness({ stateDir });

      await installDaemon({
        stateDir,
        payloadDir,
        port: 0,
        platform: "darwin",
        environment,
        run: harness.run,
        uid: 501,
        healthTimeoutMs: HEALTH_MS,
      });
      const artefact = readDaemonState(stateDir).supervisor_artefact ?? "";

      const stopped = await stopDaemon({
        stateDir,
        platform: "darwin",
        environment,
        run: harness.run,
        uid: 501,
      });
      expect(stopped.commands).toEqual(["launchctl kill SIGTERM gui/501/video.xplainer.daemon"]);
      expect(stopped.alreadyThere).toBe(false);
      expect(existsSync(artefact)).toBe(true);

      const restarted = await startDaemon({
        stateDir,
        platform: "darwin",
        environment,
        run: harness.run,
        uid: 501,
      });
      expect(restarted.commands).toEqual(["launchctl kickstart gui/501/video.xplainer.daemon"]);
      expect(restarted.alreadyThere).toBe(false);
      expect(restarted.port).toBe(readDaemonState(stateDir).port);

      // A second start finds it answering and asks the supervisor for nothing at all.
      const again = await startDaemon({
        stateDir,
        platform: "darwin",
        environment,
        run: harness.run,
        uid: 501,
      });
      expect(again.alreadyThere).toBe(true);
      expect(again.commands).toEqual([]);
    },
    SPAWN_TIMEOUT_MS,
  );

  /** A stop that the supervisor refuses to run at all is a refusal with the documented code. */
  it(
    "refuses with 4 when the supervisor command cannot be run",
    async () => {
      const root = scratchDirectory();
      const stateDir = installableState();
      const environment = fixtureEnvironment(root);
      const harness = lifecycleHarness({ stateDir });
      await installDaemon({
        stateDir,
        payloadDir,
        port: 0,
        platform: "darwin",
        environment,
        run: harness.run,
        uid: 501,
        healthTimeoutMs: HEALTH_MS,
      });

      const refusal = await startDaemon({
        stateDir,
        platform: "darwin",
        environment,
        run: () => ({ started: false, status: null, stdout: "", stderr: "" }),
        uid: 501,
        probe: async () => ({ kind: "unreachable", reason: "test" }),
      }).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(LifecycleRefusal);
      expect((refusal as LifecycleRefusal).exitCode).toBe(DAEMON_UNHEALTHY_EXIT_CODE);
    },
    SPAWN_TIMEOUT_MS,
  );

  /** Nothing registered is ADR 0020's `3`: a precondition unmet, with nothing written. */
  it("refuses with 3 when nothing is installed here", async () => {
    const stateDir = installableState();

    for (const verb of [startDaemon, stopDaemon, restartDaemon]) {
      const refusal: unknown = await verb({ stateDir, platform: "darwin" }).catch(
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(DaemonNotInstalled);
      expect((refusal as DaemonNotInstalled).exitCode).toBe(PRECONDITION_UNMET_EXIT_CODE);
    }
  });
});

/**
 * `daemon restart`, against a **real `xplainer serve`** under a recorded supervisor.
 *
 * The daemon here is the shipped one — the real drain route, the real socket, the real token, the
 * real `/healthz` — because the whole of this verb is a conversation with it: the drain is asked for
 * over the socket and the wait is for that process to be gone. What is substituted is the one thing
 * a single machine cannot have three of, `run`, exactly as the other lifecycle tests substitute it;
 * `install/testing/restart-proof.ts` is where the same sequence meets a real launchd and a real
 * systemd.
 *
 * The launch spec is written by hand rather than staged, and it names this process's interpreter
 * running this package's own sources. `install.test.ts` and `lifecycle.test.ts`'s other cases prove
 * the payload half; what is under test here is the drain, which the fixture payload's miniature
 * daemon deliberately does not have.
 *
 * **The latch is set while the daemon is running**, so the assertion has teeth in both directions:
 * a restart that failed to clear it would ask the supervisor to start a `serve` that exits `0`
 * without binding, and the readiness wait would time out rather than quietly passing.
 */
describe("daemon restart", () => {
  /** A state directory holding a real daemon's own record, and a launch spec that starts one. */
  function realDaemonState(kind: "launchd" | "systemd"): { stateDir: string; socket: string } {
    // A short prefix and a one-letter state directory, because the socket underneath both has to
    // fit `sockaddr_un.sun_path`: macOS allows 103 bytes and `/private/var/folders/…/T/` is most of
    // them already, which `daemon/ipc.ts` refuses by length rather than as an opaque `EINVAL`.
    const root = scratchDirectory("xr-");
    const stateDir = join(root, "s");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeToolchainMarker(stateDir);
    const socket = resolveIpcPath(stateDir);
    const tokenFile = join(stateDir, "token");
    updateDaemonState(stateDir, {
      supervisor_kind: kind,
      supervisor_artefact: join(root, kind === "launchd" ? "agent.plist" : "xplainer.service"),
      token_file: tokenFile,
      socket_path: socket,
      launch_spec: {
        executable: process.execPath,
        argv: [
          "--import",
          TS_SOURCE_HOOK,
          CHILD_SERVE,
          "--port",
          "0",
          "--state-dir",
          stateDir,
          "--token-file",
          tokenFile,
          "--socket",
          socket,
        ],
        settings: { stateDir, tokenFile, socket },
        cwd: stateDir,
      },
    });
    return { stateDir, socket };
  }

  it(
    "clears the latch, drains the running daemon over its socket, and starts it again",
    async () => {
      const { stateDir, socket } = realDaemonState("launchd");
      const environment = fixtureEnvironment(scratchDirectory());
      const harness = lifecycleHarness({ stateDir });
      const context = { stateDir, platform: "darwin" as const, environment, uid: 501 };

      await startDaemon({ ...context, run: harness.run });
      const draining = JSON.parse(readFileSync(join(stateDir, "runtime.json"), "utf8")) as {
        pid: number;
      };
      expect(isAlive(draining.pid)).toBe(true);

      // A daemon that has latched: the next `serve` refuses to bind until this is cleared.
      updateDaemonState(stateDir, {
        stalled: { at: new Date().toISOString(), reason: "five failed starts, in this test" },
      });

      const outcome = await restartDaemon({ ...context, run: harness.run });

      // The order, and the whole transcript: the route first, then the supervisor's own start.
      expect(outcome.commands).toEqual([
        `POST /api/daemon/drain over ${socket}`,
        "launchctl kickstart gui/501/video.xplainer.daemon",
      ]);
      expect(outcome.cleared.stalled?.reason).toContain("five failed starts");
      expect(outcome.stop).toContain(`pid ${String(draining.pid)} drained`);
      expect(outcome.stop).toContain("runtime.json was removed with it");
      // launchd has neither a failure latch nor a documented exit query, and says so rather than
      // implying an answer it does not have.
      expect(outcome.supervisorLatch).toContain("launchd keeps no failure latch");
      expect(outcome.exit).toContain("no documented query");

      // The daemon that came back is a different process, answering, with the latch gone.
      const after = JSON.parse(readFileSync(join(stateDir, "runtime.json"), "utf8")) as {
        pid: number;
      };
      expect(after.pid).not.toBe(draining.pid);
      expect(isAlive(draining.pid)).toBe(false);
      expect(outcome.port).toBe(readDaemonState(stateDir).port);
      expect(readDaemonState(stateDir).stalled).toBeNull();
      expect(outcome.alreadyThere).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );

  /**
   * Linux is the platform with a supervisor latch, and `reset-failed` has to run **before** the
   * daemon is asked for anything: systemd refuses a start it has rate-limited, and discovering that
   * at the end of a restart is discovering it too late.
   */
  it(
    "runs systemctl --user reset-failed first, and reads the exit status systemd records",
    async () => {
      const { stateDir, socket } = realDaemonState("systemd");
      const environment = fixtureEnvironment(scratchDirectory());
      const harness = lifecycleHarness({ stateDir });
      const context = { stateDir, platform: "linux" as const, environment, uid: 1000 };

      await startDaemon({ ...context, run: harness.run });
      const before = harness.commands.length;

      const outcome = await restartDaemon({ ...context, run: harness.run });

      expect(harness.commands[before]).toBe("systemctl --user reset-failed xplainer.service");
      expect(outcome.commands).toEqual([
        "systemctl --user reset-failed xplainer.service",
        `POST /api/daemon/drain over ${socket}`,
        "systemctl --user start xplainer.service",
      ]);
      expect(outcome.supervisorLatch).toContain("start-rate limit");
      expect(outcome.exit).toContain("Result=success ExecMainStatus=0");
      expect(outcome.exit).toContain("ended in exit 0");
      expect(outcome.port).toBe(readDaemonState(stateDir).port);
    },
    SPAWN_TIMEOUT_MS,
  );

  /** An already-stopped daemon is what people run this on, and it is a success, not a refusal. */
  it(
    "treats a daemon that is not running as nothing to drain, and starts it",
    async () => {
      const { stateDir } = realDaemonState("launchd");
      const environment = fixtureEnvironment(scratchDirectory());
      const harness = lifecycleHarness({ stateDir });
      const context = { stateDir, platform: "darwin" as const, environment, uid: 501 };

      await startDaemon({ ...context, run: harness.run });
      // **Killed and waited for, rather than asked to stop.** `SIGTERM` starts the shipped
      // 20-second drain, so a `restartDaemon` that ran straight after one met a daemon that was
      // still answering `/healthz` while its socket had already gone — and got the *other* true
      // sentence, "nothing is listening on … (ENOENT), though something answered /healthz a moment
      // earlier". macOS finished the drain quickly enough to pass and `ubuntu-latest` did not, on
      // 2026-09-08. A `SIGKILL` is also the state this case is named for: a daemon that is not
      // running, and the stale `runtime.json` a killed one leaves behind.
      await harness.kill();
      expect(existsSync(join(stateDir, "runtime.json"))).toBe(true);

      const outcome = await restartDaemon({ ...context, run: harness.run });

      expect(outcome.stop).toContain("nothing was answering");
      expect(outcome.commands).toEqual(["launchctl kickstart gui/501/video.xplainer.daemon"]);
      expect(outcome.exit).toContain("did not drain a running daemon");
      expect(outcome.port).toBe(readDaemonState(stateDir).port);
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe("daemon logs", () => {
  /** Linux is the journal, and the command is ADR 0020's own. */
  it("execs journalctl --user -u xplainer on Linux", () => {
    const stateDir = installableState();
    updateDaemonState(stateDir, { supervisor_kind: "systemd", log_sink: "journald" });

    const source = logSource(readDaemonState(stateDir), { home: "/home/t", account: "t" }, 50);

    expect(source.kind).toBe("journal");
    if (source.kind === "journal") {
      expect(line(source.command)).toBe("journalctl --user -u xplainer.service -n 50");
      expect(line(source.command).startsWith("journalctl --user -u xplainer")).toBe(true);
    }
  });

  /** macOS and Windows are a file, and the path is the one the install recorded. */
  it("tails the recorded file on macOS and Windows", () => {
    const root = scratchDirectory();
    const stateDir = installableState();
    const log = join(root, "daemon.log");
    writeFileSync(log, "");
    for (let index = 0; index < 500; index += 1) {
      appendFileSync(log, `line ${String(index)}\n`);
    }
    updateDaemonState(stateDir, { supervisor_kind: "launchd", log_sink: log });

    const source = logSource(readDaemonState(stateDir), { home: root, account: "t" }, 5);

    expect(source).toEqual({ kind: "file", path: log, present: true });
    expect(tailFile(log, 5, 64)).toEqual([
      "line 495",
      "line 496",
      "line 497",
      "line 498",
      "line 499",
    ]);
    // Fewer lines than asked for is the whole file, and no half-line from the block boundary.
    expect(tailFile(log, 5000, 64)).toHaveLength(500);
    expect(tailFile(log, 5000, 64)[0]).toBe("line 0");
  });

  /** A Windows install records the file ADR 0020's platform table names, never `journald`. */
  it("records a Windows log path rather than a journal that is not there", () => {
    const stateDir = installableState();
    updateDaemonState(stateDir, {
      supervisor_kind: "task-scheduler",
      log_sink: null,
    });

    const source = logSource(
      readDaemonState(stateDir),
      {
        home: "C:\\Users\\t",
        account: "CORP\\t",
        localAppData: "C:\\Users\\t\\AppData\\Local",
      },
      10,
    );

    expect(source).toEqual({
      kind: "file",
      path: "C:\\Users\\t\\AppData\\Local\\xplainer\\logs\\daemon.log",
      present: false,
    });
  });
});

/** Wait for a predicate, so a supervisor's stop is waited on rather than slept through. */
async function waitUntil(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("timed out waiting for the daemon to go");
}
