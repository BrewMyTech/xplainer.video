/**
 * The security descriptor the Windows named pipe needs, because its name is not protection either.
 *
 * On POSIX the IPC listener is authenticated by the `0700` directory the socket sits in
 * (`daemon/ipc.ts`), and [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md)
 * §The agent path is IPC states the claim it rests on: "Filesystem permissions are the
 * authentication … the socket is exactly as strong as the uid boundary." On Windows the same
 * listener is a named pipe, which has no directory and no mode — and, left alone, no useful DACL
 * either. Microsoft documents exactly what `CreateNamedPipe` gives a pipe whose
 * `lpSecurityAttributes` is `NULL`, which is what libuv passes:
 *
 * > The ACLs in the default security descriptor for a named pipe grant full control to the
 * > LocalSystem account, administrators, and the creator owner. **They also grant read access to
 * > members of the Everyone group and the anonymous account.**
 * > — [CreateNamedPipeA](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createnamedpipea)
 *
 * So every account on the machine can open our IPC endpoint for reading. What that buys an attacker
 * is bounded — a read-only handle cannot send an HTTP request, so no tool can be invoked through it
 * — and it is still not the property the ADR claims, and ADR 0020's note of 2026-09-08 recorded the
 * gap as open rather than closed. This module closes it.
 *
 * **Why the descriptor is applied after the bind rather than at creation, and how wide that window
 * is.** Node's `net.Server.listen()` takes no security descriptor: `ListenOptions` offers
 * `readableAll` and `writableAll`, which *widen* a pipe through `uv_pipe_chmod`, and nothing that
 * narrows one. A native addon could call `CreateNamedPipeW` itself, and that is precisely what phase
 * 2's single-file packaging cannot carry — the same constraint that ruled out DPAPI in R-SEC-5. So
 * the pipe is created by libuv with the default descriptor and narrowed at the first instant Node
 * offers, and the window between the two is measured out rather than waved at:
 *
 * - It **opens** inside `server.listen(pipePath, …)`, where libuv's `uv_pipe_bind` calls
 *   `CreateNamedPipeW` with `lpSecurityAttributes = NULL`. Nothing before that call exists to
 *   narrow; a descriptor written earlier would be written to no object.
 * - It **closes** when `SetAccessControl` returns in the PowerShell child below. What is inside it
 *   is one promise resolution — the IPC listener is the **last** thing `startServer()` binds, so
 *   `serve` reaches {@link restrictPipeToOwner} with nothing of its own in between — and one
 *   `powershell.exe` start, which is the cost of having no native addon.
 * - Nothing of this daemon's runs *during* it: the narrowing is `spawnSync`, so the event loop is
 *   blocked and the HTTP server accepts nothing until the descriptor is in place. `markReady()`,
 *   the shutdown handlers and the ready line all happen after it, so no consumer has been told the
 *   socket exists while it is still wide.
 * - What an attacker gets inside it is what the default descriptor grants: **read** access. A
 *   read-only handle cannot send an HTTP request, so no tool can be invoked through one, and the
 *   `0700` directory that protects the POSIX socket has no Windows counterpart to have been wider.
 *
 * The one thing that would close the window entirely is a narrower started *before* the bind and
 * parked in `NamedPipeClientStream.Connect(timeout)`, which waits for the pipe to appear. It is not
 * taken this phase, and the reason is recorded rather than left as an omission: it turns a
 * synchronous call into a two-phase one whose failure modes — a bind that never happens, a client
 * that attaches to somebody else's pipe of the same name — are only observable on a Windows runner,
 * and this project's Windows runners are unavailable (§P2-7). A defect written on that platform is
 * exactly how this file's `PipeAccessRights` bug reached a release.
 *
 * **Why narrowing one handle narrows the pipe.** The descriptor belongs to the *named pipe*, not to
 * the instance: "If a new named pipe is being created, the access control list (ACL) from the
 * security attributes parameter defines the discretionary access control for the named pipe", and
 * the access check for creating a further instance "compares the thread's access token and the
 * requested access rights against the DACL in the named pipe's security descriptor"
 * ([Named Pipe Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)).
 * Libuv creates further instances as connections are accepted, and every one of them is checked
 * against the descriptor written here — which is why the single entry grants **full control** and
 * not merely read and write: `FILE_CREATE_PIPE_INSTANCE` is part of it, and a daemon that narrowed
 * its own pipe out of the right to accept a second connection would have made itself unusable.
 *
 * **Why a client connection is what carries the change, and why it asks for `ReadData`.**
 * `SetSecurityInfo` needs a handle, and the only handles to the server end belong to libuv. So the
 * pipe is opened by name, asking for `WRITE_DAC` and `READ_CONTROL` — `ChangePermissions` and
 * `ReadPermissions` — **plus the one data right .NET will not open a pipe without**:
 *
 * > The pipe direction for this constructor is determined by the `desiredAccessRights` parameter.
 * > If the `desiredAccessRights` value is `ReadData`, the pipe direction will be `In`. If the value
 * > of `desiredAccessRights` is `WriteData`, the pipe direction will be `Out`.
 * > — [NamedPipeClientStream(String, String, PipeAccessRights, PipeOptions, TokenImpersonationLevel, HandleInheritability)](https://learn.microsoft.com/en-us/dotnet/api/system.io.pipes.namedpipeclientstream.-ctor)
 *
 * A rights value carrying neither is not a direction the constructor can produce, and it does not
 * guess: `DirectionFromRights` throws `ArgumentOutOfRangeException` — "Throw if neither ReadData nor
 * WriteData are specified, as this will result in an invalid PipeDirection"
 * ([dotnet/runtime, `NamedPipeClientStream.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.IO.Pipes/src/System/IO/Pipes/NamedPipeClientStream.Windows.cs)).
 * The measured consequence, on the 2026-09-08 Windows runs of this file's first release, was that
 * the script threw at `New-Object` and **every** Windows start reported `failed` — a pipe that was
 * never narrowed, behind a mechanism that reported the reason and was never read. `ReadData` is the
 * smaller of the two data rights and the connection never reads a byte: the daemon's own HTTP
 * server sees a connection that opens and closes without a request, which is a case every HTTP
 * server already handles. It costs one pipe instance for the duration of one `SetAccessControl`
 * call.
 *
 * **A failure is reported, never thrown**, for the reason `windows-acl.ts` gives for the token: a
 * daemon that refused to serve because PowerShell was missing would trade a wider pipe for no
 * service at all, on a platform where the pipe was wider before this module existed. `serve` says
 * on stderr which of the two protections this platform actually got.
 *
 * Everything here is a pure function except {@link restrictPipeToOwner}, so the script — the part
 * that is easy to get wrong and impossible to run from macOS — is asserted from every platform.
 */

