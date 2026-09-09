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
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { request as secureRequest } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { checkServerIdentity } from "node:tls";
import { MCP_CONTRACT_VERSION } from "@xplainer/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { REMOTE_EXPOSURE_FLAG } from "../daemon/binding.js";
import { readDaemonState, readRuntimeState } from "../daemon/daemon-state.js";
import { IPC_DIR, IPC_SOCKET_FILE, isNamedPipe, resolveIpcPath } from "../daemon/ipc.js";
import { createJobStore } from "../daemon/job-store.js";
import { parseReadyLine, type ReadyAnnouncement, waitForReadyLine } from "../daemon/ready.js";
import { DEFAULT_DRAIN_TIMEOUT_MS } from "../daemon/runner.js";
import { STATE_DIR_MODE, STATE_FILE_MODE, stateDirLayout } from "../daemon/state-dir.js";
import {
  endpointGone,
  lanAddress,
  ownerOnly,
  protectionOf,
  testIpcEndpoint,
} from "../daemon/testing/platform.js";
import { writeSelfSignedCertificate } from "../daemon/testing/self-signed.js";
import {
  CHILD_SERVE,
  CHILD_SERVE_JOB,
  type SpawnedChild,
  spawnEntry,
  untilGone,
} from "../daemon/testing/spawn-child.js";
import { ALLOW_HOST_FLAG, TLS_CERT_FLAG, TLS_KEY_FLAG } from "../daemon/tls.js";
import { TOKEN_FILE, TOKEN_FILE_ENV } from "../daemon/token.js";
import { isAlive } from "../daemon/worker-identity.js";
import type { CliIo } from "../io.js";
import { createProgram } from "../program.js";
import { SETTING_FLAGS } from "../runtime/launch-spec.js";
import { DRAIN_PATH } from "../server.js";
import { recordTestToolchain } from "../setup/testing/toolchain.js";
import { VIDEOS_DIR_ENV, WORKSPACE_DIR_NAME } from "../workspace-root.js";
import { createServeCommand } from "./serve.js";

/** P1-7's whole budget: the 20 s drain plus teardown. */
const SHUTDOWN_BUDGET_MS = 25_000;

/**
 * `xplainer token rotate <argv…>` through the real program, in this process.
 *
 * The *daemon* is the spawned child and this is the operator's other terminal, which is the shape
 * the rotation actually has: two processes and one pair of files between them.
 *
 * @returns the exit code the command asked for, or `undefined` when it asked for none.
 */
async function rotate(argv: readonly string[]): Promise<number | undefined> {
  let requested: number | undefined;
  const io: CliIo = {
    writeOut(): void {},
    writeErr(): void {},
    exit(code): never {
      requested = code;
      throw new Error(`xplainer token rotate exited ${String(code)}`);
    },
  };
  await createProgram(io).parseAsync(["token", "rotate", ...argv], { from: "user" });
  return requested;
}

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

/**
 * Ask a daemon to stop the way a supervisor on this platform asks.
 *
 * `SIGTERM` on POSIX, which is what `systemctl --user stop` and `launchctl bootout` send and what
 * ADR 0024's drain is written against. **Windows has no such signal**: `child.kill("SIGTERM")` is
 * `TerminateProcess`, no handler runs, the daemon dies mid-write and `runtime.json` is left behind
 * — so the planned stop there is `POST /api/daemon/drain` over the pipe, which is what ADR 0025
 * makes the restart route and what `daemon restart` sends. The six steps that follow are the same
 * on all three, which is why every assertion after this call is.
 */
async function beginPlannedShutdown(child: SpawnedChild, socketPath: string): Promise<void> {
  if (process.platform === "win32") {
    const acknowledgement = await postDrain(socketPath);
    expect(acknowledgement.status).toBe(202);
    return;
  }
  child.process.kill("SIGTERM");
}

/**
 * Start a daemon and wait for the line ADR 0025 §Part three makes the readiness signal.
 *
 * The fixture records a toolchain first. Every test in this file is about something else — the
 * token, the settings, the drain, the socket — and a daemon whose toolchain is absent now answers
 * `/healthz` with `{"status":"degraded","reason":"toolchain_missing"}` (T19), which is correct and
 * is asserted where it is the subject (`server.test.ts`, and `scripts/e2e/toolchain.mjs` against a
 * real acquisition). Recording one here is what keeps `ok` meaning "this daemon is healthy" rather
 * than "this fixture forgot to run setup".
 */
