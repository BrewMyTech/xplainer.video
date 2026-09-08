/**
 * `xplainer serve` — the local daemon.
 *
 * The command's shape is now the ordering
 * [ADR 0024](../../../../docs/adr/0024-durable-jobs-and-boot-reconciliation.md) makes an invariant:
 * **acquire exclusive ownership of the state directory, reconcile the jobs left behind by the last
 * run, and only then bind.** `../daemon/start.ts` does the first two and hands back a job runner;
 * this file does the third, and tells the runner which port it landed on.
 *
 * A process that cannot acquire ownership exits `10` **having written nothing** — not after
 * reconciling, which would have rewritten a live daemon's records on its way out. That is the
 * failure ADR 0020's own note describes: "the argument that a second `serve` is harmless because
 * the recorded port makes it exit `10` holds only at **bind**, and reconciliation happens earlier".
 *
 * Around that ordering sit the five things
 * [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md) §`serve` stays a foreground
 * process calls "prerequisites rather than extras", and each one is a module rather than a branch
 * here:
 *
 * - **The bearer token** (`../daemon/token.ts`) and **the guard** (`../daemon/guard.ts`), built
 *   together and handed to `startServer()` as a factory over the *bound* port, because R-SEC-2
 *   requires the `Host` allowlist to be built after bind and `--port 0` must keep working. A token
 *   file that exists and cannot be used ends the process with `12`: a daemon that cannot enforce
 *   authentication must not serve.
 * - **The IPC listener** (`../daemon/ipc.ts`), the second binding of ADR 0020 §The agent path is
 *   IPC, not TCP: a unix socket — a named pipe on Windows — inside a `0700` directory under the
 *   state directory, serving the same application with **no guard at all**, because "filesystem
 *   permissions are the authentication … the socket is exactly as strong as the uid boundary".
 *   That is the transport `xplainer mcp --attach` dials, which is why the entry
 *   `xplainer connect` writes into an agent's configuration carries no URL and no token, and why
 *   the whole DNS-rebinding class is absent from the path agents actually use rather than filtered
 *   out of it. Its path is the ready line's `socket` field and `runtime.json`'s.
 * - **The `SIGTERM` handler** (`../daemon/shutdown.ts`), which is what makes this a process a
 *   supervisor can stop: drain for at most 20 s, close the listeners, remove `runtime.json` and the
 *   socket, exit `0`. The same sequence is reachable as `POST /api/daemon/drain` **over the IPC
 *   socket only** (`../server.ts` §the drain route), which is how `xplainer daemon restart` asks
 *   for it on Windows, where Node maps `SIGTERM` to `TerminateProcess` and no handler ever runs.
 *   The route is given a seam over the handle installed below rather than a second implementation,
 *   so there is exactly one drain and one exit code however it was asked for.
 * - **State on disk** — `daemon.json` and `runtime.json`, written by `markReady()` at the moment
 *   both facts are known.
 * - **The ready line** (`../daemon/ready.ts`): one JSON line on stdout, once, after ownership,
 *   reconciliation and the binds. Everything else this command says goes to **stderr**, which is
 *   what keeps stdout a machine-readable contract for a parent that spawned the daemon
 *   ([ADR 0025](../../../../docs/adr/0025-daemon-updates-and-readiness.md) §Part three).
 *
 * What it serves the eight tools from is `../backend.ts`, built **after** those four things and
 * over this daemon's own runner and workspace root: `explainer_create`, `explainer_put_source`,
 * `explainer_put_media` and `explainer_list` write to and read from the shared Remotion workspace,
 * and `explainer_narrate`, `explainer_still` and `explainer_render` enqueue against the runner
 * `startDaemon()` handed back, which `explainer_job` then reports on.
 *
 * **Three settings, and each one is a flag above its variable.** `--state-dir`, `--token-file` and
 * `--socket` are what makes this command installable on all three supervisors: Windows' Task
 * Scheduler `<Exec>` action carries a command, a working directory and arguments and has **no
 * per-action environment map**, so a daemon that could only be told where its state lives through
 * `XPLAINER_STATE_DIR` would silently take the platform default there while `daemon.json` recorded
 * something else. The spellings are the launch contract's (`../runtime/launch-spec.ts`
 * `SETTING_FLAGS`), the precedence is the flag over the variable as everywhere else in this CLI,
 * and `--token-file` names a **path and never a token value**, so R-SEC-6 holds on the argv route
 * exactly as it did on the environment one. `--socket` has no variable at all — `../daemon/ipc.ts`
 * reads none — which is why all three travel in argv on every platform rather than only on Windows.
 * All three are written into `daemon.json` at readiness, so `xplainer status --json` reports what
 * this process used rather than what somebody intended.
 *
 * **Never add `serve --detach`.** [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md)
 * rejects self-daemonisation outright: `launchd.plist(5)` EXPECTATIONS says a job **MUST NOT**
 * "call `daemon(3)`" or "do the moral equivalent … by calling `fork(2)` and have the parent process
 * `exit(3)`", and systemd `Type=exec` and Task Scheduler expect the same. The supervisor owns the
 * process lifetime, so a `serve` that backgrounds itself is a `serve` no supervisor can supervise.
 * Detaching belongs to `xplainer daemon`.
 */

