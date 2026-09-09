/**
 * T16's rollback cases, rerun where a browser and a real workspace exist: **the recovered daemon
 * renders**.
 *
 * B5 proves the transaction — the operation lock, the durable journal, the boundaries, the
 * commanded recovery — and it ends every rollback case with five assertions plus one that is only
 * half of the sixth: *the installed workspace satisfies the pins of the runtime that came back*.
 * That is readiness, not a render. A daemon that answers `/healthz` and cannot produce a picture is
 * the exact failure class principle P2 exists for, and the plan splits the remaining half here on
 * purpose: the PNG needs a headless shell and a payload-2 workspace, which are `xplainer setup`'s
 * to acquire and therefore B6's to have (§12.3, "B5 proves recovery; B6 reruns every rollback case
 * after T19 has supplied the browser and the workspace").
 *
 * So this is that rerun, and it is `scripts/e2e/toolchain.mjs`'s last phase rather than a unit
 * suite, because everything it needs is what that gate has already built: an artefact assembled by
 * the shipped assembler, a workspace `setup` materialised, a browser `setup` acquired, and one
 * video whose narration has been measured. It is handed those four things and nothing else.
 *
 * **Six cases, which is every case that ends in a rollback.** The five durable boundaries an
 * updater can be killed at ({@link UPDATE_TRANSITIONS}), each driven by the same child entry B5
 * uses — `install/update/testing/interrupt-update.ts`, which parks a half-finished transaction so
 * it can be `SIGKILL`ed for real — and then the case that needs no kill at all: a replacement that
 * starts and never becomes ready, which is round 1's first injected failure. Every one of them
 * recovers into a rollback, because the incoming runtime is one this proof's supervisor declines to
 * start, and every one of them then has to render.
 *
 * **What is real here that is not real in B5's step 1.** The payloads: `assembleRuntime()` produces
 * A from this checkout, and B is A with its own version and an entry that binds nothing, rescanned
 * by the shipped scanner. So the daemon that comes back after each rollback is a real
 * `xplainer serve` out of a real payload 1, reading the real `toolchain.json` `setup` wrote and the
 * real `node_modules` `setup` materialised — and the still it is then asked for spawns the pinned
 * Remotion CLI through the interpreter D1 resolves.
 *
 * **What stays a seam, and why that is not a weakening.** The supervisor: `updateHarness()`'s `run`
 * is what `launchctl`, `systemctl` and Task Scheduler would be, and it really does start and stop
 * the daemon out of `daemon.json`'s recorded launch spec. B5's step 2 (`failure-proof.ts`) is where
 * a *real* service manager accepts a rewritten artefact, under a throwaway label; repeating that
 * here would register a launchd job on a developer's machine six more times to observe a fact that
 * proof already establishes, and would say nothing about the picture — which is the only thing this
 * rerun exists to add.
 *
 * **The marker is put back after every kill.** `interrupt-update.ts` writes the committed
 * `install/__fixtures__/toolchain.json` into the state directory, because an install refuses a
 * machine with no setup marker and B5 has no real one. Its stand-in chrome path is not a browser,
 * so this proof copies the **real** marker over it once the updater is dead and before the recovery
 * runs — which is also the honest ordering: what a user would have on that machine is what `setup`
 * left there.
 *
 * It prints one `ok:` line per assertion and exits non-zero on the first that fails. Nothing here
 * ships: `tsconfig.build.json` excludes `src/**\/testing/**`.
 */

import type { ChildProcess } from "node:child_process";
import {
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ExplainerJobOutput } from "@xplainer/protocol";
import { stillOutput, videoPaths } from "@xplainer/render-core";
import { readDaemonState, readRuntimeState } from "../../daemon/daemon-state.js";
import { DAEMON_UNHEALTHY_EXIT_CODE } from "../../daemon/exit-codes.js";
import { spawnEntry } from "../../daemon/testing/spawn-child.js";
import { isAlive } from "../../daemon/worker-identity.js";
import { installDaemon } from "../../install/install.js";
import { stagedRuntimeRoot } from "../../install/stage.js";
import { UPDATE_TRANSITIONS, updateJournalPath } from "../../install/update/journal.js";
import { operationLockPath } from "../../install/update/lock.js";
import { recoverUpdate } from "../../install/update/recover.js";
import {
  fixtureEnvironment,
  fixtureLingerMarker,
  HARNESS_LOG_FILE,
  PARKED_LINE,
  updateHarness,
} from "../../install/update/testing/harness.js";
import { UpdateRefusal, updateDaemon } from "../../install/update/transaction.js";
import { assembleRuntime } from "../../runtime/assemble.js";
import {
  PAYLOAD_BIN_DIR,
  PAYLOAD_LIB_DIR,
  RUNTIME_MANIFEST_FILE,
  type RuntimeManifest,
  scanTree,
} from "../../runtime/manifest.js";
import { readTemplatePins, verifyWorkspacePayload } from "../../runtime/verify.js";

