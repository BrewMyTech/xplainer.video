# AGENTS.md — `@xplainer/protocol`

Workspace rules and the post-change procedure: root [`AGENTS.md`](../../AGENTS.md). This file is
what is true here and nowhere else.

## What this package is

The **single source of truth for the tool contract**. `schemas/` holds hand-written JSON Schema;
`scripts/codegen.mjs` turns it into TypeScript types and a manifest, and into pydantic models and a
manifest for Python. Both languages come from the same files, which is the only reason the two
halves cannot drift. It is the sink of the dependency graph — it depends on no workspace package,
and four members depend on it — and it is the one **dual-language** member, so each of its four
scripts chains a Python half and one Turbo task exercises both (`AC-2e`).

## Public surface

`src/index.ts` is an explicit named-export list, deliberately not `export *`, so a grep for an
exported name lands on its declaration site and nothing is exported until it is added there:
`TOOL_NAMES`, `ENGINE_OWNED_FILES` and their types from `src/generated/manifest.ts`; the input and
output types for all eight tools plus `Captions`, `JobState` and the narration and timing shapes
from `src/generated/types.ts`; and the schemas themselves through the `./schemas/*` export. Python
consumers import `xplainer_protocol.generated`. Published, emits declarations, and carries
`api/protocol.api.md`.

## Commands

```bash
pnpm --filter @xplainer/protocol codegen        # regenerate both languages
pnpm --filter @xplainer/protocol codegen:check  # fail if regeneration would change anything
pnpm --filter @xplainer/protocol test           # vitest, then pytest
```

Then the root procedure: `pnpm verify`.

## Invariants

- **`schemas/**` is the only source of truth**, and **`schemas/manifest.json` is an *input* to
  codegen, not an output** — a data document listing the tools and their order, which is why
  `codegen.mjs`'s `schemaFiles()` excludes it from the schema sweep and reads it separately. That
  order is the contract order.
- **Never hand-edit `src/generated/` or `python/xplainer_protocol/generated/`.** The next codegen
  discards it.
- **A schema change and its codegen are one commit** (`AC-9c`, a CI step of its own at `AC-9d`).
  This holds only because codegen is deterministic — generators pinned exactly,
  `datamodel-code-generator` run with `--disable-timestamp` — so a change to `codegen.mjs` must keep
  that true.
- **The eight tool names are fixed** (`AC-9b`): `explainer_create`, `explainer_put_source`,
  `explainer_put_media`, `explainer_narrate`, `explainer_still`, `explainer_render`,
  `explainer_job`, `explainer_list`.
- **Adding an `error_code` enum member is an OPEN question, not a settled minor bump.** Whether it
  is minor or breaking, and whether any consumer can tolerate an unknown value, are spike
  **P1-S3(c)** and **P1-S3(d)**; the analysis is in
  [ADR 0024](../../docs/adr/0024-durable-jobs-and-boot-reconciliation.md). Measured, the generated
  Python `StrEnum` makes pydantic **reject** an unknown member, so write no code and no prose that
  assumes tolerance.
- **`isolatedDeclarations` is on `tsconfig.build.json`**, so `TS9010` surfaces under
  `pnpm turbo build`, not under `typecheck` and not in your editor. Two of its annotations live in
  generated output, so that fix belongs in `scripts/codegen.mjs` and must stay byte-deterministic.

## How to add

**A field:** edit the schema, run `codegen`, commit the generated output in the same commit. A new
required field is a breaking contract change; a new optional one is not. If it changes an exported
declaration, run `pnpm api:report` and commit the `.api.md` too.

**A tool:** add `schemas/tools/<name>.{input,output}.json`, add the entry to `schemas/manifest.json`,
run `codegen`, export the generated input and output types from `src/index.ts`, then update
`packages/skill/SKILL.md` — its `explainer_*` names are asserted against `TOOL_NAMES`. Nothing is
*registered* by hand — `createMcpServer()` iterates `TOOL_NAMES` — but `RenderBackend` and
`createStubBackend()` are hand-written lists and have to grow a method each. Finish with
`pnpm api:report`: `api/protocol.api.md` pins `TOOL_NAMES` as a literal tuple, so codegen alone
leaves `check:api-report` red. A ninth tool changes `AC-9b`, which is a deliberate act.
[`docs/ARCHITECTURE.md` §9](../../docs/ARCHITECTURE.md#9-how-to-add-x) carries the full ten-step form.

**An export:** add it to `src/index.ts` explicitly, run `pnpm api:report`, commit the `.api.md`.

Finish with `pnpm verify`.
