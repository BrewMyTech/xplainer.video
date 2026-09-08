/**
 * A real artefact server on loopback, with one route per way a download goes wrong.
 *
 * `setup`'s downloader is a network client, and the four failures ADR 0005 makes it responsible for
 * — a short body, a checksum mismatch, a resume the server did not honour, and a proxy answering
 * instead of the origin — are all *server* behaviours. A double in front of `fetch` would assert
 * that this package can pattern-match its own fixtures; a real `node:http` server that truncates a
 * body, mis-answers a `Range`, or serves a filter page instead of an archive puts the real client,
 * the real headers and the real socket in the test.
 *
 * Nothing here ships: `tsconfig.build.json` excludes `src/**\/testing/**`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One request the server saw, so a test can assert that a resume really asked for a range. */
export type RecordedRequest = {
  method: string;
  path: string;
  /** The `Range` header, verbatim, or `null` where the client sent none. */
  range: string | null;
};

/** The running fixture server. */
export type ArtefactServer = {
  /** `http://127.0.0.1:<port>`. */
  origin: string;
  /** The same authority over `https:`, which nothing here speaks — a hijacked-port stand-in. */
  tlsOrigin: string;
  /** Every request, in order. */
  requests: RecordedRequest[];
  url: (path: string) => string;
  close: () => Promise<void>;
};

/** The routes the server answers. Anything else is a `404`. */
export const ARTEFACT_ROUTES = {
  /** Serves the archive, honouring `Range` with a correct `206`. */
  good: "/good.zip",
  /** Truncates the first `GET`, then resumes correctly — a dropped download and its retry. */
  flaky: "/flaky.zip",
  /** Always ends the body early, cleanly, after declaring the full length on `HEAD`. */
  truncated: "/truncated.zip",
  /** Declares a `Content-Length` and destroys the socket half way through. */
  dropped: "/dropped.zip",
  /** Answers a `Range` with a `206` whose `Content-Range` starts somewhere else. */
  misresume: "/misresume.zip",
  /** Ignores `Range` and answers `200` with the whole artefact. */
  ignoresRange: "/ignores-range.zip",
  /** Serves the full length, with one byte changed. */
  corrupt: "/corrupt.zip",
  /**
   * A filter page on `GET`, behind an artefact-shaped `HEAD`.
   *
   * That is the shape of a proxy that inspects downloads rather than metadata, and it is the one
   * that lets the refusal quote the page: a `HEAD` has no body to quote.
   */
  blocked: "/blocked.zip",
  /** A filter page on `HEAD` as well, which is what a proxy inspecting every request does. */
  blockedHead: "/blocked-head.zip",
  /** `407 Proxy Authentication Required`. */
  proxyAuth: "/proxy-auth.zip",
  /** `404`. */
  missing: "/missing.zip",
  /** Refuses `HEAD` with `405`, and serves the artefact on `GET`. */
  noHead: "/no-head.zip",
  /** `307` to the good route, which is what the arm64 Chrome build's own CDN does. */
  redirect: "/redirect.zip",
  /** Redirects to itself, for ever. */
  loop: "/loop.zip",
  /** Answers `HEAD`, then starts a body and stops sending — what a hung proxy looks like. */
  stalls: "/stalls.zip",
} as const;

/** How long a dropped body's bytes are given to reach the client before the socket is reset. */
const DROP_DELAY_MS = 50;

const BLOCKED_PAGE =
  "<!DOCTYPE html><html><head><title>Access Denied</title></head><body>" +
  "<h1>Access Denied</h1><p>Your organisation has blocked this category: File Download.</p>" +
  "</body></html>";

