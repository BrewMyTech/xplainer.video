/**
 * The bearer token file: where it is, how it is created, and what makes it unusable.
 *
 * ADR 0020 §Security R-SEC-4 and R-SEC-5 are two requirements about one file — 32 random bytes,
 * `0600` inside a `0700` directory — and R-SEC-6 is a third about its *path* travelling in the
 * environment while the value never does. All three are asserted against the real filesystem: a
 * mode is only a mode if `stat` agrees, and a token that "exists but cannot be used" is a condition
 * you can only produce with a real file.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { PRECONDITION_UNMET_EXIT_CODE, TOKEN_UNREADABLE_EXIT_CODE } from "./exit-codes.js";
import { STATE_DIR_MODE, STATE_FILE_MODE } from "./state-dir.js";
import { ownerOnly, protectionOf } from "./testing/platform.js";
import {
  createTokenRing,
  DEFAULT_TOKEN_GRACE_MS,
  discardExpiredGrace,
  inspectTokenPresence,
  loadOrMintToken,
  MAX_TOKEN_GRACE_MS,
  previousTokenPath,
  readGraceToken,
  resolveTokenOrigin,
  resolveTokenPath,
  resolveTokenPathSetting,
  rotateToken,
  TOKEN_BYTES,
  TOKEN_FILE,
  TOKEN_FILE_ENV,
  TOKEN_PREVIOUS_SUFFIX,
  TokenMissingError,
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

/**
 * R-SEC-9's "a non-default token", made decidable.
 *
 * The value cannot answer this — the mint is 32 random bytes and so is a good operator token — so
 * the answer is provenance, and the ordering of these four cases is the whole rule. The one that
 * matters most is the third: a state directory served by a release older than `token_origin`
 * recorded the path it minted into, and reading that as the operator's would let an upgrade turn
 * this daemon's own default into a credential a remote bind accepts.
 */
describe("resolveTokenOrigin", () => {
  const path = "/state/token";

  it("calls the file this start created its own, whatever is recorded", () => {
    expect(
      resolveTokenOrigin({
        minted: true,
        path,
        recordedOrigin: "operator",
        recordedTokenFile: path,
      }),
    ).toBe("minted");
  });

  it.each(["minted", "operator"] as const)("inherits a recorded origin of %s", (recorded) => {
    expect(
      resolveTokenOrigin({
        minted: false,
        path,
        recordedOrigin: recorded,
        recordedTokenFile: path,
      }),
    ).toBe(recorded);
  });

  it("reads an unrecorded origin at a path a previous run recorded as this daemon's mint", () => {
    expect(
      resolveTokenOrigin({
        minted: false,
        path,
        recordedOrigin: null,
        recordedTokenFile: path,
      }),
    ).toBe("minted");
  });

  it.each([
    ["a directory nothing has recorded", null],
    ["a path that is not the recorded one", "/state/other-token"],
  ])(
    "calls a file it did not make and cannot account for the operator's: %s",
    (_case, recorded) => {
      expect(
        resolveTokenOrigin({
          minted: false,
          path,
          recordedOrigin: null,
          recordedTokenFile: recorded,
        }),
      ).toBe("operator");
    },
  );

  /**
   * The correction of 2026-09-08. `token_origin` records whose the token in `token_file` is, and a
   * record about `<state>/token` says nothing about the file `--token-file` has just named. Reading
   * it as an answer about *this* path refused an operator's own token for ever — a state directory
   * that had once minted could never be given one — and the refusal then said this daemon had
   * minted a file it never wrote.
   */
  it.each(["minted", "operator"] as const)(
    "does not carry a recorded %s origin over to a file it does not name",
    (recorded) => {
      expect(
        resolveTokenOrigin({
          minted: false,
          path: "/etc/xplainer/operator-token",
          recordedOrigin: recorded,
          recordedTokenFile: path,
        }),
      ).toBe("operator");
    },
  );
});

/**
 * The same rule, plus the answer R-SEC-9 has to have **before** the mint: there is no file at all.
 *
 * Every case here is a real file on disk rather than a fixture, because the question is what is at
 * a path, and the whole point of asking it here is that nothing may be written by the asking.
 */
