/**
 * The bearer token file: where it is, how it is created, and what makes it unusable.
 *
 * ADR 0020 §Security R-SEC-4 and R-SEC-5 are two requirements about one file — 32 random bytes,
 * `0600` inside a `0700` directory — and R-SEC-6 is a third about its *path* travelling in the
 * environment while the value never does. All three are asserted against the real filesystem: a
 * mode is only a mode if `stat` agrees, and a token that "exists but cannot be used" is a condition
 * you can only produce with a real file.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { TOKEN_UNREADABLE_EXIT_CODE } from "./exit-codes.js";
import { STATE_DIR_MODE, STATE_FILE_MODE } from "./state-dir.js";
import { ownerOnly, protectionOf } from "./testing/platform.js";
import {
  loadOrMintToken,
  resolveTokenPath,
  resolveTokenPathSetting,
  TOKEN_BYTES,
  TOKEN_FILE,
  TOKEN_FILE_ENV,
  TokenUnreadableError,
  tokenProtection,
} from "./token.js";

const scratch: string[] = [];

function stateDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "xplainer-token-"));
  scratch.push(dir);
  return dir;
}

/**
 * What keeps another local account out, whichever mechanism this platform has.
 *
 * On POSIX it is the mode, read off `stat`. On Windows `stat` reports `0666` for the file this mint
 * created and the DACL is the protection, so `protectionOf` reads that instead — the entry
 * `windows-acl.ts` applies at creation, which is the second half of what this case is about.
 */

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveTokenPath", () => {
  it("puts the token inside the state directory by default", () => {
    expect(resolveTokenPath("/state", {})).toBe(join("/state", TOKEN_FILE));
  });

  /** R-SEC-6: the unit carries a *path*, so the override has to win over the layout. */
  it("obeys XPLAINER_TOKEN_FILE", () => {
    expect(resolveTokenPath("/state", { [TOKEN_FILE_ENV]: "/run/secrets/xplainer" })).toBe(
      "/run/secrets/xplainer",
    );
  });

  it("ignores an override that is empty or blank", () => {
    expect(resolveTokenPath("/state", { [TOKEN_FILE_ENV]: "   " })).toBe(
      join("/state", TOKEN_FILE),
    );
  });
});

/**
 * The flag is above the variable for the reason the state directory's is: `<Exec>` carries
 * arguments and no environment. It is a **path** on both routes, which is what keeps R-SEC-6 true —
 * `/proc/<pid>/cmdline` is world-readable and `Get-ScheduledTaskInfo` prints a task's arguments, so
 * argv is exactly as safe as the environment was, and a `--token <value>` would have been neither.
 */
describe("resolveTokenPathSetting", () => {
  it("puts --token-file above XPLAINER_TOKEN_FILE and above the default", () => {
    expect(
      resolveTokenPathSetting("/state", {
        flag: "/run/user/1000/xplainer/token",
        env: { [TOKEN_FILE_ENV]: "/from/the/environment" },
      }),
    ).toEqual({ path: "/run/user/1000/xplainer/token", source: "flag" });
  });

  it("falls back to the variable, then to the state directory, saying which", () => {
    expect(
      resolveTokenPathSetting("/state", { env: { [TOKEN_FILE_ENV]: "/from/the/environment" } }),
    ).toEqual({ path: "/from/the/environment", source: "environment" });
    expect(resolveTokenPathSetting("/state", { env: {} })).toEqual({
      path: join("/state", TOKEN_FILE),
      source: "default",
    });
  });

  it("ignores a blank flag rather than resolving the token to nothing", () => {
    expect(resolveTokenPathSetting("/state", { flag: "  ", env: {} })).toEqual({
      path: join("/state", TOKEN_FILE),
      source: "default",
    });
  });
});

