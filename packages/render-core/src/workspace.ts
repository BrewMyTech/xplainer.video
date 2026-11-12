/**
 * The shared workspace: one directory, many videos (roadmap P1-1).
 *
 * The layout is the reference implementation's, and every path below is derived from it:
 *
 * ```
 * <root>/
 *   tailwind.css           the stylesheet a video's `index.ts` imports, copied from template/
 *   tsconfig.json          for an editor, copied from template/
 *   videos/<slug>/         the engine-owned shell and the agent's Scenes.tsx
 *   public/<slug>/         narration.wav, captions.json, timings.json and media/
 *   out/<slug>/            the rendered MP4 and the stills
 * ```
 *
 * **It is sources and outputs, and nothing installed.** The renderer is `@xplainer/cli`'s, and it
 * bundles every video against its own React and `@xplainer/motion`, so the workspace carries no
 * `package.json`, no lockfile and no `node_modules/`. The template's `package.json` and
 * `package-lock.json` pinned the previous renderer's tree for `xplainer setup --workspace` to
 * install, and left with it (ADR 0031 §Note, 2026-11-12, D7).
 *
 * **The split between `videos/` and `public/` is load-bearing.** `public/<slug>` is what the
 * renderer serves `staticFile()` from, and `Root.tsx` fetches `timings.json` and `captions.json`
 * through it at metadata time. Point it at the video's source directory instead and the
 * composition finds neither document, so the two directories are separate here and
 * {@link videoPaths} is the only place that pairs them.
 *
 * **Nothing here installs anything.** {@link materialiseWorkspace} copies the template files and
 * creates three directories; it never runs a package manager.
 *
 * This module writes directories and copies files. It spawns nothing and renders nothing: the
 * renderer is `@xplainer/cli`'s.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPTIONS_FILE, NARRATION_AUDIO_FILE, TIMINGS_FILE } from "./narrate/pacing.js";

/** Where one video's source lives, under the workspace root. */
export const VIDEOS_DIR = "videos";

/** Where one video's `staticFile()` assets live — narration, captions, timings and media. */
export const PUBLIC_DIR = "public";

/** Where renders and stills land. */
export const OUT_DIR = "out";

/** The media subdirectory of a video's public directory, which `explainer_put_media` writes into. */
export const MEDIA_DIR = "media";

/** Default still frame, from `explainer_still`'s signature in the reference implementation. */
export const DEFAULT_STILL_FRAME = 90;

/** Default still scale, from `explainer_still`'s signature in the reference implementation. */
export const DEFAULT_STILL_SCALE = 0.5;

/** The MP4 `explainer_render` writes, from the reference implementation's own output name. */
export const RENDERED_FILE = "explainer.mp4";

/**
 * The narration spec `explainer_narrate` records for its worker.
 *
 * The worker is a separate process, so the spec it is about to speak has to reach it as a file.
 * It lives in the video's public directory beside the three documents narration produces, which is
 * also what lets a failed run be inspected after the fact.
 */
export const NARRATION_SPEC_FILE = "narration.json";

/**
 * The workspace files copied verbatim out of this package's `template/`.
 *
 * `tailwind.css` is what a video's `index.ts` imports and what the renderer builds its stylesheet
 * from; `tsconfig.json` is for the editor. They are copied rather than generated so the shipped
 * template stays the only copy of these bytes.
 */
export const WORKSPACE_FILES = ["tailwind.css", "tsconfig.json"] as const;

/** One of the workspace-level template files. */
export type WorkspaceFile = (typeof WORKSPACE_FILES)[number];

/**
 * `dist/` after a build and `src/` under Vitest; `template/` sits beside both at the package root,
 * and `package.json`'s `files` allowlist is what ships it.
 */
const TEMPLATE_DIR = fileURLToPath(new URL("../template/", import.meta.url));

/** Every path one video owns, all derived from the workspace root and the slug. */
export type VideoPaths = {
  /** The video's slug. */
  slug: string;
  /** `<root>/videos/<slug>` — the source directory, where the scaffold writes. */
  source: string;
  /** `<root>/public/<slug>` — the directory the renderer serves `staticFile()` from. */
  publicDir: string;
  /** `<root>/public/<slug>/media` — where `explainer_put_media` writes. */
  media: string;
  /** `<root>/public/<slug>/timings.json` — the one source of every scene duration. */
  timings: string;
  /** `<root>/public/<slug>/captions.json`. */
  captions: string;
  /** `<root>/public/<slug>/narration.wav`. */
  audio: string;
  /** `<root>/public/<slug>/narration.json` — the spec the narrate worker reads. */
  narrationSpec: string;
  /** `<root>/out/<slug>` — where renders and stills land. */
  out: string;
  /** `<root>/out/<slug>/explainer.mp4`. */
  mp4: string;
};

/** What one {@link materialiseWorkspace} call did to the workspace root. */
export type WorkspaceResult = {
  /** Template files this call wrote, in {@link WORKSPACE_FILES} order. */
  created: WorkspaceFile[];
  /** Template files that were already there and were left exactly as they were. */
  skipped: WorkspaceFile[];
};

/** Expand a workspace root and a slug into every path that video owns. */
export function videoPaths(root: string, slug: string): VideoPaths {
  const publicDir = join(root, PUBLIC_DIR, slug);
  const out = join(root, OUT_DIR, slug);
  return {
    slug,
    source: join(root, VIDEOS_DIR, slug),
    publicDir,
    media: join(publicDir, MEDIA_DIR),
    timings: join(publicDir, TIMINGS_FILE),
    captions: join(publicDir, CAPTIONS_FILE),
    audio: join(publicDir, NARRATION_AUDIO_FILE),
    narrationSpec: join(publicDir, NARRATION_SPEC_FILE),
    out,
    mp4: join(out, RENDERED_FILE),
  };
}

/** The PNG one still renders to, named after the frame it captured. */
export function stillOutput(paths: VideoPaths, frame: number): string {
  return join(paths.out, `frame-${frame}.png`);
}

/**
 * Create the workspace root and copy the template files in, never overwriting one.
 *
 * Never overwriting is what lets a user edit `tailwind.css` or `tsconfig.json` once and keep the
 * edit: `explainer_create` calls this for every video.
 */
export function materialiseWorkspace(root: string): WorkspaceResult {
  mkdirSync(root, { recursive: true });
  for (const directory of [VIDEOS_DIR, PUBLIC_DIR, OUT_DIR]) {
    mkdirSync(join(root, directory), { recursive: true });
  }

  const created: WorkspaceFile[] = [];
  const skipped: WorkspaceFile[] = [];
  for (const name of WORKSPACE_FILES) {
    const target = join(root, name);
    if (existsSync(target)) {
      skipped.push(name);
      continue;
    }
    copyFileSync(join(TEMPLATE_DIR, name), target);
    created.push(name);
  }
  return { created, skipped };
}

/** Every slug with a source directory under `<root>/videos`, in sorted order. */
export function listVideoSlugs(root: string): string[] {
  const videos = join(root, VIDEOS_DIR);
  if (!existsSync(videos)) {
    return [];
  }
  return readdirSync(videos, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}
