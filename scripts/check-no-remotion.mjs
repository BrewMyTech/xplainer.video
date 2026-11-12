#!/usr/bin/env node
/**
 * The previous renderer's name stays out of the tree (ADR 0031's note of 2026-11-12, D9).
 *
 * One grep, over every file git tracks, and the same test of every tracked file's name:
 *
 *     git grep --no-color --no-column -n -i -F -e remotion
 *     git ls-files -z
 *
 * Case-insensitive and **with no word boundary**, so prose ("Rendering depends on Remotion …") is
 * caught as well as an import, and so are the spellings a `\b` lets through: a component named
 * `RemotionRoot`, a `REMOTION_TIMEOUT`, a `remotion_entry` field — `_` and a following letter are
 * word characters, so the word-bounded pattern D9 wrote saw none of them. Every hit must be admitted
 * by an entry of ALLOWLIST, or vanish once the strings in EXEMPT_STRINGS are taken out of its line
 * (or its path). Anything else is printed as `path:line`, or `path (file name)`, and the exit
 * status is 1.
 *
 * WHY. ADR 0031 replaced Remotion with a renderer this repository owns, and Phase 2 deleted the
 * last of it: the workspace payload, the template's pins, the Chrome selector that mirrored its
 * line, the sentences in `README.md`, `LICENSE` and `NOTICE`. "Nothing names it" was then a
 * sentence somebody had checked once with a grep. A sentence is true on the day it is written;
 * this file is what keeps it true.
 *
 * THE ALLOWLIST IS DATA, WRITTEN OUT IN FULL, AND EACH ENTRY IS AS TIGHT AS ITS FILE ALLOWS.
 * Records whose subject is history — the ADRs, the roadmap, the changelogs and changesets, and
 * this file, which has to name what it bans — are admitted whole, by directory or by file name.
 * **Only an entry that admits a whole file admits a file's name**: an entry scoped to lines says
 * which lines, and a name is not one of them.
 * Every other entry names one file and, where that file is otherwise live, the lines inside it: a
 * regular expression the line has to match (`text`), the Markdown heading it has to sit under
 * (`section`), or the first words of the paragraph it has to belong to (`paragraph`). A new
 * sentence naming the previous renderer in a file that already has an entry is therefore still a
 * hit, unless it is the kind of line the entry was written for.
 *
 * AN ENTRY THAT ADMITS NOTHING IS A FAILURE. It is a hole nobody is watching: the line it was
 * written for has gone, and the entry now waits to excuse whatever arrives next. Delete it. The one
 * entry allowed to be empty says why in its `mayBeEmpty` — `.changeset/`, which
 * `pnpm changeset version` empties into the changelogs.
 *
 * TWO KINDS OF STRING ARE STRIPPED BEFORE A LINE IS JUDGED, and only these: ADR 0031's own file
 * name, which contains the word and is linked from wherever that decision is cited, and this
 * checker's own name, as a file and as a root `pnpm` script, which appears wherever it is wired in.
 * Each is replaced by a space rather than by nothing, so the two halves around it cannot join into
 * a match of their own, and a line that still matches afterwards is judged like any other.
 *
 * BINARY FILES. git reports a match in a binary file but has no line to give, so such a hit is
 * admitted only by an entry with `binary: true` for that exact path, and is printed as
 * `path (binary)` otherwise. The text hits come from `git grep -I`, which skips binary files, and
 * the binary ones are the files `git grep -l` names that `-I` did not; nothing reads git's own
 * "Binary file … matches" sentence, which is translated under a non-English locale.
 *
 * FILE NAMES. `git ls-files -z` lists every tracked path, and each is judged as a line would be —
 * the exempt strings out first, then the matcher — so ADR 0031's own file and this checker pass by
 * name and a `remotion-compat.ts` does not. A tracked directory is part of every path under it.
 *
 * TRACKED FILES ONLY, AS ADR 0031'S D9 SAYS. That is what a CI checkout holds, and it keeps
 * `node_modules/`, `dist/` and anything else ignored out of the answer without a second list of
 * exclusions. The cost is that a file not yet added to git is not checked until it is; CI, which
 * checks out the commit, always sees it.
 *
 * WHY `git grep -F` AND A JAVASCRIPT REGEX BESIDE IT. The grep finds the lines; `-F -i` is a
 * fixed string matched without regard to case, which every git supports — D9's `-P` needed a git
 * built with PCRE, and a word boundary that missed the spellings above. The JavaScript `MATCHER`
 * is the same test, and it is what re-judges a line once the exempt strings are out of it.
 * `--no-color` and `--no-column` are spelled out because `color.grep` and `grep.column` in a
 * user's own git config would otherwise change the output this parses: a column is one more
 * NUL-separated field, which would land at the front of every line's text. A self-test runs the
 * grep a second time under exactly that config and requires the same hits.
 *
 * EVERY RULE CARRIES ITS OWN NEGATIVE TEST, and they run first, on every invocation, against the
 * real ALLOWLIST: a seeded hit fails, an allowlisted hit passes, the exempt file name passes and a
 * second mention on the same line does not, and each scoping field holds its line to its place.
 * The reason is `check-publish-contract.mjs`'s: a gate that cannot be shown to fire is
 * indistinguishable from one that passes vacuously. Every fixture builds the word from two halves,
 * so the samples are not hits of their own when the tree is grepped.
 *
 * Exit codes:
 *   0  every hit is admitted
 *   1  a hit outside the allowlist, an allowlist entry that admits nothing, or a self-test that
 *      failed
 *   2  the checker could not run (an argument it does not take, no workspace root, no git)
 *  70  internal error
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE_FILE = "pnpm-workspace.yaml";

/** The fixed string `git grep -F -i` looks for: every occurrence, in any case, inside any word. */
const GIT_PATTERN = "remotion";

