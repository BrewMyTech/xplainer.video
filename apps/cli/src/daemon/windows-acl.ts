/**
 * The explicit ACL Windows needs, because a mode there protects nothing.
 *
 * [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md) §R-SEC-5 states the gap and
 * the remedy in one paragraph: Node documents that only the write permission is settable on Windows
 * and that the owner/group/other distinction is not implemented
 * ([File modes](https://nodejs.org/api/fs.html#file-modes)), so `open(path, "wx", 0o600)` produces a
 * token file **every account on the machine can read**; DPAPI would need a native addon, which is
 * what phase 2's single-file packaging cannot carry; so the requirement is "an explicit ACL applied
 * at creation — `icacls <path> /inheritance:r /grant:r "%USERNAME%:(R,W)"`, which needs no
 * administrator". That is this module, and the ADR assigns it to phase 2.
 *
 * **`/inheritance:r` is the half that does the work.** A file created under `%LOCALAPPDATA%`
 * inherits its parent's ACEs, and on a machine with more than one account those routinely include
 * `BUILTIN\\Users`. Granting the owner changes nothing while the inherited entries are still there;
 * removing inheritance and then granting is one `icacls` invocation and is the documented order.
 *
 * **It is applied at creation and nowhere else**, which is exactly what the ADR asks for and no
 * more. A directory that already exists keeps whatever ACL it has — the same rule `mkdir`'s mode
 * follows — and R-SEC-5's other half, "`xplainer daemon status` re-verifies it and warns if
 * inheritance has been restored", is a check this module does not perform and no caller here calls.
 *
 * **A failure is reported, never thrown.** A daemon that refused to start because `icacls` was not
 * on `PATH` would trade a weaker file for no service at all, on a platform where the file was
 * already weaker before this module existed. The caller says so on stderr; {@link AclResult} carries
 * the command that failed so the sentence can name it.
 *
 * Everything here is a pure function except {@link restrictToOwner}, so the command line — the part
 * that is easy to get wrong and impossible to run from macOS — is asserted from every platform.
 */

import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import process from "node:process";

/** What the owner is granted on a file: read and write, per R-SEC-5's own spelling. */
export const ACL_FILE_RIGHTS = "(R,W)";

/**
 * What the owner is granted on a directory.
 *
 * `(OI)(CI)` are object- and container-inherit, so a file this daemon creates inside the directory
 * later carries the same single-account entry rather than re-inheriting the parent's. `(F)` rather
 * than `(R,W)` because the daemon renames files over each other in here — `writeJsonDurably` is
 * temp-then-rename — and a rename needs delete on the target's name.
 */
export const ACL_DIRECTORY_RIGHTS = "(OI)(CI)(F)";

/** What one `icacls` run did. */
export type AclResult =
  /** Not `win32`: the mode is the protection, and this module has nothing to add. */
  | { outcome: "not-applicable" }
  /** `icacls` exited 0 for this path. */
  | { outcome: "applied"; command: string }
  /** `icacls` could not be run, or exited non-zero. The path keeps the ACL it had. */
  | { outcome: "failed"; command: string; reason: string };

/** Whether an ACL is being applied to a file or to a directory that will hold files. */
export type AclTarget = "file" | "directory";

/**
 * The account name `icacls` is given.
 *
 * The bare user name rather than `DOMAIN\\user`: `icacls` resolves an unqualified name against the
 * local machine and then the domain, which is the same account either way, and a qualified name
 * built here would have to guess between `USERDOMAIN` and `COMPUTERNAME` on a machine where they
 * differ.
 */
export function aclAccount(name: string = userInfo().username): string {
  return name;
}

/**
 * `icacls <path> /inheritance:r /grant:r "<account>:<rights>"`, as a program and an argv.
 *
 * The argv is a vector rather than a command line, so no shell parses the parentheses in
 * `(OI)(CI)(F)` and no quoting rule has to be reimplemented here.
 *
 * @throws {RangeError} for an account name that is blank or carries a character no Windows account
 * name may contain — which would otherwise be pasted into an access-control entry.
 */
