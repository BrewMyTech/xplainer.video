/**
 * The four layers, one request at a time.
 *
 * The middleware is exercised over a real Hono application rather than by calling it with a made-up
 * context, because what ADR 0020 §Security requires is a property of *requests*: a `Host` that is
 * not on the list gets `403` whatever else it carries, and `/healthz` is behind the token exactly
 * like every other route. `app.request()` builds a genuine `Request`, which is the only way to send
 * a `Host` header at all — `fetch` overwrites it from the URL, which is why the wired-up versions of
 * these assertions in `server.test.ts` go through `node:http`.
 *
 * Ordering is asserted, not assumed: a request that is wrong in two ways is answered for the *first*
 * layer it fails, because `Host` is the check that catches DNS rebinding and it has to run before
 * anything a page can control.
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  allowedOrigins,
  BEARER_CHALLENGE,
  createLoopbackGuard,
  LOOPBACK_HOSTS,
  loopbackAuthorities,
  REDACTED_AUTHORIZATION,
  redactAuthorization,
} from "./guard.js";

const TOKEN = "a-token-that-is-thirty-two-chars";
const PORT = 8787;

type Guarded = {
  app: Hono;
  lines: string[];
};

function guarded(
  options: { port?: number | null; allowHosts?: readonly string[]; tokens?: () => string[] } = {},
): Guarded {
  const lines: string[] = [];
  const port = options.port === undefined ? PORT : options.port;
  const app = new Hono();
  app.use(
    "*",
    createLoopbackGuard({
      tokens: options.tokens ?? ((): string[] => [TOKEN]),
      port: () => port,
      ...(options.allowHosts === undefined ? {} : { allowHosts: options.allowHosts }),
      log: (line) => {
        lines.push(line);
      },
    }),
  );
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.post("/mcp", (c) => c.json({ reached: true }));
  return { app, lines };
}

/** One request with exactly the headers given — no `fetch`, so `Host` survives. */
async function send(
  app: Hono,
  path: string,
  headers: Record<string, string>,
  method = "GET",
): Promise<Response> {
  return await app.request(new Request(`http://127.0.0.1:${PORT}${path}`, { method, headers }));
}