/** The same test in JavaScript. It judges a line, or a path, after the exempt strings have left it. */
const MATCHER = /remotion/i;

/**
 * A git config that would change `git grep`'s output if the flags did not pin it: a column field,
 * and colour. The self-test runs the grep under it and requires the same hits as without it.
 */
const HOSTILE_GIT_CONFIG = {
  GIT_CONFIG_COUNT: "3",
  GIT_CONFIG_KEY_0: "grep.column",
  GIT_CONFIG_VALUE_0: "true",
  GIT_CONFIG_KEY_1: "color.grep",
  GIT_CONFIG_VALUE_1: "always",
  GIT_CONFIG_KEY_2: "color.ui",
  GIT_CONFIG_VALUE_2: "always",
};

/** The start of AC-14f's own pattern, which every description of that gate quotes. */
const AC_14F_PATTERN = /'@remotion\/\|\\bremotion\\b\|/;

/** A reported line longer than this is truncated; the location is the useful part. */
const MAX_EXCERPT = 120;

/**
 * Exact strings taken out of a line before it is judged. Case-sensitive, and only these.
 */
const EXEMPT_STRINGS = [
  {
    text: "0031-an-owned-renderer-replaces-remotion-ffmpeg-encodes",
    reason: "ADR 0031's file name, linked from wherever the decision that removed it is cited.",
  },
  {
    text: "check-no-remotion",
    reason: "This checker's file name, wherever it is wired in or described.",
  },
  {
    text: "check:no-remotion",
    reason: "The root `pnpm` script that runs this checker.",
  },
];

/**
 * Where the previous renderer's name may appear, and why. One of `path` (exact), `dir` (a prefix
 * ending in `/`) or `name` (a file name anywhere) says which files; `text`, `section` and
 * `paragraph` narrow it to lines; `binary: true` admits a binary file's match and nothing else.
 */
