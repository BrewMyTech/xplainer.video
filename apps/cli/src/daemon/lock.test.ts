/**
 * The six ownership scenarios ADR 0024's note of 2026-09-06 quotes, in process.
 *
 * `apps/cli/spikes/p1-s1-ownership.mjs` runs each of them in a child so the *exit code* is the real
 * one; that is the measurement the ADR note publishes and it stays where it is. These are the same
 * classifications asserted against the module the daemon actually loads, so the product and the
 * spike cannot drift apart — and the child-process half, including "it wrote nothing", is in
 * `start.test.ts`, where a second `xplainer serve` is spawned for real.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Acquisition,
  acquireOwnership,
  classifyHolder,
  type OwnershipRecord,
  readLock,
  releaseOwnership,
} from "./lock.js";
import { OWNER_LOCK_FILE } from "./state-dir.js";
import { selfIdentity } from "./worker-identity.js";

const scratch: string[] = [];

function stateDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "xplainer-lock-"));
  scratch.push(dir);
  return dir;
}

function writeRawLock(stateDir: string, contents: string): void {
  writeFileSync(join(stateDir, OWNER_LOCK_FILE), contents);
}

/** Narrow an acquisition, so the assertions below read as statements rather than as ternaries. */
function acquired(acquisition: Acquisition): OwnershipRecord {
  if (!acquisition.ok) {
    throw new Error(
      `expected the lock to be acquired; steps were: ${acquisition.steps.join(" | ")}`,
    );
  }
  return acquisition.record;
}

/** A pid that certainly belongs to nothing: a child that has already exited. */
function exitedPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  });
  return Number(child.stdout);
}

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("acquireOwnership", () => {
  it("[A] creates the lock in a fresh state directory and records the identity tuple", async () => {
    const stateDir = stateDirectory();

    const record = acquired(await acquireOwnership(stateDir));

    const written = JSON.parse(
      readFileSync(join(stateDir, OWNER_LOCK_FILE), "utf8"),
    ) as OwnershipRecord;
    expect(written.pid).toBe(process.pid);
    expect(written.start_time).toBe(selfIdentity().start_time);
    expect(written.boot_nonce).toBe(record.boot_nonce);
    expect(written.boot_id).toBe(selfIdentity().boot_id);
  });

  it("[E] refuses while the holder is alive and its start time matches", async () => {
    const stateDir = stateDirectory();
    acquired(await acquireOwnership(stateDir));
    const before = readFileSync(join(stateDir, OWNER_LOCK_FILE), "utf8");

    const second = await acquireOwnership(stateDir);

    expect(second.ok).toBe(false);
    expect(second.steps.at(-1)).toContain("having written nothing");
    expect(readFileSync(join(stateDir, OWNER_LOCK_FILE), "utf8")).toBe(before);
  });

  it("[D] takes over a lock naming a live pid whose start time does not match", async () => {
    const stateDir = stateDirectory();
    writeRawLock(
      stateDir,
      JSON.stringify({
        format_version: 1,
        pid: process.pid,
        start_time: "Thu Jan  1 00:00:00 1970",
        boot_nonce: "not-ours",
      }),
    );

    const acquisition = await acquireOwnership(stateDir);

    expect(acquisition.ok).toBe(true);
    expect(acquisition.steps.join(" ")).toContain("the number was reused");
  });

  it("[F] takes over a zero-length lock, which is an acquirer that died mid-write", async () => {
    const stateDir = stateDirectory();
    writeRawLock(stateDir, "");

    const acquisition = await acquireOwnership(stateDir);

    expect(acquisition.ok).toBe(true);
    expect(acquisition.steps.join(" ")).toContain("died between O_EXCL and the write");
  });

  it("takes over a lock whose holder is not alive", async () => {
    const stateDir = stateDirectory();
    writeRawLock(
      stateDir,
      JSON.stringify({ format_version: 1, pid: exitedPid(), start_time: null }),
    );

    const acquisition = await acquireOwnership(stateDir);

    expect(acquisition.ok).toBe(true);
  });

  it("refuses an unparseable lock rather than guessing about it", async () => {
    const stateDir = stateDirectory();
    writeRawLock(stateDir, "{ this is not json");

    const acquisition = await acquireOwnership(stateDir);

    expect(acquisition.ok).toBe(false);
    expect(acquisition.steps.join(" ")).toContain("refusing rather than guessing");
  });
});

describe("classifyHolder", () => {
  it("tells the four shapes of a lock file apart", () => {
    expect(classifyHolder({ state: "empty", raw: "", record: null }).live).toBe(false);
    expect(classifyHolder({ state: "unparseable", raw: "{", record: null }).live).toBe(true);
    expect(classifyHolder({ state: "parsed", raw: "{}", record: {} }).live).toBe(true);
    expect(
      classifyHolder({
        state: "parsed",
        raw: "",
        record: { pid: process.pid, start_time: selfIdentity().start_time },
      }).live,
    ).toBe(true);
  });
});

describe("releaseOwnership", () => {
  it("removes a lock this process still holds", async () => {
    const stateDir = stateDirectory();
    const record = acquired(await acquireOwnership(stateDir));

    const released = releaseOwnership(stateDir, record);

    expect(released).toBe(true);
    expect(readLock(join(stateDir, OWNER_LOCK_FILE)).state).toBe("absent");
  });

  it("leaves a successor's lock alone", async () => {
    const stateDir = stateDirectory();
    const mine = acquired(await acquireOwnership(stateDir));
    writeRawLock(
      stateDir,
      JSON.stringify({ format_version: 1, pid: 1, boot_nonce: "someone-else" }),
    );

    const released = releaseOwnership(stateDir, mine);

    expect(released).toBe(false);
    expect(readLock(join(stateDir, OWNER_LOCK_FILE)).record?.boot_nonce).toBe("someone-else");
  });
});
