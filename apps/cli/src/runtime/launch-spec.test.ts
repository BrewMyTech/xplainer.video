/**
 * The launch contract, against real payload trees and against this checkout's own Remotion.
 *
 * Three properties are what these cases exist for, and each one is a defect some earlier shape of
 * this code had:
 *
 * 1. **Every setting survives, on every platform.** The argv is compared against a written-out
 *    golden rather than rebuilt by the test, so a builder that stopped emitting one of the four
 *    values fails here rather than at the moment an installed daemon comes up on the platform
 *    defaults with `daemon.json` recording something else.
 * 2. **The `.bin` shim is never the answer.** `node_modules/.bin/remotion` is a symlink to a file
 *    beginning `#!/usr/bin/env node`, and spawning it measured exit `127` under
 *    `PATH=/usr/bin:/bin`. The fixtures put the shim next to the package under both its POSIX and
 *    its Windows name, so "not the shim" is a statement about what was chosen and not about what
 *    happened to be missing. One case resolves the **real** `@remotion/cli` in this checkout and
 *    reads that shebang back, so the premise is asserted rather than quoted.
 * 3. **A missing setting is a refusal, not a default.** Each of the four is dropped in turn and the
 *    builder is required to name it.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildLaunchSpec,
  CLI_BIN_NAME,
  emitSettings,
  findInstalledPackage,
  LaunchContractError,
  type LaunchSettings,
  PORT_FLAG,
  resolveNodeEntry,
  SERVE_COMMAND,
  SETTING_FLAGS,
  SETTING_VARIABLES,
  type SupervisorPlatform,
} from "./launch-spec.js";

let root = "";

/** The three settings, with values a reader can tell apart at a glance. */
const SETTINGS: LaunchSettings = {
  stateDir: "/var/state/xplainer",
  tokenFile: "/var/state/xplainer/token",
  socket: "/run/user/501/xplainer/xplainer.sock",
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xplainer-launch-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a package with the `bin` field given, and every file that field names. */
function writePackage(directory: string, manifest: Record<string, unknown>): string {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  const bin = manifest.bin;
  const targets =
    typeof bin === "string"
      ? [bin]
      : typeof bin === "object" && bin !== null
        ? Object.values(bin as Record<string, string>)
        : [];
  for (const target of targets) {
    const file = resolve(directory, target);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "#!/usr/bin/env node\n");
  }
  return directory;
}

/**
 * `@remotion/cli` as npm installs it: the package with its own three-entry `bin` map, and the
 * `.bin` shims beside it under both platforms' names.
 */
