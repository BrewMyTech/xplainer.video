---
"@xplainer/skill": patch
---

**Both plugin bundles now declare `npx -y xplainer mcp` rather than `npx -y @xplainer/cli mcp`.**

The bundles named the **scoped** package while every install instruction names the unscoped one. The
two resolve to the same CLI — `packages/alias` is one pinned dependency on `@xplainer/cli` and exists
to re-export its `bin` — but `@xplainer/cli` is not a name a user is ever told: `README.md`
§Installing it says `npm i -g xplainer`, and the alias is what `0.0.1` published for exactly that
reason. So the bundle and the documentation disagreed about what the product is called, for no gain.
That is the whole of this change.

**`npx -y` stays, and naming the installed binary instead was considered and rejected.**
Zero-install is the plugin route's reason to exist — `apps/cli/AGENTS.md` records `xplainer mcp`
without `--attach` as "the plugin-bundle path … on a machine with nothing installed" — and a bundle
declaring `command: "xplainer"` would require `npm i -g xplainer` before the plugin could start at
all, which collapses that route into the npm one with extra steps. A client that skipped the global
install would get a server that fails to spawn rather than one that fetches itself. The registry
cost of `npx` is also smaller than it looks: resolved packages are cached under `~/.npm/_npx`, so it
is a first-run fetch and not a per-session round trip.

`packages/skill/src/build.test.ts` asserts the declaration against the emitted bytes of both
bundles, so the two `.mcp.json` files and the constant they are compared against move together.

`AC-10b′` in `docs/acceptance-criteria.md` gains a dated note: the property it asserts — a local
stdio server in both bundles, and no `oauth_resource` in either — is unchanged and still holds, and
only the example command in its 2026-09-06 note was stale.
