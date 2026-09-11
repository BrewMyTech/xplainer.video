# Architecture Decision Records

Every stack and contract decision for xplainer.video, one file per decision, in
[MADR](https://adr.github.io/madr/) format. Each record carries `## Context and Problem
Statement`, `## Decision Drivers`, `## Considered Options`, `## Decision Outcome` and
`## Consequences`, and names the interview round that settled it.

On 2026-09-06 this repository was reduced to the local, open-source product and the hosted
tier was **relocated** — deferred pending a vendor answer, not cancelled — to a private
repository. [ADR 0023](0023-split-the-repository.md) is that decision, and it is the one to
read first if a number below is missing or a status line says "relocated".

## Provenance

These records were settled in a structured interview and turned into an executable plan, and
they cite both at section granularity — "round 8", "plan §4 S2.8", "AC-3d". **Those two
documents are not public.** They are preserved in full, with history, in the private
repository:

| | |
| --- | --- |
| Repository | `BrewMyTech/xplainer-hosted` (private) |
| Interview | `.omc/specs/deep-interview-xplainer-monorepo-init.md`, identifier `di-xplainer-20260905` |
| Plan | `.omc/plans/ralplan-xplainer-monorepo-init.md` |
| Commit | `ea4ff39f012166dad59022aae74eee0015eb5d55` — the last commit in this history in which both files were present |

The commit SHA is the load-bearing part. `git show ea4ff39f:.omc/plans/ralplan-xplainer-monorepo-init.md`
resolves for anyone with access to that repository; a bare repository name does not. A pointer
without a commit is a gesture.

**Why they are not public.** Both carry absolute local paths and the name of a private sibling
repository, and both carry hosted commercial planning — a plan shape, a vendor price list, and
172 KB of build plan and interview transcript. Scrubbing the paths was considered and rejected,
because the paths are the smallest problem in either file. `docs/open-questions-resolution.md`,
an internal risk memo with margin arithmetic and an unsent draft email to a supplier, was
removed to the same repository for the same reason; it is not a decision record, so no
immutability convention protected it. The reasoning is in
[ADR 0023](0023-split-the-repository.md).

**One cited document is in neither repository.** [ADR 0019](0019-sequencing-local-cli-before-hosted.md)
links, in its header, the external architecture review it was written to answer:
`.omc/artifacts/ask/codex-…-2026-09-05T08-54-11-831Z.md`. That file was never committed — `.omc/`
was ignored except for the two negated paths above, and it was not one of them — so the link has
been dangling since the record was written, in every clone. It is noted in that record's dated
note of 2026-09-06 rather than quietly repaired. The review's substance survives as ADR 0019's
own quotation and rebuttal of it, which is the part that carries the argument.

**Every in-record citation is left exactly as written.** `plan §4 S2.8` still resolves — inside
the private document. This section is the one place that explains where to resolve it, and that
is what keeps the records immutable and the references honest at the same time.

The phase-0 acceptance criteria left with those documents, and 52 comments, test names and CI
step names in this repository cite them by id. They are rehomed verbatim, under their existing
ids, in [`../acceptance-criteria.md`](../acceptance-criteria.md), with tombstone rows for the
ones that judged hosted work.

## Index

Five numbers are **tombstones**: the record relocated to `BrewMyTech/xplainer-hosted` because
its substance is private business detail — pricing, quotas, billing — rather than architecture.
The rows stay, unlinked, because filenames here are never renumbered and a citation of ADR 0017
must resolve to "relocated" rather than looking like a typo.

| # | Decision | Status |
|---|---|---|
| [0001](0001-monorepo-tooling-pnpm-turbo-uv.md) | Monorepo tooling: pnpm workspaces + Turborepo for TypeScript, a `uv` workspace for Python, one Turbo graph over both | accepted — note 2026-09-06 |
| [0002](0002-language-split-python-control-plane-ts-media-plane.md) | Language split: Python hosted control plane, TypeScript media plane and local runtime | accepted — **hosted half relocated (0023)** |
| [0003](0003-tier-boundary-and-open-later-plan.md) | Tier boundary: `hosted` may import `open-later`, never the reverse — machine-checked from the first commit, with the open-source extraction checklist | accepted — note 2026-09-06 |
| [0004](0004-electron-over-tauri.md) | Electron over Tauri for the desktop client, and the two `.npmrc` settings electron-builder requires | accepted |
| [0005](0005-download-on-first-run-chrome-headless-shell-and-tts.md) | Chrome Headless Shell and the TTS sidecar are downloaded on first run, not bundled in installers | accepted — notes 2026-09-08, 2026-09-10 |
| [0006](0006-kokoro-fastapi-http-contract-as-tts-interface.md) | The Kokoro-FastAPI HTTP contract is the TTS interface; word-level timestamps are the reason | accepted — note 2026-09-10 |
| [0007](0007-mcp-tool-contract-and-put-source.md) | Eight MCP tools with `put_source`, and JSON Schema in `packages/protocol` as the single source of truth for both languages | accepted |
| [0008](0008-async-job-model-poll-and-progress-no-agent-webhooks.md) | Async job model: return `job_id`, agent polls `explainer_job`, servers emit MCP progress — no webhooks to agents | accepted |
| [0009](0009-remote-mcp-and-oauth-2-1-with-external-authorization-server.md) | Remote MCP over Streamable HTTP as an OAuth 2.1 resource server, with an external IdP as the authorization server | accepted — **hosted endpoint relocated (0023)**; kept because it explains why the *local* daemon has no OAuth |
| 0010 | Renders and TTS as Docker containers on a VM, with an ephemeral per-render container as the untrusted-TSX sandbox | **relocated to `BrewMyTech/xplainer-hosted` (0023)** |
| [0011](0011-cloudflare-r2-for-storage-and-delivery-no-aws.md) | Cloudflare R2 (S3 API) for all storage and delivery, behind a custom domain with Cache Rules; no AWS | accepted — **render bucket relocated (0023)**; the delivery primitive stays and now serves release artefacts |
| 0012 | Procrastinate (Postgres-backed) as the hosted job queue | **superseded by 0017; relocated with it (0023)** |
| [0013](0013-plugin-packaging-for-claude-and-codex.md) | One SKILL.md, two plugin bundles built from it: Claude and Codex | accepted — notes 2026-09-06, 2026-09-08 |
| 0014 | The hosted free tier requires sign-in; anonymous IP-based quota is rejected as unenforceable and NAT-hostile | **relocated to `BrewMyTech/xplainer-hosted` (0023)** |
| 0015 | Remotion licensing for self-hosted VM rendering — tier settled against the not-yet-in-force v5.0 terms; what binds today, and two permission questions, still open | **proposed; relocated to `BrewMyTech/xplainer-hosted` (0023)** |
| [0016](0016-cli-first-local-runtime-desktop-is-an-optional-client.md) | CLI-first local runtime: `xplainer serve` is the runtime, the desktop app is an optional client | accepted — notes 2026-09-05, 2026-09-06, 2026-09-08 |
| 0017 | Cloudflare Queues as the hosted job queue, over HTTP pull consumers — supersedes 0012, and trades transactional enqueue for an outbox | **relocated to `BrewMyTech/xplainer-hosted` (0023)** |
| [0018](0018-engine-owns-the-composition-shell.md) | The engine owns the composition shell; the agent writes scenes only, so it cannot delete the narration or captions | accepted |
| [0019](0019-sequencing-local-cli-before-hosted.md) | Sequencing: the local CLI tier ships before the hosted tier — an external review's hosted-first recommendation is recorded and rejected, not dismissed | accepted — note 2026-09-06 |
| [0020](0020-always-running-local-daemon.md) | The local runtime is an installed, supervised, per-user daemon — `systemd --user`, a LaunchAgent, a Scheduled Task; never root, and an always-on loopback listener means the token is a requirement, not a later nicety | accepted — dated notes, latest 2026-09-08 |
| [0021](0021-proprietary-licence-free-to-use.md) | The published packages are proprietary and free to use — `SEE LICENSE IN LICENSE-BINARY`, not open source | **superseded by 0022** |
| [0022](0022-open-source-the-published-packages.md) | The published packages are open source under Apache-2.0 — Remotion is declared as a dependency, never bundled; supersedes 0021 | accepted — note 2026-09-06 |
| [0023](0023-split-the-repository.md) | Split the repository: the local tier is public and open source here, the hosted tier is relocated to a private repository — deferred pending a vendor answer, not cancelled | accepted |
| [0024](0024-durable-jobs-and-boot-reconciliation.md) | Render jobs are durable records under the daemon's state directory, reconciled at boot by the process that exclusively owns it — a job whose owner is gone ends `error` with an `error_code`, never a stuck `running` or a `404` | accepted — dated notes, latest 2026-09-08 |
| [0025](0025-daemon-updates-and-readiness.md) | The package manager updates the daemon; the daemon drains, announces readiness exactly once, and the `mcp --attach` shim exits `8` rather than speaking a skewed contract | accepted — dated notes, latest 2026-09-08 |
| [0026](0026-agent-first-repository-contracts.md) | The repository's contracts are machine-checked — ten `tsconfig` flags, `isolatedDeclarations`, seven Biome rules, nine ruff groups, five committed API reports and a checked `docs/ARCHITECTURE.md` — and `AGENTS.md` is the one agent instruction surface | accepted |
| [0027](0027-relocatable-runtime-artefact-and-the-supervisor-switch.md) | The runtime is a relocatable artefact assembled locally — two payloads with two lifetimes, defined by each package's `files` allowlist — the installer resolves the program it starts, and an update rewrites the supervisor artefact rather than flipping an indirection | accepted |
| [0028](0028-in-process-onnx-speech-and-a-g2p-we-own.md) | Speech runs in the narration worker on ONNX with a grapheme-to-phoneme layer we own — no Python, no espeak, nothing copyleft, and word timings from the model's own duration predictor | accepted |
| [0029](0029-the-agent-path-may-be-http-when-the-token-never-enters-the-config.md) | An agent may reach the daemon over HTTP instead of the socket, because a headers helper keeps the bearer token in its `0600` file — one daemon serves many sessions where the `stdio` shim cost a 98 MB process each | accepted |

### The relocated five, and why each could not stay

The splitting criterion is stated in [ADR 0023](0023-split-the-repository.md): a record that
documents **architecture** stays and is marked; a record whose substance is **private business
detail** leaves. Applied to each:

- **0010** — its Decision Outcome *is* a cost comparison of hosting options. That is hosted unit
  economics. The ephemeral per-render sandbox reasoning is worth having locally and would earn a
  *new* record; it does not earn a relocation of this one.
- **0012** — it exists only as 0017's superseded predecessor. Keeping it while 0017 left would
  publish a record whose supersession pointer dangles into a private repository.
- **0014** — quota per account, the free-plan shape, and the cost argument behind them. It
  describes nothing this repository contains.
- **0015** — headcount-band cost analysis and per-video margin, on a record still `proposed`
  against unresolved legal exposure. Its one user-facing obligation — a company above three
  people needs its own Remotion licence — is discharged by the disclosure sentence ADR 0022
  requires, on surfaces a user reads before installing.
- **0017** — a full vendor cost model with projected volumes, plus the quota-ledger and outbox
  design.

## Amendments without supersession

ADR 0016 and ADR 0014 each carry a dated note pointing at
[ADR 0019](0019-sequencing-local-cli-before-hosted.md): 0016 because it decided which process
owns the local runtime but not when it ships, and 0014 because its sign-in requirement is
scoped to the hosted tier and the local tier stays free and unlimited. Neither accepted
record was rewritten. (ADR 0014 is now in the private repository; its note travelled with it.)

ADR 0016 and ADR 0019 each carry a further dated note pointing at
[ADR 0020](0020-always-running-local-daemon.md): 0016 because it decided which process owns
the local runtime but not how that process is supervised, and 0019 because always-on narrows
one row of its Dissolved table. ADR 0020 is the second record to amend an accepted one without
superseding it — ADR 0018 was the first, against ADR 0007 — and the first to **reverse** a
stated consequence rather than add to one: 0016's "The daemon has no authentication and binds
localhost" was written for a foreground command a human starts and stops, and an always-on
loopback listener is reachable from any web page the user visits, so the local bearer token,
the `Host` allowlist and `Origin` validation become requirements of the local daemon rather
than deferred work. Both 0016 and 0019 stay `accepted` and neither is rewritten; the amendment
is argued in 0020 and pointed at from each.

ADR 0003 carries a dated note pointing at
[ADR 0021](0021-proprietary-licence-free-to-use.md), which settled the licence the published
packages ship under, and a second note pointing at
[ADR 0023](0023-split-the-repository.md), which records that the extraction its checklist
describes has now happened, that checklist item 1 is discharged, and that the npm tier check's
real-graph half is consequently vacuous.

ADR 0001, ADR 0013, ADR 0019 and ADR 0022 each gained a dated note on 2026-09-06 recording what
[ADR 0023](0023-split-the-repository.md) changed underneath them: the `uv` workspace narrowing
to two members and the import-linter contract retiring (0001); both `.mcp.json` bundles moving
to a local stdio transport (0013); two cited documents relocating (0019); and the repository
decision that 0022 explicitly deferred being taken (0022). **No body was rewritten in any of
them.**

ADR 0008 carries a dated note of 2026-09-06 pointing at
[ADR 0024](0024-durable-jobs-and-boot-reconciliation.md). ADR 0008 fixed the **shape** of a job —
a `job_id` returned immediately, five states, an agent that polls `explainer_job` — and
deliberately left the queue implementation open. ADR 0024 fills that gap on the local tier: where
the record lives, who is allowed to touch it, and what happens to it when the daemon dies without
warning. It adds the one thing ADR 0008's contract implies but does not state — that **polling
terminates across a restart** — and one field, `error_code`, to the returned shape, before
`packages/protocol`'s first publish. ADR 0008 stays `accepted` and is not rewritten.

ADR 0020 carries a dated note of 2026-09-06 pointing at **both**
[ADR 0024](0024-durable-jobs-and-boot-reconciliation.md) and
[ADR 0025](0025-daemon-updates-and-readiness.md): 0024 because ADR 0020 required that a render
whose process dies must never stay stuck in `running` without saying what re-establishes that once
the process is gone, and because exclusive ownership — not the recorded port — is what makes the
single-writer property true at reconciliation time; and 0025 because ADR 0020's own accepted cost,
a copy of the interpreter and the CLI pinned under the state directory, has an upgrade consequence
it does not spell out, and because a parent needs a readiness announcement rather than a sleep.
**That note is a pointer, not a value change.** `Type=exec` **stands** in ADR 0020; the concrete
defect is named — the unit reports active as soon as `execve` succeeds, which is before the port is
bound — and whether the fix is `Type=notify` or a readiness wait in the installer is open pending
spike **P2-S4**. Round 1 of the plan that produced 0024 and 0025 proposed amending the `Type=`
value and that proposal was withdrawn. ADR 0020 stays `accepted` and is not rewritten.

**Six records gained a dated note of 2026-09-08 pointing at
[ADR 0027](0027-relocatable-runtime-artefact-and-the-supervisor-switch.md), and no body was
rewritten in any of them.** ADR 0027 is the phase-2 distribution record: what the supervisor
actually starts, where it comes from on a machine with no Node and no published package, and what
happens to it when it is replaced. Each note records only what happened underneath its own record.

| Record | What its note adds |
|---|---|
| [0005](0005-download-on-first-run-chrome-headless-shell-and-tts.md) | The visible first-run step now acquires **three** artefacts — the render workspace joins Chrome and speech — the manifest's Chrome digest is an *expected* value captured at manifest-build time rather than a trust anchor, nothing is published to R2, and the phase-2 speech criterion is therefore **pending on Windows** |
| [0013](0013-plugin-packaging-for-claude-and-codex.md) | `xplainer mcp` is real, so half of that record's submission bar is discharged; the other half is the publish, and both bundles declare `npx -y xplainer mcp` |
| [0016](0016-cli-first-local-runtime-desktop-is-an-optional-client.md) | The optional client spawns the packaged runtime artefact rather than an `ELECTRON_RUN_AS_NODE` child, resolves its program in two stages, and has a **third** discovery branch — neither spawn nor attach — fed by `status --json` |
| [0020](0020-always-running-local-daemon.md) | The degraded paths as built; exit `5`, `6`, `7` and the `7`-versus-`10` distinction; `ProcessType=Interactive`; enable-before-bootstrap; the **per-user** Windows task name superseding the fixed one in its own table; `uninstall` deleting the token and never touching lingering; and the outcome field `recentStarts[]` turned out to need, whose design is ADR 0027's |
| [0024](0024-durable-jobs-and-boot-reconciliation.md) | The two things its P2-S5 note deferred: the Windows Job Object that closes `process-group.ts`'s grandchild gap, and the breaker's **measured** 30,000 ms boundary, inclusive, against each run's own recorded end |
| [0025](0025-daemon-updates-and-readiness.md) | Its six-step update sequence as built, with recovery **commanded rather than automatic**, and the one class of update that is refused before the drain — an incoming runtime whose template pins do not match the installed workspace |

Six is the widest set of records any one amendment here has touched, and the convention holds
unchanged for all of them: the argument lives in ADR 0027's own body, each amended record keeps its
status and its text, and its note is a pointer plus what changed underneath it.

ADR 0005 and ADR 0006 each gained a dated note of 2026-09-10 pointing at
[ADR 0028](0028-in-process-onnx-speech-and-a-g2p-we-own.md), and **neither body was rewritten.**
ADR 0005 because its download-on-first-run decision is now implemented for speech — and implemented
without the CDN and the per-OS artefact manifest its own first Consequence booked as
infrastructure, because every byte of the new route comes from its component's upstream home. ADR
0006 because ADR 0028 is the first thing to amend a *reason* rather than a decision or a
consequence: its second Decision Driver argued that the contract had to be a **network** contract
and not a library API, because two backends — a hosted container and a per-OS local install — had to
satisfy it. The hosted container relocated ([ADR 0023](0023-split-the-repository.md)) and speech now
runs in the narration worker's own process, so that driver has lost both halves of its premise while
the decision it justified stands untouched: the HTTP contract is still the contract, two of the four
speech routes still speak it, `packages/tts-client` still pins the payload, and the record's *first*
driver — word-level timestamps are non-negotiable — is exactly what selected ADR 0028's engine.
A note that retires a justification while leaving the decision in force is a third kind, beside
ADR 0018's addition and ADR 0020's reversal of a stated consequence, and it is recorded here so the
next one has a precedent to follow.

## Licence

The six packages published to npm under the `@xplainer/` scope — `apps/cli`,
`packages/{mcp-server,protocol,render-core,skill,tts-client}` — are **Apache-2.0**
([ADR 0022](0022-open-source-the-published-packages.md)). The full text is
[`LICENSE-APACHE-2.0`](../../LICENSE-APACHE-2.0) at the repository root, a copy travels inside
each published tarball, and [`NOTICE`](../../NOTICE) is the attribution notice Apache-2.0
§4(d) propagates.

**Everything else in this repository is proprietary today.** [`LICENSE`](../../LICENSE) Part
Two covers `apps/desktop`, `packages/config`, `services/tts-sidecar`, `infra/`, `scripts/`,
`docs/` and every other root file. Those three members are `open-later` — on the path to being
opened, not opened. Making the repository *public* did not relicense them, and
[ADR 0023](0023-split-the-repository.md) says so in as many words; doing it is a separate
decision that has not been taken.

`LICENSE-BINARY`, referenced by ADR 0003, ADR 0019 and ADR 0021, **no longer exists.** It was
the proprietary free-to-use licence ADR 0021 chose, and ADR 0022 retired it. Those records are
`accepted` or `superseded` and are not rewritten; a citation of `LICENSE-BINARY` in a record
body is history, and this paragraph is where it resolves.

## Conventions

- Filenames are `NNNN-kebab-case-title.md`, numbered in decision order and never renumbered.
  A relocated record leaves its number behind as a tombstone row in the index above.
- A record is **immutable once accepted**. Changing a decision means a new record that
  supersedes the old one, with both statuses updated to say so. Adding a **dated note** is how
  a record acknowledges something that happened underneath it without rewriting its argument;
  ADR 0018 was the first to do it and there are now several.
- **Relocation is not supersession and not deletion.** A relocated record's decision still
  stands; it is judged and maintained in another repository. Its status line says where, and
  its body is untouched.
- `proposed` means the decision is written down but not settled. ADR 0015 was the only one, and
  it relocated with the hosted tier while still `proposed`.
- `superseded` means the record is history and stays readable. ADR 0021 is the one in this
  repository: ADR 0022 reversed it on the merits and names what it gave up. ADR 0012 was the
  other, and relocated with ADR 0017 so that the pointer between them stays inside one
  repository.
- New records are added when a stack or contract decision is made — not for implementation
  details that a reader can get from the code.
