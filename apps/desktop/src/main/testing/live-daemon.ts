/**
 * A real daemon, a real payload and a real supervisor answer — the arrangements these tests assert
 * against.
 *
 * **Nothing here is a stand-in for the thing under test.** The daemon is `xplainer serve`, started
 * through a payload laid out exactly as the packaged application's is, and every state the seven
 * outcomes name is arranged by putting this machine into that state: a token file whose value the
 * running daemon no longer accepts, a second process holding the recorded port, a supervisor that
 * answers "disabled" for our own label. The one thing that is not carried is ~200 MB of browser and
 * speech bytes, which no assertion here is about: `recordToolchain` runs **the CLI's own fixture
 * writer**, through the CLI's own source hook, so the marker and the workspace manifest are the
 * documents `xplainer setup` writes and are read back by the same code that judges a real one.
 *
 * The payload's `bin/node` is this process's own interpreter and its `bin.js` is a one-line shim
 * that imports the CLI's built entry, so `spawn` reaches a real CLI through the real layout — the
 * production call path D10 defines, not a stand-in for it.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { type CliProgram, resolveCliProgram, type SpawnedDaemon, spawnDaemon } from "../discovery";
import { PACKAGED_PAYLOAD_DIRECTORY, PAYLOAD_CLI_ENTRY, payloadInterpreterEntry } from "../paths";
import { currentHost } from "../spawn";

/** `apps/cli`, from this file rather than from a working directory a runner may not share. */
const CLI_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "cli");

/** The built CLI the payload shim runs. `turbo` builds it before this package's tests. */
const CLI_ENTRY = join(CLI_ROOT, "dist", "bin.js");

/** The CLI's own `.ts` source hook, which is how its fixture writers are reached. */
const CLI_SOURCE_HOOK = join(CLI_ROOT, "src", "daemon", "testing", "ts-source-hook.ts");

/** The CLI's own toolchain fixture writer — the marker and the workspace manifest `setup` writes. */
const CLI_TOOLCHAIN_FIXTURE = join(CLI_ROOT, "src", "setup", "testing", "toolchain.ts");

/** Every temporary tree these tests made, removed by {@link cleanUpFixtures}. */
const roots: string[] = [];

/** Every daemon these tests started, stopped by {@link cleanUpFixtures} whatever happened. */
const daemons: SpawnedDaemon[] = [];

/**
 * A short temporary directory.
 *
 * Short deliberately: the daemon binds a unix socket inside its state directory and the path limit
 * is 103 bytes on macOS, which a nested temporary directory exceeds on its own.
 */
