/**
 * `daemon install` against a **real** service manager, on the two platforms this machine can reach.
 *
 * `install.test.ts` proves the ordering, the recording and the rollback against a supervisor whose
 * `run` is a seam. That seam is what makes three platforms checkable from one machine, and it is
 * also the one thing it cannot prove: that `launchd` accepts the plist this project renders, and
 * that `systemd` starts the unit it writes **after the user manager has been restarted with nobody
 * logged in**. Those are properties of somebody else's software, and the only way to establish them
 * is to hand it the file.
 *
 * So this is a proof rather than a test: it is a script, it exits `0` only when every expectation
 * held, and it prints the transcript that is the evidence. It is **not** part of `pnpm verify`,
 * because it writes to the machine's own service manager.
 *
 * ```sh
 * # macOS, on this machine, under a throwaway label and a throwaway home:
 * node --import apps/cli/src/daemon/testing/ts-source-hook.ts \
 *   apps/cli/src/install/testing/supervisor-proof.ts
 *
 * # Linux, inside the systemd container, as root, which is also the observer:
 * docker build -f infra/e2e/Dockerfile.systemd -t xplainer-p2s4-systemd "$(mktemp -d)"
 * docker run -d --name xplainer-t11 --privileged --cgroupns=host \
 *   -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
 *   -v "$PWD:/repo:ro" xplainer-p2s4-systemd
 * docker exec xplainer-t11 node --import /repo/apps/cli/src/daemon/testing/ts-source-hook.ts \
 *   /repo/apps/cli/src/install/testing/supervisor-proof.ts
 * ```
 *
 * ## macOS: a throwaway label, and a `finally` that boots it out
 *
 * The shipped renderer produces the plist; only its `Label` is rewritten, to
 * {@link THROWAWAY_LABEL}, and the shipped `registerCommands()` sequence is then run against that
 * label. Two things are being established and neither of them is about the label: that
 * `launchctl bootstrap` **accepts this document** — a plist launchd rejects is rejected whole, and
 * nothing else in this repository can find that out — and that the order `enable` → `bootstrap` →
 * `kickstart` leaves a job that answers an authenticated `GET /healthz`. Using the product's own
 * label would put a record in a real user's launchd for a measurement, which is not a trade this
 * proof needs to make: the plist's own bytes are what launchd is being asked about.
 *
 * ## Linux: the reboot-equivalent, observed from a second account
 *
 * P2-8 asks whether the daemon survives a reboot with **nobody logged in**, and the property that
 * makes that true is lingering: without it the user manager stops with the last session. So the
 * proof runs the real `installDaemon` as an unprivileged user, then — as **root**, which has opened
 * no session for that user — stops and starts `user@<uid>.service`, which is what a reboot does to
 * a per-user manager, and then asks `/healthz` with the token read out of the user's own state
 * directory. An `ssh` back as the target user would start their manager and would falsely prove
 * lingering; root's `curl` cannot.
 *
 * It is not a reboot of a real machine, and it is not claimed to be: T11-V3 is `[human]` and wants
 * a headless VM and a third host. What this settles is everything below that — the unit loads, the
 * manager restarts it with no session, and the daemon answers.
 *
 * ### Three attempts, because lingering has three real answers
 *
 * T11 criterion 4 is "lingering FIRST, enabled by the installer", and it has two refusing branches
 * that a run which simply enabled lingering beforehand would never reach. So the Linux leg arranges
 * each precondition explicitly rather than inheriting it, and the sequence is:
 *
 * 1. **No marker and no session.** There is no per-user manager to install into at all, so the
 *    *preflight* refuses with `6` — {@link NO_SUPERVISOR_EXIT_CODE} — naming `loginctl
 *    enable-linger` as the remediation, and nothing is registered.
 * 2. **The manager is up and the marker is still absent.** Root starts `user@<uid>.service`, which
 *    is what a login would have done, so the preflight passes and the install reaches its own
 *    phase 2 and really does ask logind for lingering *before* it registers anything. This image
 *    carries no polkit agent and the account has no active session, so logind answers "Access
 *    denied" — measured 2026-09-08 — and the install refuses with `5`,
 *    {@link ADMIN_REQUIRED_EXIT_CODE}, having written nothing. That is the ordering as an
 *    observation rather than as a recording seam.
 * 3. **An administrator enables lingering.** The install completes, and the reboot-equivalent and
 *    the per-item uninstall below run against it.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ADMIN_REQUIRED_EXIT_CODE, NO_SUPERVISOR_EXIT_CODE } from "../../daemon/exit-codes.js";
import { resolveIpcPath } from "../../daemon/ipc.js";
import { buildLaunchSpec } from "../../runtime/launch-spec.js";
import { InstallRefusal, installDaemon } from "../install.js";
import { launcherPath } from "../launcher.js";
import { runProbe } from "../preflight.js";
import { registerCommands } from "../register.js";
import { stagedRuntimeRoot, stageRuntime } from "../stage.js";
import { renderLaunchAgentPlist } from "../supervisors/launchd.js";
import { uninstallDaemon } from "../uninstall.js";
import { buildFixturePayload } from "./payload.js";
import { writeToolchainMarker } from "./toolchain.js";

/** The label the macOS half registers under. Never the product's, and removed in a `finally`. */
export const THROWAWAY_LABEL = "video.xplainer.t11-proof";