/** The child entry that parks a half-finished transaction so this proof can kill it. */
const INTERRUPT_UPDATE = fileURLToPath(
  new URL("../../install/update/testing/interrupt-update.ts", import.meta.url),
);

/** The version B declares, so the two staged slots are told apart by name. */
const INCOMING_VERSION = "0.0.0-t33-rollback";

/** How long a *deliberate* readiness failure waits before the transaction rolls back. */
const DOOMED_HEALTH_MS = 1_500;

/** How long one case's install, update, kill and recovery may take. */
const CASE_TIMEOUT_MS = 180_000;

/** How long one still may take. The first render of a run downloads a headless shell. */
const STILL_TIMEOUT_MS = 900_000;

/** The case that needs no kill: a replacement that starts and never becomes ready. */
const DOOMED_CASE = "never-ready";

/** Every case that ends in a rollback, which is what "every rollback case" means. */
const CASES = [...UPDATE_TRANSITIONS, DOOMED_CASE] as const;

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** A failed expectation is the whole point of this script, so each carries its own sentence. */
function require_(condition: boolean, what: string): void {
  if (!condition) {
    throw new Error(`FAILED: ${what}`);
  }
  say(`  ok: ${what}`);
}

/** The last lines the harness's daemons wrote in this case, or one sentence saying there are none. */
function harnessLogTail(stateDir: string, lines = 24): readonly string[] {
  const sink = join(stateDir, HARNESS_LOG_FILE);
  if (!existsSync(sink)) {
    return [`there is no ${sink}: nothing this harness started ever wrote a line`];
  }
  const written = readFileSync(sink, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
  return written.slice(-lines);
}

/** What a caught rollback said about itself, in one line, whatever kind of value it turned out to be. */
function refusalMessage(thrown: unknown): string {
  if (thrown instanceof Error) {
    return thrown.message.split("\n").join(" / ");
  }
  return thrown === null ? "it did not refuse at all" : String(thrown);
}

/** One environment variable this entry cannot do anything without. */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set, and this entry has nothing to render without it`);
  }
  return value;
}

/** The materialised workspace every case renders out of — one tree, shared, never copied. */
const workspaceRoot = required("XPLAINER_ROLLBACK_WORKSPACE");

/** The marker `xplainer setup` wrote, whose recorded paths are on this machine. */
const realMarker = required("XPLAINER_ROLLBACK_MARKER");

/** A video in that workspace whose narration has already been measured. */
const slug = required("XPLAINER_ROLLBACK_SLUG");

/** The frame each case stills. One frame is a picture; that is the whole claim. */
const frame = Number.parseInt(process.env.XPLAINER_ROLLBACK_FRAME ?? "30", 10);

/** Where the still lands, as the shipping path builder answers it. */
const stillPath = stillOutput(videoPaths(workspaceRoot, slug), frame);

/**
 * Regenerate a payload's manifest after its bytes were changed, with the shipped scanner.
 *
 * `failure-proof.ts`'s function, for the same reason: it is how B becomes a *different* payload
 * without editing the repository mid-proof, and what lands is byte-for-byte what a checkout with
 * those contents would have produced — which is what makes the stager's own re-hash accept it.
 */
function rescanPayload(payloadDir: string, cliVersion: string): void {
  const manifestFile = join(payloadDir, RUNTIME_MANIFEST_FILE);
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as RuntimeManifest;
  const rescan = scanTree(payloadDir, { exclude: [RUNTIME_MANIFEST_FILE] });
  const next: RuntimeManifest = {
    ...manifest,
    packages: manifest.packages.map((entry) =>
      entry.name === "@xplainer/cli" ? { ...entry, version: cliVersion } : entry,
    ),
    files: rescan.files,
    links: rescan.links,
  };
  writeFileSync(manifestFile, `${JSON.stringify(next, null, 2)}\n`);
}

/** A file inside a payload's `lib/node_modules/<package>/`. */
function payloadFile(payloadDir: string, packageName: string, ...rest: string[]): string {
  return join(payloadDir, ...PAYLOAD_LIB_DIR.split("/"), ...packageName.split("/"), ...rest);
}

/** The staged slot a version landed in, read off disk rather than composed. */
function stagedSlotFor(stateDir: string, version: string): string | null {
  const root = stagedRuntimeRoot(stateDir);
  if (!existsSync(root)) {
    return null;
  }
  const slot = readdirSync(root)
    .filter((name) => !name.startsWith("."))
    .sort()
    .find((name) => name.startsWith(`${version}-`));
  return slot === undefined ? null : join(root, slot);
}

/** Wait until a pid is gone, so a case never starts beside the process the last one killed. */
async function untilGone(pid: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return true;
    }
    await new Promise<void>((done) => {
      setTimeout(done, 25);
    });
  }
  return false;
}

/**
 * The daemon's own answer to an authenticated `/healthz`, or `null` when nothing answers.
 *
 * `node:http` with `agent: false`, not `fetch`: a pooled keep-alive socket outlives the response
 * and would hold this process open after the last case is done.
 */
async function askHealth(stateDir: string): Promise<{ version: unknown; status: unknown } | null> {
  const runtime = readRuntimeState(stateDir);
  const daemon = readDaemonState(stateDir);
  if (runtime === null || typeof runtime.port !== "number" || daemon.token_file === null) {
    return null;
  }
  const token = readFileSync(daemon.token_file, "utf8").trim();
  return new Promise((resolve) => {
    const call = httpRequest(
      {
        host: "127.0.0.1",
        port: runtime.port as number,
        path: "/healthz",
        method: "GET",
        agent: false,
        headers: { authorization: `Bearer ${token}` },
        timeout: 5_000,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          const parsed = JSON.parse(body) as { version?: unknown; status?: unknown };
          resolve({ version: parsed.version, status: parsed.status });
        });
      },
    );
    call.on("error", () => {
      resolve(null);
    });
    call.on("timeout", () => {
      call.destroy();
      resolve(null);
    });
    call.end();
  });
}

/**
 * A PNG's dimensions, read out of its own IHDR chunk.
 *
 * Read here rather than asked of `ffprobe` because this proof must not need a second tool to make
 * its one claim, and because the signature and the header are the two things a zero-length or
 * truncated file cannot have. The gate itself probes the MP4 with `ffprobe`; this asks only
 * whether a picture arrived.
 */
function pngSize(path: string): { width: number; height: number; bytes: number } {
  const png = readFileSync(path);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (png.length < 33 || Buffer.compare(png.subarray(0, 8), signature) !== 0) {
    throw new Error(`${path} does not begin with the PNG signature (${png.length} bytes)`);
  }
  if (png.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error(`${path}'s first chunk is not IHDR`);
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), bytes: png.length };
}

