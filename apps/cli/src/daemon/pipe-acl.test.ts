/**
 * The security descriptor the named pipe is given, asserted from a machine that has no named pipes.
 *
 * The same arrangement `windows-acl.test.ts` and `process-group.ts`'s Job Object keeper are under,
 * and for the same reason: the script is the part that is easy to get wrong, it runs on one
 * platform, and a project whose CI has one Windows leg cannot afford to learn about a typo there
 * from a proof that takes fifteen minutes to fail. What a Windows runner is for is whether the
 * descriptor this composes is the descriptor the pipe ends up with, and whether a **second local
 * account** is kept out by it — which is `daemon-windows.yml`'s two-account job and cannot be
 * answered anywhere else.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WINDOWS_PIPE_PREFIX } from "./ipc.js";
import {
  PIPE_ACL_APPLIED_PREFIX,
  PIPE_ACL_CONNECT_TIMEOUT_MS,
  pipeNameOf,
  pipeProtection,
  readPipeAclAccount,
  restrictPipeToOwner,
  restrictPipeToOwnerScript,
} from "./pipe-acl.js";

const PIPE = `${WINDOWS_PIPE_PREFIX}xplainer-0123456789abcdef`;

describe("the pipe's own name", () => {
  it("is what is left after the machine-local prefix", () => {
    expect(pipeNameOf(PIPE)).toBe("xplainer-0123456789abcdef");
    expect(pipeNameOf("\\\\?\\pipe\\xplainer-abc")).toBe("xplainer-abc");
  });

  /**
   * `--socket` is the one route by which an arbitrary string reaches this module, and a quote or a
   * line break in one would be pasted straight into a single-quoted PowerShell string.
   */
  it("refuses a path that is not a named pipe, or a name that cannot be quoted", () => {
    for (const path of [
      "/tmp/xplainer.sock",
      WINDOWS_PIPE_PREFIX,
      `${WINDOWS_PIPE_PREFIX}it's-mine`,
      `${WINDOWS_PIPE_PREFIX}two\nlines`,
    ]) {
      expect(() => pipeNameOf(path)).toThrow(RangeError);
    }
  });
});

/** The verbatim script beside this file, `#` provenance header stripped. */
const NARROW_FIXTURE = fileURLToPath(
  new URL("./__fixtures__/pipe-acl-narrow.ps1", import.meta.url),
);

/**
 * The fixture's own bytes, with only the `#` header removed.
 *
 * Stripped by prefix rather than by line count, for the reason `preflight.test.ts` strips its
 * `launchctl` capture the same way: a longer header must not silently become a truncated fixture.
 * No line of the script itself begins with `#`.
 */
function narrowFixture(): string {
  return readFileSync(NARROW_FIXTURE, "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .trim();
}

/** The rights the **opener** asks for, as the script spells them, one per element. */
function openerRights(script: string): string[] {
  const declaration = /\$rights = \[System\.IO\.Pipes\.PipeAccessRights]'([^']+)'/.exec(script);
  if (declaration === null) {
    throw new Error(`the script declares no opener rights:\n${script}`);
  }
  return (declaration[1] ?? "").split(",").map((right) => right.trim());
}

