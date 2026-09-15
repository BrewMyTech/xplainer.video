import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerWithCopilotCli } from "./copilot.js";
import type { StdioEntry } from "./entry.js";

const scratch: string[] = [];
const ENTRY: StdioEntry = { command: "xplainer", args: ["mcp", "--attach"], source: "path" };

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "xplainer-copilot-registration-"));
  scratch.push(directory);
  return directory;
}

describe("Copilot CLI registration", () => {
  it("replaces an entry when `mcp add` reports that the name already exists", () => {
    const directory = temporary();
    const program = join(directory, "copilot");
    const marker = join(directory, "registered");
    const record = join(directory, "calls");

    writeFileSync(marker, "registered\n");
    writeFileSync(
      program,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> "${record}"`,
        'if [ "$2" = "add" ]; then',
        `  if [ -s "${marker}" ]; then`,
        "    printf 'MCP server xplainer already exists\\n' >&2",
        "    exit 1",
        "  fi",
        `  printf 'registered\\n' > "${marker}"`,
        "  exit 0",
        "fi",
        'if [ "$2" = "remove" ]; then',
        `  : > "${marker}"`,
        "  exit 0",
        "fi",
        "exit 2",
        "",
      ].join("\n"),
    );
    chmodSync(program, 0o755);

    const result = registerWithCopilotCli(program, ENTRY, {});

    expect(result).toEqual({ ok: true, replaced: true });
    expect(readFileSync(record, "utf8").trim().split("\n")).toEqual([
      "mcp add xplainer -- xplainer mcp --attach",
      "mcp remove xplainer",
      "mcp add xplainer -- xplainer mcp --attach",
    ]);
    expect(readFileSync(marker, "utf8").trim()).toBe("registered");
  });

  it("reports when the replacement add fails after the old entry was removed", () => {
    const directory = temporary();
    const program = join(directory, "copilot");
    const record = join(directory, "calls");
    const removed = join(directory, "removed");

    writeFileSync(
      program,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> "${record}"`,
        'if [ "$2" = "add" ]; then',
        `  if [ ! -s "${removed}" ]; then`,
        "    printf 'MCP server xplainer already exists\\n' >&2",
        "    exit 1",
        "  fi",
        "  printf 'replacement refused\\n' >&2",
        "  exit 9",
        "fi",
        'if [ "$2" = "remove" ]; then',
        `  printf 'removed\\n' > "${removed}"`,
        "  exit 0",
        "fi",
        "exit 2",
        "",
      ].join("\n"),
    );
    chmodSync(program, 0o755);

    const result = registerWithCopilotCli(program, ENTRY, {});

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.removed).toBe(true);
      expect(result.result.status).toBe(9);
      expect(result.result.stderr).toContain("replacement refused");
    }
    expect(readFileSync(record, "utf8").trim().split("\n")).toEqual([
      "mcp add xplainer -- xplainer mcp --attach",
      "mcp remove xplainer",
      "mcp add xplainer -- xplainer mcp --attach",
    ]);
  });

  it("does not remove anything for an unrelated vendor failure", () => {
    const directory = temporary();
    const program = join(directory, "copilot");
    const record = join(directory, "calls");
    writeFileSync(
      program,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> "${record}"`,
        "printf 'configuration is invalid\\n' >&2",
        "exit 7",
        "",
      ].join("\n"),
    );
    chmodSync(program, 0o755);

    const result = registerWithCopilotCli(program, ENTRY, {});

    expect(result.ok).toBe(false);
    expect(readFileSync(record, "utf8").trim().split("\n")).toEqual([
      "mcp add xplainer -- xplainer mcp --attach",
    ]);
  });
});
