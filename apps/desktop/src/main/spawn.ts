/**
 * Running the packaged payload — the app's only way to reach the CLI before an install exists.
 *
 * **Decision D10.** `discovery.ts` and the one-click supervisor controls shell out to `status
 * --json`, `setup`, `daemon install` and `connect`. Routing those through the stable launcher would
 * make the app depend on a file that `daemon install` *creates*, so on a clean machine nothing
 * would run at all — and for the user with no supported supervisor, who never installs, nothing
 * ever would. The packaged app therefore spawns
 *
 * ```
 * <resources>/xplainer-runtime/bin/node <resources>/…/@xplainer/cli/dist/bin.js <argv…>
 * ```
 *
 * and switches to `<state>/bin/xplainer` only once `install` has written it, which `status --json`
 * reports. The consequence that matters is that the pre-install and post-install paths run the
 * *same* interpreter and the same entry: the case that is hardest to test is not also a second code
 * path.
 *
 * **`ELECTRON_RUN_AS_NODE` is not used, anywhere.** It existed so the app would not need a Node on
 * the user's machine; payload 1 carries one of its own (D3), so the Electron trick buys nothing and
 * costs the equivalence above.
 *
 * **The architecture is compared before the interpreter is spawned, by a process that is already
 * compatible.** `runtime build` copies the build host's `process.execPath`, so a payload only runs
 * on the architecture it was assembled on. Asking the mismatched interpreter to verify itself
 * yields exactly the `Bad CPU type` / `Exec format error` the manifest's `arch` field exists to
 * replace, so the Electron main process — which is already running on this machine's architecture —
 * reads the manifest and refuses **by name** first. `xplainer runtime verify` performs the same
 * comparison, and the runner check in `.github/workflows/desktop.yml` runs it from the runner's own
 * Node for the same reason.
 *
 * Everything that can be decided without touching the filesystem is a pure function over data
 * ({@link parseRuntimeManifest}, {@link checkPayloadHost}, {@link spawnPlan}); the two functions
 * that do touch it ({@link resolvePayloadCommand}, {@link runPayload}) take their host description
 * and their paths as arguments, so the Windows and wrong-architecture branches are assertable from
 * macOS.
 *
 * **The Windows launcher is a `.cmd`, and Node will not spawn one without an interpreter.**
 * {@link spawnPlan} is where that is handled, once, for every command this app runs.
 */

import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import type { Readable } from "node:stream";
import {
  PAYLOAD_CLI_ENTRY,
  packagedPayloadLayout,
  payloadInterpreterEntry,
  RUNTIME_MANIFEST_FILE,
} from "./paths";

/** Why a payload cannot be run. Every value is a condition, never a stack trace. */
export type PayloadRefusalReason =
  /** No `runtime.manifest.json` at the payload root — usually an unpackaged or dev build. */
  | "payload-absent"
  /** The manifest is there and is not the document it claims to be. */
  | "manifest-unreadable"
  /** Assembled for another operating system. */
  | "wrong-platform"
  /** Assembled for another CPU architecture. This is the one an interpreter cannot self-diagnose. */
  | "wrong-arch"
  /** The manifest's launch contract does not name the files this app knows how to spawn. */
  | "layout-mismatch"
  /** The manifest describes an interpreter that is not on disk. */
  | "interpreter-missing"
  /** The manifest describes a CLI entry that is not on disk. */
  | "entry-missing"
  /**
   * The interpreter is on disk and the operating system would not start it.
   *
   * The case this exists for is a packaging step that dropped the execute bit while copying the
   * payload into `Resources`: everything the checks above look at is intact, and `execve` still
   * answers `EACCES`.
   */
  | "spawn-failed";

/** A payload that will not be run, and the named condition that stopped it. */
export class PayloadRefusal extends Error {
  readonly reason: PayloadRefusalReason;

  constructor(reason: PayloadRefusalReason, message: string) {
    super(message);
    this.name = "PayloadRefusal";
    this.reason = reason;
  }
}