import process from "node:process";
import { MCP_CONTRACT_VERSION } from "@xplainer/protocol";
import { Command, InvalidArgumentError } from "commander";
import { createLocalBackend } from "../backend.js";
import {
  describeBindFailure,
  REMOTE_EXPOSURE_FLAG,
  resolveBindAddress,
  resolveDaemonPort,
} from "../daemon/binding.js";
import { readDaemonState } from "../daemon/daemon-state.js";
import { DAEMON_INTERNAL_EXIT_CODE, USAGE_EXIT_CODE } from "../daemon/exit-codes.js";
import { createLoopbackGuard } from "../daemon/guard.js";
import { type PreparedIpcSocket, prepareIpcSocket } from "../daemon/ipc.js";
import { formatReadyLine, readyAnnouncement } from "../daemon/ready.js";
import { DEFAULT_DRAIN_TIMEOUT_MS, type WorkerRegistry } from "../daemon/runner.js";
import { installShutdownHandlers, type ShutdownHandle } from "../daemon/shutdown.js";
import { type StartedDaemon, startDaemon } from "../daemon/start.js";
import { resolveStateDirSetting, STATE_DIR_ENV } from "../daemon/state-dir.js";
import {
  loadOrMintToken,
  resolveTokenPathSetting,
  TOKEN_FILE_ENV,
  TokenUnreadableError,
} from "../daemon/token.js";
import type { CliIo } from "../io.js";
import { DEFAULT_PORT, IpcBindError, startServer } from "../server.js";

/** The highest port a TCP listener can bind. */
const MAX_PORT = 65535;

/**
 * The three settings flags, spelled exactly as the launch contract emits them.
 *
 * `SETTING_FLAGS` in `../runtime/launch-spec.ts` is the pin, and `serve.test.ts` asserts these
 * three strings against it: the contract builds an argv this command has to parse, so a spelling
 * that changed on one side and not the other would be a daemon that refuses the vector its own
 * installer wrote. They are literals here rather than an import because a command should not pull
 * the artefact assembler into the process every time it starts, and a test that compares the two
 * makes them one edit apart just as surely.
 */
const STATE_DIR_FLAG = "--state-dir";
const TOKEN_FILE_FLAG = "--token-file";
const SOCKET_FLAG = "--socket";

/** What commander parses out of the command line. */
type ServeOptions = {
  port?: number;
  bind?: string;
  iUnderstandRemoteExposure?: boolean;
  stateDir?: string;
  tokenFile?: string;
  socket?: string;
};

