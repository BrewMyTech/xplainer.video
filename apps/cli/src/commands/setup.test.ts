/**
 * `xplainer setup`, driven as the real commander program with a recording `CliIo`.
 *
 * Three things are asserted here and nowhere else. **Which components a spelling selects** — the
 * default less each `--skip-*` flag, with `--workspace` gone as an unknown option. **The marker**:
 * that a partial run leaves the state directory usable and says what is still missing, that a
 * second run merges into what the first recorded, and that what lands on disk is a document
 * `install`'s own preflight validates. And **the previous renderer's install** (D7): removed from the
 * workspace only when it is provably the tree an earlier `setup` wrote, only once the refusal to
 * cross the cut has passed, and printed when it is.
 *
 * The heavy half is deliberately elsewhere: a real browser download is `download.test.ts`'s
 * loopback server.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { Toolchain } from "@xplainer/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { updateDaemonState } from "../daemon/daemon-state.js";
import { stateDirLayout } from "../daemon/state-dir.js";
import { toolchainMarkerPath } from "../install/preflight.js";
import { buildFixturePayload } from "../install/testing/payload.js";
import type { CliIo } from "../io.js";
import { createProgram } from "../program.js";
import { LAST_TEMPLATE, PREVIOUS_WORKSPACE_MANIFEST } from "../setup/previous-renderer.js";
import { CHROME_PROVIDER } from "../setup/providers/chrome.js";
import { committedManifestPath } from "../setup/source.js";
import { writeFakeFfmpeg } from "../setup/testing/fake-ffmpeg.js";
import { recordTestToolchain } from "../setup/testing/toolchain.js";
import { readToolchainMarker } from "../setup/toolchain.js";
import { SETUP_COMPONENTS, selectedComponents, TOOLCHAIN_DIR_NAME } from "./setup.js";

const directories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Run the real program, recording what a user would have seen and the code it would have exited. */
async function run(argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  const io: CliIo = {
    writeOut(text) {
      stdout += text;
    },
    writeErr(text) {
      stderr += text;
    },
    exit(code) {
      exitCode = code;
      throw new ExitSignal();
    },
  };
  try {
    await createProgram(io).parseAsync(["node", "xplainer", ...argv]);
  } catch (error) {
    if (!(error instanceof ExitSignal)) {
      throw error;
    }
  }
  return { stdout, stderr, exitCode };
}

class ExitSignal extends Error {}

/** A run that acquires nothing: what is left is the marker, the lexicon and D7's removal. */
const SKIP_ALL = ["--skip-browser", "--skip-ffmpeg", "--skip-speech"] as const;

describe("selectedComponents", () => {
  /**
   * A bare run acquires all three, and each `--skip-*` flag leaves one out. `--speech`,
   * `--tts-url` and `--ffmpeg-path` say *which* route or binary rather than whether, so none of
   * them changes the selection.
   */
  it("selects all three by default, and leaves out what each --skip-* flag names", () => {
    expect(selectedComponents({})).toEqual(["browser", "ffmpeg", "speech"]);
    expect(selectedComponents({ skipSpeech: true })).toEqual(["browser", "ffmpeg"]);
    expect(selectedComponents({ skipBrowser: true, skipSpeech: true })).toEqual(["ffmpeg"]);
    expect(selectedComponents({ skipBrowser: true, skipFfmpeg: true, skipSpeech: true })).toEqual(
      [],
    );
    expect(selectedComponents({ ffmpegPath: "/usr/bin/ffmpeg" })).toEqual(SETUP_COMPONENTS);
    expect(selectedComponents({ ttsUrl: "http://127.0.0.1:8880", speech: "onnx" })).toEqual(
      SETUP_COMPONENTS,
    );
  });
});

