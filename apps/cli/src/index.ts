/**
 * `@xplainer/cli` as a library.
 *
 * The package's main job is the `xplainer` binary, but its server core is
 * imported rather than re-implemented by `services/media-service` (plan §4 S2.8,
 * §5 R20): the hosted image binds the same `createServer()` app, over the same
 * `@xplainer/mcp-server` registration, so the local daemon and the container
 * serve one tool contract from one code path.
 *
 * `src/api/` is exported for a second reason: `apps/desktop` depends on this package, and the
 * `/api/*` shapes it consumes — `ApiVideo`, `ApiArtefact`, `ApiJobQueued`, the error body, the
 * event names and the path builders — are defined here and imported there rather than being
 * described twice. A route the daemon moves is then a type error in the desktop's build instead of
 * a `404` a user finds.
 *
 * The command layer (`program.ts`, `commands/`) is deliberately not exported —
 * it is the binary's business, and nothing else should be building an `xplainer`
 * command tree. `src/daemon/` is not exported either: the store, the lock, the
 * reconciler and the runner are the local runtime's own machinery, and
 * `createLocalBackend()` takes the runner as an argument rather than reaching
 * for one, which is what keeps that boundary a compile-time fact.
 */

export type {
  ApiErrorBody,
  ApiErrorCode,
  ApiRefusal,
} from "./api/errors.js";
export type { JobStreamEnd } from "./api/events.js";
export {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_JOB_POLL_INTERVAL_MS,
  END_EVENT,
  JOB_EVENT,
  RECONNECT_DELAY_MS,
} from "./api/events.js";
export type { ApiJobQueued } from "./api/jobs.js";
export {
  API_PREFIX,
  artefactPath,
  enqueuePath,
  jobEventsPath,
  jobPath,
  videoPath,
  videosPath,
} from "./api/paths.js";
export type { ApiSeam } from "./api/routes.js";
export type {
  ApiArtefact,
  ApiVideo,
  ArtefactFile,
  ArtefactKind,
  VideoLibrary,
  WorkspaceLibraryOptions,
} from "./api/videos.js";
export { createWorkspaceLibrary } from "./api/videos.js";
export type { CreateLocalBackendOptions, LocalBackendCode } from "./backend.js";
export { createLocalBackend, LocalBackendError } from "./backend.js";
export {
  NOT_IMPLEMENTED_EXIT_CODE,
  NOT_IMPLEMENTED_MESSAGE,
  notImplementedLine,
} from "./not-implemented.js";
export type {
  CreateServerOptions,
  DrainAcknowledgement,
  DrainSeam,
  GuardFactory,
  RunningServer,
  StartServerOptions,
} from "./server.js";
export {
  createServer,
  DEFAULT_HOSTNAME,
  DEFAULT_PORT,
  DRAIN_PATH,
  startServer,
} from "./server.js";
export { CLI_VERSION } from "./version.js";
export type { WorkspaceEnvironment } from "./workspace-root.js";
export { resolveWorkspaceRoot, VIDEOS_DIR_ENV, WORKSPACE_DIR_NAME } from "./workspace-root.js";
