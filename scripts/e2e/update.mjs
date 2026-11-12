#!/usr/bin/env node
/**
 * The B5 gate: an update transaction that is interrupted, refused and rolled back, on this machine.
 *
 * T15 built the transaction — an operation lock, a durable journal, a commanded recovery — and T16
 * is the failure injection over it: the updater is killed **between every pair of durable
 * transitions**, the refusals that must disturb nothing are asserted on their message as well as
 * their exit code, and every rollback ends with six assertions rather than a green `/healthz`.
 * This script is how all of that is run in one command, in three steps: the evidence has two halves
 * that no single process can produce, and ADR 0031's cut added a third question of its own.
 *
 * **Step 1 — the boundaries, in `apps/cli/src/install/update/transaction.test.ts`.** Five cases, one
 * per transition the journal records, each spawning a real updater, letting it reach that boundary
 * and killing it with `SIGKILL`. Each then asserts the two steps the plan settles: immediately
 * after the kill, `daemon status` reports an interrupted transaction, names the transition and
 * names the recovery command — and on Linux and macOS the test asserts the daemon may legitimately
 * be **down**, because past the drain the daemon exited `0` and `0` is the portable "do not
 * restart" signal on both. Then, after the named command, the previous runtime is answering, the
 * newer version's state is intact, exactly one process is running out of the state directory,
 * nothing that looks like Chrome or ffmpeg survives, and the marker on disk satisfies the
 * requirements the rolled-back runtime states in its own manifest. The payload there is a fixture
 * and the supervisor is a seam, which is what makes all three platforms checkable from one machine.
 *
 * **Step 2 — the real machine, in `install/update/testing/failure-proof.ts`.** Two payloads
 * assembled by the shipped assembler, installed under this machine's own service manager, and a
 * replacement that starts and never becomes ready. It is what step 1 cannot be: the daemon that
 * comes back is a real `xplainer serve` that takes the real `owner.lock`, so "exactly one process
 * holds it" is asked of the lock itself; `launchd` (or `systemd`) is asked to accept the rewritten
 * artefact in the rollback direction; and the refusal that must disturb nothing — a marker that
 * records no ffmpeg, judged against a runtime that requires one (ADR 0031 §Note, 2026-11-12,
 * D2 (a)) — is run against real payload directories, and the daemon is asked afterwards.
 *
 * **Step 3 — the cut, in `install/update/testing/cut-proof.ts`.** A daemon installed from before
 * ADR 0031's cut reads `toolchain.json` format 1, and three commands of this build would otherwise
 * put format 2 under it. Installed for real from a pre-cut payload — this build's payload under a
 * manifest of the shape every earlier release wrote — it is met by this build's `xplainer update`,
 * which must exit `3` **before** it runs `setup` (D2 (b)); by `xplainer setup`, which must exit `3`
 * (D2 (c)); and by `daemon update` to this build's payload, which must refuse in its precondition
 * (D2 (a)). After each: the marker's bytes, the state directory's entries, the staged runtimes and
 * the recorded run are as they were, and **the old daemon still answers `ok`**.
 *
 * **What is deferred, and to where.** The sixth assertion is "the rolled-back daemon RENDERS", and
 * a PNG needs the Chrome headless shell `setup` acquires. The halves here prove the readiness that
 * makes the still possible — the marker satisfies the requirements of the runtime that came back —
 * and **B6's `scripts/e2e/toolchain.mjs` reruns every rollback case and renders the still itself**.
 * That split is the plan's, and it is what keeps B5 runnable in its own batch.
 *
 * ```bash
 * pnpm e2e:update
 * ```
 *
 * It is **not** part of `pnpm verify` and must not become part of it: steps 2 and 3 each assemble
 * two payloads and register a service with this machine's own supervisor. On macOS each
 * registration is a throwaway label booted out in a `finally`; on Linux systemd reads only the
 * account's own config directory, so those legs install the real unit there and remove it — run it
 * on a runner or in `infra/e2e/Dockerfile.systemd` rather than on a machine somebody is using.
 *
 * Environment it reads: `COLLIE_ARTIFACTS_DIR` (default `<repo>/.session/artifacts`). Everything it
 * prints is also written to `<artifacts>/e2e-update.log`, line by line, so a run that dies halfway
 * still leaves its transcript behind.
 *
 * Exit codes: `0` every step passed; `1` one of them did not, with the step named on the last line.
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

  section("step 3 — a daemon from before ADR 0031's cut, met by this build");
  if (
    step("the cut proof", {
      command: process.execPath,
      args: [
        "--import",
        TS_SOURCE_HOOK,
        join(REPO, "apps", "cli", "src", "install", "update", "testing", "cut-proof.ts"),
      ],
      shell: false,
    }) !== 0
  ) {
    failed.push("step 3, the cut proof");
  }
}

section("verdict");
if (failed.length > 0) {
  say(`FAILED: ${failed.join("; ")}`);
  say("the render half of the sixth assertion is B6's rerun and was not attempted here");
  process.exitCode = 1;
} else {
  say(
    "PASSED: every boundary reported and recovered, the toolchain refusal disturbed nothing, and " +
      "a daemon from before the cut was refused by update, setup and daemon update and still answers ok",
  );
  say(
    "the marker satisfies the rolled-back runtime's own requirements; the still itself is B6's " +
      "rerun through scripts/e2e/toolchain.mjs, against the browser setup acquires",
  );
}
