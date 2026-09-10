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
 *
 * **The `win32` spellings are asserted here on every platform, and that is deliberate.** The
 * launcher `installCommand(null)` used to return was `npm.cmd` on Windows and nothing else, and
 * libuv refuses to spawn a `.cmd` at all — so the defect existed only on the one platform a
 * developer's suite never runs on, and this package mocks nothing (there is no `vi.mock` anywhere
 * in it). `InstallHost` is the seam that closes that gap: the platform, the interpreter and the
 * `PATH` all arrive as arguments over directories a test lays out, so what Windows would be handed
 * is a value this suite can read on darwin. The real thing is `pnpm e2e:speech` on a Windows runner.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";
import { WORKSPACE_FILES } from "@xplainer/render-core";
import { afterEach, describe, expect, it } from "vitest";
import { PRECONDITION_UNMET_EXIT_CODE } from "../../daemon/exit-codes.js";
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
  locateNpmCli,
  materialiseRenderWorkspace,
  NPM_CLI_FILE,
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

/**
 * A payload-1 directory with the three files a payload is defined by, and nothing else.
 *
 * Both spellings of the interpreter are written, so the `win32` branch of the payload route is
 * assertable from a suite running anywhere. A payload built for one platform carries one of them;
 * this is a fixture, and what it is a fixture *for* is the spelling, not the count.
 */
