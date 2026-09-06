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

export { createStubBackend } from "./backend.js";
export {
  NOT_IMPLEMENTED_EXIT_CODE,
  NOT_IMPLEMENTED_MESSAGE,
  notImplementedLine,
} from "./not-implemented.js";
export type { CreateServerOptions, RunningServer, StartServerOptions } from "./server.js";
export { createServer, DEFAULT_HOSTNAME, DEFAULT_PORT, startServer } from "./server.js";
export { CLI_VERSION } from "./version.js";
