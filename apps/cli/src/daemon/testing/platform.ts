/**
 * The facts a suite has to read off the machine it is running on, read once.
 *
 * Two of them are places where the property under test is real on every platform and the *evidence
 * for it* is not:
 *
 * - **What keeps another local account out of a file.** On POSIX it is the mode, and `stat` is the
 *   witness. On Windows Node documents that only the write permission is settable and that the
 *   owner/group/other distinction is not implemented, so `stat` answers `0666` for a file created
 *   `0600` and an assertion on it is an assertion about nothing. The witness there is the file's
 *   own DACL, which `daemon/windows-acl.ts` narrows at creation per ADR 0020 §R-SEC-5, and which
 *   `icacls` prints. {@link protectionOf} is the one reading, and {@link ownerOnly} is what a test
 *   compares it against.
 * - **Where the second listener lives.** A unix domain socket is a filesystem entry inside a `0700`
 *   directory; a Windows named pipe is a machine-global name with no directory, no mode and nothing
 *   to unlink. `resolveIpcPath` already answers with the right one for the platform, and
 *   {@link testIpcEndpoint} is the same choice for the paths a *test* invents — a suite that hard-
 *   codes `<tmp>/x.sock` gets `listen EACCES` on Windows, which is what `windows-latest` answered
 *   for eleven cases across `server.test.ts` and `commands/serve.test.ts` on 2026-09-08.
 *
 * - **What a start token that is not this machine's looks like.** Half of ADR 0024's identity rule
 *   is a live pid whose token *differs*, and a suite arranges that by recording a token no process
 *   here can have. The token's **shape** is per platform — a formatted date on macOS, clock ticks
 *   on Linux, a file time on Windows — and a suite that hard-codes one platform's spelling is
 *   asserting the right verdict from the wrong evidence everywhere else. {@link foreignStartToken}
 *   is the shape this machine would really have produced, with a value it never will.
 *
 * {@link lanAddress} is the fourth, and it is not a Windows question: R-SEC-9's whole subject is a
 * bind that is **not** loopback, and no platform lets a test invent one — `127.0.0.2` is bindable
 * on Linux and answers `EADDRNOTAVAIL` on macOS, and a loopback alias needs root everywhere. So the
 * suite uses an address this machine really has.
 *
 * Nothing here asserts. Each returns a fact, so the failure a suite reports names the value this
 * machine actually had rather than "false".
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces, userInfo } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { isNamedPipe, WINDOWS_PIPE_PREFIX } from "../ipc.js";

/** One access-control entry, as `icacls` prints it. */
type AccessEntry = {
  /** `runneradmin`, `MACHINE\\alice`, `NT AUTHORITY\\SYSTEM`. */
  principal: string;
  /** `(I)(F)`, `(R,W)`, `(OI)(CI)(F)` — inherited entries carry `(I)`. */
  rights: string;
};

/** A path's whole DACL, and the text it was read out of. */
type AccessControl = {
  entries: AccessEntry[];
  /** The entries Windows marked `(I)`: inherited from the parent, which `/inheritance:r` removes. */
  inherited: AccessEntry[];
  /** `icacls`'s own output, so a failed assertion can print what it read. */
  raw: string;
};

/**
 * Read `path`'s access-control list.
 *
 * Windows only — there is no such thing to read on the other two, and a caller that reaches here
 * off `win32` has branched wrongly rather than found an empty list.
 */
function accessControl(path: string): AccessControl {
  if (process.platform !== "win32") {
    throw new Error(`accessControl is a Windows reading, and this is ${process.platform}`);
  }
  const answer = spawnSync("icacls", [path], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  const raw = `${answer.stdout ?? ""}${answer.stderr ?? ""}`;
  if (answer.error !== undefined) {
    throw new Error(`icacls ${path} could not be run: ${answer.error.message}`);
  }
  if (answer.status !== 0) {
    throw new Error(`icacls ${path} exited ${String(answer.status)}: ${raw.trim()}`);
  }
  const entries: AccessEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.toLowerCase().startsWith(path.toLowerCase())
      ? line.slice(path.length).trim()
      : line.trim();
    if (trimmed === "" || /^(?:Successfully|Failed) process/i.test(trimmed)) {
      continue;
    }
    const at = trimmed.indexOf(":(");
    if (at < 0) {
      continue;
    }
    entries.push({ principal: trimmed.slice(0, at), rights: trimmed.slice(at + 1) });
  }
  return { entries, inherited: entries.filter((entry) => entry.rights.includes("(I)")), raw };
}

/**
 * What keeps other local accounts out of `path`, as one comparable sentence.
 *
 * `mode 0600` on POSIX; on Windows either `owner-only ACL` — no inherited entry left and exactly
 * one principal, this account — or the whole list, so the failure says who else can reach the file.
 */
export function protectionOf(path: string): string {
  if (process.platform !== "win32") {
    return `mode ${(statSync(path).mode % 0o1000).toString(8).padStart(4, "0")}`;
  }
  const acl = accessControl(path);
  const others = acl.entries.filter((entry) => !isThisAccount(entry.principal));
  if (acl.inherited.length === 0 && others.length === 0 && acl.entries.length > 0) {
    return "owner-only ACL";
  }
  return `ACL ${acl.entries.map((entry) => `${entry.principal}:${entry.rights}`).join(" ")}`;
}

