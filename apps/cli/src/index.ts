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
 * command tree. `src/daemon/` is not exported either: the store, the lock, the
 * reconciler and the runner are the local runtime's own machinery, and
 * `createLocalBackend()` takes the runner as an argument rather than reaching
 * for one, which is what keeps that boundary a compile-time fact.
 */

export type { CreateLocalBackendOptions, LocalBackendCode } from "./backend.js";
export { createLocalBackend, LocalBackendError } from "./backend.js";
export {
  NOT_IMPLEMENTED_EXIT_CODE,
  NOT_IMPLEMENTED_MESSAGE,
  notImplementedLine,
} from "./not-implemented.js";
export type {
  CreateServerOptions,
  GuardFactory,
  RunningServer,
  StartServerOptions,
} from "./server.js";
export { createServer, DEFAULT_HOSTNAME, DEFAULT_PORT, startServer } from "./server.js";
export { CLI_VERSION } from "./version.js";
export type { WorkspaceEnvironment } from "./workspace-root.js";
export { resolveWorkspaceRoot, VIDEOS_DIR_ENV, WORKSPACE_DIR_NAME } from "./workspace-root.js";
