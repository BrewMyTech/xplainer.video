---
name: update-docs
description: Bring this repository's generated files, API reports, records and instruction files back in step after a code change, in the order that makes the post-change command pass, and read the diffs that are the review. Use after editing anything under apps/, packages/ or services/ and before committing or opening a pull request. Advisory — the procedure itself is one section in the root AGENTS.md, and the enforcement is `pnpm verify` in CI.
---

# Update the docs after a code change

**This skill is advisory. It is a convenience wrapper, not a gate.** What is enforced is
`pnpm verify`, which CI runs on every push whether or not anyone invoked this skill — invoking the
skill and skipping the command proves nothing, and skipping the skill breaks nothing. Codex never
reads `.claude/skills/`, which is exactly why the procedure lives in `AGENTS.md`, where both agents
see it, and why this file adds sequence rather than content.

## The procedure itself

One section, written once — [`AGENTS.md` § The canonical post-change procedure][canonical].

Read it there. It is deliberately not repeated here: a second copy is a copy that goes stale, and
the root file says to delete any copy you find.

[canonical]: ../../../AGENTS.md#the-canonical-post-change-procedure

## The order to run things in

The canonical section says what to run. This is *when* to run it, relative to the edits that make it
pass. Do the steps that apply to your change, in this order, and leave the command for last.

1. **Regenerate first.** If you touched `packages/protocol/schemas/**`, run
   `pnpm --filter @xplainer/protocol codegen` before anything else. The regenerated TypeScript and
   Python belong in the same commit as the schema that produced them, and nothing under
   `generated/` is ever hand-edited.
2. **Build, then re-report the public surface.** If you changed an `export` in a built package,
   build before `pnpm api:report`. The reports are read out of `dist/`, so a report taken over a
   stale build is a stale report — and `isolatedDeclarations` errors surface only under `build`,
   never from `tsc --noEmit` and never in your editor.
3. **Then fix the prose the change made wrong.** A member's invariants, commands or public
   surface → that member's `AGENTS.md`. A fact about the roster, the dependency graph or the
   conventions → `docs/ARCHITECTURE.md`. The argument for a decision → a new ADR, or a dated note
   on the existing one; accepted records are never edited. What a *user* installs or runs →
   `README.md`. When two of them look right, `AGENTS.md` § What belongs where is the arbiter.
4. **Then the changeset**, if the change is user-visible in a published package: `pnpm changeset`.
5. **Then the command**, once, from the repository root.

The order matters because each step writes files the next one reads, and because the command's job
is to confirm the work rather than to discover it. Run it first and all it tells you is that
something is stale.

## Where to look at the diff

Read these before you commit. Each is the review for one of the steps above.

```bash
git status --short                          # a step you skipped shows up as an unstaged file
git diff -- apps/cli/api packages/*/api     # the public surface; an unintended line here is a
                                            # breaking change to somebody's build
git diff -- packages/protocol/src/generated \
            packages/protocol/python/xplainer_protocol/generated   # both halves of the codegen
git diff -- docs/ARCHITECTURE.md            # the two CHECKED blocks are compared to the workspace
git diff --stat                             # last: source touched, prose untouched — true?
```

That last question is the one nothing can answer for you. No gate checks whether an `AGENTS.md` was
updated alongside the code it describes, or whether any sentence in it is accurate; the checks read
structure, not claims. Reviewing that is the reason this skill exists, and the reason it stays
advisory.