/**
 * What {@link protectionOf} says for a path only this account can reach.
 *
 * `mode` is the POSIX half and is passed in rather than assumed, because the two paths this is
 * asked about have different ones — a token file is `0600` and the directory holding it is `0700`.
 */
export function ownerOnly(mode: number): string {
  return process.platform === "win32"
    ? "owner-only ACL"
    : `mode ${mode.toString(8).padStart(4, "0")}`;
}

/**
 * A socket path a test can bind: a named pipe on Windows, a file in `directory` elsewhere.
 *
 * The pipe name is a **digest of the two arguments**, which is `resolveIpcPath`'s own arrangement
 * and is what both properties a suite needs out of it: a pipe name is global to the machine, so two
 * scratch directories — two cases, two vitest workers on one runner — never collide; and the same
 * pair answers with the same name every time, so a case that stops a daemon and starts another one
 * "on the same socket" really does.
 */
export function testIpcEndpoint(directory: string, name = "x.sock"): string {
  if (process.platform === "win32") {
    const digest = createHash("sha256")
      .update(`${directory}\u0000${name}`)
      .digest("hex")
      .slice(0, 24);
    return `${WINDOWS_PIPE_PREFIX}xplainer-test-${digest}`;
  }
  return join(directory, name);
}

/**
 * Whether the endpoint a daemon announced has gone, whichever kind of endpoint it was.
 *
 * A unix domain socket is a **file**, and step 6 of ADR 0024's drain unlinks it, so its absence is
 * the fact the drain is asserted on. A named pipe has no directory entry to unlink, and
 * `existsSync` is not a stand-in for one: libuv implements `uv_fs_stat` on `\\.\pipe\<name>` by
 * *opening* the pipe for its attributes, so it answers `true` while an instance is free and `false`
 * while every instance is busy — a fact about the connection pool rather than about the endpoint,
 * measured on `windows-latest` on 2026-09-09, where a serving daemon answered `true`. What is
 * asked here instead is the only question the drain is about: whether anything will still accept a
 * connection on the name.
 */
export function endpointGone(socketPath: string): Promise<boolean> {
  if (!isNamedPipe(socketPath)) {
    return Promise.resolve(!existsSync(socketPath));
  }
  return new Promise<boolean>((resolve) => {
    const socket = connect({ path: socketPath });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(true);
    });
  });
}

/**
 * A start token in this platform's own spelling that no process on this machine can have.
 *
 * The verdict a suite is arranging with it is `stranger` — a live pid whose recorded token differs,
 * which is ADR 0024's scenario `[D]` and the one case certain enough to leave a live process alone
 * *without* setting `workers_uncertain`. Every platform's classifier compares the two tokens as
 * strings, so any value that differs produces that verdict; what this function adds is that the
 * value differs **for the right reason**. `Thu Jan  1 00:00:00 1970` is a `ps -o lstart=` date, and
 * on Windows — where a token is a file time and became one only on 2026-09-09 — a case written with
 * it would pass while proving nothing about the token this machine actually reads.
 *
 * The values are all the epoch as each platform counts it: tick zero on Linux, the Unix epoch on
 * macOS, and file time `1` on Windows, which is 1601-01-01 plus 100 ns. No process has any of them.
 */
export function foreignStartToken(): string {
  if (process.platform === "linux") {
    return "starttime=0";
  }
  if (process.platform === "win32") {
    return "CreationDate=1";
  }
  return "Thu Jan  1 00:00:00 1970";
}

/** Whether an `icacls` principal is the account this process is running as. */
function isThisAccount(principal: string): boolean {
  const account = (principal.split("\\").pop() ?? "").toLowerCase();
  return account === userInfo().username.toLowerCase();
}

/**
 * A non-loopback IPv4 address this machine really has.
 *
 * The one input a test of ADR 0020 §Security R-SEC-9 cannot fabricate. Every alternative was
 * measured and rejected: `127.0.0.2` binds on Linux and answers `EADDRNOTAVAIL` on macOS (this
 * machine, 2026-09-08); a loopback alias is `ifconfig lo0 alias` and needs root; and a name that
 * resolves to `127.0.0.1` and is not `localhost` differs per platform and per resolver. Every CI
 * runner and every container this project uses has an address here — `eth0` on the Linux runners
 * and in Docker, `en0` on macOS — so this is a fact about the machine rather than a dependency on
 * the internet.
 *
 * @throws when the machine has only loopback interfaces, which is an honest environment failure
 * rather than a skipped test: what cannot be asserted here is exactly what R-SEC-9 is about.
 */
export function lanAddress(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }
  throw new Error(
    "this suite needs one non-loopback IPv4 address and this machine has only loopback " +
      "interfaces; R-SEC-9 is about a bind that is not loopback, so there is nothing to assert " +
      "against here",
  );
}