export function temporaryDirectory(prefix = "xd-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** What {@link payloadResources} may be told about the payload it lays out. */
export type PayloadResourcesOptions = {
  /**
   * The source of the payload's CLI entry. Defaults to a shim that imports the real built CLI.
   *
   * `controls.test.ts` passes a recorder instead: the two one-click controls are asserted by what
   * program ran and with which arguments, and running the real `connect` would write an agent
   * configuration on the machine under test.
   */
  entry?: string | undefined;
};

/**
 * Build a `Resources` directory holding a payload whose CLI entry is the real one.
 *
 * The interpreter is linked where the platform allows it and copied where it does not, for the
 * reason `spawn.test.ts` gives: Windows grants `CreateSymbolicLink` only to a developer-mode or
 * elevated process, and a fixture that skipped itself there would leave the branch this app spawns
 * through unproven on the platform whose interpreter has a different name.
 */
export function payloadResources(options: PayloadResourcesOptions = {}): string {
  const root = temporaryDirectory("xd-payload-");
  const resources = join(root, "Resources");
  const payload = join(resources, PACKAGED_PAYLOAD_DIRECTORY);
  const host = currentHost();

  const interpreter = join(payload, ...payloadInterpreterEntry(host.platform).split("/"));
  mkdirSync(dirname(interpreter), { recursive: true });
  linkOrCopy(process.execPath, interpreter);

  const entry = join(payload, ...PAYLOAD_CLI_ENTRY.split("/"));
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(
    entry,
    options.entry ?? `import ${JSON.stringify(pathToFileURL(CLI_ENTRY).href)};\n`,
  );

  writeFileSync(
    join(payload, "runtime.manifest.json"),
    JSON.stringify({
      kind: "runtime",
      manifest_version: 1,
      created_at: new Date().toISOString(),
      platform: host.platform,
      arch: host.arch,
      node_version: process.version,
      launch: {
        interpreter: payloadInterpreterEntry(host.platform),
        entry: PAYLOAD_CLI_ENTRY,
      },
    }),
  );
  return resources;
}

/** The program a test's app would resolve: the payload above, or a launcher beside a state dir. */
export function programFor(resources: string, stateDir?: string): CliProgram {
  return resolveCliProgram({ resourcesPath: resources, stateDir: stateDir ?? null });
}

/** A daemon this suite started, and what a caller needs to talk to it. */
export type LiveDaemon = {
  stateDir: string;
  port: number;
  url: string;
  tokenFile: string;
  daemon: SpawnedDaemon;
  /** The bearer token the daemon read at start, from the file it recorded. */
  token(): string;
};

/**
 * Start a real `xplainer serve` on an ephemeral port, and wait for its own ready line.
 *
 * `--port 0` rather than the recorded one, so a suite never binds the port a developer's own daemon
 * is on and two test files can run at the same time.
 */
export async function startDaemon(options: {
  resources: string;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<LiveDaemon> {
  const result = await spawnDaemon({
    program: programFor(options.resources),
    args: ["--port", "0"],
    env: { ...process.env, ...options.env, XPLAINER_STATE_DIR: options.stateDir },
  });
  if (result.kind !== "spawned") {
    throw new Error(`the fixture daemon did not start: ${result.message}`);
  }
  daemons.push(result.daemon);
  const tokenFile = join(options.stateDir, "token");
  return {
    stateDir: options.stateDir,
    port: result.daemon.port,
    url: `http://127.0.0.1:${String(result.daemon.port)}`,
    tokenFile,
    daemon: result.daemon,
    token: () => readFileSync(tokenFile, "utf8").trim(),
  };
}

/**
 * Write the toolchain marker and the workspace manifest a ready daemon needs, using the CLI's own
 * writer.
 *
 * Run as a child rather than imported, because it is `.ts` in another package: the CLI's own source
 * hook is what its tests use to run its sources, and this is the same call.
 */
export function recordToolchain(stateDir: string, workspaceRoot: string): void {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(CLI_SOURCE_HOOK).href,
      "--input-type=module",
      "--eval",
      `import { recordTestToolchain } from ${JSON.stringify(pathToFileURL(CLI_TOOLCHAIN_FIXTURE).href)};
       recordTestToolchain({ stateDir: process.env.FIXTURE_STATE_DIR, workspaceRoot: process.env.FIXTURE_WORKSPACE });`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, FIXTURE_STATE_DIR: stateDir, FIXTURE_WORKSPACE: workspaceRoot },
    },
  );
  if (result.status !== 0) {
    throw new Error(`the CLI's toolchain fixture writer failed: ${result.stderr}`);
  }
}

/** Read `daemon.json`, apply a change, and write it back — the way a second writer would. */
export function amendDaemonState(stateDir: string, change: Record<string, unknown>): void {
  const file = join(stateDir, "daemon.json");
  const state = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(file, `${JSON.stringify({ ...state, ...change }, null, 2)}\n`);
}

/** The word the CLI's Windows switch query has to read back for this arrangement to mean anything. */
export const SWITCHED_OFF_STATE = "Disabled";

/** The `ScheduledTasks` module a Windows arrangement puts in front of the system one. */
export type ScheduledTasksShim = {
  /** `ScheduledTasks.psd1` — the manifest module auto-loading reads to find the command names. */
  manifest: string;
  /** `ScheduledTasks.psm1` — the two functions themselves. */
  module: string;
};

/**
 * The stand-in `ScheduledTasks` module, as text, so the Windows branch is readable from any machine.
 *
 * **Both functions declare `-TaskName`, and that is the correction of 2026-09-08.** They used to
 * take nothing but `[Parameter(ValueFromRemainingArguments = $true)] $Rest`, which captures
 * *positional* leftovers and **not** an unknown named parameter: PowerShell's binder answers
 * `-TaskName 'x'` on such a function with a terminating "A parameter cannot be found that matches
 * parameter name 'TaskName'". The CLI's query is
 * `(Get-ScheduledTask -TaskName '<identity>').State`, so the shim threw, the query wrote nothing to
 * stdout, exited non-zero, and `readSwitch` — which reads `unregistered` out of "cannot find", and
 * `unknown` out of anything else — answered `unknown`. That is exactly what `windows-latest`
 * reported on 2026-09-08: `expected 'unknown' to be 'off'`, blamed on the app, produced by the
 * arrangement.
 */
