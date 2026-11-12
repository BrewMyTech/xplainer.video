/**
 * The workspace layout, asserted against a real temporary directory.
 *
 * Two of these are load-bearing rather than incidental. The `videos/` ↔ `public/` split is what
 * makes the renderer's public directory the narration's rather than the source's, and a template
 * file a user edited must survive the next `explainer_create` — so "never overwrite" is asserted
 * with real bytes on disk, not inferred from the code.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listVideoSlugs,
  materialiseWorkspace,
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
  it("copies every template file and creates the three directories", () => {
    const root = temporaryRoot();

    const result = materialiseWorkspace(root);

    expect(result.created).toEqual([...WORKSPACE_FILES]);
    expect(result.skipped).toEqual([]);
    expect(readFileSync(join(root, "tailwind.css"), "utf8")).toContain('@import "tailwindcss"');
    for (const directory of ["videos", "public", "out"]) {
      expect(existsSync(join(root, directory)), directory).toBe(true);
    }
    expect(listVideoSlugs(root)).toEqual([]);
  });

  /**
   * The workspace is sources and outputs: the renderer bundles against `@xplainer/cli`'s own
   * install, so nothing a package manager reads is placed here — not the `package.json` and
   * lockfile the previous renderer's install needed, and so nothing for `npm` to install against.
   */
  it("places nothing a package manager would install from", () => {
    const root = temporaryRoot();

    materialiseWorkspace(root);

    expect(WORKSPACE_FILES).toEqual(["tailwind.css", "tsconfig.json"]);
    for (const name of ["package.json", "package-lock.json", "node_modules"]) {
      expect(existsSync(join(root, name)), name).toBe(false);
    }
  });

  it("never overwrites a template file the user has edited", () => {
    const root = temporaryRoot();
    materialiseWorkspace(root);
    writeFileSync(join(root, "tailwind.css"), '@import "tailwindcss";\n/* mine */\n');

    const second = materialiseWorkspace(root);

    expect(second.created).toEqual([]);
    expect(second.skipped).toEqual([...WORKSPACE_FILES]);
    expect(readFileSync(join(root, "tailwind.css"), "utf8")).toBe(
      '@import "tailwindcss";\n/* mine */\n',
    );
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
