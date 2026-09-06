# AGENTS.md — `@xplainer/mcp-server`

Workspace rules and the post-change procedure: root [`AGENTS.md`](../../AGENTS.md).

## What this package is

**Backend-agnostic MCP tool registration.** `createMcpServer(backend, options?)` builds an
`McpServer`, iterates `TOOL_NAMES` from `@xplainer/protocol`, and registers each tool with the
title and description the generated manifest carries. Every surface that serves the contract —
`apps/cli` today, the hosted media service in its own repository — mounts the same registration, so
there is exactly one implementation of "what the tools are".

The `RenderBackend` interface is the seam. This package knows the shape of a call and nothing about
how it is answered.

## Public surface

From `src/index.ts`, an explicit named-export list: `createMcpServer`, `MCP_SERVER_NAME`,
`MCP_CONTRACT_VERSION`, `CreateMcpServerOptions`, the `RenderBackend` and `RenderBackendMethod`
types, and the put-source guard (`assertAgentOwnedPaths`, `EngineOwnedPathError`,
`ENGINE_OWNED_PATH_ERROR_CODE`). Published, emits declarations, carries `api/mcp-server.api.md`.

`MCP_CONTRACT_VERSION` lives **here**, not in `apps/cli`. It reads the manifest's version.

## Commands

```bash
pnpm --filter @xplainer/mcp-server test
pnpm turbo build --filter @xplainer/mcp-server   # where TS9010 appears
```

Then the root procedure: `pnpm verify`.

## Invariants

- **Never register a tool outside `TOOL_NAMES`.** The registration loop is the mechanism; adding a
  tool means adding it to `packages/protocol`'s schemas and manifest, never here.
- **`tools/list` equals the manifest by construction** (`AC-14d`, asserted end-to-end from
  `apps/cli`). Anything that makes the two lists differ is a bug in this file, not a discrepancy to
  paper over downstream.
- **The backend interface is the seam, so no render and no TTS code lives here.** Not a Remotion
  import, not a Kokoro call. If you need one, you are in the wrong package.
- **No supervisor code here either.** Process supervision, state files and the daemon lifecycle
  belong to `apps/cli` — [ADR 0019](../../docs/adr/0019-sequencing-local-cli-before-hosted.md) kill
  criterion 6, restated in
  [ADR 0020](../../docs/adr/0020-always-running-local-daemon.md).
- **The put-source guard is a runtime gate, not a duplicate of the schema.**
  `explainer_put_source.input.json` reserves the five engine-owned names in the published contract;
  `assertAgentOwnedPaths` refuses the write at the door, because a hand-edited `Video.tsx` renders
  successfully and silently drops the soundtrack ([ADR 0018](../../docs/adr/0018-engine-owns-the-composition-shell.md)).
- **`isolatedDeclarations` is on `tsconfig.build.json`.** `MCP_SERVER_NAME` and
  `MCP_CONTRACT_VERSION` carry explicit `: string` annotations for that reason; keep them.

## How to add

**A backend method:** add it to the `RenderBackend` type, register the tool's handler in
`src/server.ts`, and update `createStubBackend` in `apps/cli` so the stub still satisfies the
interface.

**An export:** add it to `src/index.ts` explicitly — no `export *` — then `pnpm api:report` and
commit the `.api.md` diff, which is what a reviewer reads.

Finish with `pnpm verify`.
