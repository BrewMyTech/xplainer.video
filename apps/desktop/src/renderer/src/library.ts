/**
 * The library document, as a window can use it.
 *
 * `GET /api/videos` answers over IPC as `unknown`, and being named JSON says nothing about its
 * shape — so every field is checked rather than cast, the rule this app already applies to a
 * payload manifest. A daemon that answered something else produces an empty library and a sentence,
 * never a screen half-rendered around a missing field.
 *
 * **No URL is built here.** Each artefact carries the route that serves its bytes, exactly as the
 * daemon answered it, and the player hands that path to `mediaUrl()` untouched. A route the daemon
 * moves therefore cannot leave a stale copy in a component.
 *
 * Pure, and separate from the components for the reason every decision in this app is separate from
 * its Electron call: this is where "what the library says" is decided, and it is asserted against a
 * document a real daemon actually produced.
 */

/** One file a video has produced, and the daemon route that serves it. */
export type LibraryArtefact = {
  /** `video`, `still`, `narration`, `captions` or `timings` — the daemon's own closed set. */
  kind: string;
  /** The file's own name, which is also the last segment of {@link LibraryArtefact.url}. */
  name: string;
  /** The daemon path that serves the bytes. Carried whole; never composed here. */
  url: string;
  /** What the route sends as `Content-Type`. */
  contentType: string;
  bytes: number;
  /** Last modification, as the ISO-8601 string the daemon sent. */
  modifiedAt: string;
};

/** One video, as a window shows it. */
export type LibraryVideo = {
  slug: string;
  hasNarration: boolean;
  rendered: boolean;
  /** Narration length in seconds, or `null` when it has never been narrated. */
  seconds: number | null;
  /** MP4 size in megabytes, or `null` when nothing has been rendered. */
  sizeMb: number | null;
  artefacts: LibraryArtefact[];
};

/** The artefact kind a player can play. */
const FILM_KIND = "video";

/** The artefact kind a layout check leaves behind. */
const STILL_KIND = "still";

/** Read `{ videos: [...] }` into rows, dropping anything that is not one. */
export function readLibrary(body: unknown): LibraryVideo[] {
  const listed = record(body)?.videos;
  if (!Array.isArray(listed)) {
    return [];
  }
  const videos: LibraryVideo[] = [];
  for (const entry of listed) {
    const video = readVideo(entry);
    if (video !== null) {
      videos.push(video);
    }
  }
  return videos;
}

/** One entry of that list, or `null` when it is not a video document at all. */
export function readVideo(value: unknown): LibraryVideo | null {
  const fields = record(value);
  if (fields === undefined || typeof fields.slug !== "string" || fields.slug === "") {
    return null;
  }
  const artefacts: LibraryArtefact[] = [];
  if (Array.isArray(fields.artefacts)) {
    for (const entry of fields.artefacts) {
      const artefact = readArtefact(entry);
      if (artefact !== null) {
        artefacts.push(artefact);
      }
    }
  }
  return {
    slug: fields.slug,
    hasNarration: fields.has_narration === true,
    rendered: fields.rendered === true,
    seconds: number(fields.seconds),
    sizeMb: number(fields.size_mb),
    artefacts,
  };
}

/** One artefact of a video, or `null` when the entry carries no route to fetch. */
export function readArtefact(value: unknown): LibraryArtefact | null {
  const fields = record(value);
  if (fields === undefined) {
    return null;
  }
  const { kind, name, url, content_type: contentType } = fields;
  if (typeof kind !== "string" || typeof name !== "string" || typeof url !== "string") {
    return null;
  }
  return {
    kind,
    name,
    url,
    contentType: typeof contentType === "string" ? contentType : "application/octet-stream",
    bytes: number(fields.bytes) ?? 0,
    modifiedAt: typeof fields.modified_at === "string" ? fields.modified_at : "",
  };
}

/** The finished film, or `null` for a video that has never been rendered. */
export function filmOf(video: LibraryVideo): LibraryArtefact | null {
  return video.artefacts.find((artefact) => artefact.kind === FILM_KIND) ?? null;
}

/** Every still this video has, in the order the daemon listed them — which is by frame number. */
export function stillsOf(video: LibraryVideo): LibraryArtefact[] {
  return video.artefacts.filter((artefact) => artefact.kind === STILL_KIND);
}

/** One line under a video's name: what it has, in the units the daemon reported them in. */
export function describeVideo(video: LibraryVideo): string {
  const parts: string[] = [];
  parts.push(video.hasNarration ? "narrated" : "no narration");
  if (video.seconds !== null) {
    parts.push(`${video.seconds.toFixed(1)} s`);
  }
  parts.push(video.rendered ? "rendered" : "not rendered");
  if (video.sizeMb !== null) {
    parts.push(`${video.sizeMb.toFixed(1)} MB`);
  }
  const stills = stillsOf(video).length;
  if (stills > 0) {
    parts.push(`${stills} still${stills === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

/** A plain object, or `undefined` for anything else — an array and `null` included. */
function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/** A finite number, or `null`. A field the daemon omits and one it sends as `null` are the same. */
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
