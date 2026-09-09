/**
 * The server core, shared by the local daemon and the hosted image (plan §5 R20,
 * §4 S2.4b and S2.8).
 *
 * `createServer()` is the whole HTTP surface of this phase: a liveness probe and
 * a Streamable HTTP MCP endpoint. `apps/cli serve` binds it to a port on the
 * developer's machine and the hosted media service (relocated to a private
 * repository, ADR 0023) imports this same function for its container image, so
 * the two cannot drift into two implementations of one tool contract.
 * Everything below the tool names comes from
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
 * permissions are that transport's authentication — and the hosted media
 * service can carry its own at phase 3. ADR 0020 §The agent
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
 *
 * **The drain route, and the one seam that makes it IPC-only.** `POST
 * /api/daemon/drain` ({@link DRAIN_PATH}) is how a planned restart asks this
 * daemon for [ADR 0024](../../../docs/adr/0024-durable-jobs-and-boot-reconciliation.md)
 * §Drain on planned restart's six steps on a platform with no `SIGTERM` to send
 * — which is Windows, where Node maps the signal to `TerminateProcess` and no
 * handler ever runs. It is reachable over the socket **only**: over TCP it is
 * `404`, the same answer a route that does not exist gives, and it is `404` with
 * a valid bearer token too, because a remote caller must not be able to stop
 * this machine's daemon by holding the token that lets it render.
 *
 * How that is decided is {@link CreateServerOptions.isOverIpc}, and it is the
 * only shape this may take: the `WeakSet` stays inside `startServer()`, where
 * the socket's own adaptor puts the `Request` object it built into it, and this
 * function is handed a predicate over that set. **Never a header, a path, a body
 * or `remoteAddress`** — `apps/cli/AGENTS.md` §Two listeners, one application
 * states the rule and this is the seam that keeps it true while a route needs to
 * know the answer: "the moment the exemption is inferred from a header or from
 * `remoteAddress`, the loopback guard has a bypass in it."
 *
 * **The acknowledgement is written before the drain begins.** The route replies
 * `202` and only then, once that response has left the socket, calls
 * {@link DrainSeam.begin} — because step 6 removes the socket and exits the
 * process, and a client that asked for a drain and got `ECONNRESET` cannot tell
 * a daemon that is draining from one that crashed. `whenResponseIsSent()` is
 * that ordering, and it is the node adaptor's own `outgoing` response object
 * rather than a timer.
 */

import { createServer as createSecureServer } from "node:https";
import { createAdaptorServer, type ServerType, serve } from "@hono/node-server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer, type RenderBackend } from "@xplainer/mcp-server";
import { MCP_CONTRACT_VERSION } from "@xplainer/protocol";
import { Hono, type MiddlewareHandler } from "hono";
import { API_PREFIX } from "./api/paths.js";
import { type ApiSeam, createApiRoutes } from "./api/routes.js";
import { CLI_VERSION } from "./version.js";

/** The port `xplainer serve` binds when none is given (AC-14c). */
export const DEFAULT_PORT = 8787;

/** The interface `xplainer serve` binds. Loopback only: this is a local daemon. */
export const DEFAULT_HOSTNAME = "127.0.0.1";

/**
 * Where a planned restart asks for ADR 0024's six steps.
 *
 * Under `/api/` because it is the daemon's own control surface rather than part of the tool
 * contract, and a `POST` because it changes the state of the machine. T21 mounts the rest of the
 * `/api` surface beside it.
 *
 * The prefix is spelled without a trailing glob deliberately: `api-report.mjs` finds a
 * declaration's docblock by scanning back to the nearest comment opener, and a slash immediately
 * followed by an asterisk inside one **is** an opener — writing the glob here truncated this entry
 * in the published report, and the report is the surface a consumer reads.
 */
export const DRAIN_PATH = "/api/daemon/drain";

/**
 * How long {@link closer} waits for in-flight requests before it takes their connections away.
 *
 * `server.close()` stops accepting and then resolves when the last connection goes idle, which for
 * a long-lived response — an SSE stream, a media body, the `explainer_job` poll an agent is making
 * about the job being drained — is never. The drain has already given those requests its whole
 * 20-second budget by the time this runs, so the remaining choice is between a bounded teardown and
 * a daemon that hangs with its socket file still on disk. One second, and then the connections are
 * closed: ADR 0024's step 6 is "remove `runtime.json` and the socket, exit `0`", and it has to
 * happen inside P1-7's 25-second budget whatever a client is holding open.
 */
export const LISTENER_CLOSE_GRACE_MS = 1_000;

/**
 * What {@link DRAIN_PATH} answers with, and the two numbers a caller sizes its own wait from.
 *
 * `pid` is what a caller watches disappear — the drain ends in `process.exit`, and an outside
 * observer has no other way to see that happen — and `timeout_ms` is the daemon's own cap rather
 * than a constant the caller compiled in, so a client and a daemon of different releases do not
 * disagree about how long "draining" may last.
 */
