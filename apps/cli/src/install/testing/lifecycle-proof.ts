/**
 * The four lifecycle verbs, and the four sentences, against a **real** service manager.
 *
 * `lifecycle.test.ts` proves the classification, the sentences and the post-conditions against a
 * real daemon with `run` as its one seam. That seam is what makes three platforms checkable from
 * one machine, and it is also the one thing it cannot prove: that a real `launchctl` answers
 * `print-disabled` the way {@link readSwitch} reads it, that a real `systemctl --user is-enabled`
 * says `disabled` when a user switches the unit off, and that the loaded-configuration query prints
 * a real unit's `ExecStart`. Those are properties of somebody else's software.
 *
 * So this is a proof rather than a test: it is a script, it exits `0` only when every expectation
 * held, and it prints the transcript that is the evidence. It is **not** part of `pnpm verify`,
 * because it talks to the machine's own service manager.
 *
 * ```sh
 * # macOS, on this machine, under a throwaway label and a throwaway home:
 * node --import apps/cli/src/daemon/testing/ts-source-hook.ts \
 *   apps/cli/src/install/testing/lifecycle-proof.ts
 *
 * # Linux, inside the systemd container, as root, which re-enters as the unprivileged user:
 * docker build -f infra/e2e/Dockerfile.systemd -t xplainer-p2s4-systemd "$(mktemp -d)"
 * docker run -d --name xplainer-t12 --privileged --cgroupns=host \
 *   -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
 *   -v "$PWD:/repo:ro" xplainer-p2s4-systemd
 * docker exec xplainer-t12 node --import /repo/apps/cli/src/daemon/testing/ts-source-hook.ts \
 *   /repo/apps/cli/src/install/testing/lifecycle-proof.ts
 *
 * # ubuntu-latest, where `sudo loginctl enable-linger` gives the runner a user manager:
 * node --import apps/cli/src/daemon/testing/ts-source-hook.ts \
 *   apps/cli/src/install/testing/lifecycle-proof.ts --here
 * ```
 *
 * ## macOS: the disable record is proven on a throwaway label, and only that
 *
 * `launchctl` has **no verb that removes an entry from the disable store** — `enable` and `disable`
 * set its value and there is no third one — so a proof that disabled the product's own label would
 * leave a permanent record in a real user's launchd. The switched-off half therefore runs against
 * {@link THROWAWAY_LABEL}, disabled and re-enabled inside a `finally`, and what it establishes is
 * exactly what the seam cannot: that this launchctl prints the word {@link readSwitch} reads.
 * Everything else — a real supervised daemon, a real stop, a real start, the real port holder, the
 * real degraded toolchain — runs through `daemonStatus` itself with `run` being the real
 * {@link runProbe}.
 *
 * ## Linux: the whole thing, because the machine is disposable
 *
 * A container or a CI runner is not somebody's laptop, so the Linux half installs under the
 * shipped unit name, switches it off with the real `systemctl --user disable`, reads the loaded
 * configuration out of the real manager, and removes the linger marker to produce ADR 0020's fourth
 * sentence against the platform it was written for.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { updateDaemonState } from "../../daemon/daemon-state.js";
import { resolveIpcPath } from "../../daemon/ipc.js";
import { buildLaunchSpec } from "../../runtime/launch-spec.js";
import { installDaemon } from "../install.js";
import {
  DEGRADED_TOOLCHAIN_SENTENCE,
  daemonStatus,
  disabledQuery,
  logSource,
  NOT_BOOT_PERSISTENT_SENTENCES,
  readSwitch,
  SWITCHED_OFF_SENTENCES,
  startDaemon,
  statusSentences,
  stopDaemon,
} from "../lifecycle.js";
import { currentSupervisorEnvironment, runProbe } from "../preflight.js";
import { registerCommands } from "../register.js";
import { stageRuntime } from "../stage.js";
import { renderLaunchAgentPlist } from "../supervisors/launchd.js";
import { uninstallDaemon } from "../uninstall.js";
import { buildFixturePayload } from "./payload.js";
import { ACQUIRED_DIR, writeToolchainMarker } from "./toolchain.js";

/** The label the macOS half registers under. Never the product's, and re-enabled in a `finally`. */
export const THROWAWAY_LABEL = "video.xplainer.t12-proof";

