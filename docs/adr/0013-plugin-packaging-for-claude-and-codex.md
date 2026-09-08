# 0013. One skill, two plugin bundles: Claude and Codex

- Status: accepted
- Date: 2026-09-05
- Deciders: @rishavanand
- Settled by: interview rounds 5 and 8 (stack lock, Plugin)

## Context and Problem Statement

The product is reached through an agent, and there are two agents to reach: Claude Code and
Codex CLI. Each has its own plugin format and its own marketplace. What they share is the
thing that actually matters — the craft guidance for writing a good explainer video, derived
from `max/.claude/skills/max-explainer/SKILL.md`, and the MCP endpoint that serves the eight
tools.

The temptation is to maintain two skills, because the two bundles have different manifest
shapes. That is how the two agents end up giving different advice, and how a tool renamed in
the protocol keeps being recommended in one of them.

## Decision Drivers

- One SKILL.md. The craft guidance is the product's differentiator and must not fork.
- The skill must be **backend-agnostic**: the same text has to be right whether the agent is
  talking to a local daemon or the hosted endpoint.
- Manifest shapes are somebody else's contract; getting one subtly wrong means the bundle
  installs and then does not connect, with no useful error.
- A tool named in SKILL.md that does not exist in the protocol is a documentation bug that
  presents as an agent failure.

## Considered Options

1. **Two hand-maintained plugin directories**, each with its own copy of SKILL.md.
2. **One source skill plus a build step** emitting `dist/claude-plugin/` and
   `dist/codex-plugin/` from shared inputs, with both manifests schema-validated in tests.
3. **Ship only a Claude plugin** now and add Codex later.

## Decision Outcome

Chosen: **option 2.** `packages/skill` holds one `SKILL.md` and two manifest sets;
`scripts/build.mjs` emits both bundles:

- `dist/claude-plugin/.claude-plugin/{plugin.json,marketplace.json}`, `.mcp.json` at the
  bundle root, and `skills/xplainer/SKILL.md`;
- `dist/codex-plugin/.codex-plugin/plugin.json`, `.mcp.json` at the bundle root, and
  `skills/xplainer/SKILL.md`.

Both `.mcp.json` files point at `https://mcp.xplainer.video/mcp` (ADR 0009); the Codex one
additionally carries `oauth_resource`.

Option 1 was rejected on the driver above — two copies of guidance is one copy of guidance
and one copy of drift. Option 3 was rejected because supporting Codex is nearly free once
the build step exists, and adding a second target later, after the Claude bundle has grown
Claude-shaped assumptions, is not free.

**The manifest shapes were confirmed against real installed plugins rather than written from
memory**, which is the whole reason this is tractable: the Claude shapes come from an
installed marketplace plugin's `.claude-plugin/` directory, and the Codex shapes from
installed Codex plugins whose `.codex-plugin/plugin.json` declares `"skills": "./skills/"`
alongside `"mcpServers": "./.mcp.json"`, with the remote server shape
`{"type":"http","url":...,"oauth_resource":...}`. `.app.json` — the other candidate that the
spec listed as an open question — turns out to be a separate OpenAI app-directory binding,
not an MCP mechanism.

Two tests hold the bundles honest, and both assert relationships rather than existence:

- **Ajv validates both manifests** against vendored schemas, so a shape error fails the
  build rather than the install.
- **Every `explainer_*` identifier mentioned in SKILL.md must be a subset of `TOOL_NAMES`**
  from `@xplainer/protocol`. Documentation that names a tool the protocol does not have is
  caught at build time.

## Consequences

- **`SKILL.md` is written backend-neutral**, with an explicit "prefer local tools when
  present" instruction. The craft sections from `max` — mechanism over bullets, motion,
  narration, and that timings are authoritative — are kept intact; what changes is the
  removal of `max`-specific job-queue and workspace-path wording, and the addition of
  `explainer_put_source` and `explainer_put_media` to the tool table.
- **These manifest shapes were read from cached vendor plugins, not from published
  documentation.** That is a real residual risk and it is confirmed against current Codex
  documentation at implementation time; the Ajv tests then lock whatever shape is confirmed.
- **The subset check is one-directional on purpose.** SKILL.md need not mention every tool
  — it should not mention one that does not exist. Requiring full coverage would make the
  skill a schema dump instead of guidance.
- **Marketplace submission is out of scope for this phase** (spec §Non-Goals); the bundles
  build and validate locally and in CI, and submission is a phase-4 item.
- **The plugin URL is a hard dependency on ADR 0009's endpoint**, and `apps/web`'s
  `siteConfig.mcpUrl` is asserted equal to it so the site and the shipped bundles cannot
  disagree about where the service lives.

## Consequences (addendum, 2026-09-05): the Codex manifest, confirmed

