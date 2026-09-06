# @xplainer/skill

**The xplainer agent skill, plus the two plugin bundles that ship it** — a Claude Code bundle
and a Codex bundle.

`SKILL.md` is the prose an agent reads before driving the explainer tools: how to plan segments,
how to write scenes against the composition shell it does not own, and what order to call the
tools in. `dist/claude-plugin/` and `dist/codex-plugin/` are that same file assembled into each
host's bundle layout, with the plugin manifest and the MCP server declaration beside it.

Both copies of `SKILL.md` are byte-identical to the authored file, and that is checked on every
build — two agent surfaces disagreeing about how to drive the tools is the failure this package
exists to prevent.

## What is in the tarball

```
SKILL.md                                  the authored prose
dist/claude-plugin/                       Claude Code plugin bundle
dist/codex-plugin/                        Codex plugin bundle
```

**Nothing imports this package.** It exports no TypeScript and has no API report; consumers
install a bundle, and the agent reads the prose.

## Docs

- [Architecture][architecture] — the members and the dependency direction
- [Decision records][adr] — plugin packaging is ADR 0013
- [Roadmap][roadmap] — what is built and what is not

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`, both shipped inside this package.

[architecture]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/ARCHITECTURE.md
[adr]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/adr/README.md
[roadmap]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/ROADMAP.md