function installedRemotion(workspace: string): { packageDir: string; entry: string; bin: string } {
  const packageDir = writePackage(join(workspace, "node_modules", "@remotion", "cli"), {
    name: "@remotion/cli",
    version: "4.0.495",
    bin: {
      remotion: "remotion-cli.js",
      remotionb: "remotionb-cli.js",
      remotiond: "remotiond-cli.js",
    },
  });
  const bin = join(workspace, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  for (const name of ["remotion", "remotion.cmd"]) {
    writeFileSync(join(bin, name), "#!/bin/sh\n");
  }
  return { packageDir, entry: join(packageDir, "remotion-cli.js"), bin };
}

/** A payload-1 directory: both interpreter names, and `@xplainer/cli` as its allowlist ships it. */
function payload(): { runtimeDir: string; entry: string } {
  const runtimeDir = join(root, "runtime");
  mkdirSync(join(runtimeDir, "bin"), { recursive: true });
  for (const name of ["node", "node.exe"]) {
    writeFileSync(join(runtimeDir, "bin", name), "");
  }
  const cli = writePackage(join(runtimeDir, "lib", "node_modules", "@xplainer", "cli"), {
    name: "@xplainer/cli",
    version: "0.0.0",
    bin: { xplainer: "./dist/bin.js" },
  });
  return { runtimeDir, entry: join(cli, "dist", "bin.js") };
}

describe("resolveNodeEntry", () => {
  it("answers the file the `bin` map names, run under this process's own interpreter", () => {
    const { packageDir, entry } = installedRemotion(root);

    expect(resolveNodeEntry(packageDir, "remotion")).toEqual({
      executable: process.execPath,
      argv: [entry],
    });
  });

  it("never answers the .bin shim, under either of its two names", () => {
    const { packageDir, entry, bin } = installedRemotion(root);

    const resolved = resolveNodeEntry(packageDir, "remotion", { args: ["versions"] });

    expect(resolved.argv).toEqual([entry, "versions"]);
    expect(existsSync(join(bin, "remotion"))).toBe(true);
    expect(existsSync(join(bin, "remotion.cmd"))).toBe(true);
    expect([resolved.executable, ...resolved.argv].some((path) => path.startsWith(bin))).toBe(
      false,
    );
  });

  /**
   * D1's Windows clause, as three cases rather than as an argument. Resolution goes through the
   * package's own `bin` field, so the file each platform's shim *would* have been — `remotion` on
   * linux and darwin, `remotion.cmd` on win32 — is named here and is not what comes back. There is
   * no branch in {@link resolveNodeEntry} for any of the three, and that is the claim: going
   * through `bin` means there is no shim to wrap on any platform.
   */
  it.each([
    ["linux", "remotion"],
    ["darwin", "remotion"],
    ["win32", "remotion.cmd"],
  ])("returns @remotion/cli's own entry on %s, never .bin/%s", (_platform, shim) => {
    const { packageDir, entry, bin } = installedRemotion(root);

    const resolved = resolveNodeEntry(packageDir, "remotion");

    expect(existsSync(join(bin, shim))).toBe(true);
    expect(resolved.argv[0]).toBe(entry);
    expect(resolved.argv[0]).not.toBe(join(bin, shim));
  });

  /**
   * The measurement D1 rests on, re-taken: this checkout's own `@remotion/cli` really does begin
   * `#!/usr/bin/env node`, which is why exec'ing the shim needs a `node` on the child's `PATH` and
   * why the entry file is what gets spawned instead.
   */
  it("resolves this checkout's real @remotion/cli to the file whose shebang is the problem", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const packageDir = findInstalledPackage(here, "@remotion/cli");
    expect(packageDir, "this repository has no Remotion install to resolve").not.toBeNull();

    const resolved = resolveNodeEntry(packageDir ?? "", "remotion");
    const entry = resolved.argv[0] ?? "";

    expect(entry).toBe(join(packageDir ?? "", "remotion-cli.js"));
    expect(readFileSync(entry, "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
    expect(entry.includes(join("node_modules", ".bin"))).toBe(false);
  });

  it("runs the entry under the interpreter it is given, with the arguments after it", () => {
    const { packageDir, entry } = installedRemotion(root);

    expect(
      resolveNodeEntry(packageDir, "remotion", {
        interpreter: "/opt/runtime/bin/node",
        args: ["render", "videos/demo/index.ts"],
      }),
    ).toEqual({
      executable: "/opt/runtime/bin/node",
      argv: [entry, "render", "videos/demo/index.ts"],
    });
  });

  it("accepts a string `bin` under the package's own unscoped name", () => {
    const packageDir = writePackage(join(root, "pkg"), {
      name: "@scope/tool",
      bin: "./cli.js",
    });

    expect(resolveNodeEntry(packageDir, "tool").argv).toEqual([join(packageDir, "cli.js")]);
  });

  it("refuses a string `bin` asked for under any other name", () => {
    const packageDir = writePackage(join(root, "pkg"), { name: "@scope/tool", bin: "./cli.js" });

    expect(() => resolveNodeEntry(packageDir, "other")).toThrow(LaunchContractError);
    expect(() => resolveNodeEntry(packageDir, "other")).toThrow(/installs under the package/);
  });

  it("names what a `bin` map does declare when the one asked for is absent", () => {
    const { packageDir } = installedRemotion(root);

    expect(() => resolveNodeEntry(packageDir, "remotionx")).toThrow(
      /declares no `bin.remotionx`; it declares \["remotion","remotionb","remotiond"\]/,
    );
  });

  it("refuses a package with no `bin` field rather than guessing an entry", () => {
    const packageDir = writePackage(join(root, "pkg"), { name: "plain" });

    expect(() => resolveNodeEntry(packageDir, "plain")).toThrow(/declares no `bin` field/);
  });

  it("refuses a `bin` whose file the package does not actually carry", () => {
    const packageDir = join(root, "pkg");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "tool", bin: { tool: "dist/cli.js" } }),
    );

    expect(() => resolveNodeEntry(packageDir, "tool")).toThrow(/does not exist/);
  });

  it("refuses a `bin` that points outside its own package", () => {
    const packageDir = writePackage(join(root, "pkg"), { name: "tool", bin: { tool: "./cli.js" } });
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "tool", bin: { tool: "../../etc/passwd" } }),
    );

    expect(() => resolveNodeEntry(packageDir, "tool")).toThrow(/lands outside the package/);
  });

  it("says which file it could not read when the package manifest is missing", () => {
    expect(() => resolveNodeEntry(join(root, "absent"), "tool")).toThrow(/cannot be read/);
  });
});

