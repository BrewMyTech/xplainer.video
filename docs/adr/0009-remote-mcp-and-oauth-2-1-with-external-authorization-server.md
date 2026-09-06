# 0009. Remote MCP over Streamable HTTP, OAuth 2.1 resource server, external authorization server

- Status: accepted — **the hosted endpoint is relocated**, see [ADR 0023](0023-split-the-repository.md)
- Date: 2026-09-05
- Deciders: @rishavanand
- Settled by: interview round 5 ("do what's standard for such application"), refined at
  round 8

> **Relocated on 2026-09-06 by [ADR 0023](0023-split-the-repository.md).** The remote MCP
> endpoint and the OAuth 2.1 resource server described below are built in the private
> repository `BrewMyTech/xplainer-hosted`; they are deferred pending a vendor answer, **not
> cancelled**. The decision is unchanged and is not rewritten. It is kept here on purpose: it
> is the record that explains why the **local** daemon has no OAuth and authenticates with a
> loopback bearer token instead ([ADR 0020](0020-always-running-local-daemon.md)) — a question
> a reader of `apps/cli` will ask, and which nothing else in this repository answers.

## Context and Problem Statement

A single plugin bundle ships to the Claude and Codex marketplaces. It cannot know, at
install time, whether the user has the local daemon running, and it must work for a user
who has installed nothing but the plugin. Round 5 asked how one marketplace install reaches
the right backend, and the answer had to follow the ecosystem norm rather than invent one,
because the client is someone else's product.

The norm for a marketplace-installed MCP server is a **remote Streamable HTTP endpoint with
OAuth 2.1**. That immediately raises a second question: who issues the tokens? The MCP
authorization specification models the MCP server as an OAuth **resource server** and allows
the authorization server to be a separate system, discovered through protected-resource
metadata.

## Decision Drivers

- Follow the client ecosystem's standard flow; a bespoke auth scheme means agents cannot
  connect, and no amount of correctness argues around that.
- Identity is required before free-tier quota can mean anything (ADR 0014).
- Auth is the highest-consequence code we could write ourselves, and the least
  differentiating.
- The hosted API is Python (ADR 0002), so the chosen path must be supported by the official
  `mcp` Python SDK.

## Considered Options

1. **API keys** pasted into the plugin config.
2. **Self-hosted authorization server** — our own OAuth 2.1 AS, with Authlib in FastAPI.
3. **OAuth 2.1 with an external IdP as the authorization server** (Auth0 or WorkOS
   AuthKit), `apps/api` acting purely as the resource server that validates tokens and
   publishes protected-resource metadata.

## Decision Outcome

Chosen: **option 3.** `https://mcp.xplainer.video/mcp` is a Streamable HTTP MCP endpoint;
`apps/api` is an **OAuth 2.1 resource server**; the **authorization server is an external
IdP** in v1 — Auth0 or WorkOS AuthKit, both of which document the MCP flow specifically.

Option 1 was rejected because a pasted key is not the flow the marketplace clients
implement, it has no revocation or consent story, and it puts a long-lived secret in a
config file the user will paste into a chat window sooner or later.

Option 2 was rejected **for v1 only, and for a reason that is about sequencing rather than
capability**: running an authorization server means owning token issuance, refresh,
rotation, consent screens and the incident that follows any mistake in them — before the
product has a single paying user. Authlib remains the path if self-hosting later becomes
worth it, and because `apps/api` is only ever a resource server, swapping the issuer is a
configuration change plus a metadata document, not a rewrite.

`apps/api/src/xplainer_api/settings.py` carries `oauth_issuer` and `oauth_audience` as
optional settings with local defaults, so the app imports and runs with no environment
configured — which is what lets the scaffold's `/healthz` and `/mcp` tests run with no IdP
in the loop.

**No authentication is implemented in this phase** (spec §Non-Goals). The scaffold serves
`/healthz` and an unauthenticated placeholder `/mcp` whose `tools/list` matches the protocol
manifest. The token verifier arrives with roadmap phase 3.

## Consequences

- **The endpoint URL is a public contract from the first commit.** Both plugin bundles point
  at `https://mcp.xplainer.video/mcp`, and `apps/web`'s `siteConfig.mcpUrl` is asserted
  equal to it by a test so the marketing site and the shipped manifests cannot drift.
- **Mounting the MCP Streamable HTTP app inside FastAPI requires the session manager in the
  app lifespan.** Mounting the sub-app without running the session manager yields a `/mcp`
  route that accepts a request and then hangs or 500s — so `main.py` wires the session
  manager into the FastAPI `lifespan`, and `test_mcp_tools_list.py` exercises the real
  lifespan rather than calling the tool functions directly. A mis-wired mount fails the
  test instead of failing the first user.
- **An external IdP is a vendor dependency and a per-MAU cost line**, accepted in exchange
  for not operating token issuance.
- **The local daemon deliberately has no auth.** `xplainer serve` binds localhost and
  trusts the loopback boundary; non-localhost access needs a bearer token and is deferred
  to roadmap phase 2 (ADR 0016). Anyone exposing the daemon on a network before that is
  outside the supported configuration, and the roadmap says so.
- **The exact `mcp` Python SDK auth API (`TokenVerifier`, `AuthSettings`) is confirmed at
  implementation time**, not assumed here; it is one of the plan's named open questions and
  it gates phase 3, not this phase.
