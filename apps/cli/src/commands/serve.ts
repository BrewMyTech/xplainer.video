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
 *   both facts are known. With one deliberate exception: `token_file` and `token_origin` are
 *   written together, below, at the moment the token's provenance is decided, because they are one
 *   fact about one file and a start that mints and then fails to bind never reaches `markReady()`
 *   at all.
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
 * **What a non-loopback bind costs, in one place.** ADR 0020 §Security R-SEC-9 is a list of five
 * preconditions rather than a flag, and this command is where all five are asked: `daemon/binding.ts`
 * refuses `0.0.0.0` and `::` outright and refuses any other non-loopback address without
 * `--i-understand-remote-exposure`; `daemon/tls.ts` refuses one without `--tls-cert`, `--tls-key`
 * and at least one `--allow-host`, and refuses one whose bearer token is absent or is the value this
 * daemon minted for itself. The first four are decided **before ownership is taken**, and the fifth
 * before anything is bound **and before anything is minted** — a check asked after the mint would
 * have created the credential it then refuses — so every refusal leaves the machine exactly as it
 * found it, with no token file and no `token_origin` this run wrote. What the guard
 * gets is `allowHosts` — the operator's names *added* to loopback, never replacing them — which is
 * the CVE-2026-65105 lesson: widening a bind must add authority and remove none.
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
import { createWorkspaceLibrary } from "../api/videos.js";
import { createLocalBackend } from "../backend.js";
import {
  describeBindFailure,
  REMOTE_EXPOSURE_FLAG,
  resolveBindAddress,
  resolveDaemonPort,
} from "../daemon/binding.js";
import { readDaemonState, type TokenOrigin, updateDaemonState } from "../daemon/daemon-state.js";
import { DAEMON_INTERNAL_EXIT_CODE, USAGE_EXIT_CODE } from "../daemon/exit-codes.js";
import { createLoopbackGuard } from "../daemon/guard.js";
import { type PreparedIpcSocket, prepareIpcSocket, secureIpcEndpoint } from "../daemon/ipc.js";
import { pipeProtection } from "../daemon/pipe-acl.js";
import { formatReadyLine, readyAnnouncement } from "../daemon/ready.js";
import { DEFAULT_DRAIN_TIMEOUT_MS, type WorkerRegistry } from "../daemon/runner.js";
import { installShutdownHandlers, type ShutdownHandle } from "../daemon/shutdown.js";
import { type StartedDaemon, startDaemon } from "../daemon/start.js";
import { resolveStateDirSetting, STATE_DIR_ENV } from "../daemon/state-dir.js";
import {
  ALLOW_HOST_FLAG,
  loadTlsMaterial,
  remoteExposureRefusal,
  remoteTokenRefusal,
  TLS_CERT_FLAG,
  TLS_KEY_FLAG,
  type TlsMaterial,
} from "../daemon/tls.js";
import {
  createTokenRing,
  defaultTokenPath,
  discardExpiredGrace,
  inspectTokenPresence,
  loadOrMintToken,
  resolveTokenOrigin,
  resolveTokenPathSetting,
  TOKEN_FILE_ENV,
  type TokenPresence,
  TokenUnreadableError,
  tokenProtection,
} from "../daemon/token.js";
import type { CliIo } from "../io.js";
import { DEFAULT_PORT, IpcBindError, startServer } from "../server.js";
import { checkToolchain } from "../setup/toolchain.js";

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
  tlsCert?: string;
  tlsKey?: string;
  /** Every `--allow-host`, collected in the order they were given. Empty when none was. */
  allowHost?: string[];
  stateDir?: string;
  tokenFile?: string;
  socket?: string;
};

/** Commander's accumulator for a repeatable option: the previous list plus this occurrence. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

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

/**
 * What a failure of the token step says and exits with — the same answer for both halves of it.
 *
 * The file is read twice on a non-loopback bind: once to decide whose token it is, before anything
 * is minted, and once by the mint itself. A file that cannot be used is exit `12` either way, and
 * anything else is `70`; writing that once is what keeps the two reads from disagreeing about a
 * condition they share.
 */
