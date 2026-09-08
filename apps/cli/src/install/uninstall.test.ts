/**
 * `daemon uninstall`, on the three things it is not allowed to get wrong.
 *
 * The round trip — install, ask the daemon, uninstall, install again — is in `install.test.ts`,
 * because it needs an install. What is here is the behaviour that is only visible at the *edges*:
 * a token that has to be **deleted** rather than rotated even when it lives outside the state
 * directory, lingering that must survive an uninstall even though this project enabled it, and a
 * launchd disable store this command can honestly change in exactly one direction.
 *
 * `run` is the same seam `preflight.ts` established, for the same reason: `launchctl` and
 * `systemctl` cannot both be exercised on one machine, and what is being asserted is which commands
 * were issued and which were not — "no `disable-linger` was run" is a claim about a *sequence*, and
 * a recorded sequence is how it is checked.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { updateDaemonState } from "../daemon/daemon-state.js";
import { launcherPath } from "./launcher.js";
import type { ProbeResult, ProbeRunner } from "./preflight.js";
import { stagedRuntimeRoot } from "./stage.js";
import type { SupervisorEnvironment } from "./supervisors/artefact.js";
import { uninstallDaemon } from "./uninstall.js";

const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scratchDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "xplainer-uninstall-")));
  scratch.push(directory);
  return directory;
}

/** A runner that answers `0` to everything and records what it was asked. */
function recorder(stdout = ""): { run: ProbeRunner; commands: string[] } {
  const commands: string[] = [];
  const run: ProbeRunner = (command) => {
    commands.push(`${command.program} ${command.argv.join(" ")}`);
    const answer: ProbeResult = { started: true, status: 0, stdout: "", stderr: "" };
    return command.argv[0] === "print-disabled" ? { ...answer, stdout } : answer;
  };
  return { run, commands };
}

