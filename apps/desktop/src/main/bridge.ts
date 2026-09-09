/**
 * The authenticated bridge: the main process holds the token, and the renderer never sees it.
 *
 * ADR 0020 §Security makes the daemon's TCP listener bearer-authenticated and R-SEC-6 keeps the
 * secret in a file whose *path* is the only thing anything else records. This module is the one
 * place in the app that reads that file and the one place that attaches an `Authorization` header.
 * Everything the window shows — the library, a job, its progress stream, the bytes of an MP4 —
 * comes through here.
 *
 * **Why the renderer is not simply given a token.** A renderer is a browser: it runs remote-ish
 * content, it has a devtools console, and anything it holds can be read by anything that gets a
 * script into it. It also has an *origin*, and a token in a page is a token that must be reachable
 * from that origin — which would mean CORS on the daemon, and R-SEC-7 forbids CORS middleware for
 * any value, ever, because a permitted origin is a page on the internet that can drive this
 * machine's daemon with the browser's own credentials attached. Proxying in the main process is
 * what makes that rule keepable: there is no browser origin talking to the daemon at all.
 *
 * **Token rotation propagates without a restart.** The token is read from disk and cached, and a
 * `401` is treated as "the file may have changed under us": the bridge re-reads it, and if the
 * value is different it retries the request exactly once. That is the whole of the propagation
 * requirement — `xplainer token rotate` writes a new file and the daemon reloads it, and the app's
 * next request repairs itself instead of showing a user an authentication error they cannot act on.
 * One retry and no more: a `401` against a token this app has just re-read is
 * `unauthorized`, which is discovery's answer and not something to loop on.
 *
 * **The transport is `node:http`, unpooled, and that is a measured decision rather than a taste.**
 * Node's bundled `undici` calls `socket.setTypeOfService()` when it resumes a **pooled** socket, and
 * `node:net` throws a failed `setsockopt` from inside the socket's own event handler — so a daemon
 * that closed a connection between two requests produces an `EINVAL` that no `try`/`catch` around
 * the `fetch` can see. The CLI hit exactly that and moved its pollers off `fetch` for it. Every
 * request here therefore gets its own connection (`agent: false`), which also gives the streaming
 * responses the player and the event stream need, and `https` with a caller-supplied trust store
 * for the remote daemon T25 exposes.
 *
 * **No route is built here.** `/api/videos` is the one path this app has to know, and everything
 * else is followed from what the daemon answered — an artefact's `url`, a queued job's `events` —
 * so a route the daemon moves cannot leave a stale copy behind in a renderer.
 */

import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Readable } from "node:stream";
import { API_PREFIX } from "../shared/daemon-api";

/** How long a proxied request may take before it is abandoned. Media and streams are exempt. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** How a TLS daemon is trusted. T25 fills these in; a loopback daemon needs none of them. */
export type CertificateTrust = {
  /** A PEM certificate authority this app trusts for the daemon, beyond the system store. */
  ca?: string | undefined;
  /** Whether the certificate must verify. Never `false` without a user's explicit decision. */
  rejectUnauthorized?: boolean | undefined;
  /** The name to check the certificate against, when the URL is an address. */
  servername?: string | undefined;
};

/** The daemon this bridge talks to. */
export type BridgeTarget = {
  /** The origin, as `resolveDaemonUrl()` produced it. No trailing slash. */
  url: string;
  /** The file holding the bearer token — a path, and the only form a token is ever passed in. */
  tokenFile: string | null;
  /** Credentials and trust for a daemon that is not on this machine. */
  trust?: CertificateTrust | undefined;
};

/** One request the bridge makes on the renderer's behalf. */
export type BridgeRequest = {
  /** A path under {@link API_PREFIX}, or `/healthz`. Anything else is refused before it is sent. */
  path: string;
  method?: string | undefined;
  /** Headers forwarded outward. `authorization` is added here and may not be supplied. */
  headers?: Readonly<Record<string, string>> | undefined;
  /** A serialised JSON body, for `POST`. */
  body?: string | undefined;
  /** Overrides {@link REQUEST_TIMEOUT_MS}; `0` means no timeout, for a stream. */
  timeoutMs?: number | undefined;
};