export function scheduledTasksShim(state: string = SWITCHED_OFF_STATE): ScheduledTasksShim {
  return {
    manifest: [
      "@{",
      "  ModuleVersion = '99.0.0'",
      "  GUID = '4a2f6f1a-9d4e-4f0e-9a3f-2f5c9f6c8d21'",
      "  RootModule = 'ScheduledTasks.psm1'",
      "  FunctionsToExport = @('Get-ScheduledTask', 'Get-ScheduledTaskInfo')",
      "}",
      "",
    ].join("\r\n"),
    module: [
      "function Get-ScheduledTask {",
      // The real cmdlet's own two named parameters, so the binder has somewhere to put them, plus
      // the remaining-arguments catch-all for anything a future query adds positionally.
      "  param(",
      "    [string] $TaskName,",
      "    [string] $TaskPath,",
      "    [Parameter(ValueFromRemainingArguments = $true)] $Rest",
      "  )",
      `  [pscustomobject]@{ TaskName = $TaskName; State = '${state}' }`,
      "}",
      "function Get-ScheduledTaskInfo {",
      "  param(",
      "    [string] $TaskName,",
      "    [string] $TaskPath,",
      "    [Parameter(ValueFromRemainingArguments = $true)] $Rest",
      "  )",
      "  [pscustomobject]@{ TaskName = $TaskName; LastTaskResult = 0 }",
      "}",
      "Export-ModuleMember -Function Get-ScheduledTask, Get-ScheduledTaskInfo",
      "",
    ].join("\r\n"),
  };
}

/**
 * A supervisor on this machine that answers "switched off" for one label.
 *
 * Every platform is asked a different documented question, and each is arranged the way that
 * platform allows a query to be answered by something other than the real service manager:
 *
 * - **macOS** and **Linux** are asked by name — `launchctl`, `systemctl` — so a program of that
 *   name earlier on `PATH` is what answers. That is the same recording-program-on-a-temporary-path
 *   pattern the CLI's own `connect` tests use for vendor CLIs.
 * - **Windows** is asked through PowerShell, which resolves `Get-ScheduledTask` by auto-loading a
 *   module named `ScheduledTasks` off `PSModulePath` — so a module of that name is written and
 *   `PSModulePath` is set to **that directory and nothing else**, which is the arrangement
 *   `about_PSModulePath` documents as supported: "If `PSModulePath` contains `$PSHOME` modules
 *   path: **AllUsers** modules path is inserted before `$PSHOME` modules path — else: Just use
 *   `PSModulePath` as defined since the user deliberately removed the `$PSHOME` location". Removing
 *   it is what makes the answer decidable rather than a question about search order: the real
 *   `ScheduledTasks` module lives under `$PSHOME` and is not discoverable at all, so the only
 *   `Get-ScheduledTask` in that session is this one. Windows PowerShell's own built-in commands are
 *   loaded by the shell configuration rather than off this path, and the query uses none of them.
 *   `powershell.exe` itself is the real one.
 *
 * **The Windows arrangement checks itself before it is handed out**, because two different failures
 * of it — a shim the binder refuses, and an auto-load that reached the system module instead —
 * both surface as the CLI answering `unknown`, which reads as a defect in the app. The check runs
 * the query the CLI runs; a wrong answer throws here, naming the arrangement.
 *
 * Nothing on the machine is registered, enabled or disabled: `launchctl disable` writes a record
 * into a per-user store that has no removal verb, and a test may not leave that behind.
 */
