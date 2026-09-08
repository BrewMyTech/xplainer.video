/**
 * An updater that stops existing in the middle of a transaction, for real, at a named boundary.
 *
 * The failure this whole story is designed around is "the updater died", and it cannot be observed
 * from inside a Vitest worker: a process that is still running has not died, and one that threw has
 * unwound its stack. So this is a **child entry** — spawned through `ts-source-hook.ts` like every
 * other child in this package — that installs a daemon, starts a real update against it, and then
 * **parks for ever** with the journal at the transition it was told to stop after. The suite reads
 * the line it prints, sends `SIGKILL`, and is then looking at exactly the state a machine is in
 * when an updater is killed: a journal, a stale operation lock, and no updater.
 *
 * `Atomics.wait` rather than a sleep or a spin: it blocks the thread in the kernel, so the process
 * is genuinely stopped mid-step — no timer that could fire, no loop burning a core, and nothing
 * that unwinds. The line is written with `writeSync(1, …)` for the same reason: a buffered
 * `process.stdout.write` may not have reached the pipe before the thread parks, and the suite is
 * waiting on that line.
 *
 * ## The park is keyed on the **journal**, not on a command name
 *
 * T16 injects the kill at **every** boundary, and a boundary is a value in the journal rather than
 * a supervisor verb: `bootout` is the first command of a switch on macOS and `daemon-reload` is on
 * Linux, and neither says anything on Windows. So the park asks the one question that means the
 * same thing on all three — *what does `<state>/update.json` say right now* — and stops at the
 * first seam it reaches while the answer is the transition it was given. Two seams and one listener
 * cover the five boundaries, and each is the earliest point after its own boundary:
 *
 * | boundary        | where this process stops                                              |
 * |-----------------|-----------------------------------------------------------------------|
 * | `staged`        | the drain's own connection, on a socket this process is listening on   |
 * | `drained`       | the switch's first reload command                                      |
 * | `switched`      | the start command                                                      |
 * | `started`       | the rollback's stop command, once the readiness wait has given up      |
 * | `rolling-back`  | the rollback's first reload command                                    |
 *
 * **Why `started` stops at the rollback's stop rather than in the readiness poll.** The poll has a
 * transport that could be replaced by a park, but it is reached only once a `runtime.json` newer
 * than the transaction exists — and the replacement these cases inject never writes one, because it
 * never starts. So the first thing this process does after recording `started` is time that wait
 * out and ask the supervisor to stop the replacement, and that command is the earliest point after
 * the boundary. What the boundary names is durable either way: the journal says `started`, and
 * nothing else has changed.
 *
 * **Why `staged` needs a listener.** Nothing between "the incoming runtime is staged" and "the
 * running daemon is gone" goes through a seam: the drain is a `POST /api/daemon/drain` over the
 * socket `daemon.json` records. So this entry **becomes** that socket — it listens on a path of its
 * own, records it, and parks in the connection handler — which stops the updater at the most
 * faithful moment there is for that boundary: the drain has been asked and nothing has answered
 * yet, so the daemon is still running and nothing has been touched.
 */

import { writeSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import process from "node:process";
import { updateDaemonState } from "../../../daemon/daemon-state.js";
import { installDaemon } from "../../install.js";
import { type ProbeRunner, spell } from "../../preflight.js";
import { writeToolchainMarker } from "../../testing/toolchain.js";
import { readUpdateJournal, type UpdateTransition } from "../journal.js";
import { updateDaemon } from "../transaction.js";
import {
  fixtureEnvironment,
  fixtureLingerMarker,
  PARKED_LINE,
  updateHarness,
  windowsFixtureEnvironment,
} from "./harness.js";

/** Everything this entry is told, because a child entry has no arguments to spare. */
const stateDir = required("XPLAINER_TEST_STATE_DIR");
const home = required("XPLAINER_TEST_HOME");
const payloadA = required("XPLAINER_TEST_PAYLOAD_A");
const payloadB = required("XPLAINER_TEST_PAYLOAD_B");
const workspaceRoot = required("XPLAINER_TEST_WORKSPACE");
const parkAt = required("XPLAINER_TEST_PARK_AT") as UpdateTransition;

/**
 * A staged runtime this process's supervisor refuses to start, or none.
 *
 * The boundaries after the switch are only reachable when the incoming runtime does not become
 * ready — that is round 1's first injected failure, "a staged copy that fails to start" — so the
 * suite names the staged directory the harness must decline to spawn.
 */
const refuseStart = process.env.XPLAINER_TEST_REFUSE_START ?? null;

/** How long the readiness wait may take, for the cases that need it to fail rather than pass. */
const healthTimeoutMs = Number(process.env.XPLAINER_TEST_HEALTH_MS ?? "20000");

/**
 * The platform whose supervisor sequence this run drives, defaulting to the one it is running on.
 *
 * `win32` is set by the case that asks what Task Scheduler is registered to run at each boundary —
 * the question the `PT5M` repetition's behaviour turns on — which is checkable from any machine
 * because the artefact, the argv and the command order are all this process's own work.
 */
const platform = (process.env.XPLAINER_TEST_PLATFORM ?? process.platform) as NodeJS.Platform;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set, and this entry has nothing to do without it`);
  }
  return value;
}

/** What the journal says at this instant, which is what a boundary is. */
function transitionNow(): UpdateTransition | null {
  return readUpdateJournal(stateDir).journal?.transition ?? null;
}

/**
 * Say where this process stopped, and then stop existing in every way but the kernel's.
 *
 * The parent's `SIGKILL` is the only thing that ends it, which is the whole point: an updater that
 * died is not an updater that cleaned up.
 */
function park(what: string): never {
  writeSync(1, `${PARKED_LINE} ${parkAt}: ${what}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error("Atomics.wait returned, which it cannot");
}

const environment =
  platform === "win32" ? windowsFixtureEnvironment(home) : fixtureEnvironment(home);
// The marker the fixture environment names, not the machine's: `install.ts` checks `existsSync` on
// `<lingerDir>/<account>` after `enable-linger`, and on a Linux host an environment without one
// resolves the runner's own `/var/lib/systemd/linger/$USER` and refuses with exit 5.
const harness = updateHarness({ stateDir, lingerMarker: fixtureLingerMarker(environment) });

/** Everything both `install` and `update` are told about which platform they are addressing. */
const addressed = platform === process.platform ? {} : { platform, uid: 0, environment };

/** The harness's runner, which parks before the first command run at the named boundary. */
const run: ProbeRunner = (command) => {
  if (transitionNow() === parkAt) {
    park(`${spell(command)} was about to run`);
  }
  return harness.run(command);
};

writeToolchainMarker(stateDir);
await installDaemon({
  stateDir,
  payloadDir: payloadA,
  port: 0,
  environment,
  run,
  healthTimeoutMs: 20_000,
  ...addressed,
});
writeSync(1, "installed\n");

if (refuseStart !== null) {
  harness.refuseStartOf(refuseStart);
}

if (parkAt === "staged") {
  // This process becomes the socket `daemon.json` names, so the drain reaches it rather than the
  // daemon, and the connection handler is where it stops. A named pipe on Windows and a unix
  // socket everywhere else, exactly as `daemon/ipc.ts` chooses between them.
  const parkSocket =
    process.platform === "win32"
      ? `\\\\.\\pipe\\xplainer-park-${String(process.pid)}`
      : join(stateDir, "park.sock");
  const listener = createServer(() => park("the drain reached this updater's own socket"));
  await new Promise<void>((listening) => {
    listener.listen(parkSocket, listening);
  });
  updateDaemonState(stateDir, { socket_path: parkSocket });
  writeSync(1, `drain socket redirected to ${parkSocket}\n`);
}

await updateDaemon({
  stateDir,
  from: payloadB,
  environment,
  run,
  workspaceRoot,
  healthTimeoutMs,
  ...addressed,
});
writeSync(1, "updated\n");
