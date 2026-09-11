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

## Publishing a release

`pnpm verify` does not cover this and neither does `check-publish-contract`, which reads a
tarball's **contents** — licences, NOTICE, no test scaffolding, no private paths — and cannot see
the two things that actually broke the first release attempt. Both were found by unpacking a
tarball and reading the manifest by hand:

- **`publishConfig: { access: public }` on every published member.** A scoped package defaults to
  restricted, so without it the publish is refused as a private package on an org with no private
  plan. npm reports this as a permissions error, which reads like a credentials problem and is not.
- **`workspace:*` is not publishable, and this workspace cannot rewrite it.** pnpm normally
  substitutes the real version at publish time by resolving the protocol through the *consumer's*
  own `node_modules` — and `nodeLinker: hoisted` (above, for electron-builder) puts every member in
  the **root** `node_modules` instead, so `pnpm pack` and `pnpm publish` both refuse with
  `ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL`, in a package directory and recursively from the
  root alike. Forced through with `npm publish` it would ship `workspace:*` verbatim and every
  `npm i` would fail on `Unsupported URL Type`.

**And the obvious way out of that second one is a trap.** Declaring the literal version instead —
`"@xplainer/cli": "0.0.1"` in `packages/alias` — does make a plain `npm publish` correct, because
there is no protocol left to rewrite. It also silently unlinks the member: pnpm's
`linkWorkspacePackages` defaults to **false**, so a literal range resolves through the registry and
`packages/alias/node_modules/@xplainer/cli` becomes a *download* rather than the package next door.
The alias exists to read `bin["xplainer"]` out of `@xplainer/cli`'s own manifest, so pinned to the
registry it stops testing the CLI it ships beside: a renamed bin or a changed `exports` map would
pass every gate in this repository and break only once published. It also drags our own
hours-old packages through the release-age gate above, which is what appends `@xplainer/*` entries
to `minimumReleaseAgeExclude`. Keep the protocol, and publish with pnpm.

So a release is published from a **one-off isolated install**, which supplies the per-consumer
links the rewriter needs and leaves the committed configuration alone — `hoisted` exists for
packaging the desktop app, which is not involved in publishing:

```bash
pnpm changeset version          # consumes .changeset/ into CHANGELOGs, bumps versions
TURBO_FORCE=true pnpm verify    # the gate, on the versioned tree
git commit && git push          # the repository records what is about to ship, first

pnpm install --config.nodeLinker=isolated     # ONLY for the publish; do not commit a lockfile from it
pnpm publish -r --no-git-checks --access public
pnpm install                                  # restore the committed hoisted layout
```

**Verify from the registry rather than from the tarball**, because the tarball is what you already
believed: `npm install @xplainer/cli` in an empty directory outside this workspace, confirm the four
transitive `@xplainer/*` dependencies resolve, and run `npx -y @xplainer/cli --help` — a published
`workspace:*` breaks exactly this, because `npx` has to resolve the dependency tree before it can
run anything. Then the **unscoped alias**, which is both the name a user types and the one the
plugin bundles declare (`npx -y xplainer mcp`), so it is the zero-install path as well as the
install one: `npx -y xplainer --version` must print the version just published, because
`packages/alias` is one pinned dependency on `@xplainer/cli` and the pin is the only thing holding
the two together.

**Cut the tag after every member has landed on `main`, not before.** `0.0.1` did the opposite and
the record is still crooked because of it: `v0.0.1` points at the commit that published the six
scoped packages, `packages/alias` was written and published afterwards from a branch, and so
`xplainer@0.0.1` exists on the registry while the tag that names that release contains none of its
source. The tag was deliberately **left where it is** — moving a pushed ref breaks every clone that
already fetched it, to fix a mismatch that costs nothing but this paragraph — and `packages/alias`
carries the only hand-written `CHANGELOG.md` entry in the repository as a result, because its
changeset was still unspent when the package shipped. Neither is a pattern to repeat: publish every
member in one pass, then tag.

**2FA is interactive.** `pnpm publish` refuses with `ERR_PNPM_OTP_NON_INTERACTIVE` outside a TTY,
which includes every agent-run shell. Either publish from a real terminal, pass `--otp` for a
classic authenticator, or use a granular access token with *bypass 2FA* — the last is the only one
a release workflow can use.

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

