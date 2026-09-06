/**
 * `@xplainer/cli` as a library.
 *
 * The package's main job is the `xplainer` binary, but its server core is
 * imported rather than re-implemented by `services/media-service` (plan §4 S2.8,
 * §5 R20): the hosted image binds the same `createServer()` app, over the same
 * `@xplainer/mcp-server` registration, so the local daemon and the container
 * serve one tool contract from one code path.
 *
 * The command layer (`program.ts`, `commands/`) is deliberately not exported —
 * it is the binary's business, and nothing else should be building an `xplainer`
 * command tree.
 */

export * from "./backend.js";
export * from "./not-implemented.js";
export * from "./server.js";
export * from "./version.js";
