/**
 * The commands that hand a rendered artefact to a supervisor, and take it back again.
 *
 * `supervisors/` renders three files and writes nothing; this module is the other half — the exact
 * argument vectors that register, start and deregister the job on each platform, as **data** rather
 * than as three branches inside `install.ts`. That shape is what makes the orders below assertable
 * from one machine: a test asks for the Windows sequence on macOS and compares the vectors, which
 * is the only way this repository can check a Task Scheduler ordering at all.
 *
 * **macOS: `enable` precedes `bootstrap`, and a re-install boots out first.** `man launchctl` says
 * a disabled service "cannot be loaded in the specified domain until it is once again enabled", and
 * that state persists across boots — so a `bootstrap` into a domain holding a stale disable record
 * for the label fails, and fails for a reason nothing in the output names. `bootstrap` also does
 * not refresh an already-loaded definition, so a re-install over a running job would leave launchd
 * executing the previous plist while every file on disk said otherwise; `bootout` first is what
 * makes the second install mean what the first one did. `kickstart` last, because `RunAtLoad` runs
 * the job at bootstrap and `kickstart` is what starts it when the domain already had it loaded.
 *
 * **Linux: `daemon-reload` then `enable --now`.** systemd caches unit files, so a unit written a
 * moment ago is not the unit `enable` reads without the reload; `--now` is `enable` and `start` in
 * one call, which is one fewer place for the two to disagree.
 *
 * **Windows: `Register-ScheduledTask -Xml … -Force` then `Start-ScheduledTask`.** `-Force` is what
 * makes a re-install an update rather than a name collision, and the XML is read with
 * `Get-Content -Raw` because the cmdlet takes the document as a string and an array of lines is
 * not one. Both go through `powershell.exe` rather than `schtasks.exe`: `schtasks /create /xml`
 * cannot express the S4U principal this task needs without a password on the command line.
 *
 * **A tolerated step is named, not guessed.** `bootout` on a job that is not loaded, and
 * `systemctl --user disable` on a unit that was never enabled, both exit non-zero and both mean
 * "already in the state you asked for". Those steps carry {@link RegistrationStep.tolerated}, and
 * every other non-zero status is a failure the caller rolls back on.
 */

import type { SupervisorKind } from "../daemon/daemon-state.js";
import type { ProbeCommand } from "./preflight.js";

/** How long a registration command is given before it is treated as unanswered. */
export const REGISTRATION_TIMEOUT_MS = 60_000;

/** The PowerShell this project shells out to, named once. */
export const POWERSHELL = "powershell.exe";

/** The arguments every PowerShell call carries before its script. */
export const POWERSHELL_ARGV: readonly string[] = [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
];

/** One command in a registration sequence, with the reason it is being run. */
export type RegistrationStep = {
  /** What this step is for, in the words the install prints as it runs. */
  title: string;
  /** The command itself. */
  command: ProbeCommand;
  /**
   * Whether a non-zero status means "already in the asked-for state" rather than a failure.
   *
   * Only two steps carry it and both are removals: booting out a job that is not loaded, and
   * disabling a unit that was never enabled.
   */
  tolerated?: boolean;
};

/** Everything the sequences below need, and nothing about the daemon's own settings. */
export type RegistrationTarget = {
  /** Which supervisor. The same spelling `daemon.json` records. */
  kind: SupervisorKind;
  /** The unit name, the launchd label, or the fully qualified task name. */
  identity: string;
  /** The unit, plist or task XML on disk — the file the supervisor is pointed at. */
  artefact: string;
  /** The uid whose `gui/<uid>` domain a LaunchAgent is bootstrapped into. macOS only. */
  uid: number;
};

/** `gui/<uid>`, the domain a LaunchAgent belongs to. */
export function guiDomain(uid: number): string {
  return `gui/${uid}`;
}

/** `gui/<uid>/<label>`, the service specifier `launchctl` addresses one job by. */
export function guiService(target: RegistrationTarget): string {
  return `${guiDomain(target.uid)}/${target.identity}`;
}

