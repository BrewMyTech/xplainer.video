/**
 * The durable progress record an update writes at every boundary, and what a reader may conclude.
 *
 * ADR 0025 §Part one gives the update six ordered steps. An ordered sequence has no answer to "the
 * updater died", and T15's whole subject is that answer: the steps become a **transaction**, and a
 * transaction needs somewhere durable to say which transition it last completed. This file is that
 * somewhere — `<state>/update.json`, written **temp → `fsync` → `rename`** through
 * `daemon/durable-write.ts`, which is the same mechanism `daemon.json` and every job record use and
 * for the same reason: a `SIGKILL` on the next line must not lose the fact.
 *
 * **The transitions are boundaries, and the work between two of them is idempotent.** That is the
 * property recovery rests on, and it is a design rule rather than an observation: a resume does not
 * *repair* a half-done step, it **repeats** it. Rewriting an artefact that is already correct,
 * re-staging a payload that is already staged (the name is its content, so the stager copies
 * nothing) and re-running a supervisor reload are all no-ops on a machine where they already
 * happened. So a record that says `drained` licenses "switch, start, wait" with no inspection of
 * how far the switch had got, and there is no state between the boundaries that a reader has to
 * reconstruct.
 *
 * **Recovery is commanded, and this record is what makes the command possible rather than what
 * triggers it.** Nothing here watches, retries or restarts: `daemon status` reads this file and
 * names the command, `xplainer daemon recover` runs it. The round-3 decision is in the plan and its
 * cost is stated there rather than hidden — on Linux and macOS, an updater that dies between the
 * drain and the restart leaves nothing running until somebody runs that command, because the daemon
 * exited `0` and `0` is the portable "do not restart" signal on both.
 *
 * **A newer `format_version` is a rollback signal, not corruption.** ADR 0024 fixes that rule for
 * every record in this state directory and it is load-bearing here: an update that was interrupted
 * by a *downgrade* leaves a journal a older build cannot read, and the older build must preserve it
 * and say so rather than delete the one document that names the retained runtime.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { ProgramSource, SupervisorKind } from "../../daemon/daemon-state.js";
import {
  type DirectoryFlush,
  flushDirectory,
  removeIfPresent,
  writeJsonDurably,
} from "../../daemon/durable-write.js";
import { selfIdentity } from "../../daemon/worker-identity.js";
import type { LaunchSpec } from "../../runtime/launch-spec.js";

/** The journal's file name inside the state directory. */
export const UPDATE_JOURNAL_FILE = "update.json";

/** The shape this build writes and understands. */
export const UPDATE_JOURNAL_FORMAT_VERSION = 1;

/**
 * The transitions a transaction can be found at, in the order it completes them.
 *
 * Each value is a **completed** boundary: `staged` means the incoming runtime is on disk under its
 * own name and nothing else has been touched, `drained` means the running daemon is gone, and so
 * on. The two terminal outcomes — ready, and rolled back — are not values here, because both end by
 * removing the file: a journal that exists is a transaction that is unfinished, which is the one
 * question `daemon status` has to answer without interpretation.
 */
export const UPDATE_TRANSITIONS = [
  "staged",
  "drained",
  "switched",
  "started",
  "rolling-back",
] as const;

/** One of {@link UPDATE_TRANSITIONS}. */
export type UpdateTransition = (typeof UPDATE_TRANSITIONS)[number];

/** What each transition licenses a recovery to do next, in one sentence a user is shown. */
export const TRANSITION_MEANING: Readonly<Record<UpdateTransition, string>> = {
  staged: "the incoming runtime was staged and nothing else was touched — the daemon never stopped",
  drained:
    "the running daemon was drained and the supervisor still names the previous runtime — " +
    "nothing is running until the recovery command is run",
  switched:
    "the supervisor artefact, the launcher and daemon.json name the incoming runtime, and it " +
    "has not been started",
  started:
    "the incoming runtime was started and it had not answered an authenticated /healthz when " +
    "the updater stopped",
  "rolling-back":
    "the incoming runtime failed readiness and the previous one was being put back when the " +
    "updater stopped",
};

/** One side of the switch: everything a rollback needs to put a runtime back without guessing. */
export type JournalledRuntime = {
  /** `<state>/runtime/<version>-<digest>`, the staged directory itself. */
  runtime_dir: string;
  /** That directory's own name, which is the payload's content address. */
  slot: string;
  /** The version of the package whose `bin` entry the launch contract names. */
  version: string;
  /** Where this runtime's program came from, so a switch back records what the install recorded. */
  program_source: ProgramSource;
  /** The launch contract rendered into the supervisor artefact for this runtime. */
  launch_spec: LaunchSpec;
  /** `daemon.json`'s `installed_version` for this side, so the record is restored and not invented. */
  installed_version: string | null;
};

/** The process that opened the transaction, so a reader can tell "in flight" from "abandoned". */
export type JournalledUpdater = {
  pid: number;
  /** The start token that makes the pid an identity rather than a number (ADR 0024). */
  start_time: string | null;
  hostname: string;
};

