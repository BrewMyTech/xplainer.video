/**
 * The one Content-Security-Policy this application ships, read off the file that ships it.
 *
 * Every other invariant in this member is asserted against a value a function returns. This one
 * cannot be: the policy is a `<meta http-equiv>` in `index.html`, electron-vite copies that file
 * into the bundle unchanged, and the same bytes end up inside the packaged application. So the file
 * is the unit under test, and the assertions below are about its text.
 *
 * **Why it is worth a test at all.** `index.html`'s own comment and `apps/desktop/AGENTS.md` both
 * state that the daemon's origin is deliberately not in this policy, and until 2026-09-08 that was
 * false: `connect-src` ended `http://localhost:*`, which is every loopback port the daemon can
 * bind. Nothing failed, because nothing was asked — a policy is only as good as the reading of it,
 * and two documents describing a third file is exactly the arrangement that drifts.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** The shipped renderer entry, beside this file. */
const INDEX_HTML = fileURLToPath(new URL("./index.html", import.meta.url));

/** The `content="…"` of the CSP `<meta>`, or a failure that says the tag itself has moved. */
function policy(): string {
  const html = readFileSync(INDEX_HTML, "utf8");
  const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
  if (meta?.[1] === undefined) {
    throw new Error(`${INDEX_HTML} carries no Content-Security-Policy meta tag`);
  }
  return meta[1];
}

/** One directive's source list, split on whitespace. */
function directive(name: string): readonly string[] {
  const found = policy()
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry === name || entry.startsWith(`${name} `));
  if (found === undefined) {
    throw new Error(`the policy has no ${name} directive: ${policy()}`);
  }
  return found.split(/\s+/).slice(1);
}

describe("the renderer's Content-Security-Policy", () => {
  it("has a default-src of 'self' and nothing else", () => {
    expect(directive("default-src")).toEqual(["'self'"]);
  });

  /**
   * The invariant. The renderer reaches the daemon through the preload bridge and holds no bearer
   * token; R-SEC-7 keeps CORS off the daemon, so a fetch from this page would be refused anyway.
   * An `http://localhost:*` here would be an allowance for a request that must never be made.
   */
  it("does not admit the daemon's own origin: no http loopback on connect-src", () => {
    const connect = directive("connect-src");

    expect(connect).not.toContain("http://localhost:*");
    expect(connect.some((source) => source.startsWith("http://"))).toBe(false);
    expect(connect.some((source) => source.startsWith("https://"))).toBe(false);
    // The whole list, so an addition has to be made deliberately rather than slipped in.
    expect(connect).toEqual(["'self'", "ws://localhost:*"]);
  });

  it("keeps xplainer-media: on the two directives the player needs and on no others", () => {
    expect(directive("img-src")).toEqual(["'self'", "data:", "xplainer-media:"]);
    expect(directive("media-src")).toEqual(["'self'", "xplainer-media:"]);
    expect(directive("script-src")).toEqual(["'self'"]);
    expect(directive("connect-src")).not.toContain("xplainer-media:");
  });
});