export function restrictToOwnerCommand(
  path: string,
  target: AclTarget,
  account: string = aclAccount(),
): { program: string; argv: string[] } {
  if (account.trim() === "" || /["/\\[\]:;|=,+*?<>]/.test(account)) {
    throw new RangeError(
      `an access-control entry needs an account name, and ${JSON.stringify(account)} is not one: ` +
        `a Windows account name may not be blank or contain " / \\ [ ] : ; | = , + * ? < >.`,
    );
  }
  const rights = target === "directory" ? ACL_DIRECTORY_RIGHTS : ACL_FILE_RIGHTS;
  return {
    program: "icacls",
    argv: [path, "/inheritance:r", "/grant:r", `${account}:${rights}`],
  };
}

/**
 * Narrow `path` to the account this process is running as, on Windows only.
 *
 * @returns what happened, for a caller that says so on stderr. It never throws for an `icacls` that
 * failed, for the reason at the top of this file.
 */
export function restrictToOwner(
  path: string,
  target: AclTarget,
  platform: string = process.platform,
): AclResult {
  if (platform !== "win32") {
    return { outcome: "not-applicable" };
  }
  let program: string;
  let argv: string[];
  try {
    ({ program, argv } = restrictToOwnerCommand(path, target));
  } catch (error) {
    return {
      outcome: "failed",
      command: `icacls ${path}`,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const spelled = `${program} ${argv.join(" ")}`;
  const answer = spawnSync(program, argv, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (answer.error !== undefined) {
    return { outcome: "failed", command: spelled, reason: answer.error.message };
  }
  if (answer.status !== 0) {
    const said = `${answer.stdout ?? ""}${answer.stderr ?? ""}`.trim().split("\n")[0] ?? "";
    return {
      outcome: "failed",
      command: spelled,
      reason: `exited ${String(answer.status)}${said === "" ? "" : `: ${said}`}`,
    };
  }
  return { outcome: "applied", command: spelled };
}

// ── Re-verification: the second half of R-SEC-5 ─────────────────────────────────────────────────
//
// "…and `xplainer daemon status` re-verifies it and warns if inheritance has been restored." An
// entry applied at creation is a fact about one moment; `/inheritance:r` is undone by one
// `icacls <path> /inheritance:e`, by a backup restore, or by an installer that resets a tree, and
// nothing about the file's mode would change when it happened. So the entry is read back and
// compared against the one this module writes, and the comparison is a pure function of `icacls`'s
// own output so that it is asserted from a machine that has no `icacls`.

/** One access-control entry, as `icacls` prints it. */
export type AclEntry = {
  /** The principal, exactly as `icacls` spelled it — `MACHINE\\alice`, `BUILTIN\\Users`. */
  account: string;
  /** The rights blob, parentheses included: `(R,W)`, `(I)(F)`, `(OI)(CI)(F)`. */
  rights: string;
  /** Whether the entry is inherited — the `(I)` flag, which is what "inheritance restored" means. */
  inherited: boolean;
};

/** What a re-verification concluded. */
export type AclVerdict =
  /** Not `win32`: there is no entry to re-verify, and the mode is the protection. */
  | { state: "not-applicable"; detail: string; entries: readonly AclEntry[] }
  /** Exactly one entry, this account's, not inherited. What {@link restrictToOwner} leaves behind. */
  | { state: "owner-only"; detail: string; entries: readonly AclEntry[] }
  /** Somebody else is on the file, or inheritance is back. The warning R-SEC-5 asks for. */
  | { state: "widened"; detail: string; entries: readonly AclEntry[] }
  /** `icacls` could not be run, or said something this parser does not recognise. */
  | { state: "unknown"; detail: string; entries: readonly AclEntry[] };

/** The command that reads a path's entries back. */
export function aclQuery(path: string): { program: string; argv: string[] } {
  return { program: "icacls", argv: [path] };
}

/** What a command that was run produced, narrowed to what this module reads. */
export type AclProbeResult = {
  started: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
};

/**
 * The trailer `icacls` prints after the entries, in the locale GitHub's runners use.
 *
 * Matched as a prefix rather than in full because the counts vary, and treated as *one* of two
 * terminators — the other being a blank line — so that a localised trailer this does not recognise
 * ends the entries rather than being parsed as one.
 */
const ICACLS_TRAILER = /^(?:Successfully processed|Failed processing)/;

/**
 * Every access-control entry in one `icacls <path>` output.
 *
 * The first line carries the path before the first entry and the rest are indented continuations,
 * so the path is stripped by prefix rather than by splitting on whitespace: a Windows path holds
 * spaces routinely and an account name may hold them too (`MACHINE\\Some User`), which is why the
 * entry is matched from the **right** — the rights blob is the anchor, and everything before the
 * final colon is the principal.
 */
export function parseAclEntries(stdout: string, path: string): AclEntry[] {
  const entries: AclEntry[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    let line = raw;
    if (line.startsWith(path)) {
      line = line.slice(path.length);
    }
    line = line.trim();
    if (line === "") {
      // A blank line ends the entry block: what follows is the trailer, or nothing.
      if (entries.length > 0) {
        break;
      }
      continue;
    }
    if (ICACLS_TRAILER.test(line)) {
      break;
    }
    const match = /^(.+):((?:\([^()]*\))+)$/.exec(line);
    if (match === null) {
      continue;
    }
    const account = match[1] ?? "";
    const rights = match[2] ?? "";
    entries.push({ account: account.trim(), rights, inherited: rights.includes("(I)") });
  }
  return entries;
}

/** Whether an `icacls` principal names this account, with or without its machine or domain. */
export function aclEntryIsAccount(entry: AclEntry, account: string): boolean {
  const spelled = entry.account.toLowerCase();
  const wanted = account.toLowerCase();
  return spelled === wanted || spelled.endsWith(`\\${wanted}`);
}

/**
 * Read one `icacls <path>` back and say whether the file still carries only this account.
 *
 * The rule is exact rather than lenient because {@link restrictToOwnerCommand} is exact:
 * `/inheritance:r /grant:r` leaves **one** entry on the file, so a second principal — `BUILTIN\\Users`,
 * `NT AUTHORITY\\SYSTEM`, anything — is something that arrived afterwards, and an `(I)` flag is
 * inheritance having been switched back on. Both are `widened`, and both name what they found.
 */
export function readAclVerdict(
  path: string,
  answer: AclProbeResult,
  account?: string,
  platform: string = process.platform,
): AclVerdict {
  // The account is resolved **after** the platform check rather than in the parameter list: off
  // Windows there is no entry to compare anything against, and `userInfo()` is a syscall that
  // throws outright on a machine whose uid has no passwd entry — a container, which is where this
  // package's Linux suites run.
  if (platform !== "win32") {
    return {
      state: "not-applicable",
      detail: `${path} is protected by its mode on this platform, and carries no access-control entry to re-verify`,
      entries: [],
    };
  }
  if (!answer.started) {
    return {
      state: "unknown",
      detail: `icacls could not be run, so the entry on ${path} was not re-verified`,
      entries: [],
    };
  }
  const who = account ?? aclAccount();
  const entries = parseAclEntries(answer.stdout, path);
  if (answer.status !== 0 || entries.length === 0) {
    const said = `${answer.stdout}${answer.stderr}`.trim().split(/\r?\n/)[0] ?? "";
    return {
      state: "unknown",
      detail: `icacls ${path} exited ${String(answer.status)} and named no access-control entry${said === "" ? "" : `: ${said}`}`,
      entries,
    };
  }
  const inherited = entries.filter((entry) => entry.inherited);
  const foreign = entries.filter((entry) => !aclEntryIsAccount(entry, who));
  if (inherited.length > 0 || foreign.length > 0) {
    const spelled = entries.map((entry) => `${entry.account}:${entry.rights}`).join(", ");
    return {
      state: "widened",
      detail:
        `${path} is no longer owner-only: ${spelled}. ` +
        (inherited.length > 0
          ? "Inheritance has been restored underneath it. "
          : "An entry for another account has been added. ") +
        `Narrow it again with \`icacls ${path} /inheritance:r /grant:r "${who}:${ACL_FILE_RIGHTS}"\``,
      entries,
    };
  }
  return {
    state: "owner-only",
    detail: `${path} carries one access-control entry, ${entries[0]?.account ?? who}, and no inherited entry`,
    entries,
  };
}