/** What one proxied request answered, with the body still a stream. */
export type BridgeResponse = {
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: Readable;
};

/** A document answer: the body read to the end and parsed. */
export type BridgeDocument = {
  status: number;
  /** The parsed JSON body, or `null` when the response carried none. */
  body: unknown;
};

/** Why a request was not made, or not answered. Named, like every other refusal in this app. */
export type BridgeRefusalReason =
  /** The path is not one this bridge is allowed to ask for. */
  | "path-refused"
  /** The daemon could not be reached, or the connection failed mid-answer. */
  | "unreachable"
  /** The answer was not the document it claimed to be. */
  | "unreadable";

/** A request this bridge would not make, or could not finish. */
export class BridgeRefusal extends Error {
  readonly reason: BridgeRefusalReason;

  constructor(reason: BridgeRefusalReason, message: string) {
    super(message);
    this.name = "BridgeRefusal";
    this.reason = reason;
  }
}

/** One event off a job's stream. */
export type JobStreamEvent = {
  /** `job` for a progress event and `end` for the last one — the daemon's own event names. */
  name: string;
  /** The event's `data`, parsed. */
  data: unknown;
};

/** Headers a media request is allowed to send. A player needs the first two and nothing else. */
const FORWARDED_REQUEST_HEADERS = ["range", "if-range", "accept"] as const;

/** Headers a media response carries back. Enough for a player, and nothing about the connection. */
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "last-modified",
  "etag",
  "cache-control",
] as const;

/**
 * The authenticated connection to one daemon.
 *
 * Constructed from what `discovery.ts` answered: the origin it resolved and the token file the
 * daemon recorded. {@link DaemonBridge.retarget} replaces both when discovery runs again — a daemon that
 * restarted on another port, or a switch to a remote one — so the window keeps one bridge for its
 * whole life and the token never travels through anything else.
 */
export class DaemonBridge {
  #target: BridgeTarget;
  #token: string | null = null;
  #read = false;

  constructor(target: BridgeTarget) {
    this.#target = target;
  }

  /** The origin this bridge talks to. */
  get url(): string {
    return this.#target.url;
  }

  /** The token *file*. The value itself is not exposed by this class, by construction. */
  get tokenFile(): string | null {
    return this.#target.tokenFile;
  }

  /** Point this bridge at another daemon, or at the same one after a rotation. */
  retarget(target: BridgeTarget): void {
    this.#target = target;
    this.#token = null;
    this.#read = false;
  }

