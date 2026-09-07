/**
 * Where the socket goes, and what has to be true of the directory around it.
 *
 * The listener itself is asserted against a running `serve` in `../commands/serve.test.ts`, because
 * "a request over the socket needs no token" is a property of a bound listener and not of a path.
 * What is asserted here is everything that has to be right *before* `listen()` is called: the mode
 * of the directory that is this transport's whole authentication (ADR 0020 §The agent path is IPC,
 * not TCP), the Windows branch that cannot be exercised on this machine any other way, and the
 * stale socket a `SIGKILL`ed daemon leaves behind.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  IPC_DIR,
  IPC_SOCKET_FILE,
  IpcPathTooLongError,
  isNamedPipe,
  MAX_UNIX_SOCKET_PATH,
  prepareIpcSocket,
  resolveIpcPath,
  WINDOWS_PIPE_PREFIX,
} from "./ipc.js";
import { STATE_DIR_MODE } from "./state-dir.js";

const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function stateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "xplainer-ipc-"));
  scratch.push(directory);
  return directory;
}

/** The permission bits, as the four octal digits a person would write. */
function mode(path: string): string {
  return (statSync(path).mode % 0o1000).toString(8).padStart(4, "0");
}

describe("the socket path", () => {
  it("is one file inside one directory under the state directory, on every posix platform", () => {
    for (const platform of ["darwin", "linux", "freebsd"]) {
      expect(resolveIpcPath("/state", platform)).toBe(join("/state", IPC_DIR, IPC_SOCKET_FILE));
    }
  });

  /**
   * The Windows branch, which this repository can only check by asking for it (`state-dir.ts` takes
   * the platform as a parameter for the same reason). A named pipe is not a filesystem entry, so
   * there is no directory to make and nothing to unlink — and its name is machine-global, which is
   * why it carries a digest of the state directory rather than being a constant.
   */
  it("is a named pipe on Windows, named after the state directory it belongs to", () => {
    const first = resolveIpcPath("C:\\Users\\a\\AppData\\Local\\xplainer\\state", "win32");
    const second = resolveIpcPath("C:\\Users\\b\\AppData\\Local\\xplainer\\state", "win32");

    expect(first.startsWith(`${WINDOWS_PIPE_PREFIX}xplainer-`)).toBe(true);
    expect(isNamedPipe(first)).toBe(true);
    expect(first).not.toBe(second);
    // Two calls for one state directory must agree, or a shim and a daemon dial different pipes.
    expect(resolveIpcPath("C:\\Users\\a\\AppData\\Local\\xplainer\\state", "win32")).toBe(first);
  });

  it("has nothing to prepare or remove for a named pipe", () => {
    const stateDir = stateDirectory();

    const prepared = prepareIpcSocket(stateDir, "win32");

    expect(isNamedPipe(prepared.path)).toBe(true);
    expect(prepared.removeOnShutdown).toBe(false);
    expect(existsSync(join(stateDir, IPC_DIR))).toBe(false);
  });
});

describe("preparing the socket directory", () => {
  it("creates it 0700, because filesystem permissions are this transport's authentication", () => {
    const stateDir = stateDirectory();

    const prepared = prepareIpcSocket(stateDir, "darwin");

    expect(prepared.path).toBe(join(stateDir, IPC_DIR, IPC_SOCKET_FILE));
    expect(prepared.removeOnShutdown).toBe(true);
    expect(mode(join(stateDir, IPC_DIR))).toBe(STATE_DIR_MODE.toString(8).padStart(4, "0"));
  });

  /**
   * The case `mkdir` cannot cover. A mode passed to `mkdir` applies to a directory it creates and
   * is ignored for one that already exists, so an `ipc/` left open by an older release or by a
   * permissive `umask` would keep those bits for ever and the socket inside it would be reachable
   * by every local account — which is the entire authentication of this transport (ADR 0020 §The
   * agent path is IPC, not TCP). The mode has to be a property of the directory this run binds in,
   * not of the call that first made it.
   */
  it("narrows an ipc directory a previous run left open, because mkdir would not", () => {
    const stateDir = stateDirectory();
    mkdirSync(join(stateDir, IPC_DIR), { recursive: true });
    chmodSync(join(stateDir, IPC_DIR), 0o777);

    prepareIpcSocket(stateDir, "darwin");

    expect(mode(join(stateDir, IPC_DIR))).toBe("0700");
  });

  /**
   * The state directory above it is ADR 0020's to own and may be somebody's `XPLAINER_STATE_DIR`,
   * chosen for reasons of their own — so it is left exactly as it was found. That costs nothing:
   * reaching a file means holding execute on every directory on the way to it, and `ipc/` is the
   * last one.
   */
  it("leaves the state directory's own mode alone while still ending at 0700 itself", () => {
    const stateDir = stateDirectory();
    chmodSync(stateDir, 0o755);

    prepareIpcSocket(stateDir, "darwin");

    expect(mode(stateDir)).toBe("0755");
    expect(mode(join(stateDir, IPC_DIR))).toBe("0700");
  });

  /**
   * A daemon that was `SIGKILL`ed never reached step 6 of the drain, so its socket file is still
   * there — and `listen()` on an existing path is `EADDRINUSE`. Clearing it is safe *here* and only
   * here, because `serve` calls this after `acquireOwnership()`: a socket still on disk while this
   * process holds `owner.lock` belongs to a run that is gone (ADR 0024 §Exclusive ownership).
   */
  it("removes whatever the last run left at that path, so a SIGKILL needs no manual rm", () => {
    const stateDir = stateDirectory();
    mkdirSync(join(stateDir, IPC_DIR), { recursive: true, mode: STATE_DIR_MODE });
    const stale = join(stateDir, IPC_DIR, IPC_SOCKET_FILE);
    writeFileSync(stale, "not a socket, but in the way of one");

    prepareIpcSocket(stateDir, "darwin");

    expect(existsSync(stale)).toBe(false);
  });

  it("is idempotent, so a restart into the same directory prepares the same path", () => {
    const stateDir = stateDirectory();

    const first = prepareIpcSocket(stateDir, "darwin");
    const second = prepareIpcSocket(stateDir, "darwin");

    expect(second.path).toBe(first.path);
  });

  /**
   * `sun_path` is 104 bytes on macOS and 108 on Linux, and going over it fails inside `bind(2)`
   * with a message naming neither the limit nor the path. Refusing by length names both, and names
   * the environment variable that moves the directory.
   */
  it("refuses a path longer than a sockaddr_un can hold, naming the limit and the fix", () => {
    const deep = join(stateDirectory(), "d".repeat(120));
    mkdirSync(deep, { recursive: true, mode: STATE_DIR_MODE });

    expect(() => prepareIpcSocket(deep, "darwin")).toThrow(IpcPathTooLongError);
    try {
      prepareIpcSocket(deep, "darwin");
      expect.unreachable("the path is over the limit and must be refused");
    } catch (error) {
      expect((error as Error).message).toContain(String(MAX_UNIX_SOCKET_PATH));
      expect((error as Error).message).toContain("XPLAINER_STATE_DIR");
    }
    // Refused before anything was created: a directory left behind by a refusal is a directory the
    // next attempt has to reason about.
    expect(existsSync(join(deep, IPC_DIR))).toBe(false);
  });
});
