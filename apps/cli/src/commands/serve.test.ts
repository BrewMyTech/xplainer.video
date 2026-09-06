/**
 * `xplainer serve` as a supervisor sees it: a process that announces, answers, and stops.
 *
 * Everything here is a property of the **process** rather than of a function, which is why every
 * test spawns a real `serve` against a temporary state directory:
 *
 * - **the token** is minted by the daemon on its first start, and a mode is only a mode if `stat`
 *   agrees (ADR 0020 §Security R-SEC-5);
 * - **the ready line** is a contract with whatever spawned the daemon, so it has to be read from a
 *   real pipe, and "exactly one line on stdout" is only meaningful about a real stdout
 *   ([ADR 0025](../../../docs/adr/0025-daemon-updates-and-readiness.md) §Part three);
 * - **`12`** and the `--bind` refusals are exit codes, and an exit code is what a supervisor acts
 *   on;
 * - **the drain** is six steps between a signal and exit `0`, with a 25-second budget, a worker
 *   process group to tear down and two files to remove (ADR 0024 §Drain on planned restart).
 *
 * The children are started through `daemon/testing/spawn-child.ts`, which runs this package's
 * sources rather than `dist/` — `turbo.json` gives `test` no dependency on this package's own build,
 * so a `dist/` here would be absent or stale.
 */

import type { ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { MCP_CONTRACT_VERSION } from "@xplainer/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { REMOTE_EXPOSURE_FLAG } from "../daemon/binding.js";
import { IPC_DIR, IPC_SOCKET_FILE } from "../daemon/ipc.js";
import { createJobStore } from "../daemon/job-store.js";
import { parseReadyLine, type ReadyAnnouncement, waitForReadyLine } from "../daemon/ready.js";
import { STATE_DIR_MODE, STATE_FILE_MODE, stateDirLayout } from "../daemon/state-dir.js";
import {
  CHILD_SERVE,
  CHILD_SERVE_JOB,
  type SpawnedChild,
  spawnEntry,
  untilGone,
} from "../daemon/testing/spawn-child.js";
import { TOKEN_FILE, TOKEN_FILE_ENV } from "../daemon/token.js";
import { isAlive } from "../daemon/worker-identity.js";

/** P1-7's whole budget: the 20 s drain plus teardown. */
const SHUTDOWN_BUDGET_MS = 25_000;

const scratch: string[] = [];
const children: ChildProcess[] = [];
/** Worker groups a failing test might otherwise leave behind for a minute. */
const strays: number[] = [];

function stateDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "xplainer-serve-"));
  scratch.push(dir);
  return dir;
}

function run(entry: string, args: readonly string[], env: Record<string, string>): SpawnedChild {
  const child = spawnEntry(entry, args, env);
  children.push(child.process);
  return child;
}

/** The permission bits, as the four octal digits a person would write. */
function mode(path: string): string {
  return (statSync(path).mode % 0o1000).toString(8).padStart(4, "0");
}

function octal(value: number): string {
  return value.toString(8).padStart(4, "0");
}

/** Start a daemon and wait for the line ADR 0025 §Part three makes the readiness signal. */
async function serveUntilReady(
  entry: string,
  stateDir: string,
  env: Record<string, string> = {},
): Promise<{ child: SpawnedChild; ready: ReadyAnnouncement; token: string }> {
  const child = run(entry, ["--port", "0"], { XPLAINER_STATE_DIR: stateDir, ...env });
  const ready = await waitForReadyLine(child.process, { timeoutMs: 20_000 });
  const token = readFileSync(env[TOKEN_FILE_ENV] ?? join(stateDir, TOKEN_FILE), "utf8").trim();
  return { child, ready, token };
}

/**
 * One `GET /healthz`, over a TCP port or over a unix socket, with exactly the headers given.
 *
 * `node:http` rather than `fetch` for the same reason `server.test.ts` uses it: `fetch` writes the
 * `Host` header itself and has no supported way to name a socket path at all. Both destinations go
 * through this one function so that "the same request" in the assertions below is literally the
 * same request, differing in nothing but where it was sent.
 */
