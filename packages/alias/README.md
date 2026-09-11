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

Rendering depends on [Remotion](https://remotion.dev), which is licensed commercially by Remotion
AG on its own terms. The Apache-2.0 grant here covers this software only and grants you nothing in
respect of Remotion; depending on the size of your company and how you use it you may need your own
Remotion licence. See <https://remotion.pro/license> and the `NOTICE` file.