import { spawnSync } from "node:child_process";
import process from "node:process";
import { POWERSHELL, POWERSHELL_ARGV } from "../install/register.js";

/** How long the narrowing is given before it is treated as unanswered. */
export const PIPE_ACL_TIMEOUT_MS = 20_000;

/** How long the script waits for a free instance of our own pipe, in milliseconds. */
export const PIPE_ACL_CONNECT_TIMEOUT_MS = 5_000;

/** The line the script prints on success, so the caller reads an answer rather than an exit code. */
export const PIPE_ACL_APPLIED_PREFIX = "xplainer-pipe-acl applied to";

/** What one narrowing did. The same three answers {@link AclResult} carries, for the same reasons. */
export type PipeAclResult =
  /** Not a Windows named pipe: the `0700` directory is the authentication and this adds nothing. */
  | { outcome: "not-applicable" }
  /** The descriptor now grants the creating user and nobody else. */
  | { outcome: "applied"; account: string }
  /** The pipe keeps the default descriptor, which every local account can open for reading. */
  | { outcome: "failed"; reason: string };

/**
 * The pipe's own name, without the `\\\\.\\pipe\\` prefix `NamedPipeClientStream` supplies itself.
 *
 * @throws {RangeError} for a name that is empty or carries a character that cannot survive being
 * placed in a single-quoted PowerShell string — a quote, or a line break. `--socket` is the only
 * route by which either could arrive, and pasting one into a script is not a thing to do quietly.
 */
