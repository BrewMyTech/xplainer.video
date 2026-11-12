/**
 * D7's deletion, against real trees on disk (ADR 0031 §Note, 2026-11-12).
 *
 * The property worth a suite is the negative one: a workspace root may be a user's own project
 * (`XPLAINER_VIDEOS_DIR`), so everything that is not provably the tree an earlier `setup` wrote is
 * asserted byte for byte untouched — the user's project, every partial match, and the user's work
 * beside a tree that *is* removed.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LAST_TEMPLATE,
  PREVIOUS_ENTRY_FIELD,
  PREVIOUS_RENDERER_ENTRIES,
  PREVIOUS_WORKSPACE_MANIFEST,
  removePreviousRendererTree,
} from "./previous-renderer.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The user's work and the daemon's, which no outcome here may touch. */
const KEPT = [
  "videos/demo/Scenes.tsx",
  "public/demo/timings.json",
  "out/demo/explainer.mp4",
  "requests/job-000001.json",
  "locks/demo.lock",
  "tailwind.css",
  "tsconfig.json",
] as const;

/** The CLI entry name the old manifest recorded, built from parts like every fixture of the word. */
const ENTRY = ["node_modules/@", "rem", "otion/cli/", "rem", "otion-cli.js"].join("");

type TreeOptions = {
  /** `package.json`'s contents, or `null` for no file at all. */
  packageJson?: Record<string, unknown> | null;
  /** `workspace.manifest.json`'s contents, or `null` for no file at all. */
  manifest?: Record<string, unknown> | null;
};

/** A workspace root as an older `setup --workspace` left it, with the user's work beside it. */
function workspace(options: TreeOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "xplainer-previous-renderer-"));
  roots.push(root);
  for (const path of KEPT) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), `user's ${path}\n`);
  }
  mkdirSync(join(root, "node_modules", "react"), { recursive: true });
  writeFileSync(join(root, "node_modules", "react", "package.json"), '{"version":"19.2.3"}\n');
  writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  const packageJson =
    options.packageJson === undefined
      ? { ...LAST_TEMPLATE, version: "1.0.0", private: true }
      : options.packageJson;
  if (packageJson !== null) {
    writeFileSync(join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  }
  const manifest =
    options.manifest === undefined
      ? { kind: "workspace", [PREVIOUS_ENTRY_FIELD]: ENTRY }
      : options.manifest;
  if (manifest !== null) {
    writeFileSync(join(root, PREVIOUS_WORKSPACE_MANIFEST), `${JSON.stringify(manifest)}\n`);
  }
  return root;
}

/** Every file and directory under `root`, with each file's bytes, as one comparable snapshot. */
function snapshot(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const path of readdirSync(root, { recursive: true }).map(String).sort()) {
    const full = join(root, path);
    try {
      entries[path] = readFileSync(full, "utf8");
    } catch {
      entries[path] = "<directory>";
    }
  }
  return entries;
}

describe("removePreviousRendererTree", () => {
  it("removes the four entries of the tree an earlier setup wrote, evidence last", () => {
    const root = workspace();

    const outcome = removePreviousRendererTree(root);

    expect(outcome).toEqual({ kind: "removed", removed: [...PREVIOUS_RENDERER_ENTRIES] });
    expect(PREVIOUS_RENDERER_ENTRIES.at(-1)).toBe(PREVIOUS_WORKSPACE_MANIFEST);
    for (const entry of PREVIOUS_RENDERER_ENTRIES) {
      expect(existsSync(join(root, entry)), entry).toBe(false);
    }
    for (const path of KEPT) {
      expect(readFileSync(join(root, path), "utf8"), path).toBe(`user's ${path}\n`);
    }
  });

  it("finishes an interrupted removal: the two documents are what it reads, and they go last", () => {
    const root = workspace();
    rmSync(join(root, "node_modules"), { recursive: true });

    expect(removePreviousRendererTree(root)).toEqual({
      kind: "removed",
      removed: ["package-lock.json", "package.json", PREVIOUS_WORKSPACE_MANIFEST],
    });
  });

  /**
   * The interruption the evidence-last order cannot recover from by reading the two documents:
   * `package.json` gone, the manifest still there. Nothing is left for `package.json` to vouch for,
   * so the manifest is removed on its own word and the run says so — before, it was `kept` on every
   * later run, for want of the file this module had itself removed.
   */
  it("finishes a removal interrupted between package.json and the manifest", () => {
    const root = workspace();
    for (const entry of ["node_modules", "package-lock.json", "package.json"]) {
      rmSync(join(root, entry), { recursive: true });
    }

    expect(removePreviousRendererTree(root)).toEqual({
      kind: "removed",
      removed: [PREVIOUS_WORKSPACE_MANIFEST],
    });
    expect(existsSync(join(root, PREVIOUS_WORKSPACE_MANIFEST))).toBe(false);
    for (const path of KEPT) {
      expect(readFileSync(join(root, path), "utf8"), path).toBe(`user's ${path}\n`);
    }
    // And a second run finds nothing to do.
    expect(removePreviousRendererTree(root)).toEqual({ kind: "absent" });
  });

  it("leaves a user's own project alone: no manifest, another name, other pins", () => {
    const root = workspace({
      packageJson: { name: "my-videos", dependencies: { react: "19.2.8" } },
      manifest: null,
    });
    const before = snapshot(root);

    expect(removePreviousRendererTree(root)).toEqual({ kind: "absent" });
    expect(snapshot(root)).toEqual(before);
  });

  it.each([
    ["no workspace manifest", { manifest: null }],
    [
      "a manifest that is not a workspace's",
      { manifest: { kind: "runtime", [PREVIOUS_ENTRY_FIELD]: ENTRY } },
    ],
    ["a manifest recording no previous-renderer entry", { manifest: { kind: "workspace" } }],
    ["a manifest that is not JSON", { manifest: null, garbage: true }],
  ] as const)("does nothing, and says nothing, for %s", (_label, options) => {
    const root = workspace({ manifest: options.manifest });
    if ("garbage" in options) {
      writeFileSync(join(root, PREVIOUS_WORKSPACE_MANIFEST), "{ not json");
    }
    const before = snapshot(root);

    expect(removePreviousRendererTree(root)).toEqual({ kind: "absent" });
    expect(snapshot(root)).toEqual(before);
  });

  it.each([
    ["no package.json", null, "missing"],
    ["another name", { ...LAST_TEMPLATE, name: "my-videos" }, "named"],
    [
      "one pin moved",
      { ...LAST_TEMPLATE, dependencies: { ...LAST_TEMPLATE.dependencies, react: "19.2.8" } },
      "dependencies",
    ],
    [
      "one pin more",
      { ...LAST_TEMPLATE, dependencies: { ...LAST_TEMPLATE.dependencies, lodash: "4.17.21" } },
      "dependencies",
    ],
    [
      "no devDependencies",
      { name: LAST_TEMPLATE.name, dependencies: LAST_TEMPLATE.dependencies },
      "devDependencies",
    ],
  ] as const)(
    "keeps everything when the manifest matches and package.json has %s",
    (_label, packageJson, said) => {
      const root = workspace({ packageJson });
      const before = snapshot(root);

      const outcome = removePreviousRendererTree(root);

      expect(outcome.kind).toBe("kept");
      expect(outcome.kind === "kept" ? outcome.reason : "").toContain(said);
      expect(snapshot(root)).toEqual(before);
    },
  );
});