function getHealthz(
  target: { port: number } | { socketPath: string },
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const call = request(
      {
        ...("port" in target ? { host: "127.0.0.1", port: target.port } : target),
        path: "/healthz",
        method: "GET",
        headers,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, body });
        });
      },
    );
    call.once("error", reject);
    call.end();
  });
}

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  for (const pid of strays.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Gone already, which is what these tests are mostly asserting.
    }
  }
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the bearer token a daemon mints on its first start", () => {
  it("is 32 bytes, 0600, inside a 0700 state directory, and is required by /healthz", async () => {
    const stateDir = stateDirectory();

    const { child, ready, token } = await serveUntilReady(CHILD_SERVE, stateDir);

    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(mode(join(stateDir, TOKEN_FILE))).toBe(octal(STATE_FILE_MODE));
    expect(mode(stateDir)).toBe(octal(STATE_DIR_MODE));
    expect(child.stderr()).toContain("wrote a new bearer token");

    const url = `http://127.0.0.1:${ready.port}/healthz`;
    const unauthenticated = await fetch(url);
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toBe("Bearer");

    const authenticated = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    const body = (await authenticated.json()) as { status: unknown; contract_version: unknown };
    expect(authenticated.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.contract_version).toBe(MCP_CONTRACT_VERSION);
  }, 30_000);

  /** R-SEC-6: the path travels in the environment, and the value never leaves the file. */
  it("is read from XPLAINER_TOKEN_FILE when the supervisor points at one", async () => {
    const stateDir = stateDirectory();
    const elsewhere = join(stateDirectory(), "token");

    const { ready, token } = await serveUntilReady(CHILD_SERVE, stateDir, {
      [TOKEN_FILE_ENV]: elsewhere,
    });

    expect(readdirSync(stateDir)).not.toContain(TOKEN_FILE);
    expect(mode(elsewhere)).toBe(octal(STATE_FILE_MODE));
    const response = await fetch(`http://127.0.0.1:${ready.port}/healthz`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const daemonState = JSON.parse(
      readFileSync(stateDirLayout(stateDir).daemonState, "utf8"),
    ) as Record<string, unknown>;
    expect(daemonState.token_file).toBe(elsewhere);
  }, 30_000);

  /** R-SEC-10: a rejection is logged with its reason, and never with the value it rejected. */
  it("logs a rejected request with the Authorization header redacted", async () => {
    const stateDir = stateDirectory();
    const { child, ready } = await serveUntilReady(CHILD_SERVE, stateDir);

    await fetch(`http://127.0.0.1:${ready.port}/healthz`, {
      headers: { authorization: "Bearer a-token-this-daemon-never-minted" },
    });
    await child.waitForLine("401 bearer token rejected");

    expect(child.stderr()).toContain("Bearer <redacted>");
    expect(child.stderr()).not.toContain("a-token-this-daemon-never-minted");
  }, 30_000);

  it("exits 12 when the token file exists and cannot be used", async () => {
    const stateDir = stateDirectory();
    const unreadable = join(stateDirectory(), "token-as-a-directory");
    mkdirSync(unreadable);

    const child = run(CHILD_SERVE, ["--port", "0"], {
      XPLAINER_STATE_DIR: stateDir,
      [TOKEN_FILE_ENV]: unreadable,
    });
    const exit = await child.waitForExit();

    expect(exit.code).toBe(12);
    expect(child.stderr()).toContain("refusing to serve unauthenticated");
    expect(child.stdout()).toBe("");
  }, 30_000);
});

