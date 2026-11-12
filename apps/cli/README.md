# @xplainer/cli

**The xplainer local runtime.** It installs the `xplainer` binary, which serves the eight
explainer tools to a coding agent — Claude Code, Codex, or GitHub Copilot CLI — over MCP, and runs
every render and narration job on your own machine. Nothing is uploaded anywhere.

```bash
npm i -g @xplainer/cli
xplainer --help
```

## Commands

| Command | What it does |
|---|---|
| `xplainer serve` | Serves `GET /healthz` and the Streamable HTTP MCP endpoint at `/mcp` on loopback |
| `xplainer mcp` | Serves the same tools over stdio, for an agent that spawns its MCP servers |
| `xplainer setup` | Downloads the headless browser, FFmpeg and the speech engine a render needs |
| `xplainer connect` | Points Claude Code, Codex, or GitHub Copilot CLI at this daemon |
| `xplainer daemon` | Installs and manages the always-on per-user daemon |

Run `xplainer <command> --help` for the flags each one takes. **What is implemented today and
what is still ahead is tracked in one place — [`docs/ROADMAP.md`][roadmap] — rather than
restated here, so this page cannot go stale against it.** A command that is registered but not
yet implemented says so on stderr and exits `2`.

## Requirements

- **Node 24.** Enforced by `engines`, so a wrong version fails the install rather than warning.
- **`xplainer setup`, once, on the machine that renders.** Nothing is downloaded at install; `setup`
  fetches the Chrome for Testing headless shell, a pinned FFmpeg build and the Kokoro speech engine,
  each checked against a digest, and before it fetches FFmpeg it says who publishes that build and
  under which licence. `xplainer setup --ffmpeg-path <file>` records an FFmpeg you installed
  yourself instead — 6.0 or newer, with `libx264` — and a render never looks for one on `PATH`.
- **No Docker and no Python** for the default speech route: Kokoro runs in-process on the ONNX
  Runtime `setup` downloads. An Intel Mac, for which ONNX Runtime publishes no build, uses
  `xplainer setup --speech docker` or `--tts-url <url>` instead.

## Programmatic use

`createServer()` and `startServer()` build the same Hono application the binary serves, against
any `RenderBackend` from [`@xplainer/mcp-server`][mcp-server]. The exact exported surface is
`api/cli.api.md` in the repository, which is regenerated and reviewed on every change.

## Docs

- [Architecture][architecture] — the members, the dependency direction, and the recipes
- [Decision records][adr] — why each of these things is the way it is
- [Roadmap][roadmap] — what is built and what is not

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`, both shipped inside this package. What `xplainer setup`
downloads is not covered by them: FFmpeg is GPL, and the browser and the speech model each carry
their own licence. The [third-party components][third-party] page lists them all.

[architecture]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/ARCHITECTURE.md
[adr]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/adr/README.md
[roadmap]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/ROADMAP.md
[mcp-server]: https://www.npmjs.com/package/@xplainer/mcp-server
[third-party]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/third-party-components.md