export type DrainAcknowledgement = {
  event: "draining";
  /** The cap on steps 1–5, from the daemon that is about to run them. */
  timeout_ms: number;
  /** The process that will exit. */
  pid: number;
  /** Whether a drain was already running when this request arrived. */
  already_draining: boolean;
};

/**
 * The six steps, as the HTTP layer sees them: two facts to report and one thing to begin.
 *
 * A seam rather than an import, because `daemon/shutdown.ts` owns the sequence and this file must
 * stay the plain HTTP application the hosted media service can bind with no daemon underneath it.
 * Omit it and {@link DRAIN_PATH} is not registered at all, which is the honest answer for a server
 * that has no drain to run.
 */
export type DrainSeam = {
  /** ADR 0024's cap on steps 1–5, reported in the acknowledgement. */
  timeoutMs: number;
  /** This process's pid, reported in the acknowledgement. */
  pid: number;
  /**
   * Begin the six steps. Called once, and only after the acknowledgement has left the socket.
   *
   * `reason` is what the daemon's own shutdown log calls this stop, so a journal shows a drain
   * asked for over the socket differently from a `SIGTERM`.
   */
  begin: (reason: string) => void;
};

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
  /**
   * Whether this request arrived on the IPC listener, answered by the binding that accepted it.
   *
   * `startServer()` passes a predicate over its own `WeakSet<Request>` and nothing else may: the
   * set is keyed on the `Request` object the socket's adaptor constructed, so membership is a fact
   * about which listener took the connection rather than anything a client can claim. A route that
   * asked a header, a path or `remoteAddress` instead would be a bypass of the loopback guard.
   *
   * Absent — as it is for the hosted media service, which binds no socket — every request is
   * treated as not-over-IPC, so {@link DRAIN_PATH} answers `404` to all of them.
   */
  isOverIpc?: (request: Request) => boolean;
  /**
   * The drain {@link DRAIN_PATH} runs, or nothing and no such route.
   *
   * Only `commands/serve.ts` passes one, because only a daemon has ADR 0024's six steps to run.
   */
  drain?: DrainSeam;
  /**
   * Who is answering, as `/healthz` advertises it: the run id and the startup digest.
   *
   * The third row of ADR 0025's consistency check, and the only one on macOS — where no query
   * exists for what `launchd` actually loaded (§1.3b D7), a plist rewritten and never reloaded is
   * caught here or nowhere. It is **passed in** rather than computed here, because the value has to
   * be the snapshot `daemon/start.ts` froze after ownership and before this server bound: a server
   * that computed it at request time would answer for the process as it is now rather than for the
   * process as it was launched.
   *
   * Absent for the hosted media service, which takes no state directory and holds no ownership; the
   * two fields are then `null`, so the body's shape is the same either way and a reader never has
   * to tell "the field is missing" apart from "this release does not have it".
   */
  identity?: { run_id: string; runtime_digest: string };
  /**
   * Whether this machine's render toolchain is usable, asked at request time.
   *
   * [ADR 0020](../../../docs/adr/0020-always-running-local-daemon.md) §Degraded paths requires a
   * daemon whose toolchain is absent to *report* it rather than to answer `ok` and fail every
   * render, and nothing produced that report before: `/healthz` said `ok` for a machine with no
   * browser, no speech provider and no installed workspace. The seam is a function rather than a
   * value because the condition changes **under a running daemon** — `xplainer setup` is a separate
   * process, and a workspace can be deleted while the daemon is up — so a snapshot taken at bind
   * would answer for a machine that no longer exists.
   *
   * A **parameter**, for the same reason the guard is one: the hosted media service binds this same
   * application in a container with no state directory and no toolchain to have an opinion about,
   * and it passes none. Absent, `/healthz` answers `ok` with `reason: null`, so the body's shape is
   * the same either way and a reader never has to tell "this release has no such field" apart from
   * "this daemon is healthy".
   */
  toolchain?: () => { ok: boolean; reason: string | null };
  /**
   * The `/api` client surface, or nothing and no such routes.
   *
   * ADR 0016's REST and SSE under `/api` for GUI clients — the library, the artefact bytes, the
   * three enqueueing calls, one job and its event stream — mounted from `src/api/`. It is a
   * parameter rather than a fixture for the same reason the guard and the toolchain are: it needs a
   * workspace root, and the hosted media service binds this application in a container that has
   * none. Absent, the surface does not exist at all; the routes are never registered, so a request
   * for one gets the `404` a route this server does not have gives.
   *
   * `commands/serve.ts` passes `createWorkspaceLibrary({ root: daemon.workspaceRoot })` — the same
   * root the job runner's workers write into, resolved once, after ownership.
   */
  api?: ApiSeam;
};

