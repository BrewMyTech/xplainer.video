/**
 * The video scaffold generator (plan §4 S2.2; acceptance criteria AC-7b..AC-7e).
 *
 * Writes six files into one video source directory, split by ownership:
 *
 *   * five ENGINE-OWNED files — the wiring plus the composition shell that
 *     mounts the narration audio, the caption track and the per-segment
 *     sequencing. `explainer_put_source` refuses to write these, and this
 *     generator restores one that is missing *or* whose bytes have drifted
 *     from the template. Engine files are derived output, not user state.
 *   * one AGENT-OWNED file — `Scenes.tsx`, the entry point for everything the
 *     agent designs. This one keeps the reference implementation's
 *     never-overwrite rule, so the agent's work always survives a re-`create`.
 *
 * Four of the five engine files (`index.ts`, `types.ts`, `Root.tsx`,
 * `Captions.tsx`) are byte-identical ports of `explainer_mcp.py:254-260` in the
 * reference implementation. `Video.tsx` deliberately diverges (ADR 0018):
 * there it was an agent-owned "REPLACE THIS" stub that also mounted `<Audio>`
 * and `<Captions>`, so an agent rewriting it for a purely visual reason
 * dropped the soundtrack and shipped a silent video that rendered without
 * error. `test/fixtures/scaffold/upstream/Video.tsx.max` keeps the original
 * bytes and `scaffold.test.ts` proves the divergence is the intended one.
 *
 * Two load-bearing properties survive from the reference implementation:
 *
 *   1. The bytes written are the template bytes, verbatim. The templates live
 *      beside this file as `.txt` so neither Biome nor `tsc` reformats them or
 *      tries to resolve the `remotion`, `@remotion/captions`, `@remotion/media`
 *      and `../../tailwind.css` specifiers they contain, none of which are
 *      dependencies of this package. They are read as `Buffer` and written as
 *      `Buffer`, so no encoding or newline pass can touch them.
 *   2. The agent's own file is never overwritten. A slug can be re-scaffolded
 *      at any time, which is why `explainer_create` stays safe to re-run. Only
 *      the narrower claim changed: engine files are now rewritten, and are
 *      reported separately in `restored` so a caller can say so.
 *
 * `index.ts` imports `"../../tailwind.css"`, which fixes the workspace layout
 * as `<workspace>/videos/<slug>/index.ts` with `tailwind.css` at the workspace
 * root. `template/` in this package is that workspace root.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_OWNED_FILES as ENGINE_OWNED_FILES_FROM_PROTOCOL } from "@xplainer/protocol";

/**
 * The five files the engine owns, in the order `_SCAFFOLD` declares them in
 * `explainer_mcp.py:254-260`. The order is part of the contract: `created`,
 * `skipped` and `restored` are reported in it.
 *
 * This list is the reserved set `explainer_put_source` rejects, matched as
 * exact relative paths — a nested `scenes/Root.tsx` is the agent's and stays
 * writable.
 *
 * Re-exported, never restated. `packages/protocol/schemas/manifest.json`
 * carries `engine_owned_files` as the authoritative copy and codegen emits it
 * for TypeScript and Python alike, so the schema that makes
 * `explainer_put_source` refuse a path, the guard that enforces it, and the
 * generator that restores the file cannot drift apart into three lists that
 * merely used to agree.
 */
export const ENGINE_OWNED_FILES: typeof ENGINE_OWNED_FILES_FROM_PROTOCOL =
  ENGINE_OWNED_FILES_FROM_PROTOCOL;

/**
 * The files the agent owns, appended after the engine's so the first five keep
 * the positions the reference implementation reports them in.
 *
 * `Scenes.tsx` is scaffolded once as an empty `SceneMap` and never again. The
 * map is empty on purpose: a stub carrying an example key would name a segment
 * no real narration contains and trip `Video.tsx`'s unknown-id guard on the
 * first render. Empty means every segment draws the visible `MissingScene`
 * placeholder — obviously unfinished, never silently wrong.
 */
export const AGENT_OWNED_FILES = ["Scenes.tsx"] as const;