The Consequences above flagged a residual risk in plain terms — "**These manifest shapes were
read from cached vendor plugins, not from published documentation.** That is a real residual
risk and it is confirmed against current Codex documentation at implementation time." That
confirmation has now been done, against three source classes rather than one. Full evidence is
in [`docs/open-questions-resolution.md`](../open-questions-resolution.md).

**The verdict on the emitted Codex bundle is: correct on the parts that would fail silently,
incomplete on the parts a public listing needs.**

- **Confirmed by shipped vendor artefacts (strongest class).** `github.com/openai/plugins` at
  HEAD `1e28582` (2026-08-28) ships 62 plugins, 26 of them declaring a remote MCP server. All
  26 write `type` and `url`; four — figma, linear, notion, shopify — use exactly our
  `{"type":"http","url":...,"oauth_resource":...}` shape. Our `.mcp.json` is structurally
  identical to linear's. The `.codex-plugin/plugin.json` path, the `"skills": "./skills/"` and
  `"mcpServers": "./.mcp.json"` path strings, and `.mcp.json` living at the bundle root rather
  than inside `.codex-plugin/` are all confirmed against those manifests.
- **Confirmed by CLI validation.** Codex CLI 0.153.4 ships OpenAI's own ingestion-mirroring
  validator at `~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py`. There is no
  `codex plugin validate` subcommand; this script is the only local gate. Run against
  `dist/codex-plugin`, it reports "Plugin validation passed".
- **Contradicted by the documentation, in the exact way this record predicted.** The published
  docs show the `.mcp.json` wrapper key as `mcp_servers`; the loader deserialises `mcpServers`
  (camelCase), which is what all 31 shipped `.mcp.json` files use and what we already emit. A
  bundle written from the documentation installs cleanly and registers no server, with no
  useful error — precisely the failure mode named in this record's Decision Drivers. Tracked as
  `openai/codex#22105`, open and unresolved. The regression test should assert the literal key
  so nobody "corrects" it back to the docs.
- **A validator pass is not a submission guarantee, and the ADR should not imply otherwise.**
  The same validator rejects 27 of OpenAI's own 62 shipped plugins — including linear, notion,
  slack, stripe, vercel and remotion — 25 of them solely for `interface.supportURL` or
  `interface.brandColorDark`, fields OpenAI itself now ships. It is a version-pinned scaffold
  check, not the ingestion contract.

**What this changes about the Ajv test.** The test premise in the Decision Outcome —
"Ajv validates both manifests against vendored schemas" — stands, but the schemas are ours, not
the vendor's, and `packages/skill/schemas/codex-plugin.schema.json` is now measurably narrower
than what Codex accepts: it omits `id`, forbids the documented object form of `mcpServers`,
enumerates `category` and `capabilities` far too tightly, and marks `homepage`, `keywords`,
`license` and `interface.brandColor` required where Codex treats them as optional. Its
`$comment` claim that "OpenAI publishes no schema" is now false on two counts. Widen it against
the shipped manifests, keep it for editor hints, and make the vendored vendor validator the
gate.

**What is still missing, and it is listing metadata rather than shape.** Against the 62 shipped
manifests, `codex-plugin/plugin.json` lacks `interface.privacyPolicyURL` (59/62),
`interface.termsOfServiceURL` (59/62), `interface.logo` (58/62), `interface.composerIcon`
(55/62) and top-level `repository` (50/62). The first two are scored as *errors* by OpenAI's own
`plugin-eval`; both need real published pages, which is a web and legal task rather than a code
one, and therefore the long pole. The icon fields require the asset files to exist, so they
cannot be added naively.

**One layout prohibition worth recording so it is never re-explored blind.** Codex now also
discovers `.claude-plugin/plugin.json` and a root Agent Plugins `plugin.json`, which makes a
single vendor-neutral bundle look tempting. It is not: Agent Plugins v1 "defines no OAuth
configuration or portable credential-reference fields", so it cannot express `oauth_resource` at
all — and a root `plugin.json` sitting beside `.codex-plugin/` takes precedence and contributes
**zero** MCP servers, silently. The two-bundle build this record chose is the right shape; the
addition is that neither emitted bundle may contain a root `plugin.json`.

**Marketplace submission remains a phase-4 item, but it is not free and it constrains ADR 0009.**
The public path is a review portal, not a bundle upload: domain verification by serving a token
at `https://<host>/.well-known/openai-apps-challenge`, a "Scan Tools" pass over the production
MCP URL, verified business identity, and five positive plus three negative test cases. Two
consequences land on other records. First, our authorization server (ADR 0009) must be checked
against `codex mcp login` before the listing — `oauth_resource` alone works for figma, linear
and notion because their issuers support CIMD or Dynamic Client Registration; an issuer that
requires a pre-registered client needs `oauth.client_id` in `.mcp.json`, as airtable, slack and
zoom ship. Second, **skills imported from MCP are a submission-time snapshot**: changing
`SKILL.md` does not update a published plugin without a re-scan, re-submit and re-publish. That
directly constrains how often the craft guidance — the differentiator this record is built
around — can ship.

