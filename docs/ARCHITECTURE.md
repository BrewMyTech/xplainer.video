# Architecture

The document to read first. It describes the workspace as it is today — a scaffold, with the
render, TTS and job machinery still ahead of it — and says explicitly which parts of that
description a command can prove.

## 1. What this is, and what checks it

A claim inside a `CHECKED` block is **verified by `pnpm check:docs-contract`**. Two sections carry
one — [§3 Members](#3-members) and [§4 Dependency direction](#4-dependency-direction) — and each
block opens with a one-line note naming exactly which of its columns the check reads. Everything
outside those fences is **argument**, and argument has a home of record: the decision and the
reasoning behind it live in [`adr/`](adr/README.md), not here. If this file and an ADR disagree
about *why*, the ADR wins; if this file and the workspace disagree about *what*, the check is what
notices.

Four documents, four jobs:

| File | What belongs in it |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Facts about the layout: who the members are, what depends on what, how a change propagates, what the conventions are and which of them are enforced. |
| [`adr/README.md`](adr/README.md) | The index of decision records. One record per decision, MADR format. **Accepted records are immutable** — add a dated note or supersede with a new number. |
| [`ROADMAP.md`](ROADMAP.md) | What is built and what is not, phase by phase, with the spikes (`P1-S1`, `P1-S3`, `P2-S4`, `P2-S5`) that still have to settle open mechanisms. |
| [`acceptance-criteria.md`](acceptance-criteria.md) | The numbered criteria — `AC-2c`, `AC-7b`, `AC-14d` — that comments, test names and CI step names in this repository cite by id. |

`AGENTS.md` at the root and in each member is the fifth: invariants and recipes for editing that
directory. The canonical post-change procedure is written once, in the root
[`AGENTS.md`](../AGENTS.md), and everything else points at it.

## 2. The shape, in one paragraph

There is **one contract** — `packages/protocol`, JSON Schema as the source of truth, generated into
TypeScript and into pydantic models — and **one server core**: `createMcpServer()` in
`packages/mcp-server` registers the eight tools onto an MCP server over a `RenderBackend` seam, and
`createServer(backend)` in `apps/cli` mounts it into a Hono application alongside `GET /healthz`.
That application is served over **three surfaces**: a TCP loopback listener for GUI clients, an IPC
socket (unix domain socket, named pipe on Windows) for agents, and the `xplainer mcp --attach`
stdio shim that proxies stdio to that socket, which is what `xplainer connect claude|codex` writes
into an agent's configuration. `apps/desktop` is **one optional GUI client** of that daemon and
nothing more. The runtime lives in the CLI, not in Electron
([ADR 0016](adr/0016-cli-first-local-runtime-desktop-is-an-optional-client.md)), and it is a
supervised, always-running, per-user daemon rather than a foreground command
([ADR 0020](adr/0020-always-running-local-daemon.md)). Of that shape, the TCP listener, `/healthz`
and `/mcp` exist today; the IPC socket, the shim's attach mode, the supervisor and the job runner
land at roadmap phases 1 and 2.

## 3. Members

Nine workspace members, from `pnpm-workspace.yaml`'s three globs `apps/*`, `packages/*` and
`services/*`.

<!-- CHECKED:members -->
_Checked columns: **Path**, **Package**, **Tier**, **Published**, **Declarations**, **API report**
and the **AGENTS.md** link target — against `pnpm-workspace.yaml`'s globs, each `package.json`'s
`name`, `private` and `xplainer.tier`, the presence of a `tsconfig.build.json`, and
`check-publish-contract.mjs`'s `PUBLISHABLE_MEMBERS` and `PRIVATE_MEMBERS` lists. **Language** and
**Responsibility** are prose and are not checked._

| Path | Package | Tier | Published | Declarations | API report | Language | Responsibility | AGENTS.md |
|---|---|---|:--:|:--:|:--:|---|---|---|
| `apps/cli` | `@xplainer/cli` | open-later | yes | yes | yes | TypeScript | The `xplainer` binary and the HTTP application — `GET /healthz`, the Streamable HTTP MCP endpoint at `/mcp`, and from phase 1 the job runner. | [AGENTS.md](../apps/cli/AGENTS.md) |
| `apps/desktop` | `@xplainer/desktop` | open-later | no | no | no | TypeScript | Optional Electron client. Resolves a daemon URL and talks to it; holds no render or TTS code. | [AGENTS.md](../apps/desktop/AGENTS.md) |
| `packages/config` | `@xplainer/config` | open-later | no | yes | no | TypeScript | Shared tsconfig presets, the tier-boundary rule, and the three `xplainer-*` build binaries. | [AGENTS.md](../packages/config/AGENTS.md) |
| `packages/mcp-server` | `@xplainer/mcp-server` | open-later | yes | yes | yes | TypeScript | Backend-agnostic registration of the eight tools onto an MCP server, across a `RenderBackend` seam. | [AGENTS.md](../packages/mcp-server/AGENTS.md) |
| `packages/protocol` | `@xplainer/protocol` | open-later | yes | yes | yes | TypeScript + Python | The contract: JSON Schema source of truth plus generated TypeScript types and pydantic models. | [AGENTS.md](../packages/protocol/AGENTS.md) |
| `packages/render-core` | `@xplainer/render-core` | open-later | yes | yes | yes | TypeScript | Remotion template, the ownership-aware video scaffold generator, the narration port that measures scene durations from speech, and the render preflight. | [AGENTS.md](../packages/render-core/AGENTS.md) |
| `packages/skill` | `@xplainer/skill` | open-later | yes | no | no | TypeScript | The agent skill, packaged as a Claude Code plugin bundle and a Codex plugin bundle. | [AGENTS.md](../packages/skill/AGENTS.md) |
| `packages/tts-client` | `@xplainer/tts-client` | open-later | yes | yes | yes | TypeScript | Kokoro-FastAPI request and response shaping: the two endpoints and the payload flags narration depends on. | [AGENTS.md](../packages/tts-client/AGENTS.md) |
| `services/tts-sidecar` | `@xplainer/tts-sidecar` | open-later | no | n/a | no | Python | The pinned Kokoro-FastAPI image and the connection contract. The one Python-only member. | [AGENTS.md](../services/tts-sidecar/AGENTS.md) |
<!-- /CHECKED:members -->

**Published, emits declarations and has a report are three different sets.** Six members are
published (`Published: yes`). Six emit declarations — the ones with a `tsconfig.build.json` — and
they are not the same six: `packages/skill` is published but builds a bespoke bundle with
`node scripts/build.mjs` and has no TypeScript surface, while `packages/config` is
`private: true` but does emit declarations for its consumers inside the workspace. **Five** members
are in both sets, and those five are exactly the ones that carry a committed `api/*.api.md` report.
Reading the three columns as one is the mistake this table exists to prevent.

Every member declares `xplainer.tier`, and every member in this repository is `open-later`. The
`hosted` tier still exists in the rule ([ADR 0003](adr/0003-tier-boundary-and-open-later-plan.md))
and has no members here: it was relocated to a private repository by
[ADR 0023](adr/0023-split-the-repository.md).

## 4. Dependency direction

<!-- CHECKED:deps -->
_These are the **actual** edges, compared for equality against the graph declared in the
`package.json` files — not a permission list. Checked: the three table columns **From** (workspace
path), **To** (package name) and **Kind** (`dependencies`, `devDependencies`, `peerDependencies` or
`optionalDependencies`), plus the **banned-specifier list** below against `biome.json`'s
`noRestrictedImports`. The seven `→ @xplainer/config` devDependency edges are excluded by rule:
every member takes the tsconfig presets, so the edge carries no architectural information._

| From | To | Kind |
|---|---|---|
| `apps/cli` | `@xplainer/mcp-server` | dependencies |
| `apps/cli` | `@xplainer/protocol` | dependencies |
| `apps/desktop` | `@xplainer/cli` | dependencies |
| `packages/mcp-server` | `@xplainer/protocol` | dependencies |
| `packages/render-core` | `@xplainer/protocol` | dependencies |
| `packages/render-core` | `@xplainer/tts-client` | dependencies |
| `packages/skill` | `@xplainer/protocol` | devDependencies |

Banned specifiers — no file in an open-later root may import these:

- `@xplainer/api`
- `@xplainer/web`
- `@xplainer/media-service`
<!-- /CHECKED:deps -->

`check-docs-contract.mjs` parses exactly that three-column row form and fails with a
`docs-contract: deps:` diagnostic on a row it cannot parse, so a malformed row is a failure rather
than a silent skip. It also asserts that every specifier `biome.json` bans appears in the list
above, so the two cannot disagree.

**What is *permitted* is a different question, enforced by two other mechanisms.** The table above
records what **is**; neither of the following reads it:

- **The tier rule** ([ADR 0003](adr/0003-tier-boundary-and-open-later-plan.md), `AC-3`): a `hosted`
  package may depend on an `open-later` one, never the reverse, because the reverse edge would drag
  a private package into the phase-5 open-source extraction. Enforced by `pnpm lint:tiers`, which
  builds the graph from the manifests and feeds it to `checkTierGraph()` in `packages/config`.
- **The banned specifiers above**, enforced by Biome: the `noRestrictedImports` override covers
  `packages/**`, `apps/cli/**`, `apps/desktop/**` and `services/tts-sidecar/**` — the four
  open-later roots (`AC-3e`). Those three packages are the relocated hosted tier; the rule stays so
  that re-introducing one of them by import is a lint error rather than a discovery.

An equality check that reads as a permission list is how a forbidden edge gets documented into
legitimacy, so the two are stated apart on purpose.

**Direction of travel.** `packages/protocol` is the sink — it depends on nothing in the workspace,
and four members depend on it. `apps/cli` composes `mcp-server` and `protocol`. `apps/desktop`
depends only on `apps/cli`, and takes it as an **injected** production dependency
(`injectWorkspacePackages: true`, `dedupeInjectedDeps: false`) so that electron-builder packs a real
directory rather than a symlink.

## 5. The contract layer

`packages/protocol` is the single source of truth for the eight tools. The propagation direction is
one way, and getting it backwards is the most common first mistake:

```
schemas/**            (hand-written; includes schemas/manifest.json, an INPUT)
      |
      v
scripts/codegen.mjs
      |
      +--> src/generated/types.ts        +  src/generated/manifest.ts
      +--> python/xplainer_protocol/generated/models.py  +  .../manifest.py
                 |
                 v
            TOOL_NAMES  --->  createMcpServer()  --->  tools/list
```

`schemas/manifest.json` is a **data document listing the tools**, not a schema describing a value,
which is why `codegen.mjs`'s `schemaFiles()` excludes it from the schema sweep and reads it
separately for the tool names and their order. That order is the contract order.

The eight names — `explainer_create`, `explainer_put_source`, `explainer_put_media`,
`explainer_narrate`, `explainer_still`, `explainer_render`, `explainer_job`, `explainer_list` — are
fixed (`AC-9b`), and `tools/list` equals the manifest by construction because `createMcpServer()`
iterates `TOOL_NAMES` (`AC-14d`).

Two rules an agent breaks first:

1. **Never hand-edit anything under `generated/`.** Both languages' output is regenerated from the
   schemas; an edit there is discarded on the next `pnpm --filter @xplainer/protocol codegen`.
2. **A `schemas/**` change requires codegen in the same commit.** `AC-9c` runs codegen and then
   `git diff --exit-code` over both generated trees, and CI runs it as its own step (`AC-9d`). This
   only holds because codegen is deterministic: the generators are pinned to exact versions and
   `datamodel-code-generator` is invoked with `--disable-timestamp`.

`packages/protocol` is the only dual-language member, so each of its four scripts chains its Python
half (`lint` → `lint:py`, and so on) and a single Turbo task exercises both languages (`AC-2e`).

## 6. The runtime

**What exists today.** `apps/cli/src/server.ts` builds one Hono application — `GET /healthz`
returning `{status, version}`, `POST /mcp` speaking Streamable HTTP, and `GET`/`DELETE /mcp`
answering `405` — and `startServer()` binds it on `127.0.0.1:8787` by default. The eight tools are
registered and return "not implemented in this phase" payloads
([ADR 0008](adr/0008-async-job-model-poll-and-progress-no-agent-webhooks.md)). `mcp`, `setup`,
`connect` and `daemon` are registered stub commands that name themselves on stderr and exit `2`.
There is no supervisor, no IPC listener, no guard middleware, no state on disk and no job store.
**Almost everything in the rest of this section is phase 1 or phase 2**, and each paragraph says
which.

**Process model (phase 2, [ADR 0020](adr/0020-always-running-local-daemon.md)).** `xplainer serve`
becomes an installed, supervised, per-user daemon — systemd user unit, LaunchAgent, or Windows
Scheduled Task — installed by `xplainer daemon {install,uninstall,start,stop,restart,status,logs}`,
running as the user and never as root, and never needing an administrator at install.

**The two listeners (phase 2).** One application, two bindings: the TCP loopback listener, and a
unix domain socket (named pipe on Windows) inside a `0700` directory. `xplainer connect` writes a
**stdio** entry pointing at `xplainer mcp --attach`, which proxies to that socket, so no URL and no
token enter an agent configuration file. A browser can neither open a unix socket nor spawn a
process, which is what puts the DNS-rebinding class structurally outside the path agents use. The
TCP listener keeps a **guard middleware** — origin and host checks plus a bearer token — because it
is the surface a web page can reach.

**Two state files, opposite lifetimes (phase 2).** `daemon.json` is **durable**, written by
`install`, and must survive reboot; it records the port, socket path, token file path, supervisor
kind and artefact path, resolved program and interpreter, lingering, log sink and installing
version. `runtime.json` is **ephemeral**, written by `serve` at bind, removed on clean shutdown, and
never trusted without a liveness check. The port is decided once, at install, and the recorded port
is a contract — `connect`, `status`, `logs` and the desktop client all read it rather than guessing.

**Exit codes.** One table, and a new code is added to it and to the successor of the record that
owns it, never invented at the call site.

| Code | Meaning | Owner | Status |
|---:|---|---|---|
| `0` | Clean shutdown, or a deliberate stall | ADR 0020 | phase 2 |
| `2` | Command exists but does nothing yet (`NOT_IMPLEMENTED_EXIT_CODE`) | `apps/cli/src/not-implemented.ts` | **built** |
| `3` | Precondition unmet | ADR 0020 | phase 2 |
| `4` | Installed but not healthy | ADR 0020 | phase 2 |
| `5` | Administrator privileges required | ADR 0020 | phase 2 |
| `6` | No supported supervisor | ADR 0020 | phase 2 |
| `7` | Port or label conflict | ADR 0020 | phase 2 |
| `8` | Contract skew between shim and daemon | ADR 0025 | phase 1 |
| `10` | The recorded port is taken | ADR 0020 | phase 2 |
| `11` | State file unreadable | ADR 0020 | phase 2 |
| `12` | Token file missing — it cannot enforce authentication, so it must not serve | ADR 0020 | phase 2 |
| `70` | Internal error | ADR 0020 | phase 2 |

**Job lifecycle (phase 1, [ADR 0024](adr/0024-durable-jobs-and-boot-reconciliation.md)).** Five
states, and a job is always in exactly one of them: `queued`, `running`, `done`, `error`,
`cancelled` (`schemas/job-state.json`). `serve` is the only writer. Four properties are **decided**:

- **Exclusive ownership first.** `serve` acquires exclusive ownership of the state directory,
  *then* reconciles, *then* binds. The ordering is the invariant.
- **Durability.** Job records outlive the process that wrote them, under the durable state directory
  in a `jobs/` subdirectory.

  > *Proposed mechanism, to be confirmed by spike P1-S1:* one JSON file per job under an
  > exclusively-owned directory, versus `node:sqlite` in WAL mode. The ownership primitive, the
  > per-platform force of a directory flush and the means of confirming a worker's identity are
  > P1-S1's too.

- **Boot reconciliation.** Every `queued` or `running` job whose recorded pid is not alive, or whose
  recorded daemon boot-id differs from this one, is rewritten to `status: "error"`,
  `exit_code: null`, `error_code: "daemon_restarted"`, a `finished_at`, and a final `output.lines`
  entry. The agent's next `explainer_job` poll gets a terminal, explained, retryable answer — not a
  `404`, and not a `running` that never advances. This covers all three queueing tools, not renders
  alone.
- **An unknown format version is a rollback signal, not corruption**, so state written by a newer
  version is preserved rather than deleted.

**Drain (phase 1 behaviour, phase 2 reach).** `SIGTERM` stops new jobs with a named "shutting down"
error, gives in-flight jobs at most **20 s** to checkpoint, hard-stops Chrome and ffmpeg children,
marks anything still `running` *or* `queued` as `error` with `error_code: "daemon_shutdown"`,
removes `runtime.json` and the socket, and exits `0` — the portable "do not restart" signal on all
three supervisors. Twenty seconds plus teardown fits inside the 25-second budget.
> *Proposed mechanism, to be confirmed by spikes P2-S4 and P2-S5:* how each supervisor is persuaded
> to allow a daemon-controlled drain — systemd's `KillMode` and `TimeoutStopSec` are P2-S4's, the
> per-platform restart adapters are P2-S5's. The drain's behaviour and its 20-second cap are decided.

**Upgrade boundary ([ADR 0025](adr/0025-daemon-updates-and-readiness.md)).** The package manager
updates the daemon; the daemon never self-updates. The sequence is **stage → drain → switch →
restart → verify → roll back**, where *switch* means editing what the **supervisor** launches, not
only the path `daemon.json` records — rewriting `daemon.json` alone leaves `ExecStart` pointing at
the old copy and reports success. Staging is the post-install hook's work, never the daemon's. On a
readiness timeout the replacement is stopped *before* anything else is started, so two daemons never
contend for exclusive ownership.

**Version skew.** `xplainer mcp --attach` is spawned per session; the daemon is not, so a Tuesday
shim can meet a Monday daemon. An incompatible pair exits `8`, naming both versions and a command
the user can actually run at that point.
*Settled by spike P1-S3 on 2026-09-06 ([ADR 0025](adr/0025-daemon-updates-and-readiness.md)
§Note, 2026-09-06: P1-S3 settled).* The daemon advertises the contract version as `contract_version`
in the `/healthz` body — readable before an MCP session exists, which an `initialize` result is not.
`serverInfo.version` is **not** the contract version: `apps/cli/src/server.ts` passes `CLI_VERSION`
into `createMcpServer`, so the handshake reports the release number, and both numbers now appear
side by side in that one body. `MCP_CONTRACT_VERSION` lives in `@xplainer/protocol`, which also
exports `isContractCompatible(daemon, shim)`; the predicate is **major-compatible**, so an additive
change attaches and only a removal refuses.

**Readiness ([ADR 0025](adr/0025-daemon-updates-and-readiness.md), phase 1).** The daemon announces
readiness exactly once — after ownership is acquired, reconciliation has finished and both listeners
are bound — and parents wait for the announcement rather than sleeping. The primary mechanism on
every platform is **one line of JSON on stdout**. A parent that spawned the daemon itself reads it
from the pipe; a post-install hook restarting a *supervised* daemon cannot, because that stdout goes
to the supervisor's log sink, so it waits on a supervisor-native report or an authenticated,
bounded `GET /healthz` poll.
> *Proposed mechanism, to be confirmed by spike P2-S4:* systemd `Type=notify`. `$NOTIFY_SOCKET` is
> an `AF_UNIX` datagram socket and `node:dgram` is UDP-only, so `sd_notify` costs a dependency or a
> native addon. ADR 0020's `Type=exec` is **not** amended until the spike settles.

## 7. The public surface, and how it is pinned

Two mechanisms, aimed at the same thing: an agent should be able to read a package's exported
surface without running a type checker, and a change to that surface should be visible in review.

**`isolatedDeclarations`.** It does not change what is emitted; it makes the compiler *error* where
emitting a declaration would need cross-file inference. It is set on the **`tsconfig.build.json`**
files only — six of them — so:

- `pnpm turbo build` is what surfaces `TS9010` and its siblings;
- a member's `typecheck` script is `tsc --noEmit` against `tsconfig.json`, which does **not** carry
  the flag, and **your editor reads the same file**, so the error will not appear as you type;
- tests are out of scope, because each build config excludes `src/**/*.test.ts`;
- but every exported symbol in every `src/` module *is* in scope, not just the entry point.

The fixes are small and mechanical. The seven that landed, as worked examples:

| Where | Error | Fix |
|---|---|---|
| `packages/mcp-server/src/put-source-guard.ts` — `EngineOwnedPathError.code` | TS9012 | `readonly code: typeof ENGINE_OWNED_PATH_ERROR_CODE = …` |
| `packages/mcp-server/src/server.ts` — `MCP_SERVER_NAME` | TS9010 | `export const MCP_SERVER_NAME: string = manifest.name;` |
| `packages/protocol/src/generated/manifest.ts` — `MCP_CONTRACT_VERSION` | TS9010 | **generator change** in `scripts/codegen.mjs`: `export const MCP_CONTRACT_VERSION: string = "…";`. It moved out of `packages/mcp-server/src/server.ts` with spike P1-S3 and is re-exported from there. |
| `packages/protocol/src/generated/manifest.ts` — `TOOL_NAMES` | TS9010 | **generator change** in `scripts/codegen.mjs`: emit the literal tuple type before `Object.freeze([…])` |
| `packages/protocol/src/generated/manifest.ts` — `ENGINE_OWNED_FILES` | TS9010 | **generator change**, same shape |
| `packages/render-core/src/scaffold/index.ts` — `ENGINE_OWNED_FILES` | TS9010 | `export const ENGINE_OWNED_FILES: typeof ENGINE_OWNED_FILES_FROM_PROTOCOL = …` |
| `packages/render-core/src/scaffold/index.ts` — `SCAFFOLD_FILES` | TS9018 | `export const SCAFFOLD_FILES: readonly (EngineOwnedFile \| AgentOwnedFile)[] = […]` — **not strictly type-preserving**: it widens a six-element tuple to an array. `ScaffoldFile` resolves to the same union either way and nothing indexes by position, so the widening is accepted and stated. |

A fix inside `generated/` is a fix in `packages/protocol/scripts/codegen.mjs`, and it must keep
`AC-9c`'s determinism: the annotation is derived from the same schema data the values are, so a
re-run is byte-identical.

`apps/desktop` deliberately does **not** get the flag: it emits no declarations, and
`electron.vite.config.ts`'s default export is required by Vite.

**The API reports.** Five members carry a committed `api/<name>.api.md` — `apps/cli`,
`packages/mcp-server`, `packages/protocol`, `packages/render-core`, `packages/tts-client` — the
intersection of published and declaration-emitting. `pnpm api:report` regenerates them and
`pnpm check:api-report` fails if the committed file differs.

**What a PR that changes an export looks like.** The `.api.md` diff is the first thing a reviewer
sees, and it is a plain-text rendering of the entry-point-rooted surface. Adding an internal helper
changes nothing there. Adding an export to a barrel changes it by a line, and that line is the
review. So: after changing any `export` in a built package, run `pnpm api:report` and commit the
result — an unreviewed surface change and a red gate are the same event.

## 8. Conventions

Each one says whether it is enforced, and by what. "Convention, not enforced" is not an apology; it
is the honest label, and [`AGENTS.md`](../AGENTS.md)'s first principle is that an unenforced rule is
a suggestion.

**Enforced.**

- **Named exports only.** `noDefaultExport`, Biome, error. One override:
  `apps/desktop/electron.vite.config.ts`, where Vite requires the default export.
- **No `export *`.** `noReExportAll`, Biome, error. A barrel lists what it re-exports, so grep finds
  the declaration site.
- **Kebab-case filenames.** `useFilenamingConvention` with `filenameCases: ["kebab-case"]`, Biome,
  error — with **one deliberate exception**: React component files under
  `apps/desktop/src/renderer/` may also be `PascalCase`, by a scoped override in `biome.json`.
- **No `any`, no non-null assertion, no `enum`, no unused imports.** `noExplicitAny`,
  `noNonNullAssertion`, `noEnum`, `noUnusedImports` — all Biome, all error.
- **No placeholders in committed source.** No `TODO`, `FIXME`, `.skip(` or `.only(` anywhere under
  `apps/`, `packages/`, `services/` — `AC-2c`, a CI grep on a pristine tree.
- **The four-scripts rule.** Every TypeScript member declares `build`, `lint`, `typecheck` and
  `test`; `services/tts-sidecar` declares the last three and no `build`. Turbo **silently skips** a
  member that does not declare a task, so a missing script is indistinguishable from clean code.
  `AC-2b`, `AC-2f` and `AC-2g` count the tasks per member in CI, which is the only thing that
  catches it.
- **Every `uv run` carries `--no-sync`.** A uv workspace shares one environment and `uv run` is
  exact by default, so a bare member-scoped run prunes the other member out of the shared
  environment — and a bare *root*-scoped run prunes both. The argument is in `pyproject.toml`; do
  not rediscover it.

**Convention, not enforced.**

- **One concept per file, and the filename names the concept.** `put-source-guard.ts` holds the
  put-source guard. The kebab-case rule is enforced; the correspondence is not.
- **Error codes are string-literal unions in `packages/protocol`**, never bare strings at the throw
  site. `job-error-code.json` is where a code is added, and adding one to the enum is an
  [open question](adr/0024-durable-jobs-and-boot-reconciliation.md), not a settled minor bump.
- **Cite ADR numbers in module headers.** Already the house style across this repository —
  `packages/config/src/tiers.ts`, `packages/mcp-server/src/put-source-guard.ts` and
  `packages/render-core/src/scaffold/index.ts` all open by naming the record they implement. Keep it:
  it is the only thing that connects a line of code to the argument for it.
- **Test titles are sentences that state the behaviour**, not names of functions. `AC-2d` asks for
  behaviour rather than existence; the phrasing is convention.

**The compiler settings, and why each is on.** `packages/config/tsconfig/base.json` carries them
without comment — it is a JSON file that other tools parse — so the rationale lives here. Every one
of them was measured against all eight TypeScript members before it was adopted:

| Flag | Why |
|---|---|
| `strict`, `isolatedModules`, `verbatimModuleSyntax`, `moduleDetection: force` | Baseline: every file is a module, imports mean what they say, and each file compiles alone. |
| `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch` | Three ways a refactor silently changes behaviour. Cost measured: **0 errors**. |
| `allowUnreachableCode: false`, `allowUnusedLabels: false` | Dead code that survives a review is dead code an agent will extend. Cost: **0 errors**. |
| `erasableSyntaxOnly` | Nothing may compile to emitted runtime code, so the build stays a type erasure. Cost: **0 errors**. |
| `noUnusedLocals`, `noUnusedParameters` | An abandoned local is the residue of a half-finished edit. Cost: **0 errors**. |
| `noUncheckedIndexedAccess` | `arr[i]` is `T \| undefined`, because it is. Cost: **8 errors**, fixed. |
| `exactOptionalPropertyTypes` | `{ x?: number }` does not accept `{ x: undefined }`, which is what the option-object callers here actually mean. Cost: **5 errors**, fixed. |
| `noPropertyAccessFromIndexSignature` | **Rejected.** 32 errors, 30 of them in tests that walk `JSON.parse` results and JSON Schema objects. Its remedy turns `schema.properties` into `schema["properties"]`, so a reader greps for `properties` and finds two forms — the opposite of what this document is for. |

## 9. How to add X

Each recipe ends in `pnpm verify`, which is the canonical post-change procedure and is defined once
in the root [`AGENTS.md`](../AGENTS.md).

### A new workspace member

1. Create the directory under `apps/`, `packages/` or `services/` — the three globs in
   `pnpm-workspace.yaml` pick it up with no edit there.
2. Write `package.json` with `name`, `xplainer.tier` (`AC-3a`), and **all four scripts**: `build`,
   `lint` (`biome check .`), `typecheck` (`tsc --noEmit`), `test` (`vitest run`). A Python-only
   member omits `build` and wraps the other three in `uv run --no-sync --project .`.
3. Add `@xplainer/config` to `devDependencies` and extend a preset from
   `packages/config/tsconfig/`.
4. Add the member to `PUBLISHABLE_MEMBERS` **or** `PRIVATE_MEMBERS` in
   `scripts/check-publish-contract.mjs`. There is no third option: the checker fails on a member it
   does not know, in either direction.
5. If it is publishable, it also needs a `README.md` — or its npm page renders blank — plus
   `license`, `homepage`, `author` and a `repository` whose `directory` names this member. The
   same checker asserts all five, and each rule there carries its own negative test.
6. If it is published *and* has a `tsconfig.build.json`, it needs an `api/` report — run
   `pnpm api:report`.
7. Write its `AGENTS.md` and its one-line `CLAUDE.md`, and add its row to
   [§3 Members](#3-members).
8. `pnpm install` (a new member changes the workspace), then `pnpm verify`.

### A new MCP tool

1. Add `schemas/tools/<name>.input.json` and `<name>.output.json` in `packages/protocol`.
2. Add the tool to `schemas/manifest.json` — name, title, description. Manifest order is contract
   order.
3. `pnpm --filter @xplainer/protocol codegen`, and commit the regenerated TypeScript and Python
   **in the same commit** (`AC-9c`).
4. Export the generated input and output types from `packages/protocol/src/index.ts`. The barrel is
   an explicit named-export list, not a `export *`: a generated type nothing adds there is a type no
   consumer can import.
5. Nothing to *register* by hand — `createMcpServer()` iterates `TOOL_NAMES` — but three
   hand-written surfaces still name the tools one at a time, and all three stop compiling until you
   extend them: the `RenderBackend` interface in `packages/mcp-server/src/backend.ts`,
   `createStubBackend()` in `apps/cli/src/backend.ts`, and whatever real backend implements the
   seam. `server.test.ts` asserts `Object.keys(backend)` equals `TOOL_NAMES`, so a missing method is
   a failing test rather than a runtime surprise.
6. Update `packages/skill/SKILL.md` — its `explainer_*` names are asserted against `TOOL_NAMES` in
   `build.test.ts`.
7. `pnpm api:report`, and commit `packages/protocol/api/protocol.api.md` — `TOOL_NAMES` is pinned
   there as a literal tuple of the eight names — and `packages/mcp-server/api/mcp-server.api.md`,
   which changes with `RenderBackend`. Codegen alone leaves `pnpm check:api-report` red.
8. `pnpm changeset`. A new tool is user-visible in every published package that names it.
9. Note that the eight names are fixed by `AC-9b`; a ninth tool is a change to that criterion, made
   deliberately.
10. `pnpm verify`.

### A new field on an existing schema

1. Edit the schema under `packages/protocol/schemas/`. It is the only source of truth.
2. `pnpm --filter @xplainer/protocol codegen`; commit the generated output in the same commit.
3. Never touch `src/generated/` or `python/xplainer_protocol/generated/` by hand.
4. A new **required** field is a breaking change to the contract; a new optional one is not. A new
   `error_code` enum member is a **minor** change — move the minor component of
   `schemas/manifest.json`'s `version` and nothing else, because both generated decoders fall back
   to `internal` on a member they do not know ([ADR 0024](adr/0024-durable-jobs-and-boot-reconciliation.md)
   §Note, 2026-09-06: P1-S3 settled).
5. If the field changes an exported declaration, `pnpm api:report` and commit the `.api.md`.
6. Add a changeset if the change is user-visible in a published package.
7. `pnpm verify`.

### A new CLI command

1. Add the command module under `apps/cli/src/commands/`, one concept per file, kebab-case.
2. Register it in `apps/cli/src/program.ts`. Until it does something, register it as a stub that
   names itself and exits `NOT_IMPLEMENTED_EXIT_CODE`.
3. Update the command-surface assertion — it is a `toEqual`, never widened to `toContain`
   (`AC-14b`).
4. A new exit code goes in [§6's table](#6-the-runtime) and in the ADR that owns it, not into the
   call site.
5. `pnpm verify`.

### A new ADR

1. Take the next free number. Never reuse a tombstoned one — see [`adr/README.md`](adr/README.md).
2. Use MADR headings: `## Context and Problem Statement`, `## Decision Drivers`,
   `## Considered Options`, `## Decision Outcome`, `## Consequences` (`AC-5b`).
3. Record who settled it and what settled it, and link the records it builds on.
4. **Never rewrite an accepted record.** Add a dated note to it pointing at the new one, and if the
   new record changes an earlier decision, say in the new record exactly which sentence it amends.
5. Add the row to `docs/adr/README.md`'s index.
6. `pnpm verify`.

## 10. What is deliberately not here

No decision is argued in this file. Every *why* — why the CLI owns the runtime and not Electron,
why the daemon is supervised, why the composition shell is engine-owned, why the repository was
split, why job records are durable, why the package manager owns the update — is a record in
[`adr/`](adr/README.md), and that is where to change it.

**Accepted ADRs are immutable**: correct one by adding a dated note or by superseding it with a new
number, never by editing what it said.
