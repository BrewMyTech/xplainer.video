/**
 * Every path the `/api` surface answers on, written once.
 *
 * The desktop is a second program that has to build these URLs, and `apps/desktop` already depends
 * on `@xplainer/cli` — so the routes are registered from these builders **and** exported through
 * `src/index.ts`, rather than being spelled out here and spelled again in a renderer. A path that
 * only one of the two sides changes is then a type error in the desktop's build instead of a `404`
 * a user finds.
 *
 * The builders escape their arguments. A slug is `schemas/slug.json`'s pattern and could not need
 * it, but an artefact name comes off this machine's disk, and a file called `frame 1.png` must
 * produce a URL a player can actually fetch.
 */

/** Where the whole client surface is mounted, with no trailing slash. */
export const API_PREFIX = "/api";

/** `GET` — every video this machine holds, with its artefacts. */
export function videosPath(): string {
  return `${API_PREFIX}/videos`;
}

/** `GET` — one video, or `404` with `NO_SUCH_VIDEO`. */
export function videoPath(slug: string): string {
  return `${API_PREFIX}/videos/${encodeURIComponent(slug)}`;
}

/** `GET` — one artefact's bytes, with `Range` support. */
export function artefactPath(slug: string, name: string): string {
  return `${videoPath(slug)}/artefacts/${encodeURIComponent(name)}`;
}

/** `POST` — queue narration, a still, or a render for one video. */
export function enqueuePath(slug: string, verb: "narrate" | "still" | "render"): string {
  return `${videoPath(slug)}/${verb}`;
}

/** `GET` — one job, in the same shape `explainer_job` answers with. */
export function jobPath(jobId: number): string {
  return `${API_PREFIX}/jobs/${jobId}`;
}

/** `GET` — that job's progress as a `text/event-stream`. */
export function jobEventsPath(jobId: number): string {
  return `${jobPath(jobId)}/events`;
}
