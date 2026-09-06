/**
 * The five states a video lock file can be found in, and what each one means.
 *
 * The classifier is `daemon/lock.ts`'s, already measured by `spikes/p1-s1-ownership.mjs` against
 * real processes, so what is asserted here is what this module adds on top of it: where the file
 * lives, that a live holder refuses, that a dead one is taken over, that the release is guarded by
 * the nonce, and that two videos never contend. A "second process" is a lock file naming a pid the
 * classifier will call alive — spike scenario `[E]` — which is the one input that means "held".
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireVideoWriteLock,
  VIDEO_LOCK_FORMAT_VERSION,
  VIDEO_LOCKS_DIR,
  VideoBusyError,
  videoLockPath,
} from "./video-lock.js";
import { selfIdentity } from "./worker-identity.js";

const roots: string[] = [];
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xplainer-video-lock-"));
  roots.push(root);
});

afterEach(() => {
  for (const directory of roots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Write a lock file naming `pid`, with whatever start token the caller wants recorded. */
function plant(slug: string, holder: { pid: number; start_time: string | null }): string {
  const path = videoLockPath(root, slug);
  mkdirSync(join(root, VIDEO_LOCKS_DIR), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      format_version: VIDEO_LOCK_FORMAT_VERSION,
      ...holder,
      boot_id: null,
      boot_nonce: "planted",
      hostname: "elsewhere",
      acquired_at: "2026-09-07T00:00:00.000Z",
      slug,
      job_type: "explainer_render",
      job_id: 99,
    }),
  );
  return path;
}

describe("acquireVideoWriteLock", () => {
  it("writes the holder into <root>/locks/<slug>.lock and gives it back on release", () => {
    const lock = acquireVideoWriteLock({
      root,
      slug: "demo",
      jobType: "explainer_render",
      jobId: 7,
    });

    expect(lock.path).toBe(join(root, VIDEO_LOCKS_DIR, "demo.lock"));
    const written = JSON.parse(readFileSync(lock.path, "utf8"));
    expect(written).toMatchObject({
      format_version: VIDEO_LOCK_FORMAT_VERSION,
      pid: process.pid,
      slug: "demo",
      job_type: "explainer_render",
      job_id: 7,
    });

    lock.release();
    expect(existsSync(lock.path)).toBe(false);
    // Idempotent: the runner releases on the terminal write, and a caller may release again.
    expect(() => {
      lock.release();
    }).not.toThrow();
  });

  it("refuses while a live process holds it, naming why", () => {
    plant("demo", selfIdentity());

    expect(() =>
      acquireVideoWriteLock({ root, slug: "demo", jobType: "explainer_render", jobId: 1 }),
    ).toThrow(VideoBusyError);
    expect(() =>
      acquireVideoWriteLock({ root, slug: "demo", jobType: "explainer_render", jobId: 1 }),
    ).toThrow(/is being written by another process/);
  });

  /** A daemon that was SIGKILLed mid-render leaves this behind; the next run must not be stuck. */
  it("takes over a lock whose holder is gone", () => {
    const path = plant("demo", { pid: 0x7fffffff, start_time: "Thu Jan  1 00:00:00 1970" });

    const lock = acquireVideoWriteLock({
      root,
      slug: "demo",
      jobType: "explainer_render",
      jobId: 2,
    });

    expect(lock.path).toBe(path);
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(process.pid);
  });

  /** Pid reuse: alive, but not the process that was recorded (spike scenario `[D]`). */
  it("takes over a lock whose pid is alive but is a different process", () => {
    plant("demo", { pid: process.pid, start_time: "Thu Jan  1 00:00:00 1970" });

    expect(() =>
      acquireVideoWriteLock({ root, slug: "demo", jobType: "explainer_render", jobId: 3 }),
    ).not.toThrow();
  });

  it("keeps two videos apart, so two agents on two explainers never contend", () => {
    const first = acquireVideoWriteLock({
      root,
      slug: "one",
      jobType: "explainer_render",
      jobId: 1,
    });
    const second = acquireVideoWriteLock({
      root,
      slug: "two",
      jobType: "explainer_narrate",
      jobId: 2,
    });

    expect(first.path).not.toBe(second.path);
    expect(existsSync(first.path)).toBe(true);
    expect(existsSync(second.path)).toBe(true);
  });

  /**
   * The release is nonce-guarded for the same reason `releaseOwnership` is: a holder that was
   * declared stale and taken over must not unlink its *successor's* file on the way out.
   */
  it("does not delete a lock that has since been taken over by someone else", () => {
    const mine = acquireVideoWriteLock({
      root,
      slug: "demo",
      jobType: "explainer_render",
      jobId: 4,
    });
    plant("demo", selfIdentity());

    mine.release();

    expect(existsSync(mine.path)).toBe(true);
    expect(JSON.parse(readFileSync(mine.path, "utf8")).boot_nonce).toBe("planted");
  });
});
