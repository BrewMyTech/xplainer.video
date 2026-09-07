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
 * **The guard is a parameter, not a mode.** `createServer()` takes an optional
 * middleware that every route passes first, so the TCP listener can carry the
 * loopback guard (`daemon/guard.ts`: `Host` allowlist, `Origin` validation and
 * the bearer token) while the IPC listener carries none — filesystem
 * permissions are that transport's authentication — and
 * `services/media-service` can carry its own at phase 3. ADR 0020 §The agent
 * path is IPC says why it is shaped that way: "One place decides, and the
 * loopback Host allowlist does not have to be wrong for the hosted service."
 * `startServer()` takes it as a *factory* over the bound port, because R-SEC-2
 * requires the allowlist to be built after bind and `--port 0` has to keep
 * working.
 *
 * **Two listeners, one application.** `startServer({ ipc })` also binds a unix
 * socket (a named pipe on Windows) through `createAdaptorServer({ fetch })` from
 * the pinned `@hono/node-server` 2.1.1, over the *same* `Hono` object and the
 * same tool registration — ADR 0020's "One `createServer()`, one tool
 * registration, two listeners". The guard is skipped for requests that arrive on
 * that listener, and the skip is keyed on the `Request` object the socket's own
 * adaptor built, so it is a fact about which listener accepted the connection
 * rather than anything a client can claim. `daemon/ipc.ts` owns the `0700`
 * directory that makes filesystem permissions the authentication there.
 *
 * `GET` and `DELETE` on `/mcp` are the session-oriented half of the Streamable
 * HTTP transport (server-initiated notifications, session teardown). Stateless
 * mode has no session to attach them to, so they are answered with a JSON-RPC
 * error and 405 rather than being left to the transport, which would open an SSE
 * stream nothing could ever write to. MCP clients treat 405 here as "this server
 * does not offer a standalone stream" and carry on.
 */

import { createAdaptorServer, type ServerType, serve } from "@hono/node-server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer, type RenderBackend } from "@xplainer/mcp-server";
import { MCP_CONTRACT_VERSION } from "@xplainer/protocol";
import { Hono, type MiddlewareHandler } from "hono";
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
  /**
   * Middleware every route passes before it is reached — the loopback guard, for a TCP binding.
   *
   * A parameter rather than a boolean "local mode", which is
   * [ADR 0020](../../../docs/adr/0020-always-running-local-daemon.md) §The agent path is IPC: "the
   * TCP binding passes the loopback guard, the IPC binding passes none, and at phase 3
   * `services/media-service` passes its OAuth guard. One place decides, and the loopback Host
   * allowlist does not have to be wrong for the hosted service."
   *
   * It is mounted before any route, so `/healthz`, `/mcp` and the future `/api/*` are covered by
   * construction rather than by remembering to list them (R-SEC-2).
   */
  guard?: MiddlewareHandler;
};

/** A bound server, and the handle that stops it. */
export type RunningServer = {
  /** The port actually bound — resolved, so port `0` reports its real value. */
  port: number;
  /** The origin the server answers on, with no trailing slash. */
  url: string;
  /**
   * The IPC endpoint this server is also listening on, or `null` when it was not asked for one.
   *
   * A unix socket path, or a Windows named pipe name. It is what `serve` puts in the ready line and
   * in `runtime.json`, and what a clean shutdown unlinks.
   */
  socket: string | null;
  /** Stop listening — both listeners. Resolves once the server has closed. */
  close(): Promise<void>;
};

/** The IPC listener could not be bound, distinguishable from the TCP one having failed. */
export class IpcBindError extends Error {
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(
      `xplainer serve: could not listen on the IPC socket ${path} ` +
        `(${cause instanceof Error ? cause.message : String(cause)})`,
    );
    this.name = "IpcBindError";
    this.path = path;
  }
}

/**
 * A guard that can only be built once the port is known.
 *
 * R-SEC-2 requires the `Host` allowlist to be built **after** bind, "because `startServer()`
 * resolves the real port in the listen callback and `--port 0` must keep working". A factory is how
 * that requirement reaches an application object that has to exist before `listen()` is called.
 */
export type GuardFactory = (port: number) => MiddlewareHandler;

/** What {@link startServer} needs to bind. */
export type StartServerOptions = Omit<CreateServerOptions, "guard"> & {
  /** The implementation the eight tools are served from. */
  backend: RenderBackend;
  /** Port to bind. `0` picks an ephemeral one. Defaults to {@link DEFAULT_PORT}. */
  port?: number;
  /** Interface to bind. Defaults to {@link DEFAULT_HOSTNAME}. */
  hostname?: string;
  /** Built with the resolved port in the listen callback, and armed before any request arrives. */
  guard?: GuardFactory;
  /**
   * A second listener on a unix socket or Windows named pipe, serving the same app with no guard.
   *
   * `daemon/ipc.ts` produces the path, having made the `0700` directory that is this transport's
   * whole authentication (ADR 0020 §The agent path is IPC, not TCP). Omit it and only the TCP
   * listener is bound, which is what `services/media-service` wants.
   */
  ipc?: { path: string };
};

