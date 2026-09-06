# 0026. The repository's contracts are machine-checked, and `AGENTS.md` is the one instruction surface

- Status: accepted
- Date: 2026-09-06
- Deciders: @rishavanand
- Settled by: `.omc/plans/ralplan-agent-first-architecture.md` — the RALPLAN-DR plan for the
  agent-first architecture. This record was written `proposed` and became `accepted` on that plan's
  approval. Consensus at round 3: Critic APPROVE, Architect SOUND-WITH-CHANGES with every remaining
  item folded in.
- Occasioned by: the owner's direction that development of this repository is agent-first, and the
  comparison against a comparable local-daemon application that produced the three durability
  findings **L1–L3**. Those three are decided in
  **[ADR 0024](0024-durable-jobs-and-boot-reconciliation.md)** and
  **[ADR 0025](0025-daemon-updates-and-readiness.md)**, which are about the running product. This
  record is about the repository the product is built in, and it is the only one of the four that
  changes what every future contributor — human or agent — has to do.
- **Every count below is a measurement, not an estimate.** The numbers were produced against the
  working tree at `dea8c22` with the probes the plan's §3 records, one flag or rule at a time. Where
  a round of review re-measured a number and got a different answer, the corrected number is the one
  written here and the correction is stated in §Consequences rather than quietly applied. This
  record's authority rests entirely on those counts being reproducible.

## Context and Problem Statement

Development of this repository is done by agents. An agent has no memory of yesterday's session and
no author to ask, so everything it needs must be either **visible at the declaration site** or
**enforced by a command that fails**. Anything else — a convention, a paragraph in a review comment,
a rule that lives in one contributor's head — reaches the next session as nothing at all.

Measured against that standard, the scaffold is in an unusual position. It is documented far better
than most: 23 numbered decision records (0001 … 0023 — eighteen present here, five relocated
tombstones), a roadmap with pre-written phase criteria, and an acceptance-criteria file whose ids 52
comments and CI step names already cite. But:

- **None of that documentation is machine-checked.** No command fails when a record, a criterion or
  a layout description stops matching the tree. The repository can prove the consequence rather than
  argue it: the private sibling repository's name still ships inside twelve JSON Schema
  `description` strings under `packages/protocol/schemas/`, and `LICENSE` Part Two still names three
  directories — `apps/api`, `apps/web`, `services/media-service` — that no longer exist. Both are
  recorded as open gates in [`../ROADMAP.md`](../ROADMAP.md), which is to say both were caught by a
  human reading, months later, and neither was caught by a check.
- **There is no agent-facing instruction file of any kind.** No `AGENTS.md`, no `CLAUDE.md`, no
  `.claude/` was tracked anywhere. An agent's only entry point was the root `README.md`, which is
  written for a user installing the product.
- **The type system stops at `strict: true`.** Nothing above it, so an exported symbol's type can
  require the checker to look at another file, and a widened public surface can land in a diff that
  shows only an implementation change.

The question this record answers is **which of those gaps to close mechanically and which to leave
as prose**, on a 224-file scaffold — 59 TypeScript, TSX and `.mjs` sources, 10 Python files — where
the cost of closing them is at its historic minimum and can only grow.

## Decision Drivers

1. **The declaration site is the index an agent navigates by.** An agent finds a symbol by grep and
   reads its type where it is written. A type that must be inferred across files, or a public
   surface that has no rendered form, is not in that index.
2. **A rule that is not a failing command is a suggestion, and this repository already knows it.**
   AC-2c is a grep in CI. AC-9c is codegen followed by `git diff --exit-code`.
   `check-publish-contract.mjs` asks npm what a tarball contains rather than trusting the working
   tree. Every mechanism this record adopts is enforced or is explicitly labelled advisory.
3. **Migration cost is measured at 20 mechanical edits today and grows monotonically with the
   product.** Every flag and rule below was probed individually; the totals are in §3 of the plan
   and are reproduced per-mechanism here.
4. **Nothing is published yet, so protocol and surface changes are free exactly once more.** The
   moment `packages/protocol` and the other four published members exist on npm, a widened export is
   a compatibility obligation rather than a diff.

## Considered Options

1. **Conventions and prose.** An architecture document, an `AGENTS.md` hierarchy, no new
   enforcement.
2. **CI-enforced contracts.** A tightened `tsconfig`, expanded Biome and ruff, committed API reports
   with a staleness gate, a machine-checked architecture document, and a checked `AGENTS.md` set.
3. **Generated documentation.** TypeDoc or api-extractor for the public surface, and `AGENTS.md`
   generated from source.

## Decision Outcome

**Option 2, taking from option 3 only the generated public-API report.**

### Why option 1 was rejected