const AUTHORIZED = { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}` };

describe("loopbackAuthorities", () => {
  it("is exactly the three loopback names with the bound port", () => {
    expect(loopbackAuthorities(PORT)).toEqual(["127.0.0.1:8787", "localhost:8787", "[::1]:8787"]);
    expect(LOOPBACK_HOSTS).toHaveLength(3);
  });

  /** R-SEC-9: a widened bind *adds* an authority. It never removes the loopback ones. */
  it("adds a deliberately widened bind without dropping loopback", () => {
    expect(loopbackAuthorities(PORT, ["192.168.1.10"])).toContain("192.168.1.10:8787");
    expect(loopbackAuthorities(PORT, ["192.168.1.10"])).toContain("127.0.0.1:8787");
  });

  it("derives both schemes' origins from the authorities", () => {
    expect(allowedOrigins(["127.0.0.1:8787"])).toEqual([
      "http://127.0.0.1:8787",
      "https://127.0.0.1:8787",
    ]);
  });
});

describe("redactAuthorization", () => {
  it("never renders the value", () => {
    expect(redactAuthorization(`Bearer ${TOKEN}`)).toBe(REDACTED_AUTHORIZATION);
    expect(redactAuthorization(`Bearer ${TOKEN}`)).not.toContain(TOKEN);
    expect(redactAuthorization(undefined)).toBe("<absent>");
  });
});

describe("the loopback guard", () => {
  it.each(LOOPBACK_HOSTS)("admits an authenticated request with Host %s", async (host) => {
    const { app } = guarded();

    const response = await send(app, "/healthz", {
      host: `${host}:${PORT}`,
      authorization: `Bearer ${TOKEN}`,
    });

    expect(response.status).toBe(200);
  });

  it("admits a loopback Origin, and passes a request that sends none", async () => {
    const { app } = guarded();

    expect((await send(app, "/healthz", AUTHORIZED)).status).toBe(200);
    expect(
      (await send(app, "/healthz", { ...AUTHORIZED, origin: `http://127.0.0.1:${PORT}` })).status,
    ).toBe(200);
  });

  it("guards /mcp exactly as it guards /healthz", async () => {
    const { app } = guarded();

    expect((await send(app, "/mcp", { host: `127.0.0.1:${PORT}` }, "POST")).status).toBe(401);
    expect((await send(app, "/mcp", { ...AUTHORIZED, host: "evil.com:8787" }, "POST")).status).toBe(
      403,
    );
    expect((await send(app, "/mcp", AUTHORIZED, "POST")).status).toBe(200);
  });

  /** Every HTTP/1.1 request carries a `Host`; one that does not is not a request this daemon serves. */
  it("answers 403 when there is no Host header at all", async () => {
    const { app, lines } = guarded();

    expect((await send(app, "/healthz", { authorization: `Bearer ${TOKEN}` })).status).toBe(403);
    expect(lines.join("\n")).toContain("403 invalid Host header: <absent>");
  });

  it("answers 401 with a Bearer challenge when no token is presented", async () => {
    const { app, lines } = guarded();

    const response = await send(app, "/healthz", { host: `127.0.0.1:${PORT}` });
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(BEARER_CHALLENGE);
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(lines.join("\n")).toContain("401 bearer token rejected: <absent>");
  });

  it.each([
    ["a wrong token of the same length", `Bearer ${"b".repeat(TOKEN.length)}`],
    ["a token of a different length", "Bearer short"],
    ["another scheme entirely", `Basic ${TOKEN}`],
    ["a bearer with two values", `Bearer ${TOKEN} extra`],
  ])("answers 401 for %s", async (_case, authorization) => {
    const { app } = guarded();

    const response = await send(app, "/healthz", { host: `127.0.0.1:${PORT}`, authorization });

    expect(response.status).toBe(401);
  });

  it("redacts the Authorization header in the line it logs (R-SEC-10)", async () => {
    const { app, lines } = guarded();

    await send(app, "/healthz", { host: `127.0.0.1:${PORT}`, authorization: "Bearer wrong-token" });

    expect(lines.join("\n")).toContain(REDACTED_AUTHORIZATION);
    expect(lines.join("\n")).not.toContain("wrong-token");
    expect(lines.join("\n")).toContain("GET /healthz");
  });

  it("answers 403 for a Host that is not on the list, and logs the offending value", async () => {
    const { app, lines } = guarded();

    const response = await send(app, "/healthz", {
      host: "evil.com:8787",
      authorization: `Bearer ${TOKEN}`,
    });
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN_HOST");
    expect(lines.join("\n")).toContain("403 invalid Host header: evil.com:8787");
  });

  /**
   * `http://2130706433:8787` and `http://0x7f000001:8787` both reach loopback and would pass any
   * "does this look like 127.0.0.1" test. The check is string equality against a list, so they do
   * not pass this one.
   */
  it.each(["2130706433:8787", "0x7f000001:8787", "127.0.0.1", "127.0.0.1:8788"])(
    "answers 403 for the near-miss Host %s",
    async (host) => {
      const { app } = guarded();

      expect((await send(app, "/healthz", { host, authorization: `Bearer ${TOKEN}` })).status).toBe(
        403,
      );
    },
  );

  it("answers 403 for a non-loopback Origin", async () => {
    const { app, lines } = guarded();

    const response = await send(app, "/healthz", { ...AUTHORIZED, origin: "http://evil.com" });
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN_ORIGIN");
    expect(lines.join("\n")).toContain("403 invalid Origin header: http://evil.com");
  });

  /** `Host` is ranked first because it is the one a page cannot forge, so it answers first. */
  it("rejects a bad Host before it looks at the token", async () => {
    const { app } = guarded();

    const response = await send(app, "/healthz", { host: "evil.com:8787" });

    expect(response.status).toBe(403);
  });

  it("admits an operator's --allow-host, and still admits loopback", async () => {
    const { app } = guarded({ allowHosts: ["192.168.1.10"] });

    expect(
      (await send(app, "/healthz", { ...AUTHORIZED, host: `192.168.1.10:${PORT}` })).status,
    ).toBe(200);
    expect((await send(app, "/healthz", AUTHORIZED)).status).toBe(200);
  });

  /**
   * CVE-2026-65105 as a rule (R-SEC-9). Ollama's `Host` validation was conditional on a loopback
   * bind, so widening the bind switched the whole defence off. Here the operator's list *adds*
   * three things and subtracts none: an authority nobody named is still `403`, an `Origin` nobody
   * named is still `403`, and the token is still asked for.
   */
  it("still refuses evil.com when the allowlist has been widened", async () => {
    const { app, lines } = guarded({ allowHosts: ["daemon.internal", "192.168.1.10"] });

    expect((await send(app, "/healthz", { ...AUTHORIZED, host: `evil.com:${PORT}` })).status).toBe(
      403,
    );
    expect((await send(app, "/healthz", { ...AUTHORIZED, host: "evil.com" })).status).toBe(403);
    expect(
      (
        await send(app, "/healthz", {
          ...AUTHORIZED,
          host: `daemon.internal:${PORT}`,
          origin: "http://evil.com",
        })
      ).status,
    ).toBe(403);
    expect((await send(app, "/healthz", { host: `daemon.internal:${PORT}` })).status).toBe(401);
    expect(lines.join("\n")).toContain(`403 invalid Host header: evil.com:${PORT}`);
  });

  /** The operator's names are spelled the same way loopback's are: the bound port, appended. */
  it("gives an operator host the bound port and nothing else", () => {
    expect(loopbackAuthorities(PORT, ["daemon.internal"])).toEqual([
      "127.0.0.1:8787",
      "localhost:8787",
      "[::1]:8787",
      "daemon.internal:8787",
    ]);
  });

  /** A guard that does not yet know the port fails closed rather than admitting anything. */
  it("refuses every request while the port is unknown", async () => {
    const { app } = guarded({ port: null });

    expect((await send(app, "/healthz", AUTHORIZED)).status).toBe(403);
  });
});

