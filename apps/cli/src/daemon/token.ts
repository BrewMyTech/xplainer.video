/**
 * The bearer token every TCP request must carry, and the file it lives in.
 *
 * [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md) §Security R-SEC-4 puts a
 * token on **every** TCP route, `/healthz` included, and R-SEC-5 says where it lives: "File `0600`
 * inside a `0700` directory, created with `fs.open(path, "wx", 0o600)` … so it is never briefly
 * world-readable". Both rules are implemented here, and nowhere else: the guard is handed a string
 * and never a path, so there is exactly one reader of this file in the process.
 *
 * **Why `serve` mints it in phase 1, when R-SEC-5 says `setup` does.** That rule's reason is a
 * race — "a daemon that mints a token on first boot races `connect`" — and it is a race between
 * three commands, two of which exit `2` today: `xplainer setup` does not exist yet, and neither
 * does `xplainer connect`. So in this phase the only process that can mint the token is the only
 * process that needs it, and minting it here is what makes the guard non-optional rather than
 * something a user must remember to arrange. The mint is `O_EXCL`, so when `setup` arrives it takes
 * the file over by creating it first and `serve` simply reads it. ADR 0020's dated note of
 * 2026-09-06 §Phase 1 records the arrangement.
 *
 * **What the token is not** is worth repeating from that record, because a token described as a
 * sandbox is worse than no token: same-uid code reads a `0600` file trivially. It buys the browser
 * boundary — a web page can reach `127.0.0.1` and cannot read `~/.local/state` — and the other
 * local user on a shared machine. Against same-uid malware it is worth nothing.
 *
 * **Windows needs an explicit ACL, because a mode there is not protection**, also from R-SEC-5:
 * Node documents that only the write permission is settable and that the owner/group/other
 * distinction is not implemented, so a `0600` token file is readable by every account on the box.
 * The mint therefore runs `windows-acl.ts` on the file it has just created — the "explicit ACL
 * applied at creation" R-SEC-5 names, `icacls <path> /inheritance:r /grant:r "<user>:(R,W)"` — and
 * reports what that did in `DaemonToken.acl`. The other half of the same requirement — re-reading
 * the entry and warning when inheritance has been restored underneath it — is
 * `windows-acl.ts`'s `readAclVerdict`, which `xplainer daemon status` runs on the token file it
 * reports.
 *
 * **R-SEC-8's rotation lives here too, and it is a rotation rather than a replacement.** "`xplainer
 * token rotate` writes a new token with a grace window for the old one" is a promise about a daemon
 * that **stays installed**: the value in an agent's environment cannot be updated in the same
 * instant the file changes, so for the length of the window the daemon accepts **both**. The old
 * value goes into {@link previousTokenPath}, as protected as the token itself, with the instant it
 * stops being accepted written beside it; {@link createTokenRing} is what the guard asks, and it
 * re-reads both files whenever either changes, which is what lets a running daemon pick up a
 * rotation without a restart and without a control channel. `uninstall` calls none of this: T11
 * **deletes** the token file, because P2-9 asks for no live token afterwards and a rotated one is
 * still live.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import type { TokenOrigin } from "./daemon-state.js";
import { ensureStateDirectory, flushDirectory, removeIfPresent } from "./durable-write.js";
import { PRECONDITION_UNMET_EXIT_CODE, TOKEN_UNREADABLE_EXIT_CODE } from "./exit-codes.js";
import { type SettingDecision, STATE_FILE_MODE, settingFlag } from "./state-dir.js";
import { type AclResult, restrictToOwner } from "./windows-acl.js";

/** The environment variable the supervisor sets, carrying a *path* and never a value (R-SEC-6). */
export const TOKEN_FILE_ENV = "XPLAINER_TOKEN_FILE";

/**
 * The token's name inside the state directory.
 *
 * It is deliberately not part of `stateDirLayout()`: `XPLAINER_TOKEN_FILE` may put it anywhere, and
 * ADR 0020 §Port and discovery keeps it out of `XDG_RUNTIME_DIR` — where the socket belongs —
 * precisely because the token "must survive logout". A layout entry would imply a fixed home it
 * does not have.
 */
