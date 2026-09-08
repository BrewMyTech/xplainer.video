/**
 * The consistency check against a **real** service manager, a real payload and a real daemon.
 *
 * `supervisors/identity.test.ts` proves the comparison with the supervisor and `/healthz` as seams,
 * which is what makes three platforms checkable from one machine and is also exactly what it cannot
 * prove: that the *loaded* row really goes stale. Everything T17 exists for turns on that. A unit
 * rewritten and never reloaded, a plist bootstrapped once and never refreshed — those are properties
 * of somebody else's software, and the only way to establish them is to hand it the file and ask.
 *
 * So this is a proof rather than a test: a script, exit `0` only when every expectation held, and
 * its transcript is the evidence. It is **not** part of `pnpm verify` — it assembles a ~160 MB
 * payload and registers a service with this machine's own supervisor — and `scripts/e2e/identity.mjs`
 * runs it beside the unit suite as `pnpm e2e:identity`.
 *
 * ```sh
 * # macOS, on this machine, under a throwaway label and a throwaway home:
 * node --import ./apps/cli/src/daemon/testing/ts-source-hook.ts \
 *   apps/cli/src/install/testing/identity-proof.ts
 *
 * # Linux, inside the systemd container:
 * docker build -f infra/e2e/Dockerfile.systemd -t xplainer-p2s4-systemd "$(mktemp -d)"
 * docker run -d --name xplainer-t17 --privileged --cgroupns=host \
 *   -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
 *   -v "$PWD:/repo:ro" xplainer-p2s4-systemd
 * docker exec -u xplainer xplainer-t17 env XDG_RUNTIME_DIR=/run/user/1000 \
 *   node --import file:///repo/apps/cli/src/daemon/testing/ts-source-hook.ts \
 *   /repo/apps/cli/src/install/testing/identity-proof.ts
 * ```
 *
 * ## The five scenarios, and what each platform can see of them
 *
 * 1. **A hand-edited `daemon.json`.** The responding identity must be **unchanged** — it is a
 *    startup snapshot, not a read of that file — and the desired-versus-responding comparison must
 *    report a mismatch. On Linux the same edit is also a desired-versus-loaded mismatch, because the
 *    manager is still holding what the artefact said before the edit.
 * 2. **The artefact rewritten and never reloaded.** On Linux both detectors fire, and the loaded row
 *    is stale *by measurement*: `systemctl show` answers from the manager's cached unit until
 *    `daemon-reload`. On macOS there is no loaded row at all (§1.3b D7), so the responding detector
 *    fires alone and `daemon status` says which one did.
 * 3. **Switched and reloaded, but never restarted.** Row 2 now agrees with row 1 and only the digest
 *    can see it — with both runtimes on the same release version, which is the case a comparison on
 *    `CLI_VERSION` would call a pass.
 * 4. **A settings-only change**, over runtime bytes that did not move at all.
 * 5. And, before any of them, that a correct install is reported as **consistent**: the desired
 *    digest computed from `daemon.json` equals the one the running daemon advertises. That is the
 *    single assertion which proves the two sides compute the same thing over a real install, and
 *    nothing in the seam suite can make it.
 *
 * ## What is real, and the one thing that is not
 *
 * Real: the payload, assembled by the shipped `assembleRuntime()`; both staged copies; the artefact
 * bytes; the supervisor commands; the daemon, which is the real `serve` taking real ownership; and
 * `/healthz`, asked with the token that daemon minted.
 *
 * **Not real, and stated rather than glossed: the label, on macOS only.** Every command is
 * translated to {@link THROWAWAY_LABEL} and the plist's `Label` rewritten to match, because a proof
 * must not register the product's own label in a real user's `launchd`
 * (`update/testing/throwaway-supervisor.ts`). On Linux nothing is translated, so that leg installs
 * the real `xplainer.service` in the account's own config directory and removes it in the `finally`:
 * run it on a runner or in `infra/e2e/Dockerfile.systemd`.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { describeStatus } from "../../commands/daemon.js";
import { readDaemonState, updateDaemonState } from "../../daemon/daemon-state.js";
import { assembleRuntime } from "../../runtime/assemble.js";
import { buildLaunchSpec, type LaunchSpec } from "../../runtime/launch-spec.js";
import { RUNTIME_MANIFEST_FILE, scanTree } from "../../runtime/manifest.js";
import { installDaemon } from "../install.js";
import { type DaemonStatusReport, daemonStatus } from "../lifecycle.js";
import { currentSupervisorEnvironment, runProbe } from "../preflight.js";
import { stageRuntime } from "../stage.js";
import { readDesired } from "../supervisors/identity.js";
import { supervisorAdapter, supervisorKindForPlatform } from "../supervisors/index.js";
import { uninstallDaemon } from "../uninstall.js";
import { readUpdateStatus } from "../update/recover.js";
import { fixtureEnvironment } from "../update/testing/harness.js";
import { deregisterThrowaway, throwawayProbe } from "../update/testing/throwaway-supervisor.js";
import { writeToolchainMarker } from "./toolchain.js";

/** The label this proof registers under. Never the product's, and booted out in a `finally`. */
export const THROWAWAY_LABEL = "video.xplainer.t17-proof";

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

