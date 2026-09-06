# 0002. Language split: Python control plane, TypeScript media plane

- Status: accepted — **the hosted half is relocated**, see [ADR 0023](0023-split-the-repository.md)
- Date: 2026-09-05
- Deciders: @rishavanand
- Settled by: interview round 8 — "Lock, but Python for hosted API"

> **Relocated on 2026-09-06 by [ADR 0023](0023-split-the-repository.md).** The Python control
> plane this record chose — `apps/api` — now lives in the private repository
> `BrewMyTech/xplainer-hosted`; it is deferred pending a vendor answer, **not cancelled**. The
> decision below is unchanged and is not rewritten. It is kept here because half its subject
> did not move: it is still the record that explains why the media plane and the local runtime
> are TypeScript, which is the half of the split this repository contains.

## Context and Problem Statement

The hosted service has two halves that fail for different reasons. The **control plane**
handles OAuth, accounts, plans and quotas, the job queue, billing and the remote MCP
endpoint. The **media plane** bundles user-authored Remotion TSX, drives Chrome Headless
Shell, calls the TTS service, and uploads the result to object storage.

The media plane has no real language choice: Remotion is a React renderer and its CLI,
bundler and browser integration are TypeScript. The control plane does, and the initial
proposal at round 8 was to write it in TypeScript too, on the argument that one language
is cheaper than two.

## Decision Drivers

- Remotion is TypeScript-only; the media plane is not negotiable.
- The team's existing server code — the whole `max` reference implementation — is FastAPI,
  and that is where the operational knowledge lives.
- Both languages have a first-party MCP SDK with a Streamable HTTP transport, so the
  agent-facing contract is not a tie-breaker.
- The tool contract must be *identical* on local and hosted (spec §Constraints/Contract),
  and a language boundary is exactly where a contract silently drifts.

## Considered Options

1. **All-TypeScript hosted service** — one language, one toolchain, the media plane's
   render code importable directly by the API.
2. **All-Python** — port the render pipeline to Python by shelling out to the Remotion CLI
   for everything, as the `max` reference implementation does today.
3. **Split: Python control plane (`apps/api`), TypeScript media plane
   (`services/media-service`), HTTP between them.**

## Decision Outcome

Chosen: **option 3 — the split**. `apps/api` is FastAPI plus the official `mcp` Python SDK;
`services/media-service` is a Node HTTP service the Python worker calls over the network.

Option 1 was rejected because it discards the team's actual server expertise for a
uniformity that mostly benefits a reader, not an operator. Auth, queueing, migrations and
billing are where the hosted service will spend its incident budget, and those are the
parts we have already run in production in Python.

Option 2 was rejected because it is what `max` does and it is the part of `max` that does
not generalise: driving Remotion from Python means every bundling, still and render
operation is a subprocess whose failure surface is a parsed stderr string. A first-party
Node service can hold the bundle in memory, reuse the browser, and return typed errors.

The cost of the split is one network boundary, and it was accepted because that boundary
also buys the render sandbox: the media plane already has to run each render in its own
container (ADR 0010), so an HTTP hop between the control plane and the renderer was going
to exist regardless of the language choice.

## Consequences

- **The protocol cannot live in either language.** `packages/protocol` holds JSON Schema as
  the single source of truth and generates *both* TypeScript types and pydantic models from
  it; CI fails if the generated output is stale (ADR 0007, AC-9). Without that, the split
  is two hand-maintained copies of one contract.
- **`packages/protocol` is therefore a `uv` workspace member as well as an npm one**
  (deviation D-1). Generating the pydantic models into `apps/api` instead would put
  `open-later` artefacts inside a `hosted` package and break the phase-5 extraction (ADR
  0003).
- **Two MCP server implementations exist and must be pinned by assertion, not by code
  reuse.** Every TypeScript surface is built from one `createMcpServer()` that iterates
  `TOOL_NAMES`, so the CLI daemon, the phase-1 stdio transport and the hosted media service
  are one registration. The Python surface cannot share that code, so `apps/api`'s pytest
  and the CLI's Vitest both compare `tools/list` against the protocol manifest — never
  against each other, and never against a literal list.
- **Two toolchains in one repository**, absorbed by ADR 0001's single Turbo graph rather
  than by asking contributors to remember a second command.
- **Contributors need both toolchains installed** to run the full check locally. Node LTS
  and `uv` is the whole list, and the three-OS `bootstrap` CI job proves it stays that way.