## Note, 2026-09-06: the bundles now declare a local transport, and this record's research memo relocated

Added as a dated note rather than a rewrite. The decision — one `SKILL.md`, two plugin bundles
built from it, `copyVerbatim` for each `.mcp.json` — is unchanged, and so is every argument
below. Two of its inputs moved.

**The `.mcp.json` transport.** Both bundles declared `{"type":"http","url":"https://mcp.xplainer.video/mcp"}`,
and the Codex bundle additionally declared `oauth_resource` to start an OAuth 2.1 discovery
flow against [ADR 0009](0009-remote-mcp-and-oauth-2-1-with-external-authorization-server.md)'s
resource server. [ADR 0023](0023-split-the-repository.md) relocated the hosted tier, and this
repository no longer describes the DNS record or the service behind that hostname. Shipping the
bundles unchanged would publish an install that silently does nothing, to two marketplaces, and
**a marketplace fetch is not retractable**. Both bundles therefore declare a local stdio server
(`npx -y @xplainer/cli mcp`), and the Codex bundle drops `oauth_resource` entirely: a loopback
daemon has no authorization server, and leaving the key makes the client fire a discovery
request at a host that will not answer.

Two caveats belong on the record rather than in a commit message.

- **`stdio` is the form this record's own successors already chose, and it is the form that
  does not work yet.** `xplainer mcp` is a registered stub that exits 2 until roadmap phase 1.
  The transport that answers *today* is loopback HTTP on port 8787, and it was rejected anyway:
  [ADR 0020](0020-always-running-local-daemon.md) has already decided the daemon carries a
  bearer token on every TCP route with a `Host` allowlist and `Origin` validation, and that
  `xplainer connect` writes a stdio entry carrying no token and no URL over an IPC socket.
  Publishing the loopback-HTTP form would mean publishing a configuration already decided
  against. **Neither bundle may be submitted to a marketplace until `xplainer mcp` is real.**
  Publishing a dead URL and publishing a command that exits 2 are the same failure wearing
  different clothes.
- **`packages/skill/schemas/codex-plugin.schema.json` needs no change**, and this is said so
  that nobody "fixes" it: its `mcpServers` is required but typed as a *string path*
  (`"./.mcp.json"`), so the schema never sees the transport at all. Likewise the `$id` values
  under `packages/skill/schemas/` use `https://schemas.xplainer.video/…`; those are JSON Schema
  identifiers, not URLs anything fetches.

**The addendum's evidence memo relocated.** The 2026-09-05 addendum above cites
`docs/open-questions-resolution.md` for its full evidence. That memo was **removed to the
private repository** `BrewMyTech/xplainer-hosted` by ADR 0023 — it is an internal risk
assessment carrying margin arithmetic and an unsent draft email to a vendor, and it is not a
decision record, so no immutability convention protected it. The addendum's citation is left
exactly as written; see [`README.md` § Provenance](README.md) for the repository, the path and
the commit SHA at which it resolves. The addendum's *findings* are not affected: they are
stated in full in the addendum itself, which is what a reader here needs.

## Note, 2026-09-08: `xplainer mcp` is real, and the submission bar has moved to the publish

Added as a dated note rather than a rewrite. The decision — one `SKILL.md`, two plugin bundles built
from it, `copyVerbatim` for each `.mcp.json` — is unchanged. One of its conditions is now half
discharged, and saying which half is the point of this note.

The note of 2026-09-06 above bars submission in these words: "**Neither bundle may be submitted to a
marketplace until `xplainer mcp` is real.** Publishing a dead URL and publishing a command that exits
2 are the same failure wearing different clothes." **`xplainer mcp` is real.** It is a working stdio
MCP server, it attaches to a running daemon, and `xplainer connect claude` and `xplainer connect
codex` register it with both vendor CLIs and were verified against live installations.

**The bar has not lifted, because the command in the bundles is `npx -y @xplainer/cli mcp` and the
package is not published.** As of 2026-09-08 nothing of ours is on npm — the constraint is the
owner's and it is dated, and [ADR 0027](0027-relocatable-runtime-artefact-and-the-supervisor-switch.md)
records it as dated context rather than as a decision. A marketplace fetch is not retractable, and an
install whose `command` resolves to nothing is exactly the "publishes an install that silently does
nothing" this record's own note refused. So submission is **additionally gated on the publish**: both
conditions must hold, and only one of them does.

Two smaller facts belong beside it, so that a future reader does not mistake this for a packaging
defect. First, the shape in the bundles is right — a local stdio server is the transport ADR 0020 and
ADR 0027 both land on, and the runtime the daemon actually installs is reached through a **stable
launcher** at `<state>/bin/xplainer`, which is what `xplainer connect` writes into an agent's
configuration on a machine where the package was never installed from a registry. Second, when the
publish happens, nothing in this record changes: the `npx` form starts working, the second half of
the bar clears, and the bundles are submittable exactly as they are built today.
