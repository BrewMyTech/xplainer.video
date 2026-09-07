/**
 * Replacing a file that belongs to somebody else's program, without ever leaving half of one.
 *
 * `connect` is the first thing in this repository that edits a file **outside** the state directory:
 * `~/.claude.json` holds a user's whole Claude Code state and `~/.codex/config.toml` holds their
 * whole Codex configuration, and both are read by a program that may be running right now. A
 * truncate-then-write that is interrupted — a `SIGINT`, a full disk — leaves that program with a
 * file it cannot parse and a user with no obvious way back. So the new content is written beside the
 * target and `rename`d over it, which is atomic for any reader within the filesystem.
 *
 * This is deliberately **not** `daemon/durable-write.ts`. That module answers a different question —
 * "will this record survive the machine losing power" — and pays for the answer with two `fsync`s
 * and a forced `0600` mode on everything it writes. Here the file's mode is the *other* program's
 * decision and is preserved exactly; only a file this command creates gets a mode of its own, and it
 * is the restrictive one, because an agent configuration is a file both vendors already keep at
 * `0600` on this machine.
 */

import { chmodSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import process from "node:process";

/** The mode a configuration file gets when `connect` is the one creating it. */
export const CONFIG_FILE_MODE = 0o600;

/** The mode a configuration *directory* gets when `connect` is the one creating it. */
export const CONFIG_DIR_MODE = 0o700;

/** The current mode of `path`, or `null` when there is no file there yet. */
function currentMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

/**
 * Write `text` to `path`, atomically, keeping the mode the file already had.
 *
 * The temporary file is created in the target's own directory: `rename` is only atomic within one
 * filesystem, and a name carrying this pid cannot collide with another `connect` running beside it.
 */
export function writeFileAtomically(path: string, text: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: CONFIG_DIR_MODE });
  const existing = currentMode(path);
  const temporary = join(directory, `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, text, { mode: existing ?? CONFIG_FILE_MODE });
    if (existing !== null) {
      // `writeFileSync`'s `mode` is only applied when it creates the file, and a stale temporary
      // from a crashed run would otherwise hand its own mode to the target.
      chmodSync(temporary, existing);
    }
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary is this process's own, and its absence is the desired state.
    }
    throw error;
  }
}
