/**
 * Where a packaged build's payload is, on all three platforms, from one machine.
 *
 * Round 2's version of this derivation hard-coded the macOS layout and then scheduled the check on
 * three runners, so two thirds of it could never have failed. Every assertion below names the
 * platform it is about and composes the expected string with that platform's separator, which is
 * the only reason a Windows layout is checkable from macOS at all.
 *
 * Nothing here touches the filesystem: these are the pure path functions, and the packaged tree
 * they describe is asserted for real by `scripts/check-packaged-payload.mjs` after
 * `electron-builder`.
 */

import process from "node:process";
import { describe, expect, it } from "vitest";
import {
  PACKAGED_PAYLOAD_DIRECTORY,
  PAYLOAD_CLI_ENTRY,
  packagedCliEntry,
  packagedInterpreter,
  packagedPayloadLayout,
  packagedPayloadRoot,
  packagedRuntimeManifest,
  payloadInterpreterEntry,
  RUNTIME_MANIFEST_FILE,
} from "./paths";

describe("the payload's placement inside a packaged build", () => {
  it("is the extraResources directory electron-builder.yml names", () => {
    expect(PACKAGED_PAYLOAD_DIRECTORY).toBe("xplainer-runtime");
    expect(RUNTIME_MANIFEST_FILE).toBe("runtime.manifest.json");
    expect(PAYLOAD_CLI_ENTRY).toBe("lib/node_modules/@xplainer/cli/dist/bin.js");
  });

  it("resolves the macOS layout under <app>.app/Contents/Resources", () => {
    const resources = "/Applications/Xplainer.app/Contents/Resources";
    const layout = packagedPayloadLayout(resources, "darwin");

    expect(layout.root).toBe("/Applications/Xplainer.app/Contents/Resources/xplainer-runtime");
    expect(layout.interpreter).toBe(`${layout.root}/bin/node`);
    expect(layout.entry).toBe(`${layout.root}/lib/node_modules/@xplainer/cli/dist/bin.js`);
    expect(layout.manifest).toBe(`${layout.root}/runtime.manifest.json`);
  });

  it("resolves the Linux layout under <dir>/resources", () => {
    const resources = "/opt/Xplainer/resources";
    const layout = packagedPayloadLayout(resources, "linux");

    expect(layout.root).toBe("/opt/Xplainer/resources/xplainer-runtime");
    expect(layout.interpreter).toBe("/opt/Xplainer/resources/xplainer-runtime/bin/node");
    expect(layout.entry).toBe(
      "/opt/Xplainer/resources/xplainer-runtime/lib/node_modules/@xplainer/cli/dist/bin.js",
    );
    expect(layout.manifest).toBe("/opt/Xplainer/resources/xplainer-runtime/runtime.manifest.json");
  });

  it("resolves the Windows layout under <dir>\\resources, with node.exe and backslashes", () => {
    const resources = "C:\\Program Files\\Xplainer\\resources";
    const layout = packagedPayloadLayout(resources, "win32");

    expect(layout.root).toBe("C:\\Program Files\\Xplainer\\resources\\xplainer-runtime");
    expect(layout.interpreter).toBe(
      "C:\\Program Files\\Xplainer\\resources\\xplainer-runtime\\bin\\node.exe",
    );
    expect(layout.entry).toBe(
      "C:\\Program Files\\Xplainer\\resources\\xplainer-runtime\\lib\\node_modules\\@xplainer\\cli\\dist\\bin.js",
    );
    expect(layout.manifest).toBe(
      "C:\\Program Files\\Xplainer\\resources\\xplainer-runtime\\runtime.manifest.json",
    );
  });

  it("names node.exe only on Windows", () => {
    expect(payloadInterpreterEntry("darwin")).toBe("bin/node");
    expect(payloadInterpreterEntry("linux")).toBe("bin/node");
    expect(payloadInterpreterEntry("win32")).toBe("bin/node.exe");
  });

  it("composes each path from the payload root the same way the layout does", () => {
    const root = packagedPayloadRoot("/opt/Xplainer/resources", "linux");

    expect(packagedInterpreter(root, "linux")).toBe(`${root}/bin/node`);
    expect(packagedCliEntry(root, "linux")).toBe(`${root}/${PAYLOAD_CLI_ENTRY}`);
    expect(packagedRuntimeManifest(root, "linux")).toBe(`${root}/${RUNTIME_MANIFEST_FILE}`);
  });

  it("defaults to the platform it is running on", () => {
    const resources = process.platform === "win32" ? "C:\\app\\resources" : "/app/resources";

    expect(packagedPayloadLayout(resources)).toEqual(
      packagedPayloadLayout(resources, process.platform),
    );
    expect(payloadInterpreterEntry()).toBe(payloadInterpreterEntry(process.platform));
  });
});
