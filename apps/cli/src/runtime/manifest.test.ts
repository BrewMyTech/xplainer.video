/**
 * The manifest's own rules, over real files rather than over a description of files.
 *
 * Everything here writes a small tree into a temporary directory and asks the module about it: a
 * hash is asserted against a published SHA-256 constant rather than against another call to this
 * same code, a symlink is a real symlink, and an executable bit is a real mode. The one thing that
 * cannot be produced on this machine — an Electron or single-executable host — is a **pure**
 * classification over a description, which is why {@link classifyHost} takes one instead of reading
 * `process`.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyHost,
  describeHost,
  hashFile,
  isPayloadPath,
  listTree,
  ManifestError,
  RUNTIME_MANIFEST_FILE,
  readRuntimeManifest,
  readWorkspaceManifest,
  scanTree,
  toPayloadPath,
  WORKSPACE_MANIFEST_FILE,
} from "./manifest.js";

/** The published SHA-256 of the empty string and of `abc`, so the hash is checked against a fact. */
const SHA256_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xplainer-manifest-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("classifyHost", () => {
  it("calls a plain Node interpreter node", () => {
    expect(
      classifyHost({ execPath: "/usr/local/bin/node", electronVersion: undefined, isSea: false }),
    ).toBe("node");
  });

  it("calls a packaged Electron binary electron, whatever it is named", () => {
    expect(
      classifyHost({
        execPath: "/Applications/xplainer.app/Contents/MacOS/xplainer",
        electronVersion: "40.1.0",
        isSea: false,
      }),
    ).toBe("electron");
  });

  it("calls a single-executable host sea", () => {
    expect(
      classifyHost({ execPath: "/opt/xplainer", electronVersion: undefined, isSea: true }),
    ).toBe("sea");
  });

  it("prefers electron over sea, because a SEA build can embed either", () => {
    expect(
      classifyHost({ execPath: "/opt/xplainer", electronVersion: "40.1.0", isSea: true }),
    ).toBe("electron");
  });

  it("describes this process, which is the plain Node case", () => {
    const host = describeHost();

    expect(host.execPath).toBe(process.execPath);
    expect(classifyHost(host)).toBe("node");
  });
});

describe("isPayloadPath", () => {
  it("accepts a relative, slash-separated path", () => {
    expect(isPayloadPath("lib/node_modules/@xplainer/cli/dist/bin.js")).toBe(true);
  });

  it.each([
    ["", "the empty string"],
    ["/usr/local/bin/node", "a POSIX absolute path"],
    ["\\\\server\\share\\node.exe", "a UNC path"],
    ["C:/Users/build/node.exe", "a Windows drive letter"],
    ["lib/../../etc/passwd", "an escape through .."],
  ])("rejects %j — %s", (path) => {
    expect(isPayloadPath(path)).toBe(false);
  });
});

describe("hashFile", () => {
  it("hashes an empty file to the published SHA-256 of the empty string", () => {
    const file = join(root, "empty");
    writeFileSync(file, "");

    expect(hashFile(file)).toBe(SHA256_EMPTY);
  });

  it("hashes `abc` to the published SHA-256 of `abc`", () => {
    const file = join(root, "abc");
    writeFileSync(file, "abc");

    expect(hashFile(file)).toBe(SHA256_ABC);
  });

  it("hashes a file larger than one read buffer", () => {
    const small = join(root, "small");
    const large = join(root, "large");
    writeFileSync(small, "x");
    writeFileSync(large, "x".repeat(3 * 1024 * 1024));

    expect(hashFile(large)).not.toBe(hashFile(small));
    expect(hashFile(large)).toHaveLength(64);
  });
});

