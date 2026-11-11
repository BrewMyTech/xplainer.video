/**
 * The CDP framing, over a real pair of streams and no browser.
 *
 * Chrome's pipe delivers NUL-terminated JSON in chunks whose boundaries have nothing to do with
 * the messages: one chunk can carry several, and one message can arrive in several — including a
 * split in the middle of a multi-byte character. A `PassThrough` pair stands in for fds 3 and 4,
 * which is the whole transport; nothing about the client is replaced.
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { spawnEntry, untilGone } from "../daemon/testing/spawn-child.js";
import { CdpConnection, launchChrome } from "./cdp.js";

/** A worker that exits while its browser is still starting (`testing/child-launch.ts`). */
const CHILD_LAUNCH = fileURLToPath(new URL("./testing/child-launch.ts", import.meta.url));

/** A connection over two in-memory streams, and the text it has written so far. */
function connected(): {
  connection: CdpConnection;
  fromBrowser: PassThrough;
  written: () => string;
} {
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const chunks: Buffer[] = [];
  toBrowser.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  return {
    connection: new CdpConnection(toBrowser, fromBrowser),
    fromBrowser,
    written: () => Buffer.concat(chunks).toString("utf8"),
  };
}

function frame(message: object): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\0`, "utf8");
}

/** Let the streams deliver what has been written to them. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe("CdpConnection", () => {
  it("writes each command as one JSON document followed by a NUL", async () => {
    const { connection, written } = connected();
    void connection.send("Browser.getVersion");
    void connection.send("Page.navigate", { url: "file:///x" }, "S1");
    await flush();

    expect(written().split("\0")).toEqual([
      JSON.stringify({ id: 1, method: "Browser.getVersion", params: {} }),
      JSON.stringify({
        id: 2,
        method: "Page.navigate",
        params: { url: "file:///x" },
        sessionId: "S1",
      }),
      "",
    ]);
  });

  it("answers two replies that arrive in one chunk, each to its own call", async () => {
    const { connection, fromBrowser } = connected();
    const first = connection.send("A.one");
    const second = connection.send("A.two");

    fromBrowser.write(
      Buffer.concat([frame({ id: 2, result: { n: 2 } }), frame({ id: 1, result: { n: 1 } })]),
    );

    await expect(first).resolves.toEqual({ n: 1 });
    await expect(second).resolves.toEqual({ n: 2 });
  });

  it("reassembles a reply split across chunks, including inside a multi-byte character", async () => {
    const { connection, fromBrowser } = connected();
    const answer = connection.send("Runtime.evaluate");
    const bytes = frame({ id: 1, result: { text: "naïve — café ☕" } });
    const cut = bytes.indexOf(Buffer.from("☕", "utf8")) + 1;

    fromBrowser.write(bytes.subarray(0, 5));
    await flush();
    fromBrowser.write(bytes.subarray(5, cut));
    await flush();
    fromBrowser.write(bytes.subarray(cut));

    await expect(answer).resolves.toEqual({ text: "naïve — café ☕" });
  });

  it("routes an event to the session it is tagged with, and an untagged one to the browser", async () => {
    const { connection, fromBrowser } = connected();
    const created = connection.newPage();
    fromBrowser.write(frame({ id: 1, result: { targetId: "T1" } }));
    await flush();
    fromBrowser.write(frame({ id: 2, result: { sessionId: "S1" } }));
    const page = await created;

    const onPage: unknown[] = [];
    const onBrowser: unknown[] = [];
    page.on("Runtime.consoleAPICalled", (params) => onPage.push(params));
    connection.on("Target.targetCreated", (params) => onBrowser.push(params));
    fromBrowser.write(
      Buffer.concat([
        frame({ method: "Runtime.consoleAPICalled", params: { type: "warning" }, sessionId: "S1" }),
        frame({ method: "Target.targetCreated", params: { targetInfo: {} } }),
        frame({ method: "Runtime.consoleAPICalled", params: { type: "log" }, sessionId: "S2" }),
      ]),
    );
    await flush();

    expect(page.sessionId).toBe("S1");
    expect(onPage).toEqual([{ type: "warning" }]);
    expect(onBrowser).toEqual([{ targetInfo: {} }]);
  });

  it("rejects a call the browser answered with an error, naming the method", async () => {
    const { connection, fromBrowser } = connected();
    const answer = connection.send("Page.captureScreenshot");
    fromBrowser.write(frame({ id: 1, error: { code: -32000, message: "Not attached" } }));

    await expect(answer).rejects.toThrow("CDP Page.captureScreenshot failed: -32000 Not attached");
  });

  it("rejects a call nobody answers once its own timeout passes", async () => {
    const { connection } = connected();
    await expect(
      connection.send("Page.navigate", {}, undefined, { timeoutMs: 20 }),
    ).rejects.toThrow("CDP Page.navigate had no answer after 20 ms");
  });

  it("fails every pending call and every later one with the first failure", async () => {
    const { connection } = connected();
    const pending = connection.send("A.one");
    connection.fail(new Error("the browser exited (code 1): boom"));
    connection.fail(new Error("a second, later failure"));

    await expect(pending).rejects.toThrow("boom");
    await expect(connection.send("A.two")).rejects.toThrow("boom");
  });
});

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Chrome's own line on a Linux that restricts unprivileged user namespaces. */
const SANDBOX_LINE =
  "[1:1:FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox! Update your kernel";

/**
 * A stand-in browser: a Node script that speaks the pipe protocol on fds 3 and 4 and does nothing
 * else. It answers every command with an empty result, `Browser.close` by exiting, and
 * `Test.crash` by printing to stderr and dying — and, unless it was given `--no-sandbox`, it
 * refuses to start the way Chrome does on a Linux that restricts user namespaces.
 *
 * Two variations. `late-sandbox` refuses the same way, but exits first and has a process it left
 * behind print the line 300 ms later, on the stderr it inherited — so the line arrives after
 * `exit` and before `close`. `silent` starts on any flags, never answers, and says where it is —
 * `{ pid, profile }` — by renaming a file into `XPLAINER_FAKE_CHROME_REPORT`.
 */
function fakeBrowser(mode: "answers" | "late-sandbox" | "silent" = "answers"): string {
  const directory = mkdtempSync(join(tmpdir(), "xplainer-fake-chrome-"));
  directories.push(directory);
  const script = join(directory, "chrome-headless-shell");
  const late = `setTimeout(() => process.stderr.write(${JSON.stringify(`${SANDBOX_LINE}\n`)}), 300);`;
  writeFileSync(
    script,
    `#!${process.execPath}