/** The uid whose per-user manager the Linux half restarts. The image's own `xplainer` account. */
const LINUX_UID = 1000;

/** The account the Linux half installs as. */
const LINUX_USER = "xplainer";

/** The file logind writes for a lingering account, which is what systemd itself reads at boot. */
const LINGER_MARKER = `/var/lib/systemd/linger/${LINUX_USER}`;

/** Where a completed install puts the unit, so "nothing was registered" is a `stat` on it. */
const UNIT_PATH = `/home/${LINUX_USER}/.config/systemd/user/xplainer.service`;

/** This file, so the root orchestrator can re-enter it as the unprivileged user. */
const SELF = fileURLToPath(import.meta.url);

/**
 * The source hook a child is started under, as a **file URL**.
 *
 * `--import` takes a module specifier, and an absolute Windows path is one with the scheme `c:` —
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME`, measured on `windows-latest` on 2026-09-08. `new URL(…,
 * import.meta.url).href` is a `file:` URL on every platform, so this is one spelling rather than a
 * Windows branch. {@link SELF} stays a path: an entry file is resolved, not parsed as a specifier.
 */
const HOOK = new URL("../../daemon/testing/ts-source-hook.ts", import.meta.url).href;

let failures = 0;

/** What one spawned command answered, with both streams as text. */
type Ran = { status: number | null; stdout: string; stderr: string };

/** `spawnSync` with `encoding: "utf8"`, reduced to the three fields this script reads. */
function ran(answer: {
  status: number | null;
  stdout: string | Buffer | null;
  stderr: string | Buffer | null;
}): Ran {
  return {
    status: answer.status,
    stdout: String(answer.stdout ?? ""),
    stderr: String(answer.stderr ?? ""),
  };
}

/** Record one expectation, and say what it was. */
function check(what: string, ok: boolean, detail = ""): void {
  if (!ok) {
    failures += 1;
  }
  process.stdout.write(
    `  ${ok ? "check" : "FAIL "}  ${what}${detail === "" ? "" : ` — ${detail}`}\n`,
  );
}

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Run a command and print what it said, so the transcript carries the evidence. */
function shell(program: string, argv: readonly string[], quiet = false): Ran {
  const answer = ran(spawnSync(program, [...argv], { encoding: "utf8", timeout: 120_000 }));
  if (!quiet) {
    say(`  $ ${program} ${argv.join(" ")}   -> ${String(answer.status)}`);
    for (const stream of [answer.stdout, answer.stderr]) {
      for (const outputLine of stream.split("\n")) {
        if (outputLine.trim() !== "") {
          say(`      ${outputLine}`);
        }
      }
    }
  }
  return answer;
}

