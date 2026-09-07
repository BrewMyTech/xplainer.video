/**
 * The workspace layout, asserted against a real temporary directory.
 *
 * Two of these are load-bearing rather than incidental. The `videos/` ↔ `public/` split is what
 * makes `--public-dir` point at the narration rather than at the source, and a workspace whose
 * `package.json` was rewritten from the template would be a workspace whose `node_modules/` no
 * longer matches its manifest — so "never overwrite" is asserted with real bytes on disk, not
 * inferred from the code.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
  isWorkspaceInstalled,
  listVideoSlugs,
  materialiseWorkspace,
  remotionBinary,
  stillOutput,
  videoPaths,
  WORKSPACE_FILES,
} from "./workspace.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "xplainer-workspace-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("videoPaths", () => {
  it("keeps the source directory and the public directory apart", () => {
    const paths = videoPaths("/w", "demo");

    expect(paths.source).toBe(join("/w", "videos", "demo"));
    expect(paths.publicDir).toBe(join("/w", "public", "demo"));
    expect(paths.publicDir).not.toBe(paths.source);
  });

  it("puts narration, captions, timings and media inside the public directory", () => {
    const paths = videoPaths("/w", "demo");

    for (const path of [paths.timings, paths.captions, paths.audio, paths.narrationSpec]) {
      expect(path.startsWith(`${paths.publicDir}/`)).toBe(true);
    }
    expect(paths.media).toBe(join(paths.publicDir, "media"));
  });

  it("names the MP4 and the stills under out/<slug>", () => {
    const paths = videoPaths("/w", "demo");

    expect(paths.mp4).toBe(join("/w", "out", "demo", "explainer.mp4"));
    expect(stillOutput(paths, 90)).toBe(join("/w", "out", "demo", "frame-90.png"));
  });
});

describe("materialiseWorkspace", () => {
  it("copies the four template files and creates the three directories", () => {
    const root = temporaryRoot();

    const result = materialiseWorkspace(root);

    expect(result.created).toEqual([...WORKSPACE_FILES]);
    expect(result.skipped).toEqual([]);
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies.remotion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(listVideoSlugs(root)).toEqual([]);
  });

  it("never overwrites a package.json a package manager has already installed against", () => {
    const root = temporaryRoot();
    materialiseWorkspace(root);
    writeFileSync(join(root, "package.json"), '{"name":"installed"}\n');

    const second = materialiseWorkspace(root);

    expect(second.created).toEqual([]);
    expect(second.skipped).toEqual([...WORKSPACE_FILES]);
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe('{"name":"installed"}\n');
  });
});

describe("remotionBinary", () => {
  it("answers null for a workspace nothing has been installed into", () => {
    const root = temporaryRoot();
    materialiseWorkspace(root);

    expect(remotionBinary(root)).toBeNull();
    expect(isWorkspaceInstalled(root)).toBe(false);
  });

  it("finds the CLI an install put in the workspace's own node_modules", () => {
    const root = temporaryRoot();
    materialiseWorkspace(root);
    const bin = join(root, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    const name = process.platform === "win32" ? "remotion.cmd" : "remotion";
    writeFileSync(join(bin, name), "#!/bin/sh\n");

    expect(remotionBinary(root)).toBe(join(bin, name));
    expect(isWorkspaceInstalled(root)).toBe(true);
  });
});

describe("listVideoSlugs", () => {
  it("reports every directory under videos/, sorted, and ignores files", () => {
    const root = temporaryRoot();
    materialiseWorkspace(root);
    mkdirSync(join(root, "videos", "zeta"), { recursive: true });
    mkdirSync(join(root, "videos", "alpha"), { recursive: true });
    writeFileSync(join(root, "videos", "notes.txt"), "");

    expect(listVideoSlugs(root)).toEqual(["alpha", "zeta"]);
  });
});
