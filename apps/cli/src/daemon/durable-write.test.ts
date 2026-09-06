/**
 * The four steps of a durable write, and the one that is allowed to fail.
 *
 * The measurement behind them is ADR 0024's note of 2026-09-06 §Write durability, and the crash
 * behaviour they buy is asserted for real in `start.test.ts`, where a child process is `SIGKILL`ed
 * the instant `enqueue()` returns. What is asserted here is the mechanics: that a rename lands,
 * that no temporary file is left behind, and that the directory flush reports rather than throws —
 * because on Windows it will fail, and a daemon that crashed on that would be worse than one that
 * logged it.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
  DIRECTORY_FLUSH_OK,
  ensureStateDirectory,
  flushDirectory,
  writeJsonDurably,
} from "./durable-write.js";

const scratch: string[] = [];

function temporaryDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "xplainer-durable-"));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("writeJsonDurably", () => {
  it("writes the value and leaves no temporary file behind", () => {
    const dir = temporaryDirectory();
    const target = join(dir, "record.json");

    writeJsonDurably(target, { job_id: 7, status: "queued" });

    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ job_id: 7, status: "queued" });
    expect(readdirSync(dir)).toEqual(["record.json"]);
  });

  it("replaces an existing file atomically, so a reader never sees a half-written record", () => {
    const dir = temporaryDirectory();
    const target = join(dir, "record.json");

    writeJsonDurably(target, { status: "queued" });
    writeJsonDurably(target, { status: "running" });

    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ status: "running" });
    expect(readdirSync(dir)).toEqual(["record.json"]);
  });

  it("reports the directory flush rather than throwing it", () => {
    const dir = temporaryDirectory();

    const flush = writeJsonDurably(join(dir, "record.json"), {});

    // Linux and macOS both flush a directory descriptor; Windows offers no directory handle at all,
    // which is why this is a returned string and not an exception.
    if (process.platform === "win32") {
      expect(flush.startsWith("unavailable (")).toBe(true);
    } else {
      expect(flush).toBe(DIRECTORY_FLUSH_OK);
    }
  });

  it("throws when the target directory does not exist, rather than losing the record quietly", () => {
    const dir = temporaryDirectory();

    expect(() => writeJsonDurably(join(dir, "missing", "record.json"), {})).toThrow();
  });
});

describe("flushDirectory", () => {
  it("says what happened instead of raising, for a path that is not a directory", () => {
    const dir = temporaryDirectory();
    const file = join(dir, "record.json");
    writeJsonDurably(file, {});

    const outcome = flushDirectory(join(dir, "no-such-directory"));

    expect(outcome.startsWith("unavailable (")).toBe(true);
  });
});

describe("ensureStateDirectory", () => {
  it("creates nested directories and is a no-op the second time", () => {
    const dir = temporaryDirectory();
    const nested = join(dir, "jobs", "corrupt");

    ensureStateDirectory(nested);
    ensureStateDirectory(nested);

    expect(readdirSync(join(dir, "jobs"))).toEqual(["corrupt"]);
  });
});