describe("inspectTokenPresence", () => {
  it("says a path with nothing at it is absent, and writes nothing there", () => {
    const stateDir = stateDirectory();
    const path = join(stateDir, TOKEN_FILE);

    expect(inspectTokenPresence({ path, recordedOrigin: null, recordedTokenFile: null })).toBe(
      "absent",
    );
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it("calls this state directory's own recorded mint minted", () => {
    const stateDir = stateDirectory();
    const path = join(stateDir, TOKEN_FILE);
    loadOrMintToken(path, stateDir);

    expect(inspectTokenPresence({ path, recordedOrigin: "minted", recordedTokenFile: path })).toBe(
      "minted",
    );
  });

  it("calls a token at a path this daemon never recorded the operator's", () => {
    const stateDir = stateDirectory();
    const elsewhere = join(stateDirectory(), "operator-token");
    writeFileSync(elsewhere, `${"o".repeat(43)}\n`, { mode: 0o600 });

    expect(
      inspectTokenPresence({
        path: elsewhere,
        recordedOrigin: "minted",
        recordedTokenFile: join(stateDir, TOKEN_FILE),
      }),
    ).toBe("operator");
  });

  /** A file that cannot be used is exit `12` here too: the mint would have said the same thing. */
  it("refuses a token file that holds nothing, rather than calling it absent", () => {
    const stateDir = stateDirectory();
    const path = join(stateDir, TOKEN_FILE);
    writeFileSync(path, "   \n", { mode: 0o600 });

    expect(() =>
      inspectTokenPresence({ path, recordedOrigin: null, recordedTokenFile: null }),
    ).toThrow(TokenUnreadableError);
  });
});

describe("rotateToken", () => {
  /**
   * The whole of R-SEC-8 in one case: a new value in the token file, the old one still on disk with
   * a deadline, and neither of them anywhere a reader of `daemon.json` could find it.
   */
  it("writes a new token and keeps the old one for the window", () => {
    const stateDir = stateDirectory();
    const path = join(stateDir, TOKEN_FILE);
    const before = loadOrMintToken(path, stateDir);
    const at = new Date("2026-09-08T10:00:00.000Z");

    const rotated = rotateToken({ path, graceMs: 60_000, now: at });

    const after = readFileSync(path, "utf8").trim();
    expect(after).not.toBe(before.value);
    expect(Buffer.from(after, "base64url")).toHaveLength(TOKEN_BYTES);
    expect(rotated.previousPath).toBe(previousTokenPath(path));
    expect(rotated.graceUntil.toISOString()).toBe("2026-09-08T10:01:00.000Z");
    expect(readGraceToken(previousTokenPath(path), at)).toBe(before.value);
  });

  /** The grace file holds a live credential, so it is protected exactly as the token is. */
  it("gives the retired value the same protection the token has", () => {
    const stateDir = stateDirectory();
    const path = join(stateDir, TOKEN_FILE);
    loadOrMintToken(path, stateDir);

    rotateToken({ path, graceMs: 60_000 });

    expect(protectionOf(previousTokenPath(path))).toBe(ownerOnly(STATE_FILE_MODE));
    expect(protectionOf(path)).toBe(ownerOnly(STATE_FILE_MODE));
  });

  /**
   * `--grace 0` is the answer to a leak, and it has to leave nothing behind: a grace file from an
   * earlier rotation would keep a value alive that this rotation exists to kill.
   */
  it("removes an earlier grace file when the window is zero", () => {
    const stateDir = stateDirectory();
    const path = join(stateDir, TOKEN_FILE);
    loadOrMintToken(path, stateDir);
    rotateToken({ path, graceMs: 60_000 });
    expect(existsSync(previousTokenPath(path))).toBe(true);

    const rotated = rotateToken({ path, graceMs: 0 });

    expect(rotated.previousPath).toBeNull();
    expect(existsSync(previousTokenPath(path))).toBe(false);
  });

  /** Nothing to rotate is a precondition, not a failure: exit `3`, and nothing is written. */
  it("refuses a token file that is not there, having written nothing", () => {
    const stateDir = stateDirectory();
    const path = join(stateDir, TOKEN_FILE);

    let raised: unknown;
    try {
      rotateToken({ path });
    } catch (error) {
      raised = error;
    }

    expect(raised).toBeInstanceOf(TokenMissingError);
    expect((raised as TokenMissingError).exitCode).toBe(PRECONDITION_UNMET_EXIT_CODE);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(previousTokenPath(path))).toBe(false);
  });

  /** A window is a weakening with a deadline, so there is a longest one and it is checked here. */
  it("refuses a window longer than a day, or a negative one", () => {
    const stateDir = stateDirectory();
    const path = join(stateDir, TOKEN_FILE);
    const minted = loadOrMintToken(path, stateDir);

    expect(() => rotateToken({ path, graceMs: MAX_TOKEN_GRACE_MS + 1 })).toThrow(RangeError);
    expect(() => rotateToken({ path, graceMs: -1 })).toThrow(RangeError);
    expect(readFileSync(path, "utf8").trim()).toBe(minted.value);
  });

  it("names the grace file beside the token, whatever --token-file put it", () => {
    expect(previousTokenPath("/run/secrets/xplainer")).toBe(
      `/run/secrets/xplainer${TOKEN_PREVIOUS_SUFFIX}`,
    );
  });
});

describe("readGraceToken", () => {
  /** A closed window is decided on the clock, so the same file answers differently a minute later. */
  it("stops answering once the window has closed", () => {
    const stateDir = stateDirectory();
    const path = join(stateDir, TOKEN_FILE);
    const before = loadOrMintToken(path, stateDir);
    const at = new Date("2026-09-08T10:00:00.000Z");
    rotateToken({ path, graceMs: 60_000, now: at });

    expect(readGraceToken(previousTokenPath(path), new Date(at.getTime() + 59_000))).toBe(
      before.value,
    );
    expect(readGraceToken(previousTokenPath(path), new Date(at.getTime() + 60_000))).toBeNull();
  });

  /**
   * The grace file is an addition to the token, never the authentication itself, so a corrupt one
   * is `null` rather than an error. The token keeps its own strictness, which the case above this
   * file's `loadOrMintToken` block asserts.
   */
  it("reads a corrupt record as no grace at all", () => {
    const stateDir = stateDirectory();
    const previous = join(stateDir, `${TOKEN_FILE}${TOKEN_PREVIOUS_SUFFIX}`);
    writeFileSync(previous, "{not json", { mode: STATE_FILE_MODE });

    expect(readGraceToken(previous)).toBeNull();

    writeFileSync(previous, JSON.stringify({ token: "", grace_until: "2099-01-01T00:00:00.000Z" }));
    expect(readGraceToken(previous)).toBeNull();
  });
});

describe("discardExpiredGrace", () => {
  it("removes a closed window's file and leaves an open one alone", () => {
    const stateDir = stateDirectory();
    const path = join(stateDir, TOKEN_FILE);
    loadOrMintToken(path, stateDir);
    const at = new Date("2026-09-08T10:00:00.000Z");
    rotateToken({ path, graceMs: 60_000, now: at });

    expect(discardExpiredGrace(path, new Date(at.getTime() + 30_000))).toBe(false);
    expect(existsSync(previousTokenPath(path))).toBe(true);

    expect(discardExpiredGrace(path, new Date(at.getTime() + 61_000))).toBe(true);
    expect(existsSync(previousTokenPath(path))).toBe(false);
    expect(discardExpiredGrace(path, new Date(at.getTime() + 62_000))).toBe(false);
  });
});

describe("createTokenRing", () => {
  /**
   * The property the whole rotation rests on: the daemon holds no string, so a file written by
   * another process is picked up without a restart and both values open the daemon until the
   * window closes.
   */
  it("accepts the new token and the retired one, then only the new one", () => {
    const stateDir = stateDirectory();
    const path = join(stateDir, TOKEN_FILE);
    const before = loadOrMintToken(path, stateDir);
    const at = new Date("2026-09-08T10:00:00.000Z");
    let clock = at;
    const ring = createTokenRing({ path, now: () => clock });

    expect(ring.tokens()).toEqual([before.value]);

    rotateToken({ path, graceMs: 60_000, now: at });
    const after = readFileSync(path, "utf8").trim();

    expect(ring.tokens()).toEqual([after, before.value]);

    clock = new Date(at.getTime() + 61_000);
    expect(ring.tokens()).toEqual([after]);
  });

  /** A rotation with no window locks the old holder out on the very next request. */
  it("drops the old value at once when the rotation kept no window", () => {
    const stateDir = stateDirectory();
    const path = join(stateDir, TOKEN_FILE);
    const before = loadOrMintToken(path, stateDir);
    const ring = createTokenRing({ path });
    expect(ring.tokens()).toEqual([before.value]);

    rotateToken({ path, graceMs: 0 });

    expect(ring.tokens()).not.toContain(before.value);
    expect(ring.tokens()).toHaveLength(1);
  });

  /**
   * A read that fails keeps the previous answer, because the one moment the token file is
   * unreadable is the moment something is renaming over it — and a burst of `401`s is a worse
   * answer to a rotation than a request served with the value this daemon last read.
   */
  it("keeps the values it has when the file cannot be read", () => {
    const stateDir = stateDirectory();
    const path = join(stateDir, TOKEN_FILE);
    const minted = loadOrMintToken(path, stateDir);
    const ring = createTokenRing({ path });
    expect(ring.tokens()).toEqual([minted.value]);

    writeFileSync(path, "   \n", { mode: STATE_FILE_MODE });

    expect(ring.tokens()).toEqual([minted.value]);
  });

  it("defaults the window to five minutes", () => {
    expect(DEFAULT_TOKEN_GRACE_MS).toBe(300_000);
  });
});
