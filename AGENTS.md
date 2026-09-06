# AGENTS.md — xplainer.video

Instructions for an agent working anywhere in this repository. Everything here is either
**enforced by a command that exits non-zero** or explicitly labelled a convention. An unenforced
rule is a suggestion, so the label matters.

Layout, dependency direction and the recipes for adding things are in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). This file is the invariants and the procedure.

## Bootstrap

Two commands, both idempotent, one per language:

```bash
corepack enable && pnpm install --frozen-lockfile   # AC-1a
uv sync --all-packages --frozen                     # AC-1b
```

Node and Python versions are pinned in `.node-version` and `.python-version` and are read by CI, so
do not install a different one. `engineStrict` makes the Node 24 pin a hard failure.

## The canonical post-change procedure

**After changing anything, run one command:**

```bash
pnpm verify
```

That is the whole procedure. It chains every gate, in this order:

```
turbo build lint typecheck test
  -> biome check .
  -> check:no-suppressions
  -> lint:tiers
  -> check:publish-contract
  -> check:codegen-fresh
  -> check:api-report
  -> check:docs-contract
```

**The order is not arbitrary.** `turbo build` comes first because it is the only thing that surfaces
`isolatedDeclarations` errors, and because `check:api-report` reads `dist/`. The root
`biome check .` comes next because it covers the `scripts/` and config files that `turbo run lint`
never reaches. The cheap greps follow, so a stray suppression fails fast. `check:docs-contract`
needs no build and is last only so that a failure in a cheaper gate reports first.

One thing `verify` deliberately does **not** cover: per-member task coverage (`AC-2b`, `AC-2f`,
`AC-2g`). It asserts a property of the workspace roster that a local run cannot make false, so it
stays a CI-only check.

One gate is spelled differently in the two places it runs, on purpose. `check:codegen-fresh` calls
`pnpm --filter @xplainer/protocol codegen:check`, which regenerates into memory and names any file
whose contents differ from what is on disk. CI asserts the same property with `codegen` followed by
`git diff --exit-code`, which is the literal command `AC-9c` names and is correct there because the
checkout is pristine. Locally it is not: `git diff` reads the index, so the CI form fails on
regenerated output that is merely unstaged — a red gate on correct work, with no message but a raw
diff. `codegen:check` does not consult git at all, so it says the same thing whatever your index
looks like.

`pnpm check` is a **different**, narrower command — `turbo build lint typecheck test` and nothing
else. It is the fast inner loop, and `README.md` §Getting started documents that same turbo
invocation as the one-command check. Leave it as it is: it is not the post-change procedure, and
widening it silently would make that section of the README wrong.

**This section is the single copy.** Every member's `AGENTS.md`, every recipe in
`docs/ARCHITECTURE.md` §9 and every repository skill points here rather than restating the list. If
you find a second copy of it anywhere, delete the copy.

The one repository skill, `.claude/skills/update-docs/`, is a **convenience wrapper for this
section and is advisory** — it sequences the edits that make `pnpm verify` pass and names the diffs
worth reading, nothing more. Codex never reads `.claude/skills/`, and CI runs `pnpm verify` whether
or not anyone invoked the skill, so invoking it is never evidence and skipping it is never a
failure.

Narrower commands are for iterating, not for finishing:

```bash
pnpm turbo build --filter @xplainer/<member>
pnpm --filter @xplainer/<member> test
pnpm biome check .            # the root scripts/ and config files
```

## The four-scripts rule

Every TypeScript member declares **exactly four** scripts: `build`, `lint` (`biome check .`),
`typecheck` (`tsc --noEmit`) and `test` (`vitest run`). A member may add more — `dev`, `package`,
`codegen` — but never at the cost of one of the four. `services/tts-sidecar` is the sole exception:
it is Python-only, so it declares `lint`, `typecheck` and `test` as `uv run --no-sync --project .`
wrappers and deliberately no `build`.

**Why this is a rule and not a habit.** Turbo invokes only the script whose name matches the task
and **silently skips** a member that does not declare it — no warning, no non-zero exit. A member
missing a `lint` script is therefore indistinguishable from a member that lints cleanly, and
`pnpm turbo build lint typecheck test` stays green over code nothing checked. `AC-2b`, `AC-2f` and
`AC-2g` count the tasks per member in CI, and that count is the only thing standing between you and
a silently unchecked member.

`packages/protocol` is the one dual-language member: each of its four scripts chains its Python half
(`lint` → `lint:py`, and so on), so one Turbo task exercises both languages (`AC-2e`).

## The members

