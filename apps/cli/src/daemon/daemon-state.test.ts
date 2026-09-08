/**
 * The two state files, and the breaker that had to move between them.
 *
 * ADR 0020 §Restart on crash put `recentStarts[]` and `stalled` in `runtime.json`; its own note of
 * 2026-09-06 records why that was wrong, and ADR 0024 §Consequences moves them to the durable
 * directory. The placement assertion below is the one that keeps the move made: it reads both files
 * and requires the crash history to be in the one that survives a stop.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DaemonStart,
  FAILED_START_WINDOW_MS,
  isStalled,
  markDaemonReady,
  newDaemonStart,
  RECENT_STARTS_KEPT,
  readDaemonState,
  readRuntimeState,
  recordDaemonEnd,
  recordDaemonStart,
  recordStall,
  STALL_AFTER_FAILED_STARTS,
  StateFileUnreadableError,
  startIsProvablyGone,
  updateDaemonState,
  writeRuntimeState,
} from "./daemon-state.js";
import { ensureStateDirectory } from "./durable-write.js";
import { STATE_UNREADABLE_EXIT_CODE } from "./exit-codes.js";
import { stateDirLayout } from "./state-dir.js";
import { selfIdentity } from "./worker-identity.js";

const scratch: string[] = [];

function stateDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "xplainer-state-"));
  ensureStateDirectory(dir);
  scratch.push(dir);
  return dir;
}

/** A run that started at `atMs`, recorded its own failure `livedMs` later, and never reached ready. */
function failedStart(atMs: number, index: number, livedMs = 1_000): DaemonStart {
  return {
    ...unknownStart(atMs, index),
    outcome: "failed",
    ended_at: new Date(atMs + livedMs).toISOString(),
  };
}

/**
 * A run that started at `atMs` and recorded nothing at all.
 *
 * `SIGKILL`, a panic or a power cut: no outcome, no end, and an identity tuple naming a pid that is
 * not this machine's — which is what {@link startIsProvablyGone} has to establish before D6's rule
 * may count it.
 */
function unknownStart(atMs: number, index: number): DaemonStart {
  return {
    started_at: new Date(atMs).toISOString(),
    pid: 100 + index,
    run_id: `run-${index}`,
    ready_at: null,
    outcome: null,
    ended_at: null,
    start_time: `a token no live process on this machine has (${index})`,
    boot_id: "a boot that is not this one",
  };
}

/** The instant every fixture in this file counts from. */
const base = Date.parse("2026-09-06T00:00:00.000Z");

/** The verdict D6's unknown rule asks for, stubbed, so a case can be about the arithmetic alone. */
const wasGone = (): boolean => true;

/**
 * The same run, but recorded on **this** boot, so the pid is what the verdict turns on.
 *
 * {@link unknownStart} names a foreign boot, which `classifyWorker` answers without touching the
 * process table at all. A case about a process that really is not running has to take the other
 * path, and that means a boot id this machine agrees with.
 */
function onThisBoot(pid: number): DaemonStart {
  return {
    ...unknownStart(base + 4_000, 4),
    pid,
    start_time: null,
    boot_id: selfIdentity().boot_id,
  };
}