/**
 * One authenticated `GET /healthz`, from **this** process — which on Linux is root's.
 *
 * T11-V3 words the observation as a `curl`, and the container this proof runs in has no `curl`:
 * `Dockerfile.systemd` installs `systemd`, `dbus`, `libpam-systemd` and `procps` and nothing else,
 * deliberately, because every package in a measurement image is one more thing that can explain a
 * result. What the criterion is actually about is **who** is asking — a second account that has
 * opened no session for the target user — and that is true of this process as much as of a `curl`
 * it would have spawned. The request is a separate short-lived connection with no pool behind it,
 * synchronously, because the caller is a script.
 */
function observeHealth(port: number, token: string): { status: number; body: string } {
  const answer = ran(
    spawnSync(
      process.execPath,
      [
        // Plain concatenation rather than template literals: this is source for another process,
        // and a `${…}` inside it would read as this file's own interpolation to every tool that
        // looks at it.
        "-e",
        "const p = process.argv[1], t = process.argv[2];" +
          "const call = require('node:http').request(" +
          "'http://127.0.0.1:' + p + '/healthz'," +
          "{ headers: { Authorization: 'Bearer ' + t }, agent: false, timeout: 4000 }," +
          "(r) => { let b = ''; r.on('data', (c) => { b += c; });" +
          "r.on('end', () => { process.stdout.write(r.statusCode + '\\n' + b); }); });" +
          "call.on('timeout', () => call.destroy());" +
          "call.on('error', () => process.stdout.write('0\\n'));" +
          "call.end();",
        String(port),
        token,
      ],
      { encoding: "utf8", timeout: 15_000 },
    ),
  );
  const lines = answer.stdout.split("\n");
  return { status: Number(lines[0] ?? "0"), body: lines.slice(1).join("\n") };
}

/** Wait for a predicate, so a restart is waited on rather than slept through. */
function waitFor(what: string, predicate: () => boolean, timeoutMs = 30_000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 200)"], { timeout: 5_000 });
  }
  say(`  timed out waiting for ${what}`);
  return false;
}

/** A payload, a state directory and a setup marker, under `root`. */
function prepare(root: string): { stateDir: string; payloadDir: string } {
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeToolchainMarker(stateDir);
  const payloadDir = buildFixturePayload({
    outDir: join(root, "payload"),
    version: "1.2.3",
    marker: "proof",
  }).outDir;
  return { stateDir, payloadDir };
}

