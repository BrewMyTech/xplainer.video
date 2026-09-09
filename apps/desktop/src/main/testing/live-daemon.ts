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

import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
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
import { delimiter, dirname, join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { type CliProgram, resolveCliProgram, type SpawnedDaemon, spawnDaemon } from "../discovery";
import {
  PACKAGED_PAYLOAD_DIRECTORY,
  PAYLOAD_CLI_ENTRY,
  payloadInterpreterEntry,
  RUNTIME_MANIFEST_FILE,
} from "../paths";
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
    join(payload, RUNTIME_MANIFEST_FILE),
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

/** The two PowerShell scripts a Windows arrangement puts in front of the real cmdlets. */
export type ScheduledTasksShim = {
  /** `Get-ScheduledTask.ps1` — the switch query's own command, answering for any named task. */
  getScheduledTask: string;
  /** `Get-ScheduledTaskInfo.ps1` — the health query's, so one arrangement answers both. */
  getScheduledTaskInfo: string;
};

/** What each script in {@link ScheduledTasksShim} is called on disk, in the same order. */
export const SCHEDULED_TASKS_SHIM_FILES: Readonly<Record<keyof ScheduledTasksShim, string>> = {
  getScheduledTask: "Get-ScheduledTask.ps1",
  getScheduledTaskInfo: "Get-ScheduledTaskInfo.ps1",
};

/**
 * The stand-in `Get-ScheduledTask`, as text, so the Windows branch is readable from any machine.
 *
 * **These are scripts on `PATH` rather than a module on `PSModulePath`, and the reason is
 * measured.** The arrangement here used to be a `ScheduledTasks` module written to a directory that
 * `PSModulePath` was then set to — *and to nothing else*, on the strength of `about_PSModulePath`'s
 * rule that a value which does not contain the `$PSHOME` modules path is "used as defined since the
 * user deliberately removed the `$PSHOME` location". Measured on 2026-09-09 in
 * `mcr.microsoft.com/powershell:7.4-ubuntu-22.04`, that is not what the engine does: started with
 * `PSModulePath=/exp/m`, PowerShell reported
 * `$env:PSModulePath` as `…/.local/share/powershell/Modules:…/usr/local/share/powershell/Modules:`
 * `/opt/microsoft/powershell/7/Modules:/exp/m` — it puts its own module paths **in front of** the
 * value it was given, so the system module is the one auto-loading reaches first and a stand-in
 * cannot win that race by being on the path at all. That is exactly what `windows-latest` reported
 * for `desktop.yml` run 34304160979: the real cmdlet ran and answered
 * "No MSFT_ScheduledTask objects found with property 'TaskName' equal to
 * '\\xplainer\\runneradmin-daemon'".
 *
 * **A script on `PATH` does not race auto-loading; it pre-empts it.** PowerShell's command searcher
 * resolves a name against aliases, functions, cmdlets already in the session and then files on
 * `PATH`, and module auto-discovery is attempted **only when that search finds nothing**. Measured
 * in the same container on 2026-09-09, with `/exp/bin/Get-ScheduledTask.ps1` on `PATH` and a
 * competing module still on `PSModulePath`: `Get-Command Get-ScheduledTask -All` answers
 * `ExternalScript:/exp/bin/Get-ScheduledTask.ps1` and nothing else, and the CLI's own query —
 * `-NoProfile -NonInteractive -Command "(Get-ScheduledTask -TaskName '\\xplainer\\…').State"` —
 * prints `Disabled` and exits `0`.
 *
 * It also makes all three platforms one arrangement rather than two: every supervisor is now
 * answered by a file of the queried name in a directory prepended to `PATH`.
 */
export function scheduledTasksShim(state: string = SWITCHED_OFF_STATE): ScheduledTasksShim {
  // The real cmdlets' own two named parameters, so the query's `-TaskName` has somewhere to bind,
  // plus the remaining-arguments catch-all for anything a future query adds positionally.
  const parameters = [
    "param(",
    "  [string] $TaskName,",
    "  [string] $TaskPath,",
    "  [Parameter(ValueFromRemainingArguments = $true)] $Rest",
    ")",
  ];
  return {
    getScheduledTask: [
      ...parameters,
      `[pscustomobject]@{ TaskName = $TaskName; State = '${state}' }`,
      "",
    ].join("\r\n"),
    getScheduledTaskInfo: [
      ...parameters,
      "[pscustomobject]@{ TaskName = $TaskName; LastTaskResult = 0 }",
      "",
    ].join("\r\n"),
  };
}

/**
 * The spelling of one environment variable **this process actually inherited**.
 *
 * Windows environment variable *names* are case-insensitive but an environment *block* is a list of
 * strings, and `{ ...process.env, PATH: … }` beside an inherited `Path` puts both spellings into
 * that list — which of the two a grandchild then reads is not defined anywhere. Writing the
 * override under the spelling that is already there keeps the block single-valued. On POSIX,
 * where the inherited name is `PATH` and nothing else can be, this returns the argument.
 */
function inheritedVariableName(name: string): string {
  const wanted = name.toUpperCase();
  return Object.keys(process.env).find((key) => key.toUpperCase() === wanted) ?? name;
}

/**
 * A supervisor on this machine that answers "switched off" for one label.
 *
 * One arrangement on all three platforms: a file named for the command the CLI's switch query runs,
 * in a directory prepended to `PATH`, so the program of that name earlier on the path is what
 * answers. That is the same recording-program-on-a-temporary-path pattern the CLI's own `connect`
 * tests use for vendor CLIs.
 *
 * - **macOS** and **Linux** are asked by name — `launchctl`, `systemctl` — so the file is a shell
 *   script of that name.
 * - **Windows** is asked through PowerShell, and the name in the query is a command rather than a
 *   program: `Get-ScheduledTask`. A `Get-ScheduledTask.ps1` on `PATH` is what PowerShell's command
 *   searcher resolves it to, ahead of the module auto-loading that would otherwise reach the real
 *   cmdlet — see {@link scheduledTasksShim} for the measurement behind that, and for why setting
 *   `PSModulePath` could not do it. `powershell.exe` itself is the real one.
 *
 * **The Windows arrangement checks itself before it is handed out**, because two different failures
 * of it — a shim the binder refuses, and a search that reached the real cmdlet instead — both
 * surface as the CLI answering `unknown`, which reads as a defect in the app. The check runs the
 * query the CLI runs; a wrong answer throws here, naming the arrangement and what
 * `Get-ScheduledTask` actually resolved to.
 *
 * Nothing on the machine is registered, enabled or disabled: `launchctl disable` writes a record
 * into a per-user store that has no removal verb, and a test may not leave that behind.
 */
export function switchedOffEnvironment(identity: string): NodeJS.ProcessEnv {
  const bin = join(temporaryDirectory("xd-supervisor-"), "bin");
  mkdirSync(bin, { recursive: true });

  if (process.platform === "win32") {
    const shim = scheduledTasksShim();
    for (const command of ["getScheduledTask", "getScheduledTaskInfo"] as const) {
      writeFileSync(join(bin, SCHEDULED_TASKS_SHIM_FILES[command]), shim[command]);
    }
    const environment = { [inheritedVariableName("PATH")]: prependedPath(bin) };
    assertScheduledTasksShimAnswers(identity, environment);
    return environment;
  }

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
  return { [inheritedVariableName("PATH")]: prependedPath(bin) };
}

/** This machine's `PATH` with one directory in front of it, in this platform's own spelling. */
function prependedPath(bin: string): string {
  const inherited = process.env[inheritedVariableName("PATH")] ?? "";
  return inherited === "" ? bin : `${bin}${delimiter}${inherited}`;
}

/** One PowerShell command, run the way the CLI runs its own. */
function askPowerShell(script: string, environment: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", env: { ...process.env, ...environment }, windowsHide: true },
  );
}