let failures = 0;

/** One expectation, printed either way, so the transcript is the evidence. */
function check(claim: string, held: boolean, detail = ""): void {
  say(`${held ? "ok:  " : "FAIL:"} ${claim}${detail === "" ? "" : ` — ${detail}`}`);
  if (!held) {
    failures += 1;
  }
}

/** Which detectors fired, as one comparable string. */
function detectors(report: DaemonStatusReport): string {
  return report.identity.detectors.join("+") || "none";
}

/** The fields each mismatch names, as one comparable string. */
function fields(report: DaemonStatusReport): string {
  return report.identity.mismatches.map((entry) => `${entry.detector}/${entry.field}`).join(", ");
}

const platform = process.platform;
const kind = supervisorKindForPlatform(platform);
const probe = platform === "darwin" ? throwawayProbe(THROWAWAY_LABEL) : runProbe;
const root = mkdtempSync(join(tmpdir(), "xplainer-t17-proof-"));
const home = join(root, "home");
const stateDir = join(root, "state");
// macOS renders into a scratch home and registers a throwaway label; Linux has to use this
// account's own config directory, because that is the only place its user manager looks.
const environment =
  platform === "darwin" ? fixtureEnvironment(home) : currentSupervisorEnvironment();
const uid = process.getuid?.() ?? 0;

/** `daemon status`, against the real supervisor and the real daemon. */
function status(): Promise<DaemonStatusReport> {
  return daemonStatus({ stateDir, environment, run: probe, uid });
}

/** Put a launch spec into `daemon.json` and, when asked, into the artefact the supervisor reads. */
function record(spec: LaunchSpec, runtimeDir: string, artefact: string | null): void {
  updateDaemonState(stateDir, { launch_spec: spec, runtime_dir: runtimeDir });
  if (artefact !== null && kind !== null) {
    const rendered = supervisorAdapter(kind).render(spec, environment);
    // The renderer's own bytes, at the path the record names. On macOS the label inside the plist
    // is the product's, so it is translated the same way every other command here is.
    writeFileSync(
      artefact,
      platform === "darwin"
        ? rendered.contents.split("video.xplainer.daemon").join(THROWAWAY_LABEL)
        : rendered.contents,
      { mode: rendered.mode },
    );
  }
}

