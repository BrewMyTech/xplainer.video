#!/usr/bin/env node
/**
 * The B5 gate: an update transaction that is interrupted, refused and rolled back, on this machine.
 *
 * T15 built the transaction — an operation lock, a durable journal, a commanded recovery — and T16
 * is the failure injection over it: the updater is killed **between every pair of durable
 * transitions**, the two refusals that must disturb nothing are asserted on their message as well
 * as their exit code, and every rollback ends with six assertions rather than a green `/healthz`.
 * This script is how all of that is run in one command, and it has two steps because the evidence
 * has two halves that no single process can produce.
 *
 * **Step 1 — the boundaries, in `apps/cli/src/install/update/transaction.test.ts`.** Five cases, one
 * per transition the journal records, each spawning a real updater, letting it reach that boundary
 * and killing it with `SIGKILL`. Each then asserts the two steps the plan settles: immediately
 * after the kill, `daemon status` reports an interrupted transaction, names the transition and
 * names the recovery command — and on Linux and macOS the test asserts the daemon may legitimately
 * be **down**, because past the drain the daemon exited `0` and `0` is the portable "do not
 * restart" signal on both. Then, after the named command, the previous runtime is answering, the
 * newer version's state is intact, exactly one process is running out of the state directory,
 * nothing that looks like Chrome or ffmpeg survives, and the rolled-back runtime's own template
 * pins are satisfied by the installed workspace. The payload there is a fixture and the supervisor
 * is a seam, which is what makes all three platforms checkable from one machine.
 *
 * **Step 2 — the real machine, in `install/update/testing/failure-proof.ts`.** Two payloads
 * assembled by the shipped assembler, installed under this machine's own service manager, and a
 * replacement that starts and never becomes ready. It is what step 1 cannot be: the daemon that
 * comes back is a real `xplainer serve` that takes the real `owner.lock`, so "exactly one process
 * holds it" is asked of the lock itself; `launchd` (or `systemd`) is asked to accept the rewritten
 * artefact in the rollback direction; and the two refusals are run against real payload directories
 * whose own programs the message has to name.
 *
 * **What is deferred, and to where.** The sixth assertion is "the rolled-back daemon RENDERS", and
 * a PNG needs the Chrome headless shell and the real payload-2 workspace that T19 and T33 install.
 * Both halves here prove the readiness that makes the still possible — the installed workspace
 * satisfies the pins of the runtime that came back, re-hashed by the shipped verifier — and **B6's
 * `scripts/e2e/toolchain.mjs` reruns every rollback case and renders the still itself**. That split
 * is the plan's, and it is what keeps B5 runnable in its own batch.
 *
 * ```bash
 * pnpm e2e:update
 * ```
 *
 * It is **not** part of `pnpm verify` and must not become part of it: step 2 assembles two ~160 MB
 * payloads and registers a service with this machine's own supervisor. On macOS that registration
 * is a throwaway label booted out in a `finally`; on Linux systemd reads only the account's own
 * config directory, so that leg installs the real unit there and removes it — run it on a runner or
 * in `infra/e2e/Dockerfile.systemd` rather than on a machine somebody is using.
 *
 * Environment it reads: `COLLIE_ARTIFACTS_DIR` (default `<repo>/.session/artifacts`). Everything it
 * prints is also written to `<artifacts>/e2e-update.log`, line by line, so a run that dies halfway
 * still leaves its transcript behind.
 *
 * Exit codes: `0` both steps passed; `1` one of them did not, with the step named on the last line.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The repository root, two levels up from this file. */
const REPO = fileURLToPath(new URL("../../", import.meta.url));

/** Where the transcript is left for a human to look at. */
const ARTIFACTS =
  (process.env.COLLIE_ARTIFACTS_DIR ?? "").trim() || join(REPO, ".session/artifacts");

/** Where the transcript is written, line by line. */
const LOG_PATH = join(ARTIFACTS, "e2e-update.log");

/**
 * The hook that lets a spawned `node` resolve this package's `.ts` sources, as a **file URL**.
 *
 * `--import` takes a URL, and a bare Windows path (`C:\…`) is parsed as a URL with the scheme `c:`
 * — `ERR_UNSUPPORTED_ESM_URL_SCHEME`, measured on `windows-latest` on 2026-09-08. `pathToFileURL`
 * is the documented fix and costs nothing on the other two platforms.
 */
