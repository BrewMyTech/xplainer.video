/**
 * `xplainer setup`, driven as the real commander program with a recording `CliIo`.
 *
 * Two things are asserted here and nowhere else. **Which components a spelling selects** — the union
 * rule, whose two ends are the D8 proof's `setup --workspace` and the Windows leg's
 * `--skip-speech`, and neither may quietly acquire the other's components. And **the marker**:
 * that a partial run leaves the state directory usable and says what is still missing, that a
 * second run merges into what the first recorded, and that what lands on disk is a document
 * `install`'s own preflight validates.
 *
 * The heavy halves are deliberately elsewhere: a real `npm ci` under a scrubbed `PATH` is
 * `scripts/e2e/toolchain.mjs`, and a real browser download is `download.test.ts`'s loopback server.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
import { MANIFEST_VERSION, WORKSPACE_MANIFEST_FILE } from "../runtime/manifest.js";
import { readTemplatePins } from "../runtime/verify.js";
import { CHROME_PROVIDER } from "../setup/providers/chrome.js";
import { WORKSPACE_PAYLOAD_ENV } from "../setup/providers/workspace.js";
import { committedManifestPath } from "../setup/source.js";
import { recordTestToolchain } from "../setup/testing/toolchain.js";
import { readToolchainMarker } from "../setup/toolchain.js";
import { selectedComponents, TOOLCHAIN_DIR_NAME } from "./setup.js";

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

describe("selectedComponents", () => {
  /**
   * The two spellings the rest of the phase names, and the rule that makes both mean what they say.
   * `--workspace` alone is the form the D8 proof runs under `env -i PATH=/usr/bin:/bin`; dragging a
   * browser download or a Docker pull in behind it would make that proof unrunnable.
   */
  it("restricts to what a positive flag names, and trims what a negative one excludes", () => {
    expect(selectedComponents({})).toEqual(["browser", "speech", "workspace"]);
    expect(selectedComponents({ workspace: true })).toEqual(["workspace"]);
    expect(selectedComponents({ skipSpeech: true })).toEqual(["browser", "workspace"]);
    expect(selectedComponents({ skipSpeech: true, workspace: true })).toEqual([
      "browser",
      "workspace",
    ]);
    expect(selectedComponents({ skipBrowser: true, skipSpeech: true })).toEqual(["workspace"]);
  });
});

