/**
 * The assembler, against real payloads built out of a real fixture checkout.
 *
 * Nothing here is substituted. The checkout is a directory tree with `package.json` files and a
 * `node_modules` npm itself would recognise; the payload is assembled by the shipped code; the
 * interpreter inside it is a copy of this process's own; and the three things the payload has to be
 * able to do — run its entry, resolve its data files, run its npm — are asserted by **spawning
 * them**, under a `PATH` on which `node` does not resolve. That last part is the whole point: every
 * defect this story exists to remove looked fine from inside the Vitest worker and failed in a
 * child process with no interpreter on its `PATH`.
 *
 * **Why a fixture checkout rather than this repository.** The properties under test are the
 * assembler's rules — an allowlist is honoured, a data file outside `dist/` still travels, a
 * package with no allowlist is refused, a nested version is nested rather than flattened — and each
 * one needs a tree shaped to provoke it. Running against this repository would assert them only
 * where today's dependency graph happens to exercise them, and would make the suite depend on
 * `apps/cli/dist/` existing, which `turbo.json` does not guarantee when `test` runs. The real
 * repository payload is built and verified by `scripts/e2e/runtime.mjs` and on all three runners.
 *
 * **Why a fixture template rather than Remotion.** `assembleWorkspace()` runs a real `npm ci`. The
 * behaviour being asserted is that it is a real install, that the manifest records what actually
 * arrived, and that a lifecycle script calling bare `node` succeeds because `<runtime>/bin` reached
 * the child's `PATH` and nothing else did. A local tarball dependency exercises every one of those
 * with npm doing all of its own work, and it does it without a network — which a unit test must not
 * need. Installing the actual 247-package Remotion tree is the e2e's job.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AssembledRuntime,
  type AssembledWorkspace,
  AssemblyRefusal,
  allowlistMatcher,
  assembleRuntime,
  assembleWorkspace,
  findCheckout,
  npmInstallation,
  remotionEntryPath,
} from "./assemble.js";
import { isPayloadPath, RUNTIME_MANIFEST_FILE, WORKSPACE_MANIFEST_FILE } from "./manifest.js";
import { verifyRuntimePayload } from "./verify.js";

/** The fixture's root package — the one whose closure a payload is. */
const ROOT = "@fixture/root";

/** A scratch root every test in this file works under, removed at the end. */
let scratch = "";
/** The fixture checkout, built once. */
let checkout = "";
/** One assembled payload, built once: it is 130 MB of copying and every read-only test shares it. */
let payload: AssembledRuntime;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "xplainer-assemble-"));
  checkout = buildCheckout(join(scratch, "checkout"));
  payload = assembleRuntime({
    outDir: join(scratch, "payload"),
    repoRoot: checkout,
    rootPackage: ROOT,
  });
}, 120_000);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("assembleRuntime — what travels", () => {
  it("copies exactly the root package's `files` allowlist, and nothing beside it", () => {
    const root = join(payload.outDir, "lib", "node_modules", ROOT);

    expect(existsSync(join(root, "dist", "bin.js"))).toBe(true);
    expect(existsSync(join(root, "LICENSE"))).toBe(true);
    expect(existsSync(join(root, "package.json"))).toBe(true);
    expect(existsSync(join(root, "src", "secret.ts"))).toBe(false);
    expect(existsSync(join(root, "NOTES.md"))).toBe(false);
  });

  it("ships a bare directory pattern whole, which is how `schemas` reaches the payload", () => {
    const schema = join(payload.outDir, "lib", "node_modules", ROOT, "schemas", "manifest.json");

    expect(existsSync(schema)).toBe(true);
    expect(JSON.parse(readFileSync(schema, "utf8"))).toEqual({ name: "fixture" });
  });

  it("walks the transitive closure of the external dependencies", () => {
    const names = payload.manifest.packages.map((entry) => entry.name);

    expect(names).toContain("external-a");
    expect(names).toContain("external-b");
    expect(names).toContain("@fixture/lib");
    expect(names).toContain("npm");
  });

  it("nests a second version of a package under the one that asked for it", () => {
    // `external-b` is a direct dependency of the root package at 1.0.0 and of `external-a` at
    // 2.0.0. One of them wins the hoisted slot and the other must be nested under its dependent,
    // which is npm's own layout; flattening would silently give one of the two the wrong major.
    const copies = payload.manifest.packages.filter((entry) => entry.name === "external-b");
    const hoisted = copies.filter((entry) => entry.path === "lib/node_modules/external-b");

    expect(copies.map((entry) => entry.version).sort()).toEqual(["1.0.0", "2.0.0"]);
    expect(hoisted).toHaveLength(1);
    expect(copies.filter((entry) => entry.path.endsWith("/node_modules/external-b"))).toHaveLength(
      2,
    );
    for (const copy of copies) {
      expect(
        JSON.parse(
          readFileSync(join(payload.outDir, ...copy.path.split("/"), "package.json"), "utf8"),
        ),
      ).toMatchObject({ version: copy.version });
    }
  });

  it("carries npm with its own vendored node_modules, which is what makes it runnable", () => {
    const npm = join(payload.outDir, "lib", "node_modules", "npm");
    const vendored = join(npm, "node_modules");

    expect(existsSync(join(npm, "bin", "npm-cli.js"))).toBe(true);
    expect(existsSync(vendored)).toBe(true);
    expect(
      payload.manifest.files.some((file) =>
        file.path.startsWith("lib/node_modules/npm/node_modules/"),
      ),
    ).toBe(true);
  });

  it("records npm's version, the platform and the interpreter's architecture", () => {
    expect(payload.manifest.npm_version).toBe(npmInstallation(process.execPath).version);
    expect(payload.manifest.platform).toBe(process.platform);
    expect(payload.manifest.arch).toBe(process.arch);
    expect(payload.manifest.node_version).toBe(process.version);
    expect(payload.manifest.host).toBe("node");
  });
});

