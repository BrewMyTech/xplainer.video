---
"@xplainer/cli": minor
---

`serve` answers the `/api/*` REST and SSE surface a GUI client reads.

ADR 0016 promises "REST + SSE at `/api/*` for GUI clients" beside the MCP endpoint, and phase 1
built only `/healthz`, `/mcp` and — from T13 — the drain control route. The surface a desktop is
judged against now exists: the library, the artefact bytes, the three long-running tools, one job,
and the stream that reports it.

| Method | Path | Answers |
|---|---|---|
| `GET` | `/api/videos` | `{ videos: ApiVideo[] }` — the library, each entry with its artefacts |
| `GET` | `/api/videos/:slug` | one `ApiVideo` |
| `GET`/`HEAD` | `/api/videos/:slug/artefacts/:name` | the bytes, with `Range` |
| `POST` | `/api/videos/:slug/narrate` \| `/still` \| `/render` | `202` and a `job_id` |
| `GET` | `/api/jobs/:id` | `ExplainerJobOutput`, unchanged |
| `GET` | `/api/jobs/:id/events` | `text/event-stream` of that same document |

**Nothing here is a second implementation of a tool.** Every route relays to the same
`RenderBackend` `/mcp` dispatches through, so a window and an agent watching one render read one
description of it: `GET /api/jobs/:id` answers with exactly what `explainer_job` answers with, and
each SSE frame carries that document. The three `POST`s take the slug from the path and pass the
rest of the body through untouched, which leaves `backend.ts` the only place a refusal is decided.
The backend's refusal codes reach the client unchanged inside `{ error: { code, message } }`, with
the status this surface promised for each: `404` for `NO_SUCH_VIDEO`, `409` for
`NARRATION_MISSING`, `503` for `WORKSPACE_NOT_INSTALLED` and for a daemon that has stopped
accepting work mid-drain.

**What the tool contract deliberately does not carry, this surface does.** `ExplainerListOutput`'s
`mp4` is a path on the machine that answered — a hosted backend must not expose one and a player
cannot open one — so `ApiVideo` drops it and carries artefacts instead: the film, the stills, the
narration audio, the captions and the timings, each with the route that serves its bytes. That
route implements RFC 9110 §14 for a single byte range, which is the difference between a player and
a download: `206` with `Content-Range`, `416` outside the file, `Accept-Ranges` on every answer, and
the body read lazily so a 200 MB render costs one file descriptor rather than 200 MB of heap. An
artefact is fetched **by name out of an enumeration** and never by a path joined to what a client
sent, and the slug is checked against `schemas/slug.json`'s pattern before anything touches the
disk.

**The stream ends by itself.** A `job` frame is written only when the document changed, a comment
line keeps a silent render's connection provably alive, and a terminal job gets one last frame, an
`end` frame and a close — so a window does not have to decide when to stop listening and the daemon
does not accumulate streams over jobs that finished hours ago. A job this daemon has no record of
is a `404` before the stream opens, rather than a stream an `EventSource` would reconnect to for
ever.

**The guard is the guard that was already there.** The routes are registered after the middleware
`createServer()` mounts on `*`, so the bearer token, the `Host` allowlist and the `Origin` check
cover every one of them on TCP, and the IPC listener passes none — filesystem permissions on a
`0700` directory are that transport's authentication. There is no per-route authentication and
**no CORS middleware, for any value** (R-SEC-7): the desktop's renderer never talks to this daemon
directly, so no browser origin needs allowing, and one that was allowed would let any page a user
visits drive this machine's daemon with the browser's own credentials attached.

The whole surface is **optional**. `createServer()` mounts it only when it is given an `ApiSeam`,
so `services/media-service` binds the same application, over the same tool registration, with no
route that assumes a workspace on local disk.

New from `src/index.ts`, for `apps/desktop` to import rather than describe a second time:
`ApiSeam`, `createWorkspaceLibrary`, `VideoLibrary`, `ApiVideo`, `ApiArtefact`, `ArtefactKind`,
`ArtefactFile`, `ApiJobQueued`, `ApiErrorBody`, `ApiErrorCode`, `ApiRefusal`, `JobStreamEnd`,
`JOB_EVENT`, `END_EVENT`, `DEFAULT_JOB_POLL_INTERVAL_MS`, `DEFAULT_HEARTBEAT_MS`,
`RECONNECT_DELAY_MS`, `API_PREFIX`, `videosPath`, `videoPath`, `artefactPath`, `enqueuePath`,
`jobPath` and `jobEventsPath`.

The drain now has the case T13 specified and could not exercise: a drain asked for over the socket
with an **open SSE stream and a media body mid-transfer**, asserting that the acknowledgement is
complete before the listeners close and that closing them still finishes.