describe("the bind refusals", () => {
  it.each([
    ["0.0.0.0", ["--bind", "0.0.0.0"], "binds every interface"],
    ["0.0.0.0 even when acknowledged", ["--bind", "0.0.0.0", REMOTE_EXPOSURE_FLAG], "refused"],
    ["a LAN address with no acknowledgement", ["--bind", "192.168.1.10"], REMOTE_EXPOSURE_FLAG],
  ])(
    "refuses %s before it takes the state directory",
    async (_case, args, expected) => {
      const stateDir = stateDirectory();

      const child = run(CHILD_SERVE, [...args, "--port", "0"], { XPLAINER_STATE_DIR: stateDir });
      const exit = await child.waitForExit();

      expect(exit.code).toBe(1);
      expect(child.stderr()).toContain(expected);
      expect(child.stdout()).toBe("");
      // A usage error that had already acquired the directory would be a usage error that stopped
      // the real daemon from starting, so the refusal happens before anything is written.
      expect(readdirSync(stateDir)).toEqual([]);
    },
    30_000,
  );
});

describe("a port that is already taken", () => {
  it("exits 10 rather than 70, so a supervisor stops restarting it", async () => {
    const stateDir = stateDirectory();
    const squatter = createServer();
    await new Promise<void>((listening) => {
      squatter.listen(0, "127.0.0.1", listening);
    });
    const address = squatter.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    try {
      const child = run(CHILD_SERVE, ["--port", String(port)], { XPLAINER_STATE_DIR: stateDir });
      const exit = await child.waitForExit();

      expect(exit.code).toBe(10);
      expect(child.stderr()).toContain(`127.0.0.1:${port} is already in use`);
      // The refusal gave the state directory back, so the next start can take it.
      expect(readdirSync(stateDir)).not.toContain("owner.lock");
    } finally {
      await new Promise<void>((closed) => {
        squatter.close(() => {
          closed();
        });
      });
    }
  }, 30_000);
});

describe("the ready line", () => {
  it("is the whole of stdout, and describes the listener that is actually bound", async () => {
    const stateDir = stateDirectory();

    const { child, ready } = await serveUntilReady(CHILD_SERVE, stateDir);

    expect(child.stdout().trimEnd().split("\n")).toHaveLength(1);
    expect(parseReadyLine(child.stdout())).toEqual(ready);
    expect(ready.event).toBe("ready");
    expect(ready.pid).toBe(child.process.pid);
    expect(ready.contract_version).toBe(MCP_CONTRACT_VERSION);
    // The second listener, named: a parent reading this line learns the socket path without a
    // request, which is the whole point of announcing rather than being polled.
    expect(ready.socket).toBe(join(stateDir, IPC_DIR, IPC_SOCKET_FILE));
    expect(existsSync(ready.socket ?? "")).toBe(true);

    const runtime = JSON.parse(
      readFileSync(stateDirLayout(stateDir).runtimeState, "utf8"),
    ) as Record<string, unknown>;
    expect(runtime.port).toBe(ready.port);
    expect(runtime.addresses).toEqual([`http://127.0.0.1:${ready.port}`]);
    expect(runtime.socket).toBe(ready.socket);
    // Announced *after* ownership, reconciliation and the bind: the listener answers immediately.
    const response = await fetch(`http://127.0.0.1:${ready.port}/healthz`, {
      headers: {
        authorization: `Bearer ${readFileSync(join(stateDir, TOKEN_FILE), "utf8").trim()}`,
      },
    });
    expect(response.status).toBe(200);
  }, 30_000);
});

/**
 * ADR 0020 §The agent path is IPC, not TCP, as a running daemon: "the TCP binding passes the
 * loopback guard, the IPC binding passes none … Filesystem permissions are the authentication."
 *
 * The pair of tests below is the whole claim, and it is only a claim about a **process**: the same
 * bytes, sent to the same route of the same daemon, are refused on one listener and served on the
 * other. Asserting either half alone would prove nothing — a socket that answered everything with a
 * `200` would pass the second, and a guard that refused everything would pass the first.
 */
