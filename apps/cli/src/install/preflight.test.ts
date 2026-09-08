/**
 * The preflight, asserted on what it answers **and** on what it leaves behind.
 *
 * Two properties are being checked here and the second one is the harder one. The first is that
 * each degraded condition produces the code and the remediation ADR 0020 §Degraded paths fixes for
 * it. The second is P2-10's own obligation — that a refused install "writes nothing" — and a test
 * that only read the return value could not see a violation of it at all. So every refusal case
 * runs against a **hashed snapshot** of the state directory *and* of the supervisor locations an
 * install would write to, taken before the call and compared after it: the unit, the plist, the
 * task XML and the linger marker, whichever of them this platform has.
 *
 * **Nothing is mocked.** The setup marker is a real file, the staged runtime is a real payload-1
 * artefact whose interpreter is a real file with a real mode, and the held port is a real listener
 * on a real socket. The one seam is `run` — how a probe command reaches the outside world — which
 * is a parameter for the reason `daemon/state-dir.ts` gives about `platform` and `home`: the Linux
 * and Windows branches have to be checkable from one machine, and a canned `systemctl` answer is
 * the only way to assert the sentence a user on that platform is shown. The macOS branch is
 * additionally run against the **real** `launchctl` on a macOS host, so at least one platform's
 * probe is proved end to end here rather than only in a container.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  type Dirent,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { Toolchain } from "@xplainer/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  INSTALL_CONFLICT_EXIT_CODE,
  NO_SUPERVISOR_EXIT_CODE,
  PRECONDITION_UNMET_EXIT_CODE,
} from "../daemon/exit-codes.js";
import { launcherPath } from "./launcher.js";
import {
  currentSupervisorEnvironment,
  type InstallPreflight,
  type PreflightRequest,
  type ProbeCommand,
  type ProbeResult,
  type ProbeRunner,
  preflightInstall,
  preflightWriteLocations,
  readDisableRecord,
  runProbe,
  SPAWN_REMEDIATION,
  TOOLCHAIN_FORMAT_VERSION,
  toolchainMarkerPath,
} from "./preflight.js";
import { resolveProgram } from "./program.js";
import { stageRuntime } from "./stage.js";
import { buildFixturePayload } from "./testing/payload.js";
import { writeToolchainMarker } from "./testing/toolchain.js";

/** The verbatim `launchctl print-disabled` capture beside this file, comment header stripped. */
const PRINT_DISABLED_FIXTURE = fileURLToPath(
  new URL("./__fixtures__/launchctl-print-disabled.txt", import.meta.url),
);

/**
 * The capture's own bytes, with only the `#` provenance header removed.
 *
 * Stripped by prefix rather than by line count, so a longer header is not a silently truncated
 * fixture: launchctl's own output has no line beginning with `#`.
 */
function printDisabledFixture(): string {
  return readFileSync(PRINT_DISABLED_FIXTURE, "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n");
}

const scratch: string[] = [];
const listeners: Server[] = [];

afterEach(async () => {
  for (const listener of listeners.splice(0)) {
    await new Promise<void>((resolve) => {
      listener.close(() => {
        resolve();
      });
    });
  }
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A scratch directory, resolved through its own symlinks so paths compare as themselves. */
function scratchDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "xplainer-preflight-")));
  scratch.push(directory);
  return directory;
}

/** A state directory with nothing in it, which is where every machine starts. */
function stateDirectory(): string {
  const root = scratchDirectory();
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  return stateDir;
}

/** A complete toolchain marker whose two recorded files really are on disk. */
function writeMarker(stateDir: string, overrides: Partial<Toolchain> = {}): Toolchain {
  return writeToolchainMarker(stateDir, overrides);
}

/** A runner that answers every command the same way, and records what it was asked. */
function runnerAnswering(answer: Partial<ProbeResult>): {
  run: ProbeRunner;
  asked: ProbeCommand[];
} {
  const asked: ProbeCommand[] = [];
  const run: ProbeRunner = (command) => {
    asked.push(command);
    return { started: true, status: 0, stdout: "", stderr: "", ...answer };
  };
  return { run, asked };
}

