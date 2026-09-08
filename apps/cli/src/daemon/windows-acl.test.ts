/**
 * The `icacls` invocation ADR 0020 §R-SEC-5 specifies, asserted from a machine that cannot run it.
 *
 * The same arrangement `process-group.ts`'s Job Object keeper is under, and for the same reason:
 * the command line is the part that is easy to get wrong, it is only exercised on `win32`, and a
 * project whose CI has one Windows leg cannot afford to learn about a typo there from a proof that
 * takes fifteen minutes to fail. What a Windows runner is for is whether the ACL this composes is
 * the ACL the filesystem ends up with, which is `commands/serve.test.ts`'s token cases.
 */

import { describe, expect, it } from "vitest";
import {
  ACL_DIRECTORY_RIGHTS,
  ACL_FILE_RIGHTS,
  aclQuery,
  parseAclEntries,
  readAclVerdict,
  restrictToOwner,
  restrictToOwnerCommand,
} from "./windows-acl.js";

describe("the explicit ACL for a Windows file", () => {
  it("removes inheritance and grants this account, in one invocation", () => {
    const { program, argv } = restrictToOwnerCommand(
      "C:\\Users\\alice\\AppData\\Local\\xplainer\\state\\token",
      "file",
      "alice",
    );

    expect(program).toBe("icacls");
    expect(argv).toEqual([
      "C:\\Users\\alice\\AppData\\Local\\xplainer\\state\\token",
      // Both halves, in this order: granting the owner changes nothing while `BUILTIN\Users` is
      // still on the file by inheritance, which is the ordinary state of anything under
      // `%LOCALAPPDATA%` on a machine with a second account.
      "/inheritance:r",
      "/grant:r",
      `alice:${ACL_FILE_RIGHTS}`,
    ]);
    expect(ACL_FILE_RIGHTS).toBe("(R,W)");
  });

  /**
   * A directory needs the inherit flags, or the entry protects the directory and nothing the daemon
   * later writes into it.
   */
  it("gives a directory the inheritance flags a file does not need", () => {
    const { argv } = restrictToOwnerCommand("C:\\state", "directory", "alice");

    expect(argv[3]).toBe(`alice:${ACL_DIRECTORY_RIGHTS}`);
    expect(ACL_DIRECTORY_RIGHTS).toBe("(OI)(CI)(F)");
  });

  /** The argv is a vector, so nothing has to escape the parentheses in `(OI)(CI)(F)`. */
  it("passes the entry as one argument rather than through a shell", () => {
    const { argv } = restrictToOwnerCommand("C:\\a b\\token", "file", "alice");

    expect(argv[0]).toBe("C:\\a b\\token");
    expect(argv).toHaveLength(4);
  });

  it("refuses an account name that would be pasted into an access-control entry", () => {
    for (const name of ["", "   ", "al:ice", 'al"ice', "al,ice", "MACHINE\\alice"]) {
      expect(() => restrictToOwnerCommand("C:\\token", "file", name)).toThrow(RangeError);
    }
  });

  /**
   * Off Windows it is not "it worked": there is nothing here to apply, the mode already carries the
   * property, and a caller that reported success would be reporting a protection twice.
   */
  it("does nothing at all on a platform whose mode is the protection", () => {
    expect(restrictToOwner("/tmp/token", "file", "darwin")).toEqual({ outcome: "not-applicable" });
    expect(restrictToOwner("/tmp/token", "file", "linux")).toEqual({ outcome: "not-applicable" });
  });
});

/**
 * R-SEC-5's second half — "…and `xplainer daemon status` re-verifies it and warns if inheritance
 * has been restored" — asserted against the bytes `icacls` prints rather than against a machine.
 *
 * The transcripts below are `icacls`'s real output shape: the path on the first line followed by
 * its first entry, indented continuations, a blank line and the processed-files trailer. Getting
 * that parse wrong is how a re-verification reports "owner-only" about output it did not
 * understand, which is worse than not looking.
 */
const TOKEN_PATH = "C:\\Users\\alice\\AppData\\Local\\xplainer\\state\\token";

const NARROWED = `${TOKEN_PATH} MACHINE\\alice:(R,W)

Successfully processed 1 files; Failed processing 0 files
`;

