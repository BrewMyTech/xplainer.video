/**
 * The record a committed acquisition carries **inside itself**, and the check a warm cache passes.
 *
 * This module exists because of a defect, and the defect is worth stating: until it was written,
 * `providers/speech-bundle.ts` skipped the download **and the verification** whenever its
 * destination directory already existed, and then recorded `sha256: entry.sha256` — the digest the
 * manifest had merely *told* it — for a tree nothing on this machine had ever checked. Three things
 * were wrong at once. A populated destination bypassed verify-before-extract entirely. The recorded
 * digest was an assertion rather than an observation, which is exactly the distinction
 * `apps/cli/AGENTS.md` §`src/setup/` draws when it says digests are expected and never recorded.
 * And **cache identity bound the version, not the digest**: a re-published artefact at the same
 * version would be served out of the cold cache for ever, because the directory name matched.
 *
 * **So an acquisition records what it was admitted on, in the tree it commits.** `acquireArtefact`
 * calls {@link stageAcquired} after extraction and before the `rename`, which is what makes the
 * record present exactly when the tree is: a receipt written after the rename would leave a window
 * in which a correct tree carries none, and a later run that refuses a tree with no receipt would
 * then refuse correct work.
 *
 * **Why a file in the tree rather than the marker.** `toolchain.json` also records digests, and it
 * is the wrong place for this check twice over: it can be absent while the tree is present (a
 * `setup` that was interrupted between the two, a state directory whose marker was cleaned), and it
 * is written by the *caller* of a provider rather than by the provider that knows what it fetched.
 * A record inside the tree travels with the tree, is committed by the same `rename`, and answers
 * the one question a warm cache asks: **is what is here the thing whose digest was reviewed?**
 *
 * **What is verified, and what is only witnessed.** The archive's own digest is verified before
 * extraction and is not re-derivable afterwards — a tree is not its tarball — so the receipt
 * *records* it and a warm run compares the record against the expectation. What a warm run really
 * re-verifies is the {@link AcquiredRecord.files} inventory: a caller-named, deliberately **small**
 * set of load-bearing files, each with the digest and length of what came out of the verified
 * archive. That is enough because the tree was committed by one atomic `rename`, so a witness
 * inside it is a witness for it; and it is honest, because a several-hundred-megabyte tree's every
 * file is not something to hash on each `setup`.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { ToolchainFile } from "@xplainer/protocol";
import { hashFile } from "../runtime/manifest.js";

/** The record's name inside the tree it describes. */
export const ACQUIRED_FILE = ".acquired.json";

/** The shape this build writes and reads. A newer one is reported, never guessed at. */
export const ACQUIRED_FORMAT_VERSION = 1;

/** One witnessed file, at a path **relative to the tree**, so the tree stays relocatable. */
export type AcquiredFile = {
  /** `/`-separated and relative to the committed directory. */
  path: string;
  sha256: string;
  bytes: number;
};

/** What one committed acquisition says about itself. */
export type AcquiredRecord = {
  format_version: number;
  /** The URL the archive came from. */
  url: string;
  /** The **reviewed** digest the archive was admitted on, which is what a warm run compares. */
  sha256: string;
  /** The archive's length, as the reviewed manifest or the pinned table records it. */
  size: number;
  /** When it was committed, RFC 3339, so a support report can say how old the tree is. */
  acquired_at: string;
  /** The load-bearing files inside the tree, with what they hashed to when they came out of it. */
  files: readonly AcquiredFile[];
};

/** What an artefact was admitted on: the three fields a warm run has to agree with. */
export type AcquiredExpectation = {
  url: string;
  sha256: string;
  size: number;
};

/** Why a populated destination was not trusted. One value per distinguishable condition. */
export type AcquiredVerdictReason =
  | "no-record"
  | "unreadable-record"
  | "newer-record"
  | "different-artefact"
  | "file-missing"
  | "file-changed";

/**
 * Whether a tree that is already there may be used.
 *
 * A discriminated union rather than a boolean and a message, so a caller that has checked `ok` has
 * the inventory and a caller that has not has a sentence naming what is wrong.
 */
export type AcquiredVerdict =
  | { ok: true; record: AcquiredRecord; files: readonly ToolchainFile[] }
  | { ok: false; reason: AcquiredVerdictReason; detail: string };

/**
 * Write the record into a staging tree, hashing each witness as it goes.
 *
 * `witnesses` are destination-relative paths the caller has decided are load-bearing; a path that
 * is not in the tree is a **refusal**, because a witness list naming a file the extraction did not
 * produce is a list that would witness nothing on the next run.
 */