/** macOS: hand the shipped plist to the real launchd, under a label nothing else uses. */
async function proveLaunchd(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "xplainer-t11-launchd-"));
  const home = join(root, "home");
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  const uid = process.getuid?.() ?? 0;
  const service = `gui/${String(uid)}/${THROWAWAY_LABEL}`;

  try {
    const { stateDir, payloadDir } = prepare(root);
    const staged = stageRuntime({ payloadDir, stateDir });
    const spec = buildLaunchSpec({
      runtimeDir: staged.path,
      port: 0,
      settings: {
        stateDir,
        tokenFile: join(stateDir, "token"),
        socket: resolveIpcPath(stateDir),
      },
    });
    const artefact = renderLaunchAgentPlist(spec, { home, account: LINUX_USER });
    // The shipped bytes, with one substitution, named here rather than hidden: the label.
    const plist = artefact.contents.replace(
      `<key>Label</key><string>${artefact.identity}</string>`,
      `<key>Label</key><string>${THROWAWAY_LABEL}</string>`,
    );
    check("the label substitution applied", plist.includes(THROWAWAY_LABEL));
    const plistPath = join(home, "Library", "LaunchAgents", `${THROWAWAY_LABEL}.plist`);
    writeFileSync(plistPath, plist, { mode: 0o600 });

    say(`\nlaunchd, the shipped sequence, against ${service}:`);
    for (const step of registerCommands({
      kind: "launchd",
      identity: THROWAWAY_LABEL,
      artefact: plistPath,
      uid,
    })) {
      const answer = shell(step.command.program, step.command.argv);
      check(
        `${step.command.argv[0]} ${step.tolerated === true ? "(tolerated)" : ""}`.trim(),
        step.tolerated === true || answer.status === 0,
        `exit ${String(answer.status)}`,
      );
    }

    const ready = waitFor("runtime.json", () => existsSync(join(stateDir, "runtime.json")));
    check("launchd started the job it bootstrapped", ready);
    if (ready) {
      const runtime = JSON.parse(readFileSync(join(stateDir, "runtime.json"), "utf8")) as {
        port: number;
      };
      const token = readFileSync(join(stateDir, "token"), "utf8").trim();
      const unauthorised = observeHealth(runtime.port, "not-the-token");
      check(
        "an unauthenticated probe is refused",
        unauthorised.status === 401,
        String(unauthorised.status),
      );
      const health = observeHealth(runtime.port, token);
      say(`  GET /healthz -> ${String(health.status)} ${health.body}`);
      check("the job answered an authenticated GET /healthz", health.status === 200);
    }

    // T11 criterion 8 — "every path the uninstall promises to remove is gone, observed per item" —
    // is **not** proven on this leg, and that is a statement rather than a silence. This function
    // registers the plist through `registerCommands()` directly, so there is no `daemon.json`
    // install record for `uninstallDaemon()` to read, and giving it one would mean running the
    // real `installDaemon()` under the *product's* own label in a real user's launchd — which the
    // header of this file refuses on purpose. The criterion is proven per item against a real
    // service manager on the systemd leg below, and against the recording `run` seam on all three
    // platforms in `uninstall.test.ts`.
    say(
      "\nnot proven here: T11 criterion 8, the per-item uninstall. The systemd leg below observes " +
        "every promised path, and `uninstall.test.ts` covers all three platforms through the seam.",
    );
  } finally {
    say("\ntearing the throwaway job down:");
    shell("launchctl", ["bootout", service]);
    rmSync(root, { recursive: true, force: true });
    const remaining = ran(spawnSync("launchctl", ["print", service], { encoding: "utf8" }));
    check(
      "the throwaway job is no longer loaded",
      remaining.status !== 0,
      `launchctl print exited ${String(remaining.status)}`,
    );
  }
}

/**
 * The port the Linux install records.
 *
 * Fixed rather than ephemeral, because the whole point of the restart is that a **second account**
 * can find the daemon again afterwards, and `--port 0` gives a different port on every start: the
 * observer would be polling the one the first run happened to get. A recorded port is what ADR 0020
 * means by "the recorded port is a contract", and it is what an installed daemon actually has.
 */
const LINUX_PROOF_PORT = 18787;

/** Linux, as the unprivileged user: the real install, reporting where it landed. */
async function installAsUser(): Promise<void> {
  const root = join(process.env.HOME ?? "/tmp", "t11-proof");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const { stateDir, payloadDir } = prepare(root);
  let outcome: Awaited<ReturnType<typeof installDaemon>>;
  try {
    outcome = await installDaemon({
      stateDir,
      payloadDir,
      port: LINUX_PROOF_PORT,
      run: runProbe,
      healthTimeoutMs: 30_000,
      log: (entry) => {
        say(`    ${entry}`);
      },
    });
  } catch (error) {
    // Exactly what `commands/daemon.ts` does with the same error: the documented exit code is the
    // refusal's own, and a proof that let the process exit `1` would be measuring the harness.
    if (error instanceof InstallRefusal) {
      say(error.message);
      for (const undone of error.undone) {
        say(`  rolled back: ${undone}`);
      }
      process.exit(error.exitCode);
    }
    throw error;
  }
  process.stdout.write(
    `PROOF-JSON ${JSON.stringify({
      stateDir,
      port: outcome.health.port,
      tokenFile: outcome.health.tokenFile,
      artefact: outcome.artefact,
      lingerEnabledByUs: outcome.linger.enabledByUs,
    })}\n`,
  );
}

/**
 * Linux, as the unprivileged user: the real uninstall, reporting **every** path it promises.
 *
 * The whole report rather than the paths that existed, because T11 criterion 8 is an assertion per
 * item and the observer is root: it re-`stat`s each path itself afterwards. A list filtered to what
 * was there cannot be checked that way — an entry missing from it is indistinguishable from a path
 * the uninstall never considered.
 */