/** The launch contract as payload 1's manifest records it — payload-relative, `/`-separated. */
export type PayloadLaunchContract = {
  interpreter: string;
  entry: string;
};

/** The three manifest fields this app reads. The manifest carries more; none of it is needed here. */
export type PayloadManifestFacts = {
  /** `process.platform` of the build host. */
  platform: string;
  /** `process.arch` of the interpreter that was copied. */
  arch: string;
  launch: PayloadLaunchContract;
};

/** The machine asking to run the payload. Passed rather than read, so both branches are testable. */
export type PayloadHost = {
  platform: NodeJS.Platform;
  arch: string;
};

/** The command D10 spells out, resolved against a real payload on disk. */
export type PayloadCommand = {
  /** The payload directory the command runs out of. */
  root: string;
  /** The payload's own interpreter. Never this process's, and never a `PATH` lookup. */
  executable: string;
  /** The CLI entry, which is always `argv[0]` after the interpreter. */
  entry: string;
};

/** What one run of the payload produced. A non-zero `code` is data, not a failure to throw on. */
export type PayloadRun = {
  /** The process exit code, or `null` when a signal ended it. */
  code: number | null;
  /** The signal that ended it, or `null`. */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

/** The host this process is running on, as {@link PayloadHost}. */
export function currentHost(): PayloadHost {
  return { platform: process.platform, arch: process.arch };
}

/**
 * Validate a manifest's text into the facts this app reads.
 *
 * A manifest is data that arrives from disk and being named `.json` says nothing about its shape,
 * so every field is checked rather than cast — the same rule `readRuntimeManifest` applies on the
 * CLI side.
 */
export function parseRuntimeManifest(text: string, file: string): PayloadManifestFacts {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new PayloadRefusal(
      "manifest-unreadable",
      `${file} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new PayloadRefusal("manifest-unreadable", `${file} is not a JSON object.`);
  }
  const record = document as Record<string, unknown>;
  if (record.kind !== "runtime") {
    throw new PayloadRefusal(
      "manifest-unreadable",
      `${file} records kind ${JSON.stringify(record.kind)}; a packaged payload is kind "runtime".`,
    );
  }
  const platform = requireString(record.platform, "platform", file);
  const arch = requireString(record.arch, "arch", file);
  const launch = record.launch;
  if (typeof launch !== "object" || launch === null || Array.isArray(launch)) {
    throw new PayloadRefusal("manifest-unreadable", `${file} has no \`launch\` object.`);
  }
  const contract = launch as Record<string, unknown>;
  return {
    platform,
    arch,
    launch: {
      interpreter: requireString(contract.interpreter, "launch.interpreter", file),
      entry: requireString(contract.entry, "launch.entry", file),
    },
  };
}

/**
 * Compare a payload against the host that wants to run it, and name the first mismatch.
 *
 * Pure, and deliberately performed before anything is spawned: this is the check an incompatible
 * interpreter could not have performed on itself. The layout comparison is in the same pass because
 * a payload whose launch contract moved is not one this app knows how to start, and saying so is
 * more useful than a `MODULE_NOT_FOUND` from a child.
 */
export function checkPayloadHost(
  manifest: PayloadManifestFacts,
  host: PayloadHost,
): PayloadRefusal | null {
  if (manifest.platform !== host.platform) {
    return new PayloadRefusal(
      "wrong-platform",
      `this payload was assembled on ${manifest.platform} and this machine is ${host.platform}. ` +
        `Payload contents are platform-specific — the interpreter is a native binary — so it has ` +
        `to be built on the platform it targets.`,
    );
  }
  if (manifest.arch !== host.arch) {
    return new PayloadRefusal(
      "wrong-arch",
      `this payload carries a ${manifest.arch} interpreter and this machine is ${host.arch}. ` +
        `\`runtime build\` copies the build host's own \`process.execPath\`, so a payload only ` +
        `runs on the architecture it was built on. Install the ${host.arch} build of this app.`,
    );
  }
  const interpreter = payloadInterpreterEntry(host.platform);
  if (manifest.launch.interpreter !== interpreter) {
    return new PayloadRefusal(
      "layout-mismatch",
      `this payload's launch contract names ${manifest.launch.interpreter} as its interpreter ` +
        `and this app spawns ${interpreter}.`,
    );
  }
  if (manifest.launch.entry !== PAYLOAD_CLI_ENTRY) {
    return new PayloadRefusal(
      "layout-mismatch",
      `this payload's launch contract names ${manifest.launch.entry} as its entry and this app ` +
        `runs ${PAYLOAD_CLI_ENTRY}.`,
    );
  }
  return null;
}

