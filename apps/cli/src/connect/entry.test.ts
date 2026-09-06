/**
 * Which command line an agent is handed, decided by what is really on `PATH`.
 *
 * The branch matters more than it looks: an entry naming `xplainer` on a machine without it is a
 * configuration that spawns nothing and reports "server failed to start", and an entry naming
 * `npx -y @xplainer/cli` on a machine that *has* the binary pays a registry round trip on every
 * agent session. So the lookup is exercised against real files with real modes — an executable, a
 * file that is merely present, and a Windows-shaped `PATHEXT` — rather than against a stubbed
 * `existsSync`.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ATTACH_ARGS, CLI_PACKAGE, describeEntry, findOnPath, resolveStdioEntry } from "./entry.js";

const scratch: string[] = [];

function binDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "xplainer-path-"));
  scratch.push(directory);
  return directory;
}

/** Write `name` into `directory` with the mode a shell would need to run it. */
function executable(directory: string, name: string): string {
  const path = join(directory, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("findOnPath", () => {
  it("returns the executable it found, and null for a file it could not run", () => {
    const directory = binDirectory();
    const path = executable(directory, "xplainer");

    expect(findOnPath("xplainer", { PATH: directory }, "darwin")).toBe(path);

    chmodSync(path, 0o644);
    expect(findOnPath("xplainer", { PATH: directory }, "darwin")).toBeNull();
  });

  it("searches PATH in order and skips empty entries", () => {
    const first = binDirectory();
    const second = binDirectory();
    const path = executable(second, "xplainer");

    expect(findOnPath("xplainer", { PATH: [first, "", second].join(":") }, "darwin")).toBe(path);
  });

  /** On Windows the binary npm installs is `xplainer.cmd`, so a bare-name-only lookup finds none. */
  it("tries the PATHEXT suffixes on win32 and only the bare name elsewhere", () => {
    const directory = binDirectory();
    const path = executable(directory, "xplainer.CMD");
    const env = { PATH: directory, PATHEXT: ".COM;.EXE;.CMD" };

    expect(findOnPath("xplainer", env, "win32")).toBe(path);
    expect(findOnPath("xplainer", env, "darwin")).toBeNull();
  });
});

describe("resolveStdioEntry", () => {
  it("names the installed binary when it is on PATH", () => {
    const directory = binDirectory();
    executable(directory, "xplainer");

    const entry = resolveStdioEntry({ env: { PATH: directory }, platform: "darwin" });

    expect(entry).toEqual({ command: "xplainer", args: [...ATTACH_ARGS], source: "path" });
    expect(describeEntry(entry)).toBe("xplainer mcp --attach");
  });

  it("falls back to npx when it is not, which is the plugin bundles' own form", () => {
    const entry = resolveStdioEntry({ env: { PATH: binDirectory() }, platform: "darwin" });

    expect(entry).toEqual({
      command: "npx",
      args: ["-y", CLI_PACKAGE, ...ATTACH_ARGS],
      source: "npx",
    });
    expect(describeEntry(entry)).toBe("npx -y @xplainer/cli mcp --attach");
  });

  /** The whole point of the entry: it is a command, and there is nowhere in it for a secret. */
  it("produces an entry with no URL, no port and no token, either way", () => {
    const withBinary = binDirectory();
    executable(withBinary, "xplainer");

    for (const directory of [withBinary, binDirectory()]) {
      const line = describeEntry(
        resolveStdioEntry({ env: { PATH: directory }, platform: "linux" }),
      );

      expect(line).not.toMatch(/http/i);
      expect(line).not.toMatch(/token/i);
      expect(line).not.toMatch(/\d{4}/);
    }
  });
});
