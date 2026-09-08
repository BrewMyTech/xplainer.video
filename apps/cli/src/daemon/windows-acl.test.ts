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
