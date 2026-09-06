import { describe, expect, it } from "vitest";
import { checkTierGraph, type PackageNode } from "./tiers";

const hosted = (name: string, dependsOn: string[] = []): PackageNode => ({
  name,
  tier: "hosted",
  dependsOn,
});

const openLater = (name: string, dependsOn: string[] = []): PackageNode => ({
  name,
  tier: "open-later",
  dependsOn,
});

describe("checkTierGraph", () => {
  it("permits a hosted package to depend on an open-later package", () => {
    const violations = checkTierGraph([
      hosted("@xplainer/api", ["@xplainer/protocol"]),
      openLater("@xplainer/protocol"),
    ]);

    expect(violations).toEqual([]);
  });

  it("reports exactly one violation naming both packages when open-later depends on hosted", () => {
    const violations = checkTierGraph([
      openLater("@xplainer/render-core", ["@xplainer/api"]),
      hosted("@xplainer/api"),
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      from: "@xplainer/render-core",
      fromTier: "open-later",
      to: "@xplainer/api",
      toTier: "hosted",
    });
    expect(violations[0]?.message).toContain("@xplainer/render-core");
    expect(violations[0]?.message).toContain("@xplainer/api");
  });

  it("permits an open-later package to depend on another open-later package", () => {
    const violations = checkTierGraph([
      openLater("@xplainer/cli", ["@xplainer/mcp-server"]),
      openLater("@xplainer/mcp-server"),
    ]);

    expect(violations).toEqual([]);
  });
});
