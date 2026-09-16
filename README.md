# xplainer.video

**Your agents found the answer. Now see the explanation.**

Working across multiple agents means repeatedly catching up on what each one found. Turn complex code, debugging findings, and ideas into explainer videos, so you can follow the problem without reconstructing it from chat threads.

https://github.com/user-attachments/assets/32e7abb8-eb8d-4359-a661-af709731788f

<p align="center">
  <sub>Ninety seconds, and it explains itself: an agent wrote the scenes, the built-in voice narrated them, and the machine it played on rendered it.<br>
  <code>docs/media/</code> holds the MP4, and <code>docs/media/xplainer-intro/</code> the <code>narrate</code> and <code>put_source</code> payloads that regenerate it.</sub>
</p>

xplainer is a plugin for Claude Code, Codex and GitHub Copilot CLI. Your agent writes the
scenes and narration; xplainer makes a narrated MP4 with burnt-in captions. Speech and rendering
run on your machine. Nothing is uploaded.

## Quick setup

With **Node 24 LTS** installed, run these three commands on macOS, Linux or Windows:

```bash
npm i -g xplainer
xplainer setup
xplainer connect claude --spawn
```

Then run `/reload-plugins` in Claude Code and ask:

> Explain how our retry logic works as a ninety-second video.

The agent previews a frame, renders the video and gives you the file path. The MP4 is saved to
`<state dir>/workspace/out/<slug>/explainer.mp4`; `xplainer status` prints the state directory.

For another agent, replace the last command with:

- **Codex:** `xplainer connect codex --spawn`
- **GitHub Copilot CLI:** `xplainer connect copilot --spawn`