/**
 * Every file one `scaffoldVideo()` call is responsible for.
 *
 * The engine's five come first and `Scenes.tsx` last, and `created`, `skipped`
 * and `restored` are reported in that order. `isolatedDeclarations` cannot infer
 * a type through the spreads, so the type is written out as an array rather than
 * a six-element tuple: the ordering above is a guarantee about these values, not
 * about the type, and no consumer indexes the list by position.
 */
export const SCAFFOLD_FILES: readonly (EngineOwnedFile | AgentOwnedFile)[] = [
  ...ENGINE_OWNED_FILES,
  ...AGENT_OWNED_FILES,
];

export type EngineOwnedFile = (typeof ENGINE_OWNED_FILES)[number];
export type AgentOwnedFile = (typeof AGENT_OWNED_FILES)[number];
export type ScaffoldFile = (typeof SCAFFOLD_FILES)[number];

const ENGINE_OWNED: ReadonlySet<string> = new Set<string>(ENGINE_OWNED_FILES);

/** Whether `name` is one of the five paths the agent may not write. */
export function isEngineOwned(name: string): name is EngineOwnedFile {
  return ENGINE_OWNED.has(name);
}

/** What one `scaffoldVideo()` call did, mirroring `created` / `already_present`. */
export type ScaffoldResult = {
  /** Files this call wrote for the first time, in `SCAFFOLD_FILES` order. */
  created: ScaffoldFile[];
  /** Files that already existed and were left exactly as they were. */
  skipped: ScaffoldFile[];
  /**
   * Engine-owned files that existed with different bytes and were rewritten
   * from the template. Never contains an agent-owned file.
   *
   * This is the one place the reference implementation's "never overwrites"
   * promise is deliberately narrowed. It closes the `write_source_to` hole: on
   * a local backend the agent writes files with its own tools, where no MCP
   * guard can see it, so restoring the shell on the next `create` or render is
   * the only thing standing between a hand-edited `Video.tsx` and a silent MP4.
   */
  restored: ScaffoldFile[];
};

/**
 * `dist/scaffold/templates/` after a build, `src/scaffold/templates/` under
 * Vitest. `scripts/copy-templates.mjs` runs as the second half of `build` so
 * both resolve to a real directory; the build fails loudly if it does not.
 */
const TEMPLATE_DIR = fileURLToPath(new URL("./templates/", import.meta.url));

/**
 * The verbatim bytes of one scaffold template.
 *
 * Returns a `Buffer` rather than a string on purpose: the byte-identity
 * assertion in `scaffold.test.ts` compares with `Buffer.compare`, and a string
 * round-trip is exactly the kind of silent normalisation that would make that
 * assertion pass over content that had been altered. `preflight()` compares
 * against these same bytes for the same reason.
 */
export function readScaffoldTemplate(name: ScaffoldFile): Buffer {
  return readFileSync(join(TEMPLATE_DIR, `${name}.txt`));
}

/**
 * Scaffold the six files into `dir`, creating it if needed.
 *
 * Ownership decides what happens to a file that is already there:
 *
 *   * agent-owned — left untouched and reported in `skipped`, always
 *     (`explainer_mcp.py:324-331`);
 *   * engine-owned — compared against the template; identical bytes are
 *     `skipped`, different bytes are rewritten and reported in `restored`.
 */
export function scaffoldVideo(dir: string): ScaffoldResult {
  mkdirSync(dir, { recursive: true });

  const created: ScaffoldFile[] = [];
  const skipped: ScaffoldFile[] = [];
  const restored: ScaffoldFile[] = [];

  for (const name of SCAFFOLD_FILES) {
    const target = join(dir, name);
    const template = readScaffoldTemplate(name);

    if (!existsSync(target)) {
      writeFileSync(target, template);
      created.push(name);
      continue;
    }

    if (!isEngineOwned(name) || Buffer.compare(readFileSync(target), template) === 0) {
      skipped.push(name);
      continue;
    }

    writeFileSync(target, template);
    restored.push(name);
  }

  return { created, skipped, restored };
}