describe("assembleRuntime — the manifest", () => {
  it("records only payload-relative paths, in the files, links, packages and launch contract", () => {
    const paths = [
      ...payload.manifest.files.map((file) => file.path),
      ...payload.manifest.links.map((link) => link.path),
      ...payload.manifest.packages.map((entry) => entry.path),
      payload.manifest.launch.interpreter,
      payload.manifest.launch.entry,
      payload.manifest.launch.npm_cli,
      ...payload.manifest.launch.argv,
    ];

    expect(paths.filter((path) => !isPayloadPath(path))).toEqual([]);
  });

  it("reads the launch entry off the root package's own `bin` field", () => {
    expect(payload.manifest.launch.entry).toBe(`lib/node_modules/${ROOT}/dist/bin.js`);
    expect(payload.manifest.launch.argv).toEqual([
      payload.manifest.launch.interpreter,
      payload.manifest.launch.entry,
    ]);
  });

  it("produces a payload that verifies against the manifest it just wrote", () => {
    const report = verifyRuntimePayload(payload.outDir);

    expect(report.failure).toBeNull();
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(payload.manifest.files.length + payload.manifest.links.length);
  });

  it("hashes every file in the payload except its own manifest", () => {
    expect(payload.manifest.files.some((file) => file.path === RUNTIME_MANIFEST_FILE)).toBe(false);
    expect(payload.manifest.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true);
    expect(existsSync(payload.manifestPath)).toBe(true);
  });
});

describe("allowlistMatcher", () => {
  it("ships a bare pattern's whole directory, which is npm's own rule", () => {
    const shipped = allowlistMatcher(["schemas"]);

    expect(shipped("schemas")).toBe(true);
    expect(shipped("schemas/manifest.json")).toBe(true);
    expect(shipped("schemas-of-mine/manifest.json")).toBe(false);
    expect(shipped("src/schemas/manifest.json")).toBe(false);
  });

  it("expands `**/` across directories and `*` within one", () => {
    const shipped = allowlistMatcher(["dist/**/*.js"]);

    expect(shipped("dist/index.js")).toBe(true);
    expect(shipped("dist/scaffold/templates/index.js")).toBe(true);
    expect(shipped("dist/index.ts")).toBe(false);
    expect(shipped("src/index.js")).toBe(false);
  });

  it("ships package.json whatever the allowlist says, because npm does", () => {
    expect(allowlistMatcher(["dist"])("package.json")).toBe(true);
  });

  it("treats a trailing slash as the same directory", () => {
    expect(allowlistMatcher(["template/"])("template/package-lock.json")).toBe(true);
  });
});

