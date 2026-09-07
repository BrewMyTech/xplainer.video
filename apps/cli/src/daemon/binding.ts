/**
 * Where the daemon listens, and how that is decided — two pure functions and no I/O.
 *
 * **The bind address (R-SEC-9).** [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md)
 * §Security makes non-loopback exposure a deliberate, awkward gesture rather than a flag:
 * "A non-loopback socket requires **all** of: an explicit `--bind`; an explicit
 * `--i-understand-remote-exposure` (the same gesture as `services/tts-sidecar/packaging/`'s
 * `--i-know-this-is-a-stub`, so the repository has one idiom for 'this is deliberately hard'); a
 * non-default token; TLS; and a Host/Origin allowlist that still applies… `0.0.0.0` and `::` are
 * refused outright." The wildcards are refused *even with* the acknowledgement, because a wildcard
 * bind is not a decision about which interface to expose — it is the absence of one, and it is the
 * exact shape of the CVE that section cites.
 *
 * TLS does not exist in this phase, so an acknowledged non-loopback bind is refused a second time
 * by reality rather than by this function; what it does here is refuse to be reached by accident.
 *
 * **The port (ADR 0020 §Port and discovery).** The precedence is
 * **configured URL → `daemon.json`'s recorded port → `DEFAULT_PORT`**, and it is a pure function so
 * that `serve`, `status` and (from phase 2) `apps/desktop`'s `resolveDaemonUrl()` cannot each
 * invent their own order. The recorded port is a *contract*: "a discovery value that changes on
 * restart is not a discovery mechanism, and restart is the property this record adds."
 */

import { DAEMON_INTERNAL_EXIT_CODE, OWNERSHIP_REFUSED_EXIT_CODE } from "./exit-codes.js";

/** The hostnames that mean "this machine, and nowhere else". */
export const LOOPBACK_BINDS: readonly string[] = ["127.0.0.1", "localhost", "::1", "[::1]"];

/** The addresses that mean "every interface", and are refused however hard the caller insists. */
export const WILDCARD_BINDS: readonly string[] = ["0.0.0.0", "::", "[::]", "*"];

/** The flag that turns a refusal into a deliberate act. */
export const REMOTE_EXPOSURE_FLAG = "--i-understand-remote-exposure";

/** What {@link resolveBindAddress} was asked for. */
export type BindRequest = {
  /** The `--bind` argument, or `undefined` for the default. */
  bind?: string | undefined;
  /** Whether {@link REMOTE_EXPOSURE_FLAG} was given. */
  acknowledged?: boolean | undefined;
  /** The interface used when `--bind` is absent. */
  fallback?: string;
};

/** Either an address to bind, or the sentence explaining why not. */
export type BindDecision =
  | {
      ok: true;
      hostname: string;
      /** `false` only for an acknowledged, deliberately remote bind. */
      loopback: boolean;
    }
  | { ok: false; message: string };

/** Decide what `serve` may bind, refusing anything R-SEC-9 refuses. */
export function resolveBindAddress(request: BindRequest = {}): BindDecision {
  const fallback = request.fallback ?? "127.0.0.1";
  const requested = request.bind?.trim();
  if (requested === undefined || requested === "") {
    return { ok: true, hostname: fallback, loopback: true };
  }
  if (LOOPBACK_BINDS.includes(requested)) {
    return { ok: true, hostname: requested, loopback: true };
  }
  if (WILDCARD_BINDS.includes(requested)) {
    return {
      ok: false,
      message:
        `xplainer serve: --bind ${requested} binds every interface, which is refused outright — ` +
        `${REMOTE_EXPOSURE_FLAG} does not enable it. Name the one interface you mean ` +
        "(ADR 0020 §Security R-SEC-9).",
    };
  }
  if (request.acknowledged !== true) {
    return {
      ok: false,
      message:
        `xplainer serve: --bind ${requested} is not a loopback address, and this daemon serves ` +
        `loopback only unless ${REMOTE_EXPOSURE_FLAG} is also given. Remote exposure is outside ` +
        "the supported configuration: it needs TLS and a non-default token as well " +
        "(ADR 0020 §Security R-SEC-9).",
    };
  }
  return { ok: true, hostname: requested, loopback: false };
}

/** Which of the three inputs decided the port. */
export type PortSource = "configured" | "daemon.json" | "default";

/** A resolved port, and which precedence step produced it. */
export type PortDecision = {
  port: number;
  source: PortSource;
};

