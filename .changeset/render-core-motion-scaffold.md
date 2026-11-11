---
"@xplainer/render-core": minor
---

The scaffold is written against `@xplainer/motion`, and the previous renderer's CLI helpers are
gone.

Removed exports: `REMOTION_BIN`, `renderArgs`, `stillArgs`, `entryPoint`, `COMPOSITION_ID` and the
types `RenderArgsInput` and `StillArgsInput` — the argv builders for a CLI nothing spawns any more —
and, from the workspace layout, `remotionBinary`, `isWorkspaceInstalled` and
`workspaceNotInstalledMessage`. `DEFAULT_STILL_FRAME` and `DEFAULT_STILL_SCALE` are still exported,
from the workspace module rather than the deleted `render/args`.

`template/remotion.config.ts` is gone, so `WORKSPACE_FILES` is `package.json`, `package-lock.json`,
`tailwind.css` and `tsconfig.json`; a workspace materialised earlier keeps its copy, which nothing
reads. `template/package.json` and its lockfile are unchanged and still pin the previous renderer's
packages, because `xplainer setup --workspace` still installs that tree; no render reads it.

The engine-owned `index.ts`, `Root.tsx`, `Captions.tsx` and `Video.tsx` import from
`@xplainer/motion` and nothing else by package name, with their bodies unchanged except that
`Captions.tsx` pages through `paginateCaptions(sentence, { combineWithinMs })`. `scaffoldVideo()`
restores an engine-owned file whose bytes differ, so an existing video picks the new files up on
its next `explainer_create`, `explainer_still` or `explainer_render`. `types.ts` is the one file
still byte-identical to the reference implementation's scaffold.