/** A runner nothing may reach: any command it is handed is a probe that should not have run. */
const noCommands: ProbeRunner = (command) => {
  throw new Error(`the preflight ran ${command.program} ${command.argv.join(" ")}`);
};

/** Every file under `root`, as `path → sha256`, so "nothing was written" is a comparison. */
function hashTree(root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  const walk = (directory: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        hashes[`${path}/`] = `mode ${(statSync(path).mode & 0o7777).toString(8)}`;
        walk(path);
        continue;
      }
      hashes[path] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(root);
  return hashes;
}

/** The state directory and every supervisor location, hashed together. */
function hashLocations(locations: readonly string[]): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const location of locations) {
    if (!existsSync(location)) {
      hashes[location] = "absent";
      continue;
    }
    if (statSync(location).isDirectory()) {
      Object.assign(hashes, hashTree(location));
      continue;
    }
    hashes[location] = createHash("sha256").update(readFileSync(location)).digest("hex");
  }
  return hashes;
}

/**
 * Run the preflight and prove it changed nothing it could have changed.
 *
 * The locations come from the preflight's own answer, so this cannot drift from what it probes: a
 * new write location is a new hashed path here without an edit.
 */
async function preflightWithoutWriting(request: PreflightRequest): Promise<InstallPreflight> {
  const first = await preflightInstall(request);
  const locations = preflightWriteLocations(first);
  const before = hashLocations(locations);
  const second = await preflightInstall(request);
  expect(hashLocations(locations)).toEqual(before);
  return second;
}

describe("currentSupervisorEnvironment", () => {
  /**
   * The Windows task's principal and its name come from one string, and they want different halves
   * of it: `<UserId>` needs the qualified `DOMAIN\\user` form to resolve against the right
   * authority, and `taskName()` reads the user part back off it. A bare `USERNAME` satisfies the
   * second and quietly breaks the first.
   */
  it("qualifies the account as DOMAIN\\user on Windows, and leaves it bare everywhere else", () => {
    const windows = { USERNAME: "tester", USERDOMAIN: "CORP" };

    expect(currentSupervisorEnvironment(windows, "C:\\Users\\tester", "win32").account).toBe(
      "CORP\\tester",
    );
    expect(currentSupervisorEnvironment(windows, "/home/tester", "linux").account).toBe("tester");
    expect(
      currentSupervisorEnvironment({ USERNAME: "CORP\\tester" }, "C:\\", "win32").account,
    ).toBe("CORP\\tester");
    expect(currentSupervisorEnvironment({ USERNAME: "tester" }, "C:\\", "win32").account).toBe(
      "tester",
    );
  });
});