/**
 * R-SEC-8's grace window, at the layer that decides it.
 *
 * `daemon/token.ts` owns *what* is accepted and this file owns *that the guard asks*: the values
 * come from a function called per request, so a rotation in another process reaches a daemon that
 * is already running, and both values open it until the window closes. A guard that captured a
 * string at construction would make every rotation a restart.
 */
describe("the guard's accepted set", () => {
  const ROTATED = "a-second-token-of-thirty-two-ch!";

  /** The `Host` this listener answers to, and one bearer value. */
  function bearer(value: string): Record<string, string> {
    return { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${value}` };
  }

  it("accepts every value the ring offers, and refuses one it has dropped", async () => {
    let accepted = [TOKEN];
    const { app } = guarded({ tokens: () => accepted });

    expect((await send(app, "/healthz", bearer(TOKEN))).status).toBe(200);

    accepted = [ROTATED, TOKEN];
    expect((await send(app, "/healthz", bearer(ROTATED))).status).toBe(200);
    expect((await send(app, "/healthz", bearer(TOKEN))).status).toBe(200);

    accepted = [ROTATED];
    expect((await send(app, "/healthz", bearer(TOKEN))).status).toBe(401);
    expect((await send(app, "/healthz", bearer(ROTATED))).status).toBe(200);
  });

  /** An empty set refuses everything: the guard fails closed, which is the only safe direction. */
  it("refuses every request when the ring offers nothing", async () => {
    const { app } = guarded({ tokens: () => [] });

    const answer = await send(app, "/healthz", bearer(TOKEN));

    expect(answer.status).toBe(401);
  });
});