/**
 * Resolve the payload inside a packaged application into the command D10 defines.
 *
 * @throws PayloadRefusal with a named {@link PayloadRefusalReason} — never a bare `ENOENT` from a
 *   child process, which is the failure mode every check here exists to replace.
 */
export function resolvePayloadCommand(
  resourcesPath: string,
  host: PayloadHost = currentHost(),
): PayloadCommand {
  const layout = packagedPayloadLayout(resourcesPath, host.platform);
  if (!existsSync(layout.manifest)) {
    throw new PayloadRefusal(
      "payload-absent",
      `${layout.root} carries no ${RUNTIME_MANIFEST_FILE}. A packaged build ships the payload as ` +
        `an extraResources directory; a development run has none, and its pre-install commands ` +
        `have to come from a checkout instead.`,
    );
  }
  const manifest = parseRuntimeManifest(readManifestText(layout.manifest), layout.manifest);
  const refusal = checkPayloadHost(manifest, host);
  if (refusal !== null) {
    throw refusal;
  }
  if (!existsSync(layout.interpreter)) {
    throw new PayloadRefusal(
      "interpreter-missing",
      `${layout.manifest} names ${manifest.launch.interpreter} and ${layout.interpreter} is not ` +
        `on disk.`,
    );
  }
  if (!existsSync(layout.entry)) {
    throw new PayloadRefusal(
      "entry-missing",
      `${layout.manifest} names ${manifest.launch.entry} and ${layout.entry} is not on disk.`,
    );
  }
  return { root: layout.root, executable: layout.interpreter, entry: layout.entry };
}

/** What {@link runPayload} may be told beyond the command and its arguments. */
export type RunPayloadOptions = {
  /** Kill the child after this many milliseconds. A hung probe must not hang the app. */
  timeoutMs?: number | undefined;
  /** The child's environment. Defaults to this process's. */
  env?: NodeJS.ProcessEnv | undefined;
  /** The working directory. Defaults to the payload root, which always exists. */
  cwd?: string | undefined;
  /**
   * The platform whose spawn rules apply. Defaults to this process's.
   *
   * A parameter for the reason {@link checkPayloadHost} takes its host as one: the Windows branch
   * — {@link spawnPlan}'s, which is the difference between a launcher that runs and `EINVAL` — is
   * only checkable from another machine if a test can ask for it by name.
   */
  platform?: NodeJS.Platform | undefined;
};

/** The extensions Windows will only execute through a command interpreter. */
const WINDOWS_BATCH_EXTENSIONS: readonly string[] = [".cmd", ".bat"];

/** What `spawn` is actually given, once the Windows batch rule has been applied. */
export type SpawnPlan = {
  /** The image to execute: the program itself, or the command interpreter that can run it. */
  executable: string;
  /** Its arguments, already quoted where a command line rather than an argv is what arrives. */
  argv: readonly string[];
  /**
   * Whether `argv` is a command line to pass through untouched.
   *
   * `true` only for the `cmd.exe` branch, where the quoting below is the whole contract and Node's
   * own argument escaping would quote the quotes.
   */
  windowsVerbatimArguments: boolean;
};

/** Whether this platform needs a command interpreter to execute `executable` at all. */
export function isWindowsBatchFile(executable: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") {
    return false;
  }
  const lowered = executable.toLowerCase();
  return WINDOWS_BATCH_EXTENSIONS.some((extension) => lowered.endsWith(extension));
}