/**
 * The two things a *process-level* test has to reach inside a running `serve`, and that
 * `program.ts` never passes — so the shipped command is exactly the one described above.
 *
 * The `SIGTERM` drain is a property of the process: ADR 0024 §Drain on planned restart is a
 * sequence of six steps between a signal and exit `0`, and the only honest way to assert it is to
 * signal a real `xplainer serve` with a real job under it — one that is still running 20 seconds
 * later. The real workers cannot be that job: a render finishes when it finishes, and a narration
 * needs a speech server. So the drain test substitutes a worker this machine can always run and
 * always outlast, which is `../daemon/testing/fake-worker.ts`, and starts one inside a real
 * `serve`, which is these two seams and `../daemon/testing/child-serve-job.ts`. Nothing else
 * passes them.
 *
 * `workers` is not test-only in shape: it is the registry
 * [`AGENTS.md`](../../AGENTS.md) §How to add describes, and leaving it unset is what the shipped
 * command does — `startDaemon()` then registers the real narrate, still and render workers over
 * this run's workspace root.
 */
export type ServeSeams = {
  /**
   * Which job kinds this daemon can run. Defaults to the real three, registered by `startDaemon()`.
   */
  workers?: WorkerRegistry;
  /**
   * Called once both state files are written and the listener is accepting, before the ready line.
   *
   * Before, so that a parent which reads `{"event":"ready"}` is looking at a daemon whose wiring is
   * finished rather than one that is still being assembled.
   */
  onListening?: (daemon: StartedDaemon) => void | Promise<void>;
};

/**
 * Reject a port the OS could never bind before the server is built, so the
 * failure names the argument rather than surfacing as a bind error later.
 * `0` is allowed and means "any free port".
 */
function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > MAX_PORT) {
    throw new InvalidArgumentError(`Port must be a whole number between 0 and ${MAX_PORT}.`);
  }
  return port;
}

/** The `70` refusal, in the shape `startDaemon()` returns so both paths read the same. */
function internalFailure(error: unknown): {
  started: false;
  exitCode: number;
  message: string;
} {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    started: false,
    exitCode: DAEMON_INTERNAL_EXIT_CODE,
    message: `xplainer serve: could not start: ${detail}`,
  };
}

