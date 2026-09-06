/**
 * `@xplainer/mcp-server` — the shared MCP tool registration.
 *
 * Import `createMcpServer` to serve the eight explainer tools over any
 * transport, and `RenderBackend` to implement them. Nothing here decides where
 * the work happens; that is the backend's business.
 *
 * `assertAgentOwnedPaths` and `EngineOwnedPathError` are exported for the one
 * case the registration cannot cover: a backend reached without going through
 * `createMcpServer()` — the CLI's own subcommands, the media-service's internal
 * HTTP API — re-checks with the same function at the disk boundary, so the two
 * layers refuse the same paths with the same message (ADR 0018).
 */

export * from "./backend.js";
export * from "./put-source-guard.js";
export * from "./server.js";