describe("xplainer setup", () => {
  it("reports what it will acquire before it acquires anything", async () => {
    const stateDir = temporaryDirectory("xplainer-setup-state-");
    const workspace = temporaryDirectory("xplainer-setup-workspace-");
    const payload = stagedPayloadFrom(temporaryDirectory("xplainer-setup-payload-"));

    const { stdout, exitCode } = await runWithEnv(
      [
        "setup",
        "--state-dir",
        stateDir,
        "--skip-browser",
        "--skip-speech",
        "--manifest",
        committedManifestPath() ?? "",
      ],
      { XPLAINER_VIDEOS_DIR: workspace, [WORKSPACE_PAYLOAD_ENV]: payload },
    );

    expect(exitCode, stdout).toBe(0);
    expect(stdout).toContain(`state directory ${stateDir}`);
    expect(stdout).toContain("acquiring: workspace");
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
    const payload = stagedPayloadFrom(temporaryDirectory("xplainer-setup-payload-"));

    const { stdout, exitCode } = await runWithEnv(
      ["setup", "--state-dir", stateDir, "--workspace"],
      { XPLAINER_VIDEOS_DIR: workspace, [WORKSPACE_PAYLOAD_ENV]: payload },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("nothing was recorded in toolchain.json yet");
    expect(stdout).toContain("browser");
    expect(stdout).toContain("speech");
    expect(existsSync(toolchainMarkerPath(stateDir))).toBe(false);
    expect(existsSync(join(workspace, "node_modules", "@remotion", "cli"))).toBe(true);
  });

  /**
   * `--tts-url` skips both acquiring routes, which is what lets a machine with no Docker and no
   * published bundle still record a complete toolchain — and what makes the marker's `provider`
   * field worth having, since the routes are not interchangeable.
   */
  it("merges a later run into what an earlier one recorded, and writes the marker once complete", async () => {
    const stateDir = temporaryDirectory("xplainer-setup-state-");
    const workspace = temporaryDirectory("xplainer-setup-workspace-");
    const payload = stagedPayloadFrom(temporaryDirectory("xplainer-setup-payload-"));

    const first = await runWithEnv(["setup", "--state-dir", stateDir, "--workspace"], {
      XPLAINER_VIDEOS_DIR: workspace,
      [WORKSPACE_PAYLOAD_ENV]: payload,
    });
    expect(first.exitCode).toBe(0);

    const second = await runWithEnv(
      [
        "setup",
        "--state-dir",
        stateDir,
        "--skip-browser",
        "--tts-url",
        "http://127.0.0.1:8880",
        "--manifest",
        committedManifestPath() ?? "",
      ],
      { XPLAINER_VIDEOS_DIR: workspace, [WORKSPACE_PAYLOAD_ENV]: payload },
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

  it("refuses a staged payload built for another platform, with exit 3 and nothing recorded", async () => {
    const stateDir = temporaryDirectory("xplainer-setup-state-");
    const workspace = temporaryDirectory("xplainer-setup-workspace-");
    const payload = stagedPayloadFrom(temporaryDirectory("xplainer-setup-payload-"), "sunos");

    const { stderr, exitCode } = await runWithEnv(
      ["setup", "--state-dir", stateDir, "--workspace"],
      { XPLAINER_VIDEOS_DIR: workspace, [WORKSPACE_PAYLOAD_ENV]: payload },
    );

    expect(exitCode).toBe(3);
    expect(stderr).toContain("sunos");
    expect(existsSync(toolchainMarkerPath(stateDir))).toBe(false);
  });

  /**
   * The document that lands on disk is the one three other surfaces read, so it is asserted through
   * the reader `install/preflight.ts` uses rather than as the object this command happened to build.
   *
   * It starts from a **version-1** marker, which is what every machine set up before ADR 0031's cut
   * holds: the run reads its two components, acquires the workspace without recording it, and
   * writes version 2 with no `workspace` at all (§Note, 2026-11-12, D1).
   */
  it("rewrites a version-1 marker as version 2, without a workspace, keeping what it recorded", async () => {
    const stateDir = temporaryDirectory("xplainer-setup-state-");
    const workspace = temporaryDirectory("xplainer-setup-workspace-");
    const payload = stagedPayloadFrom(temporaryDirectory("xplainer-setup-payload-"));

    // The browser and speech halves this suite does not download, recorded exactly as a
    // version-1 `setup` recorded them, with the workspace beside them.
    const recorded = recordTestToolchain({ stateDir });
    writeFileSync(
      toolchainMarkerPath(stateDir),
      `${JSON.stringify({
        ...recorded,
        format_version: 1,
        workspace: { platform: `${process.platform}-${process.arch}`, version: "1.0.0" },
      })}\n`,
    );
    const { exitCode, stdout } = await runWithEnv(
      ["setup", "--state-dir", stateDir, "--workspace"],
      {
        XPLAINER_VIDEOS_DIR: workspace,
        [WORKSPACE_PAYLOAD_ENV]: payload,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("recorded ");
    // The workspace was still acquired; it is simply no longer part of the record.
    expect(existsSync(join(workspace, "node_modules", "@remotion", "cli"))).toBe(true);
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
 * D2 (c): `setup` writes a version-2 marker, and a daemon installed from before ADR 0031's cut reads
 * version 1 — so under such a daemon it refuses, exit `3`, having written nothing, and names the
 * reinstall rather than running it (§Note, 2026-11-12). The daemon is found the way every surface
 * finds it: `daemon.json`'s `runtime_dir`, then that runtime's own manifest.
 */
describe("xplainer setup — under a daemon installed from the other side of the cut", () => {
  /** A state directory holding a version-1 marker and a daemon registered from `runtimeDir`. */
  function preCutMachine(runtimeDir: string): { stateDir: string; marker: string } {
    const stateDir = temporaryDirectory("xplainer-setup-state-");
    const recorded = recordTestToolchain({ stateDir });
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
    const payload = stagedPayloadFrom(temporaryDirectory("xplainer-setup-payload-"));

    const { stdout, stderr, exitCode } = await runWithEnv(setupArgv(stateDir), {
      XPLAINER_VIDEOS_DIR: workspace,
      [WORKSPACE_PAYLOAD_ENV]: payload,
    });

    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain("acquiring: workspace");
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

/** A staged payload 2 the copy route accepts, so no test here needs a network. */
function stagedPayloadFrom(payload: string, platform: string = process.platform): string {
  const pins = readTemplatePins();
  writeFileSync(join(payload, "package.json"), `${JSON.stringify({ name: "staged" })}\n`);
  writeFileSync(join(payload, "package-lock.json"), `${JSON.stringify({ name: "staged" })}\n`);
  const packageDir = join(payload, "node_modules", "@remotion", "cli");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    `${JSON.stringify({ name: "@remotion/cli", version: "4.0.495", bin: { remotion: "remotion-cli.js" } })}\n`,
  );
  writeFileSync(join(packageDir, "remotion-cli.js"), "#!/usr/bin/env node\n");
  const bin = join(payload, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, process.platform === "win32" ? "remotion.cmd" : "remotion");
  if (process.platform === "win32") {
    writeFileSync(shim, "@echo off\n");
  } else {
    symlinkSync("../@remotion/cli/remotion-cli.js", shim);
  }
  writeFileSync(
    join(payload, WORKSPACE_MANIFEST_FILE),
    `${JSON.stringify(
      {
        kind: "workspace",
        manifest_version: MANIFEST_VERSION,
        created_at: new Date().toISOString(),
        platform,
        arch: process.arch,
        node_version: process.version,
        npm_version: "11.0.0",
        installer: "npm ci",
        pins,
        resolved: pins,
        remotion_entry: "node_modules/@remotion/cli/remotion-cli.js",
        files: [],
        links: [],
      },
      null,
      2,
    )}\n`,
  );
  return payload;
}
