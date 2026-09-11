/**
 * The other half of what `connect` writes: the skill an agent reads before it drives the tools.
 *
 * **`connect` used to write the transport and not the method, and nothing said so.** The command
 * exists to make an agent able to do this, and it delivered one stdio entry — eight tools with no
 * instructions for composing a scene, pacing a narration, or the one rule that matters (every scene
 * length comes from measured word timestamps, never from a guess). An agent given the tools alone
 * improvises all of it, and the result looks like it. The gap was documented in `README.md` twice
 * before it was closed here, which was the wrong order: it cost 11 KB and one dependency to remove.
 *
 * **Both clients read `<home>/skills/<name>/SKILL.md`**, so one writer serves both and the only
 * difference is which home — verified against real installations of each: `~/.claude/skills/` and
 * `~/.codex/skills/`, each holding one directory per skill with `SKILL.md` inside it. That is the
 * same layout `packages/skill/scripts/build.mjs` emits into both plugin bundles, which is why its
 * docblock can say "both clients discover skills at `skills/<name>/SKILL.md`" as one sentence.
 *
 * **The file is read out of `@xplainer/skill` rather than copied into this package.** There is one
 * reviewed `SKILL.md` and `packages/skill/src/build.test.ts` compares it byte-for-byte against both
 * bundles; a second copy inside `apps/cli` would be a third thing to keep in step and the first to
 * go stale. The dependency is data only — no code, no dependencies of its own, 11 KB over 12 files —
 * which is what makes it acceptable in payload 1's closure at all (root `AGENTS.md`: a new runtime
 * dependency here is a change to payload 1, the publish contract and every installer).
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { PRECONDITION_UNMET_EXIT_CODE } from "../daemon/exit-codes.js";
import { writeFileAtomically } from "./atomic-write.js";
import { ConnectRefusal } from "./refusal.js";

/** The skill's directory name, which is the name an agent addresses it by. */
export const SKILL_NAME = "xplainer";

/** The file both clients look for inside that directory. */
export const SKILL_FILE = "SKILL.md";

/** Which agent's home the skill is written under. */
export type SkillClient = "claude" | "codex";

/** The directory each client keeps user-level skills in, relative to `home`. */
const CLIENT_ROOT: Readonly<Record<SkillClient, string>> = {
  claude: ".claude",
  codex: ".codex",
};

/** Where {@link installSkill} will write, so a caller can report the path it wrote. */
export function skillPath(client: SkillClient, home: string = homedir()): string {
  return join(home, CLIENT_ROOT[client], "skills", SKILL_NAME, SKILL_FILE);
}

/**
 * The reviewed `SKILL.md`, out of the installed `@xplainer/skill`.
 *
 * `@xplainer/skill` declares no `exports` map, so the subpath resolves directly; it is a
 * data-only package and this is the one file read from it. A refusal rather than a guess if it is
 * absent: an installation that cannot find its own skill should say so, not write nothing and
 * report success.
 *
 * **The refusal branch is deliberately untested, and the reason is worth knowing before anyone
 * tries.** It takes no `from` seam: one was written and removed, because vitest's resolver
 * intercepts `createRequire` and answers with the workspace path whatever module the caller claims
 * to be resolving from — measured, it returned `packages/skill/SKILL.md` for a `createRequire`
 * rooted in an empty temp directory. So a seam here would be a parameter that is dead in production
 * and does not work in the suite either, which is worse than none. The branch is reachable on a
 * real machine — a partial `npm i -g`, a pruned `node_modules` — and `scripts/e2e/` is where a case
 * for it belongs.
 */
export function readSkill(): string {
  const require = createRequire(import.meta.url);
  let resolved: string;
  try {
    resolved = require.resolve(`@xplainer/skill/${SKILL_FILE}`);
  } catch {
    throw new ConnectRefusal(
      PRECONDITION_UNMET_EXIT_CODE,
      `the installed \`@xplainer/skill\` does not carry ${SKILL_FILE}, so there is no skill to ` +
        "write. Reinstall with `npm i -g xplainer`, which depends on it.",
    );
  }
  if (!existsSync(resolved)) {
    throw new ConnectRefusal(
      PRECONDITION_UNMET_EXIT_CODE,
      `\`@xplainer/skill\` resolves ${SKILL_FILE} to ${resolved}, and there is no file there.`,
    );
  }
  return readFileSync(resolved, "utf8");
}

/** What one {@link installSkill} did, so the command can say it in one line. */
export type SkillInstall = {
  /** Where it was written. */
  path: string;
  /** Whether the bytes changed — `false` when the file was already this version. */
  updated: boolean;
};

/**
 * Write the skill into `client`'s home, replacing whatever version was there.
 *
 * **Re-running `connect` is the update path**, which is the reason this overwrites rather than
 * refusing an existing file: after `npm i -g xplainer@latest`, one `xplainer connect claude`
 * refreshes both halves — the MCP entry and the instructions — and a user who has upgraded should
 * not have to know that the skill is a separate artefact. `updated` distinguishes a refresh from a
 * no-op so the command can say which, rather than claiming to have changed something it did not.
 *
 * The write goes through `atomic-write.ts` for the same reason every other write in this directory
 * does: it is somebody else's directory, and a half-written `SKILL.md` is an agent reading half an
 * instruction.
 */
export function installSkill(client: SkillClient, home: string = homedir()): SkillInstall {
  const path = skillPath(client, home);
  const text = readSkill();
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (before === text) {
    return { path, updated: false };
  }
  writeFileAtomically(path, text);
  return { path, updated: true };
}
