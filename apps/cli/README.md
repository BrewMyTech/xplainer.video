# @xplainer/cli

**The xplainer local runtime.** It installs the `xplainer` binary, which serves the eight
explainer tools to a coding agent — Claude Code or Codex — over MCP, and runs every render and
narration job on your own machine. Nothing is uploaded anywhere.

```bash
npm i -g @xplainer/cli
xplainer --help
```

## Commands

| Command | What it does |
|---|---|
| `xplainer serve` | Serves `GET /healthz` and the Streamable HTTP MCP endpoint at `/mcp` on loopback |
| `xplainer mcp` | Serves the same tools over stdio, for an agent that spawns its MCP servers |
| `xplainer setup` | Prepares the local render and TTS toolchain |
| `xplainer connect` | Points an agent client at this daemon |
| `xplainer daemon` | Installs and manages the always-on per-user daemon |

Run `xplainer <command> --help` for the flags each one takes. **What is implemented today and
what is still ahead is tracked in one place — [`docs/ROADMAP.md`][roadmap] — rather than
restated here, so this page cannot go stale against it.** A command that is registered but not
yet implemented says so on stderr and exits `2`.

## Requirements

- **Node 24.** Enforced by `engines`, so a wrong version fails the install rather than warning.
- **Docker**, for the Kokoro text-to-speech container that narration talks to.
- **A Remotion licence, depending on who you are.** Remotion is free for individuals and for
  companies of up to three people; above that **you need your own Remotion licence** — see
  <https://remotion.pro/license>. `@xplainer/render-core` *declares* Remotion as a dependency
  of the video workspace it scaffolds and never bundles it, so your own install fetches
  Remotion under Remotion's terms, on your machine, in your name.

## Programmatic use

`createServer()` and `startServer()` build the same Hono application the binary serves, against
any `RenderBackend` from [`@xplainer/mcp-server`][mcp-server]. The exact exported surface is
`api/cli.api.md` in the repository, which is regenerated and reviewed on every change.

## Docs

- [Architecture][architecture] — the members, the dependency direction, and the recipes
- [Decision records][adr] — why each of these things is the way it is
- [Roadmap][roadmap] — what is built and what is not

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`, both shipped inside this package.

[architecture]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/ARCHITECTURE.md
[adr]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/adr/README.md
[roadmap]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/ROADMAP.md
[mcp-server]: https://www.npmjs.com/package/@xplainer/mcp-server