function fakeRuntime(): string {
  const runtime = temporaryDirectory("xplainer-runtime-");
  writeFileSync(join(runtime, RUNTIME_MANIFEST_FILE), "{}\n");
  mkdirSync(join(runtime, PAYLOAD_BIN_DIR), { recursive: true });
  for (const name of ["node", "node.exe"]) {
    writeFileSync(join(runtime, PAYLOAD_BIN_DIR, name), "");
  }
  mkdirSync(join(runtime, ...PAYLOAD_NPM_CLI.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(join(runtime, ...PAYLOAD_NPM_CLI.split("/")), "");
  return runtime;
}

function interpreterName(): string {
  return process.platform === "win32" ? "node.exe" : "node";
}

/**
 * A directory laid out the way a Windows Node installation is: the launchers, and npm beside them.
 *
 * `node.exe`, `npm.cmd` and `node_modules\npm\bin\npm-cli.js` in one directory is what the MSI and
 * every `hostedtoolcache` copy produce, and it is the layout the resolve route's Windows answer
 * comes out of.
 */
function windowsNodeInstall(): { directory: string; execPath: string; npmCli: string } {
  const directory = temporaryDirectory("xplainer-node-win-");
  const execPath = join(directory, "node.exe");
  writeFileSync(execPath, "");
  writeFileSync(join(directory, "npm.cmd"), "@echo off\r\n");
  const npmCli = join(directory, "node_modules", "npm", "bin", NPM_CLI_FILE);
  mkdirSync(dirname(npmCli), { recursive: true });
  writeFileSync(npmCli, "");
  return { directory, execPath, npmCli };
}

/** A POSIX prefix: `<prefix>/bin/node` and `<prefix>/lib/node_modules/npm/bin/npm-cli.js`. */
function posixNodePrefix(): { binDir: string; execPath: string; npmCli: string } {
  const prefix = temporaryDirectory("xplainer-node-posix-");
  const binDir = join(prefix, "bin");
  mkdirSync(binDir, { recursive: true });
  const execPath = join(binDir, "node");
  writeFileSync(execPath, "");
  const npmCli = join(prefix, "lib", "node_modules", "npm", "bin", NPM_CLI_FILE);
  mkdirSync(dirname(npmCli), { recursive: true });
  writeFileSync(npmCli, "");
  return { binDir, execPath, npmCli };
}

/**
 * A `bin` directory with both spellings of the interpreter in it and no npm anywhere near it.
 *
 * Nested one level inside a directory this suite owns, deliberately: the POSIX candidate is
 * `<bin>/../lib/node_modules/npm/…`, so a `bin` placed directly in `tmpdir()` would be asking
 * whether the machine happens to have `/tmp/lib/node_modules/npm` — and a "no npm here" fixture
 * must not depend on that.
 */
function nodeWithNoNpm(name: string): string {
  const binDir = join(temporaryDirectory(name), "bin");
  mkdirSync(binDir, { recursive: true });
  for (const spelling of ["node", "node.exe"]) {
    writeFileSync(join(binDir, spelling), "");
  }
  return binDir;
}

/** A `bin` directory holding launchers that are not npm's script, for the same reason. */
function npmShimsWithNoScript(): string {
  const binDir = join(temporaryDirectory("xplainer-npm-shim-"), "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "npm"), '#!/bin/sh\nexec volta-shim npm "$@"\n');
  writeFileSync(join(binDir, "npm.cmd"), "@echo off\r\n");
  return binDir;
}

/** The refusal a call threw, so its reason and its exit code can be read rather than matched. */
function refusalFrom(call: () => unknown): WorkspaceRefusal {
  try {
    call();
  } catch (error) {
    if (error instanceof WorkspaceRefusal) {
      return error;
    }
    throw error;
  }
  throw new Error("the call was expected to refuse and did not");
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

  /** The payload's interpreter is spelled by the platform the payload is for, not by this one. */
  it("spells the payload's interpreter node.exe for win32 and node for everything else", () => {
    const runtime = fakeRuntime();

    expect(installCommand(runtime, { platform: "win32" }).command).toBe(
      join(runtime, PAYLOAD_BIN_DIR, "node.exe"),
    );
    expect(installCommand(runtime, { platform: "linux" }).command).toBe(
      join(runtime, PAYLOAD_BIN_DIR, "node"),
    );
    expect(installCommand(runtime, { platform: "darwin" }).command).toBe(
      join(runtime, PAYLOAD_BIN_DIR, "node"),
    );
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

/**
 * The resolve route with no payload — the branch that returned `npm.cmd` on Windows and so had
 * never once run there.
 *
 * The property every case below is a form of: **the command is an interpreter and the first
 * argument is a script**, on every platform, because libuv will not spawn a launcher on one of the
 * three and `shell: true` is not an option (it re-parses the argv in `cmd.exe`, which a workspace
 * path with a space in it does not survive). Nothing here spawns anything: the assertion is the
 * argv, and a `.cmd` in it is the defect.
 */
describe("the install invocation with no payload", () => {
  it("spawns this process's own interpreter over a real npm-cli.js on this machine", () => {
    const install = installCommand(null);

    expect(install.command).toBe(process.execPath);
    expect(install.args[0]).toMatch(/npm-cli\.js$/);
    expect(existsSync(install.args[0] ?? "")).toBe(true);
    expect(install.args[1]).toBe(INSTALL_SUBCOMMAND);
    expect(install.args).not.toContain("install");
    expect(install.args).not.toContain("--ignore-scripts");
  });

  /**
   * The regression itself, asserted from any platform. `npm.cmd` is sitting in this fixture's
   * directory, so a route that reached for a launcher would find one — and the argv must still name
   * the script beside it, because `spawnSync("npm.cmd", …)` answers `EINVAL` with no `status` and
   * no `signal` on every Node this build supports and `setup` then exits 70.
   */
  it("names npm's script and never the .cmd beside it, on win32", () => {
    const { execPath, npmCli, directory } = windowsNodeInstall();

    const install = installCommand(null, { platform: "win32", execPath, path: directory });

    expect(install.command).toBe(execPath);
    expect(install.args[0]).toBe(npmCli);
    for (const word of [install.command, ...install.args]) {
      expect(word.toLowerCase().endsWith(".cmd"), word).toBe(false);
      expect(word.toLowerCase().endsWith(".bat"), word).toBe(false);
    }
  });

  it("finds the npm beside an npm.cmd that is on PATH but not beside the interpreter", () => {
    const { npmCli, directory } = windowsNodeInstall();
    const bare = nodeWithNoNpm("xplainer-node-bare-");

    const install = installCommand(null, {
      platform: "win32",
      execPath: join(bare, "node.exe"),
      path: `${bare}${delimiter}${directory}`,
    });

    expect(install.command).toBe(join(bare, "node.exe"));
    expect(install.args[0]).toBe(npmCli);
  });

  it("finds the POSIX prefix layout, one directory up and across into lib", () => {
    const { execPath, npmCli } = posixNodePrefix();

    expect(locateNpmCli({ platform: "linux", execPath, path: "" })).toBe(npmCli);
  });

  /**
   * On POSIX the `npm` on `PATH` is a symlink onto `npm-cli.js` itself, so following it is the
   * shortest true answer — and the only one for a `bin` directory that is not beside a prefix.
   */
  it.skipIf(process.platform === "win32")(
    "follows an npm symlink on PATH to the script it points at",
    () => {
      const { npmCli } = posixNodePrefix();
      const elsewhere = temporaryDirectory("xplainer-npm-link-");
      symlinkSync(npmCli, join(elsewhere, "npm"));
      const bare = nodeWithNoNpm("xplainer-node-bare-");

      const located = locateNpmCli({
        platform: "linux",
        execPath: join(bare, "node"),
        path: elsewhere,
      });

      expect(located).toBe(realpathSync(npmCli));
    },
  );

  /**
   * A launcher whose real path is not the script — a `.cmd`, a Volta or Corepack shim — is not an
   * `npm-cli.js` and is rejected rather than spawned as one. The directory is still searched for
   * the two layouts, and here it carries neither, so the answer is `null` and not the shim.
   */
  it("rejects a launcher that is not the script, rather than answering with it", () => {
    const shims = npmShimsWithNoScript();
    const bare = nodeWithNoNpm("xplainer-node-bare-");

    for (const platform of ["linux", "win32"] as const) {
      expect(
        locateNpmCli({ platform, execPath: join(bare, interpreterName()), path: shims }),
        platform,
      ).toBeNull();
    }
  });

  /**
   * A refusal by name, and at exit code `3` rather than `70`: a machine with no npm to be found is
   * a precondition this command cannot meet, not an internal error. The `npm.cmd` that used to be
   * returned here made it the second — `WorkspaceRefusal("install-failed")`, which is
   * `DAEMON_INTERNAL_EXIT_CODE`, which is the bucket for a throw nobody expected.
   */
  it("refuses by name when no npm-cli.js exists, rather than falling back to a launcher", () => {
    const bare = nodeWithNoNpm("xplainer-node-bare-");
    const host = { platform: "win32" as const, execPath: join(bare, "node.exe"), path: bare };

    const refusal = refusalFrom(() => installCommand(null, host));

    expect(refusal.reason).toBe("no-package-manager");
    expect(refusal.exitCode).toBe(PRECONDITION_UNMET_EXIT_CODE);
    expect(refusal.message).toContain(NPM_CLI_FILE);
    expect(refusal.message).toContain(join(bare, "node.exe"));
  });

  it("prefers the interpreter's own npm to one on PATH, since it supplies the interpreter", () => {
    const beside = windowsNodeInstall();
    const onPath = windowsNodeInstall();

    const install = installCommand(null, {
      platform: "win32",
      execPath: beside.execPath,
      path: onPath.directory,
    });

    expect(install.args[0]).toBe(beside.npmCli);
  });

  it("searches an empty PATH without producing a candidate out of the empty entry", () => {
    const bare = nodeWithNoNpm("xplainer-node-bare-");

    expect(
      locateNpmCli({ platform: "linux", execPath: join(bare, "node"), path: `${delimiter}  ` }),
    ).toBeNull();
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