/** The account the Linux half installs as inside the container image. */
const LINUX_USER = "xplainer";

/** The uid that account has in the image. */
const LINUX_UID = 1000;

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

/** The port the Linux install records: fixed, because a second account has to find it again. */
const LINUX_PROOF_PORT = 18788;

let failures = 0;

/** What one spawned command answered, with both streams as text. */
type Ran = { status: number | null; stdout: string; stderr: string };

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
function shell(program: string, argv: readonly string[]): Ran {
  const answer = ran(spawnSync(program, [...argv], { encoding: "utf8", timeout: 120_000 }));
  say(`  $ ${program} ${argv.join(" ")}   -> ${String(answer.status)}`);
  for (const stream of [answer.stdout, answer.stderr]) {
    for (const outputLine of stream.split("\n")) {
      if (outputLine.trim() !== "") {
        say(`      ${outputLine}`);
      }
    }
  }
  return answer;
}

/** Wait for a predicate without sleeping through it. */
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
    marker: "lifecycle-proof",
  }).outDir;
  return { stateDir, payloadDir };
}

/** The sentence one state produced, by tag, or `null`. */
function sentenceFor(
  report: Awaited<ReturnType<typeof daemonStatus>>,
  state: string,
): string | null {
  return report.sentences.find((entry) => entry.state === state)?.text ?? null;
}

// ── macOS ────────────────────────────────────────────────────────────────────────────────────

