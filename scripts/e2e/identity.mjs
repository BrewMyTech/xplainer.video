#!/usr/bin/env node
/**
 * The T17 gate: the three-row consistency check, on this machine.
 *
 * `desired` is what `daemon.json` records, `loaded` is what the supervisor is actually holding, and
 * `responding` is what the daemon advertises about itself on `/healthz`. A two-way comparison cannot
 * see a switch that was written and never reloaded — reading our own file back reports success — so
 * this runs both halves of the evidence in one command.
 *
 * **Step 1 — the comparison, in `apps/cli/src/install/supervisors/identity.test.ts`.** All three
 * platforms, with the supervisor and `/healthz` as seams, plus a **real** `xplainer serve` whose
 * advertised digest is recomputed from the argv, the settings and the working directory it was
 * launched with. The systemd answers it parses are the literal bytes a real user manager printed,
 * kept in `apps/cli/src/install/__fixtures__/`.
 *
 * **Step 2 — the real machine, in `install/testing/identity-proof.ts`.** A payload assembled by the
 * shipped assembler, installed under this machine's own service manager, and the four failure
 * scenarios driven against it: a hand-edited record, an artefact rewritten and never reloaded, a
 * switch that was reloaded but never restarted, and a settings-only change. It is what step 1 cannot
 * be: **the loaded row really goes stale**, which is a property of somebody else's software.
 *
 * ```bash
 * pnpm e2e:identity
 * ```
 *
 * It is **not** part of `pnpm verify` and must not become part of it: step 2 assembles a ~160 MB
 * payload and registers a service with this machine's own supervisor. On macOS that registration is
 * a throwaway label booted out in a `finally`; on Linux systemd reads only the account's own config
 * directory, so that leg installs the real unit there and removes it — run it on a runner or in
 * `infra/e2e/Dockerfile.systemd` rather than on a machine somebody is using.
 *
 * Environment it reads: `COLLIE_ARTIFACTS_DIR` (default `<repo>/.session/artifacts`). Everything it
 * prints is also written to `<artifacts>/e2e-identity.log`, line by line, so a run that dies halfway
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
const LOG_PATH = join(ARTIFACTS, "e2e-identity.log");

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
 * The output is the evidence here — the proof prints one `ok:` line per expectation and names which
 * detector fired — so nothing is swallowed and nothing is summarised.
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
say(`${stamp()} pnpm e2e:identity — desired, loaded and responding, compared`);
say(`repository: ${REPO}`);
say(`transcript: ${LOG_PATH}`);

// The assembler copies `apps/cli/dist` and refuses a checkout that has none, so the build is a step
// of its own: a build failure has to be legible as one rather than as an assembly refusal.
const failed = [];
if (step("building every member", pnpm("turbo", "build")) !== 0) {
  failed.push("the build");
}

if (failed.length === 0) {
  section("step 1 — the comparison on all three platforms, plus a real `serve` for row 3");
  if (
    step(
      "the identity suite",
      pnpm(
        "--filter",
        "@xplainer/cli",
        "exec",
        "vitest",
        "run",
        "src/install/supervisors/identity.test.ts",
      ),
    ) !== 0
  ) {
    failed.push("step 1, the identity suite");
  }

  section("step 2 — a real payload, a real supervisor and a real daemon");
  if (
    step("the identity proof", {
      command: process.execPath,
      args: [
        "--import",
        TS_SOURCE_HOOK,
        join(REPO, "apps", "cli", "src", "install", "testing", "identity-proof.ts"),
      ],
      shell: false,
    }) !== 0
  ) {
    failed.push("step 2, the identity proof");
  }
}

section("verdict");
if (failed.length > 0) {
  say(`FAILED: ${failed.join("; ")}`);
  process.exitCode = 1;
} else {
  say("PASSED: every scenario reported the detector the plan says it should");
  say(
    "Windows is runner-only: `daemon-identity.yml` is where `Get-ScheduledTask` answers for a real " +
      "registered task, and nothing here has asked one",
  );
}
