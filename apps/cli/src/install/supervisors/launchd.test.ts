/**
 * The LaunchAgent plist, asserted whole and then asserted key by key.
 *
 * Same shape as the systemd suite and for the same reason: the spec comes from `buildLaunchSpec()`
 * against a real payload-1 artefact, the first case is the whole document byte for byte, and the
 * cases after it are the ones the plan names — the four settings in the plist's own forms, the two
 * keys the P2-S5 measurements make load-bearing (`ExitTimeOut`, `KeepAlive`), `ProcessType` with
 * the value that means *unthrottled*, `Umask` as an integer, and a `~` that never reaches a file
 * launchd will not expand it in.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildLaunchSpec, type LaunchSpec } from "../../runtime/launch-spec.js";
import { buildFixturePayload } from "../testing/payload.js";
import { SupervisorArtefactError, type SupervisorEnvironment } from "./artefact.js";
import {
  LAUNCH_AGENT_LABEL,
  LAUNCH_AGENT_MODE,
  launchAgentLogPath,
  launchAgentPath,
  renderLaunchAgentPlist,
} from "./launchd.js";

let scratch = "";
let home = "";
let stateDir = "";
let tokenFile = "";
let socket = "";
let spec: LaunchSpec;
let environment: SupervisorEnvironment;

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "xplainer-launchd-")));
  home = join(scratch, "Users", "alice");
  stateDir = join(home, "Library", "Application Support", "video.xplainer");
  tokenFile = join(stateDir, "token");
  socket = join(scratch, "sock", "xplainer.sock");
  mkdirSync(stateDir, { recursive: true });
  buildFixturePayload({
    outDir: join(scratch, "runtime"),
    version: "1.2.3",
    marker: "launchd",
    runnable: false,
  });
  spec = buildLaunchSpec({
    runtimeDir: join(scratch, "runtime"),
    port: 8787,
    settings: { stateDir, tokenFile, socket },
    cwd: stateDir,
    platform: "darwin",
  });
  environment = { home, account: "alice" };
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("the LaunchAgent plist", () => {
  it("renders the whole document, and every key of it is accounted for", () => {
    const artefact = renderLaunchAgentPlist(spec, environment);
    const programArguments = [spec.executable, ...spec.argv]
      .map((word) => `    <string>${word}</string>`)
      .join("\n");
    const log = join(home, "Library", "Logs", "xplainer", "daemon.log");

    expect(artefact.contents).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>video.xplainer.daemon</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>XPLAINER_STATE_DIR</key>
    <string>${stateDir}</string>
    <key>XPLAINER_TOKEN_FILE</key>
    <string>${tokenFile}</string>
  </dict>
  <key>WorkingDirectory</key><string>${stateDir}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ExitTimeOut</key><integer>45</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
  <key>Umask</key><integer>63</integer>
</dict>
</plist>
`,
    );
  });

  it("belongs at ~/Library/LaunchAgents/video.xplainer.daemon.plist, mode 0600", () => {
    const artefact = renderLaunchAgentPlist(spec, environment);

    expect(artefact.path).toBe(
      join(home, "Library", "LaunchAgents", "video.xplainer.daemon.plist"),
    );
    expect(artefact.path).toBe(launchAgentPath(environment));
    expect(artefact.mode).toBe(LAUNCH_AGENT_MODE);
    expect(LAUNCH_AGENT_MODE).toBe(0o600);
    expect(artefact.identity).toBe(LAUNCH_AGENT_LABEL);
    expect(artefact.kind).toBe("launchd");
  });

  it("carries all four settings, each in the form the plist spells it", () => {
    const contents = renderLaunchAgentPlist(spec, environment).contents;

    expect(contents).toContain(
      `  <dict>\n    <key>XPLAINER_STATE_DIR</key>\n    <string>${stateDir}</string>`,
    );
    expect(contents).toContain(
      `    <key>XPLAINER_TOKEN_FILE</key>\n    <string>${tokenFile}</string>`,
    );
    expect(contents).toContain(`  <key>WorkingDirectory</key><string>${stateDir}</string>`);
    // The socket has no environment variable, so it arrives the way all three do: in the argv.
    expect(contents).toContain(`    <string>--socket</string>\n    <string>${socket}</string>`);
    expect(contents).toContain(
      `    <string>--state-dir</string>\n    <string>${stateDir}</string>`,
    );
    expect(contents).toContain(
      `    <string>--token-file</string>\n    <string>${tokenFile}</string>`,
    );
    expect(contents).not.toContain("XPLAINER_SOCKET");
  });

  it("starts the interpreter with the entry file, in the order the contract gives them", () => {
    const contents = renderLaunchAgentPlist(spec, environment).contents;
    const array = contents.slice(
      contents.indexOf("<array>") + "<array>".length,
      contents.indexOf("</array>"),
    );
    const strings = [...array.matchAll(/<string>(.*)<\/string>/g)].map((match) => match[1]);

    expect(strings).toEqual([spec.executable, ...spec.argv]);
  });

  it("sends both streams to ~/Library/Logs/xplainer/daemon.log", () => {
    const log = launchAgentLogPath(environment);
    const contents = renderLaunchAgentPlist(spec, environment).contents;

    expect(log).toBe(join(home, "Library", "Logs", "xplainer", "daemon.log"));
    expect(contents).toContain(`<key>StandardOutPath</key><string>${log}</string>`);
    expect(contents).toContain(`<key>StandardErrorPath</key><string>${log}</string>`);
  });

  it("keeps the three values the P2-S5 measurements make load-bearing", () => {
    const contents = renderLaunchAgentPlist(spec, environment).contents;

    // `ExitTimeOut` bounds `kickstart -k`, so it has to exceed ADR 0024's 20 s drain cap.
    expect(contents).toContain("<key>ExitTimeOut</key><integer>45</integer>");
    // An exit 0 is left alone, which is what the circuit breaker's deliberate exit 0 needs.
    expect(contents).toContain(
      "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    );
    // Unspecified is the *throttled* case, for a job whose work is Chrome and ffmpeg.
    expect(contents).toContain("<key>ProcessType</key><string>Interactive</string>");
    expect(contents).toContain("<key>ThrottleInterval</key><integer>30</integer>");
  });

  it("writes Umask as the decimal integer 63, which is 0o077", () => {
    expect(renderLaunchAgentPlist(spec, environment).contents).toContain(
      "<key>Umask</key><integer>63</integer>",
    );
    expect(0o077).toBe(63);
  });

  it("escapes a path that would otherwise close a tag", () => {
    const awkward: LaunchSpec = { ...spec, cwd: join(stateDir, "a & b <c>") };

    expect(renderLaunchAgentPlist(awkward, environment).contents).toContain(
      `<key>WorkingDirectory</key><string>${join(stateDir, "a &amp; b &lt;c&gt;")}</string>`,
    );
  });

  it("refuses a path still carrying a ~, because launchd expands none", () => {
    const unexpanded: LaunchSpec = { ...spec, cwd: "~/Library/Application Support/video.xplainer" };

    expect(() => renderLaunchAgentPlist(unexpanded, environment)).toThrow(SupervisorArtefactError);
    expect(() => renderLaunchAgentPlist(unexpanded, environment)).toThrow(/expands no/);
    expect(() => renderLaunchAgentPlist(spec, { ...environment, home: "~" })).toThrow(
      /environment\.home/,
    );
  });

  it("refuses a contract with a setting removed rather than rendering a plist without it", () => {
    const withoutToken: LaunchSpec = { ...spec, settings: { ...spec.settings, tokenFile: "" } };

    expect(() => renderLaunchAgentPlist(withoutToken, environment)).toThrow(
      SupervisorArtefactError,
    );
    expect(() => renderLaunchAgentPlist(withoutToken, environment)).toThrow(/settings\.tokenFile/);
  });
});
