/**
 * `<state>/config.json` — the owner's non-secret settings — and the document shape it shares with
 * `credentials.json`.
 *
 * Both files live in the state directory (`daemon/state-dir.ts`) rather than in a workspace or a
 * repository, for the reason spec D1 gives: it is already `0700`, it already travels to the
 * narration worker as `XPLAINER_STATE_DIR`, and it is the one store a supervised daemon reliably
 * reads — a shell export never reaches launchd, systemd or Task Scheduler.
 *
 * **One shape for both files.** `{ "format_version": 1, "tts": { … } }`, where a setting's dotted
 * name is its path into the document. The reader and the two edits below are shared with
 * `credentials.ts`, which differs only in how the bytes reach the disk.
 *
 * **An unreadable file is an error, never "no config".** Invalid JSON, a document that is not an
 * object, a missing or unknown `format_version`, or a known setting holding something other than a
 * string all raise {@link StateDocumentUnreadableError} — exit `11`, the table's code for a state
 * file that exists and cannot be read. Answering `null` instead would turn a typo in a hand-edited
 * file into a silent switch back to every default, which for `tts.provider` means a narration in a
 * different voice than the owner chose. An **absent** file is the ordinary state of a machine
 * nobody has configured, and is `null`.
 *
 * **What a writer does not understand, it keeps.** Unknown top-level keys and unknown keys inside
 * `tts` survive every write, so a newer build's setting is not erased by an older build's
 * `config set`. A newer `format_version` is refused rather than rewritten, for the same reason.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureStateDirectory, writeJsonDurably } from "../daemon/durable-write.js";
import { STATE_UNREADABLE_EXIT_CODE } from "../daemon/exit-codes.js";
import { type ConfigKey, configKeySpec } from "./keys.js";

/** The non-secret settings file's name inside the state directory. */
export const USER_CONFIG_FILE = "config.json";

/** The one `format_version` this build reads and writes, for both files. */
export const USER_CONFIG_FORMAT_VERSION = 1;

/** A parsed `config.json` or `credentials.json`: a JSON object carrying `format_version: 1`. */
export type StateDocument = Record<string, unknown>;

/**
 * `config.json` or `credentials.json` exists and cannot be used. Carries exit `11`.
 *
 * `reason` never quotes the file's contents. `credentials.json` holds an API key, and the parser's
 * own message for invalid JSON quotes the text around the fault — so the reason for a parse failure
 * is a fixed phrase for the secret file, and every other reason names a key or a version, never a
 * value.
 */
export class StateDocumentUnreadableError extends Error {
  readonly exitCode: number = STATE_UNREADABLE_EXIT_CODE;
  readonly path: string;
  readonly reason: string;

  constructor(path: string, reason: string) {
    super(
      `${path} exists and cannot be read (${reason}). Nothing was assumed in its place: ` +
        "correct the file, or delete it to return every setting it holds to its default.",
    );
    this.name = "StateDocumentUnreadableError";
    this.path = path;
    this.reason = reason;
  }
}

/** Where `config.json` lives in `stateDir`. */
export function userConfigPath(stateDir: string): string {
  return join(stateDir, USER_CONFIG_FILE);
}

/**
 * Read and check one of the two documents, or `null` when the file is not there.
 *
 * `secret` decides only what a parse failure may say about itself; see
 * {@link StateDocumentUnreadableError}.
 */
export function readStateDocument(path: string, secret: boolean): StateDocument | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw new StateDocumentUnreadableError(path, describe(error));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new StateDocumentUnreadableError(
      path,
      secret ? "it is not valid JSON" : `it is not valid JSON: ${describe(error)}`,
    );
  }
  if (!isObject(parsed)) {
    throw new StateDocumentUnreadableError(path, "it does not hold a JSON object");
  }
  const version = parsed.format_version;
  if (version === undefined) {
    throw new StateDocumentUnreadableError(path, "it records no format_version");
  }
  if (version !== USER_CONFIG_FORMAT_VERSION) {
    throw new StateDocumentUnreadableError(
      path,
      typeof version === "number"
        ? `it records format_version ${String(version)}, and this build reads only ` +
            `${String(USER_CONFIG_FORMAT_VERSION)}`
        : "its format_version is not a number",
    );
  }
  return parsed;
}

/**
 * The string stored at `key` in `document`, or `null` when nothing is.
 *
 * A container on the way that is not an object, or a value that is not a string, makes the whole
 * file unreadable rather than the one setting absent: either is a hand edit gone wrong, and the
 * module comment says why guessing past one is the worse answer.
 */
export function documentValue(
  document: StateDocument | null,
  path: string,
  key: ConfigKey,
): string | null {
  let node: unknown = document;
  const segments = key.split(".");
  for (const [index, segment] of segments.entries()) {
    if (node === null || node === undefined) {
      return null;
    }
    if (!isObject(node)) {
      throw new StateDocumentUnreadableError(
        path,
        `${segments.slice(0, index).join(".")} is not an object`,
      );
    }
    node = node[segment];
  }
  if (node === undefined || node === null) {
    return null;
  }
  if (typeof node !== "string") {
    throw new StateDocumentUnreadableError(path, `${key} is not a string`);
  }
  return node;
}

