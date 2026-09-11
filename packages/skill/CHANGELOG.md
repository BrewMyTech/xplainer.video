# @xplainer/skill

## 0.0.2

### Patch Changes

- 458aa0b: **Both plugin bundles now declare `npx -y xplainer mcp` rather than `npx -y @xplainer/cli mcp`.**

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

## 0.0.1

### Patch Changes

- b3e1be8: **The published packages described a repository that no longer exists and a service that was never
  here.** This is the editorial pass ADR 0022 booked and ADR 0023 made necessary, done before the
  first publish rather than after it.

  `apps/api`, `apps/web` and `services/media-service` moved to a private repository on 2026-09-06.
  What stayed behind was a tree full of sentences citing them as siblings — and those sentences ship.
  `apps/cli`'s npm `description` named "the HTTP/MCP server core shared with the hosted
  media-service", which is the one line a human reads before installing a daemon; twenty-three
  docblocks across `apps/cli/src/` and `packages/mcp-server/src/` cited a `services/media-service`
  path that no reader of this repository can open, and every one of them travels inside
  `dist/**/*.d.ts` and the committed API reports.

  The reasoning in those comments was never wrong and is untouched: a seam is a parameter _because_ a
  second binder supplies its own guard, state directory or socket. Only the naming changed — the
  second binder is now **the hosted media service**, located once per file as _relocated to a private
  repository, ADR 0023_. Where a comment quotes ADR 0020 or `apps/cli/AGENTS.md`, the quotation still
  says what the record said and the surrounding sentence carries the correction, because a quote that
  has been tidied is no longer evidence.

  `LICENSE` — which ships inside all six tarballs — stopped listing three directories that are not
  here and now states the decision it used to leave open: `apps/desktop`, `packages/config` and
  `services/tts-sidecar` stay proprietary and stay `UNLICENSED`. Making the repository public made
  them readable, not usable.

  `@xplainer/skill` changes most. `SKILL.md`'s "Two backends, one tool set" sold a hosted service to
  an agent that cannot reach one, which is the same failure as publishing a dead URL: it is now "One
  tool set, and it runs on this machine", and an agent told no server is registered is told to stop
  rather than to reach for a route that does not exist. The three plugin and marketplace manifests
  drop the same framing and gain the Remotion disclosure ADR 0022 requires on a pre-install surface —
  completing the five surfaces that record named, none of which existed when it was written.

  Two schema `description` strings did move, and they are the reason this pass was not editorial
  after all. `captions.json` and `narration.json` cited `max/.explainers/scripts/narrate.py` by file
  and line — a path into the private reference implementation this product was derived from — and
  `@xplainer/protocol` ships `schemas`, `python/**/*.py` and `dist/**/*.d.ts`, so one citation was
  live on three surfaces at once. Twelve descriptions named that implementation, an earlier hand pass
  scrubbed ten, and these two outlived it. Both keep their claim and lose the coordinate: caption
  timing is still "measured rather than inferred", narration defaults still "mirror the reference
  implementation". `check-publish-contract` now carries a `no-private-reference-path` rule beside the
  one that matches the hosted repository's name, with its own negative test, because a class scrubbed
  by hand comes back and a class matched by a gate does not.

  What did NOT move is the local/hosted wording itself. The tool contract describes both backends
  deliberately, that wording is the published contract rather than a stale path, and narrowing it
  would be a contract change wearing an editorial hat.

- 574480c: Give every published package a `README.md`, a `homepage`, a `repository` and an `author`.

  None of the six had a README, so each one's npm page would have rendered blank —
  including `@xplainer/cli`, which is the page a human reads before deciding to
  install a background daemon on their machine. Each README is derived from the
  member's own `AGENTS.md`, states what the package is and links to the repository
  docs rather than restating their invariants; `@xplainer/cli` and
  `@xplainer/render-core` also carry the Remotion disclosure ADR 0022 requires on
  a surface a user reads _before_ installing — Remotion is declared, never bundled,
  and a company above three people needs its own licence.

  `repository.directory` names the member inside the monorepo, so "view source"
  lands on the package a reader is looking at instead of on the repository root.

- 574480c: Stop citing documents an installer cannot open, and fix the plugin manifests' licence.

  Ten JSON Schema `description` strings and four declaration comments cited
  `max/server/explainer_mcp.py` by file and line — the reference implementation
  this contract was ported from, which lives in a repository nobody who installs
  these packages can read. Codegen carried those strings into the generated
  TypeScript, the generated pydantic models and the emitted `.d.ts`, so they were
  shipping. The substance of each description is unchanged; only the citation is,
  and it now says "the reference implementation" rather than pointing at a path
  that resolves for one person. ADR 0022 booked this as editorial work at the
  source, and this is it.

  Separately, `packages/skill`'s three plugin and marketplace manifests still
  declared `"license": "UNLICENSED"`, contradicting the package they ship inside
  and telling a prospective installer — on the marketplace listing, before they
  install — that they have no right to run the plugin. They now declare
  `Apache-2.0`, which is what the package has been licensed under since ADR 0022.