describe("assembleRuntime — the payload runs with no node on PATH", () => {
  it("runs its own entry, resolving a sibling package and a data file outside `dist/`", () => {
    const result = spawnSync(
      join(payload.outDir, ...payload.manifest.launch.interpreter.split("/")),
      [join(payload.outDir, ...payload.manifest.launch.entry.split("/"))],
      { encoding: "utf8", env: scrubbedEnvironment(), cwd: scratch },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("fixture lib-1.0.0 a-1.0.0");
    // Both this case and the `files`-allowlist refusal below assemble a real payload and spawn a
    // real interpreter out of it, and vitest's default per-case budget is 5 s. Measured on this
    // machine, alone: 2278 ms and 1064 ms. That margin is comfortable until the file runs beside
    // the rest of the suite, where the same two lost it and timed out — three times in a row on
    // 2026-09-09, on a tree whose diff touched neither this file nor `assemble.ts`. The work is
    // not slow; it is contended, so the budget says so rather than the machine deciding.
  }, 30_000);

  it("runs the npm it carries — the D3 assertion, in miniature", () => {
    const result = spawnSync(
      join(payload.outDir, ...payload.manifest.launch.interpreter.split("/")),
      [join(payload.outDir, ...payload.manifest.launch.npm_cli.split("/")), "--version"],
      { encoding: "utf8", env: scrubbedEnvironment(), cwd: scratch },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(payload.manifest.npm_version);
  });

  it("cannot find a node on that PATH, which is what makes the two runs above mean something", () => {
    const environment = scrubbedEnvironment();
    const lookup = spawnSync(
      process.platform === "win32" ? "where" : join(environment.PATH ?? "", "sh"),
      process.platform === "win32" ? ["node"] : ["-c", "command -v node"],
      { encoding: "utf8", env: environment },
    );

    expect(lookup.status).not.toBe(0);
    expect(lookup.stdout.trim()).toBe("");
  });
});

describe("assembleRuntime — what it refuses", () => {
  it("refuses a host that is not plain Node, naming which one it is", () => {
    expect(() =>
      assembleRuntime({
        outDir: join(scratch, "refused-electron"),
        repoRoot: checkout,
        rootPackage: ROOT,
        host: {
          execPath: "/Applications/x.app/Contents/MacOS/x",
          electronVersion: "40.1.0",
          isSea: false,
        },
      }),
    ).toThrowError(/is electron/);
    expect(existsSync(join(scratch, "refused-electron"))).toBe(false);
  });

  it("refuses a single-executable host for the same reason", () => {
    expect(() =>
      assembleRuntime({
        outDir: join(scratch, "refused-sea"),
        repoRoot: checkout,
        rootPackage: ROOT,
        host: { execPath: "/opt/xplainer", electronVersion: undefined, isSea: true },
      }),
    ).toThrowError(/is sea/);
  });

  it("refuses an output directory that already holds something", () => {
    const occupied = join(scratch, "occupied");
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, "keep-me"), "");

    expect(() =>
      assembleRuntime({ outDir: occupied, repoRoot: checkout, rootPackage: ROOT }),
    ).toThrowError(/is not empty/);
    expect(existsSync(join(occupied, "keep-me"))).toBe(true);
  });

  it("refuses a workspace package that declares no `files` allowlist", () => {
    const bare = buildCheckout(join(scratch, "no-allowlist"), { dropRootFiles: true });

    expect(() =>
      assembleRuntime({
        outDir: join(scratch, "no-allowlist-out"),
        repoRoot: bare,
        rootPackage: ROOT,
      }),
    ).toThrowError(/declares no `files` allowlist/);
  }, 30_000);

  it("refuses a root package whose entry was never built, naming the build command", () => {
    const unbuilt = buildCheckout(join(scratch, "unbuilt"), { dropEntry: true });

    expect(() =>
      assembleRuntime({
        outDir: join(scratch, "unbuilt-out"),
        repoRoot: unbuilt,
        rootPackage: ROOT,
      }),
    ).toThrowError(/pnpm --filter @fixture\/root build/);
  });

  it("refuses to look for a checkout that is not above it", () => {
    const orphan = mkdtempSync(join(tmpdir(), "xplainer-no-checkout-"));
    try {
      expect(() => findCheckout(orphan)).toThrowError(AssemblyRefusal);
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }
  });

  it("finds this checkout from its own source location", () => {
    expect(existsSync(join(findCheckout(), "pnpm-workspace.yaml"))).toBe(true);
  });
});

