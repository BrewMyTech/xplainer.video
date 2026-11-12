# xplainer

**The unscoped name for [`@xplainer/cli`](https://www.npmjs.com/package/@xplainer/cli).**

```bash
npm i -g xplainer     # then: xplainer --help
npx xplainer --help   # or without installing anything
```

This package is an alias. It carries one dependency — `@xplainer/cli` at the same exact version —
and its `xplainer` command hands over to that package's own binary in the same process, so the
exit code, the signals and all three streams are the CLI's own. Everything the command does, and
every flag it takes, is documented there.

Installing `@xplainer/cli` directly is equivalent and gives you the same `xplainer` command.

## What the command is

The xplainer local runtime: an always-on, per-user daemon that renders explainer videos on your own
machine, the eight MCP tools an agent drives it with, and the `setup`, `connect` and `daemon`
commands that install it. Nothing is uploaded and nothing renders anywhere but your machine.

- Product: <https://xplainer.video>
- Source, documentation and issues: <https://github.com/BrewMyTech/xplainer.video>

## Licence

Apache-2.0. `LICENSE` and `NOTICE` travel inside this tarball.

The Apache-2.0 grant covers this software only. What `xplainer setup` downloads onto your machine —
the headless browser, FFmpeg and the speech engine — is under each publisher's own licence, FFmpeg's
being the GPL, and nothing here grants you any right to it. The `NOTICE` file and the repository's
[third-party components](https://github.com/BrewMyTech/xplainer.video/blob/main/docs/third-party-components.md)
page list each one.