describe("findInstalledPackage", () => {
  it("finds a package installed at the root it is given", () => {
    const { packageDir } = installedRemotion(root);

    expect(findInstalledPackage(root, "@remotion/cli")).toBe(packageDir);
  });

  it("walks up, so a workspace nested inside an installed tree resolves", () => {
    const { packageDir } = installedRemotion(root);
    const nested = join(root, "videos", "demo");
    mkdirSync(nested, { recursive: true });

    expect(findInstalledPackage(nested, "@remotion/cli")).toBe(packageDir);
  });

  it("answers null rather than a guessed path when nothing is installed", () => {
    expect(findInstalledPackage(root, "@remotion/nothing-here")).toBeNull();
  });
});

describe("buildLaunchSpec", () => {
  /** The whole argv, written out. A builder that drops one flag fails this equality. */
  const goldenArgv = (entry: string): string[] => [
    entry,
    SERVE_COMMAND,
    PORT_FLAG,
    "8787",
    SETTING_FLAGS.stateDir,
    SETTINGS.stateDir,
    SETTING_FLAGS.tokenFile,
    SETTINGS.tokenFile,
    SETTING_FLAGS.socket,
    SETTINGS.socket,
  ];

  it("is <runtime>/bin/node and the CLI's own entry on linux", () => {
    const { runtimeDir, entry } = payload();

    const spec = buildLaunchSpec({ runtimeDir, port: 8787, settings: SETTINGS, platform: "linux" });

    expect(spec.executable).toBe(join(runtimeDir, "bin", "node"));
    expect(spec.argv).toEqual(goldenArgv(entry));
    expect(spec.settings).toEqual(SETTINGS);
    expect(spec.cwd).toBe(SETTINGS.stateDir);
  });

  it("is the same argv on darwin, because the contract does not vary by POSIX platform", () => {
    const { runtimeDir, entry } = payload();

    const spec = buildLaunchSpec({
      runtimeDir,
      port: 8787,
      settings: SETTINGS,
      platform: "darwin",
    });

    expect(spec.executable).toBe(join(runtimeDir, "bin", "node"));
    expect(spec.argv).toEqual(goldenArgv(entry));
  });

  it("is node.exe on win32, and keeps the script path before `serve`", () => {
    const { runtimeDir, entry } = payload();

    const spec = buildLaunchSpec({ runtimeDir, port: 8787, settings: SETTINGS, platform: "win32" });

    expect(spec.executable).toBe(join(runtimeDir, "bin", "node.exe"));
    expect(spec.argv).toEqual(goldenArgv(entry));
    expect(spec.argv[0]).toBe(entry);
    expect(spec.argv[1]).toBe(SERVE_COMMAND);
  });

  it("resolves the entry through `bin` rather than assuming dist/bin.js", () => {
    const { runtimeDir } = payload();
    const cli = join(runtimeDir, "lib", "node_modules", "@xplainer", "cli");
    writePackage(cli, { name: "@xplainer/cli", bin: { [CLI_BIN_NAME]: "./dist/entry.js" } });

    const spec = buildLaunchSpec({ runtimeDir, port: 0, settings: SETTINGS, platform: "linux" });

    expect(spec.argv[0]).toBe(join(cli, "dist", "entry.js"));
  });

  it("takes port 0, which is a request for an ephemeral port and not an omission", () => {
    const { runtimeDir } = payload();

    const spec = buildLaunchSpec({ runtimeDir, port: 0, settings: SETTINGS, platform: "linux" });

    expect(spec.argv).toContain("0");
  });

  it("uses the working directory it is given, over the state directory", () => {
    const { runtimeDir } = payload();

    const spec = buildLaunchSpec({
      runtimeDir,
      port: 8787,
      settings: SETTINGS,
      cwd: "/srv/xplainer",
      platform: "linux",
    });

    expect(spec.cwd).toBe("/srv/xplainer");
  });

  /**
   * The dropped-setting case, taken one field at a time. `""` is the shape a caller reaches this
   * way: a value that was read from somewhere and was not there.
   */
  it.each(["stateDir", "tokenFile", "socket"] as const)("refuses a missing %s by name", (field) => {
    const { runtimeDir } = payload();
    const settings: LaunchSettings = { ...SETTINGS };
    settings[field] = "";

    expect(() => buildLaunchSpec({ runtimeDir, port: 8787, settings, platform: "linux" })).toThrow(
      new RegExp(`needs settings\\.${field}`),
    );
  });

  it("refuses a port outside the range a socket can bind", () => {
    const { runtimeDir } = payload();

    expect(() =>
      buildLaunchSpec({ runtimeDir, port: 70000, settings: SETTINGS, platform: "linux" }),
    ).toThrow(/between 0 and 65535/);
  });

  it("refuses a runtime directory that carries no built CLI entry", () => {
    const runtimeDir = join(root, "empty");
    mkdirSync(runtimeDir, { recursive: true });

    expect(() =>
      buildLaunchSpec({ runtimeDir, port: 8787, settings: SETTINGS, platform: "linux" }),
    ).toThrow(LaunchContractError);
  });
});