/**
 * Run the query the CLI will run, and refuse to hand out an arrangement that does not answer it.
 *
 * The command is `install/lifecycle.ts`'s `disabledQuery()` for `task-scheduler`, spelled out here
 * rather than imported: `src/install/` is the CLI's internal machinery and this package consumes
 * that CLI as a program, not as a module. If the two ever drift, this check fails on the platform
 * that runs it — which is the platform the query exists for.
 *
 * A failure names what `Get-ScheduledTask` resolved to, which is the one fact that separates the
 * two ways this can go wrong: `ExternalScript:` and a wrong answer is the shim's own doing, and
 * anything else is the search having reached past it.
 */
function assertScheduledTasksShimAnswers(identity: string, environment: NodeJS.ProcessEnv): void {
  const quoted = `'${identity.replaceAll("'", "''")}'`;
  const answer = askPowerShell(`(Get-ScheduledTask -TaskName ${quoted}).State`, environment);
  const said = (answer.stdout ?? "").trim();
  if (said === SWITCHED_OFF_STATE) {
    return;
  }
  const resolved = askPowerShell(
    "(Get-Command Get-ScheduledTask -All -ErrorAction SilentlyContinue | " +
      "ForEach-Object { $_.CommandType.ToString() + ':' + $_.Source }) -join '|'",
    environment,
  );
  throw new Error(
    `the switched-off arrangement does not answer: \`(Get-ScheduledTask -TaskName ${quoted})` +
      `.State\` said ${JSON.stringify(said)} rather than ${JSON.stringify(SWITCHED_OFF_STATE)}` +
      `${answer.error === undefined ? "" : ` (${answer.error.message})`}` +
      `${(answer.stderr ?? "").trim() === "" ? "" : `, and wrote: ${(answer.stderr ?? "").trim()}`}` +
      `. \`Get-ScheduledTask\` there resolves to ${JSON.stringify((resolved.stdout ?? "").trim())}` +
      ", which says which of the two failures this is: an `ExternalScript` that answered wrongly " +
      "is the shim's own doing, and anything else is PowerShell having searched past it. Either " +
      "way the CLI would answer `unknown`, which is a fact about this arrangement rather than " +
      "about the app under test.",
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