`connect` installs both the eight MCP tools and the skill that tells your agent how to use them.
`--spawn` starts the tools inside each agent session, so nothing needs to be running beforehand.
Keep the session open until the render finishes, or use the [optional daemon](#the-optional-daemon).

`setup` is required for every install route and must run on the machine that will render the
video. Allow roughly two minutes for the initial downloads. **Intel Macs need an alternative
speech route**; see [Setup and speech](#setup-and-speech). Rendering also uses Remotion under
[its own licence terms](#licence).

## Setup and speech

`xplainer setup` downloads a headless browser, prepares the Remotion workspace and installs the
built-in Kokoro ONNX speech engine: the model, one voice and your platform's ONNX Runtime.
The speech downloads come from their upstream sources and are pinned by digest. The browser
and workspace setup uses the published [toolchain manifest](https://cdn.xplainer.video/toolchain/v1/manifest.json).
There is no Docker, Python or speech server to install for the default route.

The voice produces word-level timestamps, so scene lengths follow the narration automatically.
The initial setup and first render take longer than later runs. Render tools refuse to run
until setup is complete; installing an agent plugin alone does not prepare the machine.

**Intel Macs are the exception:** ONNX Runtime has no `darwin/x64` binding. Use a
Kokoro-FastAPI server you already run:

```bash
xplainer setup --tts-url <url>
```

Or use the pinned Docker speech image with `xplainer setup --speech docker`. Both alternatives
are also available on other supported machines. Setup preserves a recorded Docker route;
`xplainer setup --speech onnx` switches to the built-in engine on supported platforms.

For a local Kokoro-FastAPI server from this checkout:

```bash
docker compose -f infra/docker-compose.tts.yml up --build
xplainer setup --tts-url http://localhost:8880
```

At an interactive terminal, setup also asks once whether to star the repository on GitHub.
Enter declines, the prompt expires after ten seconds, and `--no-star` skips it. It never asks
in CI, during `xplainer update`, or if you have already starred the repository.

## Custom pronunciations

Available in **0.0.8** for the built-in speech engine. When narration has to guess a word, it
prints `speech derived a pronunciation for X`. If the result sounds wrong, add your preferred
pronunciation to `<state dir>/lexicon.txt`. You can also override a shipped pronunciation,
including words that produced no warning.

Run `xplainer status` to find the state directory. On macOS, the default file is:

```text
~/Library/Application Support/video.xplainer/lexicon.txt
```

`xplainer setup` creates it with commented examples and an IPA key. Add one entry per line,
with spaces between the spelling and pronunciation; the gloss after `#` is optional:

```text
<spelling><spaces><IPA><spaces># optional gloss
```

For example:

```text
kubectl        kjˈubkˌʌtəl               # koob-CUT-ul
```

The second column is **Kokoro's IPA, not English spelling**. A rough key:

| Symbol | Sound |
|---|---|
| `A` | “ay” |
| `I` | “eye” |
| `i` | “ee” |
| `O` | “oh” |
| `ɛ` | “eh” |
| `ˈ` | Marks stress |

The warning includes the guessed IPA as a starting point. Copy it into the file and adjust
what sounds wrong, or adapt one of the examples. Remove the leading `#` to activate a
commented example.

Your file is consulted **before the built-in lexicon and before CMUdict**. Matching depends on
the spelling you enter:

- A lower-case spelling matches any case: `api` catches `API`.
- A spelling containing a capital matches exactly: `ID` leaves the word `id` alone.

Malformed lines are reported and skipped; they never fail the narration. The file survives
upgrades, and running setup again preserves your edits.

## Updating

`xplainer update` re-runs setup and refreshes every configured agent's MCP entry and skill,
preserving whether it uses `--spawn` or attaches to a daemon.

If you upgrade through npm instead, re-run `connect` for each agent you use:

```bash
npm i -g xplainer@latest
xplainer connect claude --spawn
```

Use `codex` or `copilot` as appropriate, and omit `--spawn` if you use the daemon. Each run
reports whether the entry and skill were written or were already current.

Skills live at `~/.claude/skills/xplainer/SKILL.md`, `~/.codex/skills/xplainer/SKILL.md`, or
`~/.copilot/skills/xplainer/SKILL.md`. Copilot uses `COPILOT_HOME` instead of `~/.copilot` when set.

## The optional daemon

Install the daemon if you want renders to continue after you close your agent, or if several
agents should share one render queue and speech engine. After the quick setup above:

```bash
xplainer daemon install
xplainer connect claude
xplainer daemon status
```

Use `codex` or `copilot` in the second command for those agents. Without `--spawn`, `connect`
attaches the agent to the daemon. If no daemon has ever bound, it exits with code `3` and
writes nothing. Both modes provide the same eight tools.

| | Per-session tools (`--spawn`) | Daemon |
|---|---|---|
| Starts | With each agent session | As a per-user service |
| Agent closes or reconnects | Unfinished renders stop; their job IDs no longer resolve | Renders and job records outlive the agent session |
| Several agents | Separate queues; a per-video lock prevents conflicting jobs | One shared serial queue and render/speech machinery |
| Finished files | Stay on disk | Stay on disk |

Without the daemon, an interrupted render does not resume after reconnecting. Completed MP4s,
stills and narration timings remain in the workspace. Jobs that conflict on the same video
receive a retryable response; separate videos can run independently.

The daemon registers with launchd on macOS, `systemd --user` on Linux or Task Scheduler on
Windows, without an administrator. From an npm install it builds a relocatable payload of
roughly 150 MB, including its own interpreter, so changing your Node installation does not
break the service. It costs one resident process; the per-session route was measured at
about 140 ms to start and 98 MB while idle.

For a checkout, CI or an install using an explicitly supplied runtime:

```bash
xplainer runtime build --out <dir>
xplainer daemon install --runtime <dir>
```

Daemon updates are staged and journalled, with rollback if the replacement fails to become
ready. See the [daemon guide](docs/daemon.md) for lifecycle commands, logs, updates, remote
access and running on hosts without a user service manager.

## Other install options

**Claude Code marketplace:** this route currently installs the MCP tools but **does not deliver
the skill** that guides the agent. Use Quick setup for both. The missing skill is tracked in
[the roadmap](docs/ROADMAP.md).

```text
/plugin marketplace add BrewMyTech/xplainer.video
/plugin install xplainer
```

The plugin starts `npx -y xplainer mcp`. There is no global install to maintain: `npx` fetches
the CLI on first use and caches it under `~/.npm/_npx`. You still need to prepare the machine:

```bash
npx -y xplainer setup
```

**Desktop:** an optional Electron client can start the bundled CLI or attach to a daemon
elsewhere. Installers are currently unsigned, and macOS installers support **arm64 only**.
The [roadmap](docs/ROADMAP.md) tracks signing and platform support.

## How it works

The agent writes [Remotion](https://remotion.dev) scenes and a narration spec, then drives:

```text
create → put_source → narrate → still → render
```

Narration determines scene lengths from word timings. The still is a PNG preview; the final
render is a 1920×1080 MP4 with burnt-in captions. The engine owns the composition shell
(`Video.tsx`), which the agent cannot overwrite, so scene edits preserve the audio and captions.
Renders are asynchronous: the agent gets a `job_id` and polls for progress.

The eight tools are:

| Tool | Purpose |
|---|---|
| `explainer_create` | Scaffold a video |
| `explainer_put_source` | Write scene source |
| `explainer_put_media` | Add media assets |
| `explainer_narrate` | Generate narration and timings |
| `explainer_still` | Render a preview frame |
| `explainer_render` | Render the final video |
| `explainer_job` | Check job status and recent output |
| `explainer_list` | List explainers |

The CLI owns the runtime and works on headless Linux machines as well as desktops. The
Electron client contains no rendering or speech implementation. Agents use stdio MCP;
daemon connections proxy it over a local socket or Windows named pipe, with no URL, port
or token in the agent configuration.

For direct use, `xplainer serve` exposes `/healthz`, `/mcp` and the desktop's `/api/*` surface.
The HTTP endpoints require a bearer token; the daemon also validates `Host` and `Origin`,
owns its state directory and drains on `SIGTERM`. `xplainer status` reports its health in
prose or JSON. The [daemon guide](docs/daemon.md) covers authentication and operation.

## Contributing and design

Start with [AGENTS.md](AGENTS.md) for bootstrap, package invariants and the canonical
post-change procedure. Contributors need [uv](https://docs.astral.sh/uv/) and Python 3.13
as well as Node 24; use the versions pinned in the repository. The quick development check
is `pnpm turbo build lint typecheck test`, which covers both languages. Follow AGENTS.md for
the full verification procedure.

- [Architecture](docs/ARCHITECTURE.md): the ten workspace members, layout, dependency tiers,
  generated TypeScript/Python contract and development recipes.
- [Decision records](docs/adr/): the reasons behind the design, including alternatives rejected.
- [Roadmap](docs/ROADMAP.md): what works, what remains and the criteria for each phase.
- [Acceptance criteria](docs/acceptance-criteria.md): the numbered checks cited by code and CI.

The hosted tier lives in a separate private repository and is deferred pending a Remotion
licensing decision; the local product is independent of it. See
[ADR 0023](docs/adr/0023-split-the-repository.md).

Contributions to the Apache-2.0 packages use the licence's inbound grant; no separate CLA is
required. Open an issue before contributing to the proprietary parts of the repository.

## Licence

The **seven packages published to npm** are open source under the Apache Licence 2.0:

| Directory | Package |
|---|---|
| `apps/cli` | `@xplainer/cli` |
| `packages/alias` | `xplainer` |
| `packages/mcp-server` | `@xplainer/mcp-server` |
| `packages/protocol` | `@xplainer/protocol` |
| `packages/render-core` | `@xplainer/render-core` |
| `packages/skill` | `@xplainer/skill` |
| `packages/tts-client` | `@xplainer/tts-client` |

The unscoped `xplainer` package forwards to `@xplainer/cli`. See
[LICENSE-APACHE-2.0](LICENSE-APACHE-2.0) and [NOTICE](NOTICE); both accompany the published
packages, whose manifests declare `Apache-2.0`.

**The rest of this repository remains proprietary**, including `apps/desktop`,
`packages/config`, `services/tts-sidecar`, infrastructure, scripts, docs and root files.
[LICENSE](LICENSE) defines the boundary. The historical `open-later` tier label describes
the plan, not a licence grant.

**Remotion has its own terms.** It is free for individuals and companies of up to three
people; larger companies need their own Remotion licence. xplainer's Apache-2.0 licence does
not grant rights to Remotion. The render workspace installs Remotion as a dependency on your
machine; xplainer does not bundle it. See [Remotion's licence](https://remotion.pro/license)
and [NOTICE](NOTICE).