const ALLOWLIST = [
  // --- Records whose subject is history ------------------------------------
  {
    dir: "docs/adr/",
    reason: "Accepted decision records are immutable, and several are about the previous renderer.",
  },
  {
    path: "docs/ROADMAP.md",
    reason: "The roadmap records what was built and what it replaced.",
  },
  {
    name: "CHANGELOG.md",
    reason: "A changelog says what each release said when it shipped.",
  },
  {
    dir: ".changeset/",
    reason: "Changelog entries not yet released.",
    mayBeEmpty: "`pnpm changeset version` moves every changeset into a CHANGELOG.md.",
  },
  {
    path: "scripts/check-no-remotion.mjs",
    reason: "This checker names what it bans.",
  },

  // --- The one release of grace for videos written before (ADR 0031 Follow-up 7) ---
  {
    path: "apps/cli/src/render/bundle.ts",
    text: /^ {2}(?:remotion|"@remotion\/(?:media|captions)"): MOTION_PACKAGE,$/,
    reason: "LEGACY_IMPORT_ALIASES: the three import names an older video may use for one release.",
  },
  {
    path: "packages/skill/SKILL.md",
    paragraph: "**Videos written for the previous renderer.**",
    reason: "The migration paragraph that tells an agent what an older video meets.",
  },

  // --- Recognising what an older `setup --workspace` installed (D7) ----------
  {
    path: "apps/cli/src/setup/previous-renderer.ts",
    text: /^ {4}(?:remotion|"@remotion\/[a-z0-9-]+"): "4\.0\.495",$/,
    reason: "LAST_TEMPLATE's pins: how `setup` recognises the tree it deletes, and nothing else.",
  },
  {
    path: "apps/cli/src/setup/previous-renderer.ts",
    text: /^export const PREVIOUS_ENTRY_FIELD = "remotion_entry";$/,
    reason: "The old workspace manifest's field, spelled once; its tests read it from here.",
  },

  // --- AC-14f, which keeps the name out of apps/desktop, and what describes it ---
  {
    path: ".github/workflows/ci.yml",
    text: AC_14F_PATTERN,
    reason: "AC-14f's own grep.",
  },
  {
    path: "AGENTS.md",
    text: /`@remotion\/`, `remotion`, `@xplainer\/motion`, `kokoro`/,
    reason: "The non-negotiable that names AC-14f's pattern.",
  },
  {
    path: "apps/desktop/AGENTS.md",
    text: /`AC-14f` greps `apps\/desktop` for `@remotion\/`, `remotion`,/,
    reason: "The invariant that names AC-14f's pattern.",
  },
  {
    path: "docs/acceptance-criteria.md",
    section: "## AC-14 — The CLI is the local runtime",
    text: AC_14F_PATTERN,
    reason: "Criterion 14f and its amendment, which quote the pattern.",
  },

  // --- Criteria quoted as written, and retired by dated notes beneath them ---
  {
    path: "docs/acceptance-criteria.md",
    section: "## AC-7 — Render core and the scaffold fixtures",
    text: /^> /,
    reason: "AC-7 quoted verbatim; 7a's note of 2026-11-12 retires the half that names it.",
  },
  {
    path: "docs/acceptance-criteria.md",
    section: "## AC-7 — Render core and the scaffold fixtures",
    text: /^(?:- \*\*7a\*\* | {2}- \*Amended 2026-11-11 \(the owned renderer\):\* )/,
    reason: "Row 7a and its 2026-11-11 amendment as written; the note of 2026-11-12 retires both.",
  },
  {
    path: "docs/acceptance-criteria.md",
    section: "## AC-11 — Container images",
    text: /^> /,
    reason: "AC-11 quoted verbatim; 11a, the half that names it, relocated with media-service.",
  },

  // --- A word narration can still say --------------------------------------
  {
    path: "packages/render-core/src/g2p/data/lexicon.txt",
    text: /^remotion\s+\S/,
    reason: "A pronunciation entry: a narration about software may still say the name.",
  },
  {
    path: "packages/render-core/src/g2p/data/lexicon.txt",
    text: /^# "ONNX" and "Remotion" are all absent\./,
    reason: "The header's list of words CMUdict lacks, which is why that entry exists.",
  },

  // --- A recording, kept as it was made (its re-render is booked in docs/ROADMAP.md) ---
  {
    path: "docs/media/xplainer-intro.mp4",
    binary: true,
    reason: "The intro video, rendered by the previous renderer, whose name is in its metadata.",
  },
  {
    path: "docs/media/xplainer-intro/source.json",
    reason: "That video's source, whose on-screen copy names the previous renderer.",
  },
];

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Judging

