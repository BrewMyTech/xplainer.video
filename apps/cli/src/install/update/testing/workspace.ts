/**
 * A payload-2 workspace small enough to build in a test and real enough for the shipped verifier.
 *
 * T15's pre-drain check asks one question of the installed workspace — does
 * `verifyWorkspacePayload()` accept it against these pins — and that verifier re-hashes the tree
 * against `workspace.manifest.json` and compares the manifest's `resolved` map with the pins it was
 * given. A real payload 2 is an `npm ci` of a 268-package template and about 120 MB; none of that
 * changes the answer to the question above. So this builds the smallest tree the **shipped**
 * verifier accepts: a real file, a real hash, a real manifest written by the same `scanTree()` the
 * assembler uses.
 *
 * **What that does and does not establish.** It establishes that the precondition reads a real
 * manifest, re-hashes real bytes and compares real version maps — so a change that stopped
 * verifying, or that compared the wrong map, fails here. It does **not** establish anything about
 * `npm ci`, about Remotion's own `versions` check, or about a workspace's ability to render: those
 * are `runtime/assemble.ts`'s and T19's, and `scripts/e2e/toolchain.mjs` is where the rendering half
 * is proved. Nothing here ships — `tsconfig.build.json` excludes `src/**\/testing/**`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
  MANIFEST_VERSION,
  scanTree,
  WORKSPACE_MANIFEST_FILE,
  type WorkspaceManifest,
} from "../../../runtime/manifest.js";

/** What {@link writeFixtureWorkspace} was asked for. */
export type FixtureWorkspaceOptions = {
  /** Where the workspace goes. Created if missing. */
  outDir: string;
  /** The pins the template declared, as the manifest records them. */
  pins: Readonly<Record<string, string>>;
  /**
   * What the install resolved, when it differs from the pins.
   *
   * Defaults to the pins themselves, which is what a healthy `npm ci` of that template produces.
   * A case that wants the "workspace does not satisfy this runtime" refusal passes a map that
   * disagrees — that is exactly the state a pin-changing update would leave behind.
   */
  resolved?: Readonly<Record<string, string>> | undefined;
};

/** Build a workspace payload at `outDir` that the shipped verifier accepts against `pins`. */
export function writeFixtureWorkspace(options: FixtureWorkspaceOptions): WorkspaceManifest {
  const entry = join("node_modules", "remotion", "cli.js");
  mkdirSync(join(options.outDir, "node_modules", "remotion"), { recursive: true });
  writeFileSync(join(options.outDir, entry), "// a stand-in for the Remotion CLI entry\n");
  writeFileSync(
    join(options.outDir, "package.json"),
    `${JSON.stringify(
      { name: "@xplainer/render-workspace", version: "1.0.0", dependencies: { ...options.pins } },
      null,
      2,
    )}\n`,
  );

  const scan = scanTree(options.outDir, { exclude: [WORKSPACE_MANIFEST_FILE] });
  const manifest: WorkspaceManifest = {
    kind: "workspace",
    manifest_version: MANIFEST_VERSION,
    created_at: new Date().toISOString(),
    // This machine's, because `runtime/verify.ts` refuses a payload assembled for another host
    // before it hashes anything — a workspace holds compiled dependencies.
    platform: process.platform,
    arch: process.arch,
    node_version: process.version,
    npm_version: "0.0.0-fixture",
    installer: "npm ci",
    pins: { ...options.pins },
    resolved: { ...(options.resolved ?? options.pins) },
    remotion_entry: entry.split("\\").join("/"),
    files: scan.files,
    links: scan.links,
  };
  writeFileSync(
    join(options.outDir, WORKSPACE_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}