function tokenStepFailure(error: unknown): { message: string; exitCode: number } {
  return error instanceof TokenUnreadableError
    ? { message: error.message, exitCode: error.exitCode }
    : { message: internalFailure(error).message, exitCode: DAEMON_INTERNAL_EXIT_CODE };
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
      `${TLS_CERT_FLAG} <path>`,
      "PEM certificate chain; required for a non-loopback --bind, refused for a loopback one",
    )
    .option(`${TLS_KEY_FLAG} <path>`, "PEM private key for the certificate above")
    .option(
      `${ALLOW_HOST_FLAG} <host>`,
      "a hostname the Host allowlist gains beside loopback; repeatable, required for a " +
        "non-loopback --bind",
      collect,
      [],
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

      // The three R-SEC-9 preconditions argv decides — TLS in both halves, and at least one
      // operator host — asked here for the same reason the bind was: a daemon that discovered a
      // missing certificate after binding would already have been reachable, unencrypted, on the
      // address the operator was trying to protect. The fifth, the token's provenance, needs the
      // state directory and is asked below.
      const allowHosts = options.allowHost ?? [];
      const remoteRefusal = remoteExposureRefusal({
        loopback: bind.loopback,
        hostname: bind.hostname,
        ...(options.tlsCert === undefined ? {} : { certPath: options.tlsCert }),
        ...(options.tlsKey === undefined ? {} : { keyPath: options.tlsKey }),
        allowHosts,
      });
      if (remoteRefusal !== null) {
        io.writeErr(`${remoteRefusal}\n`);
        io.exit(USAGE_EXIT_CODE);
      }

      // Read and checked before ownership too: `loadTlsMaterial()` only reads two files the
      // operator already owns, and a certificate that turns out not to be one is a usage error
      // rather than a daemon that took the state directory and then gave it back.
      let tls: TlsMaterial | null = null;
      if (options.tlsCert !== undefined && options.tlsKey !== undefined) {
        const material = loadTlsMaterial({ certPath: options.tlsCert, keyPath: options.tlsKey });
        if (!material.ok) {
          io.writeErr(`${material.message}\n`);
          io.exit(USAGE_EXIT_CODE);
        }
        tls = material.material;
      }

      // Flag → variable → platform default, decided before ownership is attempted, because the
      // directory this resolves is the directory the lock is taken in.
      const stateDirSetting = resolveStateDirSetting({ flag: options.stateDir });

      const outcome = await startDaemon({
        stateDir: stateDirSetting.path,
        // The two other settings travel in as the flags they were given, so the startup identity
        // snapshot `startDaemon()` freezes describes the settings this daemon really resolved —
        // and so they are resolved once, by their own resolvers, rather than here and there.
        ...(options.tokenFile === undefined ? {} : { tokenFile: options.tokenFile }),
        ...(options.socket === undefined ? {} : { socket: options.socket }),
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
      // Read once, before the token, because both the token's provenance and the port come out of
      // it and a second read between the two would be reading a file this process has since
      // written. Reading it at all is safe only here: ownership is held.
      const recorded = readDaemonState(stateDir);
      // R-SEC-9's fifth precondition, asked **before the mint** and not after it. A remote bind that
      // reached `loadOrMintToken` would create the token file — `0600`, recorded, exactly as an
      // ordinary start does — and then refuse itself over the credential it had just written, which
      // is both a write on a path that must leave the machine as it found it and a sentence
      // claiming this daemon minted a file the operator had never seen. The three answers are
      // `absent`, `minted` and `operator`; only the last one binds. It is its own step rather than
      // the first lines of the mint's `try`, because `io.exit` unwinds by *throwing* under the
      // recording `CliIo` `program.test.ts` supplies, and a `catch` written for the mint would have
      // reported this refusal as an internal failure.
      if (!bind.loopback) {
        let presence: TokenPresence;
        try {
          presence = inspectTokenPresence({
            path: tokenPath,
            defaultPath: defaultTokenPath(stateDir),
            recordedOrigin: recorded.token_origin,
            recordedTokenFile: recorded.token_file,
          });
        } catch (error) {
          await daemon.close();
          const failure = tokenStepFailure(error);
          io.writeErr(`${failure.message}\n`);
          io.exit(failure.exitCode);
        }
        const refusal = remoteTokenRefusal({ presence, path: tokenPath });
        if (refusal !== null) {
          await daemon.close();
          io.writeErr(`${refusal}\n`);
          io.exit(USAGE_EXIT_CODE);
        }
      }

      // Declared without a value because the only path that leaves the block below without
      // assigning it is the `catch`, and every branch of that one exits. The token's *value* is
      // deliberately not kept: what the guard is given further down is the ring over the file, so
      // that a rotation in another process is picked up rather than shadowed by a string read at
      // start-up.
      let tokenOrigin: TokenOrigin;
      try {
        const minted = loadOrMintToken(tokenPath, stateDir);
        tokenOrigin = resolveTokenOrigin({
          minted: minted.minted,
          path: tokenPath,
          defaultPath: defaultTokenPath(stateDir),
          recordedOrigin: recorded.token_origin,
          recordedTokenFile: recorded.token_file,
        });
        if (minted.minted) {
          // What actually protects the file, named, because it differs by platform: a mode on the
          // two that have one, and the explicit ACL of ADR 0020 R-SEC-5 on the one that does not.
          // A `win32` machine whose `icacls` did not run has a token every local account can read,
          // and that is a sentence a person must be able to find in the log rather than infer.
          io.writeErr(
            `xplainer serve: wrote a new bearer token to ${tokenPath} (${tokenProtection(minted.acl)}).\n`,
          );
        }
      } catch (error) {
        await daemon.close();
        const failure = tokenStepFailure(error);
        io.writeErr(`${failure.message}\n`);
        io.exit(failure.exitCode);
      }

      // A grace window that closed while this daemon was down is a secret with nothing left to
      // open, so the file goes rather than sitting in the state directory waiting to be found in a
      // backup. Enforcement is the ring's — expiry is decided on the clock, not on the file's
      // presence — so this is hygiene, and it is done once here rather than per request.
      if (discardExpiredGrace(tokenPath)) {
        io.writeErr(
          `xplainer serve: removed the expired rotation grace file beside ${tokenPath}; the ` +
            "value in it had already stopped being accepted.\n",
        );
      }

      // What the guard is handed, and it is a function of the two files rather than a value read
      // once: `ring.tokens()` answers what is accepted *now*, which after a rotation is two values.
      const ring = createTokenRing({ path: tokenPath });

      // Recorded on every start, loopback or not, so that the answer survives into the next one:
      // the run that can see the file being created is the only run that can decide this, and a
      // remote bind three restarts later still needs it (`daemon/token.ts` §resolveTokenOrigin).
      //
      // **The path is written with it, in the same call**, and that is the correction of
      // 2026-09-08. `token_origin` is a fact about the file `token_file` names and about no other,
      // so a record holding one without the other answers for a file it cannot identify. Writing
      // them apart is what made that reachable: `token_origin` was written here, `token_file` only
      // at `markReady()` after both binds, so any ordinary failed start — a held port, a
      // certificate pair that will not load, a socket path this platform refuses — left `minted`
      // behind with no path beside it. The next start read "the record names no file of mine",
      // answered `operator` for the very token this daemon had minted a moment earlier, and
      // R-SEC-9's fifth precondition was met by a bookkeeping gap rather than by an operator.
      // Before the bind rather than after it for the same reason: the mint is the event that has
      // to survive, and the run that mints and then fails is exactly the run whose answer the next
      // one inherits.
      if (tokenOrigin !== recorded.token_origin || tokenPath !== recorded.token_file) {
        updateDaemonState(stateDir, { token_origin: tokenOrigin, token_file: tokenPath });
      }

      // Configured → recorded → default, which is ADR 0020 §Port and discovery's precedence. The
      // recorded value is read after ownership: reading it earlier would mean reading a file this
      // process might not be allowed to have.
      const port = resolveDaemonPort({
        configured: options.port,
        recorded: recorded.port,
        fallback: DEFAULT_PORT,
      });

      // Built here, after ownership and reconciliation, over the runner those two steps produced
      // and the workspace root they resolved. Before either, the eight tools would be able to
      // enqueue against a runner holding records this daemon has not yet decided about.
      const backend = createLocalBackend({
        runner: daemon.runner,
        root: daemon.workspaceRoot,
        stateDir,
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
        // Row 3 of the consistency check, taken before this bind and unchanged by anything after
        // it. `/healthz` advertises it; nothing infers it from a file.
        identity: daemon.identity,
        // ADR 0016's `/api/*` surface for GUI clients, over the same workspace root the runner's
        // workers write into. It is passed here rather than resolved inside the server because the
        // root is a function of this command's settings — `--state-dir`, `XPLAINER_VIDEOS_DIR`, the
        // recorded state — and a server that resolved it again could answer for a different
        // directory than the one this daemon is rendering into.
        api: { library: createWorkspaceLibrary({ root: daemon.workspaceRoot }) },
        // Asked per request rather than once: `xplainer setup` runs in another process, and a
        // workspace can be removed while this daemon is up, so a snapshot would answer for a
        // machine that no longer exists.
        toolchain: () => {
          const status = checkToolchain({ stateDir, workspaceRoot: daemon.workspaceRoot });
          return { ok: status.ok, reason: status.reason };
        },
        // The operator's certificate, or nothing at all. `remoteExposureRefusal()` above is what
        // makes "nothing at all" mean "this is a loopback bind" rather than "TLS was forgotten".
        ...(tls === null ? {} : { tls: { cert: tls.cert, key: tls.key } }),
        guard: (boundPort) =>
          createLoopbackGuard({
            // The ring rather than the string, so that a `token rotate` in another process reaches
            // this daemon without a restart and its grace window is honoured here rather than
            // promised somewhere else (ADR 0020 §Security R-SEC-8).
            tokens: ring.tokens,
            port: () => boundPort,
            // R-SEC-9: the operator's hosts are *added* to loopback and take nothing away, so the
            // guard cannot be disabled by relaxing the bind — which is the CVE that section cites.
            // The bind address is not added on its own: an authority nobody asked for is an
            // authority nobody decided about, and `--allow-host` is where that decision is made.
            ...(allowHosts.length === 0 ? {} : { allowHosts }),
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

      // The IPC endpoint asks for no token, so *this* is its authentication — and on Windows the
      // pipe libuv just created is readable by every local account until this call replaces its
      // descriptor. It is the first statement after the bind for that reason, and the position is
      // load-bearing rather than tidy: the IPC listener is the **last** thing `startServer()`
      // binds, so nothing of this daemon's runs between `CreateNamedPipeW` and the narrowing, and
      // the narrowing is synchronous, so nothing is served during it either. Everything that tells
      // somebody the endpoint exists — `markReady()`, the shutdown handlers, the ready line —
      // happens below. `daemon/pipe-acl.ts` states the window and what would close it entirely.
      const ipcProtection = secureIpcEndpoint(bound.running.socket ?? ipc.path);

      daemon.markReady({
        port: bound.running.port,
        addresses: [bound.running.url],
        socket: bound.running.socket,
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
        // Said even though all five preconditions were met, because meeting them is what makes the
        // exposure deliberate rather than what makes it safe: ADR 0020 §Security keeps remote
        // exposure outside the supported configuration, and this line is where a reader learns
        // which certificate and which authorities this daemon is actually trusting.
        io.writeErr(
          `xplainer serve: bound ${bind.hostname}, which is not loopback, over TLS from ` +
            `${tls?.certPath ?? "<none>"}. Reachable as ${allowHosts.join(", ")} — plus loopback, ` +
            "which the guard never gives up — with an operator token from " +
            `${tokenPath}. Remote exposure remains outside the supported configuration ` +
            "(ADR 0020 §Security R-SEC-9).\n",
        );
      }
      io.writeErr(
        `xplainer serve: listening on ${bound.running.url} (MCP at ${bound.running.url}/mcp), ` +
          `port from ${port.source}; every TCP request needs the bearer token in ${tokenPath}.\n`,
      );
      io.writeErr(
        `xplainer serve: also listening on ${ipc.path}, where ${pipeProtection(ipcProtection)} is ` +
          "the authentication and no token is asked for — that is the socket " +
          "`xplainer mcp --attach` dials, and it is why an agent's configuration holds no URL and " +
          "no secret.\n",
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