describe("loadOrMintToken", () => {
  it("mints 32 random bytes only this account can read, and says it minted them", () => {
    const stateDir = join(stateDirectory(), "nested");
    const path = join(stateDir, TOKEN_FILE);

    const token = loadOrMintToken(path, stateDir);

    expect(token.minted).toBe(true);
    expect(token.path).toBe(path);
    expect(Buffer.from(token.value, "base64url")).toHaveLength(TOKEN_BYTES);
    // `0600` inside a `0700` directory on POSIX; on Windows the two explicit ACLs that replace
    // them, because a mode there is not protection (ADR 0020 §R-SEC-5).
    expect(protectionOf(path)).toBe(ownerOnly(STATE_FILE_MODE));
    expect(protectionOf(stateDir)).toBe(ownerOnly(STATE_DIR_MODE));
    // And the mint says which of the two it got, so `serve` can print it.
    expect(token.acl.outcome).toBe(process.platform === "win32" ? "applied" : "not-applicable");
  });

  /**
   * The sentence `serve` prints, in all three of its forms.
   *
   * The weakest of them is the one that matters: a `win32` machine whose `icacls` did not run has a
   * token every local account can read, and that has to be a sentence a person can find in the log
   * rather than something inferred from its absence.
   */
  it("says which of a mode and an ACL protected the file it minted", () => {
    expect(tokenProtection({ outcome: "not-applicable" })).toBe("mode 0600");
    expect(tokenProtection({ outcome: "applied", command: "icacls C:\\t /inheritance:r" })).toBe(
      "owner-only ACL",
    );

    const failed = tokenProtection({
      outcome: "failed",
      command: "icacls C:\\t /inheritance:r /grant:r alice:(R,W)",
      reason: "exited 5: Access is denied.",
    });
    expect(failed).toContain("WITHOUT an owner-only ACL");
    expect(failed).toContain("readable by every local account");
    expect(failed).toContain("icacls C:\\t");
    expect(failed).toContain("exited 5: Access is denied.");
  });

  it("mints a different token every time", () => {
    const first = loadOrMintToken(join(stateDirectory(), TOKEN_FILE));
    const second = loadOrMintToken(join(stateDirectory(), TOKEN_FILE));

    expect(first.value).not.toBe(second.value);
  });

  it("reads an existing token back rather than replacing it", () => {
    const stateDir = stateDirectory();
    const path = join(stateDir, TOKEN_FILE);
    const minted = loadOrMintToken(path, stateDir);

    const reread = loadOrMintToken(path, stateDir);

    expect(reread.value).toBe(minted.value);
    expect(reread.minted).toBe(false);
  });

  it("trims the newline it wrote, so the value never carries whitespace", () => {
    const path = join(stateDirectory(), TOKEN_FILE);
    writeFileSync(path, "  a-token-with-space  \n", { mode: STATE_FILE_MODE });

    expect(loadOrMintToken(path).value).toBe("a-token-with-space");
  });

  /**
   * An empty token would authenticate an empty `Authorization` header, which is not a weaker guard
   * but no guard at all — so it is the same refusal as a file that cannot be read.
   */
  it(`refuses an empty token file with exit ${TOKEN_UNREADABLE_EXIT_CODE}`, () => {
    const path = join(stateDirectory(), TOKEN_FILE);
    writeFileSync(path, "\n");

    expect(() => loadOrMintToken(path)).toThrow(TokenUnreadableError);
    try {
      loadOrMintToken(path);
      expect.unreachable("the empty token file was accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(TokenUnreadableError);
      if (error instanceof TokenUnreadableError) {
        expect(error.exitCode).toBe(TOKEN_UNREADABLE_EXIT_CODE);
        expect(error.path).toBe(path);
        expect(error.message).toContain("holds no token");
      }
    }
  });

  /**
   * A directory where the file should be is the portable way to make a read fail: `chmod 000` would
   * still be readable by a test running as root, and this condition is about the *refusal*, not
   * about which errno produced it.
   */
  it("refuses a token path that cannot be read at all", () => {
    const path = join(stateDirectory(), TOKEN_FILE);
    mkdirSync(path);

    expect(() => loadOrMintToken(path)).toThrow(TokenUnreadableError);
  });

  it("names a remedy a user can act on", () => {
    const path = join(stateDirectory(), TOKEN_FILE);
    writeFileSync(path, "");

    try {
      loadOrMintToken(path);
      expect.unreachable("the empty token file was accepted");
    } catch (error) {
      expect(String(error)).toContain("Delete the file");
      expect(String(error)).toContain(TOKEN_FILE_ENV);
    }
  });

  /** Nothing here may write the value anywhere but the file itself (R-SEC-6). */
  it("keeps the value out of the process environment", () => {
    const path = join(stateDirectory(), TOKEN_FILE);

    const token = loadOrMintToken(path);

    expect(Object.values(process.env)).not.toContain(token.value);
  });
});
