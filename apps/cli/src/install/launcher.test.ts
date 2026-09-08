/**
 * The launcher, proved by launching: one staged runtime, one live daemon, one stable path.
 *
 * §2.1's claim is that a consumer may hold `<state>/bin/xplainer` across an update, and the only
 * way to check it is to run the thing. So this suite stages a **real payload-1 artefact**, starts a
 * daemon out of it through the launch contract `runtime/launch-spec.ts` builds, and then runs the
 * launcher as a separate process and asks it — over the daemon's own socket — which daemon it
 * reached. Nothing is substituted: the launcher is the generated script, the interpreter inside the
 * payload is a real one, and the identity comes back over loopback rather than out of a variable
 * this file set.
 *
 * The second half is the property the first half exists for. The launcher is rewritten to a
 * **second** staged runtime while the first daemon is still up, and the same path then runs out of
 * the second one — which is what makes `connect`'s written entry, the desktop's shell-outs and
 * `attach.ts`'s remediation survive an update that renames the runtime directory.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildLaunchSpec, type LaunchSpec } from "../runtime/launch-spec.js";
import { LAUNCHER_MODE, launcherPath, renderLauncher, writeLauncher } from "./launcher.js";
import { type ResolvedProgram, resolveProgram } from "./program.js";
import { stageRuntime } from "./stage.js";
import { buildFixturePayload } from "./testing/payload.js";

/** Everything one spawned daemon leaves behind, for the assertions and for the teardown. */
type LiveDaemon = {
  pid: number;
  ready: { runtime: string; marker: string; pid: number; port: number };
};

/**
 * The budget for a case that runs the launcher as a real process.
 *
 * Vitest's default is five seconds and this suite's two spawning cases measured 0.4 s and 1.2 s on
 * an idle machine — the second one higher because it is the first run out of the *second* payload,
 * whose 146 MB of interpreter and modules are still cold. Under a full `vitest run` those two costs
 * land beside every other suite's children, and the second case is the one that was seen to exceed
 * five seconds. The budget is raised rather than the work reduced: what makes this suite worth
 * anything is that it launches the real artefact, and a 60 s ceiling still fails a hang in a
 * fraction of the job's own timeout.
 */
const SPAWN_TIMEOUT_MS = 60_000;

let scratch = "";
let stateDir = "";
let firstRuntime = "";
let secondRuntime = "";
let firstProgram: ResolvedProgram;
let spec: LaunchSpec;
let daemon: LiveDaemon;
let killDaemon: () => void = () => {};

beforeAll(async () => {
  // The real path, because Node resolves a module's own symlinks before it runs it: the payload's
  // entry reports where it is from `import.meta.url`, and on macOS `/var` is a link to `/private/var`.
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "xplainer-launcher-")));
  stateDir = join(scratch, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  const alpha = buildFixturePayload({
    outDir: join(scratch, "payload-alpha"),
    version: "1.2.3",
    marker: "alpha",
  });
  const beta = buildFixturePayload({
    outDir: join(scratch, "payload-beta"),
    version: "1.2.4",
    marker: "beta",
  });

  firstRuntime = stageRuntime({ payloadDir: alpha.outDir, stateDir }).path;
  secondRuntime = stageRuntime({ payloadDir: beta.outDir, stateDir }).path;
  firstProgram = resolveProgram({ stateDir, runtimeDir: firstRuntime });

  spec = buildLaunchSpec({
    runtimeDir: firstRuntime,
    port: 0,
    settings: {
      stateDir,
      tokenFile: join(stateDir, "token"),
      socket: join(stateDir, "ipc", "xplainer.sock"),
    },
  });
  daemon = await startDaemon(spec);
  writeLauncher({ stateDir, program: firstProgram });
}, 120_000);

afterAll(() => {
  killDaemon();
  rmSync(scratch, { recursive: true, force: true });
});