describe("the IPC listener", () => {
  it("serves a request the TCP listener refuses, because the socket is the credential", async () => {
    const stateDir = stateDirectory();
    const { ready } = await serveUntilReady(CHILD_SERVE, stateDir);
    const socketPath = ready.socket ?? "";

    // One request, no `Authorization`, sent twice.
    const overTcp = await getHealthz({ port: ready.port });
    const overSocket = await getHealthz({ socketPath });

    expect(overTcp.status).toBe(401);
    expect(overTcp.body).toContain("UNAUTHORIZED");
    expect(overSocket.status).toBe(200);
    expect(JSON.parse(overSocket.body)).toEqual({
      status: "ok",
      version: expect.any(String),
      contract_version: MCP_CONTRACT_VERSION,
    });
  }, 30_000);

  it("puts the socket in a 0700 directory, which is what that authentication is", async () => {
    const stateDir = stateDirectory();
    const { ready } = await serveUntilReady(CHILD_SERVE, stateDir);
    const socketPath = ready.socket ?? "";

    expect(socketPath).toBe(join(stateDir, IPC_DIR, IPC_SOCKET_FILE));
    expect(mode(dirname(socketPath))).toBe(octal(STATE_DIR_MODE));
    expect(statSync(socketPath).isSocket()).toBe(true);
  }, 30_000);

  /**
   * Step 6 of ADR 0024's drain is "remove `runtime.json` **and the socket**, exit `0`", and the
   * socket half is why: a socket file that outlives its daemon is a path `mcp --attach` dials and
   * finds nothing behind — a `ECONNREFUSED` where an honest `ENOENT` would have said "no daemon".
   */
  it("unlinks the socket on a clean shutdown, along with runtime.json", async () => {
    const stateDir = stateDirectory();
    const { child, ready } = await serveUntilReady(CHILD_SERVE, stateDir);
    const socketPath = ready.socket ?? "";
    expect(existsSync(socketPath)).toBe(true);

    child.process.kill("SIGTERM");
    const exit = await child.waitForExit();

    expect(exit.code).toBe(0);
    expect(existsSync(socketPath)).toBe(false);
    // The directory stays: it is `0700` and the next start binds into it again.
    expect(existsSync(dirname(socketPath))).toBe(true);
    expect(readdirSync(stateDir)).not.toContain("runtime.json");
  }, 30_000);
});

describe("SIGTERM", () => {
  it(
    "drains the running job, stops its process group, removes runtime.json and exits 0",
    async () => {
      const stateDir = stateDirectory();
      const { child } = await serveUntilReady(CHILD_SERVE_JOB, stateDir, {
        XPLAINER_TEST_WORKER: JSON.stringify({ lines: 3, lifeMs: 60_000, grandchild: true }),
      });
      const announced = await child.waitForLine('"event":"job"');
      const { job_id: jobId, worker_pid: workerPid } = JSON.parse(announced) as {
        job_id: number;
        worker_pid: number;
      };
      strays.push(workerPid);
      const record = createJobStore(stateDir).read(jobId);
      const grandchild = Number(
        (record?.log.find((line) => line.startsWith("grandchild ")) ?? "").replace(
          "grandchild ",
          "",
        ),
      );
      expect(record?.status).toBe("running");
      expect(isAlive(workerPid)).toBe(true);
      expect(isAlive(grandchild)).toBe(true);

      const sentAt = Date.now();
      child.process.kill("SIGTERM");
      const exit = await child.waitForExit();
      const elapsed = Date.now() - sentAt;

      expect(exit.code).toBe(0);
      expect(elapsed).toBeLessThan(SHUTDOWN_BUDGET_MS);
      // The group, not the leader: a render's expensive half is the browser and the encoder the
      // worker started.
      expect(await untilGone(workerPid)).toBe(true);
      expect(await untilGone(grandchild)).toBe(true);
      // Step 6 — and the reason the file means anything: a descriptor that is only ever written is
      // a descriptor every stale copy of which looks live.
      expect(readdirSync(stateDir)).not.toContain("runtime.json");
      expect(readdirSync(stateDir)).toContain("daemon.json");

      const drained = createJobStore(stateDir).read(jobId);
      expect(drained?.status).toBe("error");
      expect(drained?.error_code).toBe("daemon_shutdown");
      expect(drained?.finished_at).not.toBeNull();
      expect(drained?.log).toContain("line 1");
      expect(drained?.log.length).toBeLessThanOrEqual(200);
    },
    SHUTDOWN_BUDGET_MS + 30_000,
  );
});
