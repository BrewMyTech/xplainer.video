/**
 * ADR 0031's cut, met on a real machine: a daemon installed from before it, and the three commands
 * of this build that would otherwise put a marker under it that it cannot read.
 *
 * The cut moved `toolchain.json` from format 1, which records a workspace, to format 2, which
 * records an ffmpeg instead (ADR 0031 §Note, 2026-11-12, D1). A daemon installed from before it
 * reads format 1, and three commands of this build write format 2 or install a runtime that does:
 * `xplainer update`, whose first step is `setup`; `xplainer setup` itself; and `daemon update`, the
 * transaction. D2 refuses all three with `3` — (b), (c) and (a) — and the two that print a remedy
 * print the reinstall and run none of it (Q3). `transaction.test.ts`, `commands/update.test.ts` and
 * `commands/setup.test.ts` prove each refusal against seams. This proves them against a daemon a
 * real service manager is running, from the far side of a real payload, and asserts the part a seam
 * cannot: that afterwards **the old daemon is still the one answering, and still answers `ok`**.
 *
 * ## The cases
 *
 * 1. **`xplainer update` exits `3` before it runs `setup`** (D2 (b)): the three reinstall commands
 *    on stderr, nothing on stdout — the report every completed step prints is absent, so no step
 *    ran — and nothing written.
 * 2. **`xplainer setup` exits `3`** (D2 (c)), naming the committed manifest so that nothing could
 *    reach the network even if the refusal did not fire, and again nothing written.
 * 3. **`daemon update` to this build's payload exits `3` in its precondition** (D2 (a)), naming
 *    both formats and the direction, with nothing staged and nothing drained.
 *
 * After each, the same five facts: the marker's bytes, the state directory's top-level entries,
 * the staged runtimes, the run `runtime.json` records, and an authenticated `/healthz` answering
 * `ok` as the pre-cut release.
 *
 * ## What is real, and the two things that are not
 *
 * Real: both payloads, assembled by the shipped `assembleRuntime()`; the install, under this
 * machine's own service manager; the daemon, a real `xplainer serve` out of the pre-cut payload;
 * the two commands, spawned as this build's own payload runs them — its interpreter and its entry;
 * and the transaction, called as `daemon update` calls it.
 *
 * **Not real, and stated rather than glossed:**
 *
 * 1. **The pre-cut runtime is this build's payload with a pre-cut manifest.** A copy of the payload
 *    under its own version, whose `runtime.manifest.json` is rewritten to the shape every release
 *    before the cut wrote — `manifest_version` 1 and no `toolchain` block — and rescanned with the
 *    shipped scanner, so the stager accepts it. Detection reads exactly that manifest, through
 *    `daemon.json`'s `runtime_dir`, so what is under test is real; the daemon's *code* is this
 *    build's, which is why the marker it serves from is the committed format-2 fixture and why it
 *    answers `ok` before and after. A real 0.0.10 daemon would read that file as missing — which is
 *    the reason the refusals exist, and the reason this proof does not try to stand one up.
 * 2. **The label, on macOS only**, exactly as `failure-proof.ts`: every command is translated to
 *    {@link THROWAWAY_LABEL}, and on Linux the real `xplainer.service` is installed in the
 *    account's own config directory and removed in the `finally`.
 *
 * It is not part of `pnpm verify`; `scripts/e2e/update.mjs` runs it as the last step of
 * `pnpm e2e:update`. Nothing here ships: `tsconfig.build.json` excludes `src/**\/testing/**`.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readRuntimeState } from "../../../daemon/daemon-state.js";
import { assembleRuntime } from "../../../runtime/assemble.js";
import {
  PAYLOAD_LIB_DIR,
  RUNTIME_MANIFEST_FILE,
  type RuntimeManifest,
  readRuntimeManifest,
  runtimeToolchainFormat,
  scanTree,
} from "../../../runtime/manifest.js";
import { installedDaemonFormat, toolchainMarkerPath } from "../../../setup/toolchain.js";
import { awaitHealthy, type HealthResponse, loopbackGet } from "../../health.js";
import { installDaemon } from "../../install.js";
import { currentSupervisorEnvironment } from "../../preflight.js";
import { stagedRuntimeRoot } from "../../stage.js";
import { supervisorKindForPlatform } from "../../supervisors/index.js";
import { removeScratchRoot } from "../../testing/scratch.js";
import { writeToolchainMarker } from "../../testing/toolchain.js";
import { updateJournalPath } from "../journal.js";
import { operationLockPath } from "../lock.js";
import { UpdateRefusal, updateDaemon } from "../transaction.js";
import { fixtureEnvironment } from "./harness.js";
import { deregisterThrowaway, throwawayProbe } from "./throwaway-supervisor.js";

/** The label this proof registers under. Never the product's, and booted out in a `finally`. */
export const THROWAWAY_LABEL = "video.xplainer.cut-proof";