/** The supervisor registration the switch rewrites. */
export type JournalledSupervisor = {
  kind: SupervisorKind;
  /** The unit name, the launchd label, or the fully qualified task name. */
  identity: string;
  /** The unit, plist or task XML the switch rewrites. */
  artefact: string;
};

/** `<state>/update.json` in full. */
export type UpdateJournal = {
  format_version: number;
  /** Unique to this transaction, so two journals cannot be confused in a support transcript. */
  transaction_id: string;
  started_at: string;
  updated_at: string;
  /** The last **completed** transition. */
  transition: UpdateTransition;
  updater: JournalledUpdater;
  supervisor: JournalledSupervisor;
  /** The retained previous runtime — the rollback target. */
  previous: JournalledRuntime;
  /** The runtime being switched to. */
  incoming: JournalledRuntime;
  /** The port the artefact records, carried so a rollback re-renders the same contract. */
  port: number;
  /**
   * The run that was answering when the transaction opened, or `null` if nothing was.
   *
   * Carried so the readiness wait can say "this is a **different** run" rather than "a record
   * exists": `runtime.json` is removed by a clean drain, but a daemon that was killed leaves its
   * own record behind, and a wait that accepted it would report the drained process as the
   * replacement. It is journalled rather than held in memory because a recovery resumes in a
   * process that never saw the daemon it is replacing.
   */
  previous_run_id: string | null;
  /** Why the transaction turned around, once it has. */
  rollback_reason: string | null;
};

/**
 * What a read of the journal found. Four states, kept apart because they mean four things.
 *
 * `newer` is the ADR 0024 case and is deliberately not folded into `unreadable`: the document is
 * intact and this build is the wrong reader, so the only safe act is to name the version and stop.
 */
export type JournalRead =
  | { state: "absent"; journal: null }
  | { state: "present"; journal: UpdateJournal }
  | { state: "newer"; journal: null; formatVersion: number }
  | { state: "unreadable"; journal: null; detail: string };

/** `<state>/update.json`. */
export function updateJournalPath(stateDir: string): string {
  return join(stateDir, UPDATE_JOURNAL_FILE);
}

/** This process, as the journal records an updater. */
export function currentUpdater(): JournalledUpdater {
  const self = selfIdentity();
  return { pid: self.pid, start_time: self.start_time, hostname: hostname() };
}

/** A transaction id nothing else will produce. */
export function newTransactionId(): string {
  return randomUUID();
}

/**
 * Read the journal, telling absent, readable, too-new and damaged apart.
 *
 * Nothing here throws: every caller is either about to refuse or about to recover, and both need a
 * value to put in a sentence rather than an exception to translate.
 */
export function readUpdateJournal(stateDir: string): JournalRead {
  let raw: string;
  try {
    raw = readFileSync(updateJournalPath(stateDir), "utf8");
  } catch {
    return { state: "absent", journal: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      state: "unreadable",
      journal: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { state: "unreadable", journal: null, detail: "it is not a JSON object" };
  }
  const document = parsed as Record<string, unknown>;
  const version = document.format_version;
  if (typeof version !== "number") {
    return { state: "unreadable", journal: null, detail: "it records no format_version" };
  }
  if (version > UPDATE_JOURNAL_FORMAT_VERSION) {
    return { state: "newer", journal: null, formatVersion: version };
  }
  const transition = document.transition;
  if (
    typeof transition !== "string" ||
    !(UPDATE_TRANSITIONS as readonly string[]).includes(transition)
  ) {
    return {
      state: "unreadable",
      journal: null,
      detail: `it records transition ${JSON.stringify(transition)}, which is not one of ${UPDATE_TRANSITIONS.join(", ")}`,
    };
  }
  return { state: "present", journal: document as unknown as UpdateJournal };
}

/**
 * Write the journal at a boundary, durably.
 *
 * The `updated_at` stamp is set here rather than by the caller so that every boundary carries the
 * moment it was crossed and no call site can forget one.
 */
export function recordTransition(
  stateDir: string,
  journal: UpdateJournal,
  transition: UpdateTransition,
  rollbackReason: string | null = journal.rollback_reason,
): UpdateJournal {
  const next: UpdateJournal = {
    ...journal,
    transition,
    updated_at: new Date().toISOString(),
    rollback_reason: rollbackReason,
  };
  writeJsonDurably(updateJournalPath(stateDir), next);
  return next;
}

/**
 * Remove the journal, which is how both terminal outcomes are recorded.
 *
 * The directory is flushed after the unlink for the reason every other durable write flushes it: on
 * Linux and macOS the *name* is not durable until the directory is, and a journal that came back
 * after a power cut would send `daemon status` looking for a transaction that finished.
 */
export function clearUpdateJournal(stateDir: string): DirectoryFlush {
  removeIfPresent(updateJournalPath(stateDir));
  return flushDirectory(stateDir);
}