/** A copy of `document` — or of an empty one — with `value` stored at `key`, everything else kept. */
export function withDocumentValue(
  document: StateDocument | null,
  path: string,
  key: ConfigKey,
  value: string,
): StateDocument {
  const root: StateDocument = {
    format_version: USER_CONFIG_FORMAT_VERSION,
    ...structuredCopy(document),
  };
  const segments = key.split(".");
  let node = root;
  for (const [index, segment] of segments.slice(0, -1).entries()) {
    const next = node[segment];
    if (next === undefined || next === null) {
      const created: StateDocument = {};
      node[segment] = created;
      node = created;
    } else if (isObject(next)) {
      node = next;
    } else {
      throw new StateDocumentUnreadableError(
        path,
        `${segments.slice(0, index + 1).join(".")} is not an object`,
      );
    }
  }
  node[lastSegment(segments)] = value;
  return root;
}

/**
 * A copy of `document` without `key`, or `null` when there was nothing at `key` to remove.
 *
 * A container this removal leaves empty is removed with it, so setting and then unsetting a key
 * leaves the file as it was found rather than holding `"elevenlabs": {}`. Containers that were
 * already empty, or that still hold anything — known or not — are kept.
 */
export function withoutDocumentValue(
  document: StateDocument | null,
  path: string,
  key: ConfigKey,
): StateDocument | null {
  if (documentValue(document, path, key) === null) {
    return null;
  }
  const root = structuredCopy(document);
  const segments = key.split(".");
  const trail: StateDocument[] = [root];
  for (const segment of segments.slice(0, -1)) {
    const next = trail[trail.length - 1]?.[segment];
    if (!isObject(next)) {
      return null;
    }
    trail.push(next);
  }
  delete trail[trail.length - 1]?.[lastSegment(segments)];
  for (let depth = trail.length - 1; depth > 0; depth -= 1) {
    const container = trail[depth];
    const segment = segments[depth - 1];
    if (container === undefined || segment === undefined || Object.keys(container).length > 0) {
      break;
    }
    delete trail[depth - 1]?.[segment];
  }
  return root;
}

/**
 * The value `config.json` holds for `key`, or `null` when the file or the setting is absent.
 *
 * @throws {StateDocumentUnreadableError} for a file that exists and cannot be used.
 */
export function readUserConfigValue(stateDir: string, key: ConfigKey): string | null {
  requireNonSecret(key);
  const path = userConfigPath(stateDir);
  return documentValue(readStateDocument(path, false), path, key);
}

/**
 * Store `value` at `key` in `config.json`, keeping everything else the file holds.
 *
 * The state directory is created `0700` if it is not there, and the file is written through
 * `writeJsonDurably` — temp, `fsync`, `rename`, `fsync` the directory — at `0600`, the mode every
 * file in that directory gets. The value is not validated here; `keys.ts` is asked first, by the
 * command.
 *
 * @throws {StateDocumentUnreadableError} for an existing file that cannot be used: it is not
 * overwritten, because keeping what a writer does not understand is the rule above.
 */
export function writeUserConfigValue(stateDir: string, key: ConfigKey, value: string): void {
  requireNonSecret(key);
  const path = userConfigPath(stateDir);
  const document = readStateDocument(path, false);
  const next = withDocumentValue(document, path, key, value);
  ensureStateDirectory(stateDir);
  writeJsonDurably(path, next);
}

/**
 * Remove `key` from `config.json`. Answers whether it was there to remove.
 *
 * @throws {StateDocumentUnreadableError} for an existing file that cannot be used.
 */
export function unsetUserConfigValue(stateDir: string, key: ConfigKey): boolean {
  requireNonSecret(key);
  const path = userConfigPath(stateDir);
  const next = withoutDocumentValue(readStateDocument(path, false), path, key);
  if (next === null) {
    return false;
  }
  writeJsonDurably(path, next);
  return true;
}

/**
 * A secret never goes through this file, in either direction.
 *
 * Spec D2's whole argument for two files is that the non-secret one has nothing in it to redact; a
 * call that put the API key here would make every `config list` and bug report a leak.
 */
function requireNonSecret(key: ConfigKey): void {
  if (configKeySpec(key).secret) {
    throw new Error(`${key} is a secret and is stored in credentials.json, never in config.json`);
  }
}

function isObject(value: unknown): value is StateDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A deep copy, so an edit never reaches the document a caller still holds. */
function structuredCopy(document: StateDocument | null): StateDocument {
  return document === null ? {} : structuredClone(document);
}

function lastSegment(segments: readonly string[]): string {
  const last = segments[segments.length - 1];
  if (last === undefined) {
    throw new Error("a setting's name has at least one segment");
  }
  return last;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
