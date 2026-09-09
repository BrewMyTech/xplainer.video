/**
 * The Task Scheduler document for `\xplainer\<user>-daemon`, mirrored at
 * `%LOCALAPPDATA%\xplainer\service\xplainer-daemon.xml`.
 *
 * **A per-user task identity, not one machine-global name.** Round 1 of the plan registered
 * `\xplainer-daemon`, which two users on one machine cannot both hold. The folder-plus-user form
 * is a deliberate departure from ADR 0020's table, and the folder is what makes the departure
 * cheap: every xplainer task on the machine is under one node.
 *
 * **The principal and the trigger carry explicit identities, and `/SC ONLOGON`, `/RU` and the logon
 * technique are three different things.** `LeastPrivilege` is the XML spelling of the run level;
 * `LIMITED` is the command-line spelling and `TASK_RUNLEVEL_LUA` the COM enum, and a document that
 * used either of the other two would be rejected by the schema rather than quietly downgraded.
 * `LogonType=S4U` runs the task with no stored password and no network credentials, which is why
 * T11's runner job runs a real `create → narrate` under this principal rather than assuming that
 * registering proves it.
 *
 * **`<Repetition>` with an `<Interval>` and no `<Duration>` is how a repetition becomes
 * indefinite** — a duration would bound it and stop the five-minute re-check that is this
 * platform's substitute for `Restart=on-failure` on a job that exited without failing.
 *
 * **A repetition belongs to a trigger, and a trigger that never fires has no repetition. That is
 * why there are two triggers here and not one.** Measured on `windows-latest` on 2026-09-09 —
 * three throwaway tasks side by side, one action that exits `10`, `Get-ScheduledTaskInfo` polled
 * every twenty seconds for eleven minutes (run 34317779107, job 102357526877):
 *
 * | document | started by | runs in 11 minutes |
 * |---|---|---|
 * | `<LogonTrigger>` alone, with the `PT5M` repetition | `Start-ScheduledTask` | **1** — 06:08:47, and nothing after it |
 * | the same, plus a `<RegistrationTrigger>` carrying the same repetition | nothing; registering it | **3** — 06:08:47, 06:13:47, 06:18:47 |
 *
 * `Start-ScheduledTask` is an **on-demand** run: it starts the action and starts no trigger, so
 * nothing repeats afterwards. The `<LogonTrigger>` fires at an interactive logon — which a hosted
 * runner never has, and which a real machine has already had by the time `daemon install` runs in
 * a terminal inside that session. So the shipped document's five-minute re-check did not exist
 * between the install and the next logon: a daemon started by `install` and then killed stayed
 * dead. `<RegistrationTrigger>` closes exactly that window, because **registering the task is
 * itself the trigger event** — the run that registration produces is a triggered run, and its
 * repetition then runs the task every five minutes for ever. The two are complementary and both
 * are needed: registration covers this boot, the logon trigger covers the next one.
 *
 * `MultipleInstancesPolicy` is what makes two triggers safe, and it was measured rather than
 * assumed: a third task in the same run registered with a `<RegistrationTrigger>` and a
 * four-minute action, and was then asked for `Start-ScheduledTask` immediately, recorded **one**
 * start. So `register.ts`'s explicit start beside this trigger cannot produce a second concurrent
 * daemon; it is kept because `daemon start` (T12) is that same call and has to work on a task that
 * is registered and not running.
 *
 * **`<RestartOnFailure>` does not restart an action that exits non-zero, and the same measurement
 * says so.** Its `PT1M` is the schema minimum, and the row above shows the second task's three
 * runs five minutes apart rather than one minute apart — on a *triggered* run, with `<Count>3` and
 * `<Interval>PT1M</Interval>` registered and read back out of `Export-ScheduledTask`. A Win32
 * exit code of `10` is a **completed** run that Task Scheduler records as `LastTaskResult 10`; the
 * failure `<RestartOnFailure>` is about is the task failing to *launch*. It is kept because that
 * is a real, different failure and ADR 0020's table names it — but nothing in this project may
 * count on it to re-run a daemon that started and exited. The retry cadence on this platform is
 * the `PT5M` repetition, alone, and T14's circuit breaker is written against that.
 *
 * **`AllowHardTerminate` is `true` on purpose.** T13's control route is asked for the drain
 * *before* anything asks Task Scheduler to end the task, so a hard terminate is the escalation and
 * never the mechanism; forbidding it would leave a wedged process with nothing above it.
 * `AllowStartOnDemand` is `true` because `daemon start` (T12) is `schtasks /Run`, which is a
 * start on demand.
 *
 * **The declared encoding is `UTF-16`, and the bytes on disk are UTF-8, because the declaration
 * describes the buffer the parser is handed rather than the file.** T11 registers the document as
 * `Register-ScheduledTask -Xml (Get-Content <xml> -Raw -Encoding UTF8)`: PowerShell decodes the
 * UTF-8 file into a .NET string and Task Scheduler parses **that string**, which is UTF-16 by
 * construction. A declaration of `UTF-8` on a UTF-16 buffer is a parse failure, not a conversion —
 * MSXML answers `(1,40)::ERROR: unable to switch the encoding`, the service turns it into
 * `SCHED_E_MALFORMEDXML` (`0x8004131a`), and `Register-ScheduledTask` reports "The task XML is
 * malformed". That is measured, not reasoned: it is what `windows-latest` did to every registration
 * this project attempted on 2026-09-08 (T11's install, T13's, T14's and T17's proofs), while the
 * same runner registered `daemon-windows.yml`'s inline probe document — identical but for a
 * `UTF-16` declaration, passed as a PowerShell here-string — without a warning. It is also what
 * `Export-ScheduledTask` emits, so the mirror and a Windows export carry the same header.
 *
 * The file itself stays UTF-8 so that every other reader of it — this repository's golden test, a
 * `grep`, a person opening the mirror — reads text rather than UTF-16 code units, and the one
 * consumer that parses it is told which encoding to decode with at the point it reads.
 *
 * **What this file cannot settle.** Golden text validates values, not schema ordering and not
 * registration; the element order below is the order Windows' own exports use, and
 * `daemon-windows.yml` (T11) is where it becomes evidence rather than a reading of the schema.
 */

