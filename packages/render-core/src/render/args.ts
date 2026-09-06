/**
 * Pure argument-vector builders for the Remotion CLI (plan §4 S2.2, deviation D-4).
 *
 * This module renders nothing. It spawns no process, touches no filesystem and
 * imports no Remotion package; it turns a slug and a pair of paths into the
 * exact argv the reference implementation shells out at
 * `explainer_mcp.py:416-419` (render) and `explainer_mcp.py:442-446` (still).
 * It exists in a scaffold-only phase because it pins the CLI contract that
 * roadmap phase 1 executes, and pinning it now costs one file.
 *
 * Two deliberate differences from the reference implementation's strings:
 *
 *   * An argv array, not a shell string. The reference implementation builds a
 *     command for a shell-backed job queue and therefore has to `shlex.quote`
 *     every path. Handing an argv straight to `spawn` removes the quoting
 *     question entirely, so a slug or an output path containing a space cannot
 *     become a second argument.
 *   * No `npx`. `npx remotion` resolves and downloads whatever version the
 *     registry serves at call time, which would drift the renderer away from
 *     the `remotion@4.0.495` pin in `template/package.json`. Phase 1 spawns the
 *     pinned local CLI; `REMOTION_BIN` names it and nothing else.
 */

/** The binary these argvs are for. Deliberately not `npx` — see the note above. */
export const REMOTION_BIN = "remotion";

/** The composition id every scaffolded video registers in `Root.tsx`. */
export const COMPOSITION_ID = "Explainer";

/** Default still frame, from `explainer_still`'s signature (`explainer_mcp.py:430`). */
export const DEFAULT_STILL_FRAME = 90;

/** Default still scale, from `explainer_still`'s signature (`explainer_mcp.py:430`). */
export const DEFAULT_STILL_SCALE = 0.5;

/** Where a video's entry point sits inside the Remotion workspace. */
export function entryPoint(slug: string): string {
  return `videos/${slug}/index.ts`;
}

export type RenderArgsInput = {
  /** Video slug; selects the entry point under `videos/`. */
  slug: string;
  /** Absolute or workspace-relative path of the `.mp4` to write. */
  output: string;
  /** Directory Remotion serves `staticFile()` from, i.e. `public/<slug>`. */
  publicDir: string;
};

export type StillArgsInput = RenderArgsInput & {
  /** Frame to capture; defaults to `DEFAULT_STILL_FRAME`. */
  frame?: number;
  /** Output scale; defaults to `DEFAULT_STILL_SCALE`. */
  scale?: number;
};

/**
 * argv for a full render, mirroring `explainer_mcp.py:416-419`:
 * `remotion render videos/<slug>/index.ts Explainer <output> --public-dir=<publicDir>`
 */
export function renderArgs({ slug, output, publicDir }: RenderArgsInput): string[] {
  return ["render", entryPoint(slug), COMPOSITION_ID, output, `--public-dir=${publicDir}`];
}

/**
 * argv for a single still, mirroring `explainer_mcp.py:442-446`:
 * `remotion still videos/<slug>/index.ts Explainer <output> --frame=<n> --scale=<n> --public-dir=<publicDir>`
 *
 * Flag order matches the reference implementation exactly, so a diff against it
 * stays readable.
 */
export function stillArgs({
  slug,
  output,
  publicDir,
  frame = DEFAULT_STILL_FRAME,
  scale = DEFAULT_STILL_SCALE,
}: StillArgsInput): string[] {
  return [
    "still",
    entryPoint(slug),
    COMPOSITION_ID,
    output,
    `--frame=${frame}`,
    `--scale=${scale}`,
    `--public-dir=${publicDir}`,
  ];
}