export const TOKEN_FILE = "token";

/** 32 bytes from `crypto.randomBytes`, as R-SEC-4 requires. */
export const TOKEN_BYTES = 32;

/** The environment this module reads, narrowed to what it uses. */
export type TokenEnvironment = Readonly<Record<string, string | undefined>>;

/** A token, and whether this process is the one that created it. */
export type DaemonToken = {
  /** The secret, base64url, with no surrounding whitespace. */
  value: string;
  /** The file it was read from or written to. */
  path: string;
  /** `true` only on the run that created the file, so a start-up log can say so once. */
  minted: boolean;
  /**
   * What the explicit Windows ACL did, on the run that minted the file.
   *
   * `not-applicable` everywhere but `win32`, where the mode is not the protection and
   * `daemon/windows-acl.ts` is. It is reported rather than thrown, so `serve`'s one line about the
   * token says which of the two protections this platform actually got.
   */
  acl: AclResult;
};

/**
 * The token file exists and cannot be used. Carries ADR 0020's exit code for that condition.
 *
 * "Cannot be used" covers a read that fails and a file that holds nothing: an empty token would
 * authenticate an empty `Authorization` header, which is not a weaker guard but no guard at all.
 */
export class TokenUnreadableError extends Error {
  readonly exitCode: number = TOKEN_UNREADABLE_EXIT_CODE;
  readonly path: string;

  constructor(path: string, reason: string) {
    super(
      `xplainer serve: the bearer token file ${path} exists but cannot be used (${reason}); ` +
        `refusing to serve unauthenticated, and exiting ${TOKEN_UNREADABLE_EXIT_CODE}. ` +
        "Delete the file to have the next start mint a new token, or point XPLAINER_TOKEN_FILE at " +
        "a readable one.",
    );
    this.name = "TokenUnreadableError";
    this.path = path;
  }
}

/** What {@link resolveTokenPathSetting} weighs, in precedence order. */
export type TokenPathRequest = {
  /** `serve --token-file`, which wins over the variable and the default. */
  flag?: string | undefined;
  env?: TokenEnvironment;
};

/**
 * The whole precedence: `--token-file` → `XPLAINER_TOKEN_FILE` → `token` in the state directory.
 *
 * The flag exists for the same reason the variable does — a supervisor has to be able to put the
 * token somewhere the daemon will find it — and it is above the variable because Task Scheduler's
 * `<Exec>` action has no environment map to carry one. **Both forms name a path and never a value**,
 * which is R-SEC-6 in one sentence: `/proc/<pid>/cmdline` is world-readable and
 * `Get-ScheduledTaskInfo` prints a task's arguments, so an argv route is exactly as safe as the
 * environment route was and no safer — and a `--token <value>` would have been neither.
 */
export function resolveTokenPathSetting(
  stateDir: string,
  request: TokenPathRequest = {},
): SettingDecision {
  const flag = settingFlag(request.flag);
  if (flag !== undefined) {
    return { path: flag, source: "flag" };
  }
  const env = request.env ?? process.env;
  const override = settingFlag(env[TOKEN_FILE_ENV]);
  if (override !== undefined) {
    return { path: override, source: "environment" };
  }
  return { path: join(stateDir, TOKEN_FILE), source: "default" };
}

/** Where the token lives for a caller with no flag: `XPLAINER_TOKEN_FILE`, or the default. */
export function resolveTokenPath(stateDir: string, env: TokenEnvironment = process.env): string {
  return resolveTokenPathSetting(stateDir, { env }).path;
}

/** What {@link resolveTokenOrigin} weighs. */
export type TokenOriginRequest = {
  /** Whether **this** start created the token file. */
  minted: boolean;
  /** The token file this start resolved. */
  path: string;
  /** `daemon.json`'s `token_origin`, or `null` in a directory no recording release has served. */
  recordedOrigin: TokenOrigin | null;
  /** `daemon.json`'s `token_file`, which is what makes the unrecorded case decidable. */
  recordedTokenFile: string | null;
};