import { win32 } from "node:path";
import type { SupervisorKind } from "../../daemon/daemon-state.js";
import { emitSettings, type LaunchSpec } from "../../runtime/launch-spec.js";
import {
  escapeXml,
  requireRenderableSpec,
  requireValue,
  type SupervisorArtefact,
  SupervisorArtefactError,
  type SupervisorEnvironment,
} from "./artefact.js";
import type { SupervisorAdapter } from "./index.js";

/** The supervisor this module renders for. */
export const TASK_SCHEDULER_KIND: SupervisorKind = "task-scheduler";

/** The folder every xplainer task lives under. */
export const TASK_FOLDER = "\\xplainer";

/** The file name the document is mirrored under, inside `%LOCALAPPDATA%\xplainer\service`. */
export const TASK_XML_FILE = "xplainer-daemon.xml";

/** `0600`. On Windows a mode is not protection, and ADR 0020 already records that. */
export const TASK_XML_MODE = 0o600;

/** How often the logon trigger re-checks that the daemon is running. */
export const TASK_REPETITION_INTERVAL = "PT5M";

/** The schema's minimum restart interval, which is why T14's breaker is written around it. */
export const TASK_RESTART_INTERVAL = "PT1M";

/** How many times Task Scheduler restarts a failed task before it stops. */
export const TASK_RESTART_COUNT = 3;