async function serveUntilReady(
  entry: string,
  stateDir: string,
  env: Record<string, string> = {},
): Promise<{ child: SpawnedChild; ready: ReadyAnnouncement; token: string }> {
  recordTestToolchain({
    stateDir,
    workspaceRoot: env[VIDEOS_DIR_ENV] ?? join(stateDir, WORKSPACE_DIR_NAME),
  });
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

/**
 * `POST /api/daemon/drain` over the socket, with no token and no headers but the authority.
 *
 * The same `node:http` route the `/healthz` helper takes, and for the same reason: `fetch` has no
 * supported way to name a socket path. Written out here rather than reusing the daemon's own client
 * (`daemon/control.ts`) so that what this test asserts is the wire — a `202` and a JSON body on a
 * connection that was not reset — and not this package agreeing with itself.
 */
function postDrain(socketPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const call = request(
      { socketPath, path: DRAIN_PATH, method: "POST", headers: { host: "xplainer.ipc" } },
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

/**
 * One `GET /healthz` over TLS, with exactly the headers given and the certificate pinned.
 *
 * Two options are set explicitly and neither is decoration. **`servername`**, because Node derives
 * SNI from the `Host` header when none is given, so `Host: evil.com` would fail the certificate
 * check before the guard ever saw it and would prove the wrong thing entirely; it is a DNS name in
 * the certificate rather than the address, since Node deprecates an IP there (RFC 6066).
 * **`checkServerIdentity`**, so the name verified is the address this request actually dialled and
 * not whichever one SNI carried. `rejectUnauthorized` stays on — `ca` is the daemon's own
 * certificate — so this is a real handshake against a real chain, not an encrypted socket nobody
 * checked.
 */
function getHealthzOverTls(
  target: { host: string; port: number; ca: string; servername: string },
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const call = secureRequest(
      {
        host: target.host,
        port: target.port,
        path: "/healthz",
        method: "GET",
        headers,
        ca: target.ca,
        servername: target.servername,
        checkServerIdentity: (_presented, certificate) =>
          checkServerIdentity(target.host, certificate),
        agent: false,
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
  it("is 32 bytes, reachable only by this account, and is required by /healthz", async () => {
    const stateDir = stateDirectory();

    const { child, ready, token } = await serveUntilReady(CHILD_SERVE, stateDir);

    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    // `0600` inside a `0700` directory on POSIX. On Windows `stat` reports `0666` for both — Node
    // documents that the owner/group/other distinction is not implemented there — and the protection
    // is the explicit ACL of ADR 0020 §R-SEC-5, which `daemon/windows-acl.ts` applies at creation.
    expect(protectionOf(join(stateDir, TOKEN_FILE))).toBe(ownerOnly(STATE_FILE_MODE));
    // The directory **this daemon** made, not the one `mkdtemp` handed the test: `mkdtemp` creates
    // `0700` on POSIX and an inheriting directory on Windows, so the state directory itself would
    // have asserted the temporary-file API on one platform and nothing at all on the other. Both
    // platforms narrow at creation and leave a directory that was already there as they found it,
    // so `<state>/jobs` is where that rule is observable.
    expect(protectionOf(stateDirLayout(stateDir).jobs)).toBe(ownerOnly(STATE_DIR_MODE));
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
    expect(protectionOf(elsewhere)).toBe(ownerOnly(STATE_FILE_MODE));
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

  /**
   * R-SEC-8's rotation against a daemon that is **running**, which is the only place it can be
   * proved: the guard holds no string, so the value written by another process reaches this daemon
   * without a restart, and both values open it until the window closes.
   *
   * The rotation goes through the real `xplainer token rotate` — this process's program, the
   * daemon's is the spawned child — because a test that wrote the two files itself would prove the
   * ring and not the command.
   */
  it("accepts a rotated token, and the retired one, without restarting", async () => {
    const stateDir = stateDirectory();
    const { ready, token } = await serveUntilReady(CHILD_SERVE, stateDir);
    const authorised = (value: string): Record<string, string> => ({
      host: `127.0.0.1:${ready.port}`,
      authorization: `Bearer ${value}`,
    });

    expect((await getHealthz({ port: ready.port }, authorised(token))).status).toBe(200);

    expect(await rotate(["--state-dir", stateDir, "--grace", "600"])).toBeUndefined();
    const rotated = readFileSync(join(stateDir, TOKEN_FILE), "utf8").trim();
    expect(rotated).not.toBe(token);

    // The new value, on a daemon that has been up since before the file changed.
    expect((await getHealthz({ port: ready.port }, authorised(rotated))).status).toBe(200);
    // And the retired one, which is the whole of what the window buys: an agent holding the old
    // value in its environment keeps working until somebody restarts it.
    expect((await getHealthz({ port: ready.port }, authorised(token))).status).toBe(200);

    const record = readDaemonState(stateDir).token_rotation;
    expect(record?.previous_token_file).toBe(`${join(stateDir, TOKEN_FILE)}.previous`);

    // Closing the window is the same command with no window, and it takes effect on the next
    // request rather than on the next start.
    expect(await rotate(["--state-dir", stateDir, "--grace", "0"])).toBeUndefined();
    const third = readFileSync(join(stateDir, TOKEN_FILE), "utf8").trim();
    expect((await getHealthz({ port: ready.port }, authorised(token))).status).toBe(401);
    expect((await getHealthz({ port: ready.port }, authorised(rotated))).status).toBe(401);
    expect((await getHealthz({ port: ready.port }, authorised(third))).status).toBe(200);
  }, 30_000);
});

/**
 * The three settings, and the reason they are flags at all.
 *
 * Task Scheduler's `<Exec>` action carries a command, a working directory and arguments and has
 * **no per-action environment map**, so on Windows an installed daemon told where its state lives
 * only through `XPLAINER_STATE_DIR` would silently take the platform default while `daemon.json`
 * recorded something else — and T17's consistency check would compare an environment that was never
 * delivered. Every assertion below is therefore about a **real process**: what it read, what it
 * bound, and what it wrote down afterwards.
 */
describe("the three settings options", () => {
  /**
   * The launch contract builds the argv this command has to parse. A spelling that changed on one
   * side and not the other would be a daemon that refuses the vector its own installer wrote, so
   * the two are compared rather than trusted to stay in step.
   */
  it("is spelled exactly as the launch contract emits it", () => {
    const silent: CliIo = {
      writeOut: () => {},
      writeErr: () => {},
      exit: (): never => {
        throw new Error("not expected");
      },
    };

    const flags = createServeCommand(silent)
      .options.map((option) => option.long)
      .filter((long): long is string => long !== null && long !== undefined);

    expect(flags).toContain(SETTING_FLAGS.stateDir);
    expect(flags).toContain(SETTING_FLAGS.tokenFile);
    expect(flags).toContain(SETTING_FLAGS.socket);
  });

  it("takes each flag over its variable, and binds and writes where the flag said", async () => {
    const stateDir = stateDirectory();
    const decoyStateDir = stateDirectory();
    const decoyToken = join(stateDirectory(), "decoy-token");
    const tokenFile = join(stateDir, "delivered-token");
    const socket = testIpcEndpoint(join(stateDir, "run"));

    const child = run(
      CHILD_SERVE,
      [
        "--port",
        "0",
        SETTING_FLAGS.stateDir,
        stateDir,
        SETTING_FLAGS.tokenFile,
        tokenFile,
        SETTING_FLAGS.socket,
        socket,
      ],
      { XPLAINER_STATE_DIR: decoyStateDir, [TOKEN_FILE_ENV]: decoyToken },
    );
    const ready = await waitForReadyLine(child.process, { timeoutMs: 20_000 });

    // The socket the daemon announces is the one it was told to bind, and it answers there.
    expect(ready.socket).toBe(socket);
    const overSocket = await getHealthz({ socketPath: socket });
    expect(overSocket.status).toBe(200);

    // The token is a file at the given path that only this account can read, and it is the token
    // the TCP guard accepts.
    expect(protectionOf(tokenFile)).toBe(ownerOnly(STATE_FILE_MODE));
    const token = readFileSync(tokenFile, "utf8").trim();
    const overTcp = await getHealthz({ port: ready.port }, { authorization: `Bearer ${token}` });
    expect(overTcp.status).toBe(200);

    // The `0700` rule followed the path: it is the socket's own directory that is narrowed. A
    // named pipe has no directory to narrow, and `prepareIpcSocket` makes nothing for it — the
    // assertion there is that `--socket` moved the endpoint at all, which the two above are.
    if (!isNamedPipe(socket)) {
      expect(protectionOf(dirname(socket))).toBe(ownerOnly(STATE_DIR_MODE));
    }

    // The state directory is the flag's, and `daemon.json` records what this process used.
    const daemonState = JSON.parse(
      readFileSync(stateDirLayout(stateDir).daemonState, "utf8"),
    ) as Record<string, unknown>;
    expect(daemonState.token_file).toBe(tokenFile);
    expect(daemonState.socket_path).toBe(socket);
    expect(daemonState.port).toBe(ready.port);

    // Nothing at all happened where the variables pointed.
    expect(readdirSync(decoyStateDir)).toEqual([]);
    expect(existsSync(decoyToken)).toBe(false);
    // And the daemon said which input decided each one, so a delivery that silently did not
    // arrive is visible in the log rather than only in a later failure.
    expect(child.stderr()).toContain("settings from flag/flag/flag");
  }, 30_000);

  /**
   * The other half of the two-writer split: `install` owns the supervisor fields and `serve` owns
   * the run's, and a `serve` that rewrote `daemon.json` from its own narrow view would silently
   * uninstall the daemon it is part of. Asserted against a real start, because the preservation is
   * a property of the read-modify-write this process performs and not of a function call.
   */
  it("preserves every daemon.json field the installer owns while writing its own", async () => {
    const stateDir = stateDirectory();
    const installed = {
      supervisor_kind: "launchd",
      supervisor_artefact: "/Users/a/Library/LaunchAgents/video.xplainer.daemon.plist",
      runtime_dir: "/state/runtime/1.0.0-abc",
      launch_spec: {
        executable: "/state/runtime/1.0.0-abc/bin/node",
        argv: ["/entry.js", "serve"],
        settings: { stateDir: "/state", tokenFile: "/state/token", socket: "/state/ipc/x.sock" },
        cwd: "/state",
      },
      program_source: "runtime-dir",
      linger_enabled_by_us: true,
      log_sink: "/Users/a/Library/Logs/xplainer/daemon.log",
      installed_version: "0.0.1-installed",
    };
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stateDirLayout(stateDir).daemonState, JSON.stringify(installed));

    const { ready } = await serveUntilReady(CHILD_SERVE, stateDir);

    const after = JSON.parse(readFileSync(stateDirLayout(stateDir).daemonState, "utf8")) as Record<
      string,
      unknown
    >;
    for (const [key, value] of Object.entries(installed)) {
      expect(after[key]).toEqual(value);
    }
    expect(after.port).toBe(ready.port);
    expect(after.socket_path).toBe(ready.socket);
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

/**
 * ADR 0020 §Security R-SEC-9, as a process a supervisor could really start.
 *
 * The refusals are asserted where they matter — **before anything is bound**, and for the four that
 * argv alone decides, before the state directory is even taken — because a daemon that discovered a
 * missing certificate after binding would already have been reachable, unencrypted, on the address
 * the operator was trying to protect. `192.0.2.10` is RFC 5737 TEST-NET-1 and is never bound by any
 * of these: the refusal happens first, which is the property, so the address only has to be
 * non-loopback and not a machine anybody has.
 *
 * The last case is the one the CVE is about, and it needs a real listener on a real non-loopback
 * address ({@link lanAddress}), a real certificate ({@link writeSelfSignedCertificate}) and a real
 * TLS handshake. `node:https` rather than `fetch` for the same reason the rest of this file uses
 * `node:http`: `fetch` writes the `Host` header itself, and `Host` is the whole subject.
 */
describe("a non-loopback bind, and the five things R-SEC-9 makes it cost", () => {
  it.each([
    ["::", ["--bind", "::"], "binds every interface"],
    [":: even when acknowledged", ["--bind", "::", REMOTE_EXPOSURE_FLAG], "refused"],
    [
      "a remote bind with the acknowledgement and nothing else",
      ["--bind", "192.0.2.10", REMOTE_EXPOSURE_FLAG],
      TLS_CERT_FLAG,
    ],
    [
      "a remote bind with half a TLS pair",
      ["--bind", "192.0.2.10", REMOTE_EXPOSURE_FLAG, TLS_CERT_FLAG, "/nowhere/tls.crt"],
      TLS_KEY_FLAG,
    ],
    [
      "a remote bind with TLS and no operator allowlist",
      [
        "--bind",
        "192.0.2.10",
        REMOTE_EXPOSURE_FLAG,
        TLS_CERT_FLAG,
        "/nowhere/tls.crt",
        TLS_KEY_FLAG,
        "/nowhere/tls.key",
      ],
      ALLOW_HOST_FLAG,
    ],
    [
      "TLS on a loopback bind, which would break every local caller",
      [TLS_CERT_FLAG, "/nowhere/tls.crt", TLS_KEY_FLAG, "/nowhere/tls.key"],
      "xplainer status",
    ],
  ])(
    "refuses %s before it takes the state directory",
    async (_case, args, expected) => {
      const stateDir = stateDirectory();

      const child = run(CHILD_SERVE, [...args, "--port", "0"], { XPLAINER_STATE_DIR: stateDir });
      const exit = await child.waitForExit();

      expect(exit.code).toBe(1);
      expect(child.stderr()).toContain(expected);
      expect(child.stdout()).toBe("");
      expect(readdirSync(stateDir)).toEqual([]);
    },
    30_000,
  );

  it("refuses a certificate that is not there, still before ownership", async () => {
    const stateDir = stateDirectory();

    const child = run(
      CHILD_SERVE,
      [
        "--port",
        "0",
        "--bind",
        "192.0.2.10",
        REMOTE_EXPOSURE_FLAG,
        TLS_CERT_FLAG,
        join(stateDir, "absent.crt"),
        TLS_KEY_FLAG,
        join(stateDir, "absent.key"),
        ALLOW_HOST_FLAG,
        "daemon.internal",
      ],
      { XPLAINER_STATE_DIR: stateDir },
    );
    const exit = await child.waitForExit();

    expect(exit.code).toBe(1);
    expect(child.stderr()).toContain("could not read the TLS certificate");
    expect(child.stderr()).toContain("Nothing has been bound.");
    expect(readdirSync(stateDir)).toEqual([]);
  }, 30_000);

  /**
   * The fifth precondition is the only one that needs the state directory, so this refusal happens
   * *after* ownership — and gives it back. It is also asked **before the mint**, which is the
   * correction of 2026-09-08: this start used to create the token file and then refuse itself over
   * the credential it had just written, leaving a `0600` secret and a `token_origin` behind on a
   * path R-SEC-9 says must be left as it was found.
   */
  it("refuses a remote bind with no token, having minted nothing", async () => {
    const stateDir = stateDirectory();
    const certificate = writeSelfSignedCertificate(stateDir, { names: ["192.0.2.10"] });

    const child = run(
      CHILD_SERVE,
      [
        "--port",
        "0",
        "--bind",
        "192.0.2.10",
        REMOTE_EXPOSURE_FLAG,
        TLS_CERT_FLAG,
        certificate.certPath,
        TLS_KEY_FLAG,
        certificate.keyPath,
        ALLOW_HOST_FLAG,
        "daemon.internal",
      ],
      { XPLAINER_STATE_DIR: stateDir },
    );
    const exit = await child.waitForExit();

    expect(exit.code).toBe(1);
    expect(child.stderr()).toContain("there is no bearer token at");
    expect(child.stderr()).toContain("Nothing has been minted here and nothing has been bound");
    // The sentence a refusal may never say about a file this daemon did not write.
    expect(child.stderr()).not.toContain("is the one this daemon minted for itself");
    expect(child.stdout()).toBe("");
    // No token file, and no answer recorded about whose token it is — because there is none.
    expect(existsSync(join(stateDir, TOKEN_FILE))).toBe(false);
    expect(readDaemonState(stateDir).token_origin).toBeNull();
    // Nothing was bound, and the state directory was given back: `runtime.json` is written by
    // `markReady()` and `owner.lock` by the acquisition this refusal released.
    expect(readRuntimeState(stateDir)).toBeNull();
    expect(existsSync(stateDirLayout(stateDir).lock)).toBe(false);
  }, 30_000);

  /** The refusal that is true: a loopback start really did mint this file, and says so. */
  it("refuses the token it minted for itself on an earlier start, and binds nothing", async () => {
    const stateDir = stateDirectory();
    const certificate = writeSelfSignedCertificate(stateDir, { names: ["192.0.2.10"] });
    const first = await serveUntilReady(CHILD_SERVE, stateDir);
    await beginPlannedShutdown(first.child, first.ready.socket ?? "");
    await first.child.waitForExit();

    const child = run(
      CHILD_SERVE,
      [
        "--port",
        "0",
        "--bind",
        "192.0.2.10",
        REMOTE_EXPOSURE_FLAG,
        TLS_CERT_FLAG,
        certificate.certPath,
        TLS_KEY_FLAG,
        certificate.keyPath,
        ALLOW_HOST_FLAG,
        "daemon.internal",
      ],
      { XPLAINER_STATE_DIR: stateDir },
    );
    const exit = await child.waitForExit();

    expect(exit.code).toBe(1);
    expect(child.stderr()).toContain("is the one this daemon minted for itself");
    expect(child.stderr()).toContain(join(stateDir, TOKEN_FILE));
    expect(readDaemonState(stateDir).token_origin).toBe("minted");
    expect(readRuntimeState(stateDir)).toBeNull();
    expect(existsSync(stateDirLayout(stateDir).lock)).toBe(false);
  }, 40_000);

  /**
   * The record has to survive a start that never bound, because that is when it is written.
   *
   * `token_origin` and `token_file` are one fact about one file, and they used to be written at two
   * different moments: the origin the instant the token was minted, the path only at `markReady()`
   * after both listeners were up. Any ordinary failed start therefore left `minted` on disk with no
   * path beside it — a held port, a certificate pair that will not load, a socket path this platform
   * refuses — and `resolveTokenOrigin` read "the record names no file of mine" and answered
   * `operator` for the very token this daemon had minted seconds earlier. The next `--bind` then met
   * R-SEC-9's fifth precondition without an operator having supplied anything, and said so: "with an
   * operator token from `<state>/token`", about a file nobody but this daemon had ever written.
   */
  it("still refuses its own minted token after a start that failed before it bound", async () => {
    const stateDir = stateDirectory();
    const certificate = writeSelfSignedCertificate(stateDir, { names: ["192.0.2.10"] });

    // A start that gets as far as the mint and no further: the port is taken, so it exits 10 from
    // the bind, long after `loadOrMintToken` created the file and long before `markReady()`.
    const squatter = createServer();
    await new Promise<void>((listening) => {
      squatter.listen(0, "127.0.0.1", listening);
    });
    const held = squatter.address();
    const heldPort = typeof held === "object" && held !== null ? held.port : 0;
    try {
      const failed = run(CHILD_SERVE, ["--port", String(heldPort)], {
        XPLAINER_STATE_DIR: stateDir,
      });
      expect((await failed.waitForExit()).code).toBe(10);
    } finally {
      await new Promise<void>((closed) => {
        squatter.close(() => {
          closed();
        });
      });
    }

    // The mint happened, and the record answers for the file it made — both halves, or neither.
    const tokenPath = join(stateDir, TOKEN_FILE);
    expect(existsSync(tokenPath)).toBe(true);
    const afterFailure = readDaemonState(stateDir);
    expect(afterFailure.token_origin).toBe("minted");
    expect(afterFailure.token_file).toBe(tokenPath);

    const child = run(
      CHILD_SERVE,
      [
        "--port",
        "0",
        "--bind",
        "192.0.2.10",
        REMOTE_EXPOSURE_FLAG,
        TLS_CERT_FLAG,
        certificate.certPath,
        TLS_KEY_FLAG,
        certificate.keyPath,
        ALLOW_HOST_FLAG,
        "daemon.internal",
      ],
      { XPLAINER_STATE_DIR: stateDir },
    );
    const exit = await child.waitForExit();

    expect(exit.code).toBe(1);
    expect(child.stderr()).toContain("is the one this daemon minted for itself");
    expect(child.stdout()).toBe("");
    expect(readRuntimeState(stateDir)).toBeNull();
    expect(existsSync(stateDirLayout(stateDir).lock)).toBe(false);
  }, 40_000);

  /**
   * The other half of the same correction, and the case the record used to make unreachable.
   *
   * `token_origin` answers for the file `token_file` names and for no other. A state directory that
   * has already minted its own token is exactly the machine an operator then points `--token-file`
   * at a token of their own from — and inheriting the recorded `minted` there refused that token
   * for ever, in a sentence claiming this daemon had written a file it had never seen.
   */
  it("takes an operator's token at another path after this directory minted its own", async () => {
    const stateDir = stateDirectory();
    const address = lanAddress();
    const certificate = writeSelfSignedCertificate(stateDir, {
      names: [address, "daemon.internal"],
    });
    const first = await serveUntilReady(CHILD_SERVE, stateDir);
    await beginPlannedShutdown(first.child, first.ready.socket ?? "");
    await first.child.waitForExit();
    expect(readDaemonState(stateDir).token_origin).toBe("minted");

    const operatorToken = join(stateDirectory(), "operator-token");
    const token = randomBytes(32).toString("base64url");
    writeFileSync(operatorToken, `${token}\n`, { mode: 0o600 });

    const child = run(
      CHILD_SERVE,
      [
        "--port",
        "0",
        "--bind",
        address,
        REMOTE_EXPOSURE_FLAG,
        TLS_CERT_FLAG,
        certificate.certPath,
        TLS_KEY_FLAG,
        certificate.keyPath,
        ALLOW_HOST_FLAG,
        "daemon.internal",
        "--token-file",
        operatorToken,
      ],
      { XPLAINER_STATE_DIR: stateDir },
    );
    const ready = await waitForReadyLine(child.process, { timeoutMs: 20_000 });

    const answered = await getHealthzOverTls(
      { host: address, port: ready.port, ca: certificate.cert, servername: "daemon.internal" },
      { authorization: `Bearer ${token}`, host: `daemon.internal:${ready.port}` },
    );
    expect(answered.status).toBe(200);
    const state = readDaemonState(stateDir);
    expect(state.token_origin).toBe("operator");
    // The record now answers for the file this start actually read.
    expect(state.token_file).toBe(operatorToken);
    await beginPlannedShutdown(child, ready.socket ?? "");
    await child.waitForExit();
  }, 40_000);

  it("serves TLS to an operator's allowlist, and still answers 403 to Host: evil.com", async () => {
    const stateDir = stateDirectory();
    const address = lanAddress();
    const certificate = writeSelfSignedCertificate(stateDir, {
      names: [address, "daemon.internal"],
    });
    // The operator's token, written before this daemon ever runs: a file `serve` finds rather
    // than makes is what `resolveTokenOrigin()` calls the operator's, and it is the only kind
    // R-SEC-9 lets guard a remote listener.
    const token = randomBytes(32).toString("base64url");
    writeFileSync(join(stateDir, TOKEN_FILE), `${token}\n`, { mode: 0o600 });
    recordTestToolchain({ stateDir, workspaceRoot: join(stateDir, WORKSPACE_DIR_NAME) });

    const child = run(
      CHILD_SERVE,
      [
        "--port",
        "0",
        "--bind",
        address,
        REMOTE_EXPOSURE_FLAG,
        TLS_CERT_FLAG,
        certificate.certPath,
        TLS_KEY_FLAG,
        certificate.keyPath,
        ALLOW_HOST_FLAG,
        address,
        ALLOW_HOST_FLAG,
        "daemon.internal",
      ],
      { XPLAINER_STATE_DIR: stateDir },
    );
    const ready = await waitForReadyLine(child.process, { timeoutMs: 20_000 });
    const target = {
      host: address,
      port: ready.port,
      ca: certificate.cert,
      servername: "daemon.internal",
    };
    const authorized = { authorization: `Bearer ${token}` };

    // The certificate is verified rather than waved through: `ca` is the one this daemon was
    // given, and the connection is to the address its subjectAltName names.
    expect(
      (await getHealthzOverTls(target, { ...authorized, host: `${address}:${ready.port}` })).status,
    ).toBe(200);
    expect(
      (await getHealthzOverTls(target, { ...authorized, host: `daemon.internal:${ready.port}` }))
        .status,
    ).toBe(200);
    // Loopback is still on the list. Widening a bind adds authority and removes none — which is
    // the sentence CVE-2026-65105 is the counterexample to.
    expect(
      (await getHealthzOverTls(target, { ...authorized, host: `127.0.0.1:${ready.port}` })).status,
    ).toBe(200);

    const impostor = await getHealthzOverTls(target, {
      ...authorized,
      host: `evil.com:${ready.port}`,
    });
    expect(impostor.status).toBe(403);
    expect(impostor.body).toContain("FORBIDDEN_HOST");

    // The token is still asked for, on the widened bind, on `/healthz`.
    const unauthenticated = await getHealthzOverTls(target, { host: `${address}:${ready.port}` });
    expect(unauthenticated.status).toBe(401);

    expect(child.stderr()).toContain(`bound ${address}, which is not loopback, over TLS from`);
    expect(child.stderr()).toContain(certificate.certPath);
    const state = readDaemonState(stateDir);
    expect(state.token_origin).toBe("operator");
    expect(state.port).toBe(ready.port);
    expect(readRuntimeState(stateDir)?.addresses).toEqual([`https://${address}:${ready.port}`]);
  }, 40_000);
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
    expect(ready.socket).toBe(resolveIpcPath(stateDir));
    // Bound, rather than present: on Windows the endpoint is a named pipe and there is no file to
    // find. One authenticated-by-the-filesystem `GET` is the fact on both.
    expect((await getHealthz({ socketPath: ready.socket ?? "" })).status).toBe(200);

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
      // `null` because this daemon's toolchain is fine, not because the field is absent: the body's
      // shape is the same either way, so a reader never has to tell "this release has no such
      // field" apart from "this daemon can render" (T19).
      reason: null,
      version: expect.any(String),
      contract_version: MCP_CONTRACT_VERSION,
      // The identity a supervised daemon advertises about itself: the ownership acquisition's own
      // nonce, and the startup snapshot `daemon/start.ts` froze before this listener bound. They
      // are asserted as *present and non-empty* here, because what this case is about is the two
      // listeners; `install/supervisors/identity.test.ts` is where the values are recomputed from
      // the launch that produced them.
      run_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      runtime_digest: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
  }, 30_000);

  /**
   * **The Windows half makes the same claim about a different mechanism.** A named pipe is a
   * machine-global name rather than a filesystem entry: there is no directory to narrow, no mode to
   * set and nothing to unlink, so `<state>/ipc/` is never created there and the `0700` assertion
   * below has nothing to be about. The access control is the **pipe's own security descriptor**,
   * which `net.Server.listen({ path })` cannot be given and `daemon/pipe-acl.ts` therefore replaces
   * immediately after the bind — and the sentence `serve` prints is where that outcome is legible,
   * because a descriptor is not a file and there is no `stat` to read it off.
   *
   * `existsSync` is deliberately **not** asked here, in either direction. libuv implements
   * `uv_fs_stat` on `\\.\pipe\<name>` by opening the pipe for its attributes, so the answer is
   * `true` while a server instance is free and `false` while every instance is busy: a property of
   * the connection pool rather than of the endpoint, which `endpointGone` in
   * `daemon/testing/platform.ts` is why it dials the pipe instead.
   */
  it("puts the socket where only this account can reach it, which is what that authentication is", async () => {
    const stateDir = stateDirectory();
    const { child, ready } = await serveUntilReady(CHILD_SERVE, stateDir);
    const socketPath = ready.socket ?? "";

    expect(socketPath).toBe(resolveIpcPath(stateDir));
    if (isNamedPipe(socketPath)) {
      expect(socketPath).toBe(resolveIpcPath(stateDir, "win32"));
      expect(socketPath).not.toBe(resolveIpcPath(stateDirectory(), "win32"));
      expect(existsSync(join(stateDir, IPC_DIR))).toBe(false);
      expect(child.stderr()).toContain(
        `also listening on ${socketPath}, where a security descriptor granting`,
      );
      expect(child.stderr()).toContain("and nobody else is the authentication");
      expect((await getHealthz({ socketPath })).status).toBe(200);
      return;
    }
    expect(socketPath).toBe(join(stateDir, IPC_DIR, IPC_SOCKET_FILE));
    expect(protectionOf(dirname(socketPath))).toBe(ownerOnly(STATE_DIR_MODE));
    expect(statSync(socketPath).isSocket()).toBe(true);
  }, 30_000);

  /**
   * Step 6 of ADR 0024's drain is "remove `runtime.json` **and the socket**, exit `0`", and the
   * socket half is why: a socket file that outlives its daemon is a path `mcp --attach` dials and
   * finds nothing behind — a `ECONNREFUSED` where an honest `ENOENT` would have said "no daemon".
   */
  it("leaves nothing answering on the socket after a clean shutdown, along with runtime.json", async () => {
    const stateDir = stateDirectory();
    const { child, ready } = await serveUntilReady(CHILD_SERVE, stateDir);
    const socketPath = ready.socket ?? "";
    expect((await getHealthz({ socketPath })).status).toBe(200);

    await beginPlannedShutdown(child, socketPath);
    const exit = await child.waitForExit();

    expect(exit.code).toBe(0);
    expect(await endpointGone(socketPath)).toBe(true);
    if (!isNamedPipe(socketPath)) {
      // The directory stays: it is `0700` and the next start binds into it again. A named pipe has
      // no directory, which is why `prepareIpcSocket` reports `removeOnShutdown: false` for one.
      expect(existsSync(dirname(socketPath))).toBe(true);
    }
    expect(readdirSync(stateDir)).not.toContain("runtime.json");
  }, 30_000);
});

/**
 * A supervisor's planned stop, whichever form this platform's supervisor has.
 *
 * `SIGTERM` on the two platforms that have one. Windows does not: `TerminateProcess` runs no
 * handler, so the same six steps are asked for over the pipe, which is the route ADR 0025 gives
 * `daemon restart` and the only graceful stop that platform has. What follows the ask is identical
 * on all three, and is asserted identically.
 */
describe("a planned stop", () => {
  it(
    "drains the running job, stops its process group, removes runtime.json and exits 0",
    async () => {
      const stateDir = stateDirectory();
      const { child, ready } = await serveUntilReady(CHILD_SERVE_JOB, stateDir, {
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
      await beginPlannedShutdown(child, ready.socket ?? "");
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

/**
 * The drain route, against a real spawned `serve` with a real job under it.
 *
 * `server.test.ts` owns the seam — which listener may reach the route, and that the answer is
 * written before the listeners close. What can only be asserted about a **process** is the rest of
 * it: that a `202` over the socket produces the same six steps a `SIGTERM` produces, ending in exit
 * `0`, with the worker's whole process group gone, the job marked `daemon_shutdown`, and
 * `runtime.json` and the socket removed. This is the route `xplainer daemon restart` calls and the
 * only graceful stop Windows has, where `SIGTERM` is `TerminateProcess` and no handler ever runs.
 */
describe("POST /api/daemon/drain over the socket", () => {
  it(
    "runs the same six steps a SIGTERM does, and exits 0",
    async () => {
      const stateDir = stateDirectory();
      const { child, ready } = await serveUntilReady(CHILD_SERVE_JOB, stateDir, {
        XPLAINER_TEST_WORKER: JSON.stringify({ lines: 3, lifeMs: 60_000, grandchild: true }),
      });
      const announced = await child.waitForLine('"event":"job"');
      const { job_id: jobId, worker_pid: workerPid } = JSON.parse(announced) as {
        job_id: number;
        worker_pid: number;
      };
      strays.push(workerPid);
      const socketPath = ready.socket ?? "";
      expect(createJobStore(stateDir).read(jobId)?.status).toBe("running");

      const sentAt = Date.now();
      const acknowledgement = await postDrain(socketPath);

      // The answer is complete — a body, on a connection that was not reset — and it names this
      // daemon's own pid and its own cap rather than anything the caller assumed.
      expect(acknowledgement.status).toBe(202);
      expect(JSON.parse(acknowledgement.body)).toEqual({
        event: "draining",
        timeout_ms: DEFAULT_DRAIN_TIMEOUT_MS,
        pid: ready.pid,
        already_draining: false,
      });

      const exit = await child.waitForExit();
      expect(exit.code).toBe(0);
      expect(Date.now() - sentAt).toBeLessThan(SHUTDOWN_BUDGET_MS);
      expect(child.stderr()).toContain(`POST ${DRAIN_PATH}`);

      // Steps 3 to 6, exactly as the signal produces them.
      expect(await untilGone(workerPid)).toBe(true);
      expect(await endpointGone(socketPath)).toBe(true);
      expect(readdirSync(stateDir)).not.toContain("runtime.json");
      const drained = createJobStore(stateDir).read(jobId);
      expect(drained?.status).toBe("error");
      expect(drained?.error_code).toBe("daemon_shutdown");
    },
    SHUTDOWN_BUDGET_MS + 30_000,
  );

  /**
   * The negative, against the daemon's own minted token rather than a made-up one: the bearer token
   * is what lets an agent render on this machine, and it must not also be what stops the daemon.
   * The daemon is still serving afterwards, which is what makes the `404` a refusal and not a
   * different way of draining.
   */
  it("is 404 over TCP with the daemon's own bearer token, and the daemon keeps serving", async () => {
    const stateDir = stateDirectory();
    const { ready, token } = await serveUntilReady(CHILD_SERVE, stateDir);

    const refused = await getHealthz({ port: ready.port }, { authorization: `Bearer ${token}` });
    const overTcp = await new Promise<number>((resolve, reject) => {
      const call = request(
        {
          host: "127.0.0.1",
          port: ready.port,
          path: DRAIN_PATH,
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      call.once("error", reject);
      call.end();
    });

    expect(refused.status).toBe(200);
    expect(overTcp).toBe(404);
    // Still there, and still answering on the listener that is allowed to ask.
    expect((await getHealthz({ socketPath: ready.socket ?? "" })).status).toBe(200);
  }, 30_000);
});
