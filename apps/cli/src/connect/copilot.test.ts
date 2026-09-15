import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  copilotAddArgv,
  copilotConfigPath,
  copilotHome,
  copilotServerEntry,
  writeCopilotConfig,
} from "./copilot.js";
import type { StdioEntry } from "./entry.js";
import { skillPath } from "./skill.js";

const scratch: string[] = [];

const ENTRY: StdioEntry = {
  command: "xplainer",
  args: ["mcp", "--attach"],
  source: "path",
};

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "xplainer-copilot-"));
  scratch.push(directory);
  return directory;
}

describe("GitHub Copilot CLI connection", () => {
  it("uses Copilot's documented personal config location and respects COPILOT_HOME", () => {
    const home = "/home/example";

    expect(copilotHome(home, {})).toBe(join(home, ".copilot"));
    expect(copilotConfigPath(home, {})).toBe(join(home, ".copilot", "mcp-config.json"));
    expect(copilotHome(home, { COPILOT_HOME: "/custom/copilot" })).toBe("/custom/copilot");
    expect(copilotConfigPath(home, { COPILOT_HOME: "/custom/copilot" })).toBe(
      join("/custom/copilot", "mcp-config.json"),
    );
    expect(skillPath("copilot", home, { COPILOT_HOME: "/custom/copilot" })).toBe(
      join("/custom/copilot", "skills", "xplainer", "SKILL.md"),
    );
  });

  it("builds the documented `copilot mcp add NAME -- COMMAND ARGS...` vector", () => {
    expect(copilotAddArgv(ENTRY)).toEqual([
      "mcp",
      "add",
      "xplainer",
      "--",
      "xplainer",
      "mcp",
      "--attach",
    ]);
  });

  it("renders a local stdio server with every xplainer tool enabled", () => {
    expect(copilotServerEntry(ENTRY)).toEqual({
      type: "local",
      command: "xplainer",
      args: ["mcp", "--attach"],
      tools: ["*"],
    });
  });

  it("merges xplainer into mcp-config.json and replaces only its own entry on a re-run", () => {
    const directory = temporary();
    const path = join(directory, "mcp-config.json");
    writeFileSync(
      path,
      `${JSON.stringify({
        otherSetting: true,
        mcpServers: {
          other: { type: "local", command: "other", args: [] },
          xplainer: { type: "local", command: "old", args: ["stale"] },
        },
      })}\n`,
    );

    const written = writeCopilotConfig(path, ENTRY);

    expect(written).toEqual({ merged: true, replaced: true });
    const document = JSON.parse(readFileSync(path, "utf8")) as {
      otherSetting: boolean;
      mcpServers: Record<string, unknown>;
    };
    expect(document.otherSetting).toBe(true);
    expect(document.mcpServers.other).toEqual({ type: "local", command: "other", args: [] });
    expect(document.mcpServers.xplainer).toEqual({
      type: "local",
      command: "xplainer",
      args: ["mcp", "--attach"],
      tools: ["*"],
    });
  });

  it("refuses to overwrite a malformed Copilot config", () => {
    const directory = temporary();
    const path = join(directory, "mcp-config.json");
    writeFileSync(path, "{ definitely not json\n");

    expect(() => writeCopilotConfig(path, ENTRY)).toThrow(/is not JSON/);
    expect(readFileSync(path, "utf8")).toBe("{ definitely not json\n");
  });
});
