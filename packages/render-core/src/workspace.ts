/**
 * The shared Remotion workspace: one install, many videos (roadmap P1-1).
 *
 * The layout is the reference implementation's, and every path below is derived from it:
 *
 * ```
 * <root>/
 *   node_modules/          installed once, shared by every video
 *   package.json           the pinned Remotion versions, copied from this package's template/
 *   package-lock.json      the resolution `npm ci` reproduces them from
 *   remotion.config.ts     Tailwind, JPEG frames, overwrite
 *   tailwind.css
 *   tsconfig.json
 *   videos/<slug>/         the engine-owned shell and the agent's Scenes.tsx
 *   public/<slug>/         narration.wav, captions.json, timings.json and media/
 *   out/<slug>/            the rendered MP4 and the stills
 * ```
 *
 * **The split between `videos/` and `public/` is load-bearing.** `--public-dir` is what Remotion
 * serves `staticFile()` from, and `Root.tsx` fetches `timings.json` and `captions.json` through it
 * at metadata time. Point it at the video's source directory instead and the composition still
 * renders — silently, at `Root.tsx`'s `durationInFrames={300}` placeholder — so the two directories
 * are separate here and {@link videoPaths} is the only place that pairs them.
 *
 * **Nothing here installs anything.** {@link materialiseWorkspace} copies the template files and
 * creates three directories; it never runs a package manager. Installing hundreds of megabytes is a
 * visible step a user takes — `xplainer setup --workspace` — never something a tool call does
 * behind an agent's back, so {@link remotionBinary} answers `null` for a workspace that has never
 * been installed and {@link workspaceNotInstalledMessage} is the sentence a caller shows instead of
 * failing later with an `ENOENT` from `spawn`.
 *
 * **`package-lock.json` is one of the copied files, and that is what makes the install possible.**
 * `npm ci` is the command both ends of the pinned resolution run — build time for the staged
 * payload, `setup --workspace` on a user's machine — and `npm ci` in a directory with no lockfile
 * exits `EUSAGE` ("can only install packages when your package.json and package-lock.json ... are
 * in sync"). Copying `package.json` without the lockfile beside it therefore produces a workspace
 * that cannot be installed at all, which is why the two travel together here rather than being
 * placed by whoever happens to run the installer.
 *
 * This module writes directories and copies files. It spawns nothing and renders nothing:
 * `render/args.ts` builds the argv, and the caller spawns it.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
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
 * `package.json` pins Remotion, React and Tailwind; `package-lock.json` is the resolution `npm ci`
 * reproduces those pins from; `remotion.config.ts` enables Tailwind and JPEG frames; `tailwind.css`
 * is what a video's `index.ts` imports; `tsconfig.json` is for the editor. They are copied rather
 * than generated so the shipped template stays the only copy of these bytes.
 */
export const WORKSPACE_FILES = [
  "package.json",
  "package-lock.json",
  "remotion.config.ts",
  "tailwind.css",
  "tsconfig.json",
] as const;

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
  /** `<root>/public/<slug>` — Remotion's `--public-dir` for this video. */
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
 * Never overwriting matters more here than it looks: `package.json` is what a package manager
 * recorded `node_modules/` against, so rewriting it from the template on every `explainer_create`
 * would silently un-pin a workspace someone had already installed.
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

/**
 * The Remotion CLI this workspace resolves, or `null` when nothing has been installed.
 *
 * Walks the ancestors the way Node's own module resolution does, so a workspace installed in place
 * (`<root>/node_modules/.bin/remotion`) and one nested inside an already-installed tree both work.
 * `null` — rather than a guessed path — is what lets a caller say "run `xplainer setup --workspace`"
 * instead of failing later inside `spawn`.
 *
 * Deliberately not `npx`: `REMOTION_BIN` in `render/args.ts` records why, and resolving the local
 * binary is the half of that decision this function owns.
 */
export function remotionBinary(root: string): string | null {
  const name = process.platform === "win32" ? "remotion.cmd" : "remotion";
  let directory = root;
  for (;;) {
    const candidate = join(directory, "node_modules", ".bin", name);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

/** Whether {@link remotionBinary} can find a Remotion CLI for this workspace. */
export function isWorkspaceInstalled(root: string): boolean {
  return remotionBinary(root) !== null;
}

/**
 * The one sentence a caller shows for a workspace whose dependencies were never installed.
 *
 * It names `xplainer setup --workspace` and not `npm install`, because the machine this runs on is
 * not assumed to have a package manager at all: the CLI's own runtime payload carries the npm that
 * resolves this tree, and `setup` is the visible step that runs it. A message telling a user to run
 * `npm install` is a message they cannot follow on exactly the machine it is printed for.
 */
export function workspaceNotInstalledMessage(root: string): string {
  return (
    `the Remotion workspace at ${root} has no dependencies installed, so there is nothing to ` +
    "render with. Run `xplainer setup --workspace` once — it is a few hundred megabytes and " +
    "every video shares it — and try again."
  );
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
