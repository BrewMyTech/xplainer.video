/**
 * The `/api` client surface, assembled: what the desktop talks to, and what it is allowed to be.
 *
 * [ADR 0016](../../../../docs/adr/0016-cli-first-local-runtime-desktop-is-an-optional-client.md)
 * promises REST and SSE under `/api` for GUI clients beside the MCP endpoint, and this is it: list
 * the library, read one video, fetch its bytes with `Range`, queue the three long-running tools,
 * read a job and watch it. Nothing here is a second implementation of anything — every route is a
 * relay to `RenderBackend`, the same interface `/mcp` dispatches through, plus one filesystem seam
 * for the artefacts the tool contract deliberately does not describe.
 *
 * **Three rules this surface is held to.**
 *
 * 1. **The guard is the same guard.** These routes are registered *after* `createServer()` has
 *    mounted its middleware on `*`, so the bearer token, the `Host` allowlist and the `Origin`
 *    check cover them by construction on the TCP listener, and the IPC listener passes none —
 *    filesystem permissions on a `0700` directory are that transport's authentication. There is no
 *    per-route authentication here and there must never be one: a route that authenticated itself
 *    would be a route that can forget to (ADR 0020 §R-SEC-2).
 * 2. **No CORS middleware, ever, for any value** (R-SEC-7). Not `*`, not an allowlist, not "just for
 *    the dev server". The desktop's renderer never talks to this daemon directly — the main process
 *    holds the token and proxies (T23) — so there is no browser origin that needs to be allowed,
 *    and adding one would let any page a user visits read and drive this machine's daemon with the
 *    browser's own credentials attached.
 * 3. **`/api/daemon/drain` is not here.** It stays in `server.ts` beside the drain seam it needs,
 *    reachable over the socket only, because it is the daemon's control surface rather than a
 *    client's (T13, ADR 0024 §Drain on planned restart).
 *
 * The whole surface is **optional**: `createServer()` mounts it only when it is given
 * {@link ApiSeam}, so `services/media-service` binds the same application with `/healthz` and
 * `/mcp` and nothing that assumes a workspace on local disk.
 */

import type { RenderBackend } from "@xplainer/mcp-server";
import { Hono } from "hono";
import { registerJobEventRoutes } from "./events.js";
import { registerJobRoutes } from "./jobs.js";
import { registerMediaRoutes } from "./media.js";
import { registerVideoRoutes, type VideoLibrary } from "./videos.js";

/**
 * What the client surface needs that the tool contract does not carry.
 *
 * A seam rather than a workspace root, for the reason the guard is a parameter: `createServer()` is
 * bound by a daemon that resolved a state directory from flags, environment and a recorded value,
 * and by a container that has none of those. The daemon passes
 * `createWorkspaceLibrary({ root: daemon.workspaceRoot })` — the root the runner's workers already
 * write into — and a test passes one over a temporary directory.
 */
export type ApiSeam = {
  /** Where this machine's artefacts are, and how to open one. */
  library: VideoLibrary;
  /** How often an open SSE stream re-reads its job. Defaults to the daemon's own interval. */
  pollIntervalMs?: number | undefined;
  /** How long an open SSE stream may be silent before it writes a keep-alive comment. */
  heartbeatMs?: number | undefined;
};

/**
 * Build the router `createServer()` mounts under `/api`.
 *
 * The routes are registered in one place rather than four so that the order is visible: the media
 * route is a `:name` under `/videos/:slug`, and the library's `/videos/:slug` is not a prefix of it
 * by accident.
 */
export function createApiRoutes(backend: RenderBackend, seam: ApiSeam): Hono {
  const api = new Hono();
  registerVideoRoutes(api, { backend, library: seam.library });
  registerMediaRoutes(api, { library: seam.library });
  registerJobRoutes(api, { backend });
  registerJobEventRoutes(api, {
    backend,
    pollIntervalMs: seam.pollIntervalMs,
    heartbeatMs: seam.heartbeatMs,
  });
  return api;
}
