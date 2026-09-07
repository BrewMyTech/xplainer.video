/**
 * The one line, and the wait a parent does instead of sleeping.
 *
 * The parsing half is pure and is asserted as such. The waiting half is not: ADR 0025 §Part three
 * puts the announcement on a **pipe**, and P1-14 asks for two failure paths that only a real child
 * can produce — a process that exits before announcing, and one that is still alive and has not
 * announced. So the children here are real `node` processes, written as one-liners because nothing
 * about this file needs a daemon: what is under test is what `waitForReadyLine` does with a stream.
 */

import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExitedBeforeReadyError,
  formatReadyLine,
  parseReadyLine,
  READY_EVENT,
  ReadyTimeoutError,
  readyAnnouncement,
  waitForReadyLine,
} from "./ready.js";

const children: ChildProcess[] = [];

/** Run a fragment of JavaScript as a real child, so the wait is over a real pipe. */
function child(script: string): ChildProcess {
  const spawned = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(spawned);
  return spawned;
}

afterEach(() => {
  for (const spawned of children.splice(0)) {
    spawned.kill("SIGKILL");
  }
});

const FIELDS = { port: 8787, socket: null, contractVersion: "1.0", pid: 4242 };

describe("readyAnnouncement", () => {
  it("carries the port, the socket, the contract version and the pid", () => {
    expect(readyAnnouncement(FIELDS)).toEqual({
      event: READY_EVENT,
      port: 8787,
      socket: null,
      contract_version: "1.0",
      pid: 4242,
    });
  });

  /**
   * `socket` is present-and-null rather than absent until the IPC listener lands (roadmap P1-9), so
   * a parent written against the line today keeps parsing when the socket arrives.
   */
  it("writes socket: null rather than omitting the key", () => {
    const line = formatReadyLine(readyAnnouncement({ port: 8787, contractVersion: "1.0", pid: 1 }));

    expect(line).toContain('"socket":null');
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd().split("\n")).toHaveLength(1);
  });

  it("round-trips through the parser", () => {
    const announcement = readyAnnouncement({ ...FIELDS, socket: "/run/user/1000/xplainer.sock" });

    expect(parseReadyLine(formatReadyLine(announcement))).toEqual(announcement);
  });
});

describe("parseReadyLine", () => {
  it.each([
    ["a log line", "xplainer serve: listening on http://127.0.0.1:8787"],
    ["an empty line", "   "],
    ["half a JSON object", '{"event":"ready"'],
    ["another event", '{"event":"stopping","port":8787,"contract_version":"1","pid":1}'],
    ["a line with no port", '{"event":"ready","contract_version":"1","pid":1}'],
    ["a line with no pid", '{"event":"ready","port":8787,"contract_version":"1"}'],
    ["a JSON array", "[1,2,3]"],
  ])("returns null for %s", (_case, line) => {
    expect(parseReadyLine(line)).toBeNull();
  });

  it("treats a non-string socket as no socket", () => {
    expect(
      parseReadyLine('{"event":"ready","port":1,"socket":7,"contract_version":"1","pid":2}'),
    ).toEqual({ event: READY_EVENT, port: 1, socket: null, contract_version: "1", pid: 2 });
  });
});

describe("waitForReadyLine", () => {
  it("resolves with the announcement a child writes to stdout", async () => {
    const announcement = await waitForReadyLine(
      child(
        'process.stdout.write(\'{"event":"ready","port":8787,"socket":null,"contract_version":"1.0","pid":\' + process.pid + \'}\\n\');' +
          "setInterval(function () {}, 1000);",
      ),
    );

    expect(announcement.port).toBe(8787);
    expect(announcement.contract_version).toBe("1.0");
    expect(announcement.socket).toBeNull();
  });

  /** Everything `serve` says goes to stderr, so the wait has to ignore all of it. */
  it("ignores log lines on both streams, and a partial write, before the announcement", async () => {
    const announcement = await waitForReadyLine(
      child(
        'process.stderr.write("xplainer serve: reconciled 1 job\\n");' +
          'process.stdout.write("not json at all\\n");' +
          'process.stdout.write(\'{"event":"ready","port":9\');' +
          "setTimeout(function () {" +
          'process.stdout.write(\'123,"socket":null,"contract_version":"1.0","pid":1}\\n\');' +
          "}, 30);" +
          "setInterval(function () {}, 1000);",
      ),
    );

    expect(announcement.port).toBe(9123);
  });

  /**
   * The refusal paths all exit with a documented code — `10`, `11`, `12`, `0` — so the error carries
   * it, and the tail of what the child said, rather than becoming a timeout ten seconds later.
   */
  it("rejects with the exit code when the child exits before announcing", async () => {
    const failing = child(
      'process.stderr.write("xplainer serve: the bearer token file cannot be used\\n");' +
        "process.exit(12);",
    );

    await expect(waitForReadyLine(failing)).rejects.toBeInstanceOf(ExitedBeforeReadyError);
    const error = await waitForReadyLine(child("process.exit(12);")).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ExitedBeforeReadyError);
    if (error instanceof ExitedBeforeReadyError) {
      expect(error.exitCode).toBe(12);
      expect(error.signal).toBeNull();
    }
  });

  it("quotes what the child said when it exited", async () => {
    const error = await waitForReadyLine(
      child('process.stderr.write("no state directory\\n"); process.exit(11);'),
    ).catch((thrown: unknown) => thrown);

    expect(String(error)).toContain("no state directory");
    expect(String(error)).toContain("exit code 11");
  });

  /**
   * A daemon that is alive and has not bound is the case a parent must *stop* before starting
   * anything else, or two daemons contend for exclusive ownership — so it is a distinguishable
   * error, and this function never kills the child on its own.
   */
  it("rejects with a timeout for a child that stays alive and never announces", async () => {
    const silent = child("setInterval(function () {}, 1000);");

    const error = await waitForReadyLine(silent, { timeoutMs: 150 }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ReadyTimeoutError);
    if (error instanceof ReadyTimeoutError) {
      expect(error.timeoutMs).toBe(150);
    }
    expect(silent.exitCode).toBeNull();
    expect(silent.signalCode).toBeNull();
  });
});