describe("the script that replaces the descriptor", () => {
  /**
   * The whole emitted script, compared with a committed capture.
   *
   * A `toContain` per clause is what let the first release ship a script that could not run at all:
   * every individual assertion passed while the one line they were about — the opener's rights —
   * named a value .NET refuses. The script is thirteen lines and runs on a platform this suite
   * cannot execute, so the reviewable unit is the whole of it, as a diff.
   */
  it("is exactly the capture beside this file", () => {
    expect(restrictPipeToOwnerScript(PIPE)).toBe(narrowFixture());
  });

  /**
   * The rule the capture has to satisfy, stated independently of it.
   *
   * `NamedPipeClientStream`'s `PipeAccessRights` constructor **derives the pipe direction from
   * these rights** — "If the `desiredAccessRights` value is `ReadData`, the pipe direction will be
   * `In`" — and `DirectionFromRights` throws `ArgumentOutOfRangeException` for a value carrying
   * neither `ReadData` nor `WriteData`, because that is not a direction. A rights value of
   * `ChangePermissions,ReadPermissions` therefore never opens the pipe, never reaches
   * `SetAccessControl`, and leaves the default descriptor — every local account reading — behind a
   * mechanism that reports `failed` and is read by nobody. That is what happened on 2026-09-08.
   */
  it("asks for a data right, because .NET derives the direction from it", () => {
    const rights = openerRights(restrictPipeToOwnerScript(PIPE));

    expect(rights.includes("ReadData") || rights.includes("WriteData")).toBe(true);
    // The minimum that opens a pipe: read is a direction, write would be one this never uses.
    expect(rights).not.toContain("WriteData");
    // And the two that make it a *narrowing* rather than a connection: WRITE_DAC and READ_CONTROL.
    expect(rights).toContain("ChangePermissions");
    expect(rights).toContain("ReadPermissions");
  });

  /**
   * Three more things are load-bearing: the DACL is **protected**, which is what removes the
   * default `Everyone` entry rather than adding beside it; the entry granted is `FullControl`,
   * because creating the next pipe instance needs `FILE_CREATE_PIPE_INSTANCE` and libuv creates one
   * per accepted connection; and the identity is the token's `User` SID rather than its owner,
   * which under elevation is the administrators group.
   */
  it("protects the DACL, and grants this account full control", () => {
    const script = restrictPipeToOwnerScript(PIPE);

    expect(script).toContain("$security.SetAccessRuleProtection($true, $false)");
    expect(script).toContain("[System.IO.Pipes.PipeAccessRights]::FullControl");
    expect(script).toContain("[System.Security.Principal.WindowsIdentity]::GetCurrent().User");
    expect(script).toContain("$client.SetAccessControl($security)");
    expect(script).not.toContain("PipeDirection");
  });

  it("names the pipe without its prefix, and waits a bounded time for a free instance", () => {
    const script = restrictPipeToOwnerScript(PIPE);

    expect(script).toContain("'xplainer-0123456789abcdef'");
    expect(script).not.toContain(WINDOWS_PIPE_PREFIX);
    expect(script).toContain(`$client.Connect(${String(PIPE_ACL_CONNECT_TIMEOUT_MS)})`);
  });

  /** The handle is given back whether the call succeeded or not: a leaked one is a busy instance. */
  it("disposes the client in a finally", () => {
    const script = restrictPipeToOwnerScript(PIPE);

    expect(script).toContain("} finally {");
    expect(script).toContain("$client.Dispose()");
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
  });

  /** The caller reads an account out of the output, so an exit code alone is never "applied". */
  it("prints the account it granted, and that line is what is read back", () => {
    const script = restrictPipeToOwnerScript(PIPE);
    expect(script).toContain(`Write-Output ('${PIPE_ACL_APPLIED_PREFIX}`);

    expect(
      readPipeAclAccount(
        `${PIPE_ACL_APPLIED_PREFIX} xplainer-0123456789abcdef for S-1-5-21-1-2-3-1001\r\n`,
      ),
    ).toBe("S-1-5-21-1-2-3-1001");
    expect(readPipeAclAccount("something else entirely\n")).toBeNull();
  });
});

describe("restrictPipeToOwner", () => {
  /**
   * Off Windows it is not "it worked": there is nothing here to narrow, the `0700` directory
   * already carries the property, and a caller that reported success would be reporting a
   * protection twice.
   */
  it("does nothing at all on a platform whose directory is the protection", () => {
    expect(restrictPipeToOwner(PIPE, "darwin")).toEqual({ outcome: "not-applicable" });
    expect(restrictPipeToOwner(PIPE, "linux")).toEqual({ outcome: "not-applicable" });
  });

  /** A path that cannot be narrowed is reported, never thrown — the daemon still serves. */
  it("reports a path it cannot narrow rather than throwing", () => {
    const result = restrictPipeToOwner("/tmp/not-a-pipe.sock", "win32");

    expect(result.outcome).toBe("failed");
    expect(result.outcome === "failed" ? result.reason : "").toContain("is not a named pipe");
  });
});

describe("what serve says the IPC endpoint is protected by", () => {
  it("names the account on success and the exposure on failure", () => {
    expect(pipeProtection({ outcome: "applied", account: "S-1-5-21-7" })).toBe(
      "a security descriptor granting S-1-5-21-7 and nobody else",
    );
    expect(pipeProtection({ outcome: "not-applicable" })).toBe("the 0700 directory it is bound in");

    const failed = pipeProtection({ outcome: "failed", reason: "powershell.exe exited 1" });
    expect(failed).toContain("WITHOUT an owner-only security descriptor");
    expect(failed).toContain("every local account can open it for reading");
    expect(failed).toContain("powershell.exe exited 1");
  });
});
