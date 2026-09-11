/**
 * The skill `connect` writes beside the MCP entry.
 *
 * **Asserted against the reviewed file rather than against a fixture**, because the whole value of
 * reading it out of `@xplainer/skill` is that there is one copy: a test with its own expected text
 * would pass while the shipped instructions drifted. `packages/skill/src/build.test.ts` compares
 * that same file against both plugin bundles, so this suite and that one pin the same bytes from
 * two directions.
 *
 * The re-run case is the one that matters in practice. `connect` is documented as re-runnable —
 * after an upgrade a user runs it again — and the point of writing the skill here is that one
 * command refreshes both halves. So a stale file must be replaced, and an identical one must be
 * reported as already current rather than rewritten, because "wrote" about a no-op is the kind of
 * sentence that makes a reader doubt the rest of the output.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { installSkill, readSkill, SKILL_FILE, SKILL_NAME, skillPath } from "./skill.js";

/** The one reviewed copy, read straight off the workspace rather than through the package. */
const REVIEWED = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
    "packages",
    "skill",
    SKILL_FILE,
  ),
  "utf8",
);

const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function home(): string {
  const directory = mkdtempSync(join(tmpdir(), "xplainer-skill-home-"));
  scratch.push(directory);
  return directory;
}

describe("the skill connect installs", () => {
  it("reads the one reviewed SKILL.md out of @xplainer/skill", () => {
    // Not "looks like a skill" — the same bytes the workspace holds and the bundles ship.
    expect(readSkill()).toBe(REVIEWED);
  });

  it.each([
    ["claude", ".claude"],
    ["codex", ".codex"],
  ] as const)("writes %s's skill at <home>/%s/skills/xplainer/SKILL.md", (client, root) => {
    const where = home();

    const installed = installSkill(client, where);

    expect(installed.path).toBe(join(where, root, "skills", SKILL_NAME, SKILL_FILE));
    expect(installed.updated).toBe(true);
    expect(readFileSync(installed.path, "utf8")).toBe(REVIEWED);
  });

  it("replaces a stale skill, which is what re-running connect after an upgrade is for", () => {
    const where = home();
    const path = skillPath("claude", where);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "# an older version of the instructions\n");

    const installed = installSkill("claude", where);

    expect(installed.updated).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(REVIEWED);
  });

  it("reports an identical skill as already current rather than claiming a write", () => {
    const where = home();

    expect(installSkill("claude", where).updated).toBe(true);
    // Second run, same bytes: the command should say "already current", not "wrote".
    expect(installSkill("claude", where).updated).toBe(false);
    expect(readFileSync(skillPath("claude", where), "utf8")).toBe(REVIEWED);
  });

  it("creates the directories it needs and touches nothing else in the home", () => {
    const where = home();
    writeFileSync(join(where, "untouched"), "mine\n");

    installSkill("codex", where);

    expect(existsSync(join(where, ".codex", "skills", SKILL_NAME))).toBe(true);
    expect(readFileSync(join(where, "untouched"), "utf8")).toBe("mine\n");
    // The other agent's tree is not created by installing for one of them.
    expect(existsSync(join(where, ".claude"))).toBe(false);
  });
});