  /**
   * Make one authenticated request and answer with the response still streaming.
   *
   * A `401` is retried exactly once, and only when re-reading the token file produced a *different*
   * value — which is what makes a rotation invisible to the window and a genuine `401` a single
   * answer rather than a loop.
   */
  async open(request: BridgeRequest): Promise<BridgeResponse> {
    // Resolved once, here, and carried into both sends: the URL that is checked has to be the URL
    // that is dialled, or the check is about a different string than the request.
    const target = resolveAllowedUrl(request.path, this.#target.url);
    const first = await this.#send(request, this.#authorise(), target);
    if (first.status !== 401) {
      return first;
    }
    const before = this.#token;
    const after = this.#refreshToken();
    if (after === null || after === before) {
      return first;
    }
    // The old answer is dropped rather than left dangling: an unread response body keeps its
    // socket alive until the daemon times it out.
    first.body.destroy();
    return this.#send(request, after, target);
  }

  /** One request, read to the end and parsed as JSON. The shape every `/api/*` route answers in. */
  async json(request: BridgeRequest): Promise<BridgeDocument> {
    const response = await this.open(request);
    const text = await readAll(response.body);
    if (text.trim() === "") {
      return { status: response.status, body: null };
    }
    try {
      return { status: response.status, body: JSON.parse(text) as unknown };
    } catch (error) {
      throw new BridgeRefusal(
        "unreadable",
        `${request.path} answered ${String(response.status)} with something that is not JSON: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * `/healthz`, authenticated — the daemon's own account of itself, including a degraded `reason`.
   *
   * Discovery's outcome comes from the CLI's report; this is how a window shows the sentence behind
   * it without shelling out again.
   */
  health(): Promise<BridgeDocument> {
    return this.json({ path: "/healthz" });
  }

  /**
   * One artefact's bytes, with the player's `Range` forwarded and the answer's `Range` kept.
   *
   * The path is the `url` the library gave for that artefact, never one rebuilt here.
   */
  async media(
    path: string,
    headers: Readonly<Record<string, string | undefined>> = {},
  ): Promise<BridgeResponse> {
    const forwarded: Record<string, string> = {};
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = headers[name] ?? headers[name.toUpperCase()];
      if (value !== undefined) {
        forwarded[name] = value;
      }
    }
    const response = await this.open({ path, headers: forwarded, timeoutMs: 0 });
    const kept: Record<string, string | undefined> = {};
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers[name];
      if (value !== undefined) {
        kept[name] = value;
      }
    }
    return { status: response.status, headers: kept, body: response.body };
  }

  /**
   * Follow one job's progress until the daemon says it is over.
   *
   * The stream is `text/event-stream`, and the frames are parsed here rather than in the renderer
   * for the same reason the token is held here: the renderer's only view of the daemon is a value
   * this process handed it. The promise resolves when the daemon ends the stream, when the abort
   * signal fires, or when the connection dies — a caller that wants to keep watching re-subscribes,
   * which is what the `retry` field on the daemon's own events is for.
   */
  async subscribe(
    path: string,
    listener: (event: JobStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.open({
      path,
      headers: { accept: "text/event-stream" },
      timeoutMs: 0,
    });
    if (response.status !== 200) {
      const text = await readAll(response.body);
      throw new BridgeRefusal(
        "unreadable",
        `${path} answered ${String(response.status)} rather than opening a stream: ${text.trim()}`,
      );
    }
    await new Promise<void>((resolve, reject) => {
      let buffer = "";
      const onAbort = (): void => {
        response.body.destroy();
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      response.body.setEncoding("utf8");
      response.body.on("data", (chunk: string) => {
        buffer += chunk;
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = parseEventFrame(frame);
          if (event !== null) {
            listener(event);
          }
          boundary = buffer.indexOf("\n\n");
        }
      });
      response.body.on("end", () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });
      response.body.on("error", (error: Error) => {
        signal?.removeEventListener("abort", onAbort);
        reject(new BridgeRefusal("unreachable", `${path} stopped streaming: ${error.message}`));
      });
    });
  }

  /** The token, read once and kept. Private: nothing outside this class is given the value. */
  #authorise(): string | null {
    if (!this.#read) {
      this.#refreshToken();
    }
    return this.#token;
  }

  /** Re-read the token file, and answer with what it holds now. */
  #refreshToken(): string | null {
    this.#read = true;
    const file = this.#target.tokenFile;
    if (file === null) {
      this.#token = null;
      return null;
    }
    try {
      const value = readFileSync(file, "utf8").trim();
      this.#token = value === "" ? null : value;
    } catch {
      // A token file that is not there yet is a fact the daemon's `401` will state; it is not this
      // module's business to decide whether that means "not installed" or "not readable".
      this.#token = null;
    }
    return this.#token;
  }

  /** One request, with the token attached if there is one, at the URL {@link open} resolved. */
  #send(request: BridgeRequest, token: string | null, target: URL): Promise<BridgeResponse> {
    const secure = target.protocol === "https:";
    const trust = this.#target.trust ?? {};
    const headers: Record<string, string> = { ...(request.headers ?? {}) };
    if (token !== null) {
      headers.authorization = `Bearer ${token}`;
    }
    if (request.body !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(request.body));
    }

    return new Promise<BridgeResponse>((resolve, reject) => {
      const send = secure ? httpsRequest : httpRequest;
      const client = send(
        target,
        {
          method: request.method ?? "GET",
          headers,
          // Every request gets its own connection: see this module's header for the pooled-socket
          // failure this avoids.
          agent: false,
          ...(secure
            ? {
                ...(trust.ca === undefined ? {} : { ca: trust.ca }),
                ...(trust.rejectUnauthorized === undefined
                  ? {}
                  : { rejectUnauthorized: trust.rejectUnauthorized }),
                ...(trust.servername === undefined ? {} : { servername: trust.servername }),
              }
            : {}),
        },
        (message) => {
          resolve({
            status: message.statusCode ?? 0,
            headers: flattenHeaders(message.headers),
            body: message,
          });
        },
      );
      const timeout = request.timeoutMs ?? REQUEST_TIMEOUT_MS;
      if (timeout > 0) {
        client.setTimeout(timeout, () => {
          client.destroy(
            new BridgeRefusal(
              "unreachable",
              `${request.path} did not answer within ${String(timeout)} ms.`,
            ),
          );
        });
      }
      client.on("error", (error: Error) => {
        reject(
          error instanceof BridgeRefusal
            ? error
            : new BridgeRefusal(
                "unreachable",
                `${this.#target.url}${request.path} could not be reached: ${error.message}`,
              ),
        );
      });
      if (request.body !== undefined) {
        client.write(request.body);
      }
      client.end();
    });
  }
}

