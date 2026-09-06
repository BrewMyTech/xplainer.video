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
 * **The socket lives under the state directory, not under `XDG_RUNTIME_DIR`.** ADR 0020 §Port and
 * discovery observes that `XDG_RUNTIME_DIR` "is the right home for the socket, whose mandated
 * lifetime matches a socket's" — and that is where a *packaged* Linux daemon will put it, through
 * `daemon.json`'s recorded socket path at phase 2, when `install` writes the unit that sets
 * `RuntimeDirectory=`. Until then there is no installer to write that path and one directory a test
 * can relocate with `XPLAINER_STATE_DIR` is worth more than a platform branch nothing exercises;
 * `shutdown.ts` unlinks the socket on a clean stop either way, which is the property
 * `RuntimeDirectory=` would have provided for free.
 *
 * **Windows is code-pathed and not tested here.** A named pipe is not a filesystem entry: it has no
 * mode, no directory and nothing to unlink, and its name is global to the machine — so the name
 * carries a digest of the state directory, which is what keeps two users' daemons (and two test
 * runs) from colliding on one pipe. ADR 0020 §Security R-SEC-5 already records the honest gap this
 * leaves: on Windows "a mode is not protection", and the ACL work that would close it belongs to
 * the installer in phase 2.
 */

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { STATE_DIR_MODE } from "./state-dir.js";

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

  constructor(path: string) {
    // No `xplainer serve:` prefix: the caller wraps this in its own sentence, and two prefixes in
    // one line read as two failures.
    super(
      `the IPC socket path is ${Buffer.byteLength(path)} bytes and the limit is ` +
        `${MAX_UNIX_SOCKET_PATH} (${path}). Point XPLAINER_STATE_DIR at a shorter directory.`,
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
 * Only the `ipc/` directory is enforced here. The state directory *above* it is
 * [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md)'s to own (`state-dir.ts`
 * mints it `0700`), and a `chmod` on somebody's `XPLAINER_STATE_DIR` — which may be a directory
 * they chose for other reasons — is not this module's to make. A permissive parent still leaves the
 * socket unreachable, because reaching a file means having execute on **every** directory on the
 * way to it, and this one is the last of them.
 */
export function prepareIpcSocket(
  stateDir: string,
  platform: string = process.platform,
): PreparedIpcSocket {
  const path = resolveIpcPath(stateDir, platform);
  if (isNamedPipe(path)) {
    return { path, removeOnShutdown: false };
  }
  if (Buffer.byteLength(path) > MAX_UNIX_SOCKET_PATH) {
    throw new IpcPathTooLongError(path);
  }
  const directory = join(stateDir, IPC_DIR);
  mkdirSync(directory, { recursive: true, mode: STATE_DIR_MODE });
  chmodSync(directory, STATE_DIR_MODE);
  try {
    unlinkSync(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  return { path, removeOnShutdown: true };
}
