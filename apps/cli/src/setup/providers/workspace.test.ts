/**
 * The workspace provider's two routes, and decision D8's exact invocation.
 *
 * **What is asserted here and what is asserted elsewhere.** The `resolve` route ends in a real
 * `npm ci` of 268 packages over a network, which is `scripts/e2e/toolchain.mjs`'s subject and not a
 * unit test's: what this file asserts about it is the part that is a *decision* — the interpreter,
 * the argv, the working directory and the `PATH` prepend, composed with `path.delimiter` — because
 * every one of those was measured into existence and a change to any of them is a change to D1 or
 * D8. The `copy` route is asserted end to end, with a real staged payload on disk, because it moves
 * bytes and symlinks and nothing about it needs a network.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import { WORKSPACE_FILES } from "@xplainer/render-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  MANIFEST_VERSION,
  PAYLOAD_BIN_DIR,
  PAYLOAD_NPM_CLI,
  RUNTIME_MANIFEST_FILE,
  WORKSPACE_MANIFEST_FILE,
} from "../../runtime/manifest.js";
import { readTemplatePins } from "../../runtime/verify.js";
import {
  hostRuntimeDir,
  INSTALL_INPUTS,
  INSTALL_SUBCOMMAND,
  installCommand,
  installEnvironment,
  materialiseRenderWorkspace,
  readWorkspaceResolution,
  remotionShimPath,
  templateVersion,
  WORKSPACE_PAYLOAD_ENV,
  WorkspaceRefusal,
} from "./workspace.js";

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

/** A payload-1 directory with the three files a payload is defined by, and nothing else. */
function fakeRuntime(): string {
  const runtime = temporaryDirectory("xplainer-runtime-");
  writeFileSync(join(runtime, RUNTIME_MANIFEST_FILE), "{}\n");
  mkdirSync(join(runtime, PAYLOAD_BIN_DIR), { recursive: true });
  writeFileSync(join(runtime, PAYLOAD_BIN_DIR, interpreterName()), "");
  mkdirSync(join(runtime, ...PAYLOAD_NPM_CLI.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(join(runtime, ...PAYLOAD_NPM_CLI.split("/")), "");
  return runtime;
}

function interpreterName(): string {
  return process.platform === "win32" ? "node.exe" : "node";
}

/**
 * A staged payload 2: the two install inputs, a `node_modules` with the CLI and its `.bin` link,
 * and the manifest that describes what it resolved.
 */
function stagedPayload(options: { platform?: string; pins?: Record<string, string> } = {}): string {
  const payload = temporaryDirectory("xplainer-payload2-");
  const pins = options.pins ?? readTemplatePins();
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
        platform: options.platform ?? process.platform,
        arch: process.arch,
        node_version: process.version,
        npm_version: "11.0.0",
        installer: `npm ${INSTALL_SUBCOMMAND}`,
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

describe("the install invocation (D8)", () => {
  /**
   * The exact command the plan writes out. Every part of it is a decision: the interpreter is the
   * payload's own because the machine is not assumed to have one (D1/D3), the entry is npm's
   * `npm-cli.js` because a `bin` shim would need `node` on `PATH` to start, and the subcommand is
   * `ci` and never `install` because `ci` requires the lockfile to be in sync and removes
   * `node_modules` first (D11).
   */
  it("is <runtime>/bin/node <runtime>/lib/node_modules/npm/bin/npm-cli.js ci", () => {
    const runtime = fakeRuntime();

    const install = installCommand(runtime);

    expect(install.command).toBe(join(runtime, PAYLOAD_BIN_DIR, interpreterName()));
    expect(install.args[0]).toBe(join(runtime, ...PAYLOAD_NPM_CLI.split("/")));
    expect(install.args[1]).toBe("ci");
    expect(install.args).not.toContain("install");
    expect(install.args).not.toContain("--ignore-scripts");
  });

  it("falls back to whatever npm is on PATH when there is no payload to run from", () => {
    const install = installCommand(null);

    expect(install.command).toBe(process.platform === "win32" ? "npm.cmd" : "npm");
    expect(install.args[0]).toBe("ci");
  });

  it("refuses a directory that is not a payload, naming the file that is missing", () => {
    const notAPayload = temporaryDirectory("xplainer-not-a-payload-");

    expect(() => installCommand(notAPayload)).toThrow(WorkspaceRefusal);
    expect(() => installCommand(notAPayload)).toThrow(/does not exist/);
  });

  /**
   * The prepend is `path.delimiter` and never a literal `:`, because Windows separates with `;` —
   * a literal there produces one unusable entry where two usable ones were meant.
   */
  it("prepends <runtime>/bin with path.delimiter and changes nothing else", () => {
    const runtime = fakeRuntime();
    const inherited = { PATH: "/usr/bin:/bin", HOME: "/home/someone" };

    const env = installEnvironment(inherited, runtime);

    expect(env.PATH).toBe(`${join(runtime, PAYLOAD_BIN_DIR)}${delimiter}/usr/bin:/bin`);
    expect(env.PATH?.includes(delimiter)).toBe(true);
    expect(env.HOME).toBe("/home/someone");
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH"]);
  });

  it("leaves the environment exactly as it was when there is no payload", () => {
    const inherited = { PATH: "/usr/bin:/bin" };

    expect(installEnvironment(inherited, null)).toBe(inherited);
  });

  it("gives the prepend an empty PATH's worth of room rather than a leading delimiter", () => {
    const runtime = fakeRuntime();

    expect(installEnvironment({}, runtime).PATH).toBe(join(runtime, PAYLOAD_BIN_DIR));
  });
});

describe("the copy route", () => {
  it("materialises the template, copies the payload, and reports the route", () => {
    const root = temporaryDirectory("xplainer-workspace-");
    const payload = stagedPayload();

    const result = materialiseRenderWorkspace({ workspaceRoot: root, payloadDir: payload });

    expect(result.route).toBe("copy");
    for (const name of WORKSPACE_FILES) {
      expect(existsSync(join(root, name)), name).toBe(true);
    }
    expect(result.remotionShim).toBe(remotionShimPath(root));
    expect(result.resolution.platform).toBe(`${process.platform}-${process.arch}`);
    expect(result.resolution.templateVersion).toBe(templateVersion());
  });

  /**
   * npm materialises `.bin/remotion` as a **relative symlink**, and a copy that dereferenced it
   * would leave a file whose `#!/usr/bin/env node` line then resolves against nothing.
   */
  it.skipIf(process.platform === "win32")(
    "keeps the .bin shim a symlink rather than a copy",
    () => {
      const root = temporaryDirectory("xplainer-workspace-");

      materialiseRenderWorkspace({ workspaceRoot: root, payloadDir: stagedPayload() });

      const shim = join(root, "node_modules", ".bin", "remotion");
      expect(lstatSync(shim).isSymbolicLink()).toBe(true);
    },
  );

  it("refuses a payload resolved on another platform, before anything is copied", () => {
    const root = temporaryDirectory("xplainer-workspace-");
    const payload = stagedPayload({ platform: "sunos" });

    expect(() => materialiseRenderWorkspace({ workspaceRoot: root, payloadDir: payload })).toThrow(
      /compositor/,
    );
    expect(existsSync(join(root, "node_modules"))).toBe(false);
  });

  it("refuses a directory with no workspace manifest, naming the command that builds one", () => {
    const root = temporaryDirectory("xplainer-workspace-");
    const empty = temporaryDirectory("xplainer-empty-payload-");

    expect(() => materialiseRenderWorkspace({ workspaceRoot: root, payloadDir: empty })).toThrow(
      /runtime build --workspace/,
    );
  });

  /**
   * The pin check that runs before anything is recorded — decision D2's other half. A payload whose
   * tree disagrees with the template is one Remotion's own `remotion versions` exits 1 on, and it is
   * refused here rather than three minutes into a render.
   */
  it("refuses a payload whose resolved tree disagrees with the template's pins", () => {
    const root = temporaryDirectory("xplainer-workspace-");
    const payload = stagedPayload({ pins: { ...readTemplatePins(), zod: "4.5.4" } });

    expect(() => materialiseRenderWorkspace({ workspaceRoot: root, payloadDir: payload })).toThrow(
      /zod/,
    );
  });

  /**
   * `setup` is the command a user runs again after an interrupted first attempt, and `npm ci`'s own
   * rule is the one applied here: the tree is removed before the new one lands, so a second run
   * cannot leave a workspace that is neither payload.
   */
  it("is re-runnable, replacing the tree rather than copying over it", () => {
    const root = temporaryDirectory("xplainer-workspace-");
    const payload = stagedPayload();
    materialiseRenderWorkspace({ workspaceRoot: root, payloadDir: payload });
    writeFileSync(join(root, "node_modules", "left-over.txt"), "from the first run\n");

    const second = materialiseRenderWorkspace({ workspaceRoot: root, payloadDir: payload });

    expect(second.route).toBe("copy");
    expect(existsSync(join(root, "node_modules", "left-over.txt"))).toBe(false);
    expect(remotionShimPath(root)).not.toBeNull();
  });

  it("takes the staged payload from the environment when no caller named one", () => {
    const root = temporaryDirectory("xplainer-workspace-");
    const payload = stagedPayload();

    const result = materialiseRenderWorkspace({
      workspaceRoot: root,
      env: { ...process.env, [WORKSPACE_PAYLOAD_ENV]: payload },
    });

    expect(result.route).toBe("copy");
  });
});

describe("readWorkspaceResolution", () => {
  it("reads a payload's own manifest, keeping the pins apart from what was resolved", () => {
    const payload = stagedPayload();

    const resolution = readWorkspaceResolution(payload);

    expect(resolution?.pins).toEqual(readTemplatePins());
    expect(resolution?.remotionEntry).toBe("node_modules/@remotion/cli/remotion-cli.js");
  });

  it("answers null for every shape of 'there is no workspace here'", () => {
    const empty = temporaryDirectory("xplainer-empty-");
    writeFileSync(join(empty, WORKSPACE_MANIFEST_FILE), "not json");

    expect(readWorkspaceResolution(temporaryDirectory("xplainer-none-"))).toBeNull();
    expect(readWorkspaceResolution(empty)).toBeNull();
  });

  it("answers null for a runtime manifest handed to it, which is a different document", () => {
    const payload = temporaryDirectory("xplainer-runtime-manifest-");
    writeFileSync(
      join(payload, WORKSPACE_MANIFEST_FILE),
      `${JSON.stringify({ kind: "runtime" })}\n`,
    );

    expect(readWorkspaceResolution(payload)).toBeNull();
  });
});

describe("hostRuntimeDir", () => {
  it("answers null in a checkout, where there is no payload above these sources", () => {
    expect(hostRuntimeDir()).toBeNull();
  });

  it("answers the directory that has all three of the files a payload is defined by", () => {
    const runtime = fakeRuntime();
    const deep = join(runtime, "lib", "node_modules", "@xplainer", "cli", "dist");
    mkdirSync(deep, { recursive: true });

    expect(hostRuntimeDir(deep)).toBe(runtime);
  });
});

describe("the install inputs", () => {
  /**
   * `npm ci` with no lockfile exits `EUSAGE`, so both files have to be in the workspace before npm
   * is invoked — which is why `package-lock.json` is a member of `WORKSPACE_FILES` rather than
   * something the installer places.
   */
  it("are both members of the template render-core materialises", () => {
    for (const name of INSTALL_INPUTS) {
      expect(WORKSPACE_FILES).toContain(name);
    }
  });
});
