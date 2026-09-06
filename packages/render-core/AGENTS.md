# AGENTS.md — `@xplainer/render-core`

Workspace rules and the post-change procedure: root [`AGENTS.md`](../../AGENTS.md).

## What this package is

Three things that travel together: the **Remotion workspace template** under `template/`, the
**ownership-aware scaffold generator** under `src/scaffold/`, and the **render preflight** that
refuses an unrenderable job before Chrome is launched.

File ownership is the idea the whole package is built around
([ADR 0018](../../docs/adr/0018-engine-owns-the-composition-shell.md)): the **engine** owns five
files — `index.ts`, `types.ts`, `Root.tsx`, `Captions.tsx`, `Video.tsx` — and the **agent** owns
one, `Scenes.tsx`.

## Public surface

From `src/index.ts`: `scaffoldVideo`, `readScaffoldTemplate`, `isEngineOwned`,
`ENGINE_OWNED_FILES`, `AGENT_OWNED_FILES`, `SCAFFOLD_FILES` and their types; `preflight`,
`assertRenderable`, `PreflightError` and the preflight problem types; and `renderArgs`, `stillArgs`,
`entryPoint`, `COMPOSITION_ID`, `REMOTION_BIN`, `DEFAULT_STILL_FRAME`, `DEFAULT_STILL_SCALE`. The
Remotion template itself is not a JavaScript export — it is files, reached through `./template/*`.

Published, emits declarations, carries `api/render-core.api.md`.

## Commands

```bash
pnpm --filter @xplainer/render-core test
pnpm turbo build --filter @xplainer/render-core   # also copies the templates
```

Then the root procedure: `pnpm verify`.

## Invariants

- **The five engine-owned scaffold files are byte-identity fixtures.** Editing a template without
  updating its golden in the same commit fails `AC-7b` (the four inherited wiring files, compared
  against the upstream reference extraction) or `AC-7e` (`Video.tsx` and `Scenes.tsx`, compared
  against xplainer's own goldens). The two sets are different in kind — provenance fixtures versus
  change detectors — and `test/fixtures/README.md` records why.
- **`Video.tsx` diverges from upstream deliberately** ([ADR 0018](../../docs/adr/0018-engine-owns-the-composition-shell.md)).
  Upstream's is agent-owned; ours is engine-owned, mounts the narration audio, the captions track
  and the per-segment sequences, and `explainer_put_source` **refuses to write it**. The upstream
  bytes are kept at `test/fixtures/scaffold/upstream/Video.tsx.max` so the difference stays a tested
  claim rather than a memory.
- **`scaffoldVideo()` never overwrites `Scenes.tsx`**, and restores any engine-owned file that is
  missing or whose bytes differ (`AC-7c`). A second call on the same directory reports all five
  engine names plus `Scenes.tsx` as skipped and changes nothing on disk.
- **`isolatedDeclarations` is on the *build* config**, so `pnpm turbo build` is what surfaces
  `TS9010` — not `typecheck`, and not your editor. `SCAFFOLD_FILES` carries a deliberately widened
  annotation (`readonly (EngineOwnedFile | AgentOwnedFile)[]`); the ordering comment describes the
  values, not the type.

## How to add

**A template file:** add it under `template/` or `src/scaffold/templates/`, decide its owner, add it
to `ENGINE_OWNED_FILES` (in `packages/protocol`'s schemas, which is where the list is generated
from) or to `AGENT_OWNED_FILES`, and add its golden fixture in the same commit.

**A preflight check:** add the code to the `PreflightCode` union, emit the problem from
`preflight()`, and test both the firing and the not-firing case.

Finish with `pnpm verify`.