function uninstallAsUser(stateDir: string): void {
  const outcome = uninstallDaemon({ stateDir, run: runProbe });
  process.stdout.write(
    `PROOF-JSON ${JSON.stringify({
      tokenDeleted: outcome.token.deleted,
      linger: outcome.linger.detail,
      removed: outcome.removed.map((entry) => ({
        what: entry.what,
        path: entry.path,
        existed: entry.existed,
        error: entry.error ?? null,
      })),
    })}\n`,
  );
}

/** Run this same script as the unprivileged user, inside their own manager's environment. */
function asUser(args: readonly string[]): Ran {
  return ran(
    spawnSync(
      "runuser",
      ["-u", LINUX_USER, "--", process.execPath, "--import", HOOK, SELF, ...args],
      {
        encoding: "utf8",
        timeout: 300_000,
        env: {
          ...process.env,
          HOME: `/home/${LINUX_USER}`,
          XDG_RUNTIME_DIR: `/run/user/${String(LINUX_UID)}`,
          DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${String(LINUX_UID)}/bus`,
        },
      },
    ),
  );
}

/** The one `PROOF-JSON` line a child printed, or `null`. */
function reported<T>(answer: Ran): T | null {
  const found = answer.stdout.split("\n").find((entry) => entry.startsWith("PROOF-JSON "));
  return found === undefined ? null : (JSON.parse(found.slice("PROOF-JSON ".length)) as T);
}

/**
 * Both of a child's streams, because a refusal's sentence is on the one `commands/daemon.ts` uses.
 *
 * {@link installAsUser} prints an `InstallRefusal`'s message with the same `say` it prints
 * everything else with — stdout — and the child's stderr carries only what the runtime wrote. A
 * check written against `stderr` alone therefore asserted against an empty string, which is how it
 * passed vacuously for the wrong reason before 2026-09-08.
 */
function said(answer: Ran): string {
  return `${answer.stdout}\n${answer.stderr}`;
}

/** Linux, as root: install as somebody else, restart their manager, then observe. */
async function proveSystemd(): Promise<void> {
  say("\nsystemd, inside the container, as root — which is also the observer:");

  // The three attempts below are a sequence, and each one's *precondition* is arranged here rather
  // than inherited, so that a second run inside a container the proof has already used measures the
  // same three things as the first. `disable-linger` and stopping the manager are the two facts
  // attempt 1 turns on, and the uninstall at the end deliberately leaves lingering enabled.
  say("\nresetting the two preconditions attempt 1 turns on:");
  shell("loginctl", ["disable-linger", LINUX_USER]);
  shell("systemctl", ["stop", `user@${String(LINUX_UID)}.service`]);
  check(
    "no linger marker and no session, so this user has no manager at all",
    !existsSync(LINGER_MARKER) && loginSessions(LINUX_USER) === 0,
  );

  // Attempt 1 — the *preflight's* refusal, which comes before the install's own linger step: with
  // no marker and no session there is no per-user manager to install into at all, and ADR 0020's
  // code for "this machine offers no supervisor" is 6. It was written here as 5 until 2026-09-08,
  // which is a code this branch has never produced.
  say("\nattempt 1 — no marker and no session, so there is no user manager to install into:");
  const first = asUser(["--install"]);
  say(first.stdout.trimEnd());
  say(`  the install exited ${String(first.status)}:`);
  say(first.stderr.trimEnd());
  check(
    "an install with no user service manager refuses with the documented no-supervisor code 6",
    first.status === NO_SUPERVISOR_EXIT_CODE,
    `exit ${String(first.status)}`,
  );
  check(
    "and the refusal names lingering as the remediation rather than `--spawn` alone",
    said(first).includes(`sudo loginctl enable-linger ${LINUX_USER}`),
  );
  check("nothing was registered by the refused install", !existsSync(UNIT_PATH));

  // Attempt 2 — T11 criterion 4's own branch, "lingering FIRST, enabled by the installer", against
  // real logind. Root starts the per-user manager, which is what a login would have done, and
  // leaves the marker absent: the preflight now passes, so the install reaches its own phase 2 and
  // really does run `loginctl --no-ask-password enable-linger` before it registers anything. This
  // image has no polkit agent and the account has no active session, so logind answers "Access
  // denied" — measured 2026-09-08 — and the documented code for "the supervisor is here and
  // refused" is 5. What that establishes is the **ordering**: the step ran first, and its refusal
  // left no unit behind.
  say("\nattempt 2 — the manager is up and the marker is absent, so the install must enable it:");
  shell("systemctl", ["start", `user@${String(LINUX_UID)}.service`]);
  check(
    "root started the manager without opening a session or writing a marker",
    !existsSync(LINGER_MARKER) && loginSessions(LINUX_USER) === 0,
  );
  const second = asUser(["--install"]);
  say(second.stdout.trimEnd());
  say(`  the install exited ${String(second.status)}:`);
  say(second.stderr.trimEnd());
  check(
    "the install asked logind for lingering before registering anything",
    second.stdout.includes(`lingering: ${LINGER_MARKER} is absent, asking logind for it`),
  );
  check(
    "and logind's own refusal is the install's: the documented administrator code 5",
    second.status === ADMIN_REQUIRED_EXIT_CODE,
    `exit ${String(second.status)}`,
  );
  check(
    "the refusal quotes what loginctl said and asks an administrator for the same command",
    said(second).includes("lingering could not be enabled") &&
      said(second).includes(`sudo loginctl enable-linger ${LINUX_USER}`),
  );
  check("still nothing registered: the linger step really is first", !existsSync(UNIT_PATH));

  // Attempt 3 — the administrator does what both refusals asked for, and the install proceeds.
  say("\nattempt 3 — an administrator enables lingering, which is what the refusals asked for:");
  shell("loginctl", ["enable-linger", LINUX_USER]);
  check("the marker logind writes is there now", existsSync(LINGER_MARKER));
  const install = asUser(["--install"]);
  say(install.stdout.trimEnd());
  const installed = reported<{
    stateDir: string;
    port: number;
    tokenFile: string;
    artefact: string;
  }>(install);
  if (install.status !== 0 || installed === null) {
    say(install.stderr.trimEnd());
    check(
      "the install completed as the unprivileged user",
      false,
      `exit ${String(install.status)}`,
    );
    return;
  }
  check("the install completed as the unprivileged user", true, `port ${String(installed.port)}`);
  check("the unit is where systemd looks", existsSync(installed.artefact), installed.artefact);

  const token = readFileSync(installed.tokenFile, "utf8").trim();
  const before = observeHealth(installed.port, token);
  check(
    "root can reach the daemon before the restart",
    before.status === 200,
    String(before.status),
  );

  // The reboot-equivalent: a per-user manager is what a reboot takes away, and lingering is what
  // brings it back with nobody logged in.
  say("\nrestarting the per-user manager, which is what a reboot does to it:");
  shell("systemctl", ["stop", `user@${String(LINUX_UID)}.service`]);
  check(
    "the daemon is gone while the manager is down",
    waitFor(
      "the port to go quiet",
      () => observeHealth(installed.port, token).status !== 200,
      20_000,
    ),
  );
  shell("systemctl", ["start", `user@${String(LINUX_UID)}.service`]);

  // No session is opened for the target user anywhere in this function: root is a second account,
  // and an `ssh` back as the user would start their manager and prove nothing.
  const restarted = waitFor(
    "the daemon to answer again",
    () => observeHealth(installed.port, token).status === 200,
    60_000,
  );
  const after = observeHealth(installed.port, token);
  say(`  GET /healthz -> ${String(after.status)} ${after.body}`);
  check("the daemon came back with nobody logged in", restarted && after.status === 200);
  check("root opened no session for the target user", loginSessions(LINUX_USER) === 0);

  // T11 criterion 8 is per item, so what the daemon has on disk *now* is read before the uninstall
  // and each path is re-`stat`ed by root afterwards. The IPC socket is named explicitly because it
  // is the one entry a report of "what existed" would quietly drop on a platform whose socket lives
  // outside the state directory, and because it is the live surface the uninstall is about.
  //
  // `owner.lock` is deliberately not in this list and *is* in the accounted-for list below: the
  // payload this proof installs is `testing/payload.ts`'s fixture, whose entry is a miniature daemon
  // that binds, answers `/healthz` and writes `runtime.json` without taking the ownership lock the
  // real `serve` takes. Asserting a file the program under test never writes would be asserting
  // against the fixture; the promise itself is still checked, by the absence and receipt loops.
  const socket = resolveIpcPath(installed.stateDir);
  say("\nwhat is on disk before the uninstall:");
  const beforeUninstall = [
    ["the systemd unit", installed.artefact],
    ["the IPC socket", socket],
    ["the bearer token", installed.tokenFile],
    ["this run's ephemeral record", join(installed.stateDir, "runtime.json")],
    ["the installer's record", join(installed.stateDir, "daemon.json")],
    ["every staged runtime", stagedRuntimeRoot(installed.stateDir)],
    ["the stable launcher", launcherPath(installed.stateDir, "linux")],
  ] as const;
  for (const [what, path] of beforeUninstall) {
    check(`${what} is there to remove: ${path}`, existsSync(path));
  }

  say("\nuninstalling:");
  const removed = asUser(["--uninstall", installed.stateDir]);
  say(removed.stdout.trimEnd());
  const removedReport = reported<{
    tokenDeleted: boolean;
    linger: string;
    removed: { what: string; path: string; existed: boolean; error: string | null }[];
  }>(removed);
  check("the uninstall completed", removed.status === 0, `exit ${String(removed.status)}`);
  check("the token was deleted", removedReport?.tokenDeleted === true);

  // Every path the uninstall *promises*, observed by root rather than read off its own report: a
  // command's list of what it removed is its own account of itself, and the criterion asks whether
  // the paths are gone.
  const promised = removedReport?.removed ?? [];
  check("the uninstall reported the paths it promises", promised.length > 0);
  for (const entry of promised) {
    check(
      `${entry.what} is gone: ${entry.path}${entry.existed ? "" : " (nothing was there)"}`,
      !existsSync(entry.path) && entry.error === null,
    );
  }
  for (const [what, path] of [
    ...beforeUninstall,
    // Promised and never written by the fixture daemon, for the reason above; the receipt has to
    // account for it all the same, because the real `serve` does write it.
    ["the ownership artefact", join(installed.stateDir, "owner.lock")] as const,
  ]) {
    check(
      `${what} is one of the paths the uninstall accounted for`,
      promised.some((entry) => entry.path === path),
      path,
    );
  }

  check(
    "lingering is still enabled after the uninstall",
    existsSync(`/var/lib/systemd/linger/${LINUX_USER}`),
  );
  check("the daemon is no longer answering", observeHealth(installed.port, token).status !== 200);
}

/** How many login sessions the target user has, so "nobody logged in" is a measurement. */
function loginSessions(user: string): number {
  const answer = ran(spawnSync("loginctl", ["list-sessions", "--no-legend"], { encoding: "utf8" }));
  return answer.stdout.split("\n").filter((entry) => entry.includes(user)).length;
}

const uninstallAt = process.argv.indexOf("--uninstall");
if (process.argv.includes("--install")) {
  await installAsUser();
} else if (uninstallAt >= 0) {
  uninstallAsUser(process.argv[uninstallAt + 1] ?? "");
} else {
  say(`T11 supervisor proof — ${process.platform}, node ${process.version}`);
  if (process.platform === "darwin") {
    await proveLaunchd();
  } else if (process.platform === "linux") {
    await proveSystemd();
  } else {
    say(`nothing to prove on ${process.platform}`);
  }
  say(`\n${failures === 0 ? "PASSED" : `FAILED: ${String(failures)} expectation(s)`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}
