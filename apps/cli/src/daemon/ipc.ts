/**
 * Where the second listener lives, and why it needs no token.
 *
 * [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md) §The agent path is IPC, not
 * TCP decides both halves: "`serve` binds **two** listeners over one Hono application: the TCP
 * loopback listener it binds today, and a unix domain socket (named pipe on Windows) inside a
 * `0700` directory", and "Filesystem permissions are the authentication, which is Docker-on-Linux's
 * model, stated honestly: the socket is exactly as strong as the uid boundary."
 *
 * That is why this module is about a *directory mode* rather than about a secret. A browser can
 * neither open a unix socket nor spawn a process, so the whole DNS-rebinding class the TCP guard
 * exists for is **structurally absent** from the path agents actually use — and the one thing left
 * to get right is that no other local user can reach the socket file. Hence `0700` on the
 * directory, created before the socket is bound, and the socket inside it.
 *
 * **The default socket lives under the state directory, and `serve --socket` is what moves it.**
 * ADR 0020 §Port and discovery observes that `XDG_RUNTIME_DIR` "is the right home for the socket,
 * whose mandated lifetime matches a socket's", which is where the installed Linux unit puts it with
 * `RuntimeDirectory=xplainer` and `--socket %t/xplainer/xplainer.sock`. `RuntimeDirectory=`
 * relocates nothing on its own: it creates a directory, and without a flag that names it the daemon
 * would keep binding under the state directory while systemd made an empty directory beside it.
 * There is deliberately **no environment variable** for this one — the flag is the only route, and
 * `SETTING_VARIABLES` in `../runtime/launch-spec.ts` records that absence as the reason all three
 * settings travel in argv on every platform. `shutdown.ts` unlinks the socket on a clean stop
 * wherever it is, which is the property `RuntimeDirectory=` would have provided for free.
 *
 * **`--socket` moves the `0700` rule with it.** The directory the mode is enforced on is the one
 * the socket is actually in, because that directory *is* this transport's authentication and a rule
 * that stayed pointed at `<state>/ipc` while the socket moved would be a rule about an empty
 * directory. The cost is stated rather than discovered: a `--socket` names a directory whose mode
 * this daemon takes over on every start, so it wants a directory dedicated to the socket — which is
 * what `%t/xplainer` is, and what `$HOME` is not.
 *
 * **Windows is code-pathed and not tested here.** A named pipe is not a filesystem entry: it has no
 * mode, no directory and nothing to unlink, and its name is global to the machine — so the name
 * carries a digest of the state directory, which is what keeps two users' daemons (and two test
 * runs) from colliding on one pipe. A digest is not an access check, though, and the pipe libuv
 * creates carries the default descriptor Microsoft documents as granting "read access to members of
 * the Everyone group and the anonymous account" — so {@link secureIpcEndpoint} replaces it, right
 * after the bind, with one that names this account and nobody else. `daemon/pipe-acl.ts` is that
 * mechanism and the reasoning behind it; this module is where the two transports' protections are
 * asked for by one name.
 */

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { removeIfPresent } from "./durable-write.js";
import { type PipeAclResult, restrictPipeToOwner } from "./pipe-acl.js";
import {
  type SettingDecision,
  type SettingSource,
  STATE_DIR_MODE,
  settingFlag,
} from "./state-dir.js";

/** The `0700` directory inside the state directory that holds the socket. */
export const IPC_DIR = "ipc";

/** The socket file itself. */
export const IPC_SOCKET_FILE = "xplainer.sock";

/** The prefix every Windows named pipe path carries. */
export const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";

/**
 * How much of a `sun_path` a unix socket may use.
 *
 * `sockaddr_un.sun_path` is 104 bytes on macOS and 108 on Linux, both including the terminator, and
 * a path over the limit fails at `bind(2)` with a message naming neither the limit nor the path.
 * The smaller of the two is checked on every platform, so a state directory that works on Linux and
 * silently would not on macOS is refused in the same words on both.
 */
export const MAX_UNIX_SOCKET_PATH = 103;

/** The socket path is too long for the platform to bind, and says so before `bind(2)` does. */
export class IpcPathTooLongError extends Error {
  readonly path: string;

  constructor(path: string, source: SettingSource = "default") {
    // No `xplainer serve:` prefix: the caller wraps this in its own sentence, and two prefixes in
    // one line read as two failures. The remedy names whichever input actually produced the path:
    // telling someone to move XPLAINER_STATE_DIR when they passed --socket sends them to change a
    // value that is not in the answer.
    super(
      `the IPC socket path is ${Buffer.byteLength(path)} bytes and the limit is ` +
        `${MAX_UNIX_SOCKET_PATH} (${path}). ` +
        (source === "flag"
          ? "Point --socket at a shorter path."
          : "Point XPLAINER_STATE_DIR at a shorter directory."),
    );
    this.name = "IpcPathTooLongError";
    this.path = path;
  }
}

/**
 * The socket path for a state directory, on the platform given.
 *
 * `platform` is a parameter rather than a read of `process.platform` for the reason
 * `state-dir.ts` gives for the same choice: the Windows branch is only checkable on one machine if
 * a test can ask for it.
 */
