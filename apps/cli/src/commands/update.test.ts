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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attachedForm, compareVersions, upgradeCommand } from "./update.js";

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

/**
 * The second thing this command got wrong, and the one that would have been worse.
 *
 * `update` re-runs `connect` for every configured agent, and the first version re-ran the bare verb
 * — which writes an *attaching* entry and refuses with exit 3 when no daemon has ever bound. That is
 * the majority of machines, since the daemon is opt-in, so `update` would have failed for most of
 * the people it exists to help. The fix reads the form out of the configuration the user already
 * has, and this is that read.
 *
 * The case worth the fixtures is a configuration with more than one MCP server in it, because the
 * obvious implementation — find "xplainer", look for `--attach` after it — inherits a neighbour's
 * transport and rewrites a working in-session entry as a broken attaching one.
 */
describe("attachedForm", () => {
  let dir = "";
  const write = (name: string, text: string): string => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };
  const claudeConfig = (name: string, servers: unknown): string =>
    write(name, JSON.stringify({ mcpServers: servers }, null, 2));

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "xplainer-update-form-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the attaching form out of each client's own format", () => {
    const claude = claudeConfig("attach.json", {
      xplainer: { command: "npx", args: ["-y", "xplainer", "mcp", "--attach"] },
    });
    expect(attachedForm(claude, "claude")).toBe(true);

    const codex = write(
      "attach.toml",
      '[mcp_servers.xplainer]\ncommand = "npx"\nargs = ["-y", "xplainer", "mcp", "--attach"]\n',
    );
    expect(attachedForm(codex, "codex")).toBe(true);
  });

  it("answers false for the in-session form, so the refresh keeps --spawn", () => {
    const claude = claudeConfig("spawn.json", {
      xplainer: { command: "npx", args: ["-y", "xplainer", "mcp"] },
    });
    expect(attachedForm(claude, "claude")).toBe(false);

    const codex = write(
      "spawn.toml",
      '[mcp_servers.xplainer]\ncommand = "npx"\nargs = ["-y", "xplainer", "mcp"]\n',
    );
    expect(attachedForm(codex, "codex")).toBe(false);
  });

  it("does not inherit --attach from a NEIGHBOURING server, in either format", () => {
    // The regression this reader exists to avoid: ours is in-session, the next server along
    // attaches to something of its own, and a text scan from our name to the end of the file says
    // "attached". Both orders are checked, because a scan that happens to look backwards has the
    // same bug mirrored.
    const after = claudeConfig("neighbour-after.json", {
      xplainer: { command: "npx", args: ["-y", "xplainer", "mcp"] },
      other: { command: "other-server", args: ["--attach", "/tmp/other.sock"] },
    });
    const before = claudeConfig("neighbour-before.json", {
      other: { command: "other-server", args: ["--attach", "/tmp/other.sock"] },
      xplainer: { command: "npx", args: ["-y", "xplainer", "mcp"] },
    });
    expect(attachedForm(after, "claude")).toBe(false);
    expect(attachedForm(before, "claude")).toBe(false);

    const codexAfter = write(
      "neighbour-after.toml",
      '[mcp_servers.xplainer]\ncommand = "npx"\nargs = ["-y", "xplainer", "mcp"]\n\n' +
        '[mcp_servers.other]\ncommand = "other-server"\nargs = ["--attach"]\n',
    );
    expect(attachedForm(codexAfter, "codex")).toBe(false);
  });

  it("still finds our own --attach when a neighbour follows it", () => {
    // The mirror of the case above: bounding the window must not make it too small to see our own
    // transport.
    const claude = claudeConfig("attach-then-neighbour.json", {
      xplainer: { command: "npx", args: ["-y", "xplainer", "mcp", "--attach"] },
      other: { command: "other-server", args: [] },
    });
    expect(attachedForm(claude, "claude")).toBe(true);

    const codex = write(
      "attach-then-neighbour.toml",
      '[mcp_servers.xplainer]\ncommand = "npx"\nargs = ["-y", "xplainer", "mcp", "--attach"]\n\n' +
        '[mcp_servers.other]\ncommand = "other-server"\nargs = []\n',
    );
    expect(attachedForm(codex, "codex")).toBe(true);
  });

  it("answers false for anything it cannot resolve", () => {
    // No file, no entry, not parseable, a shape it does not recognise. Every one of these means
    // "no attaching entry to preserve", and --spawn is the form that works with nothing running —
    // so false is the safe answer to all of them.
    expect(attachedForm(join(dir, "absent.json"), "claude")).toBe(false);
    expect(attachedForm(join(dir, "absent.toml"), "codex")).toBe(false);
    expect(attachedForm(claudeConfig("empty.json", {}), "claude")).toBe(false);
    expect(attachedForm(write("truncated.json", '{"mcpServers":'), "claude")).toBe(false);
    expect(attachedForm(write("other-only.toml", "[mcp_servers.other]\n"), "codex")).toBe(false);
    // args declared as something other than a list.
    const odd = claudeConfig("odd.json", { xplainer: { command: "npx", args: "--attach" } });
    expect(attachedForm(odd, "claude")).toBe(false);
  });
});

describe("upgradeCommand", () => {
  it("prints nothing for a checkout, because there is no install to upgrade", () => {
    // This suite runs from the checkout, where `installedPackageRoot()` answers null by
    // construction — the same fact that makes `runtime-dir` the default program source here.
    expect(upgradeCommand()).toBeNull();
  });
});
