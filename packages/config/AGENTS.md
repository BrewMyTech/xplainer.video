# AGENTS.md — `@xplainer/config`

Workspace rules and the post-change procedure: root [`AGENTS.md`](../../AGENTS.md).

## What this package is

The workspace's shared build furniture: the **tsconfig presets** every member extends, the **tier
boundary rule** as a pure function, and three **build binaries** the members call from their
scripts. It is `private: true` and stays that way — it is infrastructure for this repository, not a
product.

Every other member takes it as a `devDependency`. Those seven edges are excluded from
`docs/ARCHITECTURE.md`'s dependency table by rule, because "every member takes the tsconfig presets"
carries no architectural information.

## Public surface

- `./tsconfig/base.json`, `./tsconfig/node.json`, `./tsconfig/react.json` — the presets.
- `./tiers` — `checkTierGraph()`, `Tier`, `PackageNode`, `Violation`. A pure function over a
  declared graph: no filesystem, no process, no network.
- Three `bin` entries: `xplainer-check-tiers`, `xplainer-minify-dist`, `xplainer-sync-license`.

It emits declarations (it has a `tsconfig.build.json` and carries `isolatedDeclarations`) but, being
private, has **no published API report**.

## Commands

```bash
pnpm --filter @xplainer/config test
pnpm lint:tiers                    # runs bin/check-tiers.mjs over the real workspace
```

Then the root procedure: `pnpm verify`.

## Invariants

- **A change here is a workspace-wide change.** The presets are consumed by every member, so adding
  a compiler flag turns on a rule for eight packages at once. Measure the flag against all of them
  before adopting it, and record the rationale in
  [`docs/ARCHITECTURE.md` §8](../../docs/ARCHITECTURE.md#8-conventions) — that is where the
  per-flag argument lives.
- **`tsconfig/base.json` carries no comments.** `src/tsconfig-base.test.ts` reads it with
  `JSON.parse`, so a `//` comment throws and the test goes red — `tsc` itself accepts JSONC, and
  that test is the only thing in the repository that does not. It also asserts AC-15a's ten flags
  and AC-15d's absent one, so a flag quietly dropped from the shared preset fails `pnpm verify`
  rather than turning a rule off for eight packages in silence. This is why the rationale is in the
  architecture document and not in the file.
- **`private: true`, and it stays unpublished.** It is listed in `PRIVATE_MEMBERS` in
  `scripts/check-publish-contract.mjs`, and the checker fails in either direction if that changes.
- **`checkTierGraph()` stays pure.** `bin/check-tiers.mjs` is the layer that reads manifests and
  knows the full member set; the function judges only the graph it is handed. Keep the split — it is
  what makes the rule testable against hand-written graphs (`AC-3c`).
- **`check-tiers.mjs` must read all four dependency kinds** — `dependencies`, `devDependencies`,
  `peerDependencies`, `optionalDependencies` — so a forbidden edge cannot hide in a kind the checker
  never looks at. `docs/ARCHITECTURE.md` §4 documents the edges, but that is an equality check and
  does not prove the graph is *allowed*; narrowing `DEPENDENCY_FIELDS` reopens a hole nothing else
  covers.
- **`isolatedDeclarations` is on `tsconfig.build.json`**, so `TS9010` surfaces under
  `pnpm turbo build`, not under `typecheck` and not in your editor.

## How to add

**A compiler flag:** probe it one flag at a time across every TypeScript member
(`tsc -p <member>/tsconfig.json --noEmit <flag>`), record the error count, fix or reject, then add
it to `base.json` and its rationale to `docs/ARCHITECTURE.md` §8.

**A preset:** add the file, add it to `exports`, and say which members are expected to extend it.

**A bin script:** add it under `bin/`, register it in `bin`, and remember that root `scripts/` and
`bin/` are linted by the root `biome check .`, not by `turbo run lint`.

Finish with `pnpm verify`.