describe("the setup marker", () => {
  it("refuses with 3 and the one command that fixes it when setup has not run", async () => {
    const stateDir = stateDirectory();

    const preflight = await preflightWithoutWriting({
      stateDir,
      port: 0,
      platform: "linux",
      run: runnerAnswering({ stdout: "running\n" }).run,
    });

    expect(preflight.toolchain.marker).toBeNull();
    const refusal = preflight.refusals[0];
    expect(refusal?.code).toBe("setup-absent");
    expect(refusal?.exitCode).toBe(PRECONDITION_UNMET_EXIT_CODE);
    expect(refusal?.message).toContain("xplainer setup");
    expect(refusal?.message).toContain(toolchainMarkerPath(stateDir));
  });

  it("refuses with 3 when the marker is there and the files it records are not", async () => {
    const stateDir = stateDirectory();
    const marker = writeMarker(stateDir);
    rmSync(marker.chrome.path);

    const preflight = await preflightWithoutWriting({
      stateDir,
      port: 0,
      platform: "linux",
      run: runnerAnswering({ stdout: "running\n" }).run,
    });

    expect(preflight.toolchain.missing).toEqual([marker.chrome.path]);
    expect(preflight.refusals[0]).toMatchObject({
      code: "setup-paths-gone",
      exitCode: PRECONDITION_UNMET_EXIT_CODE,
    });
    expect(preflight.refusals[0]?.message).toContain("xplainer setup");
  });

  it("refuses with 3 when the marker cannot be parsed or is incomplete", async () => {
    const broken = stateDirectory();
    writeFileSync(toolchainMarkerPath(broken), "{not json\n");
    const partial = stateDirectory();
    writeFileSync(
      toolchainMarkerPath(partial),
      `${JSON.stringify({ format_version: 1, created_at: "2026-09-08T09:00:00Z" })}\n`,
    );

    for (const stateDir of [broken, partial]) {
      const preflight = await preflightWithoutWriting({
        stateDir,
        port: 0,
        platform: "darwin",
        run: runnerAnswering({}).run,
      });
      expect(preflight.refusals[0]).toMatchObject({
        code: "setup-unreadable",
        exitCode: PRECONDITION_UNMET_EXIT_CODE,
      });
    }
  });

  /**
   * The same rule the job store applies to a record a newer daemon wrote: an unknown format version
   * is a rollback signal, not corruption. The marker is reported as newer and is still read, because
   * every field this build needs is a field a later one keeps.
   */
  it("reads a marker written by a newer build rather than treating it as damaged", async () => {
    const stateDir = stateDirectory();
    writeMarker(stateDir, { format_version: TOOLCHAIN_FORMAT_VERSION + 7 });

    const preflight = await preflightWithoutWriting({
      stateDir,
      port: 0,
      platform: "darwin",
      run: runnerAnswering({}).run,
    });

    expect(preflight.toolchain.newerFormat).toBe(true);
    expect(preflight.toolchain.marker?.chrome.provider).toBe("remotion");
    expect(preflight.refusals.map((refusal) => refusal.code)).not.toContain("setup-unreadable");
  });
});