const INHERITANCE_RESTORED = `${TOKEN_PATH} BUILTIN\\Administrators:(I)(F)
                              NT AUTHORITY\\SYSTEM:(I)(F)
                              MACHINE\\alice:(I)(F)

Successfully processed 1 files; Failed processing 0 files
`;

function answered(
  stdout: string,
  status = 0,
): {
  started: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
} {
  return { started: true, status, stdout, stderr: "" };
}

describe("reading a Windows access-control entry back", () => {
  it("parses the path off the first line and the continuations after it", () => {
    const entries = parseAclEntries(INHERITANCE_RESTORED, TOKEN_PATH);

    expect(entries).toEqual([
      { account: "BUILTIN\\Administrators", rights: "(I)(F)", inherited: true },
      { account: "NT AUTHORITY\\SYSTEM", rights: "(I)(F)", inherited: true },
      { account: "MACHINE\\alice", rights: "(I)(F)", inherited: true },
    ]);
  });

  /** An account name may hold spaces, so the entry is matched from the rights blob backwards. */
  it("keeps an account name that contains a space", () => {
    const entries = parseAclEntries(`${TOKEN_PATH} MACHINE\\Some User:(R,W)\n`, TOKEN_PATH);

    expect(entries).toEqual([{ account: "MACHINE\\Some User", rights: "(R,W)", inherited: false }]);
  });

  it("calls one entry for this account, not inherited, owner-only", () => {
    const verdict = readAclVerdict(TOKEN_PATH, answered(NARROWED), "alice", "win32");

    expect(verdict.state).toBe("owner-only");
    expect(verdict.detail).toContain("MACHINE\\alice");
  });

  /**
   * The warning R-SEC-5 asks for by name. It has to say *what* it found and name the command that
   * puts the file back, because the reader of this line is somebody who did not restore the
   * inheritance themselves.
   */
  it("warns, names the entries and names the remedy when inheritance is back", () => {
    const verdict = readAclVerdict(TOKEN_PATH, answered(INHERITANCE_RESTORED), "alice", "win32");

    expect(verdict.state).toBe("widened");
    expect(verdict.detail).toContain("Inheritance has been restored");
    expect(verdict.detail).toContain("BUILTIN\\Administrators:(I)(F)");
    expect(verdict.detail).toContain(`icacls ${TOKEN_PATH} /inheritance:r /grant:r "alice:(R,W)"`);
  });

  /** A second principal with no `(I)` is not inheritance — it is a grant somebody made. */
  it("warns about another account even when nothing is inherited", () => {
    const stdout = `${TOKEN_PATH} MACHINE\\alice:(R,W)
                              MACHINE\\bob:(R)

Successfully processed 1 files; Failed processing 0 files
`;

    const verdict = readAclVerdict(TOKEN_PATH, answered(stdout), "alice", "win32");

    expect(verdict.state).toBe("widened");
    expect(verdict.detail).toContain("another account has been added");
  });

  /**
   * "I could not look" is its own answer. Reporting a file whose entry was never read as owner-only
   * would be the report claiming a protection nothing established.
   */
  it("says unknown when icacls did not run, or said nothing it understood", () => {
    expect(
      readAclVerdict(
        TOKEN_PATH,
        { started: false, status: null, stdout: "", stderr: "" },
        "alice",
        "win32",
      ).state,
    ).toBe("unknown");
    expect(
      readAclVerdict(TOKEN_PATH, answered("Access is denied.", 5), "alice", "win32").state,
    ).toBe("unknown");
  });

  /** Off Windows there is no entry to re-verify and the mode already carries the property. */
  it("has nothing to re-verify on a platform whose mode is the protection", () => {
    const verdict = readAclVerdict("/state/token", answered(""), "alice", "darwin");

    expect(verdict.state).toBe("not-applicable");
    expect(verdict.detail).toContain("protected by its mode");
  });

  /** A query and nothing else: no `/grant`, no `/inheritance`, so `daemon status` stays read-only. */
  it("reads the entry with a query that changes nothing", () => {
    expect(aclQuery(TOKEN_PATH)).toEqual({ program: "icacls", argv: [TOKEN_PATH] });
  });
});