Prose does not defend itself, and this repository can prove it rather than assert it. The twelve
schema `description` strings and `LICENSE` Part Two's three dead directories, both named in the
Context above, are documentation that drifted from the tree and stayed drifted until a person read
it. An `AGENTS.md` hierarchy with no check behind it is the same class of artefact and would drift
the same way — faster, because it describes a workspace roster that changes.

### Why option 3 was rejected as a *shape*

Not on tooling grounds — see the next section, which is about tooling and reaches a different
answer. On the argument that survives measurement: **generated documentation says what the types
are, and the facts agents get wrong are invariants.** That `serve` must never gain a `--detach`
flag. That five scaffold files are engine-owned and an agent-authored scene may not replace them.
That every `uv run` in this repository carries `--no-sync`. That `isolatedDeclarations` errors
appear on `pnpm turbo build` and never in an editor. No generator emits any of those, because none
of them is a property of a type.

The one part of option 3 that does survive is the **public-API report**: a rendered, committed
`.api.md` per published surface is exactly the artefact that makes a widened export visible in a
diff, and it is generated rather than written precisely because a hand-maintained one would drift.

### On the tooling, this record states what was measured rather than what was assumed

Round 1 of the plan rejected both generators on the ground that they pin a TypeScript range. That
was true of one and false of the other, and the correction is recorded here because the difference
decided the outcome.

- **`typedoc@0.28.20` declares `peerDependencies: { typescript: "5.0.x || … || 6.0.x" }`**, and this
  workspace pins **7.0.2**. TypeDoc is excluded by its own manifest. The range claim holds — for
  TypeDoc only.
- **`@microsoft/api-extractor@7.59.0` declares no `peerDependencies` at all** and carries its own
  pinned `typescript: 5.9.3` as a direct dependency, with `engines: { node: ">=20.9.0" }`. It does
  **not** constrain this workspace's compiler. The only open question was whether its bundled 5.9.3
  parses declarations emitted by 7.0.2, and that question was **answered by running it** against all
  five published entry points before any alternative was written.

**The result, in the order it was found.** Its bundled TypeScript parses 7.0.2-emitted `.d.ts`
without complaint — the syntax was never the problem. Run in its documented default configuration,
with `compiler.tsconfigFilePath` defaulting to each member's own `tsconfig.json`, extraction
succeeds on **four** of the five entry points and **aborts on `packages/render-core`** with
`Internal Error: Unable to follow symbol for "Buffer" … You have encountered a software defect`. The
trigger is `readScaffoldTemplate(name: ScaffoldFile): Buffer` — the global `Buffer` that
`@types/node@26.4.1` declares inside `declare module "node:buffer" { global { … } }`. A one-line
`.d.ts` containing only `export declare function readBytes(name: string): Buffer;` reproduces it,
and changing that return type to `Uint8Array` makes the same run succeed. All five entry points
*do* extract, byte-stably across two runs, but only under a hand-written inline
`compiler.overrideTsconfig` that both narrows `include` to `dist/**/*.d.ts` and pins `typeRoots` at
the workspace's `node_modules/@types` — a configuration that is a workaround for a crash, found by
bisection rather than by documentation, and one that would have to be rediscovered the next time
`@types/node` moves.

The rule the plan set before the measurement was taken decided the rest: **extraction that covers
four packages in the natural configuration and needs a bespoke fifth is a partial pass, and a
partial pass takes the fallback branch.** So the report is generated by `scripts/api-report.mjs`, in
the house style of `check-tiers.mjs` and `check-publish-contract.mjs` — a module header that
explains what it reads and why, and documented exit codes. It is `node:`-only and walks each entry
point's re-export lists rather than building a type graph, which it can do because no `export *`
survives anywhere in `apps` or `packages`; where that reach is not enough it exits `2` and names the
file rather than quietly producing a thinner report.

A future contributor who proposes api-extractor reads an experiment, not an assumption. The same
measurement is in that script's module header, for a reader who never opens this record.

### What was adopted, specifically

- **Ten `tsconfig` flags** in `packages/config/tsconfig/base.json`, alongside the existing `strict`:
  `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`,
  `allowUnreachableCode: false`, `allowUnusedLabels: false`, `erasableSyntaxOnly`, `noUnusedLocals`,
  `noUnusedParameters` (0 errors each), `exactOptionalPropertyTypes` (5) and
  `noUncheckedIndexedAccess` (8). The file stays plain JSON with no comments, because `require()`
  parses it and a check depends on that.
