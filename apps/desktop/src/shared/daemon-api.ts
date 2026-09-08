/**
 * The daemon's client surface, as both halves of this app have to name it.
 *
 * Two constants and one URL scheme, and they are `src/shared/` rather than `src/main/` because the
 * renderer needs them too: the library path is where a window starts, and the media scheme is what
 * a `<video>` element loads from. Nothing here reads a file or opens a socket, so the preload
 * bundle can carry it into a context that has no Node built-ins.
 *
 * **Two paths are spelled out and no other is.** `/api/videos` is where a window begins, and the
 * enqueue routes are the one family no answered document carries a URL for — a video's listing
 * describes what it *has*, not what may be asked of it. Every other path — an artefact's bytes, a
 * job, a job's event stream — is followed from what the daemon answered, because those routes carry
 * their own URLs, which is why a route the daemon moves cannot leave a stale copy behind here.
 * `daemon-api.test.ts` pins both builders against `@xplainer/cli`'s own, so the two are one edit
 * apart.
 */

/**
 * Where the client surface is mounted.
 *
 * Must equal `API_PREFIX` in `apps/cli/src/api/paths.ts`; `bridge.test.ts` imports that module's
 * `videosPath()` and compares, so the two are one edit apart.
 */
export const API_PREFIX = "/api";

/** The library route. `videosPath()` in `@xplainer/cli`. */
export const VIDEOS_PATH = `${API_PREFIX}/videos`;

/**
 * Which of the three long-running tools a window may queue.
 *
 * `narrate` is deliberately not one. `explainer_narrate` takes a `narration` document whose segment
 * ids have to be the scene ids in the video's own `Scenes.tsx`, and composing one is the agent's
 * work — a window that offered a button for it would have to invent a script. The two verbs left
 * take no arguments at all, and this is the closed set the route is built from.
 */
export const ENQUEUE_VERBS = ["still", "render"] as const;

/** One of {@link ENQUEUE_VERBS}. */
export type EnqueueVerb = (typeof ENQUEUE_VERBS)[number];

/** Whether an unvalidated value off the IPC boundary is a verb this app will build a route for. */
export function isEnqueueVerb(value: unknown): value is EnqueueVerb {
  return typeof value === "string" && (ENQUEUE_VERBS as readonly string[]).includes(value);
}

/**
 * Where one of those is queued. `enqueuePath()` in `@xplainer/cli`.
 *
 * The slug is escaped for the same reason the CLI's builder escapes it: it reaches this function
 * from a listing rather than from a literal, and a URL is not a place to find out that it needed to
 * be.
 */
export function enqueuePath(slug: string, verb: EnqueueVerb): string {
  return `${VIDEOS_PATH}/${encodeURIComponent(slug)}/${verb}`;
}

/**
 * The scheme a renderer's `<video>` and `<img>` load artefacts from.
 *
 * A custom scheme rather than the daemon's own URL, because an element that fetched the daemon
 * directly would need the bearer token in the page — and a token in a page is a token that must be
 * reachable from a browser origin, which is the CORS the daemon must never have (R-SEC-7). The main
 * process registers a handler for this scheme, adds the `Authorization`, and streams the answer
 * back with its `Range` intact.
 */
export const MEDIA_SCHEME = "xplainer-media";

/**
 * The URL a renderer loads one artefact from.
 *
 * The daemon path is carried whole, so what a window asks for is exactly the `url` the library gave
 * it. The host segment is `artefact` because a custom scheme needs one to parse at all.
 */
export function mediaUrl(apiPath: string): string {
  return `${MEDIA_SCHEME}://artefact${apiPath}`;
}

/** The daemon path a media URL asks for, or `null` when it asks for something else entirely. */
export function mediaPath(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${MEDIA_SCHEME}:`) {
    return null;
  }
  const path = `${parsed.pathname}${parsed.search}`;
  return path.startsWith(`${API_PREFIX}/`) ? path : null;
}
