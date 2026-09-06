/**
 * A worker that needs neither Remotion nor a TTS server.
 *
 * The runner's contract with a worker is small — a command, some arguments, a process group, two
 * pipes and an exit code — so every property the job runner has to prove can be proved against a
 * `node -e` script: that `queued` is observable before `running`, that the log tail is bounded and
 * durable, that a non-zero exit becomes `error`, that cancelling tears down the whole process
 * *group* rather than the leader alone, and that a `SIGKILL`ed daemon leaves a record boot
 * reconciliation can finish. Requiring a real render for any of that would make the suite slow,
 * network-dependent and unable to run at all before the render backend exists.
 *
 * The configuration travels in an environment variable rather than in the script text, because a
 * script assembled by string interpolation is a quoting bug waiting to be written.
 *
 * This directory is **excluded from `tsconfig.build.json`**, so nothing here compiles into `dist/`
 * or reaches a published tarball; it is type-checked by `tsc --noEmit` and linted like the rest of
 * `src/`.
 */

import process from "node:process";
import type { WorkerRegistry, WorkerSpec } from "../runner.js";

/** The environment variable the script below reads its configuration from. */
export const FAKE_WORKER_ENV = "XPLAINER_FAKE_WORKER";

/** How a fake worker behaves. Every field has a default that makes a trivial, instant worker. */
export type FakeWorkerConfig = {
  /** Lines written to stdout, immediately, as `line 1` … `line n`. */
  lines?: number;
  /** Lines written to stderr after the stdout ones, as `stderr 1` … `stderr n`. */
  stderrLines?: number;
  /** How long the process stays alive before exiting. */
  lifeMs?: number;
  /** The code it exits with. */
  exitCode?: number;
  /**
   * Start an unref'd grandchild that sleeps for ever and print its pid as `grandchild <pid>`.
   *
   * This is what makes the process-group assertions meaningful: killing the leader alone leaves
   * this one behind, which is exactly the orphaned Chrome ADR 0024 §Scope is about.
   */
  grandchild?: boolean;
};

/**
 * The worker body, as CommonJS because `node -e` evaluates its argument as CommonJS.
 *
 * `process.exitCode` rather than `process.exit()`: stdout is a pipe here, writes to a pipe are
 * asynchronous, and exiting outright truncates the log the tests are about to assert on.
 */
const FAKE_WORKER_SCRIPT = `
const config = JSON.parse(process.env.${FAKE_WORKER_ENV} || "{}");
if (config.grandchild) {
  const { spawn } = require("node:child_process");
  const kid = spawn(process.execPath, ["-e", "setInterval(function () {}, 1000);"], {
    stdio: "ignore",
  });
  kid.unref();
  process.stdout.write("grandchild " + kid.pid + "\\n");
}
for (let index = 1; index <= (config.lines || 0); index += 1) {
  process.stdout.write("line " + index + "\\n");
}
for (let index = 1; index <= (config.stderrLines || 0); index += 1) {
  process.stderr.write("stderr " + index + "\\n");
}
const life = config.lifeMs || 0;
const code = config.exitCode || 0;
if (life > 0) {
  setTimeout(function () {
    process.exitCode = code;
  }, life);
} else {
  process.exitCode = code;
}
`;

/** One fake worker, ready to hand to the runner. */
export function fakeWorkerSpec(config: FakeWorkerConfig = {}): WorkerSpec {
  return {
    command: process.execPath,
    args: ["-e", FAKE_WORKER_SCRIPT],
    env: { [FAKE_WORKER_ENV]: JSON.stringify(config) },
  };
}

/** The same fake worker registered for all three job kinds. */
export function fakeWorkerRegistry(config: FakeWorkerConfig = {}): WorkerRegistry {
  const factory = (): WorkerSpec => fakeWorkerSpec(config);
  return {
    explainer_narrate: factory,
    explainer_still: factory,
    explainer_render: factory,
  };
}
