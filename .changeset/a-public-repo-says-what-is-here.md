---
"@xplainer/cli": patch
"@xplainer/mcp-server": patch
"@xplainer/protocol": patch
"@xplainer/render-core": patch
"@xplainer/skill": patch
"@xplainer/tts-client": patch
---

**The published packages described a repository that no longer exists and a service that was never
here.** This is the editorial pass ADR 0022 booked and ADR 0023 made necessary, done before the
first publish rather than after it.

`apps/api`, `apps/web` and `services/media-service` moved to a private repository on 2026-09-06.
What stayed behind was a tree full of sentences citing them as siblings — and those sentences ship.
`apps/cli`'s npm `description` named "the HTTP/MCP server core shared with the hosted
media-service", which is the one line a human reads before installing a daemon; twenty-three
docblocks across `apps/cli/src/` and `packages/mcp-server/src/` cited a `services/media-service`
path that no reader of this repository can open, and every one of them travels inside
`dist/**/*.d.ts` and the committed API reports.

The reasoning in those comments was never wrong and is untouched: a seam is a parameter *because* a
second binder supplies its own guard, state directory or socket. Only the naming changed — the
second binder is now **the hosted media service**, located once per file as *relocated to a private
repository, ADR 0023*. Where a comment quotes ADR 0020 or `apps/cli/AGENTS.md`, the quotation still
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

Nothing in the tool contract moved. `packages/protocol`'s schemas and generated output still
describe a local and a hosted backend, deliberately: that wording is the published contract rather
than a stale path, and narrowing it would be a contract change wearing an editorial hat.