describe("the supervisor", () => {
  it("detects systemd by /run/systemd/system and refuses 6 when it is not there", async () => {
    const stateDir = stateDirectory();
    writeMarker(stateDir);
    const { run, asked } = runnerAnswering({ stdout: "running\n" });

    const preflight = await preflightWithoutWriting({
      stateDir,
      port: 0,
      platform: "linux",
      run,
      environment: {
        home: scratchDirectory(),
        account: "tester",
        lingerDir: scratchDirectory(),
        systemdBooted: join(scratchDirectory(), "no-such-run-systemd-system"),
      },
    });

    expect(preflight.supervisor).toMatchObject({ kind: "systemd", present: false, usable: false });
    expect(preflight.refusals[0]).toMatchObject({
      code: "no-user-manager",
      exitCode: NO_SUPERVISOR_EXIT_CODE,
    });
    expect(preflight.refusals[0]?.message).toContain(SPAWN_REMEDIATION);
    // The remediation leads: it is the first command in the message, not a footnote after it.
    const message = preflight.refusals[0]?.message ?? "";
    expect(message.indexOf(SPAWN_REMEDIATION)).toBeLessThan(message.indexOf("docs/daemon.md"));
    // `command -v systemctl` is not the question, so `systemctl` is never run once the directory
    // has answered — which is the whole point of using the directory.
    expect(asked).toEqual([]);
  });

  /**
   * The second half of the check, and the one a booted-system test cannot reach: systemd is PID 1
   * and this *user* still has no manager to register a unit with. ADR 0020's degraded row is the
   * same `6`, and the sentence has to say which of the two facts failed.
   */
  it("refuses 6 when systemd booted the machine and this user has no manager", async () => {
    const stateDir = stateDirectory();
    writeMarker(stateDir);
    const booted = join(scratchDirectory(), "run-systemd-system");
    mkdirSync(booted, { recursive: true });
    const { run, asked } = runnerAnswering({ status: 1, stdout: "offline\n" });

    const preflight = await preflightWithoutWriting({
      stateDir,
      port: 0,
      platform: "linux",
      run,
      environment: {
        home: scratchDirectory(),
        account: "tester",
        lingerDir: scratchDirectory(),
        systemdBooted: booted,
      },
    });

    expect(preflight.supervisor).toMatchObject({ present: true, usable: false });
    expect(preflight.supervisor.detail).toContain("offline");
    expect(preflight.refusals[0]).toMatchObject({
      code: "no-user-manager",
      exitCode: NO_SUPERVISOR_EXIT_CODE,
    });
    expect(preflight.refusals[0]?.message).toContain(SPAWN_REMEDIATION);
    expect(asked[0]).toEqual({ program: "systemctl", argv: ["--user", "is-system-running"] });
  });

  it("accepts a booted machine whose user manager answers, and names the unit it would write", async () => {
    const stateDir = stateDirectory();
    writeMarker(stateDir);
    const booted = join(scratchDirectory(), "run-systemd-system");
    mkdirSync(booted, { recursive: true });
    const home = scratchDirectory();

    const preflight = await preflightWithoutWriting({
      stateDir,
      port: 0,
      platform: "linux",
      run: runnerAnswering({ stdout: "degraded\n", status: 1 }).run,
      environment: {
        home,
        account: "tester",
        lingerDir: join(home, "linger"),
        systemdBooted: booted,
      },
    });

    expect(preflight.supervisor).toMatchObject({ present: true, usable: true, refusal: null });
    expect(preflight.supervisor.artefact).toBe(
      join(home, ".config", "systemd", "user", "xplainer.service"),
    );
    expect(preflight.supervisor.identity).toBe("xplainer.service");
  });

  /**
   * Windows: the supervisor is there and will not let *this* session register. ADR 0020 gives it
   * the same `6` as "there is no supervisor", because the next step is the same one.
   */
  it("refuses 6 when Task Scheduler answers a query with access denied", async () => {
    const stateDir = stateDirectory();
    writeMarker(stateDir);

    const preflight = await preflightWithoutWriting({
      stateDir,
      port: 0,
      platform: "win32",
      run: runnerAnswering({ status: 1, stderr: "ERROR: Access is denied.\r\n" }).run,
      environment: {
        home: "C:\\Users\\tester",
        account: "CORP\\tester",
        localAppData: "C:\\Users\\tester\\AppData\\Local",
      },
    });

    expect(preflight.supervisor).toMatchObject({ present: true, usable: false });
    expect(preflight.refusals[0]).toMatchObject({
      code: "registration-blocked",
      exitCode: NO_SUPERVISOR_EXIT_CODE,
    });
    expect(preflight.refusals[0]?.message).toContain(SPAWN_REMEDIATION);
    expect(preflight.refusals[0]?.message).toContain("Access is denied.");
  });

  it("accepts a Task Scheduler that answers, and names the task it would register", async () => {
    const stateDir = stateDirectory();
    writeMarker(stateDir);

    const preflight = await preflightWithoutWriting({
      stateDir,
      port: 0,
      platform: "win32",
      run: runnerAnswering({ status: 1, stdout: "INFO: There are no scheduled tasks.\r\n" }).run,
      environment: {
        home: "C:\\Users\\tester",
        account: "CORP\\tester",
        localAppData: "C:\\Users\\tester\\AppData\\Local",
      },
    });

    expect(preflight.supervisor).toMatchObject({ usable: true, refusal: null });
    expect(preflight.supervisor.identity).toBe("\\xplainer\\tester-daemon");
    // **The directory is the artefact's own, in the grammar the artefact was composed in.** The
    // Task Scheduler renderer answers with a `win32.join`ed path, which on macOS and Linux carries
    // no `/` at all — so the host's `dirname` answers `"."`, and every caller of
    // `preflightWriteLocations` is then told an install may write to the current working
    // directory. `install.test.ts` hashes each of those either side of a refusal, so it was
    // hashing this checkout.
    expect(preflight.supervisor.artefactDir).toBe(
      "C:\\Users\\tester\\AppData\\Local\\xplainer\\service",
    );
    expect(preflightWriteLocations(preflight)).not.toContain(".");
  });

  it("refuses 6 on macOS when launchd has no GUI domain for this user", async () => {
    const stateDir = stateDirectory();
    writeMarker(stateDir);

    const preflight = await preflightWithoutWriting({
      stateDir,
      port: 0,
      platform: "darwin",
      run: runnerAnswering({
        status: 113,
        stderr: "Could not find domain for\n",
      }).run,
      environment: { home: scratchDirectory(), account: "tester" },
    });

    expect(preflight.supervisor).toMatchObject({ usable: false });
    expect(preflight.refusals[0]).toMatchObject({
      code: "no-user-manager",
      exitCode: NO_SUPERVISOR_EXIT_CODE,
    });
    expect(preflight.disabled).toMatchObject({ applicable: true, probed: false });
  });

  /**
   * The canned answer is the **fixture**, so this case and the parser below cannot drift apart: the
   * stale-record branch is driven by bytes a real `launchctl` printed, with one value swapped from
   * `enabled` to `disabled` — the swap is named here rather than hidden, because this machine's own
   * store holds no disabled record for our label and inventing the whole document would put the
   * spelling back under this test's control, which is what let the defect through.
   */
  it("names a stale launchctl disable record without refusing, and the command that undoes it", async () => {
    const stateDir = stateDirectory();
    writeMarker(stateDir);
    const uid = process.getuid?.() ?? 0;

    const preflight = await preflightWithoutWriting({
      stateDir,
      port: 0,
      platform: "darwin",
      run: runnerAnswering({
        stdout: printDisabledFixture().replace(
          `"video.xplainer.daemon" => enabled`,
          `"video.xplainer.daemon" => disabled`,
        ),
      }).run,
      environment: { home: scratchDirectory(), account: "tester" },
    });

    expect(preflight.disabled).toMatchObject({
      applicable: true,
      probed: true,
      disabled: true,
      record: "disabled",
    });
    expect(preflight.disabled.detail).toContain(
      `launchctl enable gui/${uid}/video.xplainer.daemon`,
    );
    // A disable record is a fact and not a refusal: the install can proceed, and `status` says so.
    expect(preflight.refusals).toEqual([]);
  });

  /**
   * The defect this parser was rewritten for, pinned to the bytes that exposed it.
   *
   * `preflight.ts` matched `/=>\s*true/`. The fixture is a verbatim capture of
   * `launchctl print-disabled gui/$(id -u)` on macOS 2026-09-08 and contains no `true` at all, so
   * the old predicate answered "not disabled" for every label on the platform — the one condition
   * the probe exists to catch, silently unreachable. The first assertion is that regression, stated
   * as a property of the capture rather than of the code.
   */
  it("reads `=> disabled`, `=> enabled` and an absent label out of a real print-disabled capture", () => {
    const output = printDisabledFixture();

    expect(/=>\s*true/.test(output)).toBe(false);
    expect(readDisableRecord(output, "com.apple.Siri.agent")).toBe("disabled");
    expect(readDisableRecord(output, "com.apple.ManagedClientAgent.enrollagent")).toBe("disabled");
    expect(readDisableRecord(output, "video.xplainer.daemon")).toBe("enabled");
    expect(readDisableRecord(output, "com.ollama.ollama")).toBe("enabled");
    expect(readDisableRecord(output, "video.xplainer.never-installed")).toBe("absent");
    // The spelling older releases printed is still read, because accepting it costs one word.
    expect(
      readDisableRecord(`\t\t"video.xplainer.daemon" => true\n`, "video.xplainer.daemon"),
    ).toBe("disabled");
    expect(
      readDisableRecord(`\t\t"video.xplainer.daemon" => false\n`, "video.xplainer.daemon"),
    ).toBe("enabled");
  });

  /** One platform's probe run for real, so the canned answers above are answers to a real command. */
  it.skipIf(process.platform !== "darwin")("reads the real launchctl domain on macOS", async () => {
    const stateDir = stateDirectory();
    writeMarker(stateDir);

    const preflight = await preflightWithoutWriting({ stateDir, port: 0 });

    expect(preflight.supervisor.kind).toBe("launchd");
    expect(preflight.disabled.applicable).toBe(true);
    // Whether this machine has a GUI domain is a property of how the test is being run — a
    // developer's terminal has one, a headless runner may not — so what is asserted is that the
    // two readings agree, which is the invariant the shared query exists for.
    expect(preflight.disabled.probed).toBe(preflight.supervisor.usable);
    expect(runProbe({ program: "launchctl", argv: ["print-disabled", "gui/0"] }).started).toBe(
      true,
    );
  });
});

