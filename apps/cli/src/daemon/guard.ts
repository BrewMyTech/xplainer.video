/**
 * The four layers every TCP request passes before it reaches a route.
 *
 * [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md) §Security states them as
 * requirements rather than features, and this file is all four in one middleware:
 *
 * - **R-SEC-2 — `Host` allowlist, exact match, every TCP route.** The allowlist is exactly
 *   `{127.0.0.1:PORT, localhost:PORT, [::1]:PORT}` and it is built **after** bind, because
 *   `startServer()` only learns the real port in the listen callback and `--port 0` has to keep
 *   working. Mismatch → `403`. **Never a parser:** `http://2130706433:8787` and
 *   `http://0x7f000001:8787` both reach loopback and would pass a "does this look like 127.0.0.1"
 *   test, so the check is string equality against a list and nothing else. `Host` is the header
 *   that catches DNS rebinding, because script cannot set it and every HTTP/1.1 request carries it.
 * - **R-SEC-3 — `Origin` validation.** Present and not allowed → `403`; **absent → pass**, because
 *   `curl`, Claude Code and Codex send none. That asymmetry is exactly why the `Host` check is
 *   ranked first and runs first here.
 * - **R-SEC-4 — a bearer token on every route, `/healthz` included**, compared with
 *   `crypto.timingSafeEqual` after a length check; failure → `401` with `WWW-Authenticate: Bearer`.
 *   Authenticating `/healthz` is load-bearing twice: an unauthenticated `{status, version}` tells a
 *   web page which xplainer to attack, and a `401` against *our* token is what lets `status` say
 *   "something is on our port that is not our daemon".
 * - **R-SEC-9 — the guard is unconditional.** It does not weaken when the bind widens. That is the
 *   CVE-2026-65105 lesson written down: Ollama's `Host` validation was conditional on a loopback
 *   bind, so widening the bind silently disabled the whole defence. Here a widened bind *adds* its
 *   authority to the allowlist and removes nothing.
 *
 * **R-SEC-10 — `Authorization` is redacted at the logger, not at call sites.** {@link redactAuthorization}
 * is the only thing that ever renders that header, and every rejection is logged with its reason and
 * the offending value, because `403 invalid Host header: evil.com:8787` is the only way anyone
 * learns a page tried this. Rejections are low-volume by construction; request bodies are never
 * logged at all.
 *
 * The middleware is passed *in* to `createServer()` rather than switched on by a flag, which is
 * ADR 0020 §The agent path is IPC: "the TCP binding passes the loopback guard, the IPC binding
 * passes none, and at phase 3 `services/media-service` passes its OAuth guard. One place decides,
 * and the loopback Host allowlist does not have to be wrong for the hosted service."
 */

import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/** The hostnames a loopback listener answers to, before the port is appended. */
export const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];

/** What a log line says in place of the bearer token (R-SEC-10). */
export const REDACTED_AUTHORIZATION = "Bearer <redacted>";

/** The challenge a rejected request is answered with, as RFC 9110 §11.6.1 requires of a `401`. */
export const BEARER_CHALLENGE = "Bearer";

/** Where the guard's rejections go. Silent by default. */
export type GuardLog = (line: string) => void;

/** What {@link createLoopbackGuard} needs. */
export type LoopbackGuardOptions = {
  /** The secret from `daemon/token.ts`. Compared, never logged. */
  token: string;
  /**
   * The bound port, read **per request**.
   *
   * A function rather than a number because the allowlist is built after bind: the app is
   * constructed before `listen()` resolves the port, and `--port 0` means the number does not exist
   * until then. `null` means "not bound yet", and a request that somehow arrives first is refused
   * rather than admitted.
   */
  port: () => number | null;
  /**
   * Extra authorities to allow, for the deliberately widened bind of R-SEC-9.
   *
   * They are *added* to the loopback set. The guard never subtracts.
   */
  hostnames?: readonly string[];
  log?: GuardLog;
};

/** The authorities a `Host` header may carry for a listener bound on `port`. */
export function loopbackAuthorities(port: number, extra: readonly string[] = []): string[] {
  const hosts = [...LOOPBACK_HOSTS, ...extra];
  return hosts.map((host) => `${host}:${port}`);
}

/** The origins those authorities correspond to, over both schemes a local page could use. */
export function allowedOrigins(authorities: readonly string[]): string[] {
  return authorities.flatMap((authority) => [`http://${authority}`, `https://${authority}`]);
}

/** Render an `Authorization` header for a log line, which means never rendering its value. */
export function redactAuthorization(value: string | undefined): string {
  return value === undefined ? "<absent>" : REDACTED_AUTHORIZATION;
}

/** Constant-time comparison that cannot be short-circuited by a length difference. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  // `timingSafeEqual` throws on differing lengths, so the length check has to come first; a length
  // difference is not a secret, and the value it leaks — how long the token is — is public.
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The token a request presents, or `null` when it presents none in the scheme we accept. */
function presentedToken(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme === undefined || scheme.toLowerCase() !== "bearer" || rest.length !== 1) {
    return null;
  }
  return rest[0] ?? null;
}

/**
 * Build the middleware. Mount it before any route, so `/healthz`, `/mcp` and the future `/api/*`
 * are covered by construction rather than by remembering to list them.
 */
export function createLoopbackGuard(options: LoopbackGuardOptions): MiddlewareHandler {
  const log = options.log ?? ((): void => {});

  return async function loopbackGuard(c, next) {
    const port = options.port();
    const authorities = port === null ? [] : loopbackAuthorities(port, options.hostnames ?? []);
    const origins = allowedOrigins(authorities);
    const method = c.req.method;
    const path = new URL(c.req.url).pathname;

    const host = c.req.header("host");
    if (host === undefined || !authorities.includes(host)) {
      log(`403 invalid Host header: ${host ?? "<absent>"} (${method} ${path})`);
      return c.json(
        {
          error: {
            code: "FORBIDDEN_HOST",
            message:
              "This daemon serves loopback callers only, and answers to " +
              `${authorities.join(", ")}. See ADR 0020 §Security R-SEC-2.`,
          },
        },
        403,
      );
    }

    const origin = c.req.header("origin");
    if (origin !== undefined && !origins.includes(origin)) {
      log(`403 invalid Origin header: ${origin} (${method} ${path})`);
      return c.json(
        {
          error: {
            code: "FORBIDDEN_ORIGIN",
            message:
              `The Origin ${origin} is not a loopback origin of this daemon. ` +
              "See ADR 0020 §Security R-SEC-3.",
          },
        },
        403,
      );
    }

    const authorization = c.req.header("authorization");
    const presented = presentedToken(authorization);
    if (presented === null || !tokenMatches(presented, options.token)) {
      log(`401 bearer token rejected: ${redactAuthorization(authorization)} (${method} ${path})`);
      c.header("WWW-Authenticate", BEARER_CHALLENGE);
      return c.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message:
              "Every TCP route of this daemon requires the bearer token from its token file " +
              "(ADR 0020 §Security R-SEC-4).",
          },
        },
        401,
      );
    }

    // Returned rather than awaited-and-fallen-off-the-end: every other path here answers with a
    // `Response`, and `noImplicitReturns` is on precisely so that a middleware whose last branch
    // forgets to hand `next()` back cannot be written by accident.
    return next();
  };
}