/**
 * Ask the daemon that is answering now for one still, over the shim an agent would use.
 *
 * `mcp --attach` out of the **installed** runtime, so the process that carries the request is the
 * one the rollback put back — not this proof, and not a client built from a path composed here.
 */
async function stillThroughDaemon(stateDir: string, runtimeDir: string): Promise<void> {
  const interpreter = join(
    runtimeDir,
    PAYLOAD_BIN_DIR,
    process.platform === "win32" ? "node.exe" : "node",
  );
  const entry = payloadFile(runtimeDir, "@xplainer/cli", "dist", "bin.js");
  const transport = new StdioClientTransport({
    command: interpreter,
    args: [entry, "mcp", "--attach"],
    env: {
      ...(process.env as Record<string, string>),
      XPLAINER_STATE_DIR: stateDir,
      XPLAINER_VIDEOS_DIR: workspaceRoot,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "xplainer-t33-rollback", version: "1.0.0" });
  await client.connect(transport);
  transport.stderr?.on("data", () => {});
  try {
    const queued = (await callTool(client, "explainer_still", {
      slug,
      frame,
      scale: 0.5,
    })) as { job_id: number };
    const finished = await pollJob(client, queued.job_id);
    require_(
      finished.status === "done",
      `explainer_still finished "done" on the recovered daemon (exit ${String(finished.exit_code)})`,
    );
  } finally {
    await client.close();
  }
}

/** Call one tool and return its structured result, refusing a tool error. */
async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: { text?: string }[];
  };
  const structured = result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? "null");
  if (result.isError === true) {
    throw new Error(`${name} refused: ${result.content?.[0]?.text ?? JSON.stringify(structured)}`);
  }
  return structured;
}

