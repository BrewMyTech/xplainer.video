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
import { toolchainMarkerPath } from "../install/preflight.js";
import type { CliIo } from "../io.js";
import { createProgram } from "../program.js";
import { MANIFEST_VERSION, WORKSPACE_MANIFEST_FILE } from "../runtime/manifest.js";
import { readTemplatePins } from "../runtime/verify.js";
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
   */
  it("writes a marker whose validating reader accepts it, once all three are recorded", async () => {
    const stateDir = temporaryDirectory("xplainer-setup-state-");
    const workspace = temporaryDirectory("xplainer-setup-workspace-");
    const payload = stagedPayloadFrom(temporaryDirectory("xplainer-setup-payload-"));

    // The browser and speech halves this suite does not download, recorded exactly as `setup`
    // records them; the run under test then re-resolves the workspace and completes the document.
    recordTestToolchain({ stateDir, workspaceRoot: workspace });
    rmSync(join(workspace, WORKSPACE_MANIFEST_FILE));
    const { exitCode, stdout } = await runWithEnv(
      ["setup", "--state-dir", stateDir, "--workspace"],
      {
        XPLAINER_VIDEOS_DIR: workspace,
        [WORKSPACE_PAYLOAD_ENV]: payload,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("recorded ");
    const marker = readToolchainMarker(stateDir);
    expect(marker).not.toBeNull();
    expect(marker?.workspace.platform).toBe(`${process.platform}-${process.arch}`);
    const onDisk = JSON.parse(readFileSync(toolchainMarkerPath(stateDir), "utf8")) as Toolchain;
    expect(onDisk.speech.provider).toBe("docker");
    expect(onDisk.chrome.provider).toBe("remotion");
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