/** The commands that put the artefact under the supervisor and start it, in order. */
export function registerCommands(target: RegistrationTarget): readonly RegistrationStep[] {
  switch (target.kind) {
    case "systemd":
      return [
        {
          title: "reload the user manager so it reads the unit just written",
          command: { program: "systemctl", argv: ["--user", "daemon-reload"] },
        },
        {
          title: "enable the unit for boot and start it now",
          command: { program: "systemctl", argv: ["--user", "enable", "--now", target.identity] },
        },
      ];
    case "launchd":
      return [
        {
          title: "bootout any definition already loaded, because bootstrap does not refresh one",
          command: { program: "launchctl", argv: ["bootout", guiService(target)] },
          tolerated: true,
        },
        {
          title: "clear any disable record, which bootstrap would otherwise refuse over",
          command: { program: "launchctl", argv: ["enable", guiService(target)] },
        },
        {
          title: "bootstrap the plist into this user's GUI domain",
          command: {
            program: "launchctl",
            argv: ["bootstrap", guiDomain(target.uid), target.artefact],
          },
        },
        {
          title: "kickstart the job, so a domain that already had it loaded starts it too",
          command: { program: "launchctl", argv: ["kickstart", guiService(target)] },
        },
      ];
    case "task-scheduler":
      return [
        {
          title: "register the task from its XML document, replacing any task of the same name",
          // `-Encoding UTF8` names the bytes `supervisors/schtasks.ts` wrote. Windows PowerShell
          // decodes a file with no byte order mark as the active ANSI code page otherwise, which
          // turns every non-ASCII character of a profile path into two — and the document's own
          // declaration is `UTF-16` because what Task Scheduler parses is the decoded string.
          command: powershellCommand(
            `Register-ScheduledTask -Xml (Get-Content -Path ${powerShellLiteral(target.artefact)} -Raw ` +
              `-Encoding UTF8) -TaskName ${powerShellLiteral(target.identity)} -Force`,
          ),
        },
        {
          title: "start the task",
          command: powershellCommand(
            `Start-ScheduledTask -TaskName ${powerShellLiteral(target.identity)}`,
          ),
        },
      ];
  }
}

/** The commands that take the job back off the supervisor, in order. */
export function deregisterCommands(target: RegistrationTarget): readonly RegistrationStep[] {
  switch (target.kind) {
    case "systemd":
      return [
        {
          title: "stop the unit and remove it from the boot set",
          command: { program: "systemctl", argv: ["--user", "disable", "--now", target.identity] },
          tolerated: true,
        },
        {
          title: "reload the user manager, so the removed unit stops being cached",
          command: { program: "systemctl", argv: ["--user", "daemon-reload"] },
        },
      ];
    case "launchd":
      return [
        {
          title: "bootout the job from this user's GUI domain",
          command: { program: "launchctl", argv: ["bootout", guiService(target)] },
          tolerated: true,
        },
      ];
    case "task-scheduler":
      return [
        // The counterpart of `disable --now` and of `bootout`, and the reason it is a step of its
        // own: `Unregister-ScheduledTask` removes the *registration* and leaves a running instance
        // running. On the other two the deregistration stops the process — `systemctl --user
        // disable --now` and `launchctl bootout` both do — so a Windows deregistration without
        // this one leaves a daemon holding its state directory after every file naming it is gone,
        // which is what an `EPERM` on removing that directory was on `windows-latest`, 2026-09-09.
        {
          title: "stop the task, which unregistering it does not do",
          command: powershellCommand(
            `Stop-ScheduledTask -TaskName ${powerShellLiteral(target.identity)}`,
          ),
          tolerated: true,
        },
        {
          title: "unregister the scheduled task",
          command: powershellCommand(
            `Unregister-ScheduledTask -TaskName ${powerShellLiteral(target.identity)} -Confirm:$false`,
          ),
          tolerated: true,
        },
      ];
  }
}

/**
 * The one call that asks Task Scheduler why a registered task did not run.
 *
 * `LastTaskResult` is a Win32 status, and `0x0004131C` — `SCHED_S_BATCH_LOGON_PROBLEM` — is the
 * success-with-warning that means the principal lacks a logon right. It is read only when the
 * health check has already failed, because on its own it says nothing: a task that has never run
 * reports `267011` (`SCHED_S_TASK_HAS_NOT_RUN`) and that is the ordinary state a second after
 * `Start-ScheduledTask`.
 */
export function taskInfoCommand(target: RegistrationTarget): ProbeCommand {
  return powershellCommand(
    `(Get-ScheduledTaskInfo -TaskName ${powerShellLiteral(target.identity)}) | ` +
      "Select-Object -Property LastTaskResult,LastRunTime,NumberOfMissedRuns | Format-List",
  );
}

/** A PowerShell one-liner, as the command a step runs. */
function powershellCommand(script: string): ProbeCommand {
  return { program: POWERSHELL, argv: [...POWERSHELL_ARGV, script] };
}

/**
 * A PowerShell single-quoted literal.
 *
 * Single quotes rather than double, because a task name is `\xplainer\<user>-daemon` and PowerShell
 * expands nothing inside a single-quoted string — no backtick escapes, no `$` substitution, and a
 * backslash that stays a backslash. The one character that has to be handled is the quote itself,
 * which PowerShell escapes by doubling.
 *
 * Exported because every other module that composes a PowerShell one-liner about this task —
 * `lifecycle.ts`'s verbs and the update's `switch.ts` — has to escape it the same way, and a second
 * copy of an escaping rule is a second thing to get wrong.
 */
export function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
