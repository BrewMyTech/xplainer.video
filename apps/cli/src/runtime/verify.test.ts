/**
 * The verifier, against payloads that have really been tampered with.
 *
 * Each case writes a small payload with a real manifest, changes exactly one thing on disk or in
 * the document, and asserts which mismatch is reported **and by what name**. That last part is the
 * behaviour under test: a verifier that answers "no" has told a reader nothing, and the story's
 * requirement is that it "reports the first mismatch by name".
 *
 * The manifest is written the way the assembler writes it — {@link scanTree} over the finished tree
 * — rather than by hand, so the fixture cannot quietly drift into describing a document this
 * repository never produces. That the assembler's own output verifies is asserted in
 * `assemble.test.ts` against a real 130 MB payload.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MANIFEST_VERSION,
  RUNTIME_MANIFEST_FILE,
  type RuntimeManifest,
  scanTree,
  WORKSPACE_MANIFEST_FILE,
  type WorkspaceManifest,
} from "./manifest.js";
import { readTemplatePins, verifyRuntimePayload, verifyWorkspacePayload } from "./verify.js";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xplainer-verify-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("verifyRuntimePayload", () => {
  it("passes a payload nothing has touched", () => {
    writeRuntimePayload();

    const report = verifyRuntimePayload(root);

    expect(report.failure).toBeNull();
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(4);
  });

  it("names a file whose contents changed, without its size changing", () => {
    writeRuntimePayload();
    writeFileSync(join(root, "lib", "b.js"), "XX");

    const report = verifyRuntimePayload(root);

    expect(report.failure?.reason).toBe("changed");
    expect(report.failure?.name).toBe("lib/b.js");
    expect(report.failure?.detail).toMatch(/hashes to [0-9a-f]{64}/);
  });

  it("distinguishes a truncated file from a rewritten one", () => {
    writeRuntimePayload();
    truncateSync(join(root, "lib", "b.js"), 1);

    const report = verifyRuntimePayload(root);

    expect(report.failure?.reason).toBe("resized");
    expect(report.failure?.name).toBe("lib/b.js");
  });

  it("names a file that is gone", () => {
    writeRuntimePayload();
    unlinkSync(join(root, "bin", "node"));

    const report = verifyRuntimePayload(root);

    expect(report.failure?.reason).toBe("missing");
    expect(report.failure?.name).toBe("bin/node");
  });

  it("names a file that is no longer a regular file", () => {
    writeRuntimePayload();
    unlinkSync(join(root, "lib", "a.js"));
    mkdirSync(join(root, "lib", "a.js"));

    const report = verifyRuntimePayload(root);

    expect(report.failure?.reason).toBe("not-a-file");
    expect(report.failure?.name).toBe("lib/a.js");
  });

  it("names a file that was added, because a payload is exactly what was assembled", () => {
    writeRuntimePayload();
    writeFileSync(join(root, "lib", "smuggled.js"), "hello");

    const report = verifyRuntimePayload(root);

    expect(report.failure?.reason).toBe("unexpected");
    expect(report.failure?.name).toBe("lib/smuggled.js");
  });

  it("names a symlink that was repointed, by its target rather than by what it points at", () => {
    writeRuntimePayload();
    unlinkSync(join(root, "bin", "npm"));
    symlinkSync("../lib/b.js", join(root, "bin", "npm"));

    const report = verifyRuntimePayload(root);

    expect(report.failure?.reason).toBe("link-changed");
    expect(report.failure?.name).toBe("bin/npm");
    expect(report.failure?.detail).toContain("../lib/a.js");
  });

  it("names a symlink that is gone", () => {
    writeRuntimePayload();
    unlinkSync(join(root, "bin", "npm"));

    const report = verifyRuntimePayload(root);

    expect(report.failure?.reason).toBe("link-missing");
    expect(report.failure?.name).toBe("bin/npm");
  });

  it("reports the FIRST mismatch, in path order, when there is more than one", () => {
    writeRuntimePayload();
    writeFileSync(join(root, "lib", "a.js"), "ZZ");
    writeFileSync(join(root, "lib", "b.js"), "ZZ");

    expect(verifyRuntimePayload(root).failure?.name).toBe("lib/a.js");
  });

  it("refuses a payload built for another platform before it hashes anything", () => {
    writeRuntimePayload({ platform: "aix" });

    const report = verifyRuntimePayload(root);

    expect(report.failure?.reason).toBe("wrong-platform");
    expect(report.failure?.name).toBe("aix");
    expect(report.checked).toBe(0);
  });

  it("refuses a payload carrying an interpreter for another architecture", () => {
    writeRuntimePayload({ arch: "mips" });

    const report = verifyRuntimePayload(root);

    expect(report.failure?.reason).toBe("wrong-arch");
    expect(report.failure?.name).toBe("mips");
    expect(report.checked).toBe(0);
  });

  it("refuses a manifest that names an absolute path", () => {
    const manifest = writeRuntimePayload();
    const first = manifest.files[0];
    if (first === undefined) {
      throw new Error("the fixture payload described no files");
    }
    first.path = "/etc/passwd";
    writeFileSync(join(root, RUNTIME_MANIFEST_FILE), JSON.stringify(manifest));

    const report = verifyRuntimePayload(root);

    expect(report.failure?.reason).toBe("absolute-path");
    expect(report.failure?.name).toBe("/etc/passwd");
  });

  it("says the manifest could not be read when it is absent, and names the file", () => {
    const report = verifyRuntimePayload(root);

    expect(report.failure?.reason).toBe("manifest-unreadable");
    expect(report.failure?.name).toBe(join(root, RUNTIME_MANIFEST_FILE));
  });

  it("says the manifest could not be read when it is not JSON", () => {
    writeFileSync(join(root, RUNTIME_MANIFEST_FILE), "{");

    expect(verifyRuntimePayload(root).failure?.detail).toMatch(/not valid JSON/);
  });

  it("refuses a workspace manifest handed to the runtime verifier", () => {
    const manifest = writeRuntimePayload();
    writeFileSync(
      join(root, RUNTIME_MANIFEST_FILE),
      JSON.stringify({ ...manifest, kind: "workspace" }),
    );

    expect(verifyRuntimePayload(root).failure?.detail).toMatch(/not a runtime payload manifest/);
  });
});

describe("verifyWorkspacePayload", () => {
  it("passes an installed workspace whose resolved versions are the template's pins", () => {
    writeWorkspacePayload({ react: "19.2.3", zod: "4.3.6" });

    const report = verifyWorkspacePayload(root, { react: "19.2.3", zod: "4.3.6" });

    expect(report.failure).toBeNull();
    expect(report.ok).toBe(true);
  });

  it("names the package whose resolved version is not the pinned one", () => {
    writeWorkspacePayload({ react: "19.2.3", zod: "4.5.4" });

    const report = verifyWorkspacePayload(root, { react: "19.2.3", zod: "4.3.6" });

    expect(report.failure?.reason).toBe("pin-mismatch");
    expect(report.failure?.name).toBe("zod");
    expect(report.failure?.detail).toContain("4.5.4");
    expect(report.failure?.detail).toContain("4.3.6");
  });

  it("names a pinned package the install never produced", () => {
    writeWorkspacePayload({ react: "19.2.3" });

    const report = verifyWorkspacePayload(root, { react: "19.2.3", zod: "4.3.6" });

    expect(report.failure?.reason).toBe("pin-missing");
    expect(report.failure?.name).toBe("zod");
  });

  it("compares pins in name order, so the reported package is stable", () => {
    writeWorkspacePayload({ alpha: "1", zeta: "1" });

    const report = verifyWorkspacePayload(root, { alpha: "2", zeta: "2" });

    expect(report.failure?.name).toBe("alpha");
  });

  it("refuses a workspace installed on another platform, which is what compositors require", () => {
    writeWorkspacePayload({ react: "19.2.3" }, { platform: "aix" });

    expect(verifyWorkspacePayload(root, { react: "19.2.3" }).failure?.reason).toBe(
      "wrong-platform",
    );
  });

  it("checks the tree before it checks the pins, so a tampered file is not excused by them", () => {
    writeWorkspacePayload({ react: "19.2.3" });
    writeFileSync(join(root, "lib", "a.js"), "ZZ");

    expect(verifyWorkspacePayload(root, { react: "19.2.3" }).failure?.reason).toBe("changed");
  });
});

describe("readTemplatePins", () => {
  it("reads the shipped template's own pins, including the zod Remotion requires", () => {
    const pins = readTemplatePins();

    expect(pins.zod).toBe("4.3.6");
    expect(pins.remotion).toBe("4.0.495");
    expect(pins.react).toBe("19.2.3");
    expect(pins.typescript).toBe("5.7.3");
  });
});

/** Write a four-entry payload and its manifest, and return the manifest for a test to tamper with. */
function writeRuntimePayload(overrides: Partial<RuntimeManifest> = {}): RuntimeManifest {
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "bin", "node"), "interpreter");
  writeFileSync(join(root, "lib", "a.js"), "aa");
  writeFileSync(join(root, "lib", "b.js"), "bb");
  symlinkSync("../lib/a.js", join(root, "bin", "npm"));

  const scan = scanTree(root, { exclude: [RUNTIME_MANIFEST_FILE] });
  const manifest: RuntimeManifest = {
    kind: "runtime",
    manifest_version: MANIFEST_VERSION,
    created_at: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node_version: process.version,
    npm_version: "11.19.0",
    host: "node",
    launch: {
      interpreter: "bin/node",
      entry: "lib/a.js",
      npm_cli: "lib/b.js",
      argv: ["bin/node", "lib/a.js"],
    },
    packages: [],
    files: scan.files,
    links: scan.links,
    ...overrides,
  };
  writeFileSync(join(root, RUNTIME_MANIFEST_FILE), JSON.stringify(manifest));
  return JSON.parse(readFileSync(join(root, RUNTIME_MANIFEST_FILE), "utf8")) as RuntimeManifest;
}

/** Write a small installed-workspace fixture whose manifest claims `resolved`. */
function writeWorkspacePayload(
  resolved: Record<string, string>,
  overrides: Partial<WorkspaceManifest> = {},
): void {
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "lib", "a.js"), "aa");
  writeFileSync(join(root, "package.json"), "{}\n");

  const scan = scanTree(root, { exclude: [WORKSPACE_MANIFEST_FILE] });
  const manifest: WorkspaceManifest = {
    kind: "workspace",
    manifest_version: MANIFEST_VERSION,
    created_at: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node_version: process.version,
    npm_version: "11.19.0",
    installer: "npm ci",
    pins: resolved,
    resolved,
    remotion_entry: "node_modules/@remotion/cli/remotion-cli.js",
    files: scan.files,
    links: scan.links,
    ...overrides,
  };
  writeFileSync(join(root, WORKSPACE_MANIFEST_FILE), JSON.stringify(manifest));
}