/** A pid that really is not running: a child spawned, waited for, and now reaped. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error("spawnSync reported no pid for a child that has already exited");
  }
  return pid;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("readDaemonState", () => {
  it("describes a directory that has never held a daemon", () => {
    expect(readDaemonState(stateDirectory())).toEqual({
      format_version: 1,
      port: null,
      contract_version: null,
      token_file: null,
      socket_path: null,
      token_origin: null,
      token_rotation: null,
      directory_flush: null,
      supervisor_kind: null,
      supervisor_artefact: null,
      runtime_dir: null,
      launch_spec: null,
      program_source: null,
      launchd_enable_record_created: null,
      linger_enabled_by_us: null,
      log_sink: null,
      installed_version: null,
      recentStarts: [],
      stalled: null,
    });
  });

  /**
   * The installer's half of the file, read back as the typed fields the consumers want: `status`
   * reports them, the consistency check compares them, and `uninstall` acts on
   * `linger_enabled_by_us`. A field that is only *preserved* is a field nobody can read without a
   * cast at every call site.
   */
  it("reads back every field the installer writes", () => {
    const stateDir = stateDirectory();
    const launchSpec = {
      executable: "/state/runtime/1.0.0-abc/bin/node",
      argv: [
        "/state/runtime/1.0.0-abc/lib/node_modules/@xplainer/cli/dist/bin.js",
        "serve",
        "--port",
        "8787",
        "--state-dir",
        "/state",
        "--token-file",
        "/state/token",
        "--socket",
        "/run/user/1000/xplainer/xplainer.sock",
      ],
      settings: {
        stateDir: "/state",
        tokenFile: "/state/token",
        socket: "/run/user/1000/xplainer/xplainer.sock",
      },
      cwd: "/state",
    };
    writeFileSync(
      stateDirLayout(stateDir).daemonState,
      JSON.stringify({
        socket_path: "/run/user/1000/xplainer/xplainer.sock",
        supervisor_kind: "systemd",
        supervisor_artefact: "/home/a/.config/systemd/user/xplainer.service",
        runtime_dir: "/state/runtime/1.0.0-abc",
        launch_spec: launchSpec,
        program_source: "runtime-dir",
        linger_enabled_by_us: true,
        log_sink: "journald",
        installed_version: "1.0.0",
      }),
    );

    const state = readDaemonState(stateDir);

    expect(state.socket_path).toBe("/run/user/1000/xplainer/xplainer.sock");
    expect(state.supervisor_kind).toBe("systemd");
    expect(state.supervisor_artefact).toBe("/home/a/.config/systemd/user/xplainer.service");
    expect(state.runtime_dir).toBe("/state/runtime/1.0.0-abc");
    expect(state.launch_spec).toEqual(launchSpec);
    expect(state.program_source).toBe("runtime-dir");
    expect(state.linger_enabled_by_us).toBe(true);
    expect(state.log_sink).toBe("journald");
    expect(state.installed_version).toBe("1.0.0");
  });

  /**
   * `daemon.json` is a file a person can edit, so a value outside the closed set is `null` rather
   * than a string a later `switch` would fall through. And a *half* launch spec is `null` outright:
   * a consistency check handed an `argv` with no `settings` would report agreement it never
   * established.
   */
  it("refuses a supervisor, a program source and a launch spec it cannot trust", () => {
    const stateDir = stateDirectory();
    writeFileSync(
      stateDirLayout(stateDir).daemonState,
      JSON.stringify({
        supervisor_kind: "upstart",
        program_source: "curl-bash",
        linger_enabled_by_us: "yes",
        token_origin: "trusted",
        launch_spec: { executable: "/bin/node", argv: ["serve"], cwd: "/state" },
      }),
    );

    const state = readDaemonState(stateDir);

    expect(state.supervisor_kind).toBeNull();
    expect(state.program_source).toBeNull();
    expect(state.linger_enabled_by_us).toBeNull();
    expect(state.launch_spec).toBeNull();
    // ADR 0020 §Security R-SEC-9 is decided against this field, and every uncertainty about it has
    // to fall towards the answer that refuses a remote bind. A word nobody defined is `null`, and
    // `daemon/tls.ts` treats anything that is not `operator` as the daemon's own mint.
    expect(state.token_origin).toBeNull();
  });

  it.each(["minted", "operator"] as const)("reads back a token_origin of %s", (origin) => {
    const stateDir = stateDirectory();
    writeFileSync(stateDirLayout(stateDir).daemonState, JSON.stringify({ token_origin: origin }));

    expect(readDaemonState(stateDir).token_origin).toBe(origin);
  });

  it("refuses to guess about a file it cannot parse, with the exit code that names the condition", () => {
    const stateDir = stateDirectory();
    writeFileSync(stateDirLayout(stateDir).daemonState, "{ not json");

    expect(() => readDaemonState(stateDir)).toThrow(StateFileUnreadableError);
    try {
      readDaemonState(stateDir);
    } catch (error) {
      expect(error).toBeInstanceOf(StateFileUnreadableError);
      expect((error as StateFileUnreadableError).exitCode).toBe(STATE_UNREADABLE_EXIT_CODE);
    }
  });
});

describe("updateDaemonState", () => {
  it("keeps keys this daemon does not know about", () => {
    const stateDir = stateDirectory();
    writeFileSync(
      stateDirLayout(stateDir).daemonState,
      JSON.stringify({ supervisor: "launchd", token_path: "/tokens/xplainer" }),
    );

    updateDaemonState(stateDir, { port: 8787 });

    const raw = JSON.parse(readFileSync(stateDirLayout(stateDir).daemonState, "utf8")) as Record<
      string,
      unknown
    >;
    // Phase 2's installer owns most of this file; a `serve` that rewrote it from its own narrow
    // view would silently uninstall the daemon it is part of.
    expect(raw.supervisor).toBe("launchd");
    expect(raw.token_path).toBe("/tokens/xplainer");
    expect(raw.port).toBe(8787);
  });
});