/** The version the pre-cut payload's `@xplainer/cli` declares, and so the release it reports. */
export const PRE_CUT_VERSION = "0.0.0-pre-cut-proof";

/**
 * The committed manifest, which `setup` is pointed at so that nothing here can reach the network.
 *
 * The refusal fires before any manifest is read; this is what keeps a refusal that did **not** fire
 * from asking the published address for a document a release has not uploaded yet.
 */
const COMMITTED_MANIFEST = fileURLToPath(
  new URL("../../../setup/toolchain.manifest.json", import.meta.url),
);

/** ADR 0020 §6's code for "a precondition of this operation is not met", from the document. */
const PRECONDITION_UNMET = 3;

/** The reinstall D2 prints and runs none of, as both commands print it. */
const REINSTALL = "  xplainer daemon uninstall\n  xplainer setup\n  xplainer daemon install\n";

/** How long one spawned command may take. Each refuses before it does anything at all. */
const COMMAND_TIMEOUT_MS = 60_000;

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** A failed expectation is the whole point of this script, so each carries its own sentence. */
function require(condition: boolean, what: string): void {
  if (!condition) {
    throw new Error(`FAILED: ${what}`);
  }
  say(`  ok: ${what}`);
}

/** A file inside a payload's `lib/node_modules/<package>/`. */
function payloadFile(payloadDir: string, packageName: string, ...rest: string[]): string {
  return join(payloadDir, ...PAYLOAD_LIB_DIR.split("/"), ...packageName.split("/"), ...rest);
}

/** Every entry of a directory, sorted, as the set a refusal must not have added to. */
function readDirectorySorted(path: string): string[] {
  return existsSync(path) ? readdirSync(path).sort() : [];
}

/** The run `runtime.json` records now, which is what "nothing was drained" compares. */
function runIdOf(dir: string): string | null {
  const run = readRuntimeState(dir)?.run_id;
  return typeof run === "string" ? run : null;
}