/**
 * Whose token this is — the daemon's own mint, or the operator's.
 *
 * ADR 0020 §Security R-SEC-9 requires "a non-default token" for a non-loopback bind, and the value
 * cannot answer that: the mint is 32 random bytes and so is a good operator token. So the answer is
 * *provenance*, decided here and recorded in `daemon.json` so the next start inherits it:
 *
 * 1. **This start minted the file** → `minted`, unconditionally. A daemon that generated the secret
 *    a moment ago knows exactly what it is looking at.
 * 2. **`daemon.json` records an origin** → that origin. It was decided by the start that could see
 *    the file being created, and nothing since has been able to see more.
 * 3. **No origin recorded, but `daemon.json` records this same path** → `minted`. That is a state
 *    directory a release older than this field served, and every such release minted its own token
 *    into the path it recorded. Reading it as the operator's would let an upgrade turn the daemon's
 *    own default into a credential R-SEC-9 accepts, which is the one error here that matters.
 * 4. **Neither** → `operator`. A token file that exists, that this start did not make, and that no
 *    run of this state directory has ever recorded, is a file somebody else put there — which is
 *    exactly what an operator supplying a token with `--token-file` looks like.
 *
 * The rule is written so that every uncertainty falls towards `minted`, because `minted` is the
 * answer that refuses the remote bind.
 */
export function resolveTokenOrigin(request: TokenOriginRequest): TokenOrigin {
  if (request.minted) {
    return "minted";
  }
  if (request.recordedOrigin !== null) {
    return request.recordedOrigin;
  }
  return request.recordedTokenFile === request.path ? "minted" : "operator";
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Read the token at `path`, or `null` if no file is there yet. */
function readToken(path: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw new TokenUnreadableError(path, describe(error));
  }
  const value = raw.trim();
  if (value === "") {
    throw new TokenUnreadableError(path, "it holds no token");
  }
  return value;
}

/**
 * How the file this daemon just minted is protected, as the phrase `serve` prints.
 *
 * One phrase rather than two branches at the call site, because the three answers are three
 * different security claims and the weakest of them — a `win32` machine whose `icacls` did not run,
 * whose token every local account can therefore read — is the one that must not be silent.
 */
export function tokenProtection(acl: AclResult): string {
  if (acl.outcome === "applied") {
    return "owner-only ACL";
  }
  if (acl.outcome === "failed") {
    return `WITHOUT an owner-only ACL, readable by every local account: ${acl.command} ${acl.reason}`;
  }
  return `mode ${STATE_FILE_MODE.toString(8).padStart(4, "0")}`;
}

/**
 * Read the token, minting one if the file is not there.
 *
 * The create is `wx` — `O_CREAT | O_EXCL` — so two processes that reach this line together cannot
 * both believe they wrote the token: the loser gets `EEXIST` and reads the winner's file. The mode
 * argument can only *remove* bits under the umask, never add them, so `0600` is a ceiling rather
 * than a hope; the containing directory is created `0700` first, which is what protects the file on
 * a filesystem that ignores modes on individual entries.
 *
 * Throws {@link TokenUnreadableError} — exit `12` — for a file that exists and cannot be used.
 */