/** Start the server. The archive is the body every successful route serves. */
export async function startArtefactServer(archive: Buffer): Promise<ArtefactServer> {
  const requests: RecordedRequest[] = [];
  let flakyServed = 0;
  const corrupted = Buffer.from(archive);
  const flip = Math.floor(corrupted.length / 2);
  corrupted.writeUInt8(corrupted.readUInt8(flip) ^ 0xff, flip);

  const server = createServer((request, response) => {
    const path = (request.url ?? "").split("?")[0] ?? "";
    requests.push({
      method: request.method ?? "",
      path,
      range: request.headers.range ?? null,
    });
    route({ request, response, path, archive, corrupted, flakyServed });
    if (path === ARTEFACT_ROUTES.flaky && request.method === "GET") {
      flakyServed += 1;
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    tlsOrigin: `https://127.0.0.1:${port}`,
    requests,
    url: (path: string) => `${origin}${path}`,
    close: () => closeServer(server),
  };
}

type RouteContext = {
  request: IncomingMessage;
  response: ServerResponse;
  path: string;
  archive: Buffer;
  corrupted: Buffer;
  flakyServed: number;
};

function route(context: RouteContext): void {
  const { request, response, path, archive, corrupted } = context;
  const isHead = request.method === "HEAD";
  switch (path) {
    case ARTEFACT_ROUTES.good:
      serveRangeable(request, response, archive);
      return;
    case ARTEFACT_ROUTES.flaky:
      if (isHead) {
        head(response, archive.length, true);
        return;
      }
      if (context.flakyServed === 0) {
        endEarly(response, archive);
        return;
      }
      serveRangeable(request, response, archive);
      return;
    case ARTEFACT_ROUTES.truncated:
      if (isHead) {
        head(response, archive.length, true);
        return;
      }
      endEarly(response, archive);
      return;
    case ARTEFACT_ROUTES.dropped:
      if (isHead) {
        head(response, archive.length, true);
        return;
      }
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-length": String(archive.length),
      });
      // The destroy waits for the write to reach the socket, so the client sees a real response
      // and a body that stops — rather than a connection that failed before the status line.
      //
      // And it waits a further {@link DROP_DELAY_MS} after that. "Flushed to the socket" is not
      // "delivered to the client's parser": under load — a whole `pnpm verify`, measured
      // 2026-09-08 — the reset can overtake the bytes already in flight, and the client then sees a
      // dropped connection with **nothing written**, which fails an assertion about the partial
      // being kept for a reason that has nothing to do with the code under test. The delay is not a
      // weakening: this route's subject is a body that *starts* and then stops, and a body that
      // never arrived is a different condition with its own route (`missing`).
      response.write(archive.subarray(0, Math.floor(archive.length / 2)), () => {
        setTimeout(() => {
          response.socket?.destroy();
        }, DROP_DELAY_MS);
      });
      return;
    case ARTEFACT_ROUTES.misresume:
      if (isHead) {
        head(response, archive.length, true);
        return;
      }
      if (request.headers.range === undefined) {
        endEarly(response, archive);
        return;
      }
      // A `206` that claims the whole artefact rather than the range that was asked for. Appending
      // this body to a partial file is what produces a right-length, wrong-content download.
      response.writeHead(206, {
        "content-type": "application/zip",
        "content-length": String(archive.length),
        "content-range": `bytes 0-${archive.length - 1}/${archive.length}`,
      });
      response.end(archive);
      return;
    case ARTEFACT_ROUTES.ignoresRange:
      if (isHead) {
        head(response, archive.length, true);
        return;
      }
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-length": String(archive.length),
      });
      response.end(archive);
      return;
    case ARTEFACT_ROUTES.corrupt:
      if (isHead) {
        head(response, corrupted.length, false);
        return;
      }
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-length": String(corrupted.length),
      });
      response.end(corrupted);
      return;
    case ARTEFACT_ROUTES.blocked:
      if (isHead) {
        head(response, archive.length, true);
        return;
      }
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(Buffer.byteLength(BLOCKED_PAGE)),
        via: "1.1 proxy.example.internal",
      });
      response.end(BLOCKED_PAGE);
      return;
    case ARTEFACT_ROUTES.blockedHead:
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(Buffer.byteLength(BLOCKED_PAGE)),
        via: "1.1 proxy.example.internal",
      });
      response.end(isHead ? undefined : BLOCKED_PAGE);
      return;
    case ARTEFACT_ROUTES.proxyAuth:
      response.writeHead(407, {
        "proxy-authenticate": 'Basic realm="proxy.example.internal"',
        "content-length": "0",
      });
      response.end();
      return;
    case ARTEFACT_ROUTES.noHead:
      if (isHead) {
        response.writeHead(405, { allow: "GET", "content-length": "0" });
        response.end();
        return;
      }
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-length": String(archive.length),
      });
      response.end(archive);
      return;
    case ARTEFACT_ROUTES.redirect:
      response.writeHead(307, { location: ARTEFACT_ROUTES.good, "content-length": "0" });
      response.end();
      return;
    case ARTEFACT_ROUTES.loop:
      response.writeHead(302, { location: ARTEFACT_ROUTES.loop, "content-length": "0" });
      response.end();
      return;
    case ARTEFACT_ROUTES.stalls:
      if (isHead) {
        head(response, archive.length, true);
        return;
      }
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-length": String(archive.length),
      });
      response.write(archive.subarray(0, 16));
      // No end, no further writes: the socket stays open and silent until the client gives up.
      return;
    default:
      response.writeHead(404, { "content-length": "0" });
      response.end();
      return;
  }
}

function head(response: ServerResponse, length: number, ranges: boolean): void {
  response.writeHead(200, {
    "content-type": "application/zip",
    "content-length": String(length),
    ...(ranges ? { "accept-ranges": "bytes" } : {}),
  });
  response.end();
}

/** A clean end of body before the declared length — the ordinary truncated download. */
function endEarly(response: ServerResponse, archive: Buffer): void {
  // No `Content-Length`: the response is chunked, ends cleanly, and carries half the artefact.
  // That is a truncation the client can only notice by counting, which is the point.
  response.writeHead(200, { "content-type": "application/zip" });
  response.end(archive.subarray(0, Math.floor(archive.length / 2)));
}

/** `Range` done correctly: a `206` for the requested suffix, or the whole body. */
function serveRangeable(request: IncomingMessage, response: ServerResponse, archive: Buffer): void {
  const isHead = request.method === "HEAD";
  if (isHead) {
    head(response, archive.length, true);
    return;
  }
  const range = request.headers.range;
  const match = range === undefined ? null : /^bytes=(\d+)-(\d*)$/.exec(range);
  if (match === null) {
    response.writeHead(200, {
      "content-type": "application/zip",
      "content-length": String(archive.length),
      "accept-ranges": "bytes",
    });
    response.end(archive);
    return;
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? archive.length - 1 : Number(match[2]);
  if (start >= archive.length) {
    response.writeHead(416, {
      "content-range": `bytes */${archive.length}`,
      "content-length": "0",
    });
    response.end();
    return;
  }
  const body = archive.subarray(start, end + 1);
  response.writeHead(206, {
    "content-type": "application/zip",
    "content-length": String(body.length),
    "content-range": `bytes ${start}-${end}/${archive.length}`,
    "accept-ranges": "bytes",
  });
  response.end(body);
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
