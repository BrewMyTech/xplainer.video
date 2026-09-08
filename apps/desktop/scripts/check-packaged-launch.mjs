/**
 * The packaged application, launched, with the checkout out of reach.
 *
 * `check-packaged-payload.mjs` proves the payload is in the packaged tree and runs. This proves the
 * thing that actually ships does the running: the **packaged executable** is started, and the
 * `payload_probe` line it prints names the interpreter it spawned. Decision D10 is only true if
 * that interpreter is the one inside the application bundle.
 *
 * Three things are taken away before the app starts, so a pass cannot be a coincidence:
 *
 *   * **The checkout.** The application is copied out of the repository into a temporary directory
 *     and launched from there. Nothing it does can reach `apps/cli/dist`, `node_modules`, or the
 *     payload sitting in `.artefacts/`.
 *   * **`PATH`.** It is replaced with one empty directory, so there is no `node` and no `xplainer`
 *     for anything to fall back to. This is the machine ADR 0020 cares about: the user who has
 *     never installed a Node.
 *   * **The state directory.** `XPLAINER_STATE_DIR` points at a temporary directory, so the probe
 *     reports on a machine with no daemon rather than on the developer's own.
 *
 * The app is killed as soon as it has printed its line. It opens a window while it lives, which is
 * why this is a `local` and `human` check and not a runner one: `.github/workflows/desktop.yml`
 * runs the display-free half instead.
 *
 *     node apps/desktop/scripts/check-packaged-launch.mjs
 *
 * On Linux it needs a display; run it under `xvfb-run -a`.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** `apps/desktop`, derived from this file rather than from the working directory. */
const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where electron-builder writes, per `directories.output`. */
const RELEASE_DIR = join(DESKTOP_DIR, "release");

/** How long the packaged app is given to print its probe line before it is killed. */
const LAUNCH_TIMEOUT_MS = 60_000;

/**
 * The packaged application for this platform: the executable, and the bundle to copy.
 *
 * `bundle` is what is copied out of the checkout — the `.app` on macOS, the unpacked directory
 * elsewhere — and `executable` is stated relative to it, so the copy is launched by its own path
 * and never by the original.
 */
function packagedApplication() {
  if (process.platform === "darwin") {
    const macDirs = existsSync(RELEASE_DIR)
      ? readdirSync(RELEASE_DIR).filter((name) => name === "mac" || name.startsWith("mac-"))
      : [];
    for (const dir of macDirs) {
      const parent = join(RELEASE_DIR, dir);
      const app = readdirSync(parent).find((name) => name.endsWith(".app"));
      if (app !== undefined) {
        return { bundle: join(parent, app), executable: ["Contents", "MacOS", "Xplainer"] };
      }
    }
    return null;
  }
  if (process.platform === "win32") {
    const bundle = join(RELEASE_DIR, "win-unpacked");
    return existsSync(bundle) ? { bundle, executable: ["Xplainer.exe"] } : null;
  }
  const bundle = join(RELEASE_DIR, "linux-unpacked");
  return existsSync(bundle) ? { bundle, executable: ["xplainer"] } : null;
}

/**
 * Copy the packaged application to `destination`.
 *
 * macOS uses `ditto` because a `.app` is a signed bundle: `ditto` is the only copy Apple documents
 * as preserving one whole, and an ad-hoc signature that a copy invalidated would show up here as a
 * `Killed: 9` that has nothing to do with the payload. Everywhere else a recursive copy that keeps
 * symlinks as symlinks is exactly right — Electron's own `Frameworks` layout is made of them.
 */
function copyApplication(bundle, destination) {
  if (process.platform === "darwin") {
    const copied = spawnSync("/usr/bin/ditto", [bundle, destination], { encoding: "utf8" });
    if (copied.status !== 0) {
      throw new Error(`ditto exited ${copied.status}: ${copied.stderr}`);
    }
    return;
  }
  cpSync(bundle, destination, { recursive: true, dereference: false, preserveTimestamps: true });
}