describe("the program", () => {
  it("accepts a staged runtime and refuses 3 when its interpreter cannot be executed", async () => {
    const stateDir = stateDirectory();
    writeMarker(stateDir);
    const payload = buildFixturePayload({
      outDir: join(scratchDirectory(), "payload"),
      version: "1.2.3",
      marker: "preflight",
      runnable: false,
    });
    const staged = stageRuntime({ payloadDir: payload.outDir, stateDir });
    const program = resolveProgram({ stateDir, runtimeDir: staged.path });

    const ok = await preflightWithoutWriting({
      stateDir,
      port: 0,
      platform: "darwin",
      program,
      run: runnerAnswering({}).run,
    });
    expect(ok.program).toMatchObject({ executableOk: true, entryOk: true, refusal: null });

    chmodSync(program.executable, 0o644);
    const broken = await preflightInstall({
      stateDir,
      port: 0,
      platform: "darwin",
      program,
      run: runnerAnswering({}).run,
    });

    expect(broken.program.executableOk).toBe(false);
    expect(broken.program.refusal).toMatchObject({
      code: "program-not-executable",
      exitCode: PRECONDITION_UNMET_EXIT_CODE,
    });
    expect(broken.program.refusal?.message).toContain(program.executable);
  });

  it("answers about the program only when one has been resolved", async () => {
    const stateDir = stateDirectory();
    writeMarker(stateDir);

    const preflight = await preflightWithoutWriting({
      stateDir,
      port: 0,
      platform: "darwin",
      run: runnerAnswering({}).run,
    });

    expect(preflight.program).toMatchObject({ executable: null, entry: null, refusal: null });
  });
});