export function stageAcquired(
  staging: string,
  expectation: AcquiredExpectation,
  witnesses: readonly string[],
  now: () => Date = () => new Date(),
): AcquiredRecord {
  const files: AcquiredFile[] = witnesses.map((witness) => {
    const absolute = join(staging, ...witness.split("/"));
    if (!existsSync(absolute)) {
      throw new Error(
        `${expectation.url} was unpacked and does not contain ${witness}, which this provider ` +
          "names as one of the files the component is made of. Nothing was committed.",
      );
    }
    return { path: witness, sha256: hashFile(absolute), bytes: statSync(absolute).size };
  });
  const record: AcquiredRecord = {
    format_version: ACQUIRED_FORMAT_VERSION,
    url: expectation.url,
    sha256: expectation.sha256,
    size: expectation.size,
    acquired_at: now().toISOString(),
    files,
  };
  writeFileSync(join(staging, ACQUIRED_FILE), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** Read a tree's own record, or `null` where there is nothing readable to read. */
export function readAcquired(destination: string): AcquiredRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(destination, ACQUIRED_FILE), "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const document = parsed as Record<string, unknown>;
  const files = asFiles(document.files);
  if (
    typeof document.format_version !== "number" ||
    typeof document.url !== "string" ||
    typeof document.sha256 !== "string" ||
    typeof document.size !== "number" ||
    typeof document.acquired_at !== "string" ||
    files === null
  ) {
    return null;
  }
  return {
    format_version: document.format_version,
    url: document.url,
    sha256: document.sha256,
    size: document.size,
    acquired_at: document.acquired_at,
    files,
  };
}

function asFiles(value: unknown): AcquiredFile[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const files: AcquiredFile[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return null;
    }
    const raw = entry as Record<string, unknown>;
    if (
      typeof raw.path !== "string" ||
      raw.path === "" ||
      typeof raw.sha256 !== "string" ||
      typeof raw.bytes !== "number"
    ) {
      return null;
    }
    files.push({ path: raw.path, sha256: raw.sha256, bytes: raw.bytes });
  }
  return files;
}

/**
 * Judge a destination that is already there against what the current pin expects.
 *
 * The order is the order of the repairs. No record at all, or one this build cannot read, means the
 * tree was not committed by a build that writes them — it is a cold cache wearing a warm cache's
 * name, and the whole defect this module exists for. A record from a **newer** build is reported as
 * a rollback signal rather than as corruption, the same rule the marker and the job store apply. A
 * record naming a different digest is a different artefact under the same name. And then every
 * witness is re-hashed, because "the digest was checked once, in a run that is over" is not a fact
 * about the file that is on the disk now.
 */
export function verifyAcquired(
  destination: string,
  expectation: AcquiredExpectation,
): AcquiredVerdict {
  const record = readAcquired(destination);
  const at = join(destination, ACQUIRED_FILE);
  if (record === null) {
    return {
      ok: false,
      reason: existsSync(at) ? "unreadable-record" : "no-record",
      detail:
        `${destination} is already there and ${at} ${existsSync(at) ? "cannot be read" : "does not exist"}, ` +
        "so nothing on this machine says the tree under that name is the artefact whose digest " +
        `was reviewed. setup will not record a digest it has not checked. Remove ${destination} ` +
        "and run setup again.",
    };
  }
  if (record.format_version > ACQUIRED_FORMAT_VERSION) {
    return {
      ok: false,
      reason: "newer-record",
      detail:
        `${at} says format_version ${record.format_version} and this build reads ` +
        `${ACQUIRED_FORMAT_VERSION}. It was written by a newer xplainer and is left exactly as it ` +
        "is: this is a rollback signal, not corruption. Run setup from the runtime installed now.",
    };
  }
  if (record.sha256 !== expectation.sha256 || record.size !== expectation.size) {
    return {
      ok: false,
      reason: "different-artefact",
      detail:
        `${destination} was acquired from ${record.url} at sha256 ${record.sha256} ` +
        `(${record.size} bytes) and this build expects ${expectation.sha256} ` +
        `(${expectation.size} bytes) from ${expectation.url}. Same name, different artefact — ` +
        `which is what a re-published artefact at an unchanged version looks like. Remove ` +
        `${destination} and run setup again.`,
    };
  }
  const files: ToolchainFile[] = [];
  for (const file of record.files) {
    const absolute = join(destination, ...file.path.split("/"));
    if (!existsSync(absolute)) {
      return {
        ok: false,
        reason: "file-missing",
        detail:
          `${absolute} is recorded in ${at} and is no longer on this machine. The tree says setup ` +
          "acquired it; the path says it has since been moved or cleaned away.",
      };
    }
    const bytes = statSync(absolute).size;
    // Length first, so a truncated or replaced file is refused without hashing ninety megabytes.
    const digest = bytes === file.bytes ? hashFile(absolute) : null;
    if (digest !== file.sha256) {
      const found = digest ?? "(not hashed: the length already disagrees)";
      return {
        ok: false,
        reason: "file-changed",
        detail:
          `${absolute} is ${bytes} bytes hashing to ${found} and ${at} records ${file.bytes} ` +
          `bytes at ${file.sha256}. It has been changed since it was acquired. Remove ` +
          `${destination} and run setup again.`,
      };
    }
    files.push({ path: absolute, sha256: file.sha256, bytes: file.bytes });
  }
  return { ok: true, record, files };
}

/**
 * A tree-relative, `/`-separated witness path from an absolute one.
 *
 * The record stores relative paths so the tree stays relocatable — a state directory is moved and
 * restored for a living — and this is the one conversion, so the separator is normalised in one
 * place rather than at each provider.
 */
export function witnessPath(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/");
}
