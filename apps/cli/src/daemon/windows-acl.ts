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