Nine of them. The table — path, package name, tier, published or not, whether it emits declarations,
whether it has an API report, and what it is responsible for — is
[`docs/ARCHITECTURE.md` §3 Members](docs/ARCHITECTURE.md#3-members), and it is machine-checked
against the workspace. There is no second copy here on purpose: a hand-maintained duplicate is a
table that goes stale.

## Non-negotiables

Each one, and the thing that catches you:

- **Accepted ADRs are immutable.** Correct a record by adding a dated note to it, or supersede it
  with a new number that says exactly which sentence it amends. Never edit what an accepted record
  said. *Enforcement: review. `check:docs-contract` does not read ADR bodies — this one is on you.*
- **A `schemas/**` change needs its codegen in the same commit.** Run
  `pnpm --filter @xplainer/protocol codegen` and commit the regenerated TypeScript and Python.
  *Enforcement: `AC-9c` — codegen then `git diff --exit-code` — as its own CI step (`AC-9d`), and
  `check:codegen-fresh` in `pnpm verify` locally.*
- **Never hand-edit anything under `generated/`.** It is overwritten on the next codegen.
  *Enforcement: the same diff.*
- **A user-visible change to a published package needs a changeset.** `pnpm changeset`.
  *Enforcement: review. There is no release workflow in this repository yet — `.github/workflows/`
  holds `ci.yml` and `desktop.yml`, and neither reads `.changeset/` — so this is a convention until
  one exists. Treat it as binding anyway: the changeset is the changelog entry, and it is written
  while the reason for the change is still in front of you.*
- **No `TODO`, `FIXME`, `.skip(` or `.only(` in committed source.** Not in a comment, not "just for
  now". *Enforcement: `AC-2c`, a CI grep over `apps/`, `packages/` and `services/` on a pristine
  tree.*
- **No type or lint suppressions, in either language.** No `as any`, no `@ts-ignore`, no
  `@ts-expect-error`, no `biome-ignore`; and on the Python side no `# noqa` — including the
  file-level `# ruff: noqa` and `# flake8: noqa` — no `# type: ignore` and no `# pyright: ignore`,
  reached for to satisfy a gate. If a gate is wrong, change the gate deliberately.
  *Enforcement: `pnpm check:no-suppressions` (`AC-15e`), early in CI.*
- **`apps/desktop` contains no render or TTS code, ever.** *Enforcement: `AC-14f`, a grep for
  `@remotion/`, `remotion`, `kokoro`, `captioned_speech` and `tts` across `apps/desktop` —
  `apps/desktop/src`, its root `*.ts` files and its `package.json` — as its own CI step beside
  AC-2c's.*
- **After changing any `export` in a built package, run `pnpm api:report` and commit the result.**
  The `.api.md` diff is the review. *Enforcement: `pnpm check:api-report`.*
- **`isolatedDeclarations` errors only appear under `build`.** It is set on the
  `tsconfig.build.json` files, and both `tsc --noEmit` and your editor read `tsconfig.json`. A clean
  editor means nothing here; `pnpm verify` builds first for this reason.
- **The tier boundary holds in both directions.** An `open-later` package may never depend on a
  `hosted` one. *Enforcement: `pnpm lint:tiers` over the declared dependency graph, plus
  `biome.json`'s `noRestrictedImports` at the import site (`AC-3b`, `AC-3e`).*
- **Every `uv run` carries `--no-sync`.** Every one, root-scoped included. A bare `uv run` re-syncs
  the shared environment down to one member's closure and prunes the other out of it. The argument
  is in `pyproject.toml`; do not rediscover it. *Enforcement: the next Python task fails.*

## Root-owned paths, and who checks them

These are not inside any member, so `turbo run lint` never reaches them. A change here is a
workspace-wide change.

| Path | What it is | What checks it |
|---|---|---|
| `scripts/` | The bespoke gates (`check-publish-contract.mjs`, `api-report.mjs`, `check-docs-contract.mjs`), and `e2e/macos.mjs`, which is a **proof** rather than a gate: `pnpm e2e:macos` needs Docker and several minutes of Chrome, so it is deliberately outside `pnpm verify` | Root `pnpm biome check .`, in CI and in the lefthook pre-commit job. Not `turbo run lint`. |
| `.github/workflows/` | CI and the desktop packaging workflow | `actionlint` (`AC-4a`) |
| `docs/` | ADRs (immutable), `ARCHITECTURE.md`, `ROADMAP.md`, `acceptance-criteria.md` | `pnpm check:docs-contract` for `ARCHITECTURE.md`'s two `CHECKED` blocks and the `AGENTS.md`/`CLAUDE.md` set; review for everything else |
| `biome.json`, `ruff.toml` | Lint configuration for both languages | Changing either changes every member's `lint` |
| `pnpm-workspace.yaml` | Member globs, the version catalog, and the install settings | `pnpm install --frozen-lockfile`; the normative script rule is written in its comments |
| `packages/config/tsconfig/` | The presets every member extends | Every member's `typecheck` and `build` |
| `turbo.json`, `lefthook.yml`, `.npmrc`, `pyproject.toml`, `uv.lock` | Task graph, git hooks, install settings, Python workspace | `pnpm verify` |

## Before editing a member, read that member's `AGENTS.md`

Each of the nine has one, with the same five headings: `## What this package is`,
`## Public surface`, `## Commands`, `## Invariants`, `## How to add`. The invariants there are
specific and are not repeated at the root.

**This is a convention, not a mechanism.** Neither Claude Code nor Codex loads nested instruction
files automatically in every configuration: Codex walks `AGENTS.md` hierarchically and never reads
`CLAUDE.md`; Claude Code reads `CLAUDE.md` from directories it works in and never reads
`AGENTS.md`. That is why each member also carries a one-line `CLAUDE.md` importing its `AGENTS.md`.
The nine member files are deliberately **not** imported from the root — importing them would load
all nine every session and destroy the locality that makes them useful.

## What belongs where

| Kind of thing | Home |
|---|---|
| An invariant, or a recipe for editing this directory | `AGENTS.md` — root for workspace-wide, member for local |
| The **argument** for a decision, and the options rejected | [`docs/adr/`](docs/adr/README.md) |
| A fact about the layout, the graph, or the conventions | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| What is built, what is not, and which spike settles an open mechanism | [`docs/ROADMAP.md`](docs/ROADMAP.md) |
| A numbered, citable criterion | [`docs/acceptance-criteria.md`](docs/acceptance-criteria.md) |
| What a **user** needs to install and run it | [`README.md`](README.md) |

If a fact belongs in two of them, it belongs in one of them and the other points at it.