- **`isolatedDeclarations: true` on the six members that have a `tsconfig.build.json`** — `apps/cli`,
  `packages/config`, `packages/mcp-server`, `packages/protocol`, `packages/render-core`,
  `packages/tts-client` — for **7** fixes, two of them in `packages/protocol`'s code generator so
  the annotation is derived from the same schema data the values are and re-running codegen stays
  byte-identical.
- **Seven Biome rules at `error`** — `noExplicitAny`, `noUnusedImports`, `noNonNullAssertion`,
  `noEnum`, `noDefaultExport`, `useFilenamingConvention` and `noReExportAll` — with **two** scoped
  overrides for them: `noDefaultExport` off for `apps/desktop/electron.vite.config.ts`, which Vite
  requires, and `useFilenamingConvention` allowing PascalCase under `apps/desktop/src/renderer/**`.
  `noReExportAll` is the highest-value rule in the set: it converted **9** `export *` statements
  across **3** files into explicit named lists, which is what turns a barrel into an index an agent
  can grep.
- **Nine ruff groups** — `ANN`, `RUF`, `PTH`, `C4`, `SIM`, `TID`, `ARG`, `N`, `D` — with
  `convention = "google"` and two test per-file-ignores, at **zero** source edits. `S` (bandit) is
  rejected: all 14 of its hits were `assert` in tests, and after ignoring tests it finds nothing in
  two hand-written modules that read no untrusted input.
- **A public-API report with five committed files**, at `<member>/api/<unscoped-name>.api.md`, for
  the intersection of published and declaration-emitting: `apps/cli`, `packages/mcp-server`,
  `packages/protocol`, `packages/render-core`, `packages/tts-client`.
- **`docs/ARCHITECTURE.md` with two machine-checked blocks**, `CHECKED:members` and `CHECKED:deps`,
  and **`scripts/check-docs-contract.mjs`** behind them.
- **A root `verify` script** that chains every gate a local run can execute, so there is one command
  an agent can be told to run.
- **An `AGENTS.md` per member** — nine of them plus the root — and **ten `CLAUDE.md` stubs** (root
  plus each of the nine members), each a one-line `@AGENTS.md` import. Two files exist rather than
  one because Claude Code reads `CLAUDE.md` and does not discover `AGENTS.md` at any level, while
  Codex walks `AGENTS.md` hierarchically; a one-line import has nothing in it that can drift, which
  is the only reason two surfaces are tolerable at all.

### Four mechanisms rejected, each on a measured count

The counts are recorded here so a future contributor who proposes one of them reads the number
first, and argues against evidence rather than against taste.

- **`noPropertyAccessFromIndexSignature` — 32 errors** (protocol 13, skill 17, desktop 1,
  mcp-server 1), all `TS4111`, and 30 of them in tests that walk `JSON.parse` results and JSON
  Schema objects. Its remedy is to rewrite `schema.properties` as `schema["properties"]` and
  `servers.xplainer` as `servers["xplainer"]`. A reader greps for `properties` and finds both forms;
  an agent editing the file has to know which is required where. It replaces readable property
  access with string indexing across the two packages whose whole job is describing the contract.
  **It is not made redundant by `noUncheckedIndexedAccess`** — that flag adds `| undefined` to an
  index-signature read and does not reject a misspelled key; a misspelled key under it is simply a
  `T | undefined` the code must narrow. The two do different jobs, and this rejection rests on
  grep-ability alone, which is sufficient. AC-15d asserts the flag's **absence**, so a future
  contributor who adds it meets this paragraph first.
- **Biome `useNamingConvention` — 57 errors**, 43 of them the snake_case wire contract: `job_id`,
  `exit_code`, `finished_at`, `output_lines`, `explainer_put_source` and the rest. Those names are
  fixed by `packages/protocol/schemas/**` and by the MCP tool contract
  ([ADR 0007](0007-mcp-tool-contract-and-put-source.md)). Enforcing camelCase would either break the
  contract or bury four files in suppression comments.
- **`noBarrelFile` — 5 errors**, all of them the package entry points named in each
  `package.json`'s `exports` map. Banning them means every consumer deep-imports, which contradicts
  the published interface. The real defect was `export * from "./client.js"`, and `noReExportAll`
  is what removes it.
- **`useExplicitType` — 27 errors**, of which **zero** are `it()` callbacks: 8 are object-literal
  method shorthand in a test stub backend, 7 are `CliIo` writer methods and arrows, 4 are helper
  arrows assigned to a `const` in tests, 3 are exported consts `isolatedDeclarations` already
  catches, and 5 are a function declaration, a React component and miscellany. **18 of the 27 are in
  test files**, where the rule's demand is a return type on a stub method whose type is already
  fixed by the interface it implements. Superseded by `isolatedDeclarations` at **7** fixes,
  enforced by the compiler rather than by a nursery rule that may move or change semantics.