describe("xplainer setup", () => {
  it("reports what it will acquire before it acquires anything", async () => {
    const stateDir = temporaryDirectory("xplainer-setup-state-");
    const workspace = temporaryDirectory("xplainer-setup-workspace-");

    const { stdout, exitCode } = await runWithEnv(
      [
        "setup",
        "--state-dir",
        stateDir,
        "--skip-browser",
        "--skip-ffmpeg",
        "--skip-speech",
        "--manifest",
        committedManifestPath() ?? "",
      ],
      { XPLAINER_VIDEOS_DIR: workspace },
    );

    expect(exitCode, stdout).toBe(0);
    expect(stdout).toContain(`state directory ${stateDir}`);
    expect(stdout).toContain("acquiring: nothing");
    expect(existsSync(join(stateDir, TOOLCHAIN_DIR_NAME))).toBe(true);
  });

  /**
   * A run that acquired one component leaves a state directory a later run can finish, and says so.
   * Refusing to write anything would be the same outcome with less information; writing an
   * incomplete marker would produce a document `install`'s preflight rejects as corrupt.
   */
  it("records nothing yet after a partial run, and names what is still to acquire", async () => {
    const stateDir = temporaryDirectory("xplainer-setup-state-");
    const workspace = temporaryDirectory("xplainer-setup-workspace-");

    const { stdout, exitCode } = await runWithEnv(["setup", "--state-dir", stateDir, ...SKIP_ALL], {
      XPLAINER_VIDEOS_DIR: workspace,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("nothing was recorded in toolchain.json yet");
    expect(stdout).toContain("browser");
    expect(stdout).toContain("speech");
    expect(existsSync(toolchainMarkerPath(stateDir))).toBe(false);
  });

  /**
   * `--tts-url` skips both acquiring routes, which is what lets a machine with no Docker and no
   * published bundle still record a complete toolchain — and what makes the marker's `provider`
   * field worth having, since the routes are not interchangeable.
   */
  it("merges a later run into what an earlier one recorded, and writes the marker once complete", async () => {
    const stateDir = temporaryDirectory("xplainer-setup-state-");
    const workspace = temporaryDirectory("xplainer-setup-workspace-");

    const first = await runWithEnv(["setup", "--state-dir", stateDir, ...SKIP_ALL], {
      XPLAINER_VIDEOS_DIR: workspace,
    });
    expect(first.exitCode).toBe(0);

    const second = await runWithEnv(
      [
        "setup",
        "--state-dir",
        stateDir,
        "--skip-browser",
        "--skip-ffmpeg",
        "--tts-url",
        "http://127.0.0.1:8880",
        "--manifest",
        committedManifestPath() ?? "",
      ],
      { XPLAINER_VIDEOS_DIR: workspace },
    );

    expect(second.exitCode, second.stderr).toBe(0);
    // Still incomplete: the browser was skipped in both runs, so there is nothing to record for it.
    expect(existsSync(toolchainMarkerPath(stateDir))).toBe(false);
    expect(second.stdout).toContain("browser");
    expect(second.stdout).not.toContain("still to acquire: speech");
  });

  /**
   * `--speech` names one of the two routes that acquire something, and a value that is neither is a
   * usage error before anything is resolved — exit `1`, the table's usage code, with the sentence
   * naming both routes *and* the two ways to reach the other two. A `choices()` on the option would
   * exit `1` too and would say only "allowed choices are onnx, docker", which leaves a user who
   * meant a server they already run with nowhere to go.
   */
  it("refuses a --speech value that is not a route, with exit 1 and nothing written", async () => {
    const stateDir = temporaryDirectory("xplainer-setup-state-");

    const { stderr, exitCode } = await run([
      "setup",
      "--state-dir",
      stateDir,
      "--speech",
      "kokoro",
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("--speech kokoro is not a route");
    expect(stderr).toContain("onnx or docker");
    expect(stderr).toContain("--tts-url <url>");
    expect(existsSync(toolchainMarkerPath(stateDir))).toBe(false);
    // Not even the toolchain directory: the check is above every resolution this command does.
    expect(existsSync(join(stateDir, TOOLCHAIN_DIR_NAME))).toBe(false);
  });

  /**
   * AC-A9: the workspace is sources only and `setup` acquires nothing into it, so the flag that
   * used to install the previous renderer there is commander's own unknown option — exit `1`, the
   * table's usage code — and not a no-op that a script relying on it would mistake for success.
   */
  it("refuses --workspace as an unknown option, with exit 1 and nothing written", async () => {
    const stateDir = temporaryDirectory("xplainer-setup-state-");

    const { stderr, exitCode } = await run(["setup", "--state-dir", stateDir, "--workspace"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown option '--workspace'");
    expect(existsSync(join(stateDir, TOOLCHAIN_DIR_NAME))).toBe(false);
  });

  /**
   * The document that lands on disk is the one three other surfaces read, so it is asserted through
   * the reader `install/preflight.ts` uses rather than as the object this command happened to build.
   *
   * It starts from a **version-1** marker, which is what every machine set up before ADR 0031's cut
   * holds: a run that acquires nothing reads its two components and writes version 2 with no
   * `workspace` at all (§Note, 2026-11-12, D1).
   */
  it("rewrites a version-1 marker as version 2, without a workspace, keeping what it recorded", async () => {
    const stateDir = temporaryDirectory("xplainer-setup-state-");
    const workspace = temporaryDirectory("xplainer-setup-workspace-");

    // The browser and speech halves this suite does not download, recorded exactly as a
    // version-1 `setup` recorded them, with the workspace beside them and no ffmpeg.
    const recorded = recordTestToolchain({ stateDir, ffmpeg: false });
    writeFileSync(
      toolchainMarkerPath(stateDir),
      `${JSON.stringify({
        ...recorded,
        format_version: 1,
        workspace: { platform: `${process.platform}-${process.arch}`, version: "1.0.0" },
      })}\n`,
    );
    const { exitCode, stdout } = await runWithEnv(["setup", "--state-dir", stateDir, ...SKIP_ALL], {
      XPLAINER_VIDEOS_DIR: workspace,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("recorded ");
    const marker = readToolchainMarker(stateDir);
    expect(marker?.format_version).toBe(2);
    expect(marker?.chrome).toEqual(recorded.chrome);
    expect(marker?.speech).toEqual(recorded.speech);
    const onDisk = JSON.parse(readFileSync(toolchainMarkerPath(stateDir), "utf8")) as Toolchain;
    expect(onDisk).not.toHaveProperty("workspace");
    expect(onDisk.speech.provider).toBe("docker");
    expect(onDisk.chrome.provider).toBe(CHROME_PROVIDER);
  });
});

/**
 * The ffmpeg component (ADR 0031 §Note, 2026-11-12, D6 and D12). The download route itself is
 * `providers/ffmpeg.test.ts`'s, against a real binary over the loopback server; what is asserted
 * here is what the command does with it — the route a flag selects, and that a row recording this
 * platform's build as unavailable is a printed skip and a marker without ffmpeg rather than a
 * failure, so `setup` and `xplainer update` keep working on such a platform.
 */
describe("xplainer setup — ffmpeg", () => {
  /** A machine whose browser and speech are already recorded, with no ffmpeg. */
  function machineWithoutFfmpeg(): { stateDir: string; env: Record<string, string> } {
    const stateDir = temporaryDirectory("xplainer-setup-state-");
    recordTestToolchain({ stateDir, ffmpeg: false });
    return {
      stateDir,
      env: { XPLAINER_VIDEOS_DIR: temporaryDirectory("xplainer-setup-workspace-") },
    };
  }

  it("records the ffmpeg --ffmpeg-path names, as provider path, without reading a manifest", async () => {
    const { stateDir, env } = machineWithoutFfmpeg();
    const fake = writeFakeFfmpeg(temporaryDirectory("xplainer-setup-ffmpeg-"), {
      licence: "GPL-3.0-or-later",
    });

    const { stdout, stderr, exitCode } = await runWithEnv(
      ["setup", "--state-dir", stateDir, "--skip-browser", "--skip-speech", "--ffmpeg-path", fake],
      env,
    );

    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain("acquiring: ffmpeg");
    expect(stdout).not.toContain("manifest");
    const marker = readToolchainMarker(stateDir);
    expect(marker?.ffmpeg).toMatchObject({
      path: fake,
      provider: "path",
      licence: "GPL-3.0-or-later",
      files: [{ path: fake }],
    });
    expect(marker?.ffmpeg).not.toHaveProperty("publisher");
  });

  it("refuses --ffmpeg-path beside --skip-ffmpeg, and a path that is no ffmpeg, writing nothing", async () => {
    const { stateDir, env } = machineWithoutFfmpeg();
    const before = readFileSync(toolchainMarkerPath(stateDir), "utf8");

    const both = await runWithEnv(
      ["setup", "--state-dir", stateDir, "--ffmpeg-path", "/usr/bin/ffmpeg", "--skip-ffmpeg"],
      env,
    );
    expect(both.exitCode).toBe(1);
    expect(both.stderr).toContain("give one or the other");

    const missing = join(temporaryDirectory("xplainer-setup-ffmpeg-"), "ffmpeg");
    const nothing = await runWithEnv(
      [
        "setup",
        "--state-dir",
        stateDir,
        "--skip-browser",
        "--skip-speech",
        "--ffmpeg-path",
        missing,
      ],
      env,
    );
    expect(nothing.exitCode).toBe(3);
    expect(nothing.stderr).toContain(`--ffmpeg-path names ${missing}`);
    expect(readFileSync(toolchainMarkerPath(stateDir), "utf8")).toBe(before);
  });

  /**
   * The generic form of D12's skip. Every row in the committed manifest is recorded, so the case is
   * seeded: this platform's row is replaced by an `unavailable` one, as a manifest would carry a
   * platform whose build is not yet published.
   */
  it("prints a skip naming --ffmpeg-path and writes the marker without ffmpeg for an unavailable row", async () => {
    const { stateDir, env } = machineWithoutFfmpeg();
    const committed = JSON.parse(readFileSync(committedManifestPath() ?? "", "utf8")) as {
      ffmpeg: { expected: Record<string, unknown> };
    };
    const key = `${process.platform}-${process.arch}`;
    committed.ffmpeg.expected[key] = {
      status: "unavailable",
      reason: "the build for this platform is not published yet.",
    };
    const manifest = join(temporaryDirectory("xplainer-setup-manifest-"), "manifest.json");
    writeFileSync(manifest, `${JSON.stringify(committed)}\n`);

    const { stdout, stderr, exitCode } = await runWithEnv(
      ["setup", "--state-dir", stateDir, "--skip-browser", "--skip-speech", "--manifest", manifest],
      env,
    );

    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain(
      `ffmpeg: skipped — The toolchain manifest records the ffmpeg for ${key} as unavailable: ` +
        "the build for this platform is not published yet.",
    );
    expect(stdout).toContain("`xplainer setup --ffmpeg-path <file>`");
    expect(stdout).toContain("ffmpeg is not recorded: stills will work");
    const onDisk = JSON.parse(readFileSync(toolchainMarkerPath(stateDir), "utf8")) as Toolchain;
    expect(onDisk.format_version).toBe(2);
    expect(onDisk).not.toHaveProperty("ffmpeg");
  });
});

/**
 * D2 (c): `setup` writes a version-2 marker, and a daemon installed from before ADR 0031's cut reads
 * version 1 — so under such a daemon it refuses, exit `3`, having written nothing, and names the
 * reinstall rather than running it (§Note, 2026-11-12). The daemon is found the way every surface
 * finds it: `daemon.json`'s `runtime_dir`, then that runtime's own manifest.
 */
describe("xplainer setup — under a daemon installed from the other side of the cut", () => {
  /** A state directory holding a version-1 marker and a daemon registered from `runtimeDir`. */
  function preCutMachine(runtimeDir: string): { stateDir: string; marker: string } {
    const stateDir = temporaryDirectory("xplainer-setup-state-");
    const recorded = recordTestToolchain({ stateDir, ffmpeg: false });
    const marker = `${JSON.stringify({
      ...recorded,
      format_version: 1,
      workspace: { platform: `${process.platform}-${process.arch}`, version: "1.0.0" },
    })}\n`;
    writeFileSync(toolchainMarkerPath(stateDir), marker);
    updateDaemonState(stateDir, { runtime_dir: runtimeDir });
    return { stateDir, marker };
  }

  const setupArgv = (stateDir: string): string[] => [
    "setup",
    "--state-dir",
    stateDir,
    "--skip-browser",
    "--skip-ffmpeg",
    "--skip-speech",
    "--manifest",
    committedManifestPath() ?? "",
  ];

  function expectReinstall(stderr: string): void {
    const uninstall = stderr.indexOf("  xplainer daemon uninstall\n");
    expect(uninstall).toBeGreaterThan(-1);
    expect(stderr.indexOf("  xplainer setup\n")).toBeGreaterThan(uninstall);
    expect(stderr.indexOf("  xplainer daemon install\n")).toBeGreaterThan(
      stderr.indexOf("  xplainer setup\n"),
    );
  }

  it("refuses with exit 3 and leaves the marker's bytes exactly as they were", async () => {
    const preCut = buildFixturePayload({
      outDir: join(temporaryDirectory("xplainer-setup-precut-"), "payload"),
      version: "0.0.9",
      marker: "0.0.9",
      runnable: false,
      toolchain: null,
    });
    const { stateDir, marker } = preCutMachine(preCut.outDir);
    const listing = readdirSync(stateDir, { recursive: true }).map(String).sort();

    const { stdout, stderr, exitCode } = await run(setupArgv(stateDir));

    expect(exitCode, stderr).toBe(3);
    expect(stderr).toContain(`runs the runtime at ${preCut.outDir}`);
    expect(stderr).toContain("reads toolchain.json format 1");
    expect(stderr).toContain("Nothing was run and nothing was written.");
    expectReinstall(stderr);
    expect(stdout).toBe("");
    expect(readFileSync(toolchainMarkerPath(stateDir), "utf8")).toBe(marker);
    // Not one entry added or removed: the refusal comes before the toolchain directory is made.
    expect(readdirSync(stateDir, { recursive: true }).map(String).sort()).toEqual(listing);
  });

  it("treats a recorded runtime it cannot read as one from before the cut, and says so", async () => {
    const gone = join(temporaryDirectory("xplainer-setup-gone-"), "runtime", "0.0.9-0123456789ab");
    const { stateDir, marker } = preCutMachine(gone);

    const { stderr, exitCode } = await run(setupArgv(stateDir));

    expect(exitCode, stderr).toBe(3);
    expect(stderr).toContain(`records the runtime at ${gone}, whose manifest cannot be read`);
    expect(stderr).toContain("treated as a runtime from before the cut");
    expectReinstall(stderr);
    expect(readFileSync(toolchainMarkerPath(stateDir), "utf8")).toBe(marker);
  });

  it("stops with exit 11 on a daemon.json it cannot read, rather than guessing", async () => {
    const stateDir = temporaryDirectory("xplainer-setup-state-");
    writeFileSync(stateDirLayout(stateDir).daemonState, "{ not json");

    const { stderr, exitCode } = await run(setupArgv(stateDir));

    expect(exitCode, stderr).toBe(11);
    expect(stderr).toContain("cannot be read as JSON");
    expect(existsSync(join(stateDir, TOOLCHAIN_DIR_NAME))).toBe(false);
  });

  it("runs as usual under a daemon whose runtime reads format 2", async () => {
    const current = buildFixturePayload({
      outDir: join(temporaryDirectory("xplainer-setup-current-"), "payload"),
      version: "0.0.12",
      marker: "0.0.12",
      runnable: false,
    });
    const stateDir = temporaryDirectory("xplainer-setup-state-");
    updateDaemonState(stateDir, { runtime_dir: current.outDir });
    const workspace = temporaryDirectory("xplainer-setup-workspace-");

    const { stdout, stderr, exitCode } = await runWithEnv(setupArgv(stateDir), {
      XPLAINER_VIDEOS_DIR: workspace,
    });

    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain("acquiring: nothing");
  });
});

/**
 * D7 through the command (ADR 0031 §Note, 2026-11-12): which trees count is
 * `setup/previous-renderer.test.ts`'s subject; what is asserted here is where the command runs it —
 * the workspace root `XPLAINER_VIDEOS_DIR` names, every time, and never before D2 (c) has passed —
 * and that what it removed is printed.
 */
describe("xplainer setup — the previous renderer's install (D7)", () => {
  /** A workspace root as an older `setup --workspace` left it, with a video beside the tree. */
  function previousTree(packageJson: Record<string, unknown> = { ...LAST_TEMPLATE }): string {
    const root = temporaryDirectory("xplainer-setup-workspace-");
    mkdirSync(join(root, "node_modules", "react"), { recursive: true });
    writeFileSync(join(root, "node_modules", "react", "package.json"), "{}\n");
    writeFileSync(join(root, "package.json"), `${JSON.stringify(packageJson)}\n`);
    writeFileSync(join(root, "package-lock.json"), "{}\n");
    writeFileSync(
      join(root, PREVIOUS_WORKSPACE_MANIFEST),
      `${JSON.stringify({ kind: "workspace", remotion_entry: "node_modules/cli/cli.js" })}\n`,
    );
    mkdirSync(join(root, "videos", "demo"), { recursive: true });
    writeFileSync(join(root, "videos", "demo", "Scenes.tsx"), "export const scenes = [];\n");
    return root;
  }

  it("removes the tree an earlier setup wrote under XPLAINER_VIDEOS_DIR, says so, keeps videos", async () => {
    const stateDir = temporaryDirectory("xplainer-setup-state-");
    const workspace = previousTree();

    const { stdout, stderr, exitCode } = await runWithEnv(
      ["setup", "--state-dir", stateDir, ...SKIP_ALL],
      { XPLAINER_VIDEOS_DIR: workspace },
    );

    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain(
      `removed the previous renderer's install from ${workspace}: node_modules/, ` +
        `package-lock.json, package.json, ${PREVIOUS_WORKSPACE_MANIFEST}.`,
    );
    expect(readdirSync(workspace).sort()).toEqual(["videos"]);
    expect(readFileSync(join(workspace, "videos", "demo", "Scenes.tsx"), "utf8")).toBe(
      "export const scenes = [];\n",
    );
  });

  it("leaves a project of the user's own exactly as it is, and says nothing about it", async () => {
    const stateDir = temporaryDirectory("xplainer-setup-state-");
    const workspace = previousTree({ name: "my-videos", dependencies: { react: "19.2.8" } });
    rmSync(join(workspace, PREVIOUS_WORKSPACE_MANIFEST));
    const listing = readdirSync(workspace, { recursive: true }).map(String).sort();

    const { stdout, exitCode } = await runWithEnv(["setup", "--state-dir", stateDir, ...SKIP_ALL], {
      XPLAINER_VIDEOS_DIR: workspace,
    });

    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("previous renderer");
    expect(readdirSync(workspace, { recursive: true }).map(String).sort()).toEqual(listing);
  });

  it("keeps a tree whose package.json is not the last template's, and says why", async () => {
    const stateDir = temporaryDirectory("xplainer-setup-state-");
    const workspace = previousTree({
      ...LAST_TEMPLATE,
      dependencies: { ...LAST_TEMPLATE.dependencies, react: "19.2.8" },
    });
    const listing = readdirSync(workspace, { recursive: true }).map(String).sort();

    const { stdout, exitCode } = await runWithEnv(["setup", "--state-dir", stateDir, ...SKIP_ALL], {
      XPLAINER_VIDEOS_DIR: workspace,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain(`left the previous renderer's install in ${workspace} as it is`);
    expect(readdirSync(workspace, { recursive: true }).map(String).sort()).toEqual(listing);
  });

  it("removes nothing while a daemon from before the cut is installed", async () => {
    const preCut = buildFixturePayload({
      outDir: join(temporaryDirectory("xplainer-setup-precut-"), "payload"),
      version: "0.0.9",
      marker: "0.0.9",
      runnable: false,
      toolchain: null,
    });
    const stateDir = temporaryDirectory("xplainer-setup-state-");
    updateDaemonState(stateDir, { runtime_dir: preCut.outDir });
    const workspace = previousTree();
    const listing = readdirSync(workspace, { recursive: true }).map(String).sort();

    const { exitCode } = await runWithEnv(["setup", "--state-dir", stateDir, ...SKIP_ALL], {
      XPLAINER_VIDEOS_DIR: workspace,
    });

    expect(exitCode).toBe(3);
    expect(readdirSync(workspace, { recursive: true }).map(String).sort()).toEqual(listing);
  });
});

/** Run the program with `env` merged into `process.env` for the length of one call. */
async function runWithEnv(
  argv: string[],
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const before = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    return await run(argv);
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
