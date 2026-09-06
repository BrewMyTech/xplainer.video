/**
 * The version seam between the main process and the renderer.
 *
 * `formatVersionArgument` and `parseVersionArgument` are two halves of one
 * contract, so the round trip is asserted rather than each half in isolation:
 * a change to the flag spelling that breaks the pair fails here even though
 * both functions still "work" on their own.
 */

import { describe, expect, it } from "vitest";
import { formatVersionArgument, parseVersionArgument, UNKNOWN_VERSION } from "./version-argument";

describe("the renderer version argument", () => {
  it("survives the round trip from the main process to the renderer", () => {
    const argv = ["/path/to/electron", "--some-chromium-switch", formatVersionArgument("1.4.2")];

    expect(parseVersionArgument(argv)).toBe("1.4.2");
  });

  it("ignores the unrelated switches Chromium adds to the renderer argv", () => {
    const argv = [
      "/path/to/electron",
      "--disable-features=SomeFeature",
      "--xplainer-app-version-lookalike=9.9.9",
      formatVersionArgument("0.0.0"),
      "--lang=en-GB",
    ];

    expect(parseVersionArgument(argv)).toBe("0.0.0");
  });

  it("reports an unknown version when the flag is missing entirely", () => {
    expect(parseVersionArgument(["/path/to/electron", "--lang=en-GB"])).toBe(UNKNOWN_VERSION);
  });

  it("reports an unknown version rather than an empty string when the flag has no value", () => {
    expect(parseVersionArgument([formatVersionArgument("")])).toBe(UNKNOWN_VERSION);
  });
});