/** The SHA-256 of a file's bytes, which is what "the marker is unchanged" compares. */
function digestOf(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const root = mkdtempSync(join(tmpdir(), "xplainer-cut-proof-"));
const home = join(root, "home");
const stateDir = join(root, "state");
// macOS renders into a scratch home and registers a throwaway label; Linux has to use this
// account's own config directory, because that is the only place its user manager looks.
const environment =
  process.platform === "darwin" ? fixtureEnvironment(home) : currentSupervisorEnvironment();
const uid = process.getuid?.() ?? 0;
const probe = throwawayProbe(THROWAWAY_LABEL);

/** What the machine looked like with the pre-cut daemon installed and answering. */
type Baseline = {
  marker: string;
  entries: string[];
  slots: string[];
  run: string | null;
};

/** The pre-cut daemon's `/healthz`, asked with the token it minted, and the body it answered. */
async function askHealthz(): Promise<{ version: string; status: string; url: string }> {
  // A holder rather than a `let`: the transport assigns it inside a closure, which control-flow
  // narrowing cannot see, so a `let … | null` would read as `null` for ever after the call.
  const seen: { last: HealthResponse | null } = { last: null };
  const answer = await awaitHealthy({
    stateDir,
    since: 0,
    timeoutMs: 15_000,
    env: process.env,
    transport: async (request) => {
      seen.last = await loopbackGet(request);
      return seen.last;
    },
  });
  const body = seen.last?.body ?? "{}";
  const status = (JSON.parse(body) as { status?: unknown }).status;
  return {
    version: answer.version,
    status: typeof status === "string" ? status : "",
    url: answer.url,
  };
}

/** The five facts a refusal must leave as it found them, the last one asked of the daemon. */
async function requireUntouched(before: Baseline, after: string): Promise<void> {
  require(digestOf(toolchainMarkerPath(stateDir)) ===
    before.marker, `${after}: toolchain.json has the same bytes it had before`);
  require(readDirectorySorted(stateDir).join(",") ===
    before.entries.join(
      ",",
    ), `${after}: the state directory holds the same entries (${before.entries.join(", ")}) — no toolchain/ directory, no seeded lexicon`);
  require(readDirectorySorted(stagedRuntimeRoot(stateDir)).join(",") ===
    before.slots.join(","), `${after}: nothing was staged — still ${before.slots.join(", ")}`);
  require(runIdOf(stateDir) ===
    before.run, `${after}: nothing was drained — the same run is recorded`);
  require(!existsSync(updateJournalPath(stateDir)) &&
    !existsSync(operationLockPath(stateDir)), `${after}: no journal and no operation lock`);
  const health = await askHealthz();
  require(health.version === PRE_CUT_VERSION &&
    health.status ===
      "ok", `${after}: the pre-cut daemon still answers ${health.url} as ${health.version}, status ${health.status}`);
}

/** Spawn this build's own payload as a user would run it, against the proof's state directory. */
function runThisBuild(
  interpreter: string,
  entry: string,
  argv: readonly string[],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(interpreter, [entry, ...argv], {
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    env: {
      ...process.env,
      XPLAINER_STATE_DIR: stateDir,
      // Belt and braces: were the refusal not to fire, `setup` would read this file rather than the
      // published address, and `connect` would write into the scratch home, not into this account.
      XPLAINER_TOOLCHAIN_MANIFEST: COMMITTED_MANIFEST,
      HOME: home,
      USERPROFILE: home,
    },
  });
  for (const [stream, text] of [
    ["out", result.stdout ?? ""],
    ["err", result.stderr ?? ""],
  ] as const) {
    for (const line of text.split("\n")) {
      if (line.trim() !== "") {
        say(`    [${stream}] ${line}`);
      }
    }
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

try {
  say(`proof root: ${root}`);
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(join(home, "Library", "Logs"), { recursive: true });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  say("assembling this build's payload from the checkout");
  const current = assembleRuntime({ outDir: join(root, "payload-current") });
  const currentFormat = runtimeToolchainFormat(readRuntimeManifest(current.outDir));
  say(`  current: ${current.outDir}, reads toolchain.json format ${String(currentFormat)}`);
  require(currentFormat ===
    2, "this build's payload declares format 2, the side of the cut it writes");

  say(
    "copying it into a pre-cut payload: its own version, and the manifest every earlier release wrote",
  );
  const preCutDir = join(root, "payload-pre-cut");
  cpSync(current.outDir, preCutDir, {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  });
  const preCutPackageFile = payloadFile(preCutDir, "@xplainer/cli", "package.json");
  const preCutPackage = JSON.parse(readFileSync(preCutPackageFile, "utf8")) as { version: string };
  preCutPackage.version = PRE_CUT_VERSION;
  writeFileSync(preCutPackageFile, `${JSON.stringify(preCutPackage, null, 2)}\n`);
  const manifestFile = join(preCutDir, RUNTIME_MANIFEST_FILE);
  const { toolchain: _declared, ...preCutManifest } = JSON.parse(
    readFileSync(manifestFile, "utf8"),
  ) as RuntimeManifest;
  const rescan = scanTree(preCutDir, { exclude: [RUNTIME_MANIFEST_FILE] });
  writeFileSync(
    manifestFile,
    `${JSON.stringify(
      {
        ...preCutManifest,
        manifest_version: 1,
        packages: preCutManifest.packages.map((entry) =>
          entry.name === "@xplainer/cli" ? { ...entry, version: PRE_CUT_VERSION } : entry,
        ),
        files: rescan.files,
        links: rescan.links,
      },
      null,
      2,
    )}\n`,
  );
  require(runtimeToolchainFormat(readRuntimeManifest(preCutDir)) ===
    1, "the shipped reader reads the pre-cut payload as format 1: no toolchain block, manifest_version 1");

  say("writing the setup marker");
  writeToolchainMarker(stateDir);

  say(
    process.platform === "darwin"
      ? `installing the pre-cut payload under launchd as ${THROWAWAY_LABEL}`
      : `installing the pre-cut payload under ${String(supervisorKindForPlatform(process.platform))}`,
  );
  const install = await installDaemon({
    stateDir,
    payloadDir: preCutDir,
    port: 0,
    environment,
    run: probe,
  });
  say(
    `  installed: ${install.runtimeDir}, answering ${install.health.url} as release ` +
      `${install.health.version} after ${String(install.health.elapsedMs)} ms`,
  );
  const detected = installedDaemonFormat(stateDir);
  require(detected.installed &&
    detected.format === 1 &&
    detected.runtimeDir ===
      install.runtimeDir, "daemon.json's runtime_dir leads to a runtime that reads format 1, which is what every command below asks");
  const answering = await askHealthz();
  require(answering.status === "ok" &&
    answering.version ===
      PRE_CUT_VERSION, `the pre-cut daemon answers /healthz ok as ${answering.version} before anything is run`);

  const baseline: Baseline = {
    marker: digestOf(toolchainMarkerPath(stateDir)),
    entries: readDirectorySorted(stateDir),
    slots: readDirectorySorted(stagedRuntimeRoot(stateDir)),
    run: runIdOf(stateDir),
  };
  const interpreter = join(current.outDir, current.manifest.launch.interpreter);
  const entry = join(current.outDir, current.manifest.launch.entry);

  say("");
  say("case 1 — this build's `xplainer update`, under the pre-cut daemon (D2 (b))");
  const updated = runThisBuild(interpreter, entry, ["update"]);
  require(updated.status ===
    PRECONDITION_UNMET, `it exited ${String(updated.status)}, ADR 0020 §6's code for a precondition that is not met`);
  require(updated.stderr.includes("xplainer update: the daemon installed in ") &&
    updated.stderr.includes(
      "reads toolchain.json format 1",
    ), "stderr names the installed daemon and the format its runtime reads");
  require(updated.stderr.includes(
    REINSTALL,
  ), "and prints the reinstall — daemon uninstall, setup, daemon install — without running it");
  require(updated.stdout ===
    "", "stdout is empty: not the `setup` step's output, not the report every finished step prints — it stopped before setup");
  await requireUntouched(baseline, "after `xplainer update`");

  say("");
  say("case 2 — this build's `xplainer setup`, under the pre-cut daemon (D2 (c))");
  const setup = runThisBuild(interpreter, entry, ["setup", "--manifest", COMMITTED_MANIFEST]);
  require(setup.status ===
    PRECONDITION_UNMET, `it exited ${String(setup.status)}, ADR 0020 §6's code for a precondition that is not met`);
  require(setup.stderr.includes("xplainer setup: the daemon installed in ") &&
    setup.stderr.includes(REINSTALL), "stderr names the daemon and prints the same reinstall");
  require(setup.stdout === "", "stdout is empty: no state directory line, no acquisition began");
  await requireUntouched(baseline, "after `xplainer setup`");

  say("");
  say("case 3 — `daemon update` to this build's payload, across the cut (D2 (a))");
  const crossed = await updateDaemon({
    stateDir,
    from: current.outDir,
    environment,
    run: probe,
  }).then(
    () => null,
    (thrown: unknown) => thrown,
  );
  if (!(crossed instanceof UpdateRefusal)) {
    throw new Error(
      `FAILED: the update was expected to refuse and it ${
        crossed === null ? "succeeded" : `threw ${String(crossed)}`
      }`,
    );
  }
  say(`    ${crossed.message.split("\n")[0] ?? ""}`);
  require(crossed.exitCode === PRECONDITION_UNMET &&
    crossed.phase ===
      "precondition", "it refused with 3 in the precondition, before anything was staged or drained");
  require(crossed.message.includes("reads toolchain.json format 1") &&
    crossed.message.includes("reads format 2") &&
    crossed.message.includes(
      "crossed forwards",
    ), "the message names both formats and the direction it would have crossed in");
  await requireUntouched(baseline, "after `daemon update`");

  say("");
  say("PROOF PASSED");
} catch (error) {
  process.exitCode = 1;
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
} finally {
  say(deregisterThrowaway({ label: THROWAWAY_LABEL, environment, uid }));
  removeScratchRoot(root);
  say(`cleaned up ${root}`);
}