export function pipeNameOf(pipePath: string): string {
  const name = pipePath.replace(/^\\\\[.?]\\pipe\\/i, "");
  if (name === "" || name === pipePath || /['\r\n\0]/.test(name)) {
    throw new RangeError(
      `${JSON.stringify(pipePath)} is not a named pipe this daemon can narrow: a pipe path must ` +
        "begin \\\\.\\pipe\\ and its name may not be empty or contain a quote or a line break.",
    );
  }
  return name;
}

/**
 * The PowerShell that replaces the pipe's descriptor with one entry for the account we are running
 * as.
 *
 * Written against **Windows PowerShell** (`powershell.exe`, the .NET Framework host this project
 * already shells out to in `install/register.ts`) because that is where `PipeSecurity`,
 * `PipeAccessRule` and `PipeStream.SetAccessControl` are instance members; in PowerShell 7 the same
 * three live behind `System.IO.Pipes.AccessControl`'s extension methods and the client-stream
 * constructor that takes `PipeAccessRights` is a static factory. One host, one spelling.
 *
 * `SetAccessRuleProtection($true, $false)` marks the DACL protected and copies nothing in, so the
 * result is the single entry below and not that entry beside whatever was already there — the same
 * job `/inheritance:r` does for the token file, and the half that actually removes `Everyone`.
 *
 * The identity is `WindowsIdentity::GetCurrent().User`, which is the account's own SID whether or
 * not the process is elevated: an elevated token's *owner* may be `BUILTIN\\Administrators`, and an
 * entry for the administrators group is not "the creating user only".
 *
 * **The opener's rights and the granted rights are different values, deliberately.** What is opened
 * is the minimum that can open a pipe at all and change its DACL — `ReadData` for the direction
 * .NET requires (see the top of this file), `ChangePermissions` for `WRITE_DAC` and
 * `ReadPermissions` for `READ_CONTROL` — while what is *granted* is `FullControl`, because the
 * entry replaces the whole DACL and libuv needs `FILE_CREATE_PIPE_INSTANCE` out of it to accept the
 * next connection.
 */
export function restrictPipeToOwnerScript(
  pipePath: string,
  connectTimeoutMs: number = PIPE_ACL_CONNECT_TIMEOUT_MS,
): string {
  const name = pipeNameOf(pipePath);
  return [
    "$ErrorActionPreference = 'Stop'",
    "$rights = [System.IO.Pipes.PipeAccessRights]'ReadData,ChangePermissions,ReadPermissions'",
    `$client = New-Object System.IO.Pipes.NamedPipeClientStream('.', '${name}', $rights, ` +
      "[System.IO.Pipes.PipeOptions]::None, " +
      "[System.Security.Principal.TokenImpersonationLevel]::None, " +
      "[System.IO.HandleInheritability]::None)",
    "try {",
    `  $client.Connect(${String(connectTimeoutMs)})`,
    "  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
    "  $security = New-Object System.IO.Pipes.PipeSecurity",
    "  $security.SetAccessRuleProtection($true, $false)",
    "  $security.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($me, " +
      "[System.IO.Pipes.PipeAccessRights]::FullControl, " +
      "[System.Security.AccessControl.AccessControlType]::Allow)))",
    "  $client.SetAccessControl($security)",
    // `[Console]::Out.WriteLine` and not `Write-Output`: everything PowerShell emits as a value
    // goes through its output formatter, and with stdout redirected — which it always is here —
    // that formatter wraps at a default width of 80 rather than at a terminal's. This line is the
    // prefix, a digest-length pipe name and a SID, which is comfortably past it, and a wrapped one
    // hands {@link readPipeAclAccount} half a SID as the account it reports granting. Measured on
    // `windows-latest`, 2026-09-09.
    `  [Console]::Out.WriteLine('${PIPE_ACL_APPLIED_PREFIX} ${name} for ' + $me.Value)`,
    "} finally {",
    "  $client.Dispose()",
    "}",
  ].join("\n");
}

/** The account the script reported granting, out of its one line of output. */
export function readPipeAclAccount(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(PIPE_ACL_APPLIED_PREFIX)) {
      const account = trimmed.slice(trimmed.lastIndexOf(" ") + 1);
      return account === "" ? null : account;
    }
  }
  return null;
}

/**
 * Narrow a bound named pipe to the account this process runs as, on Windows only.
 *
 * @returns what happened, for a caller that says so on stderr. It never throws, for the reason at
 * the top of this file.
 */
export function restrictPipeToOwner(
  pipePath: string,
  platform: string = process.platform,
): PipeAclResult {
  if (platform !== "win32") {
    return { outcome: "not-applicable" };
  }
  let script: string;
  try {
    script = restrictPipeToOwnerScript(pipePath);
  } catch (error) {
    return { outcome: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  const answer = spawnSync(POWERSHELL, [...POWERSHELL_ARGV, script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: PIPE_ACL_TIMEOUT_MS,
  });
  if (answer.error !== undefined) {
    return { outcome: "failed", reason: `${POWERSHELL} could not be run: ${answer.error.message}` };
  }
  if (answer.status !== 0) {
    const said = `${answer.stderr ?? ""}${answer.stdout ?? ""}`.trim().split(/\r?\n/)[0] ?? "";
    return {
      outcome: "failed",
      reason: `${POWERSHELL} exited ${String(answer.status)}${said === "" ? "" : `: ${said}`}`,
    };
  }
  const account = readPipeAclAccount(answer.stdout ?? "");
  if (account === null) {
    return {
      outcome: "failed",
      reason: `${POWERSHELL} exited 0 without saying which account it granted, so the descriptor on ${pipePath} is not known to have changed`,
    };
  }
  return { outcome: "applied", account };
}

/**
 * How the IPC endpoint is protected, as the phrase `serve` prints.
 *
 * One phrase rather than a branch at the call site, because the three answers are three different
 * security claims and the weakest of them — a Windows machine whose narrowing did not run, whose
 * pipe every local account can open for reading — is the one that must not be silent.
 */
export function pipeProtection(result: PipeAclResult): string {
  if (result.outcome === "applied") {
    return `a security descriptor granting ${result.account} and nobody else`;
  }
  if (result.outcome === "failed") {
    return (
      "WITHOUT an owner-only security descriptor, so every local account can open it for reading: " +
      result.reason
    );
  }
  return "the 0700 directory it is bound in";
}