/**
 * Resolve one request against this daemon, and refuse anything that is not its client surface.
 *
 * The renderer names the path, so this is where "the renderer may ask for anything" stops. `/mcp`
 * is not on the list deliberately: the tool endpoint is an agent's, and a window that could reach
 * it could run every tool with the daemon's own authority.
 *
 * **The check is on the resolved URL, never on the string that arrived.** A prefix test over the
 * raw path answers about a different request than the one that is sent: `new URL()` collapses
 * `..`, `.` and their percent-encoded spellings (`%2e%2e` is a double-dot segment by the URL
 * standard), so `/api/../mcp`, `/api/videos/../../mcp`, `/api/%2e%2e/mcp` and `/api/./../mcp` all
 * pass a `startsWith("/api/")` and then dial `/mcp` — with this process's bearer token attached.
 * Normalising first is what `mediaPath()` in `src/shared/daemon-api.ts` already does for the media
 * scheme, and it is the same rule: parse, then judge what the parse produced.
 *
 * The origin is judged too, because a path is not the only thing `new URL()` accepts: an absolute
 * `http://elsewhere/api/x`, or a protocol-relative `//elsewhere/api/x`, resolves to another host
 * entirely, and this bridge sends its token to one daemon and no other.
 */
function resolveAllowedUrl(path: string, base: string): URL {
  const daemon = new URL(base);
  let target: URL;
  try {
    target = new URL(path, daemon);
  } catch {
    throw new BridgeRefusal(
      "path-refused",
      `${JSON.stringify(path)} is not a path this bridge can resolve against ${daemon.origin}.`,
    );
  }
  if (target.protocol !== daemon.protocol || target.host !== daemon.host) {
    throw new BridgeRefusal(
      "path-refused",
      `${JSON.stringify(path)} resolves to ${target.origin}, which is not the daemon this bridge ` +
        `talks to (${daemon.origin}); the token goes to one daemon and no other.`,
    );
  }
  if (target.pathname === "/healthz" || target.pathname.startsWith(`${API_PREFIX}/`)) {
    return target;
  }
  throw new BridgeRefusal(
    "path-refused",
    `${JSON.stringify(path)} asks for ${target.pathname}, which is not part of this daemon's ` +
      `client surface; the bridge sends ${API_PREFIX}/… and /healthz and nothing else.`,
  );
}

/** One SSE frame — `event:` and `data:` lines — as an event, or `null` for a comment. */
function parseEventFrame(frame: string): JobStreamEvent | null {
  let name = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":") || line.trim() === "") {
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") {
      name = value;
    } else if (field === "data") {
      data.push(value);
    }
  }
  if (data.length === 0) {
    return null;
  }
  const text = data.join("\n");
  try {
    return { name, data: JSON.parse(text) as unknown };
  } catch {
    return { name, data: text };
  }
}

/** Read a stream to the end as UTF-8. */
async function readAll(body: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** `IncomingMessage.headers`, with the repeated ones joined the way a proxy would send them on. */
function flattenHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string | undefined> {
  const flat: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    flat[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return flat;
}
