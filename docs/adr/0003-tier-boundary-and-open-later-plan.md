# 0003. Tier boundary and the open-later plan

- Status: accepted
- Date: 2026-09-05
- Deciders: @rishavanand
- Settled by: interview round 7 — "Private now, open later"

## Context and Problem Statement

The repository is private today and the local/free tier is intended to be open-sourced at
roadmap phase 5. That means every package in the repository belongs to one of two tiers:

- **`open-later`** — will be extracted and published under an open licence: `apps/cli`,
  `apps/desktop`, `packages/{protocol,mcp-server,render-core,tts-client,skill,config}`,
  `services/tts-sidecar`.
- **`hosted`** — stays proprietary: `apps/api`, `apps/web`, `services/media-service`.

The direction of the import rule follows from that: **`hosted` may import `open-later`;
`open-later` must never import `hosted`.** An `open-later → hosted` edge means the
extraction is not a directory move, it is a rewrite.

The failure mode is entirely about timing. Retrofitting an import boundary onto code that
already exists is exactly what makes an open-source extraction slip a quarter, and by then
every violating edge has a reason attached to it. The boundary is therefore machine-checked
from the first commit, before there is anything worth importing.

## Decision Drivers

- The cost of getting the boundary wrong is paid at phase 5, which is precisely why it has
  to be decided now, while it is free.
- A rule enforced by review is a rule that decays; the check has to be a command that CI
  runs and that fails red.
- The check must work across two languages, because `packages/protocol` and
  `services/tts-sidecar` are `open-later` Python and `apps/api` is `hosted` Python.
- Honesty about scope: a check that claims more coverage than it has is worse than a
  narrower one people understand, because it stops anyone looking.

## Considered Options

1. **Convention plus code review** — a documented rule, no tooling.
2. **Two repositories now** — a public one and a private one, wired by a published package.
3. **Nx's `@nx/enforce-module-boundaries`** — tag-based, first-class, and free.
4. **Tier metadata in each `package.json` plus two purpose-built checks** — a workspace
   dependency-graph checker for npm, an `import-linter` contract for Python, and a Biome
   `noRestrictedImports` override as a second, differently-shaped net.

## Decision Outcome

Chosen: **option 4**. Concretely:

- Every `package.json` under `apps/`, `packages/` and `services/` carries
  `"xplainer": { "tier": "hosted" | "open-later" }`. A member without the field is an
  error (exit 2), not a pass.
- `packages/config/bin/check-tiers.mjs` reads those fields plus each member's declared
  `@xplainer/*` dependencies, feeds them through the pure `checkTierGraph()` in
  `packages/config/src/tiers.ts`, and exits 1 on any `open-later → hosted` edge.
  `packages/config/src/tiers.test.ts` proves both directions: `hosted → open-later` yields
  no violation, `open-later → hosted` yields exactly one naming both packages.
- The root `pyproject.toml` carries a `[tool.importlinter]` `forbidden` contract —
  `source_modules = ["xplainer_protocol", "xplainer_tts_sidecar"]`,
  `forbidden_modules = ["xplainer_api"]` — and `apps/api/tests/test_tier_boundary.py`
  proves it *fails* on a deliberate violating fixture, so a contract that silently matches
  nothing cannot pass as a green check.
- `biome.json` bans the specifiers `@xplainer/api`, `@xplainer/web` and
  `@xplainer/media-service` inside the four `open-later` roots (`packages/**`,
  `apps/cli/**`, `apps/desktop/**`, `services/tts-sidecar/**`).

Option 1 was rejected on the driver above: the rule that matters is the one that is checked
on the commit that breaks it.

Option 2 was rejected because it front-loads all of phase 5's cost onto phase 0 and buys
nothing until there is a second consumer. Two repositories means a publish-install cycle
between every local change to the protocol and every consumer of it, during the phase where
the protocol changes most.

Option 3 was invalidated by a locked decision, not argued down: round 8 locked pnpm plus
Turborepo (ADR 0001), and the rule is ESLint-bound while the locked linter is Biome.

## Consequences

### The enforcement scope, stated honestly

The checks cover **declared npm workspace dependency edges and Python module imports**.
They do **not** cover:

