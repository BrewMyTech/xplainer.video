/**
 * The bytes themselves: one artefact, streamed, with `Range` — which is what makes the player work.
 *
 * A `<video>` element does not download a file and then play it. It asks for a few hundred
 * kilobytes, reads the container's index, and then asks for byte ranges as the user scrubs; a
 * server that answers every request with the whole file and no `Accept-Ranges` gives a player that
 * can start at the beginning and nothing else. So this route implements RFC 9110 §14 for the one
 * shape a player sends — a single byte range — and says so in the headers.
 *
 * **What is deliberately not here.** No conditional requests: there is no `ETag` and no
 * `If-Range`, because an artefact is *overwritten in place* by the next render of the same video
 * and a validator we do not check would be worse than none. `Cache-Control: no-store` is the
 * consequence — the desktop asks again after a render finishes and gets the new film rather than
 * the one its cache remembers.
 *
 * **No CORS header, on this route least of all** (R-SEC-7). It is the one route that serves bytes a
 * page would want to read cross-origin, which is exactly why the answer is no: the guard in front
 * of these routes is a `Host` allowlist, an `Origin` check and a bearer token, and a permissive
 * `Access-Control-Allow-Origin` would hand a browser on any site the ability to read this machine's
 * renders back out of a daemon that authenticated the request.
 */

import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { Hono } from "hono";
import { apiError, refusal, sendRefusal } from "./errors.js";
import { type ArtefactFile, isVideoSlug, type VideoLibrary } from "./videos.js";

/** A single byte range, as RFC 9110 §14.1.1 spells one, resolved against the file's real size. */
export type ResolvedRange = {
  /** First byte served, inclusive. */
  start: number;
  /** Last byte served, inclusive. */
  end: number;
};

/**
 * What a `Range` header asks for: a range, "nothing this file can satisfy", or no opinion.
 *
 * `null` covers both "no header" and "a header this server does not understand" — a multi-range
 * ask, a unit that is not `bytes`, a syntactically broken value. RFC 9110 §14.2 lets a server
 * ignore a `Range` it cannot process and answer the whole representation, and that is the answer
 * here: a player that asked for something exotic gets a playable `200` rather than a `416`.
 */
export type RangeRequest = ResolvedRange | "unsatisfiable" | null;

/** `bytes=<first>-<last>`, `bytes=<first>-`, or `bytes=-<suffix length>`, and nothing else. */
const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * Resolve one `Range` header against a size.
 *
 * A zero-length artefact can satisfy no range at all: every first-byte position is past the end and
 * a suffix of a file with no bytes is empty, so any `Range` against it is `416` (§14.1.2's
 * "unsatisfiable" is defined in terms of the current length, and that length is 0).
 */
export function parseRange(header: string | undefined, size: number): RangeRequest {
  if (header === undefined) {
    return null;
  }
  const match = SINGLE_RANGE.exec(header.trim());
  const first = match?.[1];
  const last = match?.[2];
  if (first === undefined || last === undefined || (first === "" && last === "")) {
    return null;
  }
  if (size === 0) {
    return "unsatisfiable";
  }

  if (first === "") {
    // `bytes=-N`: the last N bytes, clamped to the whole file. `N = 0` asks for nothing, which is
    // the one suffix form §14.1.2 calls unsatisfiable.
    const suffix = Number.parseInt(last, 10);
    if (suffix === 0) {
      return "unsatisfiable";
    }
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number.parseInt(first, 10);
  if (start >= size) {
    return "unsatisfiable";
  }
  const end = last === "" ? size - 1 : Math.min(Number.parseInt(last, 10), size - 1);
  if (end < start) {
    return "unsatisfiable";
  }
  return { start, end };
}

/** What {@link artefactResponse} needs from the request it is answering. */
export type ArtefactRequest = {
  /** The `Range` header, verbatim, or nothing. */
  range?: string | undefined;
  /** `GET` or `HEAD`. A `HEAD` gets every header and no body. */
  method: string;
};

/**
 * One artefact, as a response: `200`, `206` or `416`, always with `Accept-Ranges`.
 *
 * The body is the file read lazily rather than a buffer, so a 200 MB render costs one file
 * descriptor here instead of 200 MB of this daemon's heap — and when the player seeks and drops the
 * connection, cancelling the response's stream destroys the read stream with it.
 */
export function artefactResponse(file: ArtefactFile, request: ArtefactRequest): Response {
  const headers = new Headers({
    "content-type": file.contentType,
    "accept-ranges": "bytes",
    "last-modified": file.modifiedAt.toUTCString(),
    "cache-control": "no-store",
  });

  const range = parseRange(request.range, file.bytes);
  if (range === "unsatisfiable") {
    headers.set("content-range", `bytes */${file.bytes}`);
    headers.set("content-type", "application/json");
    const refused = JSON.stringify(
      apiError(
        "RANGE_NOT_SATISFIABLE",
        `the requested range is outside ${file.bytes} byte${file.bytes === 1 ? "" : "s"}.`,
      ),
    );
    // A `HEAD` never carries a body, refusal or not (RFC 9110 §9.3.2), so the explanation is the
    // status line and `Content-Range` alone.
    return request.method === "HEAD"
      ? new Response(null, { status: 416, headers })
      : new Response(refused, { status: 416, headers });
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? file.bytes - 1;
  const length = file.bytes === 0 ? 0 : end - start + 1;
  headers.set("content-length", String(length));
  if (range !== null) {
    headers.set("content-range", `bytes ${start}-${end}/${file.bytes}`);
  }
  const status = range === null ? 200 : 206;

  if (request.method === "HEAD" || length === 0) {
    return new Response(null, { status, headers });
  }
  const body = Readable.toWeb(
    createReadStream(file.path, { start, end }),
  ) as ReadableStream<Uint8Array>;
  return new Response(body, { status, headers });
}

/** What the media route needs. */
export type MediaRouteDependencies = {
  library: VideoLibrary;
};

/**
 * Mount `GET`/`HEAD /videos/:slug/artefacts/:name` on a router already prefixed with `/api`.
 *
 * `HEAD` is registered beside `GET` because that is how a player asks how long a file is before it
 * decides how to fetch it, and a `405` there is a video that never starts.
 */
export function registerMediaRoutes(app: Hono, dependencies: MediaRouteDependencies): void {
  app.on(["GET", "HEAD"], "/videos/:slug/artefacts/:name", (c) => {
    const slug = c.req.param("slug");
    const name = c.req.param("name");
    // One answer for "not a slug", "no such video" and "no such file": there is nothing to fetch,
    // and a caller probing names learns the same from all three.
    if (!isVideoSlug(slug)) {
      return sendRefusal(
        c,
        refusal(404, "NO_SUCH_ARTEFACT", `no artefact ${JSON.stringify(name)}.`),
      );
    }
    const file = dependencies.library.open(slug, name);
    if (file === null) {
      return sendRefusal(
        c,
        refusal(
          404,
          "NO_SUCH_ARTEFACT",
          `${JSON.stringify(slug)} has no artefact called ${JSON.stringify(name)}.`,
        ),
      );
    }
    return artefactResponse(file, { range: c.req.header("range"), method: c.req.method });
  });
}
