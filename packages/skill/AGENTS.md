# AGENTS.md — `@xplainer/skill`

Workspace rules and the post-change procedure: root [`AGENTS.md`](../../AGENTS.md).

## What this package is

The **agent skill**, plus the two plugin bundles that ship it: a Claude Code bundle and a Codex
bundle ([ADR 0013](../../docs/adr/0013-plugin-packaging-for-claude-and-codex.md)). `SKILL.md` is the
instructions an agent reads before driving the tools; `scripts/build.mjs` assembles both bundles
into `dist/`, and `schemas/` holds the two JSON Schemas the manifests are validated against.

## Public surface

**Not a TypeScript surface.** The package ships `SKILL.md` and `dist/`, built by
`node scripts/build.mjs`. It is **published but emits no TypeScript declarations**, so it has no
`api/` report and `isolatedDeclarations` does not apply to it. It contains exactly one `.ts` file
and that file is a test.

Consumers install the bundle; nothing imports this package.

## Commands

```bash
pnpm --filter @xplainer/skill build   # writes dist/claude-plugin and dist/codex-plugin
pnpm --filter @xplainer/skill test    # Ajv-validates both manifests, checks the tool names
```

Then the root procedure: `pnpm verify`.

## Invariants

- **`SKILL.md`'s `explainer_*` names must equal `TOOL_NAMES` exactly.** Asserted in
  `src/build.test.ts` against `@xplainer/protocol`. Adding a tool to the contract without adding it
  here fails the test; naming one here that the contract does not have fails it too.
- **Both plugin bundles declare a local stdio server and no `oauth_resource`** (`AC-10b′`). A
  loopback daemon has no authorization server, so an `oauth_resource` key would describe something
  that does not exist. The original `AC-10b`, which pointed both bundles at a hosted URL, judges the
  bundles in the private hosted repository — not these.
- **The build writes the exact file set `AC-10a` names**, in both bundles:
  `.claude-plugin/{plugin.json,marketplace.json}` and `.codex-plugin/plugin.json`, `.mcp.json`, and
  `skills/xplainer/SKILL.md`.
- **This package takes `@xplainer/protocol` as a `devDependency`, not a dependency.** It uses it to
  assert the tool names at build and test time; the shipped bundle contains no JavaScript.
- **It is published**, so a user-visible change to `SKILL.md` or a bundle needs a changeset.

## How to add

**A tool to the skill:** add it to `packages/protocol` first, then document it in `SKILL.md`. The
test asserts the relation, so the order is not optional.

**A key to a plugin manifest:** update the matching schema under `schemas/`, then the manifest, then
the assertion in `src/build.test.ts`. A manifest key nothing validates is a key that will be wrong.

Finish with `pnpm verify`.