export function switchedOffEnvironment(identity: string): NodeJS.ProcessEnv {
  const root = temporaryDirectory("xd-supervisor-");
  if (process.platform === "win32") {
    const module = join(root, "modules", "ScheduledTasks");
    mkdirSync(module, { recursive: true });
    const shim = scheduledTasksShim();
    writeFileSync(join(module, "ScheduledTasks.psd1"), shim.manifest);
    writeFileSync(join(module, "ScheduledTasks.psm1"), shim.module);
    const environment = { PSModulePath: join(root, "modules") };
    assertScheduledTasksShimAnswers(identity, environment);
    return environment;
  }

  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const program = process.platform === "darwin" ? "launchctl" : "systemctl";
  const script =
    process.platform === "darwin"
      ? [
          "#!/bin/sh",
          'if [ "$1" = "print-disabled" ]; then',
          '  echo "disabled services = {"',
          `  echo '\t"${identity}" => disabled'`,
          '  echo "}"',
          "  exit 0",
          "fi",
          "exit 0",
          "",
        ].join("\n")
      : [
          "#!/bin/sh",
          'for argument in "$@"; do',
          '  if [ "$argument" = "is-enabled" ]; then',
          "    echo disabled",
          "    exit 1",
          "  fi",
          "done",
          "exit 0",
          "",
        ].join("\n");
  writeFileSync(join(bin, program), script, { mode: 0o755 });
  return { PATH: `${bin}:${process.env.PATH ?? ""}` };
}

/**
 * Run the query the CLI will run, and refuse to hand out an arrangement that does not answer it.
 *
 * The command is `install/lifecycle.ts`'s `disabledQuery()` for `task-scheduler`, spelled out here
 * rather than imported: `src/install/` is the CLI's internal machinery and this package consumes
 * that CLI as a program, not as a module. If the two ever drift, this check fails on the platform
 * that runs it — which is the platform the query exists for.
 */
function assertScheduledTasksShimAnswers(identity: string, environment: NodeJS.ProcessEnv): void {
  const answer = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `(Get-ScheduledTask -TaskName '${identity.replaceAll("'", "''")}').State`,
    ],
    { encoding: "utf8", env: { ...process.env, ...environment }, windowsHide: true },
  );
  const said = (answer.stdout ?? "").trim();
  if (said === SWITCHED_OFF_STATE) {
    return;
  }
  throw new Error(
    `the switched-off arrangement does not answer: \`(Get-ScheduledTask -TaskName '${identity}')` +
      `.State\` said ${JSON.stringify(said)} rather than ${JSON.stringify(SWITCHED_OFF_STATE)}` +
      `${answer.error === undefined ? "" : ` (${answer.error.message})`}` +
      `${(answer.stderr ?? "").trim() === "" ? "" : `, and wrote: ${(answer.stderr ?? "").trim()}`}` +
      ". Either PowerShell refused the shim module's parameters or it auto-loaded the system " +
      "ScheduledTasks module instead of the one on PSModulePath; both would make the CLI answer " +
      "`unknown`, which is a fact about this arrangement rather than about the app under test.",
  );
}

/**
 * Hold a TCP port from another process, answering nothing.
 *
 * Another process because the outcome under test is "the port is held and `status` names a
 * **foreign** pid": a listener inside this test's own process would be named too, but arranging it
 * out of process is what a user's stray program actually looks like. The connection is accepted and
 * destroyed rather than left open, so the daemon's probe fails at once instead of waiting out its
 * own timeout.
 */
export function holdPort(port: number): { pid: number; release: () => Promise<void> } {
  const root = temporaryDirectory("xd-hold-");
  const file = join(root, "hold.mjs");
  writeFileSync(
    file,
    [
      'import { createServer } from "node:net";',
      "const server = createServer((socket) => socket.destroy());",
      'server.listen(Number(process.env.HOLD_PORT), "127.0.0.1");',
      "",
    ].join("\n"),
  );
  const child = spawn(process.execPath, [file], {
    env: { ...process.env, HOLD_PORT: String(port) },
    stdio: ["ignore", "ignore", "ignore"],
  });
  return {
    pid: child.pid ?? 0,
    release: () =>
      new Promise<void>((resolve) => {
        child.on("close", () => {
          resolve();
        });
        child.kill("SIGKILL");
      }),
  };
}

/** Stop every daemon and remove every tree these fixtures made. */
export async function cleanUpFixtures(): Promise<void> {
  for (const daemon of daemons.splice(0)) {
    await daemon.stop(5_000).catch(() => undefined);
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A link where the platform allows one, and a copy where it does not. */
function linkOrCopy(from: string, to: string): void {
  try {
    symlinkSync(from, to);
    return;
  } catch {
    // Windows without developer mode, or a filesystem with no symlinks.
  }
  try {
    linkSync(from, to);
    return;
  } catch {
    // A different volume; the copy below always works.
  }
  copyFileSync(from, to);
}