const fs = require("node:fs");
const mode = ${JSON.stringify(mode)};
if (mode === "silent") {
  const report = process.env.XPLAINER_FAKE_CHROME_REPORT;
  const profile = process.argv.find((arg) => arg.startsWith("--user-data-dir=")).slice(16);
  fs.writeFileSync(report + ".tmp", JSON.stringify({ pid: process.pid, profile }));
  fs.renameSync(report + ".tmp", report);
  fs.createReadStream(null, { fd: 3 }).resume();
  setInterval(() => {}, 1000);
} else if (!process.argv.includes("--no-sandbox")) {
  if (mode === "late-sandbox") {
    require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(late)}], {
      stdio: ["ignore", "ignore", "inherit"],
    });
  } else {
    process.stderr.write(${JSON.stringify(`${SANDBOX_LINE}\n`)});
  }
  process.exit(1);
} else {
  const input = fs.createReadStream(null, { fd: 3 });
  const output = fs.createWriteStream(null, { fd: 4 });
  let pending = "";
  input.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    for (let end = pending.indexOf("\\0"); end >= 0; end = pending.indexOf("\\0")) {
      const message = JSON.parse(pending.slice(0, end));
      pending = pending.slice(end + 1);
      if (message.method === "Test.crash") {
        process.stderr.write("renderer went away: boom\\n");
        process.exit(3);
      }
      output.write(JSON.stringify({ id: message.id, result: {} }) + "\\0", () => {
        if (message.method === "Browser.close") process.exit(0);
      });
    }
  });
}
`,
  );
  chmodSync(script, 0o755);
  return script;
}

describe("launchChrome", () => {
  /**
   * Ubuntu 24.04 — every GitHub Linux runner — restricts unprivileged user namespaces, and Chrome
   * then refuses to start with "No usable sandbox". On Linux the launch retries once with
   * `--no-sandbox` and says so in the log; elsewhere the refusal is the launch failure, with
   * Chrome's own line in it. Root on Linux gets `--no-sandbox` from the first attempt.
   */
  it("relaunches once without the sandbox on Linux, and fails with Chrome's line elsewhere", async () => {
    const executable = fakeBrowser();
    const lines: string[] = [];
    const launched = launchChrome({ executable, log: (line) => lines.push(line) });

    if (process.platform !== "linux") {
      await expect(launched).rejects.toMatchObject({
        code: "CHROME_LAUNCH_FAILED",
        message: expect.stringContaining("No usable sandbox"),
      });
      return;
    }
    const chrome = await launched;
    expect(chrome.args).toContain("--no-sandbox");
    if (process.getuid?.() !== 0) {
      expect(lines.join("\n")).toContain("No usable sandbox");
      expect(lines.join("\n")).toContain("relaunching once with --no-sandbox");
    }
    await chrome.close();
  });

  it("fails every pending call with the tail of what the browser printed when it dies", async () => {
    const executable = fakeBrowser();
    // Given `--no-sandbox` up front, so the stand-in starts on every platform.
    const chrome = await launchChrome({ executable, log: () => {}, extraFlags: ["--no-sandbox"] });

    await expect(chrome.connection.send("Test.crash")).rejects.toMatchObject({
      code: "PAGE_ERROR",
      message: expect.stringMatching(/^PAGE_ERROR: the browser exited \(code 3[\s\S]*boom/),
    });
    await chrome.kill();
  });

  /**
   * `exit` can be emitted before the last of the browser's stderr has been read, and the sandbox
   * line is the last thing it prints. The stand-in makes that ordering certain: the line comes from
   * a process it left behind, 300 ms after it exited. Decided on `exit`, the launch would see no
   * line, never retry on Linux, and quote nothing anywhere.
   */
  it("reads the browser's last words before deciding on the sandbox, even when they arrive after its exit", async () => {
    const executable = fakeBrowser("late-sandbox");
    const lines: string[] = [];
    const launched = launchChrome({ executable, log: (line) => lines.push(line) });

    if (process.platform !== "linux") {
      await expect(launched).rejects.toMatchObject({
        code: "CHROME_LAUNCH_FAILED",
        message: expect.stringContaining("No usable sandbox"),
      });
      return;
    }
    const chrome = await launched;
    expect(chrome.args).toContain("--no-sandbox");
    if (process.getuid?.() !== 0) {
      expect(lines.join("\n")).toContain("relaunching once with --no-sandbox");
    }
    await chrome.close();
  });

  /**
   * A `SIGTERM` while Chrome is still starting ends the worker through `process.exit()`, before
   * `launchChrome` has returned anything for it to clean up. The browser and its profile go with
   * the worker anyway.
   */
  it("takes the browser and its profile with it when the worker exits during the handshake", async () => {
    const executable = fakeBrowser("silent");
    const scratch = mkdtempSync(join(tmpdir(), "xplainer-launch-exit-"));
    directories.push(scratch);
    const report = join(scratch, "browser.json");

    const child = spawnEntry(CHILD_LAUNCH, [executable, report], {
      XPLAINER_FAKE_CHROME_REPORT: report,
    });
    const exit = await child.waitForExit();

    expect(exit.code, child.stderr()).toBe(7);
    const browser = JSON.parse(readFileSync(report, "utf8")) as { pid: number; profile: string };
    expect(await untilGone(browser.pid)).toBe(true);
    expect(existsSync(browser.profile)).toBe(false);
  });

  it("fails with CHROME_LAUNCH_FAILED naming an executable that is not there", async () => {
    const missing = "/nonexistent/xplainer/chrome-headless-shell";
    await expect(launchChrome({ executable: missing, log: () => {} })).rejects.toMatchObject({
      code: "CHROME_LAUNCH_FAILED",
      message: expect.stringContaining(`CHROME_LAUNCH_FAILED: ${missing}:`),
    });
  });
});