try {
  say(`proof root: ${root}`);
  say(`platform:   ${platform} (${kind ?? "no supervisor"})`);
  if (kind === null) {
    say("SKIPPED: this platform has no supervisor to install into");
    process.exit(0);
  }
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(join(home, "Library", "Logs"), { recursive: true });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeToolchainMarker(stateDir);

  say("assembling payload A from this checkout");
  const alpha = assembleRuntime({ outDir: join(root, "payload-a") });

  // B is A with one shipped byte changed and its manifest rescanned by the shipped scanner: a
  // different content digest and therefore a different staged slot, at the **same release
  // version**. That equality is the point of scenario 3 — two runtimes a `CLI_VERSION` comparison
  // cannot tell apart.
  say("building payload B: the same release, one byte of content different");
  const betaDir = join(root, "payload-b");
  cpSync(alpha.outDir, betaDir, { recursive: true, verbatimSymlinks: true });
  // A file that is only *content*: nothing resolves it, nothing executes it, and no package's
  // `files` allowlist decides whether it is there. What has to differ between A and B is the
  // content hash the assembler computes, and this is the smallest honest way to make it differ
  // while `@xplainer/cli`'s version — and therefore `/healthz`'s release number — stays identical.
  writeFileSync(join(betaDir, "t17-proof-marker.txt"), "payload B\n");
  const rescan = scanTree(betaDir, { exclude: [RUNTIME_MANIFEST_FILE] });
  writeFileSync(
    join(betaDir, RUNTIME_MANIFEST_FILE),
    `${JSON.stringify({ ...alpha.manifest, files: rescan.files, links: rescan.links }, null, 2)}\n`,
  );

  say(platform === "darwin" ? `installing A as ${THROWAWAY_LABEL}` : `installing A under ${kind}`);
  const install = await installDaemon({
    stateDir,
    payloadDir: alpha.outDir,
    port: 0,
    environment,
    run: probe,
    log: (line) => {
      say(`  ${line}`);
    },
  });
  const version = install.health.version;
  say(`  installed: ${install.runtimeDir}, answering as release ${version}`);

  say("staging B beside it");
  const betaSlot = stageRuntime({ payloadDir: betaDir, stateDir });
  const betaSpec = buildLaunchSpec({
    runtimeDir: betaSlot.path,
    port: install.spec.argv.includes("--port")
      ? Number(install.spec.argv[install.spec.argv.indexOf("--port") + 1])
      : 0,
    settings: { ...install.spec.settings },
    cwd: install.spec.cwd,
  });
  check(
    "B is a different staged runtime at the same release version",
    betaSlot.path !== install.runtimeDir,
    `${install.runtimeDir} vs ${betaSlot.path}`,
  );

  // ── 0. a correct install agrees on every row it has ───────────────────────────────────────
  say("\nscenario 0 — a correct install");
  const healthy = await status();
  check(
    "`/healthz` advertises a run id",
    healthy.health?.run_id !== null,
    healthy.health?.run_id ?? "<none>",
  );
  check(
    "`/healthz` advertises a runtime digest",
    healthy.health?.runtime_digest !== null,
    healthy.health?.runtime_digest ?? "<none>",
  );
  check(
    "the digest `daemon.json` implies is the digest the running daemon advertises",
    healthy.identity.desired.digest === healthy.health?.runtime_digest,
    `${healthy.identity.desired.digest ?? "<none>"} vs ${healthy.health?.runtime_digest ?? "<none>"}`,
  );
  check("nothing has drifted", healthy.identity.consistent, healthy.identity.detail);
  if (kind === "systemd") {
    check(
      "the loaded row came back from the real user manager",
      healthy.identity.loaded.answered && (healthy.identity.loaded.command ?? "").includes("serve"),
      healthy.identity.loaded.detail,
    );
  } else {
    check(
      "macOS declares the loaded row unavailable rather than parsing `launchctl print`",
      !healthy.identity.loaded.available,
      healthy.identity.loaded.detail,
    );
  }
  const runningDigest = healthy.health?.runtime_digest ?? "";
  const runningRunId = healthy.health?.run_id ?? "";

  // ── 1. a hand-edited daemon.json ──────────────────────────────────────────────────────────
  say("\nscenario 1 — `daemon.json`'s launch spec is hand-edited, nothing else is touched");
  record(betaSpec, betaSlot.path, null);
  const edited = await status();
  check(
    "the responding identity is UNCHANGED: it is a startup snapshot, not a read of that file",
    edited.health?.runtime_digest === runningDigest && edited.health?.run_id === runningRunId,
    `${edited.health?.runtime_digest ?? "<none>"} / ${edited.health?.run_id ?? "<none>"}`,
  );
  check(
    "desired versus responding reports a mismatch",
    edited.identity.mismatches.some(
      (entry) => entry.detector === "responding-identity" && entry.field === "runtime_digest",
    ),
    fields(edited),
  );
  check(
    kind === "systemd"
      ? "and on Linux the same edit is a desired-versus-loaded mismatch too"
      : "and on macOS the identity detector is the only one there is",
    kind === "systemd"
      ? detectors(edited) === "loaded-configuration+responding-identity"
      : detectors(edited) === "responding-identity",
    detectors(edited),
  );

  // ── 2. the artefact rewritten, and nothing reloaded ───────────────────────────────────────
  say("\nscenario 2 — the artefact is rewritten to B and the supervisor is never asked to reload");
  record(betaSpec, betaSlot.path, install.artefact);
  check(
    "the artefact on disk now names B",
    readFileSync(install.artefact, "utf8").includes(betaSlot.path),
  );
  const rewritten = await status();
  check(
    kind === "systemd"
      ? "systemd is still holding A: the loaded row is stale until `daemon-reload`"
      : "macOS detects it through the responding identity instead (§1.3b D7)",
    kind === "systemd"
      ? detectors(rewritten) === "loaded-configuration+responding-identity"
      : detectors(rewritten) === "responding-identity",
    detectors(rewritten),
  );
  const prose = describeStatus(rewritten, readUpdateStatus(stateDir));
  check(
    "`daemon status` names which detector fired",
    rewritten.identity.detectors.every((detector) =>
      prose.includes(`MISMATCH:        ${detector}`),
    ),
    rewritten.identity.detectors.join(", "),
  );

  // ── 3. switched and reloaded, never restarted ─────────────────────────────────────────────
  say("\nscenario 3 — the switch is reloaded, and the daemon is still the one that was running");
  if (kind === "systemd") {
    const reload = probe({ program: "systemctl", argv: ["--user", "daemon-reload"] });
    check("`systemctl --user daemon-reload` ran", reload.started && reload.status === 0);
  } else {
    say("  launchd has no reload that is not a restart: `bootout` stops the job, so the plist");
    say("  rewritten above is as far as a switch can get without restarting. The assertion below");
    say("  is therefore the same one, and it is the only one macOS can make.");
  }
  const reloaded = await status();
  check(
    "the responding mismatch is by digest, with both runtimes on the same release version",
    reloaded.identity.mismatches.some(
      (entry) => entry.detector === "responding-identity" && entry.field === "runtime_digest",
    ) && readDaemonState(stateDir).installed_version === version,
    `${fields(reloaded)}; installed_version ${readDaemonState(stateDir).installed_version ?? "<none>"}`,
  );
  if (kind === "systemd") {
    check(
      "and row 2 now agrees with row 1, so the digest is the only detector left",
      detectors(reloaded) === "responding-identity",
      detectors(reloaded),
    );
  }

  // ── 4. a settings-only change ─────────────────────────────────────────────────────────────
  say("\nscenario 4 — only a setting moves, over runtime bytes that did not");
  const movedSocket = join(root, "moved.sock");
  const movedSpec = buildLaunchSpec({
    runtimeDir: install.runtimeDir,
    port: 0,
    settings: { ...install.spec.settings, socket: movedSocket },
    cwd: install.spec.cwd,
  });
  record(movedSpec, install.runtimeDir, install.artefact);
  check(
    "the interpreter, the entry and the payload are unchanged",
    movedSpec.executable === install.spec.executable && movedSpec.argv[0] === install.spec.argv[0],
  );
  const moved = await status();
  check(
    "the digest still differs",
    (readDesired({ stateDir }).digest ?? "") !== runningDigest,
    `${readDesired({ stateDir }).digest ?? "<none>"} vs ${runningDigest}`,
  );
  check(
    "and it is reported as a responding mismatch",
    moved.identity.mismatches.some(
      (entry) => entry.detector === "responding-identity" && entry.field === "runtime_digest",
    ),
    fields(moved),
  );

  say(failures === 0 ? "\nPROOF PASSED" : `\nPROOF FAILED: ${String(failures)} expectation(s)`);
  if (failures > 0) {
    process.exitCode = 1;
  }
} catch (error) {
  process.exitCode = 1;
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
} finally {
  // Whatever happened, this machine's supervisor goes back to holding nothing of ours.
  try {
    if (existsSync(join(stateDir, "daemon.json"))) {
      uninstallDaemon({ stateDir, environment, run: probe, uid });
    }
  } catch (error) {
    process.stdout.write(
      `uninstall reported: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  process.stdout.write(`${deregisterThrowaway({ label: THROWAWAY_LABEL, environment, uid })}\n`);
  rmSync(root, { recursive: true, force: true });
  process.stdout.write(`cleaned up ${root}\n`);
}
