/**
 * `xplainer update`'s two pure decisions: which version is later, and what to tell a user to run.
 *
 * The comparison is here because it shipped wrong once in the course of one afternoon. The first
 * version asked `latest !== CLI_VERSION` and called any difference "newer on npm", so a checkout at
 * `0.0.3` was told that `0.0.2` was available — an offer to downgrade, printed as an upgrade. The
 * direction is the whole decision this command makes, and `!==` cannot express a direction.
 *
 * What is deliberately not tested here is the reconcile half, which spawns `xplainer setup` and
 * `xplainer connect` as children. Those are real processes that download a browser and write into an
 * agent's configuration; asserting them belongs in `scripts/e2e/`, where the cost is expected. What
 * a unit suite can honestly hold is the arithmetic and the advice.
 */

import { describe, expect, it } from "vitest";
import { compareVersions, upgradeCommand } from "./update.js";

describe("compareVersions", () => {
  it("says the installed build is behind only when it really is", () => {
    expect(compareVersions("0.0.2", "0.0.3")).toBe("behind");
    expect(compareVersions("0.0.9", "0.1.0")).toBe("behind");
    expect(compareVersions("0.9.9", "1.0.0")).toBe("behind");
    // The regression: a later local build must never be reported as behind.
    expect(compareVersions("0.0.3", "0.0.2")).toBe("ahead");
    expect(compareVersions("1.0.0", "0.9.9")).toBe("ahead");
    expect(compareVersions("0.1.0", "0.0.9")).toBe("ahead");
  });

  it("treats equal versions as equal, however they are spelled in length", () => {
    expect(compareVersions("0.0.2", "0.0.2")).toBe("same");
    // Missing trailing parts are zero, so these are the same version.
    expect(compareVersions("1.0", "1.0.0")).toBe("same");
    expect(compareVersions("1.0.0.0", "1.0")).toBe("same");
  });

  it("compares numerically rather than as text, which is where a string compare fails", () => {
    // "0.0.10" < "0.0.9" as strings, and the wrong answer here would offer a downgrade.
    expect(compareVersions("0.0.9", "0.0.10")).toBe("behind");
    expect(compareVersions("0.0.10", "0.0.9")).toBe("ahead");
    expect(compareVersions("0.2.0", "0.10.0")).toBe("behind");
  });

  it("declines to guess at anything that is not numeric parts", () => {
    // A pre-release or build metadata: the command's only decision is whether to OFFER an upgrade,
    // and declining is strictly better than offering the wrong direction.
    expect(compareVersions("0.0.3-rc.1", "0.0.3")).toBe("unknown");
    expect(compareVersions("0.0.3", "0.0.4-beta")).toBe("unknown");
    expect(compareVersions("0.0.3", "not-a-version")).toBe("unknown");
    expect(compareVersions("0.0.3", "")).toBe("unknown");
  });

  it("answers unknown when the registry could not be read at all", () => {
    expect(compareVersions("0.0.3", null)).toBe("unknown");
  });
});

describe("upgradeCommand", () => {
  it("prints nothing for a checkout, because there is no install to upgrade", () => {
    // This suite runs from the checkout, where `installedPackageRoot()` answers null by
    // construction — the same fact that makes `runtime-dir` the default program source here.
    expect(upgradeCommand()).toBeNull();
  });
});
