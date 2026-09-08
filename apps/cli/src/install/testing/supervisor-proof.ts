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
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveIpcPath } from "../../daemon/ipc.js";
import { buildLaunchSpec } from "../../runtime/launch-spec.js";
import { InstallRefusal, installDaemon } from "../install.js";
import { runProbe } from "../preflight.js";
import { registerCommands } from "../register.js";
import { stageRuntime } from "../stage.js";
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

/** Linux, as the unprivileged user: the real uninstall, reporting what it left. */
function uninstallAsUser(stateDir: string): void {
  const outcome = uninstallDaemon({ stateDir, run: runProbe });
  process.stdout.write(
    `PROOF-JSON ${JSON.stringify({
      tokenDeleted: outcome.token.deleted,
      linger: outcome.linger.detail,
      removed: outcome.removed.filter((entry) => entry.existed).map((entry) => entry.path),
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

/** Linux, as root: install as somebody else, restart their manager, then observe. */
async function proveSystemd(): Promise<void> {
  say("\nsystemd, inside the container, as root — which is also the observer:");

  // First, with lingering absent, because that is the step the install is supposed to take itself
  // and the one that can be refused. Whatever happens here is a measurement and not a failure: a
  // machine with no polkit agent is exactly the case ADR 0020 gives exit `5`.
  say("\nattempt 1 — lingering absent, so the install has to ask for it:");
  const first = asUser(["--install"]);
  say(first.stdout.trimEnd());
  const firstReport = reported<{ lingerEnabledByUs: boolean }>(first);
  if (first.status === 0 && firstReport !== null) {
    check("the install enabled lingering itself", firstReport.lingerEnabledByUs);
  } else {
    say(`  the install exited ${String(first.status)}:`);
    say(first.stderr.trimEnd());
    check(
      "an install that cannot enable lingering refuses with exit 5 rather than registering",
      first.status === 5,
      `exit ${String(first.status)}`,
    );
    check(
      "nothing was registered by the refused install",
      !existsSync(`/home/${LINUX_USER}/.config/systemd/user/xplainer.service`),
    );
    say("\nattempt 2 — an administrator enables lingering, which is what the refusal asks for:");
    shell("loginctl", ["enable-linger", LINUX_USER]);
  }

  const install = first.status === 0 ? first : asUser(["--install"]);
  if (install !== first) {
    say(install.stdout.trimEnd());
  }
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

  say("\nuninstalling:");
  const removed = asUser(["--uninstall", installed.stateDir]);
  say(removed.stdout.trimEnd());
  const removedReport = reported<{ tokenDeleted: boolean; linger: string }>(removed);
  check("the uninstall completed", removed.status === 0, `exit ${String(removed.status)}`);
  check("the token was deleted", removedReport?.tokenDeleted === true);
  check("the unit is gone", !existsSync(installed.artefact));
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
