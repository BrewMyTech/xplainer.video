/**
 * `fetch` over a unix socket, because the platform's own does not offer one.
 *
 * `xplainer mcp --attach` has to speak HTTP to the daemon's IPC listener, and the two clients that
 * want to — the `/healthz` probe and the SDK's `StreamableHTTPClientTransport`, which accepts a
 * `fetch` implementation — both express themselves as `fetch`. Node's global `fetch` has no
 * supported way to name a socket path: the option that would do it lives on undici's dispatcher,
 * which is bundled but not exported from any `node:` module. `node:http` has taken a `socketPath`
 * since forever, so this file is that one request, wrapped in the `Request`/`Response` shapes the
 * callers above expect.
 *
 * It deliberately implements only what those two callers use — a string body, ordinary headers, an
 * `AbortSignal` — and refuses anything else by name rather than silently dropping it. A partial
 * `fetch` that pretends to be a whole one is how a request ends up on the wire missing its body.
 *
 * There is no authentication here and that is the point (ADR 0020 §The agent path is IPC, not TCP):
 * the daemon's socket lives inside a `0700` directory, so being able to `connect(2)` to it *is* the
 * credential.
 */

import { request as httpRequest } from "node:http";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * Statuses that RFC 9110 and the `Response` constructor agree carry no body.
 *
 * Passing even an empty string for one of these throws a `TypeError`, so the body is dropped for
 * exactly these and kept for everything else — including `202`, which the MCP endpoint answers a
 * notification with and which *may* have one.
 */
const NULL_BODY_STATUS: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);

/** What {@link createSocketFetch} dials. */
export type SocketFetchOptions = {
  /** The unix socket path, or the Windows named pipe name. */
  socketPath: string;
  /**
   * The `Host` header every request carries.
   *
   * A socket has no authority of its own, and `@hono/node-server` builds the request URL from this
   * header — so it is sent explicitly rather than left to Node's default, which is `localhost` and
   * would read as a loopback TCP request in a log.
   */
  host?: string;
};

/** Body shapes this client can put on the wire. Anything else is a caller's mistake, said aloud. */
function bodyOf(body: BodyInit | null | undefined, url: URL): string | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (typeof body === "string") {
    return body;
  }
  throw new TypeError(
    `xplainer: the IPC fetch can only send a string body, and ${url.pathname} was given a ` +
      `${body.constructor.name}. Serialise it before calling.`,
  );
}

/** `HeadersInit` in any of its three shapes, flattened to what `node:http` wants. */
function headersOf(headers: HeadersInit | undefined, host: string): Record<string, string> {
  const flattened: Record<string, string> = { host };
  if (headers !== undefined) {
    new Headers(headers).forEach((value, key) => {
      flattened[key] = value;
    });
  }
  return flattened;
}

/**
 * Build a `fetch` that ignores the URL's authority and dials `socketPath` instead.
 *
 * The path and query are taken from the URL, so a caller writes `http://xplainer.ipc/mcp` and gets
 * `/mcp` on the socket. The authority is a label, not a destination.
 */
export function createSocketFetch(options: SocketFetchOptions): FetchLike {
  const host = options.host ?? "xplainer.ipc";

  return function socketFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
    const target = typeof url === "string" ? new URL(url) : url;
    const body = bodyOf(init.body, target);

    return new Promise<Response>((resolve, reject) => {
      const call = httpRequest(
        {
          socketPath: options.socketPath,
          path: `${target.pathname}${target.search}`,
          method: init.method ?? "GET",
          headers: headersOf(init.headers, host),
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            const status = response.statusCode ?? 0;
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (Array.isArray(value)) {
                for (const item of value) {
                  headers.append(name, item);
                }
              } else if (value !== undefined) {
                headers.set(name, value);
              }
            }
            resolve(
              new Response(NULL_BODY_STATUS.has(status) ? null : Buffer.concat(chunks), {
                status,
                headers,
              }),
            );
          });
        },
      );

      call.once("error", reject);

      // The SDK's transport aborts its controller in `close()`, and a request left in flight after
      // that would hold the event loop open long past the point the shim meant to exit.
      const signal = init.signal;
      if (signal !== null && signal !== undefined) {
        if (signal.aborted) {
          call.destroy(new Error("xplainer: the IPC request was aborted before it was sent."));
        } else {
          signal.addEventListener(
            "abort",
            () => {
              call.destroy(new Error("xplainer: the IPC request was aborted."));
            },
            { once: true },
          );
        }
      }

      call.end(body);
    });
  };
}