- **Docker build contexts.** The `services/media-service` image builds with the repository
  root as its context, so a `COPY` line can pull `hosted` files into an image that also
  contains `open-later` ones. Nothing in the tier check sees a Dockerfile.
- **Compose service wiring.** `infra/docker-compose.hosted.yml` freely wires `hosted` and
  `open-later` containers together; that is runtime topology, not an import.
- **Cross-language edges.** A TypeScript package calling a Python service over HTTP is
  invisible to both checkers.
- **Generated artefacts.** Code emitted into `src/generated/` is excluded from the
  formatter and, where a generator could be pointed at the wrong tier, only the checked-in
  result is reviewable.

### `node-linker=hoisted` narrows the npm half further

This is a real cost of the electron-builder fix in ADR 0004 and it must not be discovered
later. With a hoisted `node_modules`, an **undeclared** import of a `hosted` package still
resolves — at runtime and under `tsc` — because every package is flattened into one
directory tree. `check-tiers.mjs` reads `package.json` dependency fields, so it **cannot
see that edge at all**: there is no declared dependency to inspect.

The Biome specifier ban is therefore the **sole backstop for undeclared edges**, and it
works on import specifiers rather than on the dependency graph. The two checks are
genuinely complementary rather than redundant — the checker catches a declared dependency
that no file imports yet, the specifier ban catches an import that no manifest declares —
and **neither alone is sufficient**. Removing either one leaves a real class of violation
unguarded.

Both limits are reviewed by hand at roadmap phase 5, as an explicit item, not as a hope.

### The extraction checklist for phase 5

1. **Scrub or exclude `.omc/specs/` and `.omc/plans/` before anything is made public.**
   Both files are committed deliberately, because they are the decision provenance every
   ADR in this directory cites — but both contain **absolute local paths under
   `/Users/<redacted>/`** and the **name of a private sibling repository** (name withheld)
   whose source the render templates and the TTS contract were copied from. Publishing them
   unscrubbed leaks a developer's home directory layout and the existence and name of
   unpublished private work. This item is named here, in the ADR, and again in
   `docs/ROADMAP.md` phase 5, because a checklist that lives only in someone's memory is
   not a checklist.
2. Review Docker build contexts and Compose wiring by hand — the two scope gaps above.
3. Treat `@xplainer/cli` as a **publish-then-consume boundary, not a file move**:
   `services/media-service` is `hosted` and depends on `apps/cli`, which is `open-later`.
   That direction is legal, but after extraction the dependency is an externally published
   package rather than a workspace sibling (ADR 0016).
4. Relicense the `open-later` tier; the root `LICENSE` is a proprietary placeholder that
   says so.

### Ongoing

- Adding a member means adding its tier field, or `pnpm lint:tiers` exits 2 and CI is red.
  That is deliberate: an unclassified package is the one that quietly acquires the wrong
  edge.
- The tier table is duplicated in the root `README.md` for readers who will never open this
  file, and the machine-readable copy in the manifests is the one that decides.

## Note, 2026-09-06: the open-later timing and terms are qualified by ADR 0021

Added as a dated note rather than a rewrite; the tier boundary, the import rule and every
check above are unchanged.

Recorded because
[ADR 0021](0021-proprietary-licence-free-to-use.md) settled the licence question on this
date, and it lands earlier than this record assumed. Three assumptions here need qualifying:

- **The `open-later` packages become publicly visible at phase 1, not phase 5.** ADR 0020's
  installed daemon reaches users through `npm`, so `apps/cli`, `packages/protocol`,
  `packages/mcp-server`, `packages/render-core`, `packages/tts-client` and `packages/skill`
  are published to a public registry four phases before the extraction. They ship under
  `LICENSE-BINARY` — proprietary, free to use, no redistribution — not under an open-source
  licence. **`open-later` therefore means "intended for extraction", and never meant "not
  yet distributed".** The tier boundary matters more under that ordering, not less.
- **Extraction checklist item 4 is unchanged in substance and now has a record behind it.**
  "Relicense the extracted tier" still stands; the root `LICENSE` is still the proprietary
  notice that says so. What ADR 0021 adds is that the relicensing is **conditional on
  holding all the copyright**, which is a live constraint rather than paperwork.
