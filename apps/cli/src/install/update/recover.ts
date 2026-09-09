/**
 * What a reader may conclude from the journal, and the one command that acts on it.
 *
 * The round-3 decision this story implements is that **recovery is commanded, not automatic**, and
 * the split that makes it usable is the one this file draws: `daemon status` **reports** an
 * interrupted transaction and names the command; `xplainer daemon recover` **completes it or rolls
 * it back**. `status` never repairs — a status verb that mutates is a status verb nobody can run
 * safely, and the first thing a person does with a daemon that is behaving strangely is run
 * `status`.
 *
 * **In flight is not the same as interrupted, and the difference is the identity tuple.** A journal
 * whose updater is still alive is an update that is *running*, and telling a user to recover it
 * would be telling them to fight another process for the operation lock. So the reader classifies
 * the recorded updater exactly as ADR 0024 classifies a lock holder: by the pid **and** the start
 * token, never by the pid alone, because a pid is reused and a recovery started against a live
 * updater is the worst of the two mistakes available here.
 *
 * **Two journal states are reported and never acted on.** A `format_version` newer than this build
 * understands is a rollback signal rather than corruption (ADR 0024), and the document is the only
 * record of which runtime the interrupted update retained — so it is preserved and named, and the
 * release that wrote it is the one that can finish its own transaction. A journal that cannot be
 * parsed at all is preserved for the same reason: removing it would remove the evidence.
 */

import { isAlive, processStartToken } from "../../daemon/worker-identity.js";
import {
  type JournalledRuntime,
  readUpdateJournal,
  TRANSITION_MEANING,
  type UpdateTransition,
  updateJournalPath,
} from "./journal.js";
import { recoverTransaction, type UpdateOutcome, type UpdateRequest } from "./transaction.js";

/** The command that finishes or undoes an interrupted transaction. Spelled once. */
export const RECOVER_COMMAND = "xplainer daemon recover";

/** A transaction the journal describes, reduced to what a reader is shown. */
export type InterruptedTransaction = {
  transactionId: string;
  transition: UpdateTransition;
  /** What that transition means, in the sentence `status` prints. */
  meaning: string;
  startedAt: string;
  updatedAt: string;
  /** The retained previous runtime — what a rollback would put back. */
  previous: JournalledRuntime;
  /** The runtime the transaction was switching to. */
  incoming: JournalledRuntime;
  /** The updater's pid, whether it is still that process, and how the tuple was read. */
  updater: { pid: number; alive: boolean; detail: string };
  /** Why it turned around, when it had. */
  rollbackReason: string | null;
};

/** What the journal says about this state directory. Four states, because they mean four things. */
export type UpdateStatus =
  | { state: "none" }
  | { state: "in-flight"; transaction: InterruptedTransaction }
  | { state: "interrupted"; transaction: InterruptedTransaction }
  | { state: "newer"; path: string; formatVersion: number }
  | { state: "unreadable"; path: string; detail: string };

/**
 * Read the journal and classify it, without writing anything.
 *
 * Every branch is a read: `readUpdateJournal` opens one file, and the liveness check is
 * `process.kill(pid, 0)` plus one memoised `ps`. That is what makes this safe to call from
 * `daemon status`, which is the whole point of it existing separately from the transaction.
 */
export function readUpdateStatus(stateDir: string): UpdateStatus {
  const read = readUpdateJournal(stateDir);
  if (read.state === "absent") {
    return { state: "none" };
  }
  if (read.state === "newer") {
    return { state: "newer", path: updateJournalPath(stateDir), formatVersion: read.formatVersion };
  }
  if (read.state === "unreadable") {
    return { state: "unreadable", path: updateJournalPath(stateDir), detail: read.detail };
  }

  const journal = read.journal;
  const updater = classifyUpdater(journal.updater.pid, journal.updater.start_time);
  const transaction: InterruptedTransaction = {
    transactionId: journal.transaction_id,
    transition: journal.transition,
    meaning: TRANSITION_MEANING[journal.transition],
    startedAt: journal.started_at,
    updatedAt: journal.updated_at,
    previous: journal.previous,
    incoming: journal.incoming,
    updater,
    rollbackReason: journal.rollback_reason,
  };
  return updater.alive
    ? { state: "in-flight", transaction }
    : { state: "interrupted", transaction };
}

/**
 * Whether the process that opened the transaction is still that process.
 *
 * The tuple, never the pid: ADR 0024's `[D]` and `[E]` are the same live pid with opposite
 * verdicts, and a recovery offered against a running updater — or withheld from a dead one whose
 * number has been reused — is exactly the mistake that rule exists to prevent.
 */
function classifyUpdater(
  pid: number,
  recorded: string | null,
): { pid: number; alive: boolean; detail: string } {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { pid, alive: false, detail: "the journal records no usable pid" };
  }
  if (!isAlive(pid)) {
    return { pid, alive: false, detail: `pid ${String(pid)} is not alive` };
  }
  const observed = processStartToken(pid);
  if (recorded !== null && observed !== null && observed !== recorded) {
    return {
      pid,
      alive: false,
      detail: `pid ${String(pid)} is alive but started "${observed}", not "${recorded}" — the number was reused`,
    };
  }
  return { pid, alive: true, detail: `pid ${String(pid)} is alive and started "${observed}"` };
}

/**
 * The sentences `daemon status` says about the journal, and none when there is nothing to say.
 *
 * Sentences rather than a formatted block, for the reason `lifecycle.ts` gives about its own four:
 * they can be asserted as values, and the command layer decides how they are laid out.
 */
export function updateStatusSentences(status: UpdateStatus): readonly string[] {
  switch (status.state) {
    case "none":
      return [];
    case "in-flight":
      return [
        `an update is in progress: transaction ${status.transaction.transactionId} reached ` +
          `"${status.transaction.transition}" and ${status.transaction.updater.detail}. ` +
          `Nothing needs to be run; this is an update that has not finished yet.`,
      ];
    case "interrupted":
      return [
        `an update of this daemon was INTERRUPTED at "${status.transaction.transition}": ` +
          `${status.transaction.meaning}. Its updater is gone (${status.transaction.updater.detail}).`,
        `the previous runtime ${status.transaction.previous.slot} is retained at ` +
          `${status.transaction.previous.runtime_dir}, and the incoming one is ` +
          `${status.transaction.incoming.slot}.`,
        `run \`${RECOVER_COMMAND}\` to finish it or put the previous runtime back. ` +
          `\`daemon status\` reports and never repairs.`,
      ];
    case "newer":
      return [
        `${status.path} records format_version ${String(status.formatVersion)}, which is newer ` +
          `than this build understands. A newer format version is a rollback signal and never ` +
          `corruption: the document is left exactly as it is, and the release that wrote it is ` +
          `the one that can finish its own transaction.`,
      ];
    case "unreadable":
      return [
        `${status.path} exists and cannot be read: ${status.detail}. It is the only record of ` +
          `which runtime an interrupted update retained, so it is left in place rather than removed.`,
      ];
  }
}

/**
 * Finish or undo the transaction the journal describes.
 *
 * It is the same engine the forward path runs — entered at the recorded transition — so a recovery
 * that reaches readiness ends with the incoming runtime installed and answering, and one that does
 * not ends with the retained previous runtime installed and answering. Both outcomes remove the
 * journal; anything else leaves it, so the command can be run again.
 */
export async function recoverUpdate(request: UpdateRequest): Promise<UpdateOutcome> {
  return recoverTransaction(request, "recover");
}