**Biome `noProcessEnv` — 9 hits — is rejected too**, in a CLI whose job includes reading the
environment: `resolveBaseUrl(env = process.env)` is already the injectable pure function the rule is
trying to produce. The pattern is written into `AGENTS.md` as a convention instead, and is labelled
as one.

## Consequences

- **Every built package's public surface is typed at its declaration site**, and every package that
  is both published and declaration-emitting is rendered into a committed `.api.md`, so a PR that
  changes it says so in the diff. This is the single change most likely to be felt day to day: it
  makes a widened export visible in review instead of at the next major.
- **The published set and the declaration-emitting set are different, and this record names both.**
  `packages/skill` is published with **no** TypeScript surface — one `.ts` file, a test, and a
  bundle built by `node scripts/build.mjs` — so it gets no report, and the gate asserts the absence
  rather than leaving it ambiguous. `packages/config` emits declarations and is `private: true`, so
  it gets `isolatedDeclarations` and no published report. Code that assumes one list is the other
  will be wrong.
- **Four or five bespoke CI gates instead of two.** `check-tiers.mjs` and
  `check-publish-contract.mjs` today, joined by `check-no-suppressions.mjs`,
  `check-docs-contract.mjs`, and — as the tooling measurement above settled — `api-report.mjs`
  rather than an api-extractor configuration. All of them live in the `check` job, none in lefthook,
  and all are reachable through the one root `verify` script.
- **`AGENTS.md` becomes a file that must be maintained.** Its *completeness* is checked — a member
  without one fails `check:docs-contract`. Its *accuracy* is not, and cannot be. That limit is
  stated in the file itself rather than left for a reader to discover the hard way.
- **The `.d.ts` files become a first-class artefact rather than a build by-product**, which
  reinforces a decision already taken: `packages/config/bin/minify-dist.mjs` deliberately preserves
  per-symbol JSDoc and strips only unpublishable file headers, because "that is the API
  documentation of a package whose licence grants free use"
  ([ADR 0022](0022-open-source-the-published-packages.md)). That is also what makes those files a
  sound input for the report.
- **`isolatedDeclarations` errors appear on `pnpm turbo build` and not on a member's `typecheck` or
  in an editor**, because the flag lives on the build configs and a member's `typecheck` script is
  `tsc --noEmit` against `tsconfig.json`. Anyone who does not know that will meet a `TS9010` first
  in CI. It is written into each affected member's `AGENTS.md`, and it is why `verify` runs `build`
  before anything else.
- **A future contributor who wants one of the four rejected rules has a number to argue against
  rather than a taste to argue with.**
- **Two of this record's own numbers were wrong in draft and were corrected by re-measurement, not
  by argument.** The `useExplicitType` breakdown summed to 25 rather than 27 — the `CliIo` row read
  5 while its own note said seven. And a reviewer's claim that an unannotated `export const X = 1;`
  fails `isolatedDeclarations` was adopted without re-running it; measured, it compiles cleanly on
  7.0.2, because the flag permits trivial literal inference. It is not "every export carries a
  written type"; it is "no export requires the checker to look at another file". Both corrections
  are noted here because a count nobody re-ran is a taste with a number attached.
- **The repository acquires an opinion about how it is edited, and that opinion is now in CI.** If
  it turns out to be wrong, the cost of reversing it is one commit per mechanism, and each mechanism
  is independent by construction.

## Follow-ups

- **Re-measure the four rejected rules after phase 1 lands the narrate port and the job runner.** A
  count taken on a 59-source scaffold is evidence about a scaffold. `useExplicitType` in particular
  may look different against real code, and the decision should be revisited with a number rather
  than remembered as settled.
- **Decide whether `apps/desktop` and `packages/skill` should also emit declarations**, which would
  bring them under `isolatedDeclarations` and into the API report. Not now: `desktop` is not
  published and `skill` ships a bundle rather than a library.
- **Treat a rising suppression count as evidence, not as noise.** If `as any`, `@ts-ignore`,
  `@ts-expect-error`, `biome-ignore` or `# noqa` appears, that is evidence the flags are being
  routed around rather than met, and it is a reason to reopen this record. It cannot rise silently:
  the repository has **zero** suppressions today, which is what makes the criterion an equality with
  zero rather than a diff against a baseline, and `check:no-suppressions` fails the build at one.
- **Settle the enum-extension cost.** What it costs a consumer when the `error_code` enum in
  [ADR 0024](0024-durable-jobs-and-boot-reconciliation.md) grows a member depends on the
  compatibility predicate spike **P1-S3** selects, and on whether the generated Python validator can
  be made to tolerate a value it does not know. Until that spike answers both, this record claims
  neither.