describe("recentStarts and stalled", () => {
  it("live in daemon.json and in no other state file", () => {
    const stateDir = stateDirectory();
    const start = newDaemonStart("run-a", "2026-09-06T00:00:00.000Z");

    recordDaemonStart(stateDir, start);
    recordStall(stateDir, { at: "2026-09-06T00:00:01.000Z", reason: "five failed starts" });
    writeRuntimeState(stateDir, {
      pid: process.pid,
      run_id: "run-a",
      boot_id: null,
      port: 8787,
      addresses: ["http://127.0.0.1:8787"],
      socket: null,
      started_at: "2026-09-06T00:00:00.000Z",
    });

    const daemonJson = readFileSync(stateDirLayout(stateDir).daemonState, "utf8");
    const runtimeJson = readFileSync(stateDirLayout(stateDir).runtimeState, "utf8");

    expect(daemonJson).toContain("recentStarts");
    expect(daemonJson).toContain("stalled");
    expect(runtimeJson).not.toContain("recentStarts");
    expect(runtimeJson).not.toContain("stalled");
    expect(readDaemonState(stateDir).recentStarts).toEqual([start]);
    expect(readRuntimeState(stateDir)?.pid).toBe(process.pid);
  });

  it("keeps a bounded history", () => {
    const stateDir = stateDirectory();

    for (let index = 0; index < RECENT_STARTS_KEPT + 4; index += 1) {
      recordDaemonStart(stateDir, newDaemonStart(`run-${index}`, new Date(index).toISOString()));
    }

    const history = readDaemonState(stateDir).recentStarts;
    expect(history).toHaveLength(RECENT_STARTS_KEPT);
    expect(history[0]?.run_id).toBe("run-4");
  });

  /**
   * The record the breaker counts, written by the run it is about.
   *
   * Phase 1 kept a start time and a `ready_at` and inferred everything else; what is asserted here
   * is that a run's **own** end and its outcome are on its own entry, durably, and that the outcome
   * follows from whether the run ever announced itself rather than from anything read later.
   */
  it("records each run's own outcome and end time", () => {
    const stateDir = stateDirectory();
    recordDaemonStart(stateDir, newDaemonStart("run-a", "2026-09-06T00:00:00.000Z"));
    recordDaemonEnd(stateDir, "run-a", "2026-09-06T00:00:01.500Z");
    recordDaemonStart(stateDir, newDaemonStart("run-b", "2026-09-06T00:01:00.000Z"));
    markDaemonReady(stateDir, "run-b", "2026-09-06T00:01:01.000Z");
    recordDaemonEnd(stateDir, "run-b", "2026-09-08T09:00:00.000Z");

    const [failed, stopped] = readDaemonState(stateDir).recentStarts;

    expect(failed?.outcome).toBe("failed");
    expect(failed?.ended_at).toBe("2026-09-06T00:00:01.500Z");
    expect(failed?.started_at).toBe("2026-09-06T00:00:00.000Z");
    // The run that announced itself two days before it stopped is a `stopped`, not a failed start,
    // and the breaker resets on it whichever way the arithmetic would have gone.
    expect(stopped?.outcome).toBe("stopped");
    expect(stopped?.ended_at).toBe("2026-09-08T09:00:00.000Z");
    expect(readDaemonState(stateDir).recentStarts).toEqual(
      JSON.parse(readFileSync(stateDirLayout(stateDir).daemonState, "utf8")).recentStarts,
    );
  });

  it("keeps the first end a run recorded, not the last", () => {
    const stateDir = stateDirectory();
    recordDaemonStart(stateDir, newDaemonStart("run-a", "2026-09-06T00:00:00.000Z"));

    recordDaemonEnd(stateDir, "run-a", "2026-09-06T00:00:01.000Z");
    recordDaemonEnd(stateDir, "run-a", "2026-09-06T00:00:09.000Z");

    expect(readDaemonState(stateDir).recentStarts[0]?.ended_at).toBe("2026-09-06T00:00:01.000Z");
  });

  /**
   * The identity tuple, on the start record, because the case that needs it writes no `runtime.json`.
   *
   * `writeRuntimeState` is reached only from `markReady`, so a run that dies before readiness never
   * writes one — and a later start deciding whether that run is "provably gone" has nothing else to
   * read. The two probed members are `null` on a platform that cannot answer, and `startIdentity`
   * is what puts them back together with the pid.
   */
  it("persists this run's identity tuple with its start record", () => {
    const stateDir = stateDirectory();
    recordDaemonStart(stateDir, newDaemonStart("run-a", "2026-09-06T00:00:00.000Z"));

    const [entry] = readDaemonState(stateDir).recentStarts;

    expect(entry?.pid).toBe(process.pid);
    expect(entry?.start_time).toBe(selfIdentity().start_time);
    expect(entry?.boot_id).toBe(selfIdentity().boot_id);
    if (process.platform === "darwin" || process.platform === "linux") {
      expect(entry?.start_time).not.toBeNull();
      expect(entry?.boot_id).not.toBeNull();
    }
    // Alive, and itself: the one verdict that is neither `gone` nor `stranger`.
    expect(entry === undefined ? true : startIsProvablyGone(entry)).toBe(false);
  });

  /**
   * A history written by a release that had none of these fields.
   *
   * They read back as `null` rather than as absent, which is what puts such an entry under D6's
   * unknown rule instead of under an `undefined` the breaker would have to branch on.
   */
  it("reads a record written before outcomes and identities existed", () => {
    const stateDir = stateDirectory();
    writeFileSync(
      stateDirLayout(stateDir).daemonState,
      JSON.stringify({
        recentStarts: [
          { started_at: "2026-09-06T00:00:00.000Z", pid: 4242, run_id: "old", ready_at: null },
        ],
      }),
    );

    expect(readDaemonState(stateDir).recentStarts).toEqual([
      {
        started_at: "2026-09-06T00:00:00.000Z",
        pid: 4242,
        run_id: "old",
        ready_at: null,
        outcome: null,
        ended_at: null,
        start_time: null,
        boot_id: null,
      },
    ]);
  });

  it("stamps ready_at on the run that announced itself, and only that one", () => {
    const stateDir = stateDirectory();
    recordDaemonStart(stateDir, newDaemonStart("run-a", "2026-09-06T00:00:00.000Z"));
    recordDaemonStart(stateDir, newDaemonStart("run-b", "2026-09-06T00:00:10.000Z"));

    markDaemonReady(stateDir, "run-b", "2026-09-06T00:00:11.000Z");

    const history = readDaemonState(stateDir).recentStarts;
    expect(history[0]?.ready_at).toBeNull();
    expect(history[1]?.ready_at).toBe("2026-09-06T00:00:11.000Z");
  });
});

