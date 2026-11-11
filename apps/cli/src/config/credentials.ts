/**
 * `<state>/credentials.json` — the one file a third-party secret is kept in.
 *
 * It is protected exactly as the daemon's bearer token is
 * ([ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md) §Security R-SEC-5 and
 * R-SEC-6), because it is the same rule applied to a second credential (spec D2): the value lives
 * in this file and nowhere else — never on argv, in a log line, a job record or a printed sentence —
 * and the file is `0600` inside the `0700` state directory, with an explicit owner-only entry on
 * Windows, where a mode is not protection.
 *
 * **Every write is a whole new file.** A temporary file is created empty, `wx` at
 * `STATE_FILE_MODE` — so on POSIX it is never, even briefly, readable by anybody else — narrowed by
 * `daemon/windows-acl.ts` before the key is written into it, and only then renamed over
 * `credentials.json`. That is `daemon/token.ts`'s rotation write, with the two differences
 * `writeSecretDocument` gives: an entry follows a file through a rename, so what appears at the path is already owner-only, and a file whose mode
 * somebody had loosened is replaced by one that is not. `writeJsonDurably` is not used here because
 * it creates with `w` and applies no entry; `config.json` holds nothing worth either.
 *
 * The document shape, the reader and the refusal for an unreadable file are `user-config.ts`'s. The
 * one difference on the way in is that a parse failure here says only "it is not valid JSON": the
 * parser's own message quotes the text around the fault, which in this file is the key.
 *
 * **What `daemon uninstall` does with it: nothing.** The file is the owner's credential for
 * somebody else's service, not the daemon's, so removing it is `xplainer config unset`'s job.
 */

import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { ensureStateDirectory, flushDirectory, removeIfPresent } from "../daemon/durable-write.js";
import { STATE_FILE_MODE } from "../daemon/state-dir.js";
import { tokenProtection } from "../daemon/token.js";
import { restrictToOwner } from "../daemon/windows-acl.js";
import { type ConfigKey, configKeySpec } from "./keys.js";
import {
  documentValue,
  readStateDocument,
  type StateDocument,
  withDocumentValue,
  withoutDocumentValue,
} from "./user-config.js";

/** The secrets file's name inside the state directory. */
export const CREDENTIALS_FILE = "credentials.json";

/** What one write did: where the secret went, and what protects it, as a phrase to print. */
export type StoredCredential = {
  path: string;
  /**
   * `mode 0600` or `owner-only ACL`. Never the third phrase `tokenProtection` has, for a failed
   * `icacls`: that is a refusal here, and nothing is stored.
   */
  protection: string;
};

/** Where `credentials.json` lives in `stateDir`. */
export function credentialsPath(stateDir: string): string {
  return join(stateDir, CREDENTIALS_FILE);
}

/**
 * The secret stored for `key`, or `null` when the file or the entry is absent.
 *
 * The narration worker is the caller that needs the value. A command that prints asks only whether
 * this is `null`.
 *
 * @throws {StateDocumentUnreadableError} for a file that exists and cannot be used.
 */
export function readCredential(stateDir: string, key: ConfigKey): string | null {
  requireSecret(key);
  const path = credentialsPath(stateDir);
  return documentValue(readStateDocument(path, true), path, key);
}

/**
 * Store `value` for `key`, keeping every other entry the file holds.
 *
 * The value is not validated here; `keys.ts` is asked first, by the command.
 *
 * @throws {StateDocumentUnreadableError} for an existing file that cannot be used. It is not
 * replaced: an entry this build does not understand may be the owner's only copy of something.
 */
export function writeCredential(stateDir: string, key: ConfigKey, value: string): StoredCredential {
  requireSecret(key);
  const path = credentialsPath(stateDir);
  const next = withDocumentValue(readStateDocument(path, true), path, key, value);
  ensureStateDirectory(stateDir);
  return { path, protection: writeSecretDocument(path, next) };
}

/**
 * Remove `key` from the file. Answers whether it was there to remove.
 *
 * The file is rewritten through the same protected write rather than edited, so the value is gone
 * from the file the moment this returns.
 *
 * @throws {StateDocumentUnreadableError} for an existing file that cannot be used.
 */
export function removeCredential(stateDir: string, key: ConfigKey): boolean {
  requireSecret(key);
  const path = credentialsPath(stateDir);
  const next = withoutDocumentValue(readStateDocument(path, true), path, key);
  if (next === null) {
    return false;
  }
  writeSecretDocument(path, next);
  return true;
}

/**
 * `daemon/token.ts`'s protected write, for a JSON document: `wx 0600`, narrow, write, rename, flush.
 *
 * The temporary name carries the pid, so two `config set`s racing each other each get their own; a
 * leftover from a process that died holding this pid is removed first, because `wx` would refuse it.
 *
 * **Two orderings differ from the token's, both because this is somebody else's credential.** The
 * file is narrowed while it is still **empty**, and the key is written only into a file that is
 * already owner-only — on Windows a mode is no protection, so a file written first and narrowed
 * second is readable, for the length of an `icacls` spawn, by whatever the directory's inherited
 * entries allow. And an `icacls` that **fails** is a refusal here rather than a warning: the token
 * is the daemon's own and a daemon that will not start is worse than a weaker file, but a
 * `config set` that stores nothing costs one re-run, while a stored key readable by every local
 * account costs the owner a rotation at a third party.
 */
function writeSecretDocument(path: string, document: StateDocument): string {
  const temporary = join(dirname(path), `.${basename(path)}.${String(process.pid)}.tmp`);
  removeIfPresent(temporary);
  closeSync(openSync(temporary, "wx", STATE_FILE_MODE));
  try {
    const acl = restrictToOwner(temporary, "file");
    if (acl.outcome === "failed") {
      throw new Error(
        `${path} could not be made owner-only (${acl.command}: ${acl.reason}), so the key was not ` +
          "stored. Nothing was written.",
      );
    }
    const fd = openSync(temporary, "r+");
    try {
      writeSync(fd, `${JSON.stringify(document, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    flushDirectory(dirname(path));
    return tokenProtection(acl);
  } catch (error) {
    // A temporary file that outlived a failed write may hold the secret, so it does not stay.
    removeQuietly(temporary);
    throw error;
  }
}

/**
 * A setting that is not a secret never goes through this file, in either direction: the reader of
 * `credentials.json` is the one place the narration worker takes a key from, and a voice id stored
 * here would be a setting `config list` reports from a file nobody looks in.
 */
function requireSecret(key: ConfigKey): void {
  if (!configKeySpec(key).secret) {
    throw new Error(
      `${key} is not a secret and is stored in config.json, never in credentials.json`,
    );
  }
}

/** Delete the temporary file on the failure path, swallowing every error: the caller holds the real one. */
function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // The temporary file is this process's own and its absence is the desired state.
  }
}
