/**
 * The systemd unit, asserted whole and then asserted key by key.
 *
 * The spec under test is built by `buildLaunchSpec()` against a **real payload-1 artefact**, not
 * hand-written: a renderer that agreed with a literal in this file and disagreed with the contract
 * would install a daemon nobody could start, and the contract is the thing three renderers, the
 * update transaction and `daemon.json` all copy.
 *
 * The first case is the golden one — the whole file, byte for byte — because a per-key test cannot
 * catch a key that was never emitted. The cases after it are the ones the plan names: every setting
 * in the platform's own form, the start limit in the section it belongs to, `Type=exec` with no
 * `NotifyAccess=` beside it, and a renderer that refuses an incomplete contract rather than writing
 * a unit with a hole in it.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildLaunchSpec, type LaunchSpec } from "../../runtime/launch-spec.js";
import { buildFixturePayload } from "../testing/payload.js";
import { SupervisorArtefactError, type SupervisorEnvironment } from "./artefact.js";
import {
  renderSystemdUnit,
  SYSTEMD_UNIT_MODE,
  SYSTEMD_UNIT_NAME,
  systemdUnitPath,
} from "./systemd.js";

let scratch = "";
let stateDir = "";
let tokenFile = "";
let socket = "";
let spec: LaunchSpec;
let environment: SupervisorEnvironment;

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "xplainer-systemd-")));
  stateDir = join(scratch, "state");
  tokenFile = join(stateDir, "token");
  socket = join(scratch, "run", "xplainer", "xplainer.sock");
  mkdirSync(stateDir, { recursive: true });
  buildFixturePayload({
    outDir: join(scratch, "runtime"),
    version: "1.2.3",
    marker: "systemd",
    runnable: false,
  });
  spec = buildLaunchSpec({
    runtimeDir: join(scratch, "runtime"),
    port: 8787,
    settings: { stateDir, tokenFile, socket },
    cwd: stateDir,
    platform: "linux",
  });
  environment = { home: join(scratch, "home"), account: "alice" };
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A unit file's sections, so a key can be asserted against the section it is in. */
function sections(unit: string): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  let current = "";
  for (const line of unit.split("\n")) {
    if (line.startsWith("[") && line.endsWith("]")) {
      current = line.slice(1, -1);
      found[current] = [];
      continue;
    }
    if (line !== "") {
      found[current]?.push(line);
    }
  }
  return found;
}