const TS_SOURCE_HOOK = pathToFileURL(
  join(REPO, "apps", "cli", "src", "daemon", "testing", "ts-source-hook.ts"),
).href;

/**
 * How pnpm is spawned, in the form `spawnSync` takes it.
 *
 * On POSIX it is pnpm's own name and its arguments. On Windows pnpm is a `pnpm.cmd` shim, which is
 * not an image the kernel can execute, and since CVE-2024-27980 Node refuses to hand one to
 * `CreateProcess` without `shell` — and passing arguments *and* `shell: true` is a Node 24 runtime
 * deprecation (DEP0190), so that branch passes one command string and no argument array. Nothing is
 * interpolated into it; the words are the same literals the POSIX branch passes.
 */
function pnpm(...args) {
  return process.platform === "win32"
    ? { command: `pnpm.cmd ${args.join(" ")}`, args: [], shell: true }
    : { command: "pnpm", args, shell: false };
}

function stamp() {
  return new Date().toISOString();
}

/** Say something, once, to both the terminal and the transcript. */
function say(text) {
  const line = `${text}\n`;
  process.stdout.write(line);
  appendFileSync(LOG_PATH, line);
}

function section(title) {
  say("");
  say(`── ${title} ${"─".repeat(Math.max(0, 76 - title.length))}`);
}

/**
 * Run a step with both its streams captured into the transcript, and answer with its exit code.
 *
 * The output is the evidence here — a boundary case names the transition it stopped at, and the
 * proof prints one `ok:` line per expectation — so nothing is swallowed and nothing is summarised.
 */
function step(label, spec) {
  say(`${stamp()} ${label}`);
  const started = Date.now();
  const result = spawnSync(spec.command, spec.args, {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: spec.shell === true,
  });
  for (const [stream, text] of [
    ["out", result.stdout ?? ""],
    ["err", result.stderr ?? ""],
  ]) {
    for (const line of text.split("\n")) {
      if (line.trim() !== "") {
        say(`  [${stream}] ${line}`);
      }
    }
  }
  if (result.error !== undefined) {
    say(`  [error] ${result.error.message}`);
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const code = result.status ?? 1;
  say(`${stamp()} ${label}: exit ${String(code)} after ${seconds} s`);
  return code;
}

mkdirSync(ARTIFACTS, { recursive: true });
say(`${stamp()} pnpm e2e:update — the update transaction under injected failure`);
say(`repository: ${REPO}`);
say(`transcript: ${LOG_PATH}`);

// The assembler copies `apps/cli/dist` and refuses a checkout that has none, so the build is a step
// of its own: a build failure has to be legible as one rather than as an assembly refusal.
const failed = [];
if (step("building every member", pnpm("turbo", "build")) !== 0) {
  failed.push("the build");
}

if (failed.length === 0) {
  section(
    "step 1 — the updater is killed at every durable boundary (fixture payload, seam supervisor)",
  );
  if (
    step(
      "the update transaction's unit suite",
      pnpm(
        "--filter",
        "@xplainer/cli",
        "exec",
        "vitest",
        "run",
        "src/install/update/transaction.test.ts",
      ),
    ) !== 0
  ) {
    failed.push("step 1, the boundary suite");
  }

  section("step 2 — a real payload, a real supervisor and a real daemon");
  if (
    step("the failure-injection proof", {
      command: process.execPath,
      args: [
        "--import",
        TS_SOURCE_HOOK,
        join(REPO, "apps", "cli", "src", "install", "update", "testing", "failure-proof.ts"),
      ],
      shell: false,
    }) !== 0
  ) {
    failed.push("step 2, the failure-injection proof");
  }
}

section("verdict");
if (failed.length > 0) {
  say(`FAILED: ${failed.join("; ")}`);
  say("the render half of the sixth assertion is B6's rerun and was not attempted here");
  process.exitCode = 1;
} else {
  say("PASSED: every boundary reported and recovered, both refusals disturbed nothing");
  say(
    "the rolled-back runtime's pins are satisfied by the installed workspace; the still itself is " +
      "B6's rerun through scripts/e2e/toolchain.mjs, after T19 supplies the browser and payload 2",
  );
}
