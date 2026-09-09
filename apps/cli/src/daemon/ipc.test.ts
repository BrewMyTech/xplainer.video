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
  resolveIpcSocket,
  secureIpcEndpoint,
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

    const prepared = prepareIpcSocket({ stateDir: stateDir, platform: "win32" });

    expect(isNamedPipe(prepared.path)).toBe(true);
    expect(prepared.removeOnShutdown).toBe(false);
    expect(existsSync(join(stateDir, IPC_DIR))).toBe(false);
  });
});

/**
 * `--socket` is the only route: `ipc.ts` reads no environment variable, and that absence is the
 * reason the launch contract puts all three settings in argv on every platform rather than only on
 * Windows. Without it a rendered `RuntimeDirectory=xplainer` would create a directory nothing binds
 * in, and `daemon.json`'s `socket_path` would be a field with a recorder and no setter.
 */
describe("resolveIpcSocket", () => {
  it("takes --socket verbatim, over the path the state directory would have derived", () => {
    expect(
      resolveIpcSocket({
        stateDir: "/state",
        flag: "/run/user/1000/xplainer/xplainer.sock",
        platform: "linux",
      }),
    ).toEqual({ path: "/run/user/1000/xplainer/xplainer.sock", source: "flag" });
  });

  it("derives it from the state directory when no flag is given, and says so", () => {
    expect(resolveIpcSocket({ stateDir: "/state", platform: "linux" })).toEqual({
      path: join("/state", IPC_DIR, IPC_SOCKET_FILE),
      source: "default",
    });
  });

  it("ignores a blank flag rather than binding on nothing", () => {
    expect(resolveIpcSocket({ stateDir: "/state", flag: "  ", platform: "linux" }).source).toBe(
      "default",
    );
  });
});

describe("preparing the socket directory", () => {
  it("creates it 0700, because filesystem permissions are this transport's authentication", () => {
    const stateDir = stateDirectory();

    const prepared = prepareIpcSocket({ stateDir: stateDir, platform: "darwin" });

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

    prepareIpcSocket({ stateDir: stateDir, platform: "darwin" });

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

    prepareIpcSocket({ stateDir: stateDir, platform: "darwin" });

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

    prepareIpcSocket({ stateDir: stateDir, platform: "darwin" });

    expect(existsSync(stale)).toBe(false);
  });

  it("is idempotent, so a restart into the same directory prepares the same path", () => {
    const stateDir = stateDirectory();

    const first = prepareIpcSocket({ stateDir: stateDir, platform: "darwin" });
    const second = prepareIpcSocket({ stateDir: stateDir, platform: "darwin" });

    expect(second.path).toBe(first.path);
  });

  /**
   * The whole point of `--socket`: the socket is somewhere else entirely, and the `0700` rule went
   * with it. A rule that stayed pointed at `<state>/ipc` while the listener moved would be a rule
   * about an empty directory, and the socket — which asks for no token at all — would be sitting in
   * whatever mode its directory happened to have.
   */
  it("puts the socket where --socket says and makes that directory 0700", () => {
    const stateDir = stateDirectory();
    const elsewhere = join(stateDirectory(), "runtime", "xplainer");
    const socket = join(elsewhere, "xplainer.sock");

    const prepared = prepareIpcSocket({ stateDir, flag: socket, platform: "darwin" });

    expect(prepared).toEqual({ path: socket, removeOnShutdown: true, source: "flag" });
    expect(mode(elsewhere)).toBe("0700");
    // And the directory the flag replaced is not created at all: a `<state>/ipc` nothing binds in
    // is exactly the empty directory this flag exists to stop.
    expect(existsSync(join(stateDir, IPC_DIR))).toBe(false);
  });

  it("narrows a directory --socket named that was already open, on every start", () => {
    const stateDir = stateDirectory();
    const elsewhere = join(stateDirectory(), "runtime");
    mkdirSync(elsewhere, { recursive: true });
    chmodSync(elsewhere, 0o755);

    prepareIpcSocket({ stateDir, flag: join(elsewhere, "xplainer.sock"), platform: "darwin" });

    expect(mode(elsewhere)).toBe("0700");
  });

  it("clears a stale socket at the path --socket named, as it does at the derived one", () => {
    const stateDir = stateDirectory();
    const elsewhere = stateDirectory();
    const socket = join(elsewhere, "xplainer.sock");
    writeFileSync(socket, "not a socket, but in the way of one");

    prepareIpcSocket({ stateDir, flag: socket, platform: "darwin" });

    expect(existsSync(socket)).toBe(false);
  });

  /**
   * A named pipe given by flag is still a named pipe: nothing to make, nothing to unlink. This is
   * the shape the Windows task's `--socket` argument takes, and the branch that keeps `mkdir` from
   * being asked for `\\.\pipe`.
   */
  it("treats a --socket that names a Windows pipe as a pipe", () => {
    const stateDir = stateDirectory();
    const pipe = `${WINDOWS_PIPE_PREFIX}xplainer-installed`;

    const prepared = prepareIpcSocket({ stateDir, flag: pipe, platform: "win32" });

    expect(prepared).toEqual({ path: pipe, removeOnShutdown: false, source: "flag" });
  });

  /** The remedy names the input that produced the path, not the one the caller never used. */
  it("names --socket rather than XPLAINER_STATE_DIR when the flag is what is too long", () => {
    const stateDir = stateDirectory();
    const socket = join(stateDirectory(), "d".repeat(120), "xplainer.sock");

    try {
      prepareIpcSocket({ stateDir, flag: socket, platform: "darwin" });
      expect.unreachable("the path is over the limit and must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(IpcPathTooLongError);
      expect((error as Error).message).toContain("--socket");
      expect((error as Error).message).not.toContain("XPLAINER_STATE_DIR");
    }
  });

  /**
   * `sun_path` is 104 bytes on macOS and 108 on Linux, and going over it fails inside `bind(2)`
   * with a message naming neither the limit nor the path. Refusing by length names both, and names
   * the environment variable that moves the directory.
   */
  it("refuses a path longer than a sockaddr_un can hold, naming the limit and the fix", () => {
    const deep = join(stateDirectory(), "d".repeat(120));
    mkdirSync(deep, { recursive: true, mode: STATE_DIR_MODE });

    expect(() => prepareIpcSocket({ stateDir: deep, platform: "darwin" })).toThrow(
      IpcPathTooLongError,
    );
    try {
      prepareIpcSocket({ stateDir: deep, platform: "darwin" });
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

/**
 * Which of the two protections each transport gets, decided by the path rather than by a flag.
 *
 * The `0700` directory is the unix socket's authentication and there is nothing to add to it; the
 * named pipe has no directory and is born readable by every local account, so it is the one that
 * gets an explicit descriptor (`daemon/pipe-acl.ts`). Asking the question by path is what keeps
 * `--socket` from being able to choose the wrong answer.
 */
describe("secureIpcEndpoint", () => {
  it("has nothing to add to a socket inside a 0700 directory", () => {
    expect(secureIpcEndpoint("/tmp/xplainer/ipc/xplainer.sock", "win32")).toEqual({
      outcome: "not-applicable",
    });
  });

  it("sends a named pipe to the descriptor narrowing, which is a no-op off Windows", () => {
    expect(secureIpcEndpoint(`${WINDOWS_PIPE_PREFIX}xplainer-abc`, "darwin")).toEqual({
      outcome: "not-applicable",
    });
  });
});
