/**
 * The six steps between a signal and exit `0`, in their order.
 *
 * The *signal* is proved where it can only be proved — against a real `serve` in
 * `commands/serve.test.ts`, which sends a real `SIGTERM` and watches a real process group die. What
 * is proved here is the part a signal cannot show you: that the steps happen in ADR 0024 §Drain on
 * planned restart's order, that a second signal during a drain is ignored rather than obeyed, and
 * that `runtime.json` and the socket are gone before the exit code is chosen. Registration is
 * asserted by counting `process`'s own listeners, which is the only honest way to say "this daemon
 * would answer a `SIGTERM`" without sending one to the test runner.
 *
 * The last suite is the one place the drain meets a **real** render: a real job runner, the real
 * render worker, a real headless shell and a real ffmpeg, stopped part-way by the same sequence a
 * `SIGTERM` starts. What it asserts is what a user would find afterwards — no browser from the job
 * still running, no `explainer.mp4`, no partial file, no bundle directory — because a drain that
 * only *reported* stopping a render is the failure ADR 0024 §Drain exists to prevent.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { videoPaths } from "@xplainer/render-core";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalBackend } from "../backend.js";
import { testChrome } from "../render/testing/chrome.js";
import { CHROME_PROVIDER } from "../setup/providers/chrome.js";
import { recordTestToolchain } from "../setup/testing/toolchain.js";
import { TTS_FIXTURE_ENV } from "../workers/speech.js";
import { writeNarrationFixture } from "../workers/testing/narration-fixture.js";
import { writeRuntimeState } from "./daemon-state.js";
import { DAEMON_INTERNAL_EXIT_CODE } from "./exit-codes.js";
import { createJobStore } from "./job-store.js";
import { createJobRunner, DEFAULT_DRAIN_TIMEOUT_MS } from "./runner.js";
import {
  CLEAN_SHUTDOWN_EXIT_CODE,
  installShutdownHandlers,
  SHUTDOWN_SIGNALS,
  type ShutdownHandle,
} from "./shutdown.js";
import { stateDirLayout } from "./state-dir.js";
import { selfIdentity } from "./worker-identity.js";
import { createWorkerRegistry } from "./workers.js";

const scratch: string[] = [];
const handles: ShutdownHandle[] = [];

function stateDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "xplainer-shutdown-"));
  scratch.push(dir);
  writeRuntimeState(dir, {
    pid: process.pid,
    run_id: "run-1",
    boot_id: null,
    port: 8787,
    addresses: ["http://127.0.0.1:8787"],
    socket: null,
    started_at: "2026-09-06T00:00:00.000Z",
  });
  return dir;
}

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.dispose();
  }
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Install the handlers over recorders, and keep the handle for teardown. */
function install(options: {
  stateDir: string;
  steps: string[];
  exits: number[];
  socketPath?: string | null;
  drainTimeoutMs?: number;
  drain?: (timeoutMs: number) => Promise<void>;
}): ShutdownHandle {
  const { steps, exits } = options;
  const handle = installShutdownHandlers({
    stateDir: options.stateDir,
    drain:
      options.drain ??
      (async (timeoutMs) => {
        steps.push(`drain(${timeoutMs})`);
      }),
    listeners: [
      {
        close: async () => {
          steps.push("close tcp");
        },
      },
      {
        close: async () => {
          steps.push("close ipc");
        },
      },
    ],
    ...(options.socketPath === undefined ? {} : { socketPath: options.socketPath }),
    ...(options.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: options.drainTimeoutMs }),
    log: (line) => {
      steps.push(`log: ${line}`);
    },
    exit: (code) => {
      exits.push(code);
    },
  });
  handles.push(handle);
  return handle;
}

