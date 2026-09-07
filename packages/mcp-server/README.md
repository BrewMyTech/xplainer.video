# @xplainer/mcp-server

**Backend-agnostic MCP tool registration for the eight explainer tools.**
`createMcpServer(backend, options?)` builds an `McpServer`, walks `TOOL_NAMES` from
[`@xplainer/protocol`][protocol], and registers every tool with the title, description and
schemas the generated manifest carries. Every surface that serves the contract mounts this same
registration, so there is exactly one implementation of *what the tools are*.

```bash
npm i @xplainer/mcp-server
```

```ts
import { createMcpServer, type RenderBackend } from "@xplainer/mcp-server";

const backend: RenderBackend = {
  /* one method per tool: explainer_create, explainer_put_source, … */
};

const server = createMcpServer(backend);
```

`RenderBackend` is the seam. This package knows the shape of a call and nothing about how it is
answered — `@xplainer/cli` answers it from the local disk, and a hosted service answers the same
interface over its own storage.

It also ships the `explainer_put_source` guard: `assertAgentOwnedPaths()` refuses a write to any
of the five engine-owned files and throws an `EngineOwnedPathError`, so a backend cannot forget
the rule that keeps the composition shell intact.

The exported surface is recorded in `api/mcp-server.api.md` in the repository.

## Docs

- [Architecture][architecture] — the members and the dependency direction
- [Decision records][adr] — the tool contract is ADR 0007, file ownership is ADR 0018
- [Roadmap][roadmap] — what is built and what is not

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`, both shipped inside this package.

[protocol]: https://www.npmjs.com/package/@xplainer/protocol
[architecture]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/ARCHITECTURE.md
[adr]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/adr/README.md
[roadmap]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/ROADMAP.md
