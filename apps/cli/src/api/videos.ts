/**
 * The library the desktop shows: which videos exist, and which files each one has produced.
 *
 * Two questions, deliberately answered by two different things. **What a video *is*** —
 * `has_narration`, `rendered`, how long it runs, how big the MP4 is — comes from
 * `explainer_list`, the tool an agent already calls, so the window and the agent cannot disagree
 * about a video's state. **What a video has *on disk*** is this file's own, because the tool
 * contract deliberately does not carry it: `ExplainerListOutput`'s `mp4` is a path on the machine
 * that answered, its schema says a hosted backend must not expose one, and a player needs a URL it
 * can fetch rather than a path it cannot open. So `ApiVideo` drops `mp4` and carries
 * {@link ApiArtefact}s instead, each with the route that serves its bytes.
 *
 * **The library is a seam.** `createWorkspaceLibrary()` is the local implementation, over the same
 * `videoPaths()` layout `backend.ts` and the workers use; `services/media-service` would pass its
 * own, and a test passes one over a temporary directory. Nothing in the routes knows what a
 * workspace looks like.
 *
 * **An artefact is fetched by name, and the name is never joined onto a path.** `open()` enumerates
 * what the video has and returns the entry whose name matches exactly, so `..%2f..%2fetc%2fpasswd`
 * is a `404` for the same reason `frame-3.png` is when no such still was rendered — it is not in
 * the enumeration — rather than because a check spotted it. The slug is checked against
 * `schemas/slug.json`'s pattern before either function touches the disk, because the slug *is* a
 * directory name.
 */

import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { RenderBackend } from "@xplainer/mcp-server";
import { videoPaths } from "@xplainer/render-core";
import type { Hono } from "hono";
import { refusal, refusalFor, sendRefusal } from "./errors.js";
import { artefactPath } from "./paths.js";

/**
 * `schemas/slug.json`'s pattern, verbatim — the third copy, and pinned like the other two.
 *
 * `backend.ts` carries it because a slug reaching it has been validated by nothing; this file
 * carries it because a slug reaching *these* routes has been validated by nothing either, and
 * arrives one path segment away from `readdir`. `api/videos.test.ts` reads the schema and compares,
 * exactly as `backend.test.ts` does, so the copies cannot drift from the contract.
 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Whether this is a slug at all, asked before anything is built out of it. */
export function isVideoSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

/**
 * Which of a video's files this is.
 *
 * A closed set, ordered the way the desktop reads them: the finished film first, then the layout
 * checks, then what narration produced. A file the workspace holds that is not one of these — a
 * bundle cache, a half-written frame — is not an artefact and is not served.
 */
export type ArtefactKind =
  /** `out/<slug>/explainer.mp4` — the finished render. */
  | "video"
  /** `out/<slug>/frame-<n>.png` — one still, from a layout check. */
  | "still"
  /** `public/<slug>/narration.wav` — the measured voiceover. */
  | "narration"
  /** `public/<slug>/captions.json`. */
  | "captions"
  /** `public/<slug>/timings.json` — where every scene length comes from. */
  | "timings";

/** One file a video has produced, and where to fetch it. */
export type ApiArtefact = {
  kind: ArtefactKind;
  /** The file's own name, which is also the last segment of {@link url}. */
  name: string;
  /** The route that serves the bytes, `Range` included. */
  url: string;
  /** What the route sends as `Content-Type`. */
  content_type: string;
  /** Size in bytes, as of this listing. */
  bytes: number;
  /** Last modification, as an ISO-8601 timestamp with a timezone offset. */
  modified_at: string;
};

/**
 * One video, as a client sees it.
 *
 * The nullable fields are `null` rather than absent — `ExplainerListOutput` omits them, and an
 * omitted field makes a reader tell "this video has no narration" apart from "this daemon is too
 * old to say", which is a distinction no client wants to make. Same reasoning as `/healthz`'s
 * identity fields.
 */
export type ApiVideo = {
  slug: string;
  has_narration: boolean;
  rendered: boolean;
  /** Narration length in seconds, or `null` when it has never been narrated. */
  seconds: number | null;
  /** MP4 size in megabytes, or `null` when nothing has been rendered. */
  size_mb: number | null;
  /** Every file this video has produced, newest listing at request time. */
  artefacts: ApiArtefact[];
};

/** One artefact as a file, which is what the media route needs to answer a `Range`. */
export type ArtefactFile = {
  /** Absolute path on this machine. Never sent to a client. */
  path: string;
  /** Size in bytes, read in the same breath as the path was resolved. */
  bytes: number;
  contentType: string;
  /** Last modification, for `Last-Modified`. */
  modifiedAt: Date;
};

/** Where a video's files are, and how to open one. The routes know nothing else about a workspace. */
export type VideoLibrary = {
  /** Everything {@link videoArtefacts} would find for this slug, in a stable order. */
  artefacts(slug: string): ApiArtefact[];
  /** One artefact by exact name, or `null` when this video has no such file. */
  open(slug: string, name: string): ArtefactFile | null;
};

/** What `createWorkspaceLibrary` needs: the root `resolveWorkspaceRoot()` produced. */
export type WorkspaceLibraryOptions = {
  root: string;
};

/** `Content-Type` by extension, for the five things a video can produce. */
const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".wav": "audio/wav",
  ".json": "application/json",
};

