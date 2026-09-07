/**
 * What `serve` is allowed to bind, and how the port is decided.
 *
 * Both functions under test are pure, and that is the point of testing them here rather than only
 * through a running daemon: ADR 0020 §Security R-SEC-9 is a *refusal* — the interesting cases are
 * the ones where nothing binds at all — and §Port and discovery's precedence has to be identical in
 * `serve`, in `status` and in the desktop client, which is only true if there is one function.
 */

import { describe, expect, it } from "vitest";
import {
  describeBindFailure,
  REMOTE_EXPOSURE_FLAG,
  resolveBindAddress,
  resolveDaemonEndpoint,
  resolveDaemonPort,
} from "./binding.js";

describe("resolveBindAddress", () => {
  it("binds loopback when no --bind is given", () => {
    expect(resolveBindAddress()).toEqual({ ok: true, hostname: "127.0.0.1", loopback: true });
    expect(resolveBindAddress({ bind: "" })).toEqual({
      ok: true,
      hostname: "127.0.0.1",
      loopback: true,
    });
  });

  it.each(["127.0.0.1", "localhost", "::1", "[::1]"])("accepts the loopback address %s", (bind) => {
    expect(resolveBindAddress({ bind })).toEqual({ ok: true, hostname: bind, loopback: true });
  });

  /**
   * A wildcard is not a decision about which interface to expose; it is the absence of one, and it
   * is the exact shape of CVE-2026-65105. So the acknowledgement flag does not unlock it.
   */
  it.each(["0.0.0.0", "::", "[::]", "*"])("refuses %s outright, even acknowledged", (bind) => {
    const refusal = resolveBindAddress({ bind, acknowledged: true });

    expect(refusal.ok).toBe(false);
    if (!refusal.ok) {
      expect(refusal.message).toContain("binds every interface");
      expect(refusal.message).toContain(REMOTE_EXPOSURE_FLAG);
      expect(refusal.message).toContain("R-SEC-9");
    }
  });

  it("refuses a non-loopback address unless the exposure flag is given", () => {
    const refusal = resolveBindAddress({ bind: "192.168.1.10" });

    expect(refusal.ok).toBe(false);
    if (!refusal.ok) {
      expect(refusal.message).toContain(REMOTE_EXPOSURE_FLAG);
      expect(refusal.message).toContain("192.168.1.10");
    }
  });

  it("allows a non-loopback address once it is acknowledged, and says it is not loopback", () => {
    expect(resolveBindAddress({ bind: "192.168.1.10", acknowledged: true })).toEqual({
      ok: true,
      hostname: "192.168.1.10",
      loopback: false,
    });
  });
});

describe("resolveDaemonPort", () => {
  it("prefers a configured port over the recorded one", () => {
    expect(resolveDaemonPort({ configured: 9000, recorded: 8790, fallback: 8787 })).toEqual({
      port: 9000,
      source: "configured",
    });
  });

  /** `--port 0` is a real request for an ephemeral port, not an absent one. */
  it("treats a configured 0 as configured", () => {
    expect(resolveDaemonPort({ configured: 0, recorded: 8790, fallback: 8787 })).toEqual({
      port: 0,
      source: "configured",
    });
  });

  it("falls back to daemon.json's recorded port, then to the default", () => {
    expect(resolveDaemonPort({ recorded: 8790, fallback: 8787 })).toEqual({
      port: 8790,
      source: "daemon.json",
    });
    expect(resolveDaemonPort({ recorded: null, fallback: 8787 })).toEqual({
      port: 8787,
      source: "default",
    });
  });
});

describe("resolveDaemonEndpoint", () => {
  it("lets a configured URL win outright, host and all", () => {
    expect(
      resolveDaemonEndpoint({
        configuredUrl: "http://10.0.0.2:9999",
        recordedPort: 8790,
        fallbackPort: 8787,
      }),
    ).toEqual({ ok: true, url: "http://10.0.0.2:9999", port: 9999, source: "configured" });
  });

  it("infers the scheme's default port for a URL that names none", () => {
    expect(
      resolveDaemonEndpoint({ configuredUrl: "https://daemon.example", fallbackPort: 8787 }),
    ).toEqual({ ok: true, url: "https://daemon.example", port: 443, source: "configured" });
  });

  it("refuses a configured value that is not an http(s) URL", () => {
    expect(resolveDaemonEndpoint({ configuredUrl: "not a url", fallbackPort: 8787 }).ok).toBe(
      false,
    );
    expect(
      resolveDaemonEndpoint({ configuredUrl: "ftp://daemon.example", fallbackPort: 8787 }).ok,
    ).toBe(false);
  });

  it("builds a loopback origin from the recorded port, then from the default", () => {
    expect(resolveDaemonEndpoint({ recordedPort: 8790, fallbackPort: 8787 })).toEqual({
      ok: true,
      url: "http://127.0.0.1:8790",
      port: 8790,
      source: "daemon.json",
    });
    expect(resolveDaemonEndpoint({ recordedPort: null, fallbackPort: 8787 })).toEqual({
      ok: true,
      url: "http://127.0.0.1:8787",
      port: 8787,
      source: "default",
    });
  });
});

describe("describeBindFailure", () => {
  /** `70` would tell a supervisor to restart a daemon whose port is held by something else. */
  it("gives a taken port exit 10 and a sentence naming it", () => {
    const taken = Object.assign(new Error("listen EADDRINUSE: address already in use"), {
      code: "EADDRINUSE",
    });

    const failure = describeBindFailure(taken, { hostname: "127.0.0.1", port: 8787 });

    expect(failure.exitCode).toBe(10);
    expect(failure.message).toContain("127.0.0.1:8787 is already in use");
    expect(failure.message).toContain("xplainer status");
  });

  it("gives anything it cannot classify exit 70, with what the OS said", () => {
    const failure = describeBindFailure(new Error("something else entirely"), {
      hostname: "127.0.0.1",
      port: 8787,
    });

    expect(failure.exitCode).toBe(70);
    expect(failure.message).toContain("something else entirely");
  });
});