/**
 * The authority a request over the IPC listener is given when its client sent no `Host`.
 *
 * Not exported, because it is a fallback rather than an address: a socket has no authority, and
 * `@hono/node-server` needs one to build the request URL from. `xplainer mcp --attach` sends its
 * own `Host` and never relies on this.
 */
const IPC_HOSTNAME = "xplainer.ipc";

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

  if (options.guard !== undefined) {
    app.use("*", options.guard);
  }

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
export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  const port = options.port ?? DEFAULT_PORT;

  // The guard is built in the listen callback below, from the port the OS actually gave us, and
  // this indirection is what lets the application exist before that number does. A request cannot
  // reach it first: `listen()` has to succeed before the socket accepts anything, and the callback
  // runs on that event. If one somehow did, `armed === null` refuses it — the guard fails closed,
  // which is the only safe direction for a middleware whose absence means "no authentication".
  const guardFactory = options.guard;
  let armed: MiddlewareHandler | null = null;

  // Which requests arrived over the IPC listener, recorded by the listener that accepted them.
  //
  // This is ADR 0020 §The agent path is IPC's "the TCP binding passes the loopback guard, the IPC
  // binding passes none", made a property of the *binding* rather than of a second application:
  // one `createServer()`, one tool registration, two listeners. The membership is keyed on the
  // `Request` object the adaptor constructed, so nothing a client can send — a header, a path, a
  // body — can put a TCP request in this set, and a request that is in it provably came off a
  // socket inside the `0700` directory. A `WeakSet` because the key is the request and its
  // lifetime is the request's.
  const overIpc = new WeakSet<Request>();

  const gate: MiddlewareHandler = async (c, next) => {
    if (overIpc.has(c.req.raw)) {
      return next();
    }
    if (armed === null) {
      return c.json(
        {
          error: {
            code: "NOT_READY",
            message: "This daemon is not finished binding, and refuses requests until it is.",
          },
        },
        503,
      );
    }
    return armed(c, next);
  };

  const app = createServer(options.backend, {
    ...(options.name !== undefined && { name: options.name }),
    ...(options.version !== undefined && { version: options.version }),
    ...(guardFactory !== undefined && { guard: gate }),
  });

  // An IPv6 literal has to be bracketed inside a URL, or `http://::1:8787` parses as a host of
  // `::1` with no port at all. Only reachable through `--bind ::1`, and wrong every time it is.
  const authority =
    hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;

  const tcp = await new Promise<{ port: number; server: ServerType }>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname, port }, (address) => {
      if (guardFactory !== undefined) {
        armed = guardFactory(address.port);
      }
      resolve({ port: address.port, server });
    });
    server.once("error", reject);
  });

  const closeTcp = closer(tcp.server);
  const ipcPath = options.ipc?.path;
  if (ipcPath === undefined) {
    return {
      port: tcp.port,
      url: `http://${authority}:${tcp.port}`,
      socket: null,
      close: closeTcp,
    };
  }

  const ipc = await new Promise<ServerType>((resolve, reject) => {
    const server = createAdaptorServer({
      // The one seam that makes a request identifiable as having come off the socket. It is set
      // here, in the adaptor this listener owns, and read by `gate` above.
      fetch: (request, env) => {
        overIpc.add(request);
        return app.fetch(request, env);
      },
      // `@hono/node-server` needs an authority to build the `Request` URL from, and a client that
      // dialled a path rather than a host may send no `Host` header at all.
      hostname: IPC_HOSTNAME,
    });
    server.once("error", reject);
    server.listen(ipcPath, () => {
      resolve(server);
    });
  }).catch(async (error: unknown) => {
    // A TCP listener left behind by a failed IPC bind would be a daemon that never announced and
    // never released its port, which is the one state `serve`'s callers cannot recover from.
    await closeTcp();
    throw new IpcBindError(ipcPath, error);
  });

  const closeIpc = closer(ipc);
  return {
    port: tcp.port,
    url: `http://${authority}:${tcp.port}`,
    socket: ipcPath,
    close: async () => {
      await closeIpc();
      await closeTcp();
    },
  };
}

/**
 * `close()` for one bound listener.
 *
 * `close` reports only `ERR_SERVER_NOT_RUNNING`, which is the state the caller asked for, so the
 * callback is treated as "done" either way.
 */
function closer(server: ServerType): () => Promise<void> {
  return () =>
    new Promise<void>((closed) => {
      server.close(() => {
        closed();
      });
    });
}