/** What {@link resolveDaemonPort} weighs, in precedence order. */
export type PortRequest = {
  /** An explicitly configured port — `--port`, or the port inside a configured URL. */
  configured?: number | null | undefined;
  /** `daemon.json`'s recorded port. */
  recorded?: number | null | undefined;
  /** The compiled-in default. */
  fallback: number;
};

/** Configured → recorded → default, and nothing else, ever. */
export function resolveDaemonPort(request: PortRequest): PortDecision {
  if (typeof request.configured === "number" && Number.isInteger(request.configured)) {
    return { port: request.configured, source: "configured" };
  }
  if (
    typeof request.recorded === "number" &&
    Number.isInteger(request.recorded) &&
    request.recorded > 0
  ) {
    return { port: request.recorded, source: "daemon.json" };
  }
  return { port: request.fallback, source: "default" };
}

/** What {@link resolveDaemonEndpoint} weighs. */
export type EndpointRequest = {
  /** A whole URL a user configured, which wins over everything. */
  configuredUrl?: string | null | undefined;
  /** `daemon.json`'s recorded port. */
  recordedPort?: number | null | undefined;
  /** The compiled-in default port. */
  fallbackPort: number;
  /** The host a resolved port is reached on. */
  hostname?: string;
};

/** Either the origin to talk to, or the sentence explaining why the configured URL is unusable. */
export type EndpointDecision =
  | { ok: true; url: string; port: number; source: PortSource }
  | { ok: false; message: string };

/**
 * The whole precedence, as one answer a client can call `fetch` with.
 *
 * A configured URL wins outright — including its host, because a URL that names another machine is
 * the one case where the recorded port is not this machine's business.
 */
export function resolveDaemonEndpoint(request: EndpointRequest): EndpointDecision {
  const configured = request.configuredUrl?.trim();
  if (configured !== undefined && configured !== "") {
    let parsed: URL;
    try {
      parsed = new URL(configured);
    } catch {
      return {
        ok: false,
        message: `xplainer: ${configured} is not a URL this client can use.`,
      };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        ok: false,
        message: `xplainer: ${configured} is not an http(s) URL.`,
      };
    }
    const port =
      parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 80) : Number(parsed.port);
    return { ok: true, url: parsed.origin, port, source: "configured" };
  }

  const decision = resolveDaemonPort({
    recorded: request.recordedPort,
    fallback: request.fallbackPort,
  });
  const hostname = request.hostname ?? "127.0.0.1";
  return {
    ok: true,
    url: `http://${hostname}:${decision.port}`,
    port: decision.port,
    source: decision.source,
  };
}

/** Why a bind failed, in the terms the exit-code table uses. */
export type BindFailure = {
  exitCode: number;
  message: string;
};

/**
 * Turn a failed `listen()` into an exit code and a sentence.
 *
 * `EADDRINUSE` is not an internal error, and giving it `70` would tell a supervisor to restart a
 * daemon whose port is held by something else — a restart loop against a condition no restart can
 * change. ADR 0020 §Port and discovery gives it a row of its own: "if that port is later
 * unavailable `serve` exits `10` naming the pid that holds it and `status` prints the fix. A loud
 * one-line failure, rather than a silent daemon that moved and left every agent config pointing at
 * nothing." The pid is not named here — finding it portably means spawning `lsof` or its Windows
 * equivalent, which belongs with `xplainer daemon status` — so the message names the port, the two
 * things that are usually holding it, and the flag that moves this daemon instead.
 *
 * Anything else is `70`: a bind that failed for a reason this daemon cannot classify is exactly
 * what that row is for.
 */
export function describeBindFailure(
  error: unknown,
  where: { hostname: string; port: number },
): BindFailure {
  const code = error instanceof Error && "code" in error ? String(error.code) : "";
  const detail = error instanceof Error ? error.message : String(error);
  if (code === "EADDRINUSE") {
    return {
      exitCode: OWNERSHIP_REFUSED_EXIT_CODE,
      message:
        `xplainer serve: ${where.hostname}:${where.port} is already in use, so this daemon has ` +
        `nothing to listen on and is exiting ${OWNERSHIP_REFUSED_EXIT_CODE}. Either another ` +
        "xplainer daemon is running — `xplainer status` says whether it answers — or another " +
        "program holds that port; `--port` moves this one, and the port it binds is recorded in " +
        "daemon.json for the next start.",
    };
  }
  return {
    exitCode: DAEMON_INTERNAL_EXIT_CODE,
    message: `xplainer serve: could not bind ${where.hostname}:${where.port}: ${detail}`,
  };
}
