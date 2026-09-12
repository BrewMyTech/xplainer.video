# xplainer.video

**Your agents found the answer. Now see the explanation.**

Working across multiple agents means repeatedly catching up on what each one found. Turn complex code, debugging findings, and ideas into explainer videos, so you can follow the problem without reconstructing it from chat threads.

<p align="center">
  <a href="https://youtu.be/AjI2cN68rQU">
    <img
      src="docs/media/xplainer-intro-poster.png"
      alt="xplainer.video — an eighty-second tour, itself written, narrated and rendered by an agent"
      width="860"
    >
  </a>
</p>

<p align="center">
  <a href="https://youtu.be/AjI2cN68rQU"><b>▶&nbsp; Watch the 80-second tour</b></a><br>
  <sub>An agent wrote the scenes, the built-in voice narrated them, and this machine rendered it — with the five tools below.<br>
  <code>docs/media/</code> holds the MP4, and <code>docs/media/xplainer-intro/</code> the <code>narrate</code> and <code>put_source</code> payloads that regenerate it.</sub>
</p>

An agent — Claude Code or Codex — writes [Remotion](https://remotion.dev) scenes and a
narration spec, then drives `create → put_source → narrate → still → render` over MCP and
polls for the result. Text-to-speech produces word-level timestamps, every scene duration is
derived from them, and the captions are burned in. Nothing is uploaded and nothing is
rendered anywhere but your machine.

This repository is the whole local product: the `xplainer` CLI daemon, an optional Electron
client, the render core, the MCP tool contract, and the agent skill that drives them.

## Quick setup

Three commands, then ask for a video. Works on macOS, Linux and Windows.

```bash
npm i -g xplainer          # the unscoped alias; forwards to @xplainer/cli
xplainer setup             # browser + a speech route + the render workspace (~2 min, once)
xplainer connect claude --spawn   # the MCP entry AND the skill an agent reads before driving it
```

**Or, with the daemon**, if you would rather one long-lived service answered every agent session
than a fresh set of tools per session:

```bash
xplainer daemon install    # a real service under launchd, systemd or Task Scheduler
xplainer connect claude    # no --spawn: this entry ATTACHES to that service
```

Either route gives an agent the same eight tools, and you do not need both. `--spawn` needs nothing
running and is the right default; the daemon costs one resident process and earns it back when
several agents are connected at once, because they share one copy of the render and speech
machinery instead of starting their own. What you must not do is mix them: `connect` **without**
`--spawn` writes an attaching entry, and when no daemon has ever bound it refuses with exit `3` and
writes nothing at all — correct, and the reason the first route carries the flag.

Then in Claude Code:

```text
/reload-plugins
```

and ask for one:

> Explain how our retry logic works as a ninety-second video.

Claude writes the Remotion scenes and the narration, then drives
`create → put_source → narrate → still → render` over MCP. The MP4 lands in
`<state dir>/workspace/out/<slug>/explainer.mp4` — `xplainer status` prints the state directory,
and the tool's own answer gives you the path.

**Three things worth knowing before you start.** `setup` is not optional and no agent can do it for
you: it downloads a headless browser and resolves the render workspace, and the render tools refuse
without it. `connect` writes **two** things — the stdio MCP entry and
`~/.claude/skills/xplainer/SKILL.md`, the instructions an agent reads before it composes a scene —
so **re-running it after `npm i -g xplainer@latest` is how you update both**; it reports each as
written or already current. And a first render is slower than the ones after it, because the speech
model and the browser are fetched once.

For `codex` instead of Claude: `xplainer connect codex --spawn` does the same, with the skill at
`~/.codex/skills/xplainer/SKILL.md`. After an upgrade, `xplainer update` re-runs `setup` and
re-writes each configured agent's entry and skill in whichever of the two forms it already has.

See [The daemon, if you want it](#the-daemon-if-you-want-it) for the rest of what the service route
adds, and [Installing it](#installing-it) for the other two install routes.

> ### Status: it renders, and it installs itself
>
> **A video renders end to end, locally, and the daemon that does it is installed rather than
> started by hand.** `xplainer serve` answers `/healthz`, serves the eight MCP tools, owns its
> state directory, drains on `SIGTERM` and announces readiness; `xplainer status` reports
> whether it is up, in prose or as one JSON condition code. The tools do real work against a
> shared Remotion workspace on your machine: `explainer_create` scaffolds a video,
> `explainer_narrate` measures the voiceover and writes the timings every scene length comes
> from, and `explainer_still` and `explainer_render` drive the pinned Remotion CLI to a PNG and
> a 1920×1080 MP4 with burnt-in captions. A test in `apps/cli` renders one on every run and
> checks it with `ffprobe`.
>
> `xplainer setup` acquires the browser and materialises the render workspace,
> `xplainer runtime build` assembles the relocatable payload that carries its own interpreter,
> and `xplainer daemon install` registers that payload with this machine's own supervisor — a
> `systemd --user` unit, a LaunchAgent or a per-user Scheduled Task, never as root and never
> needing an administrator. `daemon update` is a transaction: staged, journalled, and rolled
> back if the replacement does not become ready. `docs/daemon.md` is that whole surface,
> including what to do on a host with no user-scope supervisor at all.
>
> `xplainer mcp` serves those tools over stdio, `xplainer mcp --attach` proxies a session to a
> running daemon over its unix socket, and `xplainer connect claude|codex` writes that command
> into your agent's configuration — a command line, with no URL, no port and no token in it.
>
> **What is not done, said plainly.** `npm i -g xplainer` is a real install route: the six
> `@xplainer/*` packages and the unscoped `xplainer` alias in `packages/alias` are all on npm — the
> CLI, the alias and the skill at `0.0.2`, the other four at `0.0.1` — so `xplainer` is a command you
> have rather than a package you assemble. The daemon is
> **opt-in rather than hand-built**: `xplainer daemon install` takes no arguments on a machine that
> installed from npm, building its own relocatable payload — about 150 MB — out of that install,
> and `--runtime` stays the route for a checkout, for CI and for a machine with no registry access.
> Speech runs **in-process on every platform** the ONNX route reaches, Windows included: `setup`
> acquires the Kokoro graph, one voice and this platform's ONNX Runtime, each from its own upstream
> home, and narration needs no container, no Python and no server. A Kokoro-FastAPI server you
> already run (`setup --tts-url`) and the pinned container are still supported routes, and Intel
> Macs need one of them because `onnxruntime-node` publishes no `darwin/x64` binding, which `setup`
> says rather than
> offering a route that fails.
> Desktop installers are unsigned, and the macOS ones are **arm64 only** this phase.
>
> [`docs/ROADMAP.md`](docs/ROADMAP.md) is what happens next, in order, with the criteria each
> phase is judged by written down before it starts.

---

## Requirements

- **Node 24 LTS** — pinned in `.node-version` and enforced by `engines` with `engine-strict`,
  so a wrong version fails rather than warns.
- **[uv](https://docs.astral.sh/uv/)** for the Python members; Python 3.13 is pinned in
  `.python-version`.
- **Docker**, for the Kokoro text-to-speech container — or a Kokoro-FastAPI server you already
  run, which `xplainer setup --tts-url <url>` records instead. A standalone per-platform speech
  bundle, which is what makes Docker optional and gives Windows a route at all, is phase-4 work
  and nothing is published for it yet.
- **A Remotion licence, depending on who you are.** Remotion is free for individuals and for
  companies of up to three people. Above that, **you need your own Remotion licence** — see
  <https://remotion.pro/license>. `@xplainer/render-core` *declares* Remotion as a dependency
  of the video workspace it scaffolds and never bundles it, so your own install fetches
  Remotion under Remotion's terms, on your machine, in your name. This is the one requirement
  here that is not a piece of software you can just install, and it is stated up front on
  purpose.

## Installing it

Three routes. **All three need `xplainer setup`**, which acquires the browser, records a speech
route and materialises the render workspace on the machine that will do the rendering. "No daemon"
is not "no setup", and no plugin bundle can do it for you. `setup` needs no arguments in the normal
case: the toolchain manifest it reads is published at
<https://cdn.xplainer.video/toolchain/v1/manifest.json>.

### The plugin marketplace

In Claude Code:

```text
/plugin marketplace add BrewMyTech/xplainer.video
/plugin install xplainer
```

The marketplace file is `.claude-plugin/marketplace.json` at the root of this repository, and it
resolves the plugin to `packages/skill/claude-plugin` — where the Claude bundle's reviewed sources
live: the manifest, and one `.mcp.json` declaring a local stdio server, `npx -y xplainer mcp`.

**This route gives you the eight tools and not the skill, and that is a gap rather than a design.**
`SKILL.md` is what an agent reads before it drives the tools, and Claude Code discovers a plugin's
skills at `<plugin>/skills/<name>/SKILL.md`. `pnpm --filter @xplainer/skill build` writes it to
exactly that path — but into `dist/`, which is not committed, and a marketplace can only read what is
in the repository. So an install declares the MCP server and ships no instructions for using it.
Until that is closed ([ROADMAP](docs/ROADMAP.md) phase 4, where it blocks **P4-3**), an agent driven
through this route is working without them.

**The two routes below do install it**, because `xplainer connect` writes the skill beside the MCP
entry — `~/.claude/skills/xplainer/SKILL.md`, or `~/.codex/` for Codex — out of the `@xplainer/skill`
the CLI depends on. It had not, for one release: `connect` wrote the transport and not the method,
which is how an agent ends up with eight tools and no instructions. Re-running `connect` after an
upgrade refreshes both, and reports each as written or already current.

So the gap is now specific to **this** route: `/plugin install` cannot deliver the skill while the
marketplace `source` points at a directory with no `skills/`. There is one reviewed `SKILL.md` and
`packages/skill/src/build.test.ts` compares it byte-for-byte against both bundles, so whichever way
P4-3 is closed, there is no second copy to drift.

Nothing has to be installed globally for that server to start: `npx` fetches the CLI the first time
and caches it under `~/.npm/_npx`. What no bundle can do for you is `setup`, so run it once, from
anywhere:

```bash
npx -y xplainer setup
```

### npm

```bash
npm i -g xplainer                    # the unscoped alias; forwards to @xplainer/cli
xplainer setup                       # browser + speech route + the render workspace
xplainer connect claude --spawn      # write that command into your agent's configuration
```

`connect codex` does the same for Codex, and both write a command line — no URL, no port and no
token in it. `--spawn` is the no-daemon form: the agent starts `xplainer mcp`, which serves all
eight tools in its own process. Measured: about 140 ms to start, about 98 MB resident while idle.

### The daemon, if you want it

The daemon is **opt-in**, and nothing above needs it. Installed from npm, it takes no arguments:

```bash
xplainer daemon install                 # builds its own payload, registers with the supervisor
xplainer daemon status                  # installed? running? healthy?
```

That first command assembles a **relocatable payload** — a copy of the interpreter, the CLI and its
dependency closure, roughly 150 MB — out of the package npm installed, and registers *that* rather
than the `xplainer` on your `PATH`. The indirection is the point: your `PATH` copy lives under
whichever Node installed it, so the next `nvm install` would leave a supervisor entry naming a file
that is gone. The payload carries its own interpreter and survives that.

On a checkout, in CI, or anywhere with no npm install to build from, name a payload instead:

```bash
xplainer runtime build --out <dir>
xplainer daemon install --runtime <dir>
```

**What the daemon buys, and nothing else does:** a render that keeps going after the agent exits, a
`job_id` that outlives the session that
created it, one serial queue for the whole machine rather than one per agent session, and the
`/api/*` surface `apps/desktop` attaches to. Without it the only exclusion is per video —
`locks/<slug>.lock`, so two agents on two explainers never contend, and two on one fail the second
job with a retryable answer. [`docs/daemon.md`](docs/daemon.md) is that surface end to end.

### What a restart costs, without the daemon

The tools run inside the MCP server your agent spawned, and that process ends when the agent's
connection to it does. Quitting the agent ends it; so does reloading the editor, and so does
reconnecting the server — it is not only the case of closing the session deliberately. **An
unfinished render does not survive that**: the `job_id` you were polling stops resolving and the
render does not resume where it left off. **Anything already finished stays on disk** — completed
MP4s, stills and timings are written into the workspace and are untouched by the restart. So what
is lost is work in flight, and **continuity across a restart is precisely what the daemon adds**:
it holds the queue and the job records outside any one agent session.

## Getting started

The rest of this file is for working **on** xplainer rather than with it.

```bash
corepack enable && pnpm install   # TypeScript members
uv sync --all-packages            # Python members
```

That is the whole bootstrap, on macOS, Linux and Windows. Nothing else is required, and CI
proves it on all three operating systems — as its own `workflow_dispatch` job, so a Windows-only
install failure cannot hide behind a green Linux run, and so the three-runner cost is paid when
the lockfiles or the version pins change rather than on every push.

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

**The daemon installs itself**, rather than being started by hand — a `systemd --user` unit on
Linux, a LaunchAgent on macOS, a per-user Scheduled Task on Windows, none of them needing an
administrator ([ADR 0020](docs/adr/0020-always-running-local-daemon.md)). The three commands that
do it are in §Installing it above, along with what the daemon buys that no other route does; this
section is the rest of that surface.

[`docs/daemon.md`](docs/daemon.md) is that surface end to end — install, lifecycle, updates,
exposing the daemon beyond this machine, and the self-supervision recipes for a host that has no
user-scope supervisor (Docker `--restart unless-stopped`, OpenRC `supervise-daemon`), each with the
caveats measured rather than assumed.

**Text-to-speech needs no container and no Python.** `xplainer setup` acquires an in-process
engine — the Kokoro-82M ONNX graph, one voice and this platform's ONNX Runtime, each pinned by
digest and each fetched from its own upstream home — and narration then runs inside the daemon's own
worker, with word timings taken from the model's own per-token duration predictor
([ADR 0028](docs/adr/0028-in-process-onnx-speech-and-a-g2p-we-own.md)). Nothing has to be started,
and nothing has to be published for it to work. Intel Macs are the one exception:
`onnxruntime-node` ships no `darwin/x64` binding, so those keep the two routes below.

A **Kokoro-FastAPI server is still a supported route**, and it wins when you name one — a container
you already run, a hosted voice, or a comparison against the reference implementation:

```bash
docker compose -f infra/docker-compose.tts.yml up --build   # on http://localhost:8880
xplainer setup --tts-url http://localhost:8880              # record it, download nothing
```

That is the contract `packages/tts-client` is pinned against
([ADR 0006](docs/adr/0006-kokoro-fastapi-http-contract-as-tts-interface.md)) — chosen because it
returns word-level timestamps, which is what makes every scene duration derivable rather than
hand-written, and it is still the contract for anything that speaks over a network.
`xplainer setup --speech docker` pulls the pinned image instead of acquiring the in-process engine;
a machine that already recorded that route keeps it on a re-run, and `--speech onnx` is how it
switches.

**`apps/desktop` is an optional GUI client**, not a second implementation. It bundles and
spawns the CLI, or attaches to a daemon running somewhere else, and it contains no render or
TTS code — asserted by a grep in CI, not by good intentions.

```bash
pnpm --filter @xplainer/desktop dev               # placeholder window titled "Xplainer"
pnpm --filter @xplainer/desktop package           # unsigned installer → apps/desktop/release/
```

Installers are unsigned until roadmap phase 3; that is a deliberate deferral, not an oversight. The
macOS artefacts are **arm64 only** this phase: the payload inside them copies the build host's own
interpreter, so an x64 artefact built on an Apple-silicon runner would ship an arm64 `node` and fail
to start. Shipping a target that cannot run is worse than not shipping it, and an Intel Mac has no
desktop installer here until a native x64 build joins the matrix.

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
│   ├── alias/              # the unscoped `xplainer` name on npm; forwards to @xplainer/cli
│   └── config/             # shared tsconfig / biome presets + the tier checker
├── services/
│   └── tts-sidecar/        # Kokoro TTS: Dockerfile + per-OS standalone packaging recipes
├── infra/
│   ├── docker-compose.tts.yml   # the local speech container, and nothing else
│   └── terraform/          # R2 bucket + cached custom domain for release artefacts
├── docs/adr/               # MADR decision records
├── docs/ARCHITECTURE.md    # the workspace, the runtime, the exit codes
├── docs/daemon.md          # installing, running, updating and exposing the daemon
├── docs/ROADMAP.md
├── docs/acceptance-criteria.md
└── .github/workflows/      # ci.yml, desktop.yml, and the workflow_dispatch proof workflows
```

Ten workspace members: nine TypeScript, one Python-only (`services/tts-sidecar`), and
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

[ADR 0023](docs/adr/0023-split-the-repository.md) explains the shape of this repository: **a
hosted tier was designed and is deferred pending a written answer from Remotion AG on whether a
rendering service may accept user-authored code. It was relocated to a private repository, not
cancelled.** The local product does not depend on that answer — you operate Remotion on your own
machine — which is why it is the half that ships first and the half that is open source.

The phase-0 acceptance criteria that comments and CI step names cite by id (`AC-2c`, `AC-7b`,
`AC-14b`) are in [`docs/acceptance-criteria.md`](docs/acceptance-criteria.md).

For how the workspace itself is put together — who the members are, what depends on what, and
which of those claims a command proves — start at
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), which is the entry point the records and the
roadmap hang off.

## Tiers

Every package declares its tier in its own `package.json` as
`"xplainer": { "tier": "open-later" }`. All ten members are `open-later`.

The name is historical and now slightly misleading: it never meant "not yet distributed", and
it does not mean "not yet open". Seven packages are already Apache-2.0 (below); `open-later`
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

Contributions to the seven Apache-2.0 packages arrive under Apache-2.0 §5, which supplies the
inbound grant in the licence text itself; no separate CLA is required for those
([ADR 0022](docs/adr/0022-open-source-the-published-packages.md)). The rest of the tree is not
open source yet — see below — so a patch to it has no inbound licence to arrive under. Open an
issue first if that is where you are headed.

## Licence

**Seven packages are open source under the Apache Licence 2.0.** These are the ones published to
npm — six under the `@xplainer/` scope plus the unscoped `xplainer`, which is an alias for
`@xplainer/cli` — and they are the whole of what a user installs:

| Directory | Package |
|---|---|
| `apps/cli` | `@xplainer/cli` |
| `packages/alias` | `xplainer` |
| `packages/mcp-server` | `@xplainer/mcp-server` |
| `packages/protocol` | `@xplainer/protocol` |
| `packages/render-core` | `@xplainer/render-core` |
| `packages/skill` | `@xplainer/skill` |
| `packages/tts-client` | `@xplainer/tts-client` |

Full text in [`LICENSE-APACHE-2.0`](LICENSE-APACHE-2.0); a copy travels inside each published
tarball, and [`NOTICE`](NOTICE) is the attribution notice Apache-2.0 §4(d) propagates. Each of
the seven manifests declares `"license": "Apache-2.0"`, which is the authoritative statement for
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