describe("scanTree", () => {
  it("records every file, sorted, payload-relative, with size and hash", () => {
    mkdirSync(join(root, "lib", "deep"), { recursive: true });
    writeFileSync(join(root, "z.txt"), "abc");
    writeFileSync(join(root, "lib", "deep", "a.txt"), "");

    const scan = scanTree(root);

    expect(scan.files.map((file) => file.path)).toEqual(["lib/deep/a.txt", "z.txt"]);
    expect(scan.files[0]).toMatchObject({ sha256: SHA256_EMPTY, bytes: 0 });
    expect(scan.files[1]).toMatchObject({ sha256: SHA256_ABC, bytes: 3 });
  });

  it("records a symlink by its unresolved target and never descends it", () => {
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(join(root, "lib", "cli.js"), "entry");
    mkdirSync(join(root, "bin"));
    symlinkSync(join("..", "lib", "cli.js"), join(root, "bin", "tool"));

    const scan = scanTree(root);

    expect(scan.files.map((file) => file.path)).toEqual(["lib/cli.js"]);
    expect(scan.links).toEqual([{ path: "bin/tool", target: "../lib/cli.js" }]);
  });

  it("records the executable bit where the platform has one", () => {
    const file = join(root, "run");
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o755);

    const [entry] = scanTree(root).files;

    expect(entry?.executable).toBe(process.platform !== "win32");
  });

  it("leaves out exactly what it is told to leave out", () => {
    writeFileSync(join(root, RUNTIME_MANIFEST_FILE), "{}");
    writeFileSync(join(root, "kept"), "");

    const scan = scanTree(root, { exclude: [RUNTIME_MANIFEST_FILE] });

    expect(scan.files.map((file) => file.path)).toEqual(["kept"]);
  });
});

describe("listTree", () => {
  it("lists the same paths scanTree describes, without hashing anything", () => {
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(join(root, "lib", "cli.js"), "entry");
    symlinkSync(join("lib", "cli.js"), join(root, "link"));

    const scan = scanTree(root);

    expect(listTree(root)).toEqual(
      [...scan.files.map((file) => file.path), ...scan.links.map((link) => link.path)].sort(),
    );
  });
});

describe("toPayloadPath", () => {
  it("leaves a slash-separated path alone", () => {
    expect(toPayloadPath("a/b/c")).toBe("a/b/c");
  });
});

describe("reading a manifest back", () => {
  it("round-trips a runtime manifest written as JSON", () => {
    writeFileSync(
      join(root, RUNTIME_MANIFEST_FILE),
      JSON.stringify({
        kind: "runtime",
        manifest_version: 1,
        created_at: "2026-09-07T00:00:00.000Z",
        platform: "linux",
        arch: "x64",
        node_version: "v24.20.0",
        npm_version: "11.19.0",
        host: "node",
        launch: {
          interpreter: "bin/node",
          entry: "lib/node_modules/@xplainer/cli/dist/bin.js",
          npm_cli: "lib/node_modules/npm/bin/npm-cli.js",
          argv: ["bin/node", "lib/node_modules/@xplainer/cli/dist/bin.js"],
        },
        packages: [
          {
            path: "lib/node_modules/@xplainer/cli",
            name: "@xplainer/cli",
            version: "0.0.0",
            workspace: true,
          },
        ],
        files: [{ path: "bin/node", sha256: SHA256_ABC, bytes: 3, executable: true }],
        links: [{ path: "bin/npm", target: "../lib/node_modules/npm/bin/npm-cli.js" }],
      }),
    );

    const manifest = readRuntimeManifest(root);

    expect(manifest.platform).toBe("linux");
    expect(manifest.arch).toBe("x64");
    expect(manifest.launch.argv).toEqual([
      "bin/node",
      "lib/node_modules/@xplainer/cli/dist/bin.js",
    ]);
    expect(manifest.packages[0]?.name).toBe("@xplainer/cli");
    expect(manifest.links[0]?.target).toBe("../lib/node_modules/npm/bin/npm-cli.js");
  });

  it("names the field that is wrong rather than throwing a cast error later", () => {
    writeFileSync(
      join(root, RUNTIME_MANIFEST_FILE),
      JSON.stringify({
        kind: "runtime",
        manifest_version: 1,
        created_at: "2026-09-07T00:00:00.000Z",
        platform: "linux",
        arch: "x64",
        node_version: "v24.20.0",
        npm_version: "11.19.0",
        host: "node",
        launch: { interpreter: "bin/node", entry: "e", npm_cli: "n", argv: [] },
        packages: [],
        files: [{ path: "bin/node", sha256: SHA256_ABC, bytes: "three", executable: true }],
        links: [],
      }),
    );

    expect(() => readRuntimeManifest(root)).toThrowError(
      /files\[0\]\.bytes is not a finite number/,
    );
  });

  it("refuses a workspace manifest that claims to be a runtime one", () => {
    writeFileSync(join(root, WORKSPACE_MANIFEST_FILE), JSON.stringify({ kind: "runtime" }));

    expect(() => readWorkspaceManifest(root)).toThrowError(ManifestError);
  });

  it("says the file could not be read when there is no manifest at all", () => {
    expect(() => readRuntimeManifest(root)).toThrowError(/cannot be read/);
  });
});
