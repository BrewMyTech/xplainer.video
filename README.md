# xplainer.video

**Agent-driven explainer videos, rendered on your own machine.**

An agent — Claude Code or Codex — writes [Remotion](https://remotion.dev) scenes and a
narration spec, then drives `create → put_source → narrate → still → render` over MCP and
polls for the result. Text-to-speech produces word-level timestamps, every scene duration is
derived from them, and the captions are burned in. Nothing is uploaded and nothing is
rendered anywhere but your machine.

This repository is the whole local product: the `xplainer` CLI daemon, an optional Electron
client, the render core, the MCP tool contract, and the agent skill that drives them.

> ### Status: it renders
>
> **A video renders end to end, locally.** `xplainer serve` answers `/healthz`, serves the
> eight MCP tools, owns its state directory, drains on `SIGTERM` and announces readiness, and
> `xplainer status` reports whether it is up. The tools do real work against a shared Remotion
> workspace on your machine: `explainer_create` scaffolds a video, `explainer_narrate`
> measures the voiceover and writes the timings every scene length comes from, and
> `explainer_still` and `explainer_render` drive the pinned Remotion CLI to a PNG and a
> 1920×1080 MP4 with burnt-in captions. A test in `apps/cli` renders one on every run and
> checks it with `ffprobe`.
>
> `xplainer mcp` serves those tools over stdio, `xplainer mcp --attach` proxies a session to a
> running daemon over its unix socket, and `xplainer connect claude|codex` writes that command
> into your agent's configuration — a command line, with no URL, no port and no token in it.
>
> Still to come at roadmap phase 1: the Kokoro container as a supported install and the
> first-run downloads. `setup` and `daemon` still print what they are and exit 2, and you
> install the workspace's `node_modules` yourself — no tool call downloads hundreds of
> megabytes behind your back. Nothing here is published to npm yet.
>
> [`docs/ROADMAP.md`](docs/ROADMAP.md) is what happens next, in order, with the criteria each
> phase is judged by written down before it starts.

---

## Requirements

- **Node 24 LTS** — pinned in `.node-version` and enforced by `engines` with `engine-strict`,
  so a wrong version fails rather than warns.
- **[uv](https://docs.astral.sh/uv/)** for the Python members; Python 3.13 is pinned in
  `.python-version`.
- **Docker**, for the Kokoro text-to-speech container. From phase 2, `xplainer setup`
  downloads a standalone TTS build instead and Docker becomes optional.
- **A Remotion licence, depending on who you are.** Remotion is free for individuals and for
  companies of up to three people. Above that, **you need your own Remotion licence** — see
  <https://remotion.pro/license>. `@xplainer/render-core` *declares* Remotion as a dependency
  of the video workspace it scaffolds and never bundles it, so your own install fetches
  Remotion under Remotion's terms, on your machine, in your name. This is the one requirement
  here that is not a piece of software you can just install, and it is stated up front on
  purpose.

## Getting started

```bash
corepack enable && pnpm install   # TypeScript members
uv sync --all-packages            # Python members
```

That is the whole bootstrap, on macOS, Linux and Windows. Nothing else is required, and CI
proves it on all three operating systems on every push — as its own job, so a Windows-only
install failure cannot hide behind a green Linux run.

### The one-command check

```bash
pnpm turbo build lint typecheck test
```

One graph covers both languages: the Python members join it through thin `package.json`
scripts that shell out to `uv run`. There is no second task runner and no second command to
remember.

## Running it

**`apps/cli` is the local runtime.** Everything else is a client of it.

```bash
pnpm --filter @xplainer/cli dev -- serve          # daemon on http://127.0.0.1:8787
# or from the built binary:
pnpm --filter @xplainer/cli build && node apps/cli/dist/bin.js serve --port 8787
```

`serve` exposes `GET /healthz` and a Streamable HTTP MCP endpoint at `/mcp`. **Both need a
bearer token**, which the first start mints at `0600` inside its state directory and names on
stderr — an always-listening loopback port is reachable from any web page you visit, so the
daemon also checks `Host` and `Origin` on every request
([ADR 0020](docs/adr/0020-always-running-local-daemon.md) §Security):

```bash
export XPLAINER_STATE_DIR=$(mktemp -d)            # or let it use this platform's default
node apps/cli/dist/bin.js serve --port 8787 &
curl -sf -H "Authorization: Bearer $(cat "$XPLAINER_STATE_DIR/token")" localhost:8787/healthz
node apps/cli/dist/bin.js status                  # where the daemon is, and whether it answers
```

It runs anywhere Node runs, including a headless Linux VM with no desktop environment — that
is the constraint the whole local design was chosen against
([ADR 0016](docs/adr/0016-cli-first-local-runtime-desktop-is-an-optional-client.md)).

From roadmap phase 2 the daemon is *installed* rather than started by hand — a `systemd --user`
unit on Linux, a LaunchAgent on macOS, a Scheduled Task on Windows, none of them needing an
administrator ([ADR 0020](docs/adr/0020-always-running-local-daemon.md)). The `xplainer daemon`
command group is registered today and reports that it is deferred.

**Text-to-speech runs in a container next to it**, on `http://localhost:8880`:

```bash
docker compose -f infra/docker-compose.tts.yml up --build
```

That is the Kokoro-FastAPI contract `packages/tts-client` is pinned against
([ADR 0006](docs/adr/0006-kokoro-fastapi-http-contract-as-tts-interface.md)) — chosen because
it returns word-level timestamps, which is what makes every scene duration derivable rather
than hand-written. From phase 2, `xplainer setup` downloads a standalone build of the same
thing and Docker stops being a requirement
([ADR 0005](docs/adr/0005-download-on-first-run-chrome-headless-shell-and-tts.md)).

**`apps/desktop` is an optional GUI client**, not a second implementation. It bundles and
spawns the CLI, or attaches to a daemon running somewhere else, and it contains no render or
TTS code — asserted by a grep in CI, not by good intentions.

```bash
pnpm --filter @xplainer/desktop dev               # placeholder window titled "Xplainer"
pnpm --filter @xplainer/desktop package           # unsigned installer → apps/desktop/release/
```

Installers are unsigned until roadmap phase 3; that is a deliberate deferral, not an oversight.

## Layout

```
xplainer.video/
├── apps/
│   ├── cli/                # `xplainer` CLI + local daemon: serve, mcp, setup, connect, daemon
│   └── desktop/            # Electron optional client; bundles + spawns @xplainer/cli
├── packages/
│   ├── protocol/           # JSON Schema source of truth → TS types + pydantic models
│   ├── mcp-server/         # Backend-agnostic TS tool implementations over a RenderBackend
│   ├── render-core/        # Remotion template, scaffold generator, render/still runners
│   ├── tts-client/         # Kokoro-FastAPI-compatible client
│   ├── skill/              # SKILL.md + Claude & Codex plugin bundles built from it
│   └── config/             # shared tsconfig / biome presets + the tier checker
├── services/
│   └── tts-sidecar/        # Kokoro TTS: Dockerfile + per-OS standalone packaging recipes
├── infra/
│   ├── docker-compose.tts.yml   # the local speech container, and nothing else
│   └── terraform/          # R2 bucket + cached custom domain for release artefacts
├── docs/adr/               # MADR decision records
├── docs/ROADMAP.md
├── docs/acceptance-criteria.md
└── .github/workflows/      # ci.yml, desktop.yml
```

Nine workspace members: eight TypeScript, one Python-only (`services/tts-sidecar`), and
`packages/protocol` carries both — one JSON Schema source generating TypeScript types and
pydantic models, so the two languages cannot drift.

## The eight tools

The agent-facing contract is eight MCP tools, defined once as JSON Schema in
`packages/protocol` and generated into both languages:

`explainer_create` · `explainer_put_source` · `explainer_put_media` · `explainer_narrate` ·
`explainer_still` · `explainer_render` · `explainer_job` · `explainer_list`

Two design choices in there are worth knowing before you read the code:

- **The agent writes scenes, not the composition shell.** `Video.tsx` is engine-owned and
  `explainer_put_source` refuses to write it, so an agent rewriting a component for a visual
  reason cannot accidentally ship a silent video with no captions
  ([ADR 0018](docs/adr/0018-engine-owns-the-composition-shell.md)).
- **Renders are asynchronous and the agent polls.** `explainer_render` returns a `job_id`; the
  agent calls `explainer_job`. No webhooks back to agents
  ([ADR 0008](docs/adr/0008-async-job-model-poll-and-progress-no-agent-webhooks.md)).

## Decisions

Every stack and contract decision is a numbered record in **[`docs/adr/`](docs/adr/)**, in
MADR format, including the ones that were rejected and why. Records are immutable once
accepted: a changed decision is a new record, and a record that acknowledges something that
happened underneath it gains a dated note rather than a rewrite.

[ADR 0023](docs/adr/0023-split-the-repository.md) is the most recent and explains the shape of
this repository: **a hosted tier was designed and is deferred pending a written answer from
Remotion AG on whether a rendering service may accept user-authored code. It was relocated to
a private repository, not cancelled.** The local product does not depend on that answer —
you operate Remotion on your own machine — which is why it is the half that ships first and
the half that is open source.

The phase-0 acceptance criteria that comments and CI step names cite by id (`AC-2c`, `AC-7b`,
`AC-14b`) are in [`docs/acceptance-criteria.md`](docs/acceptance-criteria.md).

For how the workspace itself is put together — who the members are, what depends on what, and
which of those claims a command proves — start at
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), which is the entry point the records and the
roadmap hang off.

## Tiers

Every package declares its tier in its own `package.json` as
`"xplainer": { "tier": "open-later" }`. All nine members are `open-later`.

The name is historical and now slightly misleading: it never meant "not yet distributed", and
it does not mean "not yet open". Six packages are already Apache-2.0 (below); `open-later`
marks the ones still on the path. The import rule the tier field enforces —
`hosted` may depend on `open-later`, never the reverse — is what made the repository split a
directory move rather than a rewrite
([ADR 0003](docs/adr/0003-tier-boundary-and-open-later-plan.md)).

```bash
pnpm lint:tiers                    # every member declares a tier; exit 2 if one does not
pnpm biome check .                 # banned specifiers for the relocated tier
```

With no `hosted` member left here, `lint:tiers` can no longer produce a real-graph violation;
the proof that the rule can fail is carried by a synthetic fixture in
`packages/config/src/tiers.test.ts`. That is written down in ADR 0003's dated note rather than
left for someone to discover.

## Contributing

- `pnpm turbo build lint typecheck test` must pass before a commit; lefthook runs Biome and
  ruff on staged files.
- A change to `packages/protocol/schemas/` requires
  `pnpm --filter @xplainer/protocol codegen` in the same commit — CI fails on stale generated
  output.
- A user-visible change to a published package needs a changeset (`pnpm changeset`).
- New packages need a `"xplainer": { "tier": ... }` field and all four scripts (`build`,
  `lint`, `typecheck`, `test`), or Turbo silently skips them.
- **A change to a published package's exported surface requires `pnpm api:report` in the same
  commit.** Each of the five published, declaration-emitting members carries a committed
  `api/<name>.api.md`, so a widened or narrowed export shows up in the diff — CI fails on a
  stale report.
- **`AGENTS.md` and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) are the agent-facing
  surface**, at the root and in every member, and **`pnpm verify` is the one command** — it
  chains the build, lint, typecheck and test graph and every repository gate behind it.