export function resolveIpcPath(stateDir: string, platform: string = process.platform): string {
  if (platform === "win32") {
    // A pipe name is machine-global, so it is derived from the state directory rather than fixed:
    // two users, two `XPLAINER_STATE_DIR`s and two concurrent test runs each get their own.
    const digest = createHash("sha256").update(stateDir).digest("hex").slice(0, 16);
    return `${WINDOWS_PIPE_PREFIX}xplainer-${digest}`;
  }
  return join(stateDir, IPC_DIR, IPC_SOCKET_FILE);
}

/** Whether a resolved path is a Windows named pipe rather than a filesystem socket. */
export function isNamedPipe(path: string): boolean {
  return path.startsWith(WINDOWS_PIPE_PREFIX);
}

/** What {@link resolveIpcSocket} and {@link prepareIpcSocket} weigh. */
export type IpcSocketRequest = {
  /** The state directory the default path is derived from. */
  stateDir: string;
  /** `serve --socket`, which wins over the derived path. There is no variable for this one. */
  flag?: string | undefined;
  /** Defaults to this process's, for the reason {@link resolveIpcPath} gives. */
  platform?: string;
};

/**
 * The whole precedence: `--socket` → the path derived from the state directory.
 *
 * Two steps rather than three, because there is no `XPLAINER_SOCKET`: a supervisor that could only
 * set variables would have no way to move this one, which is precisely why the launch contract puts
 * all three settings in argv on every platform.
 */
export function resolveIpcSocket(request: IpcSocketRequest): SettingDecision {
  const flag = settingFlag(request.flag);
  if (flag !== undefined) {
    return { path: flag, source: "flag" };
  }
  return {
    path: resolveIpcPath(request.stateDir, request.platform ?? process.platform),
    source: "default",
  };
}

/** A prepared IPC endpoint: where to bind, and whether anything has to be removed afterwards. */
export type PreparedIpcSocket = {
  /** The path `listen()` is given. */
  path: string;
  /**
   * Whether `shutdown.ts` should unlink it at step 6.
   *
   * False for a named pipe, which the kernel reclaims when the last handle closes and which has no
   * directory entry to remove — `unlink` on one is not "already gone", it is a different error.
   */
  removeOnShutdown: boolean;
  /** Whether `--socket` decided this path, or the state directory did. */
  source: SettingSource;
};

/**
 * Create the `0700` directory, clear any socket a previous run left, and report where to bind.
 *
 * Removing the stale socket is safe **because this is called after ownership is acquired**: ADR
 * 0024 §Exclusive ownership makes `owner.lock` the single-writer property, so a socket file still
 * sitting here belongs to a run that is gone rather than to a daemon that is serving. Doing it the
 * other way round — binding first and discovering `EADDRINUSE` — would make every `SIGKILL` need a
 * manual `rm` before the daemon could start again.
 *
 * **The `chmod` is not redundant with the `mkdir` mode.** `mkdir`'s mode applies to a directory it
 * *creates* and is ignored entirely for one that is already there, so a run in a state directory
 * whose `ipc/` was left `0755` — by an older release, by a `umask` a wrapper script set, by a user
 * who unpacked a backup — would bind the socket inside a directory every local account can walk
 * into, and nothing would say so. `chmod` runs on both paths and is what actually makes `0700` a
 * property of the directory this daemon binds in rather than of the call that happened to create it.
 *
 * Only the socket's **own** directory is enforced here — `<state>/ipc`, or the directory `--socket`
 * named. The state directory *above* it is
 * [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md)'s to own (`state-dir.ts`
 * mints it `0700`), and a `chmod` on somebody's `XPLAINER_STATE_DIR` — which may be a directory
 * they chose for other reasons — is not this module's to make. A permissive parent still leaves the
 * socket unreachable, because reaching a file means having execute on **every** directory on the
 * way to it, and this one is the last of them. The same sentence read the other way is the cost of
 * `--socket`: the last directory on the path is one this daemon narrows, so name a directory that
 * holds the socket and nothing else.
 */
export function prepareIpcSocket(request: IpcSocketRequest): PreparedIpcSocket {
  const { path, source } = resolveIpcSocket(request);
  if (isNamedPipe(path)) {
    return { path, removeOnShutdown: false, source };
  }
  if (Buffer.byteLength(path) > MAX_UNIX_SOCKET_PATH) {
    throw new IpcPathTooLongError(path, source);
  }
  // The directory the socket is *in*, which is `<state>/ipc` for the derived path and whatever
  // `--socket` named otherwise. Following the path is the point: the mode is what stops another
  // local account from reaching a listener that asks for no token, and enforcing it on a directory
  // the socket is no longer in would enforce it on nothing.
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: STATE_DIR_MODE });
  chmodSync(directory, STATE_DIR_MODE);
  removeIfPresent(path);
  return { path, removeOnShutdown: true, source };
}

/**
 * Narrow the endpoint that was just bound to the account this daemon runs as.
 *
 * Called **after** `listen()` and not before, because on Windows there is nothing to narrow until
 * libuv has created the pipe: `net.Server.listen()` takes no security descriptor, so the pipe is
 * born with the default one and is replaced a moment later. On POSIX there is nothing to do here at
 * all — {@link prepareIpcSocket} already made the socket's directory `0700`, and that directory is
 * the authentication — so the answer is `not-applicable` and `serve` says which of the two
 * protections this platform actually got.
 */
export function secureIpcEndpoint(
  path: string,
  platform: string = process.platform,
): PipeAclResult {
  if (!isNamedPipe(path)) {
    return { outcome: "not-applicable" };
  }
  return restrictPipeToOwner(path, platform);
}