/**
 * One argument, quoted so `cmd /s /c` hands it to the batch file unchanged.
 *
 * @throws {RangeError} for a character no quoting on this platform survives. `%` is the one that
 * matters: `cmd.exe` expands `%NAME%` in the command line *before* the batch file sees it, and
 * there is no escape for that in a string arriving from outside a batch file. A refusal naming the
 * path is the honest answer — the alternative is a launcher run with a different path than the one
 * the app resolved.
 */
function quoteForCmd(argument: string): string {
  if (/["%\r\n\0]/.test(argument)) {
    throw new RangeError(
      `${JSON.stringify(argument)} cannot be passed through cmd.exe: a quote, a percent sign, a ` +
        "line break or a NUL in a command line is either re-parsed or expanded before the " +
        "program sees it. The Windows launcher and the arguments this app sends it must contain " +
        "none of them.",
    );
  }
  return `"${argument}"`;
}

/**
 * What to spawn for `executable`, and with what — the one place the Windows launcher is handled.
 *
 * **Why this exists.** `daemon install` writes the stable launcher as `<state>\\bin\\xplainer.cmd`,
 * and since the fix for CVE-2024-27980 Node refuses to `spawn` a `.cmd` or `.bat` without a shell:
 * the call fails with `EINVAL` before the file is ever read. Measured on `windows-latest`,
 * 2026-09-08: every control and every discovery that resolved the launcher answered
 * `command-failed` — "`…\\bin\\xplainer.cmd` would not run: spawn EINVAL" — so the app worked on a
 * machine with **nothing** installed and stopped working the moment one was.
 *
 * **Why `cmd /d /s /c` with our own quoting rather than `shell: true`.** Node's shell option builds
 * exactly this command line and joins the arguments with spaces **without quoting any of them**, so
 * a state directory under `C:\\Users\\Ada Lovelace\\…` would reach the batch file as two arguments.
 * `/d` skips any `AutoRun` command the registry carries, `/s` is what makes "strip the outer pair
 * of quotes and take the rest verbatim" the parsing rule, and each token is quoted here.
 *
 * Everywhere else — every POSIX platform, and `node.exe` on Windows — this is the identity, and
 * `shell: false` stays the property the caller's docblock claims.
 */
export function spawnPlan(
  executable: string,
  argv: readonly string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): SpawnPlan {
  if (!isWindowsBatchFile(executable, platform)) {
    return { executable, argv: [...argv], windowsVerbatimArguments: false };
  }
  const line = [executable, ...argv].map(quoteForCmd).join(" ");
  return {
    // `ComSpec` is what Windows itself names the interpreter in, and Node's own shell branch reads
    // the same variable; the literal is the fallback for an environment that carries neither.
    executable: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
    argv: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/** How long a one-shot payload command is given before it is killed. */
export const DEFAULT_PAYLOAD_TIMEOUT_MS = 30_000;

/**
 * Run one payload command to completion and collect what it wrote.
 *
 * `shell: false` — the default, stated here because it is load-bearing: the interpreter is an
 * absolute path with no quoting applied to it, and nothing about this call goes through a shell
 * that would have to be trusted with a user's directory name.
 */
export function runPayload(
  command: PayloadCommand,
  args: readonly string[],
  options: RunPayloadOptions = {},
): Promise<PayloadRun> {
  return runProgram(command.executable, [command.entry, ...args], {
    ...options,
    cwd: options.cwd ?? command.root,
  });
}

/**
 * Start one program with its two streams captured. The **only** `spawn` call in this app.
 *
 * Everything that runs a CLI goes through here — {@link runPayload} for a one-shot command through
 * the payload, {@link runProgram} for one through the stable launcher, and `discovery.ts` for the
 * long-lived `serve` it supervises itself — so `stdio`, `windowsHide` and the interpreter question
 * are settled once. `shell: false` is the default and stays it: the one program on any platform
 * that cannot be executed without an interpreter is the Windows `.cmd` launcher, and
 * {@link spawnPlan} names `cmd.exe` explicitly and quotes every token itself rather than handing a
 * joined string to whatever `shell: true` would have picked.
 */
export function startProgram(
  executable: string,
  argv: readonly string[],
  options: RunPayloadOptions = {},
): ChildProcessByStdio<null, Readable, Readable> {
  const environment = options.env ?? process.env;
  const plan = spawnPlan(executable, argv, options.platform ?? process.platform, environment);
  return spawn(plan.executable, [...plan.argv], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
  });
}

/**
 * Run one program to completion and collect what it wrote.
 *
 * {@link runPayload} is this function with the payload's entry prepended, and `discovery.ts` calls
 * it directly for the **stable launcher**, which takes no entry because it carries the interpreter
 * and the entry inside itself. Both of D10's two stages therefore go through one place: one
 * timeout, one pair of collected streams, and no second implementation to keep in step.
 */
export function runProgram(
  executable: string,
  argv: readonly string[],
  options: RunPayloadOptions = {},
): Promise<PayloadRun> {
  return new Promise((resolve, reject) => {
    const child = startProgram(executable, argv, options);

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, options.timeoutMs ?? DEFAULT_PAYLOAD_TIMEOUT_MS);
    timer.unref();

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/** The pre-install command the app runs first: where this machine's daemon is, as JSON. */
export const PAYLOAD_STATUS_ARGV: readonly string[] = ["status", "--json"];

/** One line of evidence that the packaged app reached its own payload — or the condition that stopped it. */
export type PayloadProbe =
  | {
      event: "payload_probe";
      /** The interpreter that was spawned, which is the whole of what D10 asserts. */
      interpreter: string;
      entry: string;
      argv: readonly string[];
      exit_code: number | null;
      /** `status --json`'s own condition code, when it produced one. */
      condition: string | null;
    }
  | {
      event: "payload_unavailable";
      reason: PayloadRefusalReason;
      message: string;
    };

/**
 * Run `status --json` through the packaged payload and describe the outcome.
 *
 * This is the app's first use of D10's spawn and the one the packaged-launch check reads: it prints
 * as a single JSON line, in the same shape the daemon's own `ready` line uses, so a process
 * watching stdout can assert on it without parsing prose.
 */
export async function probePayloadStatus(
  resourcesPath: string,
  host: PayloadHost = currentHost(),
): Promise<PayloadProbe> {
  let command: PayloadCommand;
  try {
    command = resolvePayloadCommand(resourcesPath, host);
  } catch (error) {
    if (error instanceof PayloadRefusal) {
      return { event: "payload_unavailable", reason: error.reason, message: error.message };
    }
    throw error;
  }
  let run: PayloadRun;
  try {
    run = await runPayload(command, PAYLOAD_STATUS_ARGV);
  } catch (error) {
    return {
      event: "payload_unavailable",
      reason: "spawn-failed",
      message:
        `${command.executable} is on disk and would not start: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    event: "payload_probe",
    interpreter: command.executable,
    entry: command.entry,
    argv: PAYLOAD_STATUS_ARGV,
    exit_code: run.code,
    condition: readCondition(run.stdout),
  };
}

/** `status --json`'s `condition`, or `null` when it wrote something that is not one JSON object. */
function readCondition(stdout: string): string | null {
  try {
    const document: unknown = JSON.parse(stdout);
    if (typeof document !== "object" || document === null || Array.isArray(document)) {
      return null;
    }
    const condition = (document as Record<string, unknown>).condition;
    return typeof condition === "string" ? condition : null;
  } catch {
    return null;
  }
}

/** Read the manifest, turning an unreadable file into the same named refusal a bad shape gets. */
function readManifestText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    throw new PayloadRefusal(
      "manifest-unreadable",
      `${file} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** A manifest field that has to be a string, or a named refusal saying which one was not. */
function requireString(value: unknown, field: string, file: string): string {
  if (typeof value !== "string" || value === "") {
    throw new PayloadRefusal(
      "manifest-unreadable",
      `${file} has no string \`${field}\`; it records ${JSON.stringify(value)}.`,
    );
  }
  return value;
}
