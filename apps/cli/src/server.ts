/**
 * The server core, shared by the local daemon and the hosted image (plan §5 R20,
 * §4 S2.4b and S2.8).
 *
 * `createServer()` is the whole HTTP surface of this phase: a liveness probe and
 * a Streamable HTTP MCP endpoint. `apps/cli serve` binds it to a port on the
 * developer's machine and `services/media-service` imports this same function
 * for its container image, so the two cannot drift into two implementations of
 * one tool contract. Everything below the tool names comes from
 * `createMcpServer()` in `@xplainer/mcp-server`, which iterates
 * `@xplainer/protocol`'s manifest — so `tools/list` equals the manifest by
 * construction rather than by a second list kept in step by hand (AC-14d).
 *
 * **Why a fresh MCP server and transport per POST.** The transport is used in
 * stateless mode — no session id, no cross-request state — and the SDK refuses
 * to let a stateless transport handle a second request, because reusing one
 * across clients collides their JSON-RPC message ids. So each POST gets its own
 * pair, connected and closed around the request. `enableJsonResponse` keeps the
 * reply a complete JSON body rather than an SSE stream, which is what makes
 * closing immediately afterwards safe.
 *
 * `GET` and `DELETE` on `/mcp` are the session-oriented half of the Streamable
 * HTTP transport (server-initiated notifications, session teardown). Stateless
 * mode has no session to attach them to, so they are answered with a JSON-RPC
 * error and 405 rather than being left to the transport, which would open an SSE
 * stream nothing could ever write to. MCP clients treat 405 here as "this server
 * does not offer a standalone stream" and carry on.
 */

import { serve } from "@hono/node-server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer, type RenderBackend } from "@xplainer/mcp-server";
import { MCP_CONTRACT_VERSION } from "@xplainer/protocol";
import { Hono } from "hono";
import { CLI_VERSION } from "./version.js";

/** The port `xplainer serve` binds when none is given (AC-14c). */
export const DEFAULT_PORT = 8787;

/** The interface `xplainer serve` binds. Loopback only: this is a local daemon. */
export const DEFAULT_HOSTNAME = "127.0.0.1";

/** Identity the server reports on `/healthz` and in the MCP handshake. */
export type CreateServerOptions = {
  /** MCP server name. Defaults to the protocol manifest's name. */
  name?: string;
  /** Version reported by `/healthz` and the handshake. Defaults to the CLI's. */
  version?: string;
};

/** A bound server, and the handle that stops it. */
export type RunningServer = {
  /** The port actually bound — resolved, so port `0` reports its real value. */
  port: number;
  /** The origin the server answers on, with no trailing slash. */
  url: string;
  /** Stop listening. Resolves once the server has closed. */
  close(): Promise<void>;
};

/** What {@link startServer} needs to bind. */
export type StartServerOptions = CreateServerOptions & {
  /** The implementation the eight tools are served from. */
  backend: RenderBackend;
  /** Port to bind. `0` picks an ephemeral one. Defaults to {@link DEFAULT_PORT}. */
  port?: number;
  /** Interface to bind. Defaults to {@link DEFAULT_HOSTNAME}. */
  hostname?: string;
};

/** The JSON-RPC error returned for the transport methods stateless mode cannot serve. */
const METHOD_NOT_ALLOWED = {
  jsonrpc: "2.0",
  error: {
    code: -32000,
    message: "Method not allowed: this MCP endpoint is stateless and only accepts POST.",
  },
  id: null,
} as const;

/**
 * Build the HTTP application: `GET /healthz` plus the MCP endpoint at `/mcp`.
 *
 * The returned app is not bound to a port. `startServer()` binds it for the CLI;
 * `services/media-service` binds the same app in its container.
 */
export function createServer(backend: RenderBackend, options: CreateServerOptions = {}): Hono {
  const version = options.version ?? CLI_VERSION;
  const app = new Hono();

  // `contract_version` is the daemon's advertisement of the tool contract it
  // speaks, and it is deliberately on `/healthz` rather than only in the MCP
  // handshake: `xplainer mcp --attach` has to decide whether it may talk to this
  // daemon *before* it starts proxying a session, and `serverInfo.version` in
  // the handshake carries `version` below — the release number — which is the
  // wrong number to compare (ADR 0025 §Note, 2026-09-06: P1-S3 settled).
  app.get("/healthz", (c) =>
    c.json({ status: "ok", version, contract_version: MCP_CONTRACT_VERSION }),
  );

  app.post("/mcp", async (c) => {
    const server = createMcpServer(backend, {
      ...(options.name !== undefined && { name: options.name }),
      version,
    });
    // Omitting `sessionIdGenerator` IS stateless mode: the SDK reads the option
    // and branches on falsiness, and its own example passes an explicit
    // `undefined` for the same effect (@modelcontextprotocol/sdk 1.30.0). Under
    // `exactOptionalPropertyTypes` only the omission type-checks, so do not
    // re-add the key — ADR 0020 §R-SEC-2 quotes this object with it present.
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });

  app.on(["GET", "DELETE"], "/mcp", (c) => c.json(METHOD_NOT_ALLOWED, 405));

  return app;
}

/**
 * Bind {@link createServer}'s app and report where it landed.
 *
 * Rejects if the port cannot be bound, so a caller — the `serve` command, or a
 * test asking for an ephemeral port — never reports an address nothing is
 * listening on.
 */
export function startServer(options: StartServerOptions): Promise<RunningServer> {
  const app = createServer(options.backend, options);
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  const port = options.port ?? DEFAULT_PORT;

  return new Promise<RunningServer>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname, port }, (address) => {
      resolve({
        port: address.port,
        url: `http://${hostname}:${address.port}`,
        close: () =>
          new Promise<void>((closed) => {
            // `close` reports only ERR_SERVER_NOT_RUNNING, which is the state the
            // caller asked for, so the callback is treated as "done" either way.
            server.close(() => {
              closed();
            });
          }),
      });
    });
    server.once("error", reject);
  });
}
