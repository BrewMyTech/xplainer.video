/**
 * The Task Scheduler document, asserted whole and then asserted element by element.
 *
 * Same shape as the other two suites: the spec comes from `buildLaunchSpec()` against a real
 * payload-1 artefact, the first case is the whole document byte for byte, and the cases after it
 * are the ones the plan names — the per-user task identity, the explicit principal and trigger
 * identities with `LeastPrivilege` in the XML's own spelling, the indefinite `PT5M` repetition, the
 * six `<Settings>` values, and `<Exec>` carrying the argv that is this platform's only way to
 * deliver a setting at all.
 *
 * **What this file cannot decide** is whether the Task Scheduler schema accepts the document: text
 * is not a validator and this session has no Windows host. `daemon-windows.yml` (T11) registers
 * this exact XML on `windows-latest`, and that is the story where the ordering becomes evidence.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildLaunchSpec,
  type LaunchSettings,
  type LaunchSpec,
} from "../../runtime/launch-spec.js";
import { registerCommands } from "../register.js";
import { buildFixturePayload } from "../testing/payload.js";
import { SupervisorArtefactError, type SupervisorEnvironment } from "./artefact.js";
import {
  renderScheduledTask,
  TASK_SCHEDULER_KIND,
  TASK_XML_MODE,
  taskName,
  taskXmlPath,
} from "./schtasks.js";

let scratch = "";
let stateDir = "";
let tokenFile = "";
let socket = "";
let spec: LaunchSpec;
let environment: SupervisorEnvironment;

/** A launch spec with Windows-shaped values, for the cases that are about Windows quoting. */
function windowsSpec(settings: LaunchSettings, cwd: string): LaunchSpec {
  return {
    executable:
      "C:\\Users\\First Last\\AppData\\Local\\xplainer\\state\\runtime\\1-a\\bin\\node.exe",
    argv: [
      "C:\\Users\\First Last\\rt\\lib\\node_modules\\@xplainer\\cli\\dist\\bin.js",
      "serve",
      "--port",
      "8787",
      "--state-dir",
      settings.stateDir,
      "--token-file",
      settings.tokenFile,
      "--socket",
      settings.socket,
    ],
    settings,
    cwd,
  };
}

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "xplainer-schtasks-")));
  stateDir = join(scratch, "state");
  tokenFile = join(stateDir, "token");
  socket = "\\\\.\\pipe\\xplainer-alice";
  mkdirSync(stateDir, { recursive: true });
  buildFixturePayload({
    outDir: join(scratch, "runtime"),
    version: "1.2.3",
    marker: "schtasks",
    runnable: false,
  });
  spec = buildLaunchSpec({
    runtimeDir: join(scratch, "runtime"),
    port: 8787,
    settings: { stateDir, tokenFile, socket },
    cwd: stateDir,
    platform: "win32",
  });
  environment = {
    home: "C:\\Users\\alice",
    account: "WORKGROUP\\alice",
    localAppData: "C:\\Users\\alice\\AppData\\Local",
  };
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("the Task Scheduler document", () => {
  it("renders the whole document, and every element of it is accounted for", () => {
    const artefact = renderScheduledTask(spec, environment);
    const argumentLine = spec.argv.join(" ");

    expect(artefact.contents).toBe(
      `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>xplainer local daemon</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Repetition>
        <Interval>PT5M</Interval>
      </Repetition>
      <Enabled>true</Enabled>
      <UserId>WORKGROUP\\alice</UserId>
    </LogonTrigger>
    <RegistrationTrigger>
      <Repetition>
        <Interval>PT5M</Interval>
      </Repetition>
      <Enabled>true</Enabled>
    </RegistrationTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>WORKGROUP\\alice</UserId>
      <LogonType>S4U</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${spec.executable}</Command>
      <Arguments>${argumentLine}</Arguments>
      <WorkingDirectory>${stateDir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`,
    );
  });

  it("is named per user and mirrored under %LOCALAPPDATA%, mode 0600", () => {
    const artefact = renderScheduledTask(spec, environment);

    expect(artefact.identity).toBe("\\xplainer\\alice-daemon");
    expect(artefact.identity).toBe(taskName(environment));
    expect(artefact.path).toBe(
      win32.join("C:\\Users\\alice\\AppData\\Local", "xplainer", "service", "xplainer-daemon.xml"),
    );
    expect(artefact.path).toBe(
      "C:\\Users\\alice\\AppData\\Local\\xplainer\\service\\xplainer-daemon.xml",
    );
    expect(artefact.path).toBe(taskXmlPath(environment));
    expect(artefact.mode).toBe(TASK_XML_MODE);
    expect(artefact.kind).toBe("task-scheduler");
  });

  it("carries all four settings, each in the form the task spells it", () => {
    const contents = renderScheduledTask(spec, environment).contents;

    expect(contents).toContain(`--state-dir ${stateDir}`);
    expect(contents).toContain(`--token-file ${tokenFile}`);
    expect(contents).toContain(`--socket ${socket}`);
    expect(contents).toContain(`<WorkingDirectory>${stateDir}</WorkingDirectory>`);
    // <Exec> has no environment map at all, which is why every setting travels in the argv.
    expect(contents).not.toContain("XPLAINER_STATE_DIR");
    expect(contents).not.toContain("XPLAINER_TOKEN_FILE");
  });

  it("gives the principal and the trigger their own explicit identities", () => {
    const contents = renderScheduledTask(spec, environment).contents;

    expect(contents).toContain(
      '    <Principal id="Author">\n' +
        "      <UserId>WORKGROUP\\alice</UserId>\n" +
        "      <LogonType>S4U</LogonType>\n" +
        "      <RunLevel>LeastPrivilege</RunLevel>\n" +
        "    </Principal>",
    );
    expect(contents).toContain("      <UserId>WORKGROUP\\alice</UserId>\n    </LogonTrigger>");
    // `LIMITED` is the command-line spelling and `TASK_RUNLEVEL_LUA` the COM enum; neither is XML.
    expect(contents).not.toContain("LIMITED");
    expect(contents).not.toContain("TASK_RUNLEVEL_LUA");
    expect(contents).toContain('<Actions Context="Author">');
  });

  it("repeats every five minutes with no duration, which is what makes it indefinite", () => {
    const contents = renderScheduledTask(spec, environment).contents;

    expect(contents).toContain(
      "      <Repetition>\n        <Interval>PT5M</Interval>\n      </Repetition>",
    );
    expect(contents).not.toContain("<Duration>");
    expect(contents).not.toContain("StopAtDurationEnd");
  });

  /**
   * The second trigger, and the reason the repetition is on **both** rather than on the logon
   * trigger alone.
   *
   * A repetition belongs to a trigger, and a trigger that has not fired has no repetition running.
   * Measured on `windows-latest`, 2026-09-09 (run 34317779107): the shipped document with a
   * `<LogonTrigger>` alone, started with `Start-ScheduledTask`, ran **once** and never again in
   * eleven minutes — an on-demand start starts no trigger, and a machine already logged in fires
   * no logon trigger. The same document plus a `<RegistrationTrigger>` carrying the same
   * repetition ran three times, five minutes apart, having been started by nothing but its own
   * registration. Both triggers stay: registration covers this boot, logon covers the next one.
   */
  it("also repeats from a registration trigger, so the re-check exists before the next logon", () => {
    const contents = renderScheduledTask(spec, environment).contents;

    expect(contents).toContain(
      "    <RegistrationTrigger>\n" +
        "      <Repetition>\n" +
        "        <Interval>PT5M</Interval>\n" +
        "      </Repetition>\n" +
        "      <Enabled>true</Enabled>\n" +
        "    </RegistrationTrigger>",
    );
    // Both triggers carry it, which is what "the re-check survives a reboot as well" means.
    expect(contents.match(/<Interval>PT5M<\/Interval>/g)).toHaveLength(2);
    // Two `<UserId>` elements and no more: the logon trigger's and the principal's. A registration
    // is not a per-user event, and Windows' own export of this document carries none on it — which
    // the block asserted above already spells out, and this counts so that adding one anywhere
    // fails here rather than at a registration.
    expect(contents.match(/<UserId>/g)).toHaveLength(2);
  });

  /**
   * The declaration and the read that consumes it, together, because either alone is wrong.
   *
   * `Register-ScheduledTask -Xml` takes a .NET string — UTF-16 by construction — so a document
   * declaring `UTF-8` is refused with `unable to switch the encoding` and reported as
   * `SCHED_E_MALFORMEDXML`; that is what every registration on `windows-latest` answered on
   * 2026-09-08. The bytes stay UTF-8 so the mirror is readable text, which is why the registration
   * command has to name the encoding it decodes with. The two live in different modules, so they
   * are asserted against each other here rather than trusted to stay in step.
   */
  it("declares the encoding of the string a registration parses, and is read back as UTF-8", () => {
    const contents = renderScheduledTask(spec, environment).contents;

    expect(contents.startsWith('<?xml version="1.0" encoding="UTF-16"?>\n')).toBe(true);
    expect(contents).not.toContain('encoding="UTF-8"');
    // The bytes are UTF-8: every code point in the document is one this encoding round-trips, and
    // the mirror is a text file rather than UTF-16 code units.
    expect(Buffer.from(contents, "utf8").toString("utf8")).toBe(contents);

    const register = registerCommands({
      kind: TASK_SCHEDULER_KIND,
      identity: taskName(environment),
      artefact: taskXmlPath(environment),
      uid: 0,
    })[0];
    const script = (register?.command.argv ?? []).join(" ");
    expect(script).toContain("Register-ScheduledTask -Xml (Get-Content -Path ");
    expect(script).toContain("-Raw -Encoding UTF8)");
  });

  it("carries the six settings values the drain and the breaker depend on", () => {
    const contents = renderScheduledTask(spec, environment).contents;

    expect(contents).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(contents).toContain(
      "    <RestartOnFailure>\n      <Interval>PT1M</Interval>\n      <Count>3</Count>\n" +
        "    </RestartOnFailure>",
    );
    expect(contents).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(contents).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(contents).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
    // The escalation after T13's drain, never the mechanism.
    expect(contents).toContain("<AllowHardTerminate>true</AllowHardTerminate>");
  });

  it("quotes an argument with a space, because <Arguments> is a command line", () => {
    // The quote is a `&quot;` in the document and a `"` by the time the parser is done with it.
    const settings: LaunchSettings = {
      stateDir: "C:\\Users\\First Last\\AppData\\Local\\xplainer\\state",
      tokenFile: "C:\\Users\\First Last\\AppData\\Local\\xplainer\\state\\token",
      socket: "\\\\.\\pipe\\xplainer-first-last",
    };
    const contents = renderScheduledTask(
      windowsSpec(settings, settings.stateDir),
      environment,
    ).contents;

    expect(contents).toContain(`--state-dir &quot;${settings.stateDir}&quot;`);
    expect(contents).toContain(`--token-file &quot;${settings.tokenFile}&quot;`);
    // No space, so no quotes: an argument is quoted when it needs to be and not as a habit.
    expect(contents).toContain(`--socket ${settings.socket}</Arguments>`);
    // <Command> is its own element rather than the head of a command line, so it stays bare.
    expect(contents).toContain(
      "<Command>C:\\Users\\First Last\\AppData\\Local\\xplainer\\state\\runtime\\1-a\\bin\\node.exe</Command>",
    );
    expect(contents).toContain(
      "<WorkingDirectory>C:\\Users\\First Last\\AppData\\Local\\xplainer\\state</WorkingDirectory>",
    );
  });

  it("escapes an ampersand rather than emitting a document nothing can parse", () => {
    const settings: LaunchSettings = {
      stateDir: "C:\\R&D\\state",
      tokenFile: "C:\\R&D\\state\\token",
      socket: "\\\\.\\pipe\\xplainer",
    };
    const contents = renderScheduledTask(
      windowsSpec(settings, settings.stateDir),
      environment,
    ).contents;

    expect(contents).toContain("--state-dir C:\\R&amp;D\\state");
    expect(contents).toContain("<WorkingDirectory>C:\\R&amp;D\\state</WorkingDirectory>");
    expect(contents).not.toContain("R&D");
  });

  it("refuses a contract with a setting removed rather than rendering a task without it", () => {
    const withoutStateDir: LaunchSpec = { ...spec, settings: { ...spec.settings, stateDir: "" } };

    expect(() => renderScheduledTask(withoutStateDir, environment)).toThrow(
      SupervisorArtefactError,
    );
    expect(() => renderScheduledTask(withoutStateDir, environment)).toThrow(/settings\.stateDir/);
  });

  it("refuses an account it cannot make a task name out of", () => {
    expect(() => renderScheduledTask(spec, { ...environment, account: "DOMAIN\\" })).toThrow(
      /task name/,
    );
    expect(() => renderScheduledTask(spec, { ...environment, account: "" })).toThrow(
      /environment\.account/,
    );
  });

  it("refuses to place the mirror without %LOCALAPPDATA%", () => {
    const { localAppData: _localAppData, ...without } = environment;

    expect(() => renderScheduledTask(spec, without)).toThrow(/environment\.localAppData/);
  });
});