describe("assembleWorkspace", () => {
  /** One real `npm ci`, shared: every read-only assertion below is about the same install. */
  let installed: AssembledWorkspace;

  beforeAll(() => {
    installed = assembleWorkspace({
      outDir: join(scratch, "workspace"),
      templateDir: buildTemplate(join(scratch, "template")),
      runtimeDir: payload.outDir,
      env: scrubbedEnvironment({
        npm_config_cache: join(scratch, "npm-cache"),
        npm_config_offline: "true",
      }),
    });
  }, 120_000);

  it("installs the template with npm ci and records what actually arrived", () => {
    expect(installed.manifest.kind).toBe("workspace");
    expect(installed.manifest.installer).toBe("npm ci");
    expect(installed.manifest.pins["@remotion/cli"]).toMatch(/remotion-cli-9\.9\.9\.tgz$/);
    expect(installed.manifest.resolved["@remotion/cli"]).toBe("9.9.9");
    expect(installed.manifest.platform).toBe(process.platform);
    expect(installed.manifest.arch).toBe(process.arch);
    expect(installed.manifest.remotion_entry).toBe("node_modules/@remotion/cli/remotion-cli.js");
    expect(installed.manifest.files.some((file) => file.path === WORKSPACE_MANIFEST_FILE)).toBe(
      false,
    );
    expect(installed.manifest.files.length).toBeGreaterThan(0);
    expect(existsSync(join(installed.outDir, WORKSPACE_MANIFEST_FILE))).toBe(true);
  });

  it("puts <runtime>/bin on the install subprocess's PATH, so a script calling bare node runs", () => {
    expect(
      readFileSync(
        join(installed.outDir, "node_modules", "@remotion", "cli", "postinstall.txt"),
        "utf8",
      ),
    ).toBe("ran");
  });

  it("is the reason that install works: the same npm ci without it exits non-zero", () => {
    const bare = join(scratch, "no-path-injection");
    mkdirSync(bare, { recursive: true });
    const template = buildTemplate(join(scratch, "template-bare"));
    for (const file of ["package.json", "package-lock.json"]) {
      writeFileSync(join(bare, file), readFileSync(join(template, file)));
    }

    const result = spawnSync(
      join(payload.outDir, ...payload.manifest.launch.interpreter.split("/")),
      [
        join(payload.outDir, ...payload.manifest.launch.npm_cli.split("/")),
        "ci",
        "--no-audit",
        "--no-fund",
      ],
      {
        cwd: bare,
        encoding: "utf8",
        env: scrubbedEnvironment({
          npm_config_cache: join(scratch, "npm-cache"),
          npm_config_offline: "true",
        }),
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/node: (command )?not found/);
  }, 120_000);

  it("resolves the Remotion entry through the package's own `bin` field", () => {
    const entry = installed.manifest.remotion_entry;

    expect(remotionEntryPath(installed.outDir)).toBe(entry);
    expect(existsSync(join(installed.outDir, ...entry.split("/")))).toBe(true);
  });

  it("answers null for a directory with no @remotion/cli in it", () => {
    expect(remotionEntryPath(scratch)).toBeNull();
  });

  it("classifies an npm ci that ran and failed as install-failed, not as a precondition", () => {
    const template = buildTemplate(join(scratch, "template-desynced"));
    const manifestFile = join(template, "package.json");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as {
      dependencies: Record<string, string>;
    };
    manifest.dependencies["never-locked"] = "1.0.0";
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

    try {
      assembleWorkspace({
        outDir: join(scratch, "workspace-desynced"),
        templateDir: template,
        runtimeDir: payload.outDir,
        env: scrubbedEnvironment({
          npm_config_cache: join(scratch, "npm-cache"),
          npm_config_offline: "true",
        }),
      });
      throw new Error("assembleWorkspace accepted a lockfile that does not match its package.json");
    } catch (error) {
      expect(error).toBeInstanceOf(AssemblyRefusal);
      expect((error as AssemblyRefusal).reason).toBe("install-failed");
      expect((error as AssemblyRefusal).message).toContain("npm ci");
    }
  }, 120_000);

  it("refuses a template with no committed lockfile beside its package.json", () => {
    const template = buildTemplate(join(scratch, "template-unlocked"), { dropLockfile: true });

    expect(() =>
      assembleWorkspace({ outDir: join(scratch, "workspace-unlocked"), templateDir: template }),
    ).toThrowError(/package-lock\.json does not exist/);
    expect(existsSync(join(scratch, "workspace-unlocked"))).toBe(false);
  });
});

/**
 * An environment with a `PATH` on which nothing resolves.
 *
 * The directory is real and empty rather than absent, so a failure is "nothing on this `PATH`"
 * rather than "this `PATH` is malformed". On Windows a child needs `SystemRoot` to start at all,
 * and npm needs somewhere to call home on every platform, so those are supplied and nothing else
 * is: the point of the scrub is the interpreter, not the whole environment.
 */
function scrubbedEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const path = join(scratch, "no-node-path");
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
    if (process.platform !== "win32") {
      // npm runs every lifecycle script through `sh -c`, so a `PATH` with no shell at all fails
      // with `spawn sh ENOENT` before any script could look for an interpreter — which would prove
      // nothing about interpreters. The directory therefore holds a shell and provably nothing
      // else, which is a stricter scrub than `/usr/bin:/bin` and does not depend on what the host
      // happens to have installed there.
      symlinkSync("/bin/sh", join(path, "sh"));
    }
  }
  const home = join(scratch, "home");
  mkdirSync(home, { recursive: true });
  const base: NodeJS.ProcessEnv = { PATH: path, HOME: home, USERPROFILE: home };
  if (process.platform === "win32") {
    base.SystemRoot = process.env.SystemRoot ?? "C:\\Windows";
    base.ComSpec = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
    base.TEMP = process.env.TEMP ?? tmpdir();
  }
  return { ...base, ...extra };
}