/** A bound server, and the handle that stops it. */
export type RunningServer = {
  /** The port actually bound — resolved, so port `0` reports its real value. */
  port: number;
  /**
   * The origin the server answers on, with no trailing slash.
   *
   * `https:` when {@link StartServerOptions.tls} was given and `http:` otherwise, so the value
   * `serve` puts in `runtime.json`'s `addresses` and prints is one a client can use as it stands.
   */
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

/**
 * What {@link startServer} needs to bind.
 *
 * `guard` is replaced by a factory over the bound port, and `isOverIpc` is removed outright: the
 * binder owns the `WeakSet` that answers it, so a caller passing its own would be claiming
 * something about a listener it did not accept the connection on.
 */
export type StartServerOptions = Omit<CreateServerOptions, "guard" | "isOverIpc"> & {
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
   * listener is bound, which is what the hosted media service wants.
   */
  ipc?: { path: string };
  /**
   * The operator's certificate and key, which turns this listener into an `https` one.
   *
   * Present only for the deliberately non-loopback bind of ADR 0020 §Security R-SEC-9, where TLS is
   * one of the five preconditions; `daemon/tls.ts` reads and checks the pair, and `commands/serve.ts`
   * refuses the bind before this function is called if it is missing. Omitted is plain `http`,
   * which is what every loopback daemon and the hosted media service behind its own terminator get.
   *
   * The values are the PEM text rather than paths: this function does no I/O, and a caller that
   * passed a path would be asking the *listener* to decide what happens when the file cannot be
   * read — a decision that belongs before the bind, next to the other four refusals.
   */
  tls?: { cert: string; key: string };
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
 * the hosted media service binds the same app in its container.
 */
export function createServer(backend: RenderBackend, options: CreateServerOptions = {}): Hono {
  const version = options.version ?? CLI_VERSION;
  const app = new Hono();

  if (options.guard !== undefined) {
    app.use("*", options.guard);
  }

  // Fails closed: a server given no way to tell the two listeners apart treats every request as
  // having arrived over TCP, so the drain route below is `404` for all of them rather than open to
  // all of them.
  const isOverIpc = options.isOverIpc ?? ((): boolean => false);

  // `contract_version` is the daemon's advertisement of the tool contract it
  // speaks, and it is deliberately on `/healthz` rather than only in the MCP
  // handshake: `xplainer mcp --attach` has to decide whether it may talk to this
  // daemon *before* it starts proxying a session, and `serverInfo.version` in
  // the handshake carries `version` below — the release number — which is the
  // wrong number to compare (ADR 0025 §Note, 2026-09-06: P1-S3 settled).
  // `run_id` and `runtime_digest` are the identity row: pinned to this run's ownership nonce and to
  // an immutable startup snapshot over the effective argv, the resolved settings, the working
  // directory and the payload's content hash. Advertised rather than read back out of a file,
  // because a `daemon status` that inferred them from `runtime.json` would be asserting what the
  // last run wrote instead of what this process is.
  // `status` is `degraded` with a machine-readable `reason` when this machine cannot render — the
  // condition ADR 0020 §Degraded paths requires a daemon to report rather than to discover inside a
  // job. It stays a `200`: the daemon is up, answering, and holding the queue; what is missing is
  // something only `xplainer setup` can supply, and a `503` would make every liveness probe and
  // every supervisor treat a working daemon as a failed one.
  const identity = options.identity ?? null;
  const toolchain =
    options.toolchain ??
    ((): { ok: boolean; reason: string | null } => ({
      ok: true,
      reason: null,
    }));
  app.get("/healthz", (c) => {
    const health = toolchain();
    return c.json({
      status: health.ok ? "ok" : "degraded",
      reason: health.ok ? null : health.reason,
      version,
      contract_version: MCP_CONTRACT_VERSION,
      run_id: identity?.run_id ?? null,
      runtime_digest: identity?.runtime_digest ?? null,
    });
  });

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

  // Mounted after the guard: `app.route()` merges these routes into *this* application, so the `*`
  // middleware registered at the top of this function is in front of every one of them rather than
  // being something each route has to remember. The drain below registers its own path under the
  // same prefix, and the two cannot collide — `/api/daemon/drain` is not a route this router has.
  if (options.api !== undefined) {
    app.route(API_PREFIX, createApiRoutes(backend, options.api));
  }

  const drain = options.drain;
  if (drain !== undefined) {
    // One drain per process. A second POST is answered rather than refused — an impatient caller
    // that asked twice wants to know the daemon is going, not to be told off — and it starts
    // nothing, for the reason `daemon/shutdown.ts` ignores a second `SIGTERM`: step 3 is already
    // killing what step 2 was waiting for.
    let begun = false;
    app.post(DRAIN_PATH, (c) => {
      // `c.notFound()` rather than a refusal of our own, so a TCP client — token or no token —
      // gets exactly what it would get for a route this server does not have. There is nothing to
      // learn here by asking.
      if (!isOverIpc(c.req.raw)) {
        return c.notFound();
      }
      const acknowledgement: DrainAcknowledgement = {
        event: "draining",
        timeout_ms: drain.timeoutMs,
        pid: drain.pid,
        already_draining: begun,
      };
      if (!begun) {
        begun = true;
        whenResponseIsSent(c.env, () => {
          drain.begin(`POST ${DRAIN_PATH}`);
        });
      }
      return c.json(acknowledgement, 202);
    });
  }

  return app;
}

/**
 * Run `after` once this request's response has gone out, not before.
 *
 * `@hono/node-server` binds `{ incoming, outgoing }` as the request's environment, and `outgoing`
 * is the `ServerResponse` this reply is written to: its `close` event fires when the response is
 * complete — or when the connection went away first, which is equally "there is nothing more to
 * send". Waiting for it is what makes "the response is sent before the listeners close" a property
 * of the code rather than of how quickly the drain happens to run.
 *
 * The fallback is for a caller with no node binding at all — `app.request()` in a test, or a future
 * adaptor — where the response is already the returned value by the time anything else runs.
 */
function whenResponseIsSent(env: unknown, after: () => void): void {
  const outgoing = (env as { outgoing?: { once?: unknown } } | undefined)?.outgoing;
  if (outgoing === undefined || typeof outgoing.once !== "function") {
    setImmediate(after);
    return;
  }
  (outgoing as { once: (event: string, listener: () => void) => unknown }).once("close", after);
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
    ...(options.drain !== undefined && { drain: options.drain }),
    ...(options.identity !== undefined && { identity: options.identity }),
    ...(options.toolchain !== undefined && { toolchain: options.toolchain }),
    ...(options.api !== undefined && { api: options.api }),
    // The seam T13 adds, and the whole of it: the set stays here, and what leaves this function is
    // a question that can be asked about one `Request` object.
    isOverIpc: (request) => overIpc.has(request),
  });

  // An IPv6 literal has to be bracketed inside a URL, or `http://::1:8787` parses as a host of
  // `::1` with no port at all. Only reachable through `--bind ::1`, and wrong every time it is.
  const authority =
    hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;

  // The one difference TLS makes to this function: which `createServer` the adaptor calls and what
  // scheme the resulting origin carries. Everything above it — the app, the guard, the two
  // listeners — is identical, because R-SEC-9 is about what a remote bind *costs* and not about
  // serving something different once it is paid for.
  const material = options.tls;
  const scheme = material === undefined ? "http" : "https";
  const serveOptions =
    material === undefined
      ? { fetch: app.fetch, hostname, port }
      : {
          fetch: app.fetch,
          hostname,
          port,
          createServer: createSecureServer,
          serverOptions: { cert: material.cert, key: material.key },
        };

  const tcp = await new Promise<{ port: number; server: ServerType }>((resolve, reject) => {
    const server = serve(serveOptions, (address) => {
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
      url: `${scheme}://${authority}:${tcp.port}`,
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
    url: `${scheme}://${authority}:${tcp.port}`,
    socket: ipcPath,
    close: async () => {
      await closeIpc();
      await closeTcp();
    },
  };
}

/**
 * `close()` for one bound listener: stop accepting, then stop waiting.
 *
 * `close` reports only `ERR_SERVER_NOT_RUNNING`, which is the state the caller asked for, so the
 * callback is treated as "done" either way.
 *
 * **Why the grace exists.** `server.close()` resolves when the last connection is gone, and a
 * connection carrying a long-lived response — SSE, a media body, a poll that is still open — never
 * goes on its own. Node ≥19 drops *idle* connections here and holds in-flight ones for ever, so
 * without {@link LISTENER_CLOSE_GRACE_MS} a single open stream would leave the daemon running with
 * its socket file on disk and its state directory owned, which is the one state ADR 0024's step 6
 * exists to prevent. The drain that precedes this has already given every in-flight request its
 * whole budget.
 */
function closer(server: ServerType): () => Promise<void> {
  // `closeAllConnections` is `http.Server`'s and not on every member of `ServerType`; this binding
  // is always the one `serve()`/`createAdaptorServer()` built, and the optional call is what makes
  // that a fact the type system does not have to be told.
  const connections = server as unknown as { closeAllConnections?: () => void };
  return () =>
    new Promise<void>((closed) => {
      const forced = setTimeout(() => {
        connections.closeAllConnections?.();
      }, LISTENER_CLOSE_GRACE_MS);
      server.close(() => {
        clearTimeout(forced);
        closed();
      });
    });
}
