---
"@xplainer/cli": patch
---

**`xplainer connect claude|codex` writes the skill, not just the MCP entry.**

`connect` exists to make an agent able to do this, and for a release it delivered the transport and
not the method: one stdio entry, eight tools, and none of the instructions an agent reads before it
composes a scene. The visible symptom is a video that looks improvised, because it was — an agent
with the tools alone has nothing telling it that every scene length comes from measured word
timestamps rather than a guess, which is the one mechanic in `SKILL.md` that is not negotiable.

Both clients read `<home>/skills/<name>/SKILL.md`, verified against real installations of each, so
one writer serves both and the only difference is which home. The file comes out of the
`@xplainer/skill` this package now depends on — data only, no code, no dependencies of its own,
11 KB over 12 files — rather than a copy inside `apps/cli`, because there is one reviewed `SKILL.md`
and `packages/skill/src/build.test.ts` already compares it byte-for-byte against both plugin
bundles. A second copy here would be the first to go stale.

**Re-running `connect` is the update path**, which is what the write being idempotent is for: after
`npm i -g xplainer@latest`, one `xplainer connect claude` refreshes the entry and the skill together
and says which of them changed — `wrote` or `already current` — rather than claiming a write it did
not make.

This is a new runtime dependency of `@xplainer/cli`, so it is a change to payload 1's closure, to
the publish contract and to every installer. It is 11 KB of data and no code, which is the only
reason that is acceptable.