/** Each exempt string replaced by a space, so its two neighbours cannot join into a match. */
function stripExempt(text) {
  let stripped = text;
  for (const exempt of EXEMPT_STRINGS) {
    stripped = stripped.split(exempt.text).join(" ");
  }
  return stripped;
}

/** The nearest Markdown heading at or above `line` (1-based), or `null` when there is none. */
function sectionOf(lines, line) {
  for (let index = line - 1; index >= 0; index -= 1) {
    if (/^#{1,6} /.test(lines[index] ?? "")) {
      return lines[index];
    }
  }
  return null;
}

/** The first line of the paragraph — the run of non-blank lines — that `line` (1-based) is in. */
function paragraphLeadOf(lines, line) {
  let index = line - 1;
  while (index > 0 && (lines[index - 1] ?? "").trim() !== "") {
    index -= 1;
  }
  return lines[index] ?? "";
}

/** Whether `entry` admits `hit`. `readLines` returns a file's lines, for the scoping fields. */
function entryAdmits(entry, hit, readLines) {
  if (entry.path !== undefined && hit.path !== entry.path) {
    return false;
  }
  if (entry.dir !== undefined && !hit.path.startsWith(entry.dir)) {
    return false;
  }
  if (entry.name !== undefined && basename(hit.path) !== entry.name) {
    return false;
  }
  if (hit.fileName === true) {
    return (
      entry.text === undefined &&
      entry.section === undefined &&
      entry.paragraph === undefined &&
      entry.binary !== true
    );
  }
  if (hit.binary || entry.binary === true) {
    return hit.binary === true && entry.binary === true;
  }
  if (entry.text !== undefined && !entry.text.test(hit.text)) {
    return false;
  }
  if (entry.section !== undefined && sectionOf(readLines(hit.path), hit.line) !== entry.section) {
    return false;
  }
  if (
    entry.paragraph !== undefined &&
    !paragraphLeadOf(readLines(hit.path), hit.line).startsWith(entry.paragraph)
  ) {
    return false;
  }
  return true;
}

/**
 * The verdict on one hit — a line, a binary file, or a file name, whose `text` is its path:
 * `exempt` when nothing matches once the exempt strings are out,
 * `admitted` when an entry admits it (and which ones did), `violation` otherwise. A line that
 * never matched at all is `no-match`, which the grep never produces and the self-tests do.
 */
function judgeHit(hit, allowlist, readLines) {
  if (!hit.binary) {
    if (!MATCHER.test(hit.text)) {
      return { verdict: "no-match", entries: [] };
    }
    if (!MATCHER.test(stripExempt(hit.text))) {
      return { verdict: "exempt", entries: [] };
    }
  }
  const entries = [];
  for (const [index, entry] of allowlist.entries()) {
    if (entryAdmits(entry, hit, readLines)) {
      entries.push(index);
    }
  }
  return { verdict: entries.length > 0 ? "admitted" : "violation", entries };
}

/** Every hit judged, and every entry that admitted nothing and is not allowed to be empty. */
function judge(hits, allowlist, readLines) {
  const used = new Set();
  const violations = [];
  let admitted = 0;
  let exempt = 0;
  for (const hit of hits) {
    const { verdict, entries } = judgeHit(hit, allowlist, readLines);
    if (verdict === "violation") {
      violations.push(hit);
    } else if (verdict === "admitted") {
      admitted += 1;
      for (const index of entries) {
        used.add(index);
      }
    } else if (verdict === "exempt") {
      exempt += 1;
    }
  }
  const unused = allowlist.filter(
    (entry, index) => !used.has(index) && entry.mayBeEmpty === undefined,
  );
  return { violations, unused, admitted, exempt };
}