export function createServeCommand(io: CliIo, seams: ServeSeams = {}): Command {
  return new Command("serve")
    .description("Serve /healthz and the MCP endpoint over HTTP")
    .option(
      "-p, --port <port>",
      "port to listen on; defaults to the one daemon.json records, then 8787",
      parsePort,
    )
    .option("--bind <address>", "interface to bind; loopback only unless the flag below is given")
    .option(
      REMOTE_EXPOSURE_FLAG,
      "acknowledge that a non-loopback --bind exposes this daemon beyond this machine",
    )
    .option(
      `${STATE_DIR_FLAG} <path>`,
      `durable state directory; overrides ${STATE_DIR_ENV}, then the platform default`,
    )
    .option(
      `${TOKEN_FILE_FLAG} <path>`,
      `file holding the bearer token — a path, never the token; overrides ${TOKEN_FILE_ENV}`,
    )
    .option(
      `${SOCKET_FLAG} <path>`,
      "IPC socket (named pipe on Windows); its directory is made 0700 on every start",
    )
    .action(async (options: ServeOptions) => {
      // Refused before anything is acquired or written: a bind this daemon will not serve is a
      // usage error, and a usage error that has already taken the state directory is a usage error
      // that stopped the real daemon from starting.
      const bind = resolveBindAddress({
        bind: options.bind,
        acknowledged: options.iUnderstandRemoteExposure,
      });
      if (!bind.ok) {
        io.writeErr(`${bind.message}\n`);
        io.exit(USAGE_EXIT_CODE);
      }

      // Flag → variable → platform default, decided before ownership is attempted, because the
      // directory this resolves is the directory the lock is taken in.
      const stateDirSetting = resolveStateDirSetting({ flag: options.stateDir });

      const outcome = await startDaemon({
        stateDir: stateDirSetting.path,
        log: (line) => {
          io.writeErr(`${line}\n`);
        },
        ...(seams.workers === undefined ? {} : { workers: seams.workers }),
      }).catch(internalFailure);

      if (!outcome.started) {
        io.writeErr(`${outcome.message}\n`);
        io.exit(outcome.exitCode);
      }

      const { daemon } = outcome;
      const stateDir = daemon.stateDir;

      // R-SEC-4 and R-SEC-5. Minted here only when the file does not exist, and only once ownership
      // is held, so two daemons cannot race to create it. Exit `12` for a file that exists and
      // cannot be used: a daemon that cannot enforce authentication must not serve.
      const tokenSetting = resolveTokenPathSetting(stateDir, { flag: options.tokenFile });
      const tokenPath = tokenSetting.path;
      let token: string;
      try {
        const minted = loadOrMintToken(tokenPath, stateDir);
        token = minted.value;
        if (minted.minted) {
          io.writeErr(`xplainer serve: wrote a new bearer token to ${tokenPath} (mode 0600).\n`);
        }
      } catch (error) {
        await daemon.close();
        if (error instanceof TokenUnreadableError) {
          io.writeErr(`${error.message}\n`);
          io.exit(error.exitCode);
        }
        io.writeErr(`${internalFailure(error).message}\n`);
        io.exit(DAEMON_INTERNAL_EXIT_CODE);
      }

      // Configured → recorded → default, which is ADR 0020 §Port and discovery's precedence. The
      // recorded value is read after ownership: reading it earlier would mean reading a file this
      // process might not be allowed to have.
      const port = resolveDaemonPort({
        configured: options.port,
        recorded: readDaemonState(stateDir).port,
        fallback: DEFAULT_PORT,
      });

      // Built here, after ownership and reconciliation, over the runner those two steps produced
      // and the workspace root they resolved. Before either, the eight tools would be able to
      // enqueue against a runner holding records this daemon has not yet decided about.
      const backend = createLocalBackend({
        runner: daemon.runner,
        root: daemon.workspaceRoot,
      });

      // The `0700` directory and a socket path free of whatever the last run left behind, made
      // after ownership so that clearing a stale socket cannot clear a *live* daemon's
      // (ADR 0024 §Exclusive ownership is what makes that safe). A path this platform cannot bind
      // is refused here, by length, rather than as an opaque `bind(2)` failure later.
      let ipc: PreparedIpcSocket;
      try {
        ipc = prepareIpcSocket({ stateDir, flag: options.socket });
      } catch (error) {
        await daemon.close();
        io.writeErr(`${internalFailure(error).message}\n`);
        io.exit(DAEMON_INTERNAL_EXIT_CODE);
      }

      // The drain route's end of `daemon/shutdown.ts`, wired before the listener exists because
      // that is the order the two have to be created in: the handlers need the bound listeners, and
      // the route needs the handlers. A request that lands in the gap between the bind and the
      // installation is remembered rather than dropped — the window is a handful of synchronous
      // file writes wide, and a caller that got a `202` must not find nothing happened.
      let shutdownHandle: ShutdownHandle | null = null;
      let drainRequested: string | null = null;
      const beginDrain = (reason: string): void => {
        if (shutdownHandle === null) {
          drainRequested = reason;
          return;
        }
        void shutdownHandle.shutdown(reason);
      };

      const bound = await startServer({
        backend,
        port: port.port,
        hostname: bind.hostname,
        ipc: { path: ipc.path },
        drain: { timeoutMs: DEFAULT_DRAIN_TIMEOUT_MS, pid: process.pid, begin: beginDrain },
        guard: (boundPort) =>
          createLoopbackGuard({
            token,
            port: () => boundPort,
            // R-SEC-9: a widened bind *adds* its authority and takes nothing away, so the guard
            // cannot be disabled by relaxing the bind — which is the CVE that section cites.
            ...(bind.loopback ? {} : { hostnames: [bind.hostname] }),
            log: (line) => {
              io.writeErr(`xplainer serve: ${line}\n`);
            },
          }),
      }).then(
        (running) => ({ ok: true as const, running }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      if (!bound.ok) {
        // A daemon that cannot bind must not keep the state directory: the next attempt, or the
        // supervisor's restart, has to be able to acquire it.
        await daemon.close();
        // The IPC listener has its own error, and it names the socket rather than the port: a
        // message saying "could not bind 127.0.0.1:8787" about a failed `listen()` on a socket
        // sends the reader to look at the wrong thing entirely.
        if (bound.error instanceof IpcBindError) {
          io.writeErr(`${bound.error.message}\n`);
          io.exit(DAEMON_INTERNAL_EXIT_CODE);
        }
        // `EADDRINUSE` gets `10` rather than `70`, because a supervisor told `70` restarts a daemon
        // whose port is held by something else, for ever (ADR 0020 §Port and discovery).
        const failure = describeBindFailure(bound.error, {
          hostname: bind.hostname,
          port: port.port,
        });
        io.writeErr(`${failure.message}\n`);
        io.exit(failure.exitCode);
      }

      daemon.markReady({
        port: bound.running.port,
        addresses: [bound.running.url],
        socket: bound.running.socket,
        tokenFile: tokenPath,
        contractVersion: MCP_CONTRACT_VERSION,
      });

      shutdownHandle = installShutdownHandlers({
        stateDir,
        drain: (timeoutMs) => daemon.close(timeoutMs),
        listeners: [bound.running],
        // A named pipe has no directory entry, so there is nothing to unlink and asking would be a
        // different error rather than "already gone".
        socketPath: ipc.removeOnShutdown ? bound.running.socket : null,
        log: (line) => {
          io.writeErr(`${line}\n`);
        },
        exit: (code) => io.exit(code),
      });
      if (drainRequested !== null) {
        beginDrain(drainRequested);
      }

      if (!bind.loopback) {
        io.writeErr(
          `xplainer serve: bound ${bind.hostname}, which is not loopback. This is outside the ` +
            "supported configuration: there is no TLS here, and the bearer token is the only thing " +
            "between this daemon and anyone who can reach that address.\n",
        );
      }
      io.writeErr(
        `xplainer serve: listening on ${bound.running.url} (MCP at ${bound.running.url}/mcp), ` +
          `port from ${port.source}; every TCP request needs the bearer token in ${tokenPath}.\n`,
      );
      io.writeErr(
        `xplainer serve: also listening on ${ipc.path}, where filesystem permissions are the ` +
          "authentication and no token is asked for — that is the socket `xplainer mcp --attach` " +
          "dials, and it is why an agent's configuration holds no URL and no secret.\n",
      );
      // Which input decided each setting, said once. A supervisor that cannot deliver a variable —
      // Task Scheduler's `<Exec>` has no environment map — is exactly the case where a daemon
      // silently taking the platform default looks identical to one taking the setting it was
      // given, and the difference is only visible in a line like this or in `status --json`.
      io.writeErr(
        `xplainer serve: settings from ${stateDirSetting.source}/${tokenSetting.source}/` +
          `${ipc.source} — state directory ${stateDir}, token file ${tokenPath}, socket ` +
          `${ipc.path}; all three are recorded in daemon.json, which is what ` +
          "`xplainer status --json` reports.\n",
      );

      await seams.onListening?.(daemon);

      // The one machine-readable line, last, after ownership, reconciliation and both binds
      // (ADR 0025 §Part three). Nothing else is ever written to stdout.
      io.writeOut(
        formatReadyLine(
          readyAnnouncement({
            port: bound.running.port,
            socket: bound.running.socket,
            contractVersion: MCP_CONTRACT_VERSION,
            pid: process.pid,
          }),
        ),
      );
    });
}
