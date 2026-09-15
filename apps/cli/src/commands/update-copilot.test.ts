import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attachedForm } from "./update.js";

describe("Copilot update form detection", () => {
  let directory = "";

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "xplainer-update-copilot-"));
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function config(name: string, args: string[]): string {
    const path = join(directory, name);
    writeFileSync(
      path,
      `${JSON.stringify({
        mcpServers: {
          xplainer: { type: "local", command: "xplainer", args },
          other: { type: "local", command: "other", args: ["--attach"] },
        },
      })}\n`,
    );
    return path;
  }

  it("preserves the attached form", () => {
    expect(attachedForm(config("attached.json", ["mcp", "--attach"]), "copilot")).toBe(true);
  });

  it("preserves the in-session form without inheriting a neighbour's --attach", () => {
    expect(attachedForm(config("spawn.json", ["mcp"]), "copilot")).toBe(false);
  });
});