/** What an entry covers, as one phrase for a diagnostic. */
function describeEntry(entry) {
  const where = entry.path ?? entry.dir ?? `every ${entry.name}`;
  const scope = [
    entry.section === undefined ? null : `under "${entry.section}"`,
    entry.paragraph === undefined ? null : `in the paragraph "${entry.paragraph}"`,
    entry.text === undefined ? null : `lines matching ${String(entry.text)}`,
    entry.binary === true ? "(binary)" : null,
  ].filter((part) => part !== null);
  return scope.length === 0 ? where : `${where}, ${scope.join(", ")}`;
}

/** Shape problems in the allowlist itself. A malformed entry is a failed self-test. */
function validateAllowlist(allowlist) {
  const problems = [];
  for (const [index, entry] of allowlist.entries()) {
    const selectors = ["path", "dir", "name"].filter((key) => entry[key] !== undefined);
    if (selectors.length !== 1) {
      problems.push(`allowlist entry ${index} names ${selectors.length} of path, dir and name.`);
    }
    if (entry.dir !== undefined && !entry.dir.endsWith("/")) {
      problems.push(`allowlist entry ${index}'s dir "${entry.dir}" does not end in "/".`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      problems.push(`allowlist entry ${index} (${describeEntry(entry)}) has no reason.`);
    }
    if (entry.binary === true && entry.path === undefined) {
      problems.push(`allowlist entry ${index} is binary and names no exact path.`);
    }
    if (entry.text?.flags.includes("g")) {
      problems.push(`allowlist entry ${index}'s text pattern is global, so it keeps state.`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Self-tests

/** The word, from two halves, so no sample here is a hit of its own. */
const WORD = ["re", "motion"].join("");
const CAPITALISED = `R${WORD.slice(1)}`;
const ADR_0031_FILE = `0031-an-owned-renderer-replaces-${WORD}-ffmpeg-encodes.md`;

const CRITERIA_FILE = [
  "## AC-7 — Render core and the scaffold fixtures",
  "",
  `> contains the ${CAPITALISED} workspace template`,
  "",
  "## AC-8 — RELOCATED",
  "",
  `> contains the ${CAPITALISED} workspace template`,
];

const SKILL_FILE = [
  "**Videos written for the previous renderer.** Imports from",
  `\`${WORD}\` still compile for one more release.`,
  "",
  `A later paragraph that names \`${WORD}\` again.`,
];

const SAMPLE_FILES = {
  "docs/acceptance-criteria.md": CRITERIA_FILE,
  "packages/skill/SKILL.md": SKILL_FILE,
};

/** `{ name, hit, expect }`, judged against the real ALLOWLIST. */
const SELF_TESTS = [
  {
    name: "a bare import in live source is a hit",
    hit: { path: "apps/cli/src/render/example.ts", line: 3, text: `import "${WORD}";` },
    expect: "violation",
  },
  {
    name: "a scoped package is a hit",
    hit: {
      path: "packages/motion/src/example.ts",
      line: 1,
      text: `import { Audio } from "@${WORD}/media";`,
    },
    expect: "violation",
  },
  {
    name: "prose is a hit in any case",
    hit: { path: "NOTICE", line: 18, text: `Rendering depends on ${CAPITALISED}.` },
    expect: "violation",
  },
  {
    name: "the word inside another word is not a hit",
    hit: { path: "README.md", line: 1, text: "@xplainer/motion, a promotional emotion" },
    expect: "no-match",
  },
  {
    name: "a component name that starts with it is a hit",
    hit: {
      path: "apps/cli/src/render/example.tsx",
      line: 1,
      text: `export const ${CAPITALISED}Root = () => null;`,
    },
    expect: "violation",
  },
  {
    name: "an upper-case constant is a hit",
    hit: {
      path: "apps/cli/src/render/example.ts",
      line: 1,
      text: `const ${WORD.toUpperCase()}_TIMEOUT_MS = 30_000;`,
    },
    expect: "violation",
  },
  {
    name: "a snake-case field is a hit",
    hit: { path: "apps/cli/src/setup/example.ts", line: 1, text: `{ ${WORD}_entry: "cli.js" }` },
    expect: "violation",
  },
  {
    name: "previous-renderer.ts's one spelling of the old manifest's field is admitted",
    hit: {
      path: "apps/cli/src/setup/previous-renderer.ts",
      line: 49,
      text: `export const PREVIOUS_ENTRY_FIELD = "${WORD}_entry";`,
    },
    expect: "admitted",
  },
  {
    name: "and any other line of that file naming the field is not",
    hit: {
      path: "apps/cli/src/setup/previous-renderer.ts",
      line: 102,
      text: `    typeof manifest.${WORD}_entry !== "string" ||`,
    },
    expect: "violation",
  },
  {
    name: "a tracked file whose name carries it is a hit",
    hit: {
      path: `apps/cli/src/render/${WORD}-compat.ts`,
      fileName: true,
      text: `apps/cli/src/render/${WORD}-compat.ts`,
    },
    expect: "violation",
  },
  {
    name: "ADR 0031's own file, by name, is exempt",
    hit: { path: `docs/adr/${ADR_0031_FILE}`, fileName: true, text: `docs/adr/${ADR_0031_FILE}` },
    expect: "exempt",
  },
  {
    name: "a file named for it inside a record of history is admitted",
    hit: {
      path: `docs/adr/0040-after-${WORD}.md`,
      fileName: true,
      text: `docs/adr/0040-after-${WORD}.md`,
    },
    expect: "admitted",
  },
  {
    name: "and an entry scoped to lines admits no file name",
    hit: {
      path: `docs/acceptance-criteria-${WORD}.md`,
      fileName: true,
      text: `docs/acceptance-criteria-${WORD}.md`,
    },
    expect: "violation",
  },
  {
    name: "the alias table in bundle.ts is admitted",
    hit: { path: "apps/cli/src/render/bundle.ts", line: 85, text: `  ${WORD}: MOTION_PACKAGE,` },
    expect: "admitted",
  },
  {
    name: "any other line of bundle.ts is not",
    hit: { path: "apps/cli/src/render/bundle.ts", line: 3, text: `import "@${WORD}/media";` },
    expect: "violation",
  },
  {
    name: "ADR 0031's file name is exempt",
    hit: { path: "README.md", line: 419, text: `([ADR 0031](docs/adr/${ADR_0031_FILE})).` },
    expect: "exempt",
  },
  {
    name: "but only the file name: a second mention on its line is a hit",
    hit: {
      path: "README.md",
      line: 419,
      text: `([ADR 0031](docs/adr/${ADR_0031_FILE})) replaced ${CAPITALISED}.`,
    },
    expect: "violation",
  },
  {
    name: "this checker's own names are exempt",
    hit: {
      path: "package.json",
      line: 20,
      text: `"check:no-${WORD}": "node scripts/check-no-${WORD}.mjs",`,
    },
    expect: "exempt",
  },
  {
    name: "a quoted criterion is admitted under its own heading",
    hit: { path: "docs/acceptance-criteria.md", line: 3, text: CRITERIA_FILE[2] },
    expect: "admitted",
  },
  {
    name: "and the same line under another heading is not",
    hit: { path: "docs/acceptance-criteria.md", line: 7, text: CRITERIA_FILE[6] },
    expect: "violation",
  },
  {
    name: "the migration paragraph is admitted",
    hit: { path: "packages/skill/SKILL.md", line: 2, text: SKILL_FILE[1] },
    expect: "admitted",
  },
  {
    name: "and a paragraph after it is not",
    hit: { path: "packages/skill/SKILL.md", line: 4, text: SKILL_FILE[3] },
    expect: "violation",
  },
  {
    name: "a binary file is admitted by its own binary entry",
    hit: { path: "docs/media/xplainer-intro.mp4", binary: true },
    expect: "admitted",
  },
  {
    name: "and no other binary file is",
    hit: { path: "docs/media/another.mp4", binary: true },
    expect: "violation",
  },
  {
    name: "a directory entry admits files inside it",
    hit: { path: "docs/adr/0005-example.md", line: 9, text: `the ${CAPITALISED} workspace` },
    expect: "admitted",
  },
  {
    name: "and not a sibling whose name merely starts the same way",
    hit: { path: "docs/adr-drafts/example.md", line: 9, text: `the ${CAPITALISED} workspace` },
    expect: "violation",
  },
  {
    name: "a file-name entry admits that name in any directory",
    hit: { path: "packages/example/CHANGELOG.md", line: 4, text: `drops ${CAPITALISED}` },
    expect: "admitted",
  },
  {
    name: "and not a different name",
    hit: { path: "packages/example/CHANGELOG.txt", line: 4, text: `drops ${CAPITALISED}` },
    expect: "violation",
  },
];

/** The two halves of the stale-entry rule, against a one-entry allowlist and no hits at all. */
const STALE_TESTS = [
  {
    name: "an entry that admits nothing is reported",
    allowlist: [{ path: "docs/example.md", reason: "for the self-test" }],
    unused: 1,
  },
  {
    name: "unless it says why it may be empty",
    allowlist: [{ dir: ".changeset/", reason: "for the self-test", mayBeEmpty: "it may" }],
    unused: 0,
  },
];

function runSelfTests() {
  const problems = validateAllowlist(ALLOWLIST);
  const readSample = (path) => SAMPLE_FILES[path] ?? [];
  for (const test of SELF_TESTS) {
    const { verdict } = judgeHit(test.hit, ALLOWLIST, readSample);
    if (verdict !== test.expect) {
      problems.push(`${test.name}: expected ${test.expect}, judged ${verdict}.`);
    }
  }
  for (const test of STALE_TESTS) {
    const { unused } = judge([], test.allowlist, readSample);
    if (unused.length !== test.unused) {
      problems.push(`${test.name}: expected ${test.unused} unused, found ${unused.length}.`);
    }
  }
  return { problems, cases: SELF_TESTS.length + STALE_TESTS.length };
}

// ---------------------------------------------------------------------------
// The tree

/** Walk up for `pnpm-workspace.yaml`, from the working directory and then from this file. */
function findWorkspaceRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const start of [process.cwd(), resolve(here, "..")]) {
    let dir = resolve(start);
    for (;;) {
      if (existsSync(join(dir, WORKSPACE_FILE))) {
        return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  return null;
}

/** One `git grep` over the tracked files, `C` locale. Exit 1 is "no match", not a failure. */
function gitGrep(root, flags, env = {}) {
  return runGit(root, ["grep", "--no-color", "--no-column", ...flags, "-e", GIT_PATTERN], env);
}

/** `git <args>` in `root`, `C` locale, `env` over this process's. Exit 1 answers `""`. */
function runGit(root, args, env = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...env, LC_ALL: "C" },
  });
  if (result.error !== undefined) {
    throw new UsageError(`git could not be run: ${result.error.message}`);
  }
  if (result.status === 1) {
    return "";
  }
  if (result.status !== 0) {
    throw new UsageError(
      `git ${args.join(" ")} exited ${String(result.status)}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

/**
 * Every hit in the tracked tree: `{ path, line, text }`, `{ path, binary: true }`, or
 * `{ path, fileName: true, text: path }` for a tracked path that carries the word.
 */
function collectHits(root, env = {}) {
  const hits = [];
  const textFiles = new Set();
  for (const record of gitGrep(root, ["-z", "-n", "-i", "-I", "-F"], env).split("\n")) {
    if (record === "") {
      continue;
    }
    const [path, line, ...rest] = record.split("\0");
    textFiles.add(path);
    hits.push({ path, line: Number(line), text: rest.join("\0").replace(/\r$/, "") });
  }
  for (const path of gitGrep(root, ["-z", "-l", "-i", "-F"], env).split("\0")) {
    if (path !== "" && !textFiles.has(path)) {
      hits.push({ path, binary: true });
    }
  }
  for (const path of runGit(root, ["ls-files", "-z"], env).split("\0")) {
    if (path !== "" && MATCHER.test(path)) {
      hits.push({ path, fileName: true, text: path });
    }
  }
  return hits;
}

function excerpt(text) {
  const trimmed = text.trim();
  return trimmed.length > MAX_EXCERPT ? `${trimmed.slice(0, MAX_EXCERPT - 1)}…` : trimmed;
}

function main(argv) {
  if (argv.length > 0) {
    throw new UsageError(
      `unexpected argument(s): ${argv.join(" ")}. This checker takes none; it greps every ` +
        "tracked file and judges each hit against its allowlist.",
    );
  }

  const selfTest = runSelfTests();
  if (selfTest.problems.length > 0) {
    process.stderr.write(
      "check-no-remotion: the gate failed its own tests, so it was not run against the tree.\n",
    );
    for (const problem of selfTest.problems) {
      process.stderr.write(`  x ${problem}\n`);
    }
    return 1;
  }
  process.stdout.write(
    `check-no-remotion: ${String(selfTest.cases)} self-test case(s) passed against the real ` +
      "allowlist: a seeded hit fails, an allowlisted hit passes, the exempt names pass, and " +
      "each scoping field holds its line to its place.\n",
  );

  const root = findWorkspaceRoot();
  if (root === null) {
    throw new UsageError(`no ${WORKSPACE_FILE} found above the working directory.`);
  }
  const cache = new Map();
  const readLines = (path) => {
    if (!cache.has(path)) {
      cache.set(path, readFileSync(join(root, path), "utf8").split(/\r?\n/));
    }
    return cache.get(path);
  };

  const hits = collectHits(root);
  // The same grep under a git config that would add a column and colour if the flags did not pin
  // them: a parse that depended on the user's config would judge a different set of lines.
  if (JSON.stringify(collectHits(root, HOSTILE_GIT_CONFIG)) !== JSON.stringify(hits)) {
    process.stderr.write(
      "check-no-remotion: the grep answered differently under grep.column=true and " +
        "color.grep=always, so its output depends on the git config and was not judged.\n",
    );
    return 1;
  }
  const { violations, unused, admitted, exempt } = judge(hits, ALLOWLIST, readLines);

  for (const hit of violations) {
    process.stdout.write(
      hit.binary
        ? `check-no-remotion: ${hit.path} (binary)\n`
        : hit.fileName
          ? `check-no-remotion: ${hit.path} (file name)\n`
          : `check-no-remotion: ${hit.path}:${String(hit.line)}: ${excerpt(hit.text)}\n`,
    );
  }
  for (const entry of unused) {
    process.stdout.write(
      `check-no-remotion: allowlist entry for ${describeEntry(entry)} admits nothing ` +
        `("${entry.reason}"). Delete it.\n`,
    );
  }

  const files = new Set(hits.map((hit) => hit.path)).size;
  if (violations.length > 0 || unused.length > 0) {
    process.stderr.write(
      `\ncheck-no-remotion: ${String(violations.length)} hit(s) outside the allowlist and ` +
        `${String(unused.length)} allowlist entry(ies) admitting nothing. ADR 0031 removed the ` +
        "previous renderer from this repository, and this gate keeps its name out: reword the " +
        "line, or — only when it is history, a gate, or the one release of grace — add the " +
        "narrowest entry that admits it, with its reason.\n",
    );
    return 1;
  }

  process.stdout.write(
    `check-no-remotion: ${String(hits.length)} hit(s) in ${String(files)} tracked file(s): ` +
      `${String(admitted)} admitted by ${String(ALLOWLIST.length)} allowlist entries, ` +
      `${String(exempt)} exempt by name; none outside the allowlist.\n`,
  );
  return 0;
}

let exitCode;
try {
  exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`check-no-remotion: ${error.message}\n`);
    exitCode = 2;
  } else {
    process.stderr.write(
      `check-no-remotion: internal error\n${error instanceof Error ? error.stack : String(error)}\n`,
    );
    exitCode = 70;
  }
}
process.exitCode = exitCode;