describe("the stable launcher", () => {
  it(
    "reaches the daemon the staged runtime's own launch spec started",
    () => {
      // The spec started the daemon out of the staged directory, and said so over its own socket.
      expect(daemon.ready.runtime).toBe(firstRuntime);
      expect(spec.executable).toBe(join(firstRuntime, "bin", "node"));

      const answer = runLauncher(["whoami", "an argument with spaces"]);
      expect(answer.reached).toEqual({
        runtime: firstRuntime,
        marker: "alpha",
        pid: daemon.pid,
      });
      expect(answer.launcher_runtime).toBe(firstRuntime);
      expect(answer.forwarded).toEqual(["an argument with spaces"]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it("is two lines that exec the runtime's own node and its dist/bin.js", () => {
    const path = launcherPath(stateDir);
    expect(path).toBe(join(stateDir, "bin", "xplainer"));
    const lines = readFileSync(path, "utf8").split("\n").slice(0, -1);
    expect(lines).toEqual([
      "#!/bin/sh",
      `exec "${join(firstRuntime, "bin", "node")}" ` +
        `"${join(firstRuntime, "lib", "node_modules", "@xplainer", "cli", "dist", "bin.js")}" "$@"`,
    ]);
    expect(statSync(path).mode & 0o777).toBe(LAUNCHER_MODE);
  });

  it(
    "rewritten to a second staged runtime, the same path now runs out of that one",
    () => {
      const before = launcherPath(stateDir);
      const written = writeLauncher({
        stateDir,
        program: resolveProgram({ stateDir, runtimeDir: secondRuntime }),
      });
      expect(written.path).toBe(before);
      expect(written.replaced).toBe(true);

      const answer = runLauncher(["whoami"]);
      expect(answer.launcher_runtime).toBe(secondRuntime);
      expect(answer.launcher_marker).toBe("beta");
      // The daemon did not move: rewriting the launcher changes which runtime the *path* runs, and
      // the process a supervisor is holding stays exactly where it was until it is restarted.
      expect(answer.reached.runtime).toBe(firstRuntime);
    },
    SPAWN_TIMEOUT_MS,
  );

  it("replaces a launcher that is already there, by rename, at the same path", () => {
    const path = launcherPath(stateDir);
    const before = statSync(path);
    const written = writeLauncher({ stateDir, program: firstProgram });
    expect(written.replaced).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(written.script);
    // §7.11: `renameSync` replaces an existing file rather than refusing. A new inode at the same
    // path is what a rename leaves behind, and is why no consumer sees a half-written launcher.
    expect(statSync(path).ino).not.toBe(before.ino);
  });

  it("recovers a mode a crashed install could otherwise have left behind", () => {
    const path = launcherPath(stateDir);
    chmodSync(path, 0o600);
    writeLauncher({ stateDir, program: firstProgram });
    expect(statSync(path).mode & 0o777).toBe(LAUNCHER_MODE);
  });

  it("renders the Windows form as a `.cmd` that forwards `%*`", () => {
    expect(launcherPath("C:\\state", "win32").endsWith("xplainer.cmd")).toBe(true);
    const script = renderLauncher(firstProgram, "win32");
    expect(script.split("\r\n").slice(0, -1)).toEqual([
      "@echo off",
      `"${firstProgram.executable}" "${String(firstProgram.entry)}" %*`,
    ]);
  });

  it("names an explicit program on its own, with no entry file beside it", () => {
    const program: ResolvedProgram = {
      source: "explicit",
      executable: "/opt/xplainer/xplainer",
      entry: null,
      runtimeDir: null,
      manifest: null,
    };
    expect(renderLauncher(program, "linux")).toBe(
      '#!/bin/sh\nexec "/opt/xplainer/xplainer" "$@"\n',
    );
  });
});

/** What one `whoami` run through the launcher printed. */
type LauncherAnswer = {
  launcher_runtime: string;
  launcher_marker: string;
  forwarded: string[];
  reached: { runtime: string; marker: string; pid: number };
};

/** Run the launcher at its stable path, and parse the one line it prints. */
function runLauncher(args: string[]): LauncherAnswer {
  const path = launcherPath(stateDir);
  const result = spawnSync(path, args, {
    encoding: "utf8",
    // The state directory travels in the environment here so that `forwarded` is exactly what the
    // caller passed: what is being asserted is that the launcher hands its arguments on untouched.
    env: { ...process.env, XPLAINER_STATE_DIR: stateDir },
    // `cmd.exe` is not an executable image, so Windows needs the shell to run a `.cmd` at all.
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`${path} exited ${String(result.status)}\n${result.stdout}\n${result.stderr}`);
  }
  return JSON.parse(result.stdout) as LauncherAnswer;
}

/** Start the daemon exactly as the launch spec says, and wait for its ready line. */
function startDaemon(launch: LaunchSpec): Promise<LiveDaemon> {
  const child = spawn(launch.executable, [...launch.argv], {
    cwd: launch.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  killDaemon = () => {
    child.kill("SIGKILL");
  };
  return new Promise<LiveDaemon>((resolve, reject) => {
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      const line = out.split("\n").find((candidate) => candidate.includes(`"event":"ready"`));
      if (line !== undefined) {
        resolve({ pid: child.pid ?? 0, ready: JSON.parse(line) as LiveDaemon["ready"] });
      }
    });
    child.stderr.on("data", (chunk: string) => {
      err += chunk;
    });
    child.once("exit", (code) => {
      reject(new Error(`the staged runtime exited ${String(code)}\n${out}\n${err}`));
    });
  });
}