describe("the systemd unit", () => {
  it("renders the whole file, and every line of it is accounted for", () => {
    const artefact = renderSystemdUnit(spec, environment);
    const execStart = [spec.executable, ...spec.argv].join(" ");

    expect(artefact.contents).toBe(
      `[Unit]
Description=xplainer local daemon
Documentation=https://xplainer.video
After=network.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=exec
ExecStart=${execStart}
WorkingDirectory=${stateDir}
Environment=XPLAINER_STATE_DIR=${stateDir}
Environment=XPLAINER_TOKEN_FILE=${tokenFile}
RuntimeDirectory=xplainer
RuntimeDirectoryMode=0700
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=45s
Restart=on-failure
RestartSec=2
SyslogIdentifier=xplainer
UMask=0077

[Install]
WantedBy=default.target
`,
    );
  });

  it("belongs at ~/.config/systemd/user/xplainer.service, mode 0644", () => {
    const artefact = renderSystemdUnit(spec, environment);

    expect(artefact.path).toBe(
      join(environment.home, ".config", "systemd", "user", "xplainer.service"),
    );
    expect(artefact.mode).toBe(SYSTEMD_UNIT_MODE);
    expect(SYSTEMD_UNIT_MODE).toBe(0o644);
    expect(artefact.identity).toBe(SYSTEMD_UNIT_NAME);
    expect(artefact.kind).toBe("systemd");
  });

  it("follows $XDG_CONFIG_HOME, which is where systemd looks first", () => {
    const elsewhere = join(scratch, "xdg-config");

    expect(systemdUnitPath({ ...environment, configHome: elsewhere })).toBe(
      join(elsewhere, "systemd", "user", "xplainer.service"),
    );
  });

  it("carries all four settings, each in the form the unit spells it", () => {
    const lines = sections(renderSystemdUnit(spec, environment).contents).Service ?? [];

    expect(lines).toContain(`Environment=XPLAINER_STATE_DIR=${stateDir}`);
    expect(lines).toContain(`Environment=XPLAINER_TOKEN_FILE=${tokenFile}`);
    expect(lines).toContain(`WorkingDirectory=${stateDir}`);
    const execStart = lines.find((line) => line.startsWith("ExecStart="));
    expect(execStart).toContain(`--state-dir ${stateDir}`);
    expect(execStart).toContain(`--token-file ${tokenFile}`);
    expect(execStart).toContain(`--socket ${socket}`);
    // The socket has no variable at all, which is why every setting travels in the argv.
    expect(lines).not.toContain(`Environment=XPLAINER_SOCKET=${socket}`);
  });

  it("puts the start limit in [Unit], where systemd reads it", () => {
    const parsed = sections(renderSystemdUnit(spec, environment).contents);

    expect(parsed.Unit).toContain("StartLimitIntervalSec=300");
    expect(parsed.Unit).toContain("StartLimitBurst=10");
    expect(parsed.Service).not.toContain("StartLimitIntervalSec=300");
    expect(parsed.Service).not.toContain("StartLimitBurst=10");
    expect(parsed.Install).toEqual(["WantedBy=default.target"]);
  });

  it("is Type=exec with no NotifyAccess= beside it, per ADR 0025's note", () => {
    const artefact = renderSystemdUnit(spec, environment);

    expect(sections(artefact.contents).Service).toContain("Type=exec");
    expect(artefact.contents).not.toContain("NotifyAccess");
    expect(artefact.contents).not.toContain("Type=notify");
  });

  it("carries the drain's own keys: mixed, SIGTERM, and a stop budget above the 20 s cap", () => {
    const service = sections(renderSystemdUnit(spec, environment).contents).Service ?? [];

    expect(service).toContain("KillMode=mixed");
    expect(service).toContain("KillSignal=SIGTERM");
    expect(service).toContain("TimeoutStopSec=45s");
    expect(service).toContain("RuntimeDirectory=xplainer");
    expect(service).toContain("RuntimeDirectoryMode=0700");
  });

  it("quotes a path with a space and doubles a % rather than letting systemd expand it", () => {
    const awkward = buildLaunchSpec({
      runtimeDir: join(scratch, "runtime"),
      port: 8787,
      settings: {
        stateDir: join(scratch, "state 100%"),
        tokenFile,
        socket,
      },
      cwd: join(scratch, "state 100%"),
      platform: "linux",
    });

    const service = sections(renderSystemdUnit(awkward, environment).contents).Service ?? [];
    const execStart = service.find((line) => line.startsWith("ExecStart="));
    expect(execStart).toContain(`--state-dir "${join(scratch, "state 100%%")}"`);
    expect(service).toContain(`Environment="XPLAINER_STATE_DIR=${join(scratch, "state 100%%")}"`);
    // A path setting is read to the end of the line, so quoting one would make the quotes part
    // of the path — but the specifier still has to be escaped.
    expect(service).toContain(`WorkingDirectory=${join(scratch, "state 100%%")}`);
  });

  it("refuses a contract with a setting removed rather than rendering a unit without it", () => {
    const withoutSocket: LaunchSpec = { ...spec, settings: { ...spec.settings, socket: "" } };

    expect(() => renderSystemdUnit(withoutSocket, environment)).toThrow(SupervisorArtefactError);
    expect(() => renderSystemdUnit(withoutSocket, environment)).toThrow(/settings\.socket/);
  });

  it("refuses a contract whose argv lost a flag its settings still name", () => {
    const dropped = spec.argv.filter(
      (word, index) => word !== "--token-file" && spec.argv[index - 1] !== "--token-file",
    );
    const emptied: LaunchSpec = { ...spec, argv: dropped };

    expect(() => renderSystemdUnit(emptied, environment)).toThrow(/--token-file/);
  });

  it("refuses a home it cannot place the unit under", () => {
    expect(() => renderSystemdUnit(spec, { ...environment, home: "" })).toThrow(
      /environment\.home/,
    );
  });
});
