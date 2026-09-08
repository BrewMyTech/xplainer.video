/**
 * The control channel, against real daemons and real sockets.
 *
 * Three things are asserted here and each one is a property of a **process** rather than of a
 * function, which is why nothing in this file is stubbed:
 *
 * - **The drain client** dials a real spawned `serve` over the socket that daemon really bound, and
 *   the acknowledgement is compared with the ready line the same process wrote — the pid in one has
 *   to be the pid in the other, or a caller would be waiting for something else to exit.
 * - **The wait** then watches that pid go and `runtime.json` with it, which is ADR 0024's step 6
 *   and the only evidence of a completed drain an outside observer can have.
 * - **The latch** is proved by the daemon that refuses to start while it is set and starts once it
 *   is cleared. A test that only read `daemon.json` back would assert that a write happened, not
 *   that it was the write `xplainer daemon restart` needs to make.
 *
 * The two refusals — nothing listening, and something listening that has no such route — are real
 * sockets too: an absent path, and a plain `node:http` server that answers `404`. The second is a
 * *foreign* server on purpose, because "a daemon older than this route" is exactly a server that is
 * not this one.
 */

import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { DRAIN_PATH } from "../server.js";
import { awaitStopped, clearStartLatch, requestDrain } from "./control.js";
import { readDaemonState, updateDaemonState } from "./daemon-state.js";
import { waitForReadyLine } from "./ready.js";
import { CHILD_SERVE, type SpawnedChild, spawnEntry, untilGone } from "./testing/spawn-child.js";

const scratch: string[] = [];
const children: ChildProcess[] = [];
const listeners: Server[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  for (const listener of listeners.splice(0)) {
    await new Promise<void>((closed) => {
      listener.close(() => {
        closed();
      });
    });
  }
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function stateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "xplainer-control-"));
  scratch.push(directory);
  return directory;
}

/** A real `xplainer serve`, run from this package's sources, waited for by its ready line. */
async function serveUntilReady(
  stateDir: string,
): Promise<{ child: SpawnedChild; socket: string; pid: number }> {
  const child = spawnEntry(CHILD_SERVE, ["--port", "0"], { XPLAINER_STATE_DIR: stateDir });
  children.push(child.process);
  const ready = await waitForReadyLine(child.process, { timeoutMs: 20_000 });
  return { child, socket: ready.socket ?? "", pid: ready.pid };
}

describe("requestDrain", () => {
  it("drains a real daemon over its socket, and the wait sees the pid and runtime.json go", async () => {
    const stateDir = stateDirectory();
    const daemon = await serveUntilReady(stateDir);
    expect(existsSync(join(stateDir, "runtime.json"))).toBe(true);

    const asked = await requestDrain({ socketPath: daemon.socket });

    expect(asked.ok).toBe(true);
    if (!asked.ok) {
      return;
    }
    // The pid the caller is told to watch is the pid the daemon announced it was.
    expect(asked.acknowledgement.pid).toBe(daemon.pid);
    expect(asked.acknowledgement.already_draining).toBe(false);
    expect(asked.acknowledgement.timeout_ms).toBeGreaterThan(0);

    const stopped = await awaitStopped({
      stateDir,
      pid: asked.acknowledgement.pid,
      timeoutMs: 25_000,
    });

    expect(stopped.stopped).toBe(true);
    expect(stopped.runtimeRecordRemoved).toBe(true);
    expect((await daemon.child.waitForExit()).code).toBe(0);
    expect(existsSync(daemon.socket)).toBe(false);
  }, 40_000);

  it("reports a socket nothing is listening on as not-listening", async () => {
    const socketPath = join(stateDirectory(), "nothing.sock");

    const asked = await requestDrain({ socketPath });

    expect(asked).toMatchObject({ ok: false, reason: "not-listening" });
  });

  /** A daemon from a release that predates the route: it answers, and it answers 404. */
  it("reports a listener with no such route as no-route, naming the supervisor as the way out", async () => {
    const socketPath = join(stateDirectory(), "old.sock");
    const listener = createServer((_request, response) => {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("404 Not Found");
    });
    listeners.push(listener);
    await new Promise<void>((bound) => {
      listener.listen(socketPath, () => {
        bound();
      });
    });

    const asked = await requestDrain({ socketPath });

    expect(asked.ok).toBe(false);
    if (asked.ok) {
      return;
    }
    expect(asked.reason).toBe("no-route");
    expect(asked.detail).toContain(DRAIN_PATH);
    expect(asked.detail).toContain("supervisor");
  });
});

describe("awaitStopped", () => {
  it("does not report a process that is still running as stopped", async () => {
    const stateDir = stateDirectory();

    const waited = await awaitStopped({
      stateDir,
      pid: process.pid,
      timeoutMs: 150,
      intervalMs: 20,
    });

    // This very process, so "alive" is not in doubt. `runtime.json` was never written here, which
    // is why both halves are reported rather than one standing in for the other.
    expect(waited.stopped).toBe(false);
    expect(waited.runtimeRecordRemoved).toBe(true);
  });
});

describe("clearStartLatch", () => {
  /**
   * The latch is what `serve` refuses to start against, so the proof is two real starts of the same
   * daemon in the same directory: one that will not run, and one that does.
   */
  it("is the difference between a serve that refuses to start and one that does", async () => {
    const stateDir = stateDirectory();
    updateDaemonState(stateDir, {
      stalled: { at: new Date().toISOString(), reason: "five failed starts, in this test" },
      recentStarts: [
        {
          started_at: new Date().toISOString(),
          pid: 1,
          run_id: "a",
          ready_at: null,
          outcome: "failed",
          ended_at: new Date().toISOString(),
          start_time: null,
          boot_id: null,
        },
      ],
    });

    const refused = spawnEntry(CHILD_SERVE, ["--port", "0"], { XPLAINER_STATE_DIR: stateDir });
    children.push(refused.process);
    const exit = await refused.waitForExit();

    // Exit `0` is the portable "do not restart" signal, and the daemon never bound.
    expect(exit.code).toBe(0);
    expect(refused.stderr()).toContain("stalled");
    expect(refused.stdout()).toBe("");

    const cleared = clearStartLatch(stateDir);

    expect(cleared.stalled?.reason).toContain("five failed starts");
    expect(cleared.startsCleared).toBe(1);
    expect(readDaemonState(stateDir).stalled).toBeNull();
    // Both fields, because `isStalled()` re-latches from the history alone.
    expect(readDaemonState(stateDir).recentStarts).toEqual([]);

    const started = await serveUntilReady(stateDir);
    expect(started.pid).toBeGreaterThan(0);
    started.child.process.kill("SIGTERM");
    expect(await untilGone(started.pid)).toBe(true);
  }, 40_000);

  it("reports nothing cleared for a daemon that never latched", () => {
    const stateDir = stateDirectory();

    expect(clearStartLatch(stateDir)).toEqual({ stalled: null, startsCleared: 0 });
  });
});
