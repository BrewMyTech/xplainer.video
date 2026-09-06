# 0001. Monorepo tooling: pnpm workspaces + Turborepo + uv

- Status: accepted
- Date: 2026-09-05
- Deciders: @rishavanand
- Settled by: interview round 8 (stack lock), `.omc/specs/deep-interview-xplainer-monorepo-init.md`

## Context and Problem Statement

The product is five components in one repository — an agent skill and MCP surface, a
TypeScript render core, a local CLI daemon with an optional Electron client, a Python
hosted control plane, and the scaffolding that ties them together. Two of the twelve
workspace members are Python-only, one is dual-language, and the remaining nine are
TypeScript.

The repository has to satisfy two criteria that pull in opposite directions. AC-1 says a
fresh clone bootstraps on macOS, Linux and Windows with nothing installed beyond Node LTS
and `uv`. AC-2 says a *single* command — `pnpm turbo build lint typecheck test` — covers
every member, Python included. So we need one task graph over two package managers,
without a second task runner, a second CI dialect, or a per-language "and also run this"
step that people forget.

## Decision Drivers

- One command must reach every member, or the green run is a lie about the members it
  silently skipped (Turbo skips an undeclared script without warning or a non-zero exit).
- Fresh-clone reproducibility on three operating systems; no machine-specific setup.
- Node and Python dependency changes must both invalidate the build cache, or a
  Python-only change gets a stale cache hit.
- Mechanical open-source extraction of the `open-later` tier at roadmap phase 5, which
  needs the workspace boundary to be a real, declared dependency graph (see ADR 0003).

## Considered Options

1. **pnpm workspaces + Turborepo, with a `uv` workspace for the Python members and thin
   `package.json` wrappers that shell out to `uv run`.**
2. **Nx**, with its generators and its built-in `@nx/enforce-module-boundaries` rule.
3. **Bazel or Pants**, which are genuinely polyglot by design.
4. **Two toolchains side by side**: npm/yarn workspaces for TypeScript, Poetry or plain
   `pip` for Python, each with its own CI job and its own entry point.
5. **Generator-first bootstrap** — `pnpm dlx create-turbo`, then reshape.

## Decision Outcome

Chosen: **option 1 — pnpm workspaces + Turborepo + a `uv` workspace**, with Python members
joining the Turbo graph through a `package.json` whose `lint`, `typecheck` and `test`
scripts are `uv run --no-sync --project . <tool>` wrappers.

Nx was invalidated outright rather than argued down: round 8 locked "pnpm workspaces +
Turborepo", and adopting Nx would *replace* the locked task runner rather than supplement
it. Its module-boundary rule is also ESLint-bound, which contradicts the locked Biome
choice (see ADR 0003 for how the tier rule is enforced instead).

Bazel and Pants would solve the polyglot problem properly and cost more than the problem
is worth at twelve members: a hermetic build graph is a full-time investment, and neither
gives us the fresh-clone-with-two-tools property that AC-1 measures.

Two toolchains side by side was rejected because it makes AC-2 unachievable by
construction — there is no single command, only a convention, and conventions decay.

Generator-first was rejected as an *approach* but kept as a *technique*: `create-turbo`
emits a JavaScript-only workspace with no `uv` concept, no tier metadata, example apps to
delete, and an ESLint config that contradicts the locked Biome decision, so the reshaping
diff is larger than the authoring diff and its residue looks intentional. What survives is
narrow: generate a throwaway skeleton from the pinned binary, read what *that version*
actually emits, then hand-author the real file on top. Config written from memory is how a
version-specific key rename becomes a silent no-op.

## Consequences

- **Every member must declare every task it should run.** Turbo invokes only the script
  whose name matches the task and skips a member that lacks it, silently and with a zero
  exit. So all ten TypeScript members carry exactly `build`, `lint`, `typecheck` and
  `test`; the two Python-only members (`apps/api`, `services/tts-sidecar`) carry the last
  three and no `build`, because there is nothing to compile. The counts are asserted, not
  assumed: `--dry=json` must list twelve members for `test`, `lint` and `typecheck`, and
  ten for `build` (AC-2b, AC-2f, AC-2g).