/** The stills a render leaves in `out/<slug>`, and the frame number in each name. */
const STILL_PATTERN = /^frame-(\d+)\.png$/;

function contentTypeFor(name: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot === -1 ? "" : name.slice(dot).toLowerCase();
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

/** One candidate file, described before anything has been asked of the filesystem. */
type Candidate = { kind: ArtefactKind; path: string };

/**
 * Every file this video could have, in the order a listing reports them.
 *
 * The stills are read out of `out/<slug>` and sorted by frame number rather than by name, because
 * `frame-9.png` sorts after `frame-100.png` as a string and a layout check reads as a sequence.
 */
function candidates(root: string, slug: string): Candidate[] {
  const paths = videoPaths(root, slug);
  const stills = readFrames(paths.out)
    .sort((left, right) => left.frame - right.frame)
    .map((still): Candidate => ({ kind: "still", path: join(paths.out, still.name) }));
  return [
    { kind: "video", path: paths.mp4 },
    ...stills,
    { kind: "narration", path: paths.audio },
    { kind: "captions", path: paths.captions },
    { kind: "timings", path: paths.timings },
  ];
}

/** The `frame-<n>.png` files in one directory, or nothing at all when there is no directory yet. */
function readFrames(directory: string): { name: string; frame: number }[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    // A video that has never been rendered has no `out/` directory, which is not an error: it is
    // the answer "no stills", and the caller wants a list rather than an exception.
    return [];
  }
  const frames: { name: string; frame: number }[] = [];
  for (const name of names) {
    const match = STILL_PATTERN.exec(name);
    if (match?.[1] !== undefined) {
      frames.push({ name, frame: Number.parseInt(match[1], 10) });
    }
  }
  return frames;
}

/** The local library: one workspace root, read at the moment it is asked. */
export function createWorkspaceLibrary(options: WorkspaceLibraryOptions): VideoLibrary {
  const { root } = options;

  function describe(candidate: Candidate, slug: string): ApiArtefact | null {
    // `throwIfNoEntry: false` rather than `existsSync` then `stat`: one syscall, and no window in
    // which a render finishes between the two and the size reported is of a file that no longer
    // has it.
    const stats = statSync(candidate.path, { throwIfNoEntry: false });
    if (stats === undefined || !stats.isFile()) {
      return null;
    }
    const name = basename(candidate.path);
    return {
      kind: candidate.kind,
      name,
      url: artefactPath(slug, name),
      content_type: contentTypeFor(name),
      bytes: stats.size,
      modified_at: stats.mtime.toISOString(),
    };
  }

  return {
    artefacts(slug: string): ApiArtefact[] {
      if (!isVideoSlug(slug)) {
        return [];
      }
      const found: ApiArtefact[] = [];
      for (const candidate of candidates(root, slug)) {
        const artefact = describe(candidate, slug);
        if (artefact !== null) {
          found.push(artefact);
        }
      }
      return found;
    },

    open(slug: string, name: string): ArtefactFile | null {
      if (!isVideoSlug(slug)) {
        return null;
      }
      for (const candidate of candidates(root, slug)) {
        if (basename(candidate.path) !== name) {
          continue;
        }
        const stats = statSync(candidate.path, { throwIfNoEntry: false });
        if (stats === undefined || !stats.isFile()) {
          return null;
        }
        return {
          path: candidate.path,
          bytes: stats.size,
          contentType: contentTypeFor(name),
          modifiedAt: stats.mtime,
        };
      }
      return null;
    },
  };
}

/** What the two library routes need. */
export type VideoRouteDependencies = {
  backend: RenderBackend;
  library: VideoLibrary;
};

/**
 * Mount `GET /videos` and `GET /videos/:slug` on a router already prefixed with `/api`.
 *
 * One video is served out of the same `explainer_list` call as the whole library rather than out of
 * a second, narrower question, so the two routes cannot report different facts about the same
 * video. A local library is tens of entries; the day it is not, this is where a `by(slug)` seam
 * goes.
 */
export function registerVideoRoutes(app: Hono, dependencies: VideoRouteDependencies): void {
  const { backend, library } = dependencies;

  async function list(): Promise<ApiVideo[]> {
    const listed = await backend.explainer_list({});
    return listed.videos.map(
      (video): ApiVideo => ({
        slug: video.slug,
        has_narration: video.has_narration,
        rendered: video.rendered,
        seconds: video.seconds ?? null,
        size_mb: video.size_mb ?? null,
        artefacts: library.artefacts(video.slug),
      }),
    );
  }

  app.get("/videos", async (c) => {
    try {
      return c.json({ videos: await list() });
    } catch (error) {
      return sendRefusal(c, refusalFor(error));
    }
  });

  app.get("/videos/:slug", async (c) => {
    const slug = c.req.param("slug");
    if (!isVideoSlug(slug)) {
      return sendRefusal(
        c,
        refusal(
          400,
          "INVALID_SLUG",
          `${JSON.stringify(slug)} is not a slug: lowercase letters, digits and hyphens, ` +
            "starting with a letter or a digit, at most 64 characters.",
        ),
      );
    }
    try {
      const video = (await list()).find((candidate) => candidate.slug === slug);
      if (video === undefined) {
        return sendRefusal(
          c,
          refusal(404, "NO_SUCH_VIDEO", `no video called ${JSON.stringify(slug)}.`),
        );
      }
      return c.json(video);
    } catch (error) {
      return sendRefusal(c, refusalFor(error));
    }
  });
}