export function loadOrMintToken(path: string, directory?: string): DaemonToken {
  const existing = readToken(path);
  if (existing !== null) {
    return { value: existing, path, minted: false, acl: { outcome: "not-applicable" } };
  }

  if (directory !== undefined) {
    ensureStateDirectory(directory);
  }

  const value = randomBytes(TOKEN_BYTES).toString("base64url");
  let fd: number;
  try {
    fd = openSync(path, "wx", STATE_FILE_MODE);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      // Somebody else won the race between the read above and this create. Their token is the
      // token: reading it back is the only outcome in which both processes agree.
      const written = readToken(path);
      if (written === null) {
        throw new TokenUnreadableError(path, "it disappeared while being created");
      }
      return { value: written, path, minted: false, acl: { outcome: "not-applicable" } };
    }
    throw new TokenUnreadableError(path, describe(error));
  }
  try {
    writeSync(fd, `${value}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  flushDirectory(dirname(path));
  // After the write and before the token is handed to anybody: on `win32` the file was briefly
  // readable by every account on the machine, and that window is as short as a create-then-narrow
  // can make it. `open(path, "wx", 0o600)` closes the same window on the other two platforms.
  const acl = restrictToOwner(path, "file");
  return { value, path, minted: true, acl };
}

// ── R-SEC-8: rotation, and the grace window that makes it survivable ────────────────────────────

/** What is appended to the token file's name to hold the value being retired. */
export const TOKEN_PREVIOUS_SUFFIX = ".previous";

/**
 * Where the retired value waits out its window.
 *
 * Beside the token rather than inside the state directory's layout, for the reason
 * {@link TOKEN_FILE} is not in `stateDirLayout()` either: `--token-file` may put the token
 * anywhere, and a grace file somewhere else would be a second secret in a directory the operator
 * did not choose.
 */
export function previousTokenPath(tokenPath: string): string {
  return `${tokenPath}${TOKEN_PREVIOUS_SUFFIX}`;
}

/** The window the old value keeps working for when `--grace` is not given: five minutes. */
export const DEFAULT_TOKEN_GRACE_MS = 300_000;

/**
 * The longest window `token rotate` will write: one day.
 *
 * A grace window is the interval in which **two** credentials open the daemon, so it is a weakening
 * with a deadline. A day is long enough to cover an agent that is only restarted tomorrow and short
 * enough that "I rotated it" and "the old one is dead" are the same week's statement.
 */
export const MAX_TOKEN_GRACE_MS = 86_400_000;

/** The retired value and the instant it stops being accepted, as it is written to disk. */
export type TokenGraceRecord = {
  /** The value being retired. Never logged, never printed, never put in `daemon.json`. */
  token: string;
  /** ISO 8601, so a person reading the file can tell whether the window is still open. */
  grace_until: string;
};

/** What one rotation did. Carries paths and instants, and never either value. */
export type RotatedToken = {
  /** The token file, now holding the new value. */
  path: string;
  /** Where the retired value is waiting, or `null` for a rotation with no window at all. */
  previousPath: string | null;
  /** When the rotation happened. */
  rotatedAt: Date;
  /** When the retired value stops being accepted. Equal to {@link RotatedToken.rotatedAt} for `--grace 0`. */
  graceUntil: Date;
  /** What the explicit Windows ACL did to the new token file. */
  acl: AclResult;
  /** What it did to the grace file, which holds a live credential and needs the same entry. */
  previousAcl: AclResult;
};

/**
 * There is no token to rotate. Carries the "precondition unmet, nothing written" exit code.
 *
 * Distinct from {@link TokenUnreadableError} because the remedies are opposites: this one is fixed
 * by starting the daemon that mints the token, and that one by removing a file that cannot be read.
 */
export class TokenMissingError extends Error {
  readonly exitCode: number = PRECONDITION_UNMET_EXIT_CODE;
  readonly path: string;

  constructor(path: string) {
    super(
      `xplainer token rotate: there is no token at ${path}, so there is nothing to rotate and ` +
        "nothing has been written. `xplainer serve` mints one on its first start; point " +
        `--token-file or ${TOKEN_FILE_ENV} at the file if the daemon keeps its token elsewhere.`,
    );
    this.name = "TokenMissingError";
    this.path = path;
  }
}

/**
 * Write a secret to `path`, atomically, at `0600`, with the Windows entry applied before it lands.
 *
 * The mint in {@link loadOrMintToken} creates the file with `wx` and narrows it afterwards, which
 * leaves a window on `win32` where the file exists with the default inherited entries. A rotation
 * has no such window available to it and needs none: the temporary file is created `wx 0600`,
 * narrowed while nothing else knows its name, and only then renamed over the target — and an entry
 * follows a file through a rename, so what appears at `path` is already owner-only.
 */
function writeSecretFile(path: string, contents: string): AclResult {
  const temporary = `${path}.rotating`;
  removeIfPresent(temporary);
  const fd = openSync(temporary, "wx", STATE_FILE_MODE);
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const acl = restrictToOwner(temporary, "file");
  renameSync(temporary, path);
  flushDirectory(dirname(path));
  return acl;
}

/** What {@link rotateToken} weighs. */
export type RotateTokenRequest = {
  /** The token file to rotate, already resolved through {@link resolveTokenPathSetting}. */
  path: string;
  /** How long the retired value keeps working. Defaults to {@link DEFAULT_TOKEN_GRACE_MS}. */
  graceMs?: number;
  /** The clock, so a test can assert the window rather than wait for it. */
  now?: Date;
};

/**
 * Mint a new token, retire the old one for `graceMs`, and leave both readable only by this account.
 *
 * The order is the one that cannot leave the daemon locked out of itself: the **grace file is
 * written first**, so at every instant from here on at least one file on disk holds a value the
 * daemon will accept. Writing the token first would open a window in which the old value is gone
 * from both files and the new one is not yet in any agent's environment.
 *
 * `graceMs` of `0` is a rotation with no window: the grace file is removed rather than written, and
 * every client holding the old value is locked out at once. That is the right answer for a leak and
 * the wrong one for a Tuesday, which is why it is not the default.
 *
 * @throws {TokenMissingError} — exit `3` — when there is no token file to rotate.
 * @throws {TokenUnreadableError} — exit `12` — when there is one and it cannot be read.
 * @throws {RangeError} for a window that is negative or longer than {@link MAX_TOKEN_GRACE_MS}.
 */
export function rotateToken(request: RotateTokenRequest): RotatedToken {
  const graceMs = request.graceMs ?? DEFAULT_TOKEN_GRACE_MS;
  if (!Number.isFinite(graceMs) || graceMs < 0 || graceMs > MAX_TOKEN_GRACE_MS) {
    throw new RangeError(
      `a grace window is between 0 and ${String(MAX_TOKEN_GRACE_MS / 1000)} seconds, and ` +
        `${String(graceMs / 1000)} is not: two live credentials is a weakening with a deadline, ` +
        "and a deadline longer than a day is not one.",
    );
  }
  const existing = readToken(request.path);
  if (existing === null) {
    throw new TokenMissingError(request.path);
  }
  const rotatedAt = request.now ?? new Date();
  const graceUntil = new Date(rotatedAt.getTime() + graceMs);
  const previous = previousTokenPath(request.path);

  let previousAcl: AclResult = { outcome: "not-applicable" };
  if (graceMs === 0) {
    removeIfPresent(previous);
  } else {
    const record: TokenGraceRecord = { token: existing, grace_until: graceUntil.toISOString() };
    previousAcl = writeSecretFile(previous, `${JSON.stringify(record, null, 2)}\n`);
  }

  const value = randomBytes(TOKEN_BYTES).toString("base64url");
  const acl = writeSecretFile(request.path, `${value}\n`);

  return {
    path: request.path,
    previousPath: graceMs === 0 ? null : previous,
    rotatedAt,
    graceUntil,
    acl,
    previousAcl,
  };
}

/**
 * The retired value, if there is one and its window is still open.
 *
 * A record that cannot be parsed is `null` rather than an error: the grace file is an *addition* to
 * the token, and a daemon that refused to serve because a secondary credential was corrupt would
 * have turned a rotation into an outage. The primary token keeps its own strictness — an unreadable
 * one is exit `12` — because that one is the authentication itself.
 */
export function readGraceToken(previousPath: string, now: Date = new Date()): string | null {
  const grace = readGrace(previousPath);
  if (grace === null || now.getTime() >= grace.until) {
    return null;
  }
  return grace.token;
}

/** A grace file's two facts, whether or not its window is still open. */
type Grace = { token: string; until: number };

/**
 * Parse the grace file, without deciding whether the window is open.
 *
 * Separate from {@link readGraceToken} so that {@link createTokenRing} can read the file when it
 * *changes* and decide the deadline on the clock, rather than parsing JSON on every request for the
 * length of a window that may be a day long.
 */
function readGrace(previousPath: string): Grace | null {
  let raw: string;
  try {
    raw = readFileSync(previousPath, "utf8");
  } catch {
    return null;
  }
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof record !== "object" || record === null) {
    return null;
  }
  const { token, grace_until: until } = record as Record<string, unknown>;
  if (typeof token !== "string" || token === "" || typeof until !== "string") {
    return null;
  }
  const deadline = Date.parse(until);
  return Number.isFinite(deadline) ? { token, until: deadline } : null;
}

/**
 * Remove a grace file whose window has closed. Called once per start, never per request.
 *
 * A closed window is already refused by {@link createTokenRing} — expiry is decided on the clock,
 * not on the file's presence — so this is hygiene rather than enforcement: a secret that no longer
 * opens anything should not stay on disk waiting to be found in a backup.
 *
 * @returns whether a file was removed.
 */
export function discardExpiredGrace(tokenPath: string, now: Date = new Date()): boolean {
  const previous = previousTokenPath(tokenPath);
  if (!existsSync(previous)) {
    return false;
  }
  if (readGraceToken(previous, now) !== null) {
    return false;
  }
  removeIfPresent(previous);
  return true;
}

/** The values a guard accepts right now: the live token, and the retired one inside its window. */
export type TokenRing = {
  /** Newest first, so the ordinary request matches on the first comparison. */
  tokens: () => readonly string[];
};

/** What {@link createTokenRing} weighs. */
export type TokenRingRequest = {
  /** The token file this daemon read at start. */
  path: string;
  /** The clock, so a test can close a grace window without waiting for it. */
  now?: () => Date;
};

/** A file's identity for the purpose of "has this changed", or `absent`. */
function fileStamp(path: string): string {
  try {
    const stats = statSync(path);
    return `${String(stats.mtimeMs)}:${String(stats.size)}:${String(stats.ino)}`;
  } catch {
    return "absent";
  }
}

/**
 * The set of accepted values, re-read from disk whenever either file changes.
 *
 * **Why the guard asks a function rather than holding a string.** `xplainer token rotate` runs in
 * *another process*, and the daemon it rotates for is one that stays installed. Something has to
 * carry the new value across, and the two files are already that something: a `stat` of each per
 * request costs microseconds, changes nothing on the happy path, and needs no control route, no
 * signal and no restart. The alternative — an authenticated `POST /api/daemon/reload-token` — adds
 * a route whose only caller is a command that already has write access to the file it is asking
 * about.
 *
 * **A read that fails keeps the previous answer.** Replacing the token is a rename, and a rename
 * over an open file is exactly where Windows returns `EBUSY`; a ring that answered "no tokens" for
 * that one request would turn every rotation into a burst of `401`s. The cached values stay, and
 * the stamp is left unchanged so the next request tries again.
 */
export function createTokenRing(request: TokenRingRequest): TokenRing {
  const clock = request.now ?? ((): Date => new Date());
  const previousPath = previousTokenPath(request.path);
  let stamp: string | null = null;
  let current: string | null = null;
  let previous: Grace | null = null;

  return {
    tokens: (): readonly string[] => {
      const seen = `${fileStamp(request.path)}|${fileStamp(previousPath)}`;
      if (seen !== stamp) {
        let read: string | null;
        try {
          read = readToken(request.path);
        } catch {
          // An unreadable token file is `serve`'s exit `12` at start-up; mid-flight it is a file
          // being replaced, and the values already held are the better answer.
          read = null;
        }
        if (read !== null) {
          current = read;
          previous = readGrace(previousPath);
          stamp = seen;
        }
      }
      const accepted: string[] = [];
      if (current !== null) {
        accepted.push(current);
      }
      // The deadline is compared on every request while the *file* is only read when it changes:
      // a window closes with both files sitting exactly as they are, and that is the ordinary way
      // one ends.
      if (previous !== null && clock().getTime() < previous.until) {
        accepted.push(previous.token);
      }
      return accepted;
    },
  };
}