/** Poll `explainer_job` to a conclusion, the way an agent does. */
async function pollJob(client: Client, jobId: number): Promise<ExplainerJobOutput> {
  const deadline = Date.now() + STILL_TIMEOUT_MS;
  for (;;) {
    const job = (await callTool(client, "explainer_job", {
      job_id: jobId,
      output_lines: 40,
    })) as ExplainerJobOutput;
    if (job.status !== "queued" && job.status !== "running") {
      if (job.status !== "done") {
        for (const line of job.output.lines.slice(-12)) {
          say(`    | ${line}`);
        }
      }
      return job;
    }
    if (Date.now() > deadline) {
      throw new Error(`job ${String(jobId)} was still ${job.status} after ${STILL_TIMEOUT_MS} ms`);
    }
    await new Promise<void>((done) => {
      setTimeout(done, 250);
    });
  }
}

/**
 * The scratch root, with a **short** prefix, and that is a measurement rather than a preference.
 *
 * A daemon's IPC socket is `<state>/ipc/xplainer.sock`, and `sun_path` is 104 bytes on macOS — so a
 * case directory under `os.tmpdir()`, which is already 45 characters of `/var/folders/…/T/` there,
 * has very little room. Measured on 2026-09-08: a root named `xplainer-t33-rollback-XXXXXX` with
 * case directories named after their boundary produced a 113-byte socket path and every daemon
 * exited **70** with "the IPC socket path is 113 bytes and the limit is 103", which surfaced as an
 * install that registered and never became ready. The names below are short for that reason and
 * must stay short.
 */
const root = mkdtempSync(join(tmpdir(), "xp-t33-"));
const spawned: ChildProcess[] = [];

/** Whether every case finished, which is what decides if the root above is removed. */
let passed = false;

