/**
 * The two state files, and the breaker that had to move between them.
 *
 * ADR 0020 §Restart on crash put `recentStarts[]` and `stalled` in `runtime.json`; its own note of
 * 2026-09-06 records why that was wrong, and ADR 0024 §Consequences moves them to the durable
 * directory. The placement assertion below is the one that keeps the move made: it reads both files
 * and requires the crash history to be in the one that survives a stop.
 */

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
  recordDaemonStart,
  recordStall,
  STALL_AFTER_FAILED_STARTS,
  StateFileUnreadableError,
  updateDaemonState,
  writeRuntimeState,
} from "./daemon-state.js";
import { ensureStateDirectory } from "./durable-write.js";
import { STATE_UNREADABLE_EXIT_CODE } from "./exit-codes.js";
import { stateDirLayout } from "./state-dir.js";

const scratch: string[] = [];

function stateDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "xplainer-state-"));
  ensureStateDirectory(dir);
  scratch.push(dir);
  return dir;
}

/** A run that started at `atMs` and never announced itself. */
function failedStart(atMs: number, index: number): DaemonStart {
  return {
    started_at: new Date(atMs).toISOString(),
    pid: 100 + index,
    run_id: `run-${index}`,
    ready_at: null,
  };
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
      directory_flush: null,
      supervisor_kind: null,
      supervisor_artefact: null,
      runtime_dir: null,
      launch_spec: null,
      program_source: null,
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
        launch_spec: { executable: "/bin/node", argv: ["serve"], cwd: "/state" },
      }),
    );

    const state = readDaemonState(stateDir);

    expect(state.supervisor_kind).toBeNull();
    expect(state.program_source).toBeNull();
    expect(state.linger_enabled_by_us).toBeNull();
    expect(state.launch_spec).toBeNull();
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
  const base = Date.parse("2026-09-06T00:00:00.000Z");
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

  it("does not trip on failures spread out over hours, which is not a crash loop", () => {
    const slow = Array.from({ length: STALL_AFTER_FAILED_STARTS }, (_, index) =>
      failedStart(base + index * (FAILED_START_WINDOW_MS * 10), index),
    );

    expect(isStalled(slow, base + FAILED_START_WINDOW_MS * 100)).toBeNull();
  });
});