- **The contributor-licence question moves off the phase-5 checklist and onto the critical
  path.** Relicensing requires the right to relicense every line. Today that position is
  clean — five commits, one author — but the first outside pull request, or making the
  repository public, ends that unless a `CONTRIBUTING.md` declining external contributions
  or a CLA with an explicit future-relicensing grant is already in place. **A DCO is not
  enough**, because inbound-equals-outbound under a proprietary outbound licence grants no
  relicensing right. The argument is in ADR 0021's Consequences. This item must be settled
  **before the repository is public or before the first outside PR, whichever comes first** —
  not at phase 5, when its cost is already sunk.

The scrub item at checklist step 1 also has a smaller sibling that is live now rather than at
phase 5: `.omc/specs/` and `.omc/plans/` do not appear in any published tarball, but 29
shipped files cite ADR numbers and plan section IDs for documents that are not public. Same
class of leak, different scope; ADR 0021 records it.

## Note, 2026-09-06: the extraction happened, and one half of the check is now vacuous

Added as a dated note rather than a rewrite. The tier boundary, the direction of the import
rule and the reasoning for machine-checking it from the first commit are unchanged. What
changed is that the event this record was written to prepare for has occurred, and one of its
own stated limits deserves an honest update rather than a quiet one.

[ADR 0023](0023-split-the-repository.md) split the repository on this date. `apps/api`,
`apps/web` and `services/media-service` — the three `hosted` members named above — relocated to
the private repository `BrewMyTech/xplainer-hosted`, deferred pending a vendor answer and not
cancelled. **The boundary held.** No surviving member declared a dependency on any of the
three; the only cross-tier edge in the repository ran in the legal direction
(`services/media-service` → `@xplainer/cli`) and left with the dependant. That is the whole
of the claim this record made, and it was tested exactly once, by the event it predicted.

**Extraction checklist item 1 is discharged.** `.omc/specs/deep-interview-xplainer-monorepo-init.md`
and `.omc/plans/ralplan-xplainer-monorepo-init.md` were **removed to the private repository**,
not scrubbed. Scrubbing was considered and rejected: the absolute paths and the sibling
repository's name are the smallest problem in either file — the spec's Goal states a
free-and-paid plan shape and its Stack carries a vendor price list, and the plan is 172 KB of
hosted build plan and interview transcript. Scrubbing the paths would have left all of that
in a public repository. The provenance every record here cites is preserved by a Provenance
section in [`README.md`](README.md) naming the private repository, both paths, and the split
commit SHA — because `git show <sha>:<path>` resolves for anyone with access and a bare
repository name does not. **No citation in any record body was edited.**

**Two paragraphs above are now redacted in place, and this note is the record of it.** The two
occurrences of an absolute home-directory path in the extraction checklist read
`/Users/<redacted>/`, and the private repository's name reads `(name withheld)`. This is the
one point where this record's own immutability convention and ROADMAP **P5-2** — "no file in
the public repository contains an absolute local path, the private sibling repository's name"
— genuinely collide, because the string is not decoration: it *is* the stated reason for
checklist item 1. Deleting the record was rejected (it is `accepted` and its argument is live);
rewriting the body was rejected (the convention); publishing a developer's home directory and
the private repository's name in a public repository was rejected. **An announced redaction
changes no argument, no option and no outcome**, which is why it is not a rewrite of the
decision. It is flagged here as a judgement made, not as a mechanical fix.

**The npm tier check's real-graph half is now vacuous, and that is worth stating plainly.**
`pnpm lint:tiers` still runs and still exits 2 on a member with no tier field, which is AC-3a
and still real. But with no `hosted` member left in this repository, it cannot produce an
`open-later → hosted` violation from the real graph — there is nothing on the far side of the
edge. The proof that the rule *can* fail is now carried entirely by the synthetic fixture in
`packages/config/src/tiers.test.ts` (AC-3c). The Python contract retired outright for the
same reason (see ADR 0001's note of this date). The Biome specifier ban is deliberately kept,
with its message retargeted at the private repository: it is now the only mechanism that would
stop this repository re-acquiring a dependency on the relocated tier, and it costs nothing.

Checklist items 2, 3 and 4 are unaffected in substance. Item 4 was answered by
[ADR 0022](0022-open-source-the-published-packages.md) for the six published packages and is
still open for the rest of the tree.