describe("the port", () => {
  it("refuses 7 and names the holding pid in words", async () => {
    const stateDir = stateDirectory();
    writeMarker(stateDir);
    const port = await holdAPort();

    const preflight = await preflightWithoutWriting({
      stateDir,
      port,
      platform: process.platform,
      run: runProbe,
    });

    expect(preflight.port).toMatchObject({ port, held: true });
    expect(preflight.port.refusal).toMatchObject({
      code: "port-held",
      exitCode: INSTALL_CONFLICT_EXIT_CODE,
    });
    expect(preflight.port.refusal?.message).toContain(`port ${port}`);
    // The pid is this process, because this process is what is holding it — or, on a machine with
    // neither `lsof` nor `ss`, the message says that instead of implying nobody holds it.
    if (preflight.port.holder !== null) {
      expect(preflight.port.holder).toBe(process.pid);
      expect(preflight.port.refusal?.message).toContain(`pid ${process.pid}`);
    } else {
      expect(preflight.port.holderDetail).toContain("could not name");
    }
  });

  it("passes a free port, and treats 0 as the ephemeral request it is", async () => {
    const stateDir = stateDirectory();
    writeMarker(stateDir);
    const free = await freePort();

    for (const port of [free, 0]) {
      const preflight = await preflightWithoutWriting({
        stateDir,
        port,
        platform: "darwin",
        run: runnerAnswering({}).run,
      });
      expect(preflight.port).toMatchObject({ held: false, refusal: null });
    }
  });
});