/** A state directory that looks exactly like one an install left behind. */
function installedState(options: {
  platform: NodeJS.Platform;
  environment: SupervisorEnvironment;
  artefact: string;
  lingerEnabledByUs?: boolean | null;
  launchdRecordCreated?: boolean | null;
  tokenFile?: string;
}): { stateDir: string; tokenFile: string } {
  const stateDir = join(scratchDirectory(), "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(stagedRuntimeRoot(stateDir), "1.2.3-abcdef"), { recursive: true });
  writeFileSync(join(stagedRuntimeRoot(stateDir), "1.2.3-abcdef", "runtime.manifest.json"), "{}\n");
  mkdirSync(join(stateDir, "bin"), { recursive: true });
  writeFileSync(launcherPath(stateDir, options.platform), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  writeFileSync(join(stateDir, "runtime.json"), '{"format_version":1}\n');
  writeFileSync(join(stateDir, "owner.lock"), "{}\n");
  writeFileSync(join(stateDir, "toolchain.json"), '{"format_version":1}\n');
  mkdirSync(join(stateDir, "workspace", "videos", "kept"), { recursive: true });
  const tokenFile = options.tokenFile ?? join(stateDir, "token");
  mkdirSync(join(tokenFile, ".."), { recursive: true });
  writeFileSync(tokenFile, "a-real-looking-secret", { mode: 0o600 });
  mkdirSync(join(options.artefact, ".."), { recursive: true });
  writeFileSync(options.artefact, "the artefact\n");

  updateDaemonState(stateDir, {
    port: 8787,
    token_file: tokenFile,
    socket_path: join(stateDir, "ipc", "xplainer.sock"),
    supervisor_kind: options.platform === "linux" ? "systemd" : "launchd",
    supervisor_artefact: options.artefact,
    runtime_dir: join(stagedRuntimeRoot(stateDir), "1.2.3-abcdef"),
    program_source: "runtime-dir",
    linger_enabled_by_us: options.lingerEnabledByUs ?? null,
    launchd_enable_record_created: options.launchdRecordCreated ?? null,
    installed_version: "0.0.0",
  });
  return { stateDir, tokenFile };
}

describe("the token", () => {
  /**
   * P2-9 asks for "no live token" after an uninstall, and round 2's "rotate" could not deliver it:
   * rotation mints a value and leaves it on disk. The file is followed to wherever
   * `XPLAINER_TOKEN_FILE` put it — a token outside the state directory is still a live token.
   */
  it("is deleted rather than rotated, even when it lives outside the state directory", () => {
    const home = scratchDirectory();
    const elsewhere = join(scratchDirectory(), "secrets", "xplainer.token");
    const environment: SupervisorEnvironment = { home, account: "tester" };
    const { stateDir, tokenFile } = installedState({
      platform: "darwin",
      environment,
      artefact: join(home, "Library", "LaunchAgents", "video.xplainer.daemon.plist"),
      tokenFile: elsewhere,
    });
    const { run } = recorder();

    const outcome = uninstallDaemon({ stateDir, platform: "darwin", environment, run, uid: 501 });

    expect(outcome.token).toEqual({ path: elsewhere, deleted: true });
    expect(existsSync(tokenFile)).toBe(false);
    // Nothing was written in its place: deletion, not rotation.
    expect(existsSync(join(stateDir, "token"))).toBe(false);
  });
});

describe("lingering", () => {
  /**
   * The rule the plan states in as many words: `uninstall` never disables lingering, **not even
   * lingering it enabled**, because the marker is per user and anything else the user has since
   * arranged to survive logout depends on it. The check is that no `disable-linger` was issued —
   * a claim about the sequence, checked against the sequence.
   */
  it("is never disabled, not even when this install enabled it, and is reported instead", () => {
    const home = scratchDirectory();
    const environment: SupervisorEnvironment = { home, account: "tester" };
    const { stateDir } = installedState({
      platform: "linux",
      environment,
      artefact: join(home, ".config", "systemd", "user", "xplainer.service"),
      lingerEnabledByUs: true,
    });
    const { run, commands } = recorder();

    const outcome = uninstallDaemon({ stateDir, platform: "linux", environment, run });

    expect(commands).toEqual([
      "systemctl --user disable --now xplainer.service",
      "systemctl --user daemon-reload",
    ]);
    expect(commands.join(" ")).not.toContain("disable-linger");
    expect(outcome.linger).toMatchObject({
      applicable: true,
      enabledByUs: true,
      marker: "/var/lib/systemd/linger/tester",
    });
    expect(outcome.linger.detail).toContain("this install enabled lingering for tester");
    expect(outcome.linger.detail).toContain("loginctl disable-linger tester");
  });

  it("says so plainly when the marker was somebody else's to begin with", () => {
    const home = scratchDirectory();
    const environment: SupervisorEnvironment = { home, account: "tester" };
    const { stateDir } = installedState({
      platform: "linux",
      environment,
      artefact: join(home, ".config", "systemd", "user", "xplainer.service"),
      lingerEnabledByUs: false,
    });
    const { run } = recorder();

    const outcome = uninstallDaemon({ stateDir, platform: "linux", environment, run });

    expect(outcome.linger.enabledByUs).toBe(false);
    expect(outcome.linger.detail).toContain("was not enabled by this install");
  });
});

describe("the launchd disable store", () => {
  /**
   * The one direction this command can honestly change: a `disabled` record for our label is what
   * would make a later install unloadable, and `launchctl enable` is its documented undo. The
   * measured spelling is `=> disabled`, not `=> true` — see `preflight.ts`'s own note and the
   * capture in `__fixtures__/`.
   */
  it("clears a disable record for our label with launchctl enable", () => {
    const home = scratchDirectory();
    const environment: SupervisorEnvironment = { home, account: "tester" };
    const { stateDir } = installedState({
      platform: "darwin",
      environment,
      artefact: join(home, "Library", "LaunchAgents", "video.xplainer.daemon.plist"),
    });
    const { run, commands } = recorder(
      '\tdisabled services = {\n\t\t"video.xplainer.daemon" => disabled\n\t}\n',
    );

    const outcome = uninstallDaemon({ stateDir, platform: "darwin", environment, run, uid: 501 });

    expect(outcome.launchdRecord).toMatchObject({ before: "disabled", cleared: true });
    expect(commands).toContain("launchctl enable gui/501/video.xplainer.daemon");
    expect(outcome.launchdRecord.detail).toContain("has been cleared");
  });

  /**
   * And the direction it cannot: `launchctl` sets a record's value and has no verb that removes
   * one, so the `enabled` entry our own `install` created is left and **named**, rather than
   * "cleaned up" with `launchctl disable` — which would create exactly the stale disable record the
   * install preflight exists to warn about.
   */
  it("leaves the enabled record our install created, names it, and never runs launchctl disable", () => {
    const home = scratchDirectory();
    const environment: SupervisorEnvironment = { home, account: "tester" };
    const { stateDir } = installedState({
      platform: "darwin",
      environment,
      artefact: join(home, "Library", "LaunchAgents", "video.xplainer.daemon.plist"),
      launchdRecordCreated: true,
    });
    const { run, commands } = recorder(
      '\tdisabled services = {\n\t\t"video.xplainer.daemon" => enabled\n\t}\n',
    );

    const outcome = uninstallDaemon({ stateDir, platform: "darwin", environment, run, uid: 501 });

    expect(outcome.launchdRecord).toMatchObject({ before: "enabled", cleared: false });
    expect(outcome.launchdRecord.detail).toContain("which this install created");
    expect(outcome.launchdRecord.detail).toContain("no verb that removes an entry");
    expect(commands.join(" ")).not.toContain("launchctl disable");
    expect(commands.join(" ")).not.toContain("launchctl enable");
  });
});

describe("what is removed and what is kept", () => {
  it("removes every install artefact and keeps the setup marker and the workspace", () => {
    const home = scratchDirectory();
    const environment: SupervisorEnvironment = { home, account: "tester" };
    const artefact = join(home, "Library", "LaunchAgents", "video.xplainer.daemon.plist");
    const { stateDir } = installedState({ platform: "darwin", environment, artefact });
    const { run } = recorder();

    const outcome = uninstallDaemon({ stateDir, platform: "darwin", environment, run, uid: 501 });

    expect(outcome.wasInstalled).toBe(true);
    for (const path of [
      artefact,
      join(stateDir, "runtime.json"),
      join(stateDir, "daemon.json"),
      join(stateDir, "owner.lock"),
      stagedRuntimeRoot(stateDir),
      launcherPath(stateDir, "darwin"),
      join(stateDir, "bin"),
    ]) {
      expect(existsSync(path), `${path} should be gone`).toBe(false);
    }
    expect(readFileSync(join(stateDir, "toolchain.json"), "utf8")).toContain("format_version");
    expect(existsSync(join(stateDir, "workspace", "videos", "kept"))).toBe(true);
    // Every path is reported, whether or not anything was there — the report is the receipt.
    expect(outcome.removed.map((entry) => entry.path)).toContain(artefact);
    expect(outcome.removed.every((entry) => entry.error === undefined)).toBe(true);
  });

  /**
   * "It is already not installed" is the state this command is asked for, so it is not a refusal.
   * A state directory that never held an install produces a report of absences and changes nothing
   * it was not asked to.
   */
  it("is idempotent on a state directory that was never installed into", () => {
    const home = scratchDirectory();
    const environment: SupervisorEnvironment = { home, account: "tester" };
    const stateDir = join(scratchDirectory(), "state");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const { run } = recorder();

    const outcome = uninstallDaemon({ stateDir, platform: "darwin", environment, run, uid: 501 });

    expect(outcome.wasInstalled).toBe(false);
    expect(outcome.token.deleted).toBe(true);
    expect(outcome.removed.every((entry) => !entry.existed)).toBe(true);
    expect(outcome.removed.every((entry) => entry.error === undefined)).toBe(true);
  });
});