Contributions to the six Apache-2.0 packages arrive under Apache-2.0 §5, which supplies the
inbound grant in the licence text itself; no separate CLA is required for those
([ADR 0022](docs/adr/0022-open-source-the-published-packages.md)). The rest of the tree is not
open source yet — see below — so a patch to it has no inbound licence to arrive under. Open an
issue first if that is where you are headed.

## Licence

**Six packages are open source under the Apache Licence 2.0.** These are the ones published to
npm under the `@xplainer/` scope, and they are the whole of what a user installs:

| Directory | Package |
|---|---|
| `apps/cli` | `@xplainer/cli` |
| `packages/mcp-server` | `@xplainer/mcp-server` |
| `packages/protocol` | `@xplainer/protocol` |
| `packages/render-core` | `@xplainer/render-core` |
| `packages/skill` | `@xplainer/skill` |
| `packages/tts-client` | `@xplainer/tts-client` |

Full text in [`LICENSE-APACHE-2.0`](LICENSE-APACHE-2.0); a copy travels inside each published
tarball, and [`NOTICE`](NOTICE) is the attribution notice Apache-2.0 §4(d) propagates. Each of
the six manifests declares `"license": "Apache-2.0"`, which is the authoritative statement for
machine consumers.

**The rest of the repository is not open source yet.** [`LICENSE`](LICENSE) Part Two covers
`apps/desktop`, `packages/config`, `services/tts-sidecar`, `infra/`, `scripts/`, `docs/` and
the root files: proprietary, all rights reserved. Those three members are on the path to being
opened and have not been relicensed. Read `LICENSE` before copying anything out of here; it
draws the line per directory and the two halves say opposite things on purpose.

### Remotion

Rendering depends on Remotion, which is licensed commercially by Remotion AG on its own terms.
The Apache-2.0 grant above covers this software only and grants you nothing in respect of
Remotion. **Depending on the size of your company and how you use it, you may need your own
Remotion licence** — free for individuals and companies of up to three people, chargeable
above that. See <https://remotion.pro/license> and [`NOTICE`](NOTICE).

`@xplainer/render-core` declares Remotion as a dependency of the workspace it scaffolds and
does not bundle it. That is a deliberate licensing position, not an implementation detail: it
keeps you — on your own machine, under your own licence — as the party who operates Remotion
([ADR 0022](docs/adr/0022-open-source-the-published-packages.md)).