describe("lingering, the token, and what the whole thing touched", () => {
  /**
   * The round-3 correction, asserted directly: this phase **reads** the linger marker and never
   * enables it. `loginctl` is not run, and `enable-linger` appears in no argument vector — which is
   * what makes the writing phase's `linger_enabled_by_us` meaningful at all.
   */
  it("reads the linger marker and never attempts to enable lingering", async () => {
    const stateDir = stateDirectory();
    writeMarker(stateDir);
    const lingerDir = join(scratchDirectory(), "linger");
    mkdirSync(lingerDir, { recursive: true });
    const booted = join(scratchDirectory(), "run-systemd-system");
    mkdirSync(booted, { recursive: true });
    const { run, asked } = runnerAnswering({ stdout: "running\n" });

    const absent = await preflightWithoutWriting({
      stateDir,
      port: 0,
      platform: "linux",
      run,
      environment: {
        home: scratchDirectory(),
        account: "tester",
        lingerDir,
        systemdBooted: booted,
      },
    });
    expect(absent.linger).toMatchObject({
      applicable: true,
      enabled: false,
      marker: join(lingerDir, "tester"),
    });

    writeFileSync(join(lingerDir, "tester"), "");
    const enabled = await preflightWithoutWriting({
      stateDir,
      port: 0,
      platform: "linux",
      run,
      environment: {
        home: scratchDirectory(),
        account: "tester",
        lingerDir,
        systemdBooted: booted,
      },
    });
    expect(enabled.linger.enabled).toBe(true);
    // Still there afterwards, and still the only thing lingering-related that ran.
    expect(existsSync(join(lingerDir, "tester"))).toBe(true);
    expect(asked.map((command) => command.program)).not.toContain("loginctl");
    expect(asked.flatMap((command) => command.argv)).not.toContain("enable-linger");
  });

  it("reports the token file rather than minting one", async () => {
    const stateDir = stateDirectory();
    writeMarker(stateDir);

    const before = await preflightWithoutWriting({
      stateDir,
      port: 0,
      platform: "darwin",
      run: runnerAnswering({}).run,
    });
    expect(before.token).toMatchObject({ present: false, path: join(stateDir, "token") });
    expect(existsSync(before.token.path)).toBe(false);

    writeFileSync(before.token.path, "a-token\n", { mode: 0o600 });
    const after = await preflightWithoutWriting({
      stateDir,
      port: 0,
      platform: "darwin",
      run: runnerAnswering({}).run,
    });
    expect(after.token).toMatchObject({ present: true, readable: true });
  });

  /**
   * The obligation, on the worst case rather than the best: every refusal at once, on a state
   * directory holding a staged runtime and a token, with the supervisor's own artefact location and
   * the linger marker in the hashed set. Nothing under any of them moves.
   */
  it("writes nothing anywhere it could write, even when every probe refuses", async () => {
    const stateDir = stateDirectory();
    const home = scratchDirectory();
    const payload = buildFixturePayload({
      outDir: join(scratchDirectory(), "payload"),
      version: "2.0.0",
      marker: "untouched",
      runnable: false,
    });
    const staged = stageRuntime({ payloadDir: payload.outDir, stateDir });
    const program = resolveProgram({ stateDir, runtimeDir: staged.path });
    chmodSync(program.executable, 0o644);
    writeFileSync(join(stateDir, "token"), "a-token\n", { mode: 0o600 });
    const port = await holdAPort();
    const lingerDir = join(scratchDirectory(), "linger");
    mkdirSync(lingerDir, { recursive: true });

    const request: PreflightRequest = {
      stateDir,
      port,
      program,
      platform: "linux",
      run: runProbe,
      environment: {
        home,
        account: "tester",
        lingerDir,
        systemdBooted: join(scratchDirectory(), "absent"),
      },
    };

    const locations = [stateDir, join(home, ".config"), lingerDir, launcherPath(stateDir, "linux")];
    const before = hashLocations(locations);
    const preflight = await preflightInstall(request);
    expect(hashLocations(locations)).toEqual(before);

    expect(preflight.ok).toBe(false);
    expect(preflight.refusals.map((refusal) => refusal.code)).toEqual([
      "setup-absent",
      "no-user-manager",
      "program-not-executable",
      "port-held",
    ]);
    // The exit an install takes is the first one, and the whole list is what `status` can report.
    expect(preflight.refusals[0]?.exitCode).toBe(PRECONDITION_UNMET_EXIT_CODE);
    expect(preflightWriteLocations(preflight)).toEqual([
      stateDir,
      join(home, ".config", "systemd", "user", "xplainer.service"),
      join(home, ".config", "systemd", "user"),
      join(lingerDir, "tester"),
    ]);
  });

  /**
   * Measured inside `infra/e2e/Dockerfile.systemd` on 2026-09-08: with lingering off and no login
   * session, `systemctl --user is-system-running` answers "Failed to connect to bus: No such file
   * or directory", because there is no per-user manager at all. Round 1 of this file answered that
   * with "an always-running daemon cannot be arranged on this machine" and `connect --spawn`, which
   * is wrong twice: systemd *is* here, and one administrator command fixes it for good.
   */
  it("names lingering, not --spawn, when systemd is booted and the manager is absent with it", async () => {
    const stateDir = stateDirectory();
    writeMarker(stateDir);
    const home = scratchDirectory();
    const lingerDir = scratchDirectory();

    const preflight = await preflightWithoutWriting({
      stateDir,
      port: 0,
      platform: "linux",
      run: runnerAnswering({ status: 1, stderr: "Failed to connect to bus: No such file\n" }).run,
      environment: { home, account: "tester", lingerDir, systemdBooted: home },
    });

    expect(preflight.refusals[0]).toMatchObject({
      code: "no-user-manager",
      exitCode: NO_SUPERVISOR_EXIT_CODE,
    });
    expect(preflight.refusals[0]?.message).toContain("sudo loginctl enable-linger tester");
    expect(preflight.refusals[0]?.message).toContain(join(lingerDir, "tester"));
    // `--spawn` is still offered, and it is no longer the first thing said.
    const message = preflight.refusals[0]?.message ?? "";
    expect(message.indexOf("enable-linger")).toBeLessThan(message.indexOf(SPAWN_REMEDIATION));
  });

  /** And with the marker already there, the absent manager is what it has always been. */
  it("keeps the --spawn remediation when the manager is absent and lingering is not the reason", async () => {
    const stateDir = stateDirectory();
    writeMarker(stateDir);
    const home = scratchDirectory();
    const lingerDir = scratchDirectory();
    writeFileSync(join(lingerDir, "tester"), "");

    const preflight = await preflightWithoutWriting({
      stateDir,
      port: 0,
      platform: "linux",
      run: runnerAnswering({ status: 1, stderr: "Failed to connect to bus: No such file\n" }).run,
      environment: { home, account: "tester", lingerDir, systemdBooted: home },
    });

    expect(preflight.refusals[0]?.message).not.toContain("enable-linger");
    expect(preflight.refusals[0]?.message).toContain(SPAWN_REMEDIATION);
  });

  it("runs no command at all on a platform with no supervisor to ask about", async () => {
    const stateDir = stateDirectory();
    writeMarker(stateDir);

    const preflight = await preflightInstall({
      stateDir,
      port: 0,
      platform: "freebsd",
      run: noCommands,
    });

    expect(preflight.supervisor).toMatchObject({ kind: null, present: false, usable: false });
    expect(preflight.refusals[0]?.exitCode).toBe(NO_SUPERVISOR_EXIT_CODE);
    expect(preflight.refusals[0]?.message).toContain(SPAWN_REMEDIATION);
  });
});

/** Bind an ephemeral port and keep it for the test's lifetime. */
function holdAPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = createServer();
    listeners.push(listener);
    listener.once("error", reject);
    listener.listen({ port: 0, host: "127.0.0.1" }, () => {
      const address = listener.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the listener reported no port"));
        return;
      }
      resolve(address.port);
    });
  });
}

/** A port nothing is on: bound, read, and released before it is handed back. */
async function freePort(): Promise<number> {
  const port = await holdAPort();
  const listener = listeners.pop();
  await new Promise<void>((resolve) => {
    listener?.close(() => {
      resolve();
    });
  });
  return port;
}