describe("emitSettings", () => {
  const specFor = (platform: SupervisorPlatform) => {
    const { runtimeDir } = payload();
    return buildLaunchSpec({ runtimeDir, port: 8787, settings: SETTINGS, platform });
  };

  it("is systemd's Environment= lines on linux", () => {
    expect(emitSettings(specFor("linux"), "linux")).toEqual({
      form: "systemd",
      environment: [
        `${SETTING_VARIABLES.stateDir}=${SETTINGS.stateDir}`,
        `${SETTING_VARIABLES.tokenFile}=${SETTINGS.tokenFile}`,
      ],
    });
  });

  it("is launchd's EnvironmentVariables dictionary on darwin", () => {
    expect(emitSettings(specFor("darwin"), "darwin")).toEqual({
      form: "launchd",
      environment: {
        [SETTING_VARIABLES.stateDir]: SETTINGS.stateDir,
        [SETTING_VARIABLES.tokenFile]: SETTINGS.tokenFile,
      },
    });
  });

  it("is <Arguments> entries on win32, where <Exec> has no environment map", () => {
    expect(emitSettings(specFor("win32"), "win32")).toEqual({
      form: "task-scheduler",
      argv: [
        SETTING_FLAGS.stateDir,
        SETTINGS.stateDir,
        SETTING_FLAGS.tokenFile,
        SETTINGS.tokenFile,
        SETTING_FLAGS.socket,
        SETTINGS.socket,
      ],
    });
  });

  /**
   * The rule the three forms sit on top of: whatever a platform can express as an environment, the
   * argv carries all four values on every platform. There is no `XPLAINER_SOCKET`, so an
   * environment-only emission would leave the socket set by nobody.
   */
  it.each(["linux", "darwin", "win32"] as const)(
    "leaves every setting in the argv on %s, environment or no environment",
    (platform) => {
      const spec = specFor(platform);

      for (const [field, flag] of Object.entries(SETTING_FLAGS)) {
        const at = spec.argv.indexOf(flag);
        expect(at, `${flag} is missing from the ${platform} argv`).toBeGreaterThan(0);
        expect(spec.argv[at + 1]).toBe(SETTINGS[field as keyof LaunchSettings]);
      }
      expect(spec.argv[spec.argv.indexOf(PORT_FLAG) + 1]).toBe("8787");
    },
  );

  it("has no XPLAINER_SOCKET to emit, which is why the argv carries it", () => {
    expect(Object.keys(SETTING_VARIABLES)).toEqual(["stateDir", "tokenFile"]);
  });
});
