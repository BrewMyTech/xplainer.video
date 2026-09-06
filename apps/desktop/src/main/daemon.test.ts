/**
 * Which daemon the desktop client would talk to.
 *
 * `resolveDaemonUrl` is the only A1-specific code in this app, and it is pure,
 * so these assertions are on the real returned strings: nothing is spawned,
 * nothing is fetched, and no Electron runtime is involved.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_DAEMON_PORT, resolveDaemonUrl } from "./daemon";

describe("resolveDaemonUrl", () => {
  it("points at the bundled daemon on loopback at the CLI's default port", () => {
    expect(DEFAULT_DAEMON_PORT).toBe(8787);
    expect(resolveDaemonUrl()).toBe("http://127.0.0.1:8787");
  });

  it("uses an explicitly configured port instead of the default", () => {
    expect(resolveDaemonUrl({ port: 9123 })).toBe("http://127.0.0.1:9123");
  });

  it("prefers a configured remote daemon over both the default and an explicit port", () => {
    expect(resolveDaemonUrl({ remoteUrl: "https://mcp.xplainer.video", port: 9123 })).toBe(
      "https://mcp.xplainer.video",
    );
  });

  it("falls back to the bundled daemon when the remote URL is blank", () => {
    expect(resolveDaemonUrl({ remoteUrl: "   " })).toBe("http://127.0.0.1:8787");
  });

  it("strips trailing slashes so a caller can append a path to the result", () => {
    expect(resolveDaemonUrl({ remoteUrl: "https://mcp.xplainer.video//" })).toBe(
      "https://mcp.xplainer.video",
    );
  });

  it("rejects a port that is not a usable TCP port number", () => {
    expect(() => resolveDaemonUrl({ port: 0 })).toThrow(RangeError);
    expect(() => resolveDaemonUrl({ port: 70000 })).toThrow(RangeError);
    expect(() => resolveDaemonUrl({ port: 8787.5 })).toThrow(/integer between 1 and 65535/);
  });
});
