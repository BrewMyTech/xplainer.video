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
 * **Windows is an honest gap**, also from R-SEC-5: Node documents that only the write permission is
 * settable there and that the owner/group/other distinction is not implemented, so a `0600` token
 * file is readable by every account on the box. The explicit ACL that fixes it belongs to
 * `xplainer daemon install`, which is phase 2; nothing here pretends otherwise.
 */

import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { ensureStateDirectory, flushDirectory } from "./durable-write.js";
import { TOKEN_UNREADABLE_EXIT_CODE } from "./exit-codes.js";
import { STATE_FILE_MODE } from "./state-dir.js";

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

/** Where the token lives: `XPLAINER_TOKEN_FILE`, or `token` inside the state directory. */
export function resolveTokenPath(stateDir: string, env: TokenEnvironment = process.env): string {
  const override = env[TOKEN_FILE_ENV];
  if (override !== undefined && override.trim() !== "") {
    return override;
  }
  return join(stateDir, TOKEN_FILE);
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
    return { value: existing, path, minted: false };
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
      return { value: written, path, minted: false };
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
  return { value, path, minted: true };
}