/** `\xplainer\<user>-daemon`, from the qualified account the daemon runs as. */
export function taskName(environment: SupervisorEnvironment): string {
  const account = requireValue(environment.account, "environment.account", TASK_SCHEDULER_KIND);
  const segments = account.split("\\");
  const user = segments[segments.length - 1] ?? "";
  if (user.trim() === "" || /[\\/:*?"<>|]/.test(user)) {
    throw new SupervisorArtefactError(
      `the task-scheduler artefact takes its task name from the account ` +
        `${JSON.stringify(account)}, whose user part is ${JSON.stringify(user)} — and a task ` +
        `name may not be blank or carry any of \\ / : * ? " < > |. The account is the qualified ` +
        `\`DOMAIN\\user\` form, and the task name is per user because two users on one machine ` +
        `must both be able to register one.`,
    );
  }
  return `${TASK_FOLDER}\\${user}-daemon`;
}

/** `%LOCALAPPDATA%\xplainer\service\xplainer-daemon.xml`. */
export function taskXmlPath(environment: SupervisorEnvironment): string {
  const localAppData = requireValue(
    environment.localAppData ?? "",
    "environment.localAppData",
    TASK_SCHEDULER_KIND,
  );
  return win32.join(localAppData, "xplainer", "service", TASK_XML_FILE);
}

/**
 * `%LOCALAPPDATA%\xplainer\logs\daemon.log`, the file the daemon's own output goes to.
 *
 * [ADR 0020](../../../../../docs/adr/0020-always-running-local-daemon.md)'s platform table names
 * it, and the reason it is a path this project owns rather than a supervisor's capture file is that
 * Task Scheduler has no capture file: `<Exec>` carries a command, arguments and a working directory,
 * and a task's standard output goes nowhere at all. So Windows is the platform where "the daemon
 * writes its own log" is not a preference but the only way there is a log.
 *
 * It is a path rather than a writer. The writer that keeps this file under a bound is owned by no
 * story in this phase, and `daemon logs` reads whatever is here — which on a Windows machine today
 * is nothing, and is reported as nothing rather than as an error.
 */
export function taskLogPath(environment: SupervisorEnvironment): string {
  const localAppData = requireValue(
    environment.localAppData ?? "",
    "environment.localAppData",
    TASK_SCHEDULER_KIND,
  );
  return win32.join(localAppData, "xplainer", "logs", "daemon.log");
}

/**
 * The task document, complete, with every value taken from the launch contract.
 *
 * There is no environment map to put anything in — `<Exec>` carries a command, arguments and a
 * working directory and nothing else — so `emitSettings` answers with the argv slice, and this
 * renderer checks that the slice really is inside the argv it is about to write. That check is the
 * Windows half of the rule the other two platforms get from their `Environment=` lines: the
 * settings are delivered, and a golden test can say which entries deliver them.
 */
export function renderScheduledTask(
  spec: LaunchSpec,
  environment: SupervisorEnvironment,
): SupervisorArtefact {
  requireRenderableSpec(spec, TASK_SCHEDULER_KIND);
  const emission = emitSettings(spec, "win32");
  if (emission.form !== "task-scheduler") {
    throw new SupervisorArtefactError(
      `the launch contract answered with the ${emission.form} form for win32. The renderers take ` +
        `their settings from \`emitSettings\` rather than from \`spec.settings\`, so a contract ` +
        `that changed which form a platform gets is a rendering failure rather than something to ` +
        `work around here.`,
    );
  }
  requireArgvCarries(spec.argv, emission.argv);

  const account = escapeXml(
    requireValue(environment.account, "environment.account", TASK_SCHEDULER_KIND),
  );
  const argumentLine = escapeXml(windowsArgumentLine(spec.argv));
  const lines = [
    // UTF-16, on a file this module writes as UTF-8: the declaration describes the string
    // `Register-ScheduledTask -Xml` parses, not the bytes. See the note at the top of this file.
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    "    <Description>xplainer local daemon</Description>",
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <LogonTrigger>",
    "      <Repetition>",
    `        <Interval>${TASK_REPETITION_INTERVAL}</Interval>`,
    "      </Repetition>",
    "      <Enabled>true</Enabled>",
    `      <UserId>${account}</UserId>`,
    "    </LogonTrigger>",
    // The trigger that fires at registration, carrying the same repetition, so that the
    // five-minute re-check exists from the moment `install` finishes rather than from the next
    // interactive logon. No `<UserId>`: a registration is not a per-user event, and Windows'
    // own export of this document carries none. See the measurement at the top of this file.
    "    <RegistrationTrigger>",
    "      <Repetition>",
    `        <Interval>${TASK_REPETITION_INTERVAL}</Interval>`,
    "      </Repetition>",
    "      <Enabled>true</Enabled>",
    "    </RegistrationTrigger>",
    "  </Triggers>",
    "  <Principals>",
    '    <Principal id="Author">',
    `      <UserId>${account}</UserId>`,
    "      <LogonType>S4U</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowHardTerminate>true</AllowHardTerminate>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "    <Hidden>false</Hidden>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <RestartOnFailure>",
    `      <Interval>${TASK_RESTART_INTERVAL}</Interval>`,
    `      <Count>${TASK_RESTART_COUNT}</Count>`,
    "    </RestartOnFailure>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    `      <Command>${escapeXml(spec.executable)}</Command>`,
    `      <Arguments>${argumentLine}</Arguments>`,
    `      <WorkingDirectory>${escapeXml(spec.cwd)}</WorkingDirectory>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ];

  return {
    kind: TASK_SCHEDULER_KIND,
    path: taskXmlPath(environment),
    mode: TASK_XML_MODE,
    identity: taskName(environment),
    contents: lines.join("\n"),
  };
}

/** The Task Scheduler adapter: one kind, one task name, one mirrored document. */
export const taskSchedulerAdapter: SupervisorAdapter = {
  kind: TASK_SCHEDULER_KIND,
  platform: "win32",
  identity: taskName,
  artefactPath: taskXmlPath,
  render: renderScheduledTask,
};

/**
 * The argv as one command line, in the form Task Scheduler stores and hands back.
 *
 * Exported because `identity.ts` has to say what the registered task's `Arguments` *should* be
 * before it can call a difference a mismatch, and a second implementation of the quoting rule would
 * report a drift that is only a disagreement between two copies of it.
 */
export function windowsArgumentLine(argv: readonly string[]): string {
  return argv.map(quoteWindowsArgument).join(" ");
}

/** The emitted settings, as one unbroken run inside the argv the `<Arguments>` line carries. */
function requireArgvCarries(argv: readonly string[], emitted: readonly string[]): void {
  const haystack = argv.join("\u0000");
  const needle = emitted.join("\u0000");
  if (!haystack.includes(needle)) {
    throw new SupervisorArtefactError(
      `the task-scheduler artefact's <Arguments> is the launch contract's argv, and the settings ` +
        `the contract emits for win32 — ${JSON.stringify(emitted)} — are not in it: ` +
        `${JSON.stringify(Array.from(argv))}. <Exec> has no environment map, so an argv missing ` +
        `them is a daemon that receives none of them.`,
    );
  }
}

/**
 * One argument, in the form `CommandLineToArgvW` parses back into itself.
 *
 * Task Scheduler hands `<Arguments>` to the process as a command line rather than as a vector, so
 * an argument carrying a space — `C:\Users\First Last\AppData\Local\…` is the ordinary case, not
 * the exotic one — has to arrive quoted or it arrives as two. The backslash rule is the one
 * `CommandLineToArgvW` documents: a run of backslashes is doubled only when a quote follows it.
 */
function quoteWindowsArgument(argument: string): string {
  if (argument !== "" && !/[\s"]/.test(argument)) {
    return argument;
  }
  let quoted = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += `${"\\".repeat(backslashes * 2 + 1)}"`;
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}