describe("isStalled", () => {
  const fiveFastFailures = Array.from({ length: STALL_AFTER_FAILED_STARTS }, (_, index) =>
    failedStart(base + index * 1_000, index),
  );

  it("is silent until there are enough starts to judge", () => {
    expect(isStalled(fiveFastFailures.slice(1), base + 6_000)).toBeNull();
  });

  it("trips when every one of the last starts failed before it was ready, and failed fast", () => {
    const stall = isStalled(fiveFastFailures, base + 6_000);

    expect(stall).not.toBeNull();
    expect(stall?.reason).toContain(`${STALL_AFTER_FAILED_STARTS} starts`);
    expect(stall?.reason).toContain("xplainer daemon restart");
  });

  it("does not trip when one of them reached ready", () => {
    const withOneGoodStart = [...fiveFastFailures];
    withOneGoodStart[2] = { ...failedStart(base + 2_000, 2), ready_at: "2026-09-06T00:00:03.000Z" };

    expect(isStalled(withOneGoodStart, base + 6_000)).toBeNull();
  });

  /**
   * The defect T14 removes, as an assertion.
   *
   * Phase 1 inferred a run's end from the **next** run's start, so a supervisor whose retry cadence
   * is wider than the 30-second window could never trip the breaker: launchd throttles at 30 s and
   * Task Scheduler's `<RestartOnFailure>` has a one-minute schema minimum. Each of these five runs
   * recorded its own end two seconds in, and they are spaced two minutes apart.
   */
  it("trips on five fast failures however far apart the supervisor spaced them", () => {
    const spacedOut = Array.from({ length: STALL_AFTER_FAILED_STARTS }, (_, index) =>
      failedStart(base + index * 120_000, index, 2_000),
    );

    expect(isStalled(spacedOut, base + 600_000)).not.toBeNull();
  });

  /**
   * The same boundary as the unknown case below, on the path that records its own end: a run that
   * died at exactly 30,000 ms counts and one that took a millisecond longer does not.
   */
  it("counts a recorded end at exactly 30,000 ms and not at 30,001", () => {
    const lasting = (livedMs: number): DaemonStart[] =>
      Array.from({ length: STALL_AFTER_FAILED_STARTS }, (_, index) =>
        failedStart(base + index * 120_000, index, livedMs),
      );

    expect(isStalled(lasting(FAILED_START_WINDOW_MS), base + 600_000)).not.toBeNull();
    expect(isStalled(lasting(FAILED_START_WINDOW_MS + 1), base + 600_000)).toBeNull();
  });

  /**
   * D6's boundary, measured rather than assumed, on the one path where the spacing between two
   * starts is still what bounds a death: a run that recorded nothing.
   *
   * 30,000 ms is exactly launchd's `ThrottleInterval`, so "the breaker never latches under launchd"
   * would have overstated it — it latches at the boundary and not above it.
   */
  it("counts unknown starts at exactly 30,000 ms spacing and not at 30,001", () => {
    const spacing = (gap: number): DaemonStart[] =>
      Array.from({ length: STALL_AFTER_FAILED_STARTS }, (_, index) =>
        unknownStart(base + index * gap, index),
      );

    const atTheBoundary = spacing(FAILED_START_WINDOW_MS);
    const oneMillisecondOver = spacing(FAILED_START_WINDOW_MS + 1);

    expect(
      isStalled(atTheBoundary, base + STALL_AFTER_FAILED_STARTS * FAILED_START_WINDOW_MS, wasGone),
    ).not.toBeNull();
    expect(
      isStalled(
        oneMillisecondOver,
        base + STALL_AFTER_FAILED_STARTS * (FAILED_START_WINDOW_MS + 1),
        wasGone,
      ),
    ).toBeNull();
  });

  /**
   * The `SIGKILL`ed run, with the verdict taken from a real dead process rather than a stub.
   *
   * Four runs that recorded their own failures and a fifth that recorded nothing at all, whose
   * successor — the start being decided, at `nowMs` — began ten seconds later.
   */
  it("counts an unknown start whose successor began inside the window", () => {
    const killed = onThisBoot(deadPid());
    const history = [...fiveFastFailures.slice(0, 4), killed];

    // Gone by the probe itself, and not by the shortcut a foreign boot id would have taken.
    expect(killed.boot_id).toBe(selfIdentity().boot_id);
    expect(startIsProvablyGone(killed)).toBe(true);
    expect(isStalled(history, base + 14_000)).not.toBeNull();
  });

  it("resets the streak when that same start's successor arrives after the window", () => {
    const history = [...fiveFastFailures.slice(0, 4), onThisBoot(deadPid())];

    expect(isStalled(history, base + 4_000 + FAILED_START_WINDOW_MS + 1)).toBeNull();
  });

  /**
   * The run that answered for a week and was killed at the end of it.
   *
   * `ready_at` is set, so it did not fail to *start*, and no bound on when it died is relevant.
   */
  it("resets when a start reached readiness and was killed much later", () => {
    const ranForAWeek: DaemonStart = {
      ...unknownStart(base + 4_000, 4),
      ready_at: new Date(base + 5_000).toISOString(),
    };
    const history = [...fiveFastFailures.slice(0, 4), ranForAWeek];

    expect(isStalled(history, base + 4_000 + 7 * 24 * 3_600_000)).toBeNull();
  });

  /**
   * The clock stepping backwards between two starts, which is why the interval is validated.
   *
   * A negative difference is timing uncertain and resets; so is one that cannot be computed at all,
   * which is what an unparseable timestamp produces. The residual §1.3b D6 states — a backward
   * adjustment that leaves a *finite* interval under 30 s — is indistinguishable from a genuine
   * fast failure and is not asserted here, because it is not detected.
   */
  it("resets on a negative interval, and on one that is not a number", () => {
    const backwards = [
      ...fiveFastFailures.slice(0, 4),
      unknownStart(base + 4_000, 4),
      unknownStart(base + 4_000 - 3_600_000, 5),
    ].slice(-STALL_AFTER_FAILED_STARTS);
    const unparseable = [
      ...fiveFastFailures.slice(0, 4),
      { ...unknownStart(base + 4_000, 4), started_at: "the seventh of never" },
    ];

    expect(isStalled(backwards, base + 4_000, wasGone)).toBeNull();
    expect(isStalled(unparseable, base + 5_000, wasGone)).toBeNull();
  });

  /**
   * "Provably gone" is a real probe, and this process is the case it has to refuse.
   *
   * `newDaemonStart()` records this process's own identity tuple, and this process is alive and is
   * itself — `ours`, not `gone` and not `stranger` — so the streak resets rather than counting a
   * run that has not ended.
   */
  it("resets when an unknown start's process cannot be shown to be gone", () => {
    const stillHere = newDaemonStart("run-4", new Date(base + 4_000).toISOString());
    const history = [...fiveFastFailures.slice(0, 4), stillHere];

    expect(startIsProvablyGone(stillHere)).toBe(false);
    expect(isStalled(history, base + 14_000)).toBeNull();
  });
});