/** How a fixture checkout may be deliberately broken. */
type CheckoutOptions = {
  /** Leave the root package with no `files` allowlist at all. */
  dropRootFiles?: boolean;
  /** Leave `dist/bin.js` unbuilt. */
  dropEntry?: boolean;
};

/**
 * Write a checkout the assembler will accept: a workspace marker, two workspace packages and two
 * external ones, with `external-b` present at two versions so hoisting has something to decide.
 */
function buildCheckout(root: string, options: CheckoutOptions = {}): string {
  const write = (relativePath: string, contents: string): void => {
    const file = join(root, relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  };

  write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');

  write(
    "packages/root/package.json",
    `${JSON.stringify(
      {
        name: ROOT,
        version: "0.0.0",
        type: "module",
        bin: { fixture: "./dist/bin.js" },
        ...(options.dropRootFiles === true
          ? {}
          : { files: ["dist/**/*.js", "schemas", "LICENSE"] }),
        dependencies: { "@fixture/lib": "workspace:*", "external-a": "1.0.0" },
      },
      null,
      2,
    )}\n`,
  );
  if (options.dropEntry !== true) {
    write(
      "packages/root/dist/bin.js",
      [
        'import { readFileSync } from "node:fs";',
        'import { NAME } from "@fixture/lib";',
        'import { LABEL } from "external-a";',
        'const schema = JSON.parse(readFileSync(new URL("../schemas/manifest.json", import.meta.url), "utf8"));',
        'process.stdout.write([schema.name, NAME, LABEL].join(" ") + "\\n");',
        "",
      ].join("\n"),
    );
  }
  write("packages/root/schemas/manifest.json", `${JSON.stringify({ name: "fixture" })}\n`);
  write("packages/root/LICENSE", "Apache-2.0\n");
  write("packages/root/NOTES.md", "not shipped\n");
  write("packages/root/src/secret.ts", "export const secret = 1;\n");

  write(
    "packages/lib/package.json",
    `${JSON.stringify(
      {
        name: "@fixture/lib",
        version: "1.0.0",
        type: "module",
        main: "dist/index.js",
        files: ["dist"],
      },
      null,
      2,
    )}\n`,
  );
  write("packages/lib/dist/index.js", 'export const NAME = "lib-1.0.0";\n');

  write(
    "node_modules/external-a/package.json",
    `${JSON.stringify(
      {
        name: "external-a",
        version: "1.0.0",
        type: "module",
        main: "index.js",
        dependencies: { "external-b": "2.0.0" },
      },
      null,
      2,
    )}\n`,
  );
  write("node_modules/external-a/index.js", 'export const LABEL = "a-1.0.0";\n');
  write(
    "node_modules/external-a/node_modules/external-b/package.json",
    `${JSON.stringify({ name: "external-b", version: "2.0.0", type: "module", main: "index.js" }, null, 2)}\n`,
  );
  write("node_modules/external-a/node_modules/external-b/index.js", 'export const B = "2.0.0";\n');
  write(
    "node_modules/external-b/package.json",
    `${JSON.stringify({ name: "external-b", version: "1.0.0", type: "module", main: "index.js" }, null, 2)}\n`,
  );
  write("node_modules/external-b/index.js", 'export const B = "1.0.0";\n');
  write(
    "packages/lib/package-extra.json",
    `${JSON.stringify({ note: "outside every allowlist" })}\n`,
  );

  // `external-b@1.0.0` is a direct dependency of the root package too, so the hoisted copy is
  // claimed by it and `external-a`'s 2.0.0 has to be nested rather than flattened.
  const manifestFile = join(root, "packages", "root", "package.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as {
    dependencies: Record<string, string>;
  };
  manifest.dependencies["external-b"] = "1.0.0";
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  return root;
}

/** How a fixture template may be deliberately broken. */
type TemplateOptions = {
  /** Write the `package.json` and leave the lockfile out. */
  dropLockfile?: boolean;
};

/**
 * Write a template the way `packages/render-core/template/` is written: a `package.json` with pins
 * and a `package-lock.json` npm generated from it, both committed side by side.
 *
 * The one dependency is a tarball this function packs, named `@remotion/cli` so the entry
 * resolution under test has something to resolve, and carrying a `postinstall` that calls bare
 * `node` — which is precisely the lifecycle script that exits 127 when nothing puts an interpreter
 * on the install subprocess's `PATH`.
 */
function buildTemplate(root: string, options: TemplateOptions = {}): string {
  if (existsSync(join(root, "package.json"))) {
    return root;
  }
  const source = `${root}-dep`;
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, "package.json"),
    `${JSON.stringify(
      {
        name: "@remotion/cli",
        version: "9.9.9",
        bin: { remotion: "remotion-cli.js" },
        scripts: {
          postinstall: `node -e "require('node:fs').writeFileSync('postinstall.txt','ran')"`,
        },
      },
      null,
      2,
    )}\n`,
  );
  const entry = join(source, "remotion-cli.js");
  writeFileSync(entry, '#!/usr/bin/env node\nprocess.stdout.write("fixture remotion\\n");\n');
  chmodSync(entry, 0o755);

  mkdirSync(root, { recursive: true });
  const npm = npmInstallation(process.execPath);
  const packDir = `${root}-pack`;
  mkdirSync(packDir, { recursive: true });
  const packed = runNpm(npm.cli, ["pack", "--pack-destination", packDir, source], packDir);
  const tarball = packed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".tgz"))
    .at(-1);
  if (tarball === undefined) {
    throw new Error(`npm pack wrote no tarball name:\n${packed}`);
  }

  // Two fixture-only choices, both deliberate. A `file:` dependency on a **directory** is
  // materialised as a symlink out of the tree, which a payload cannot carry; a `file:` dependency
  // on a **tarball** is extracted into a real directory, so the template names the packed file. And
  // the path is absolute because `assembleWorkspace()` copies the template's two documents into a
  // staging directory and installs there — a relative `file:` would resolve against the staging
  // directory, where nothing packed it. The real template has no `file:` dependency at all.
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "@xplainer/render-workspace",
        version: "1.0.0",
        private: true,
        dependencies: { "@remotion/cli": `file:${join(packDir, tarball)}` },
      },
      null,
      2,
    )}\n`,
  );
  if (options.dropLockfile === true) {
    return root;
  }
  runNpm(npm.cli, ["install", "--package-lock-only", "--no-audit", "--no-fund"], root);
  return root;
}

/** Run npm from this machine's own installation, and fail loudly rather than silently. */
function runNpm(cli: string, args: string[], cwd: string): string {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_cache: join(scratch, "npm-cache"),
      npm_config_offline: "true",
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `npm ${args.join(" ")} exited ${result.status}:\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}