- **`packages/protocol` is dual-language, and that shapes its scripts.** Its Python half is
  chained from the primary script of the same name (`"lint": "biome check . && pnpm run
  lint:py"`) rather than parked in a separate `lint:py` task, because a task name Turbo
  does not know about is never invoked — and AC-2b would still count the member as covered
  on the strength of its TypeScript half alone.
- **`uv.lock` and `.python-version` are in `turbo.json`'s `globalDependencies`**, so a
  Python dependency change invalidates the graph. Turbo hashes files and knows nothing
  about a virtualenv.
- **Two root files exist that the spec's layout block does not list** (deviation D-5), and
  both are load-bearing rather than incidental:
  - `.npmrc` — `node-linker=hoisted`, `inject-workspace-packages=true` and
    `engine-strict=true`. The first two are electron-builder's requirements and are argued
    in ADR 0004; the third makes the Node 24 pin in `engines` a hard failure rather than a
    warning.
  - `.dockerignore` at the **repository root** — the `services/media-service` image builds
    with the repository root as its context because it installs from the pnpm workspace,
    and Docker reads the ignore file from the *context* root. An ignore file placed inside
    the service directory is silently inert for a root-context build, and the whole
    workspace including `node_modules` and `.git` gets shipped to the daemon.
- **The bootstrap is two commands and no more:** `corepack enable && pnpm install
  --frozen-lockfile` and `uv sync --all-packages --frozen`. That is exactly what AC-1
  measures and what the three-OS `bootstrap` CI job executes.
- **A pinned Biome major.** The whole `biome.json` is written in the 2.x dialect
  (`files.includes` with `!` negations, `overrides[].includes`). Biome renamed those keys
  between majors and a mixed-dialect file is *silently partly ignored* rather than
  rejected, so a future 3.x upgrade is a config migration and not a version bump.

## Note, 2026-09-06: the uv workspace narrows to two members and loses the import-linter contract

Added as a dated note rather than a rewrite. The tooling choice below — pnpm workspaces plus
Turborepo for TypeScript, a `uv` workspace for Python, one Turbo graph over both — is
unchanged, and every argument for it still holds.

[ADR 0023](0023-split-the-repository.md) relocated `apps/api` to a private repository. Two
things in the root configuration this record describes changed value as a result, and one of
them changed for a reason worth writing down rather than inferring.

**`[tool.uv.workspace] members` narrows from three to two** — `packages/protocol` and
`services/tts-sidecar`. The single-environment argument is undamaged: one `uv.lock` behind one
documented bootstrap (`uv sync --all-packages --frozen`), `datamodel-code-generator` pinned at
the root because `packages/protocol`'s pydantic output is diffed in CI, and
`packages/protocol` shipping `python/**/*.py` in its published `files`, so the Python half has
to stay installable and testable. The alternative — two independent per-directory virtual
environments — costs two lockfiles, two syncs, a second bootstrap line in the README and in
CI, and forces the pinned generator down into `packages/protocol`. Not worth it for two
members. AC-1b changes value from three to two and is unchanged in shape.

**The `[tool.importlinter]` block is deleted, and with it the `import-linter` dev
dependency and its CI step.** This is not a narrowing; it is a retirement, and the reason is
not that the workspace got smaller. The contract's `forbidden_modules` was `xplainer_api`,
and `xplainer_api` is the only `hosted` Python module that ever existed. With it relocated
there is no forbidden target, so the contract cannot be violated — and a contract that cannot
fail is not enforcement, it is decoration that a future reader would trust. The comment block
that argued for `root_packages`, *plural* — "an edge BETWEEN two members is only visible in a
graph that contains both ends of it" — was correct, and its premise is what left. Leaving it
in place would document a contract that no longer exists. The npm-side tier check and the
Biome specifier ban both stay; see ADR 0003's note of the same date for what each of them
still proves.