try {
  say(`rollback rerun root: ${root}`);
  say(`workspace:           ${workspaceRoot}`);
  say(`marker:              ${realMarker}`);
  say(`video:               ${slug}, frame ${String(frame)}`);
  require_(existsSync(join(workspaceRoot, "node_modules")), "the workspace has a node_modules");
  require_(existsSync(realMarker), "the marker setup wrote is on this machine");
  require_(
    existsSync(videoPaths(workspaceRoot, slug).timings),
    `${slug} has the measured timings.json a still is rendered against`,
  );

  // Asked here rather than discovered three minutes into the first case, because it is the one
  // condition every case below shares and because a refusal is a **finding**: this is the exact
  // call `openTransaction()` makes (`install/update/transaction.ts:806`) with the pins
  // `templatePinsOf()` reads, so a workspace it rejects is a machine `xplainer daemon update`
  // rejects.
  const updatable = verifyWorkspacePayload(workspaceRoot, readTemplatePins());
  require_(
    updatable.ok,
    "the update precondition accepts the workspace `xplainer setup --workspace` materialised" +
      (updatable.ok
        ? ""
        : ` — it does not: ${updatable.failure.reason} at ${updatable.failure.name}. ` +
          `${updatable.failure.detail} A workspace is verified in \`described\` mode ` +
          "(`runtime/verify.ts`, step 5): every file the manifest names must be present with its " +
          "recorded digest — that is what proves the pins — while the files a live workspace " +
          "legitimately holds beside them are allowed, because the manifest describes only " +
          "node_modules/, package.json and package-lock.json and `materialiseWorkspace()` also " +
          "copies in remotion.config.ts, tailwind.css and tsconfig.json, with videos/, out/, " +
          "public/ and Remotion's node_modules/.cache/ arriving after that. So a refusal here is " +
          "a real one: something the manifest describes has changed, gone, or been shadowed by a " +
          "nested copy — and `xplainer daemon update` would refuse this machine too."),
  );

  say("");
  say("assembling payload A from this checkout");
  const alpha = assembleRuntime({ outDir: join(root, "payload-a") });
  const alphaVersion = (
    JSON.parse(
      readFileSync(payloadFile(alpha.outDir, "@xplainer/cli", "package.json"), "utf8"),
    ) as { version: string }
  ).version;
  say(`  A: ${alpha.outDir}, @xplainer/cli ${alphaVersion}`);

  // B is A's bytes with its own version and an entry that binds nothing. A copy rather than a
  // second assembly, because the two payloads have to be the same tree for the pins on both sides
  // of the switch to be identical — which is what §1.3d A bounds a supported update to.
  say("copying A into payload B, and making it a replacement that never becomes ready");
  const betaDir = join(root, "payload-b");
  // `COPYFILE_FICLONE`: on a copy-on-write filesystem this is a clone rather than 150 MB of
  // real I/O, and it falls back to a plain copy where the filesystem has no such call.
  cpSync(alpha.outDir, betaDir, {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  });
  const betaPackageFile = payloadFile(betaDir, "@xplainer/cli", "package.json");
  const betaPackage = JSON.parse(readFileSync(betaPackageFile, "utf8")) as { version: string };
  betaPackage.version = INCOMING_VERSION;
  writeFileSync(betaPackageFile, `${JSON.stringify(betaPackage, null, 2)}\n`);
  writeFileSync(
    payloadFile(betaDir, "@xplainer/cli", "dist", "bin.js"),
    "// A replacement that starts and never becomes ready: no listener, no runtime.json, no line.\n" +
      "setInterval(() => {}, 60_000);\n",
  );
  rescanPayload(betaDir, INCOMING_VERSION);
  say(`  B: ${betaDir}, @xplainer/cli ${INCOMING_VERSION}, an entry that binds nothing`);

  for (const [index, current] of CASES.entries()) {
    say("");
    say(`── case ${String(index + 1)}/${String(CASES.length)}: ${current} ${"─".repeat(40)}`);
    const caseRoot = join(root, `c${String(index + 1)}`);
    const stateDir = join(caseRoot, "state");
    const home = join(caseRoot, "home");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    mkdirSync(join(home, "Library", "Logs"), { recursive: true });
    const environment = fixtureEnvironment(home);
    copyFileSync(realMarker, join(stateDir, "toolchain.json"));

    const harness = updateHarness({
      stateDir,
      // The marker this environment names, not the machine's. `install.ts` runs
      // `loginctl enable-linger` and then checks `existsSync(<lingerDir>/<account>)`, because the
      // file is what systemd reads at boot and `loginctl` only reports what it was told — so a
      // harness that answers the command without creating the file refuses with exit `5` on any
      // Linux host, before the first case is reached. `interrupt-update.ts` wires it the same way
      // for the five cases it drives; this is the sixth, which installs here.
      lingerMarker: fixtureLingerMarker(environment),
      onSpawn: (child) => {
        spawned.push(child);
        // Drained and discarded: nothing here wants the daemon's own logging, and a pipe
        // nobody reads is one a daemon can eventually block on.
        child.stdout?.resume();
        child.stderr?.resume();
      },
    });

    // What the transaction said about itself, kept for the diagnostic below: both arms produce a
    // refusal and the sentence inside it is the only thing that says *which* half gave up.
    let refused: unknown = null;
    if (current === DOOMED_CASE) {
      const install = await installDaemon({
        stateDir,
        payloadDir: alpha.outDir,
        port: 0,
        environment,
        run: harness.run,
        healthTimeoutMs: 30_000,
      });
      say(`  installed A at ${install.runtimeDir}, answering as ${install.health.version}`);
      harness.refuseStartOf(join(stagedRuntimeRoot(stateDir), `${INCOMING_VERSION}-`));
      const refusal = await updateDaemon({
        stateDir,
        from: betaDir,
        environment,
        run: harness.run,
        workspaceRoot,
        healthTimeoutMs: DOOMED_HEALTH_MS,
      }).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      refused = refusal;
      require_(
        refusal instanceof UpdateRefusal && refusal.exitCode === DAEMON_UNHEALTHY_EXIT_CODE,
        `the update refused with ${String(DAEMON_UNHEALTHY_EXIT_CODE)} and rolled back to A`,
      );
    } else {
      const parked = spawnEntry(INTERRUPT_UPDATE, [], {
        XPLAINER_TEST_STATE_DIR: stateDir,
        XPLAINER_TEST_HOME: home,
        XPLAINER_TEST_PAYLOAD_A: alpha.outDir,
        XPLAINER_TEST_PAYLOAD_B: betaDir,
        XPLAINER_TEST_WORKSPACE: workspaceRoot,
        XPLAINER_TEST_PARK_AT: current,
        XPLAINER_TEST_REFUSE_START: join(stagedRuntimeRoot(stateDir), `${INCOMING_VERSION}-`),
        XPLAINER_TEST_HEALTH_MS: String(DOOMED_HEALTH_MS),
        XPLAINER_VIDEOS_DIR: workspaceRoot,
      });
      spawned.push(parked.process);
      const line = await parked.waitForLine(`${PARKED_LINE} ${current}`, CASE_TIMEOUT_MS);
      say(`  ${line.trim()}`);
      parked.process.kill("SIGKILL");
      require_(
        await untilGone(parked.process.pid as number),
        "the updater is gone: what follows is the state a machine is in when one dies",
      );

      // `interrupt-update.ts` wrote B5's committed fixture marker over the state directory, and its
      // stand-in chrome path is not a browser. What a user has on this machine is what `setup`
      // left, so that is what the recovery and the render below are given.
      copyFileSync(realMarker, join(stateDir, "toolchain.json"));

      harness.refuseStartOf(join(stagedRuntimeRoot(stateDir), `${INCOMING_VERSION}-`));
      const recovered = await recoverUpdate({
        stateDir,
        environment,
        run: harness.run,
        workspaceRoot,
        healthTimeoutMs: DOOMED_HEALTH_MS,
      }).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      refused = recovered;
      require_(
        recovered instanceof UpdateRefusal && recovered.exitCode === DAEMON_UNHEALTHY_EXIT_CODE,
        `\`xplainer daemon recover\`'s engine rolled back and reported ${String(DAEMON_UNHEALTHY_EXIT_CODE)}`,
      );
    }

    const installedRuntime = readDaemonState(stateDir).runtime_dir;
    const previousSlot = stagedSlotFor(stateDir, alphaVersion);
    require_(
      installedRuntime !== null && installedRuntime === previousSlot,
      `daemon.json records A as the runtime the daemon runs out of (${String(installedRuntime)})`,
    );
    const health = await askHealth(stateDir);
    if (health === null) {
      // The one question this assertion cannot answer on its own: a daemon that is not answering
      // said *why* somewhere, and the harness sends its output to a sink in the state directory
      // precisely so that a proof running on a machine nobody can log into still has it. An exit
      // `10` here is a predecessor that never went away; anything else is the rollback's own.
      say(`  the recovered daemon is not answering. What it wrote, from ${HARNESS_LOG_FILE}:`);
      for (const line of harnessLogTail(stateDir)) {
        say(`    ${line}`);
      }
      // And what the rollback itself said, which is the half the log cannot give: a refusal whose
      // sentence is "the previous runtime … did not answer either" is a rollback that gave up on
      // its own comeback, and one saying "is installed and answering" is a rollback that succeeded
      // and a daemon that stopped afterwards. Those are different bugs and the two were told apart
      // by guesswork until this line existed (`windows-latest`, run 34319281465).
      say(`  and what the rollback itself reported: ${refusalMessage(refused)}`);
    }
    require_(
      health?.version === alphaVersion,
      `A is answering /healthz as release ${alphaVersion}`,
    );
    require_(
      health?.status === "ok",
      `and it reports its toolchain whole: status ${String(health?.status)}`,
    );
    require_(
      !existsSync(updateJournalPath(stateDir)) && !existsSync(operationLockPath(stateDir)),
      "the transaction is closed: no journal, no operation lock",
    );

    // The sixth assertion, in the half B5 deferred: not a green `/healthz`, a picture.
    rmSync(stillPath, { force: true });
    require_(!existsSync(stillPath), `${stillPath} is gone before the still is asked for`);
    await stillThroughDaemon(stateDir, installedRuntime as string);
    const png = pngSize(stillPath);
    require_(
      png.width === 960 && png.height === 540,
      `the rolled-back daemon rendered a ${String(png.width)}x${String(png.height)} PNG of ` +
        `${String(png.bytes)} bytes at scale 0.5`,
    );
    require_(
      statSync(stillPath).size > 4096,
      "and it has a picture in it rather than a header and a blank canvas",
    );

    harness.stopAll();
  }

  say("");
  say(`ROLLBACK RERUN PASSED: ${String(CASES.length)} rollback cases, each ending in a PNG`);
  passed = true;
} finally {
  for (const child of spawned) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  // Kept when it fails, because a case that went wrong left the only evidence there is: a state
  // directory mid-transaction, and the daemon log the supervisor's own start wrote.
  if (passed) {
    rmSync(root, { recursive: true, force: true });
  } else {
    say(`the rollback rerun's root is kept at ${root}`);
  }
}