Ten of them. The table — path, package name, tier, published or not, whether it emits declarations,
whether it has an API report, and what it is responsible for — is
[`docs/ARCHITECTURE.md` §3 Members](docs/ARCHITECTURE.md#3-members), and it is machine-checked
against the workspace. There is no second copy here on purpose: a hand-maintained duplicate is a
table that goes stale.

**The workspace root's own manifest is named `xplainer-workspace`, not `xplainer`.** The unscoped
name belongs to the published alias in `packages/alias`, and `pnpm --filter` matches by name: while
the root carried it too, `pnpm --filter xplainer test` matched **both** projects and ran the root's
`turbo run test` — the whole workspace — beside the one member that was asked for. The Python root
in `pyproject.toml` has been `xplainer-workspace` all along, so this is now one name on both sides.
Nothing reads either root name; turbo addresses root tasks as `//#<task>`.

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
  *Enforcement: review. There is no release workflow in this repository yet — of the thirteen files
  in `.github/workflows/`, not one reads `.changeset/` — so this is a convention until one exists.
  Treat it as binding anyway: the changeset is the changelog entry, and it is written while the
  reason for the change is still in front of you.*
- **No `TODO`, `FIXME`, `.skip(` or `.only(` in committed source.** Not in a comment, not "just for
  now". *Enforcement: `AC-2c`, a CI grep over `apps/`, `packages/` and `services/` on a pristine
  tree.*
- **`.skipIf(` is allowed, and only with the condition written at the call site.** It is the one
  form of skip this repository uses on purpose — a live Kokoro server, a real render, a probe that
  only `darwin` has — and the rule that keeps it honest is that the condition must **begin with
  `process.env` or `process.platform` on the same line**. A `describe.skipIf(SKIPPED)` reads as an
  unconditional skip to everyone but the author of the constant, and the gate cannot tell the two
  apart; an inline `process.env.X === "1"` says what is being waited for and where to set it. There
  is no `.skipIf` that is not gated on one of those two, and the five in the tree are
  `preflight.test.ts`, `chrome.test.ts`, `workspace.test.ts`, `workers/render.test.ts` and
  `tts-client/src/client.test.ts`. *Enforcement: `AC-2c`'s second grep, in the same CI step.*
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
| `scripts/` | The four bespoke gates (`check-publish-contract.mjs`, `api-report.mjs`, `check-docs-contract.mjs`, `check-no-suppressions.mjs`), and the **eight** end-to-end proofs in `scripts/e2e/` — each a proof rather than a gate, deliberately outside `pnpm verify` for the reason `e2e/render.mjs`'s docblock gives. `e2e:macos` is a deprecated alias for `e2e:render` kept for one release and then deleted | Root `pnpm biome check .`, in CI and in the lefthook pre-commit job. Not `turbo run lint`. |
| `.github/workflows/` | CI, the desktop packaging workflow, and the **proof** workflows — `e2e-linux.yml`, `e2e-runtime.yml`, `e2e-speech.yml`, `e2e-toolchain.yml`, `phase2-proofs.yml` and the seven `daemon-*` files (`daemon-lifecycle`, `daemon-restart`, `daemon-breaker`, `daemon-update`, `daemon-identity`, `daemon-remote`, `daemon-windows`) — every one of them `workflow_dispatch` only, because each renders a real video, assembles a real artefact, drives a real supervisor or binds a real network address. `workflow_dispatch` registers from the **default branch**, so a new proof workflow is dispatchable only once it is on `main`, whatever `--ref` says. Each carries a boolean input for the operating systems it can actually run on, and nothing for the ones it cannot: **eight of the twelve** carry all three (`e2e-runtime`, `e2e-speech`, `e2e-toolchain` and the five three-platform `daemon-*` files), `e2e-linux.yml` carries `linux` alone, `phase2-proofs.yml` carries `linux` and `windows`, `daemon-remote.yml` carries `linux` and `macos`, and `daemon-windows.yml` carries `windows` alone. Every input defaults to `false` except the one that names the workflow's home platform — `linux=true` in eleven of them, `windows=true` in `daemon-windows.yml`, which has no Linux leg. An omitted input keeps its default, so a Windows-only iteration is `gh workflow run daemon-lifecycle.yml --ref phase-2 -f linux=false -f windows=true`, and an unselected platform is excluded from the matrix before a runner is allocated, so iterating on one platform never re-pays for the others | `actionlint` (`AC-4a`) |
| `docs/` | ADRs (immutable), `ARCHITECTURE.md`, `daemon.md`, `ROADMAP.md`, `acceptance-criteria.md` | `pnpm check:docs-contract` for `ARCHITECTURE.md`'s two `CHECKED` blocks and the `AGENTS.md`/`CLAUDE.md` set; review for everything else |
| `infra/e2e/` | The Debian image `pnpm e2e:render:linux` builds to run that proof on Linux, and its own `Dockerfile.dockerignore`. Not a Compose file, and not reachable from one | The run itself; nothing else builds it |
| `.claude-plugin/`, `.claude-plugin/marketplace.json` | The one-entry marketplace `/plugin marketplace add BrewMyTech/xplainer.video` reads, because that command reads the repository **root** and the bundle lives in a member. It carries no plugin content of its own: its `source` is a plain relative path to `packages/skill/claude-plugin`, and it declares no `version`, because nothing stamps one at the root and a hand-written one would drift from the package's on the next release | Root `pnpm biome check .`, and `pnpm check:docs-contract` for the one thing a tarball check cannot see: that it is **tracked by git**, since a marketplace reads the repository and this file spent a whole run existing only in a working tree. No gate validates its *contents* — it is in no member's tarball, so `check-publish-contract` never sees it. What does, by hand, is **`claude plugin validate .claude-plugin/marketplace.json`**, which passes as of 2026-09-11; it is not in `pnpm verify` because it needs the Claude Code CLI, which a CI runner and a Codex session both lack. Run it after editing this file. Note that the same command **fails** against the `source` it points at (`No manifest found in directory. Expected .claude-plugin/…`) and that this is the already-booked gap in `docs/ROADMAP.md` rather than a new defect: that directory is a build *input* with a flat `plugin.json`, and it still installs, because components at a plugin root are auto-discovered |
| `biome.json`, `ruff.toml` | Lint configuration for both languages | Changing either changes every member's `lint` |
| `pnpm-workspace.yaml` | Member globs, the version catalog, and the install settings | `pnpm install --frozen-lockfile`; the normative script rule is written in its comments |
| `packages/config/tsconfig/` | The presets every member extends | Every member's `typecheck` and `build` |
| `turbo.json`, `lefthook.yml`, `.npmrc`, `pyproject.toml`, `uv.lock` | Task graph, git hooks, install settings, Python workspace | `pnpm verify` |

**The eight end-to-end proofs in `scripts/e2e/`.** Each has a root script and names the batch it
proves; none runs inside `pnpm verify`, because they render real video, assemble real artefacts,
drive real supervisors or bind real network addresses. The last column is the workflow that runs the
same proof on a hosted runner — every one `workflow_dispatch` only.

| Script | Command | What it proves | The `[runner]` half |
|---|---|---|---|
| `e2e/render.mjs` | `pnpm e2e:render` | P1-1: one real video through the MCP tools — a real `xplainer setup` first, because batch 6's toolchain gate refuses `still` and `render` without one, then `create → put_source → narrate → still → render` over `mcp --attach`, real Kokoro speech, `ffprobe` on the MP4 and a frame diff against a captions-disabled render | `e2e-linux.yml` (the same render on a Linux VM) |
| `e2e/speech.mjs` | `pnpm e2e:speech` | P2-4: speech with **no Docker, no `--tts-url`, no server and no Python** — the three executables made unreachable and the absence proved with the product's own `spawn`, then `setup` acquires the model, a voice and this platform's ONNX Runtime, and `narrate → still → render` comes out with **every word of the script present in `captions.json`** (AC 2, plan D5), word timings from the model's own duration predictor, and the narration worker's exit code asserted | `e2e-speech.yml` (3-OS matrix) |
| `e2e/linux.mjs` | `pnpm e2e:render:linux` | The Linux half of P1-1: `render.mjs` inside the `infra/e2e` Debian container, against a Kokoro container, both created and destroyed around it | none of its own: `e2e-linux.yml` is the hosted form of the same proof and runs `render.mjs` directly against a service container |
| `e2e/runtime.mjs` | `pnpm e2e:runtime` | B1: `create → put_source → narrate` driven entirely out of a **relocated** payload 1, with no `node` on `PATH` and no checkout in any ancestor | `e2e-runtime.yml` (3-OS matrix) |
| `e2e/toolchain.mjs` | `pnpm e2e:toolchain` | B6: `xplainer setup` acquires a browser, records a speech route and materialises the workspace on that same machine — and a picture comes out of `still → render` | `e2e-toolchain.yml` (3-OS matrix) |
| `e2e/update.mjs` | `pnpm e2e:update` | B5: the update transaction killed at **every** durable transition, its two refusals, and six assertions per rollback — including that the rolled-back daemon renders | `daemon-update.yml` |
| `e2e/identity.mjs` | `pnpm e2e:identity` | T17: desired / loaded / responding compared against a **real** service manager, which is the only way a switch that was written and never reloaded is visible | `daemon-identity.yml` |
| `e2e/remote.mjs` | `pnpm e2e:remote` | P2-5: R-SEC-9 on a non-loopback address — five refusals decided *before* the bind, then `401`, `200` and a `403` on a foreign `Host` over real TLS. `docs/daemon.md` §5 | `daemon-remote.yml` |

## Before editing a member, read that member's `AGENTS.md`

Each of the ten has one, with the same five headings: `## What this package is`,
`## Public surface`, `## Commands`, `## Invariants`, `## How to add`. The invariants there are
specific and are not repeated at the root.

**This is a convention, not a mechanism.** Neither Claude Code nor Codex loads nested instruction
files automatically in every configuration: Codex walks `AGENTS.md` hierarchically and never reads
`CLAUDE.md`; Claude Code reads `CLAUDE.md` from directories it works in and never reads
`AGENTS.md`. That is why each member also carries a one-line `CLAUDE.md` importing its `AGENTS.md`.
The ten member files are deliberately **not** imported from the root — importing them would load
all ten every session and destroy the locality that makes them useful.

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