describe("installShutdownHandlers", () => {
  it("drains, then closes every listener, then removes runtime.json, then exits 0", async () => {
    const stateDir = stateDirectory();
    const steps: string[] = [];
    const exits: number[] = [];
    const handle = install({ stateDir, steps, exits });

    await handle.shutdown("SIGTERM");

    expect(steps.filter((step) => !step.startsWith("log: "))).toEqual([
      `drain(${DEFAULT_DRAIN_TIMEOUT_MS})`,
      "close tcp",
      "close ipc",
    ]);
    expect(existsSync(stateDirLayout(stateDir).runtimeState)).toBe(false);
    expect(exits).toEqual([CLEAN_SHUTDOWN_EXIT_CODE]);
  });

  /** ADR 0024 step 2: twenty seconds, and twenty seconds plus teardown is P1-7's whole budget. */
  it("gives the drain ADR 0024's twenty seconds unless told otherwise", async () => {
    const steps: string[] = [];
    const handle = install({ stateDir: stateDirectory(), steps, exits: [], drainTimeoutMs: 500 });

    await handle.shutdown("SIGTERM");

    expect(steps).toContain("drain(500)");
    expect(DEFAULT_DRAIN_TIMEOUT_MS).toBe(20_000);
  });

  it("removes the socket it made, and does not mind one that is already gone", async () => {
    const stateDir = stateDirectory();
    const socketPath = join(stateDir, "xplainer.sock");
    writeFileSync(socketPath, "");

    await install({ stateDir, steps: [], exits: [], socketPath }).shutdown("SIGTERM");
    expect(existsSync(socketPath)).toBe(false);

    const second = stateDirectory();
    const exits: number[] = [];
    await install({
      stateDir: second,
      steps: [],
      exits,
      socketPath: join(second, "never-created.sock"),
    }).shutdown("SIGTERM");
    expect(exits).toEqual([CLEAN_SHUTDOWN_EXIT_CODE]);
  });

  /**
   * An impatient supervisor sends `SIGTERM` twice. Restarting the sequence from the top would mean
   * step 3 killing what step 2 is still waiting for, so the second one is a logged no-op.
   */
  it("ignores a second signal that arrives mid-drain", async () => {
    const stateDir = stateDirectory();
    const steps: string[] = [];
    const exits: number[] = [];
    let releaseDrain = (): void => {};
    const drainStarted = new Promise<void>((started) => {
      releaseDrain = started;
    });
    let finishDrain = (): void => {};
    const drainFinished = new Promise<void>((done) => {
      finishDrain = done;
    });

    const handle = install({
      stateDir,
      steps,
      exits,
      drain: async () => {
        steps.push("drain");
        releaseDrain();
        await drainFinished;
      },
    });

    const first = handle.shutdown("SIGTERM");
    await drainStarted;
    await handle.shutdown("SIGTERM");
    finishDrain();
    await first;

    expect(steps.filter((step) => step === "drain")).toHaveLength(1);
    expect(steps.join("\n")).toContain("already shutting down");
    expect(exits).toEqual([CLEAN_SHUTDOWN_EXIT_CODE]);
  });

  /**
   * The drain writes records, and `durable-write.ts`'s `renameSync` can fail on a full or
   * read-only disk. Before this was guarded the rejection escaped: the listeners stayed open, the
   * socket file and `runtime.json` stayed on disk, nothing called `exit`, and a second `SIGTERM`
   * met the "already shutting down" guard and was logged as ignored — so the daemon hung until a
   * supervisor killed it. The sequence must finish; only the code changes.
   */
  it("finishes the teardown and exits 70 when the drain rejects", async () => {
    const stateDir = stateDirectory();
    const socketPath = join(stateDir, "xplainer.sock");
    writeFileSync(socketPath, "");
    const steps: string[] = [];
    const exits: number[] = [];
    const handle = install({
      stateDir,
      steps,
      exits,
      socketPath,
      drain: async () => {
        steps.push("drain");
        throw new Error("ENOSPC: no space left on device, rename job-000001.json");
      },
    });

    await expect(handle.shutdown("SIGTERM")).resolves.toBeUndefined();

    expect(steps.filter((step) => !step.startsWith("log: "))).toEqual([
      "drain",
      "close tcp",
      "close ipc",
    ]);
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(stateDirLayout(stateDir).runtimeState)).toBe(false);
    expect(exits).toEqual([DAEMON_INTERNAL_EXIT_CODE]);
    expect(steps.join("\n")).toContain("ENOSPC");
  });

  /** A listener that will not close is the same shape, and must not strand the process either. */
  it("still removes runtime.json and exits 70 when a listener close rejects", async () => {
    const stateDir = stateDirectory();
    const exits: number[] = [];
    const handle = installShutdownHandlers({
      stateDir,
      drain: async () => {},
      listeners: [
        {
          close: async () => {
            throw new Error("EBADF: bad file descriptor, close");
          },
        },
      ],
      exit: (code) => {
        exits.push(code);
      },
    });
    handles.push(handle);

    await handle.shutdown("SIGTERM");

    expect(existsSync(stateDirLayout(stateDir).runtimeState)).toBe(false);
    expect(exits).toEqual([DAEMON_INTERNAL_EXIT_CODE]);
  });

  it("registers a handler for SIGTERM and SIGINT, and removes both on dispose", () => {
    const before = SHUTDOWN_SIGNALS.map((signal) => process.listenerCount(signal));

    const handle = install({ stateDir: stateDirectory(), steps: [], exits: [] });
    const during = SHUTDOWN_SIGNALS.map((signal) => process.listenerCount(signal));
    handle.dispose();
    const after = SHUTDOWN_SIGNALS.map((signal) => process.listenerCount(signal));

    expect(during).toEqual(before.map((count) => count + 1));
    expect(after).toEqual(before);
    expect([...SHUTDOWN_SIGNALS]).toEqual(["SIGTERM", "SIGINT"]);
  });
});

/** Every running process whose command line mentions `needle`, as `ps` prints them. */
function processesMentioning(needle: string): string[] {
  return execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes(needle));
}

/** The process group `pid` is in. */
function groupOf(pid: number): number {
  return Number(
    execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim(),
  );
}

/**
 * Every live process in group `pgid`, as `ps` prints them: the worker, Chrome and each helper it
 * started, and ffmpeg. A zombie is already dead and only waiting to be reaped, so it is not one.
 */