/** Start the copied application and resolve with everything it wrote before it was stopped. */
function launch(executable, environment) {
  return new Promise((settle, reject) => {
    const child = spawn(executable, [], {
      env: environment,
      cwd: dirname(executable),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let done = false;

    /** Stop the app the moment its line has arrived; `close` is what settles the promise. */
    const finish = () => {
      if (!done) {
        done = true;
        child.kill("SIGTERM");
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes('"event":"payload_probe"') || stdout.includes('"payload_unavailable"')) {
        finish();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      finish();
      child.kill("SIGKILL");
    }, LAUNCH_TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      settle({ code, signal, stdout, stderr });
    });
  });
}

/** The probe line the main process printed, or `null` when it printed none. */
function readProbe(stdout) {
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) {
      continue;
    }
    try {
      const document = JSON.parse(text);
      if (document.event === "payload_probe" || document.event === "payload_unavailable") {
        return document;
      }
    } catch {
      // Not the line: Electron and Chromium write plenty of prose to stdout.
    }
  }
  return null;
}

const application = packagedApplication();
if (application === null) {
  process.stderr.write(
    `nothing packaged under ${RELEASE_DIR}. Pack one first:\n` +
      `  pnpm --filter @xplainer/desktop exec electron-builder --dir --publish never\n`,
  );
  process.exit(1);
}

const sandbox = mkdtempSync(join(tmpdir(), "xplainer-packaged-launch-"));
const emptyPath = join(sandbox, "empty-path");
const stateDir = join(sandbox, "state");
mkdirSync(emptyPath);
mkdirSync(stateDir);

const copied = join(sandbox, application.bundle.split(/[/\\]/).pop());
process.stdout.write(`packaged launch check — ${process.platform}/${process.arch}\n`);
process.stdout.write(`  copying   ${application.bundle}\n       to   ${copied}\n`);
copyApplication(application.bundle, copied);

// Resolved, because Electron reports `process.resourcesPath` resolved and macOS's `/var` is a
// symlink to `/private/var`: the raw temporary path would never match what the app prints.
const copiedRoot = realpathSync(copied);

const executable = join(copied, ...application.executable);
const environment = {
  ...process.env,
  PATH: emptyPath,
  Path: emptyPath,
  XPLAINER_STATE_DIR: stateDir,
};
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.XPLAINER_DAEMON_URL;

process.stdout.write(`  launching ${executable}\n  PATH=${emptyPath}\n`);

let failed = false;
try {
  const run = await launch(executable, environment);
  const probe = readProbe(run.stdout);
  if (probe === null) {
    failed = true;
    process.stdout.write(
      `FAIL  the packaged app printed no payload line (exit ${run.code}, signal ${run.signal})\n` +
        `      stdout: ${JSON.stringify(run.stdout.slice(0, 2000))}\n` +
        `      stderr: ${JSON.stringify(run.stderr.slice(0, 2000))}\n`,
    );
  } else if (probe.event !== "payload_probe") {
    failed = true;
    process.stdout.write(
      `FAIL  the packaged app refused its own payload: ${probe.reason}\n      ${probe.message}\n`,
    );
  } else if (!probe.interpreter.startsWith(copiedRoot)) {
    failed = true;
    process.stdout.write(
      `FAIL  the interpreter it spawned is outside the copied application\n` +
        `      ${probe.interpreter}\n`,
    );
  } else {
    process.stdout.write(
      `ok    the packaged app spawned its own payload with the checkout out of reach\n` +
        `      interpreter ${probe.interpreter}\n` +
        `      entry       ${probe.entry}\n` +
        `      argv        ${probe.argv.join(" ")}\n` +
        `      exit_code   ${probe.exit_code}\n` +
        `      condition   ${probe.condition}\n`,
    );
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

if (failed) {
  process.stdout.write("PACKAGED LAUNCH CHECK FAILED\n");
  process.exitCode = 1;
} else {
  process.stdout.write("PACKAGED LAUNCH CHECK PASSED\n");
}