/** macOS: a real LaunchAgent, a real disable record, and the sentences that come off both. */
async function proveLaunchd(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "xplainer-t12-launchd-"));
  const home = join(root, "home");
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  const uid = process.getuid?.() ?? 0;
  const service = `gui/${String(uid)}/${THROWAWAY_LABEL}`;
  const environment = { home, account: LINUX_USER };

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
    const artefact = renderLaunchAgentPlist(spec, environment);
    const plist = artefact.contents.replace(
      `<key>Label</key><string>${artefact.identity}</string>`,
      `<key>Label</key><string>${THROWAWAY_LABEL}</string>`,
    );
    const plistPath = join(home, "Library", "LaunchAgents", `${THROWAWAY_LABEL}.plist`);
    writeFileSync(plistPath, plist, { mode: 0o600 });
    // The record `daemonStatus` reads. `installDaemon` writes exactly these fields; this proof
    // writes them by hand because the job it registers carries the throwaway label.
    updateDaemonState(stateDir, {
      supervisor_kind: "launchd",
      supervisor_artefact: plistPath,
      launch_spec: spec,
      runtime_dir: staged.path,
      log_sink: join(home, "Library", "Logs", "xplainer", "daemon.log"),
      token_file: spec.settings.tokenFile,
      socket_path: spec.settings.socket,
    });

    say(`\nlaunchd, the shipped registration sequence, against ${service}:`);
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
    const up = waitFor("runtime.json", () => existsSync(join(stateDir, "runtime.json")));
    check("launchd started the job it bootstrapped", up);
    if (!up) {
      return;
    }

    // ── The switched-off sentence, against a real disable record on the throwaway label ────────
    say("\nthe disabled query, against this machine's real launchd:");
    const target = {
      kind: "launchd" as const,
      identity: THROWAWAY_LABEL,
      artefact: plistPath,
      uid,
    };
    const before = runProbe(disabledQuery(target));
    check(
      "`launchctl print-disabled` answered",
      before.started && before.status === 0,
      `exit ${String(before.status)}`,
    );
    check(
      "the label reads as switched on before anything disabled it",
      readSwitch("launchd", THROWAWAY_LABEL, before).state === "on",
      readSwitch("launchd", THROWAWAY_LABEL, before).raw,
    );
    shell("launchctl", ["disable", service]);
    const after = runProbe(disabledQuery(target));
    const read = readSwitch("launchd", THROWAWAY_LABEL, after);
    check(
      "a real `launchctl disable` reads back as switched off",
      read.state === "off",
      `the store says ${JSON.stringify(read.raw)}`,
    );
    // The sentence, taken off the report the real disable record produces rather than compared to
    // the constant it is built from. `readSwitch` above is the only input that decides it: had the
    // store read `on`, `switchedOff` would be false and `statusSentences` would emit nothing here,
    // so this check has a failure path — which the constant-against-constant comparison it replaced
    // on 2026-09-08 did not. The literal is ADR 0020's own wording, not the production string.
    const whileOff = statusSentences({
      kind: "launchd",
      answering: true,
      stalled: false,
      failedStarts: 0,
      hold: null,
      switchedOff: read.state === "off",
      toolchainComplete: true,
      bootPersistent: null,
    });
    const switchedOff = whileOff.find((entry) => entry.state === "switched-off")?.text ?? null;
    check(
      "and the report built from that real record carries ADR 0020's sentence for it",
      switchedOff === "you or a policy switched this off in Login Items & Extensions",
      switchedOff ?? "<the report carried no switched-off sentence>",
    );

    // ── The report itself, from the real supervisor and the real daemon ───────────────────────
    say("\n`daemon status` against the running job, with the real launchctl:");
    const ready = await daemonStatus({ stateDir, environment, uid, run: runProbe });
    say(`  condition ${ready.condition}, port ${String(ready.probe.port)}`);
    check("the supervised daemon answers an authenticated /healthz", ready.condition === "ready");
    check(
      "macOS has no loaded-configuration query, and says why (D7)",
      !ready.supervisor.loaded.available && ready.supervisor.loaded.detail.includes("NOT API"),
    );
    check(
      "the boot-persistence sentence is the macOS one: login, not boot",
      sentenceFor(ready, "not-boot-persistent") === NOT_BOOT_PERSISTENT_SENTENCES.launchd,
    );
    check(
      "no `launchctl print` was involved",
      ready.supervisor.switch.query === `launchctl print-disabled gui/${String(uid)}`,
      ready.supervisor.switch.query ?? "<none>",
    );

    say("\nthe degraded sentence, with a real file removed from the real marker:");
    rmSync(join(stateDir, ACQUIRED_DIR, "chrome-headless-shell"), { force: true });
    const degraded = await daemonStatus({ stateDir, environment, uid, run: runProbe });
    check("the condition is degraded", degraded.condition === "degraded");
    check(
      "and the sentence is ADR 0020's third",
      sentenceFor(degraded, "degraded-toolchain") === DEGRADED_TOOLCHAIN_SENTENCE,
    );

    // ── stop and start, through the shipped commands, against the real job ────────────────────
    say("\n`daemon stop` and `daemon start`, against the real job:");
    const stopped = await stopDaemon({
      stateDir,
      environment,
      uid,
      run: (command) => runProbe(rewriteLabel(command, artefact.identity, THROWAWAY_LABEL, uid)),
    });
    say(`  stopped after ${String(stopped.elapsedMs)} ms via ${stopped.commands.join(", ")}`);
    // Asked of the daemon rather than of the fact that `stopDaemon` returned. It throws when
    // something is still answering, so `check(…, true)` — what stood here until 2026-09-08 — was a
    // line whose failure path could not fire; this one re-probes and reports what it found.
    const afterStop = await daemonStatus({ stateDir, environment, uid, run: runProbe });
    check(
      "the daemon stopped answering: an authenticated /healthz now gets nothing at all",
      afterStop.probe.http_status === null &&
        afterStop.condition !== "ready" &&
        afterStop.condition !== "degraded",
      `condition ${afterStop.condition}, http_status ${String(afterStop.probe.http_status)}, ` +
        `${afterStop.probe.error ?? "no error reported"}`,
    );
    check("the plist is still registered", existsSync(plistPath));

    const restarted = await startDaemon({
      stateDir,
      environment,
      uid,
      run: (command) => runProbe(rewriteLabel(command, artefact.identity, THROWAWAY_LABEL, uid)),
    });
    say(`  started in ${String(restarted.elapsedMs)} ms on port ${String(restarted.port)}`);
    check("the daemon answered again after a real kickstart", restarted.port !== null);

    // ── the log file, which on macOS is the daemon's own ─────────────────────────────────────
    const source = logSource({ ...ready.daemon, supervisor_kind: "launchd" }, environment, 20);
    check(
      "`daemon logs` points at the file launchd captures both streams into",
      source.kind === "file" && source.path.endsWith("Library/Logs/xplainer/daemon.log"),
      source.kind === "file" ? source.path : source.kind,
    );
  } finally {
    say("\ntearing the throwaway job down, and putting its disable record back:");
    shell("launchctl", ["bootout", service]);
    // `launchctl` has no verb that removes an entry from the disable store, so the honest teardown
    // is to set it back to `enabled` — which is the state this proof found it in.
    shell("launchctl", ["enable", service]);
    const store = ran(
      spawnSync("launchctl", ["print-disabled", `gui/${String(process.getuid?.() ?? 0)}`], {
        encoding: "utf8",
      }),
    );
    check(
      "the throwaway label is left enabled, not disabled",
      readSwitch("launchd", THROWAWAY_LABEL, {
        started: true,
        status: store.status,
        stdout: store.stdout,
        stderr: store.stderr,
      }).state === "on",
    );
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The shipped command with the product's label swapped for the throwaway one.
 *
 * `startCommand` and `stopCommand` address the label the adapter names, and this proof registered a
 * different one. Rewriting the argument the shipped builder produced — rather than hand-writing a
 * `launchctl kill` — is what keeps the thing being measured the shipped command.
 */
function rewriteLabel(
  command: { program: string; argv: readonly string[]; timeoutMs?: number | undefined },
  from: string,
  to: string,
  uid: number,
): { program: string; argv: readonly string[]; timeoutMs?: number | undefined } {
  void uid;
  return { ...command, argv: command.argv.map((word) => word.replaceAll(from, to)) };
}

// ── Linux ────────────────────────────────────────────────────────────────────────────────────

/** Linux, as the unprivileged user: the real install, reporting where it landed. */
async function installAsUser(): Promise<void> {
  const root = join(process.env.HOME ?? "/tmp", "t12-proof");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const { stateDir, payloadDir } = prepare(root);
  const outcome = await installDaemon({
    stateDir,
    payloadDir,
    port: LINUX_PROOF_PORT,
    run: runProbe,
    healthTimeoutMs: 30_000,
    log: (entry) => {
      say(`    ${entry}`);
    },
  });
  process.stdout.write(`PROOF-JSON ${JSON.stringify({ stateDir, port: outcome.health.port })}\n`);
}

/**
 * Linux, as the unprivileged user: one status report, reduced to what the orchestrator asserts.
 *
 * `lingerDir` is a parameter for one phase only, and the reason is measured rather than assumed:
 * on a machine with **no login session** the user manager exists only because lingering does, so
 * `loginctl disable-linger` takes the manager and the daemon with it and there is no running daemon
 * left to say "running, but not boot-persistent" about. It rides on the `SupervisorEnvironment`,
 * which is where every machine-owned path this account is identified within is injected; the rest
 * of that environment is this real account's, because this phase is deliberately being run as the
 * real unprivileged user. The orchestrator measures the real consequence separately, at the end,
 * after everything else has been observed.
 */
async function statusAsUser(stateDir: string, lingerDir: string | null): Promise<void> {
  const report = await daemonStatus({
    stateDir,
    run: runProbe,
    ...(lingerDir === null
      ? {}
      : { environment: { ...currentSupervisorEnvironment(), lingerDir } }),
  });
  process.stdout.write(
    `PROOF-JSON ${JSON.stringify({
      condition: report.condition,
      switch: report.supervisor.switch,
      loaded: report.supervisor.loaded,
      bootPersistent: report.boot_persistence.persistent,
      sentences: report.sentences,
    })}\n`,
  );
}

/** Linux, as the unprivileged user: the two verbs, against the real user manager. */
async function stopStartAsUser(stateDir: string): Promise<void> {
  const stopped = await stopDaemon({ stateDir, run: runProbe });
  const started = await startDaemon({ stateDir, run: runProbe });
  process.stdout.write(
    `PROOF-JSON ${JSON.stringify({
      stopCommands: stopped.commands,
      startCommands: started.commands,
      port: started.port,
    })}\n`,
  );
}

/** One command as the unprivileged user, inside their own manager's environment. */
function asUserCommand(argv: readonly string[]): Ran {
  return ran(
    spawnSync("runuser", ["-u", LINUX_USER, "--", ...argv], {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        HOME: `/home/${LINUX_USER}`,
        XDG_RUNTIME_DIR: `/run/user/${String(LINUX_UID)}`,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${String(LINUX_UID)}/bus`,
      },
    }),
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

/** What one status child answers with. */
type StatusReported = {
  condition: string;
  switch: { state: string; query: string | null; raw: string };
  loaded: { available: boolean; answered: boolean; output: string; query: string | null };
  bootPersistent: boolean | null;
  sentences: { state: string; text: string }[];
};

/** Linux, as root: install as somebody else, then drive the four states through a real systemd. */
async function proveSystemd(here: boolean): Promise<void> {
  const asTarget = here
    ? (args: readonly string[]): Ran =>
        ran(
          spawnSync(process.execPath, ["--import", HOOK, SELF, ...args], {
            encoding: "utf8",
            timeout: 300_000,
          }),
        )
    : asUser;
  const user = here ? (process.env.USER ?? "runner") : LINUX_USER;
  const lingerMarker = `/var/lib/systemd/linger/${user}`;
  const sudo = (argv: readonly string[]): Ran =>
    here ? shell("sudo", argv) : shell(argv[0] ?? "", argv.slice(1));

  say(`\nsystemd, as ${user}, with the real user manager:`);
  sudo(["loginctl", "enable-linger", user]);
  const install = asTarget(["--install"]);
  say(install.stdout.trimEnd());
  const installed = reported<{ stateDir: string; port: number }>(install);
  check(
    "the install completed as the target user",
    install.status === 0 && installed !== null,
    `exit ${String(install.status)}${install.status === 0 ? "" : `: ${install.stderr.trimEnd()}`}`,
  );
  if (installed === null) {
    return;
  }
  const stateDir = installed.stateDir;

  // ── ready, and boot-persistent, because lingering is on ───────────────────────────────────
  const ready = reported<StatusReported>(asTarget(["--status", stateDir]));
  check("the daemon answers", ready?.condition === "ready", ready?.condition ?? "<none>");
  check(
    "`systemctl --user is-enabled` is the query, and it says enabled",
    ready?.switch.query === "systemctl --user is-enabled xplainer.service" &&
      ready?.switch.state === "on",
    `${ready?.switch.query ?? "<none>"} -> ${ready?.switch.raw ?? "<none>"}`,
  );
  check(
    "the loaded configuration comes back from the real manager, with the unit's ExecStart",
    ready?.loaded.answered === true && (ready?.loaded.output ?? "").includes("serve"),
    (ready?.loaded.output ?? "").split("\n")[0] ?? "<empty>",
  );
  check("it is boot-persistent while lingering is on", ready?.bootPersistent === true);

  // ── the fourth sentence: what the daemon looks like with no linger marker ────────────────
  say("\nthe fourth sentence, with the linger marker's directory pointed somewhere empty:");
  const emptyLingerDir = mkdtempSync(join(tmpdir(), "xplainer-t12-linger-"));
  const unpersisted = reported<StatusReported>(
    asTarget(["--status", stateDir, "--linger-dir", emptyLingerDir]),
  );
  const fourth = unpersisted?.sentences.find((entry) => entry.state === "not-boot-persistent");
  check(
    "ADR 0020's fourth sentence, word for word, from a running daemon on a real systemd",
    fourth?.text === NOT_BOOT_PERSISTENT_SENTENCES.systemd,
    fourth?.text ?? "<none>",
  );
  check("and the report says so as a fact too", unpersisted?.bootPersistent === false);
  rmSync(emptyLingerDir, { recursive: true, force: true });

  // ── stop and start, through the shipped commands ──────────────────────────────────────────
  say("\n`daemon stop` and `daemon start`, against the real user manager:");
  const cycled = reported<{ stopCommands: string[]; startCommands: string[]; port: number | null }>(
    asTarget(["--stop-start", stateDir]),
  );
  check(
    "the stop went through `systemctl --user stop`",
    cycled?.stopCommands.join() === "systemctl --user stop xplainer.service",
    cycled?.stopCommands.join() ?? "<none>",
  );
  check(
    "the start went through `systemctl --user start` and the daemon answered again",
    cycled?.startCommands.join() === "systemctl --user start xplainer.service" &&
      cycled?.port === LINUX_PROOF_PORT,
    `${cycled?.startCommands.join() ?? "<none>"} -> port ${String(cycled?.port)}`,
  );

  // ── the second sentence: the unit really switched off ─────────────────────────────────────
  say("\nswitching the unit off the way a user would, and stopping it:");
  asTarget(["--disable", stateDir]);
  const off = reported<StatusReported>(asTarget(["--status", stateDir]));
  check(
    "a real `systemctl --user disable` reads back as switched off",
    off?.switch.state === "off",
    `${off?.switch.query ?? "<none>"} -> ${off?.switch.raw ?? "<none>"}`,
  );
  const second = off?.sentences.find((entry) => entry.state === "switched-off");
  check(
    "the switched-off sentence names the surface this user actually has",
    second?.text === SWITCHED_OFF_SENTENCES.systemd,
    second?.text ?? "<none>",
  );
  check(
    "and the condition is `disabled`, which is the one `xplainer status` cannot reach",
    off?.condition === "disabled",
    off?.condition ?? "<none>",
  );

  say("\nthe journal, which is what `daemon logs` execs on Linux:");
  const journal = shell("journalctl", ["--user", "-u", "xplainer.service", "-n", "5"]);
  check("journalctl answered for the unit", journal.status === 0);

  say("\nuninstalling:");
  asTarget(["--uninstall", stateDir]);
  check(
    "the unit is gone",
    here || !existsSync(`/home/${LINUX_USER}/.config/systemd/user/xplainer.service`),
  );

  // The measurement the seam above stands in for, taken last because it is destructive: with no
  // login session, revoking lingering stops the per-user manager itself. This is why "not
  // boot-persistent" cannot be produced here by removing the real marker under a running daemon —
  // there is no manager left to run one — and it is the strongest possible statement of what the
  // sentence means.
  say("\nwhat revoking lingering actually does here, with nobody logged in:");
  sudo(["loginctl", "disable-linger", user]);
  check("the marker is gone", !existsSync(lingerMarker), lingerMarker);
  if (here) {
    say("  (skipped on a runner, where this account is the one the job runs as)");
  } else {
    // Asked **as the target user, with their own bus address in the environment** — the same
    // environment every other child in this proof ran with, so a failure here is the manager being
    // gone rather than an environment variable being missing.
    const afterwards = asUserCommand(["systemctl", "--user", "is-system-running"]);
    say(
      `  systemctl --user is-system-running -> ${(afterwards.stdout + afterwards.stderr).trim()}`,
    );
    check(
      "the per-user manager is gone with it, which is what boot-persistence was about",
      afterwards.status !== 0,
      `exit ${String(afterwards.status)}`,
    );
  }
}

/** As the target user: switch the unit off and stop it, which is what a person does in one step. */
function disableAsUser(stateDir: string): void {
  void stateDir;
  const answer = runProbe({
    program: "systemctl",
    argv: ["--user", "disable", "--now", "xplainer.service"],
  });
  process.stdout.write(
    `PROOF-JSON ${JSON.stringify({ status: answer.status, stderr: answer.stderr.trim() })}\n`,
  );
}

/** As the target user: the real uninstall. */
function uninstallAsUser(stateDir: string): void {
  const outcome = uninstallDaemon({ stateDir, run: runProbe });
  process.stdout.write(`PROOF-JSON ${JSON.stringify({ removed: outcome.removed.length })}\n`);
}

const argument = (flag: string): string => process.argv[process.argv.indexOf(flag) + 1] ?? "";

if (process.argv.includes("--install")) {
  await installAsUser();
} else if (process.argv.includes("--status")) {
  const lingerDir = process.argv.includes("--linger-dir") ? argument("--linger-dir") : null;
  await statusAsUser(argument("--status"), lingerDir);
} else if (process.argv.includes("--stop-start")) {
  await stopStartAsUser(argument("--stop-start"));
} else if (process.argv.includes("--disable")) {
  disableAsUser(argument("--disable"));
} else if (process.argv.includes("--uninstall")) {
  uninstallAsUser(argument("--uninstall"));
} else {
  say(`T12 lifecycle proof — ${process.platform}, node ${process.version}`);
  if (process.platform === "darwin") {
    await proveLaunchd();
  } else if (process.platform === "linux") {
    await proveSystemd(process.argv.includes("--here"));
  } else {
    say(`nothing to prove on ${process.platform}`);
  }
  say(`\n${failures === 0 ? "PASSED" : `FAILED: ${String(failures)} expectation(s)`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}