function processesInGroup(pgid: number): string[] {
  return execFileSync("ps", ["-A", "-o", "pid=,pgid=,stat=,command="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([, group, stat]) => Number(group) === pgid && stat?.startsWith("Z") !== true)
    .map((fields) => fields.join(" "));
}

/** Whether `pid` is still a process this user can signal. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A real browser and a real ffmpeg, so the render test's switch; CI never sets it.
describe.skipIf(process.env.XPLAINER_SKIP_RENDER_TEST === "1")(
  "a SIGTERM drain during a real render",
  () => {
    it("stops the job's Chrome and ffmpeg and leaves no MP4, no partial and no bundle", async () => {
      const root = mkdtempSync(join(tmpdir(), "xplainer-drain-render-"));
      const fixtures = mkdtempSync(join(tmpdir(), "xplainer-drain-fixture-"));
      scratch.push(root, fixtures);
      const stateDir = stateDirectory();
      const chrome = await testChrome();
      recordTestToolchain({
        stateDir,
        workspaceRoot: root,
        overrides: {
          chrome: {
            version: chrome.version,
            path: chrome.path,
            sha256: chrome.sha256,
            provider: CHROME_PROVIDER,
          },
        },
      });
      // Six seconds of narration: long enough that the render is still capturing when the drain
      // gives up on it, short enough that the narration itself is quick.
      const narration = writeNarrationFixture(fixtures, [
        {
          id: "long",
          text: "A render long enough to be interrupted.",
          seconds: 6,
          frequency: 262,
          words: ["A", "render", "long", "enough", "to", "be", "interrupted."].map(
            (word, index) => ({
              word,
              start_time: 0.1 + index * 0.8,
              end_time: 0.7 + index * 0.8,
            }),
          ),
        },
      ]);
      process.env[TTS_FIXTURE_ENV] = fixtures;
      const runner = createJobRunner({
        store: createJobStore(stateDir),
        owner: { ...selfIdentity(), run_id: "drain-render-test" },
        workers: createWorkerRegistry({ root, stateDir }),
      });
      const backend = createLocalBackend({ runner, root, stateDir });

      try {
        await backend.explainer_create({ slug: "demo" });
        const narrated = (await backend.explainer_narrate({ slug: "demo", narration })).job_id;
        for (
          let state = runner.get({ job_id: narrated });
          state.status !== "done";
          state = runner.get({ job_id: narrated })
        ) {
          expect(state.status, state.output.lines.join("\n")).not.toBe("error");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        const { job_id } = await backend.explainer_render({ slug: "demo" });
        // Wait for the first progress line: Chrome and ffmpeg are both running from then on.
        let lines: string[] = [];
        while (!lines.some((line) => line.includes('"event":"progress"'))) {
          const state = runner.get({ job_id, output_lines: 200 });
          expect(state.status, state.output.lines.join("\n")).not.toMatch(/done|error/);
          lines = state.output.lines;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const started = /chrome (\d+) started with profile (\S+)/.exec(lines.join("\n"));
        expect(started, lines.join("\n")).not.toBeNull();
        const chromePid = Number(started?.[1]);
        const profile = started?.[2] ?? "";
        expect(alive(chromePid)).toBe(true);
        expect(processesMentioning(profile).length).toBeGreaterThan(0);
        // The group the runner made the worker lead. Chrome, every helper Chrome started — none
        // of which carries the profile in its argv — and ffmpeg are all in it.
        const jobGroup = groupOf(chromePid);
        expect(processesInGroup(jobGroup).length).toBeGreaterThan(3);

        const exits: number[] = [];
        const handle = installShutdownHandlers({
          stateDir,
          drain: (timeoutMs) => runner.drain(timeoutMs),
          listeners: [],
          // Far shorter than the render, so the drain has to stop it rather than wait it out.
          drainTimeoutMs: 100,
          exit: (code) => {
            exits.push(code);
          },
        });
        handles.push(handle);
        await handle.shutdown("SIGTERM");

        expect(exits).toEqual([CLEAN_SHUTDOWN_EXIT_CODE]);
        const record = runner.get({ job_id, output_lines: 200 });
        expect(record.status).toBe("error");
        expect(record.error_code).toBe("daemon_shutdown");
        // The worker cleaned up after itself on the SIGTERM, rather than being killed mid-write.
        expect(record.output.lines.join("\n")).toContain(
          "RENDER_CANCELLED: the worker received SIGTERM",
        );

        // Chrome is gone — the browser's pid, and every process the job's group held.
        const deadline = Date.now() + 5_000;
        while (
          (alive(chromePid) || processesInGroup(jobGroup).length > 0) &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(alive(chromePid)).toBe(false);
        expect(processesMentioning(profile)).toEqual([]);
        expect(processesInGroup(jobGroup)).toEqual([]);
        expect(existsSync(profile)).toBe(false);

        // And nothing was written: no MP4, no partial, no bundle directory.
        const video = videoPaths(root, "demo");
        expect(existsSync(video.mp4)).toBe(false);
        expect(readdirSync(video.out)).toEqual([]);
      } finally {
        delete process.env[TTS_FIXTURE_ENV];
        await runner.drain(0);
      }
    }, 180_000);
  },
);
