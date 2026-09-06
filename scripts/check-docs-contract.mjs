#!/usr/bin/env node
/**
 * Documentation contract checker (plan T15; acceptance criteria AC-18a … AC-18c
 * and AC-19a … AC-19c).
 *
 * One script, three checks, over the two documents an agent reads before it
 * touches anything:
 *
 *   1. `members` — the `CHECKED:members` table in `docs/ARCHITECTURE.md` equals
 *      the workspace roster: path, package name, tier, published,
 *      emits-declarations, has-an-API-report and the `AGENTS.md` link target.
 *   2. `deps` — the `CHECKED:deps` table equals the declared workspace
 *      dependency graph, and the banned-specifier list beneath it equals the
 *      specifiers `biome.json` bans, so the document and the linter cannot
 *      disagree.
 *   3. `agents` — the agent instruction surface is complete: an `AGENTS.md`
 *      carrying the five required headings beside every member, the canonical
 *      post-change procedure in the root `AGENTS.md`, and the ten `CLAUDE.md`
 *      stubs (root plus nine members) that Claude Code reads because it never
 *      reads `AGENTS.md` at all (plan §11).
 *
 * WHY A DIAGNOSTIC PREFIX AND NOT THREE EXIT CODES. AC-18c and AC-19c both
 * require exit **1** for a contract violation, so overloading the exit status to
 * say which check failed would break them. Every failure line instead opens with
 * `docs-contract: members:`, `docs-contract: deps:` or `docs-contract: agents:`,
 * which is what a red CI step needs in order to name the failure. `2` and `70`
 * keep the meanings the rest of this repository gives them, and neither is a
 * contract violation: a crash can therefore never be mistaken for a detection.
 *
 * Exit codes:
 *   0  the documents match the workspace
 *   1  a contract violation — the document and the workspace disagree, or a
 *      required instruction file is missing, oversized or missing its import
 *   2  a usage error: an argument this script does not take, no workspace root,
 *      a manifest or configuration file that cannot be read, or an input written
 *      in a form this reader deliberately does not implement (each such case
 *      names itself rather than degrading into a thinner check)
 *  70  an internal error — an unexpected throw, reported with its stack
 *
 * IT NEEDS NO BUILD. This script reads `pnpm-workspace.yaml`, the member
 * `package.json` files, `scripts/check-publish-contract.mjs`, `biome.json` and
 * Markdown. Nothing here looks at `dist/`, so the gate can sit anywhere in a CI
 * job and runs in milliseconds on a cold checkout.
 *
 * WHAT IS DELIBERATELY NOT CHECKED (plan T15). Whether any prose is accurate,
 * whether an `AGENTS.md` was updated alongside a source change, and how long
 * anything is. Those are review's job, not a gate's, and pretending otherwise
 * would make this script fail on edits it cannot actually judge.
 *
 * THIS IS AN EQUALITY CHECK, NOT A BOUNDARY CHECK. It proves the document
 * matches the graph; it does not prove the graph is allowed. `pnpm lint:tiers`
 * and Biome's `noRestrictedImports` decide what is permitted, and
 * `packages/config/bin/check-tiers.mjs` reads the same four dependency fields
 * this script does (AC-18d) so a forbidden edge cannot hide in a kind only one
 * of them looks at.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE_FILE = "pnpm-workspace.yaml";
const ARCHITECTURE_DOC = "docs/ARCHITECTURE.md";
const PUBLISH_CONTRACT = "scripts/check-publish-contract.mjs";
const BIOME_CONFIG = "biome.json";

const AGENTS_FILE = "AGENTS.md";
const CLAUDE_FILE = "CLAUDE.md";

/** The import line every `CLAUDE.md` carries, resolved relative to its own directory (plan §11). */
const CLAUDE_IMPORT_LINE = "@AGENTS.md";

/** A stub with more than this in it has stopped being a stub and can drift. */
const CLAUDE_MAX_LINES = 3;

/** The section every other instruction file points at instead of restating it (T14). */
const POST_CHANGE_HEADING = "## The canonical post-change procedure";

/** The fixed heading set that makes a member `AGENTS.md` checkable (T14, AC-19a). */
const REQUIRED_MEMBER_HEADINGS = [
  "## What this package is",
  "## Public surface",
  "## Commands",
  "## Invariants",
  "## How to add",
];

/**
 * The four dependency kinds a workspace edge can be declared in. `check-tiers.mjs`
 * reads exactly these four as well, which is the point: an edge cannot hide in a
 * kind only one of the two checkers looks at (AC-18d).
 */
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

const WORKSPACE_SPECIFIER = "workspace:";

/**
 * The one excluded edge, by rule. Every member takes the tsconfig presets from
 * `@xplainer/config` as a devDependency, so those edges carry no architectural
 * information and documenting them would make a routine tooling change force a
 * documentation edit. Stated in the `CHECKED:deps` fence too, so a reader of the
 * document learns it without reading this file.
 */
const PRESET_PACKAGE = "@xplainer/config";

/** Header cells of the `CHECKED:members` table, lower-cased. Prose columns are absent on purpose. */
const MEMBER_COLUMNS = {
  path: "path",
  name: "package",
  tier: "tier",
  published: "published",
  declarations: "declarations",
  report: "api report",
  agents: "agents.md",
};

/** Header cells of the `CHECKED:deps` table, lower-cased. The row form is pinned by T13. */
const DEPS_COLUMNS = { from: "from", to: "to", kind: "kind" };

/** Raised for anything that is not a contract violation but stops the checker running: exit 2. */
class UsageError extends Error {}

/**
 * Locate the workspace root by walking up for `pnpm-workspace.yaml`, first from
 * the working directory (the `pnpm check:docs-contract` case) and then from this
 * file's own location (a direct `node scripts/check-docs-contract.mjs` from
 * anywhere). Same shape as `check-publish-contract.mjs` and `check-tiers.mjs`.
 */
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

function unquote(value) {
  const trimmed = value.trim();
  const quote = trimmed.slice(0, 1);
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote) && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Read `pnpm-workspace.yaml`'s `packages:` list without a YAML parser.
 *
 * The workspace has no YAML dependency and this script is a gate, so it reads
 * the one block it needs: the top-level `packages:` key and the indented `- `
 * items under it, skipping blank and comment lines, stopping at the next
 * top-level key. Anything else in the file — the catalog, the install settings,
 * the normative script rule — is none of this checker's business.
 */
function readWorkspaceGlobs(root) {
  const text = readFileSync(join(root, WORKSPACE_FILE), "utf8");
  const globs = [];
  let inPackages = false;
  for (const line of text.split("\n")) {
    if (/^packages:\s*(#.*)?$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) {
      continue;
    }
    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (item === null) {
      break;
    }
    globs.push(unquote(item[1]));
  }
  if (globs.length === 0) {
    throw new UsageError(
      `${WORKSPACE_FILE} declares no "packages:" globs, so there is no roster to check.`,
    );
  }
  return globs;
}

/**
 * Expand one workspace glob to member directories.
 *
 * `<dir>/*` and a literal path are the two forms this workspace uses, and they
 * are the two forms implemented. Any other pattern — a `**`, a negation, a
 * partial segment — exits 2 by name rather than quietly matching nothing, which
 * would silently shrink the roster this whole check is comparing against.
 */
function expandGlob(root, glob) {
  if (!glob.includes("*")) {
    return existsSync(join(root, glob, "package.json")) ? [glob] : [];
  }
  const simple = /^([^*!]+)\/\*$/.exec(glob);
  if (simple === null) {
    throw new UsageError(
      `${WORKSPACE_FILE} declares the glob "${glob}", which this checker does not implement. ` +
        'It expands "<dir>/*" and literal paths only; extend expandGlob() rather than leaving ' +
        "members unchecked.",
    );
  }
  const dir = simple[1];
  const absolute = join(root, dir);
  if (!existsSync(absolute)) {
    return [];
  }
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${dir}/${entry.name}`)
    .filter((path) => existsSync(join(root, path, "package.json")))
    .sort();
}

function readJson(root, relativePath) {
  const absolute = join(root, relativePath);
  let text;
  try {
    text = readFileSync(absolute, "utf8");
  } catch (error) {
    throw new UsageError(
      `${relativePath} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(
      `${relativePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The workspace roster, as it is on disk. */
function readMembers(root) {
  const paths = new Set();
  for (const glob of readWorkspaceGlobs(root)) {
    for (const path of expandGlob(root, glob)) {
      paths.add(path);
    }
  }
  return [...paths].sort().map((path) => {
    const manifest = readJson(root, `${path}/package.json`);
    const scripts = manifest.scripts ?? {};
    const xplainer = manifest.xplainer ?? {};
    return {
      path,
      name: typeof manifest.name === "string" ? manifest.name : "",
      tier: typeof xplainer.tier === "string" ? xplainer.tier : null,
      hasBuildScript: typeof scripts.build === "string",
      hasBuildConfig: existsSync(join(root, path, "tsconfig.build.json")),
      manifest,
    };
  });
}

/**
 * Read `check-publish-contract.mjs`'s two declared lists.
 *
 * They are the repository's answer to "is this member published?" — declared
 * rather than discovered, precisely so a member that silently lost `private:
 * true` is caught instead of absorbed. Reading them here rather than re-deriving
 * publication from `private` keeps one answer in the repository: if the two
 * lists and the document disagree, that is the drift this gate exists to find.
 * They are not exported, so they are parsed out of the source text; a change to
 * their shape exits 2 by name instead of producing an empty roster.
 */
function readDeclaredRosters(root) {
  const absolute = join(root, PUBLISH_CONTRACT);
  let text;
  try {
    text = readFileSync(absolute, "utf8");
  } catch (error) {
    throw new UsageError(
      `${PUBLISH_CONTRACT} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const read = (listName) => {
    const declaration = new RegExp(`const ${listName} = \\[([\\s\\S]*?)\\n\\];`).exec(text);
    if (declaration === null) {
      throw new UsageError(
        `${PUBLISH_CONTRACT} no longer declares ${listName} in the form this checker parses ` +
          "(`const NAME = [ … ];` with one `{ dir, name }` object per line). Update " +
          "readDeclaredRosters() together with it.",
      );
    }
    const entries = [
      ...declaration[1].matchAll(/\{\s*dir:\s*"([^"]+)",\s*name:\s*"([^"]+)"\s*\}/g),
    ];
    if (entries.length === 0) {
      throw new UsageError(`${PUBLISH_CONTRACT}'s ${listName} parsed to zero members.`);
    }
    return new Map(entries.map((entry) => [entry[1], entry[2]]));
  };
  return { publishable: read("PUBLISHABLE_MEMBERS"), unpublished: read("PRIVATE_MEMBERS") };
}

/**
 * Every specifier `biome.json` bans, wherever the rule sits.
 *
 * The rule lives in an `overrides` entry today, so the config is walked rather
 * than indexed: moving the rule to the top level, or adding a second override,
 * must not silently empty this set. Only the `paths` form is understood — a
 * `patterns` form exits 2 by name, because silently ignoring it would let a ban
 * exist that the document never has to record.
 */
function readBannedSpecifiers(root) {
  const config = readJson(root, BIOME_CONFIG);
  const banned = new Set();
  const walk = (node) => {
    if (node === null || typeof node !== "object") {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item);
      }
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "noRestrictedImports" && value !== null && typeof value === "object") {
        const options = value.options ?? {};
        const unsupported = Object.keys(options).filter((option) => option !== "paths");
        if (unsupported.length > 0) {
          throw new UsageError(
            `${BIOME_CONFIG}'s noRestrictedImports uses ${unsupported.join(", ")}, which this ` +
              "checker does not read. Extend readBannedSpecifiers() so a ban cannot exist that " +
              `${ARCHITECTURE_DOC} never has to record.`,
          );
        }
        for (const specifier of Object.keys(options.paths ?? {})) {
          banned.add(specifier);
        }
        continue;
      }
      walk(value);
    }
  };
  walk(config);
  return banned;
}

/** The text between a `CHECKED:<id>` fence pair, or null when the fence is not both there. */
function readFence(text, id) {
  const open = `<!-- CHECKED:${id} -->`;
  const close = `<!-- /CHECKED:${id} -->`;
  const start = text.indexOf(open);
  if (start === -1) {
    return null;
  }
  const end = text.indexOf(close, start + open.length);
  if (end === -1) {
    return null;
  }
  return text.slice(start + open.length, end);
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell));
}

/**
 * Parse the one Markdown table inside a fence.
 *
 * Every `|` line in the block is a row, wherever it sits — the first is the
 * header, a dashes-only row is the separator, and everything else is data. That
 * is deliberate: a row appended after the fence's prose is still a row, so an
 * edge smuggled in below the table is a failure rather than a silent skip.
 */
function parseTable(block, columns, label) {
  const problems = [];
  const rows = [];
  let index = null;
  let widest = 0;
  for (const line of block.split("\n")) {
    if (!line.trim().startsWith("|")) {
      continue;
    }
    const cells = splitRow(line);
    if (index === null) {
      const headers = cells.map((cell) => cell.toLowerCase());
      index = {};
      for (const [key, header] of Object.entries(columns)) {
        const at = headers.indexOf(header);
        if (at === -1) {
          problems.push(
            `${label} table has no "${header}" column; its header row is: ${line.trim()}`,
          );
        }
        index[key] = at;
      }
      widest = Math.max(...Object.values(index));
      continue;
    }
    if (isSeparatorRow(cells)) {
      continue;
    }
    if (cells.length <= widest) {
      problems.push(
        `${label} row cannot be parsed: it has ${cells.length} cell(s) and the checked columns ` +
          `run to ${widest + 1}. The row is: ${line.trim()}`,
      );
      continue;
    }
    rows.push({ cells, line: line.trim() });
  }
  if (index === null) {
    problems.push(`${label} table is missing entirely: the fence contains no table row.`);
    return { rows: [], index: null, problems };
  }
  return { rows, index, problems };
}

/** `` `apps/cli` `` → `apps/cli`. Code spans are how the tables quote identifiers. */
function stripCode(cell) {
  const match = /^`(.*)`$/.exec(cell.trim());
  return match === null ? cell.trim() : match[1];
}

/** `[AGENTS.md](../apps/cli/AGENTS.md)` → `../apps/cli/AGENTS.md`. */
function linkTarget(cell) {
  const match = /\]\(([^)\s]+)/.exec(cell);
  return match === null ? null : match[1];
}

function cellAt(row, index, key) {
  const at = index[key];
  return at === -1 || at >= row.cells.length ? "" : row.cells[at];
}

/**
 * Check 1 — the member table equals the roster.
 *
 * `Declarations` is `n/a` for a member with no `build` script at all (the one
 * Python-only member), `yes` when the member has a `tsconfig.build.json` and
 * `no` otherwise. `API report` is the intersection the document exists to keep
 * legible: published **and** emitting declarations. Neither column is read off
 * the filesystem's `api/` directory, because the report generator owns that and
 * `check:api-report` is the gate for it.
 */
function checkMembers(members, rosters, document) {
  const problems = [];
  if (document === null) {
    return [`${ARCHITECTURE_DOC} is missing, so there is no member table to check (AC-18a).`];
  }
  const block = readFence(document, "members");
  if (block === null) {
    return [
      `${ARCHITECTURE_DOC} has no complete <!-- CHECKED:members --> … <!-- /CHECKED:members --> ` +
        "fence (AC-18a).",
    ];
  }
  const table = parseTable(block, MEMBER_COLUMNS, "CHECKED:members");
  problems.push(...table.problems);
  if (table.index === null) {
    return problems;
  }

  const expected = new Map();
  for (const member of members) {
    const publishable = rosters.publishable.has(member.path);
    const unpublished = rosters.unpublished.has(member.path);
    if (publishable === unpublished) {
      problems.push(
        `${member.path} is ${publishable ? "in both" : "in neither"} of ` +
          `${PUBLISH_CONTRACT}'s PUBLISHABLE_MEMBERS and PRIVATE_MEMBERS lists, so whether it is ` +
          "published is not declared anywhere and the Published column cannot be checked.",
      );
      continue;
    }
    if (member.tier === null) {
      problems.push(
        `${member.path}/package.json declares no xplainer.tier, so the Tier column has nothing ` +
          "to be checked against (pnpm lint:tiers is the gate for the tier itself).",
      );
      continue;
    }
    const declarations = !member.hasBuildScript ? "n/a" : member.hasBuildConfig ? "yes" : "no";
    expected.set(member.path, {
      path: member.path,
      name: member.name,
      tier: member.tier,
      published: publishable ? "yes" : "no",
      declarations,
      report: publishable && declarations === "yes" ? "yes" : "no",
      agents: `../${member.path}/${AGENTS_FILE}`,
    });
  }

  const documented = new Map();
  for (const row of table.rows) {
    const path = stripCode(cellAt(row, table.index, "path"));
    if (path === "") {
      problems.push(`a row has an empty Path cell: ${row.line}`);
      continue;
    }
    if (documented.has(path)) {
      problems.push(`${path} has more than one row in the table.`);
      continue;
    }
    documented.set(path, {
      path,
      name: stripCode(cellAt(row, table.index, "name")),
      tier: stripCode(cellAt(row, table.index, "tier")),
      published: cellAt(row, table.index, "published").toLowerCase(),
      declarations: cellAt(row, table.index, "declarations").toLowerCase(),
      report: cellAt(row, table.index, "report").toLowerCase(),
      agents: linkTarget(cellAt(row, table.index, "agents")),
    });
  }

  for (const [path, want] of expected) {
    const got = documented.get(path);
    if (got === undefined) {
      problems.push(
        `${path} is a workspace member with no row in the table. The workspace says: ` +
          `Package=${want.name} Tier=${want.tier} Published=${want.published} ` +
          `Declarations=${want.declarations} "API report"=${want.report} AGENTS.md=${want.agents}`,
      );
      continue;
    }
    for (const key of ["name", "tier", "published", "declarations", "report", "agents"]) {
      if (got[key] !== want[key]) {
        problems.push(
          `${path}: the "${MEMBER_COLUMNS[key]}" column says ${JSON.stringify(got[key])}, the ` +
            `workspace says ${JSON.stringify(want[key])}.`,
        );
      }
    }
  }
  for (const path of documented.keys()) {
    if (!expected.has(path)) {
      problems.push(`the table has a row for ${path}, which is not a workspace member.`);
    }
  }
  return problems;
}

/** Every `workspace:` edge the manifests declare, minus the preset edges excluded by rule. */
function buildEdges(members) {
  const edges = new Map();
  for (const member of members) {
    for (const kind of DEPENDENCY_FIELDS) {
      const declared = member.manifest[kind] ?? {};
      for (const [name, specifier] of Object.entries(declared)) {
        if (typeof specifier !== "string" || !specifier.startsWith(WORKSPACE_SPECIFIER)) {
          continue;
        }
        if (kind === "devDependencies" && name === PRESET_PACKAGE) {
          continue;
        }
        edges.set(`${member.path}|${name}|${kind}`, { from: member.path, to: name, kind });
      }
    }
  }
  return edges;
}

/** Check 2 — the edge table and the banned list both equal what the workspace declares. */
function checkDeps(members, banned, document) {
  const problems = [];
  if (document === null) {
    return [`${ARCHITECTURE_DOC} is missing, so there is no edge table to check (AC-18a).`];
  }
  const block = readFence(document, "deps");
  if (block === null) {
    return [
      `${ARCHITECTURE_DOC} has no complete <!-- CHECKED:deps --> … <!-- /CHECKED:deps --> fence ` +
        "(AC-18a).",
    ];
  }
  const table = parseTable(block, DEPS_COLUMNS, "CHECKED:deps");
  problems.push(...table.problems);
  if (table.index === null) {
    return problems;
  }

  const documented = new Map();
  for (const row of table.rows) {
    const from = stripCode(cellAt(row, table.index, "from"));
    const to = stripCode(cellAt(row, table.index, "to"));
    const kind = cellAt(row, table.index, "kind");
    if (from === "" || to === "" || kind === "") {
      problems.push(`a row has an empty From, To or Kind cell: ${row.line}`);
      continue;
    }
    if (!DEPENDENCY_FIELDS.includes(kind)) {
      problems.push(
        `the row ${row.line} has Kind ${JSON.stringify(kind)}, which is not one of ` +
          `${DEPENDENCY_FIELDS.join(", ")}.`,
      );
      continue;
    }
    const key = `${from}|${to}|${kind}`;
    if (documented.has(key)) {
      problems.push(`the edge ${from} → ${to} (${kind}) is listed more than once.`);
      continue;
    }
    documented.set(key, { from, to, kind });
  }

  const declared = buildEdges(members);
  const memberPaths = new Set(members.map((member) => member.path));
  for (const [key, edge] of declared) {
    if (!documented.has(key)) {
      problems.push(
        `${edge.from}/package.json declares ${edge.to} in ${edge.kind} with a ` +
          `"${WORKSPACE_SPECIFIER}" specifier, and the table has no row for it. Add ` +
          `\`| \`${edge.from}\` | \`${edge.to}\` | ${edge.kind} |\`.`,
      );
    }
  }
  for (const [key, edge] of documented) {
    if (declared.has(key)) {
      continue;
    }
    if (!memberPaths.has(edge.from)) {
      problems.push(
        `the table lists ${edge.from} → ${edge.to} (${edge.kind}), and ${edge.from} is not a ` +
          "workspace member.",
      );
      continue;
    }
    const otherKind = [...declared.values()].find(
      (candidate) => candidate.from === edge.from && candidate.to === edge.to,
    );
    if (otherKind !== undefined) {
      problems.push(
        `the table lists ${edge.from} → ${edge.to} as ${edge.kind}; ` +
          `${edge.from}/package.json declares it in ${otherKind.kind}.`,
      );
      continue;
    }
    problems.push(
      `the table lists ${edge.from} → ${edge.to} (${edge.kind}), which ` +
        `${edge.from}/package.json does not declare.`,
    );
  }

  const listed = new Set();
  for (const line of block.split("\n")) {
    const bullet = /^\s*-\s+`([^`]+)`\s*$/.exec(line);
    if (bullet !== null) {
      listed.add(bullet[1]);
    }
  }
  for (const specifier of banned) {
    if (!listed.has(specifier)) {
      problems.push(
        `${BIOME_CONFIG} bans the specifier ${specifier} and the banned list in the fence does ` +
          "not mention it.",
      );
    }
  }
  for (const specifier of listed) {
    if (!banned.has(specifier)) {
      problems.push(
        `the fence lists ${specifier} as banned and ${BIOME_CONFIG}'s noRestrictedImports does ` +
          "not ban it.",
      );
    }
  }
  return problems;
}

/** Lines, ignoring the trailing newline — the same count `wc -l` reports for a text file. */
function countLines(text) {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.length;
}

/** Check 3 — the instruction surface is complete: nine `AGENTS.md`, ten `CLAUDE.md`, one procedure. */
function checkAgents(root, members) {
  const problems = [];

  const rootAgents = join(root, AGENTS_FILE);
  if (!existsSync(rootAgents)) {
    problems.push(`the root ${AGENTS_FILE} is missing (AC-19b).`);
  } else if (!readFileSync(rootAgents, "utf8").includes(POST_CHANGE_HEADING)) {
    problems.push(
      `the root ${AGENTS_FILE} has no "${POST_CHANGE_HEADING}" section, and every other ` +
        "instruction file points at it rather than restating the procedure (AC-19b).",
    );
  }

  for (const member of members) {
    const relative = `${member.path}/${AGENTS_FILE}`;
    const absolute = join(root, relative);
    if (!existsSync(absolute)) {
      problems.push(`${relative} is missing (AC-19a).`);
      continue;
    }
    const text = readFileSync(absolute, "utf8");
    const missing = REQUIRED_MEMBER_HEADINGS.filter(
      (heading) => !text.split("\n").some((line) => line.trim() === heading),
    );
    if (missing.length > 0) {
      problems.push(`${relative} is missing the heading(s) ${missing.join(", ")} (AC-19a).`);
    }
  }

  for (const path of ["", ...members.map((member) => member.path)]) {
    const relative = path === "" ? CLAUDE_FILE : `${path}/${CLAUDE_FILE}`;
    const absolute = join(root, relative);
    if (!existsSync(absolute)) {
      problems.push(
        `${relative} is missing. Claude Code never reads ${AGENTS_FILE}, so without this stub ` +
          `the ${AGENTS_FILE} beside it is invisible to it (plan §11, AC-19b).`,
      );
      continue;
    }
    const text = readFileSync(absolute, "utf8");
    const lines = countLines(text);
    if (lines > CLAUDE_MAX_LINES) {
      problems.push(
        `${relative} is ${lines} lines; a stub is at most ${CLAUDE_MAX_LINES}, because content ` +
          `here can drift from the ${AGENTS_FILE} it stands in for (AC-19b).`,
      );
    }
    if (!text.split("\n").some((line) => line.trim() === CLAUDE_IMPORT_LINE)) {
      problems.push(
        `${relative} does not contain the line "${CLAUDE_IMPORT_LINE}", so it imports nothing ` +
          "(AC-19b).",
      );
    }
  }
  return problems;
}

function report(check, problems) {
  for (const problem of problems) {
    process.stderr.write(`docs-contract: ${check}: ${problem}\n`);
  }
  return problems.length;
}

function main(argv) {
  if (argv.length > 0) {
    throw new UsageError(
      `unexpected argument(s): ${argv.join(" ")}. This checker takes none; it reads the ` +
        "workspace and the documents and compares them.",
    );
  }
  const root = findWorkspaceRoot();
  if (root === null) {
    throw new UsageError(`no ${WORKSPACE_FILE} found above the working directory.`);
  }

  const members = readMembers(root);
  const rosters = readDeclaredRosters(root);
  const banned = readBannedSpecifiers(root);
  const documentPath = join(root, ARCHITECTURE_DOC);
  const document = existsSync(documentPath) ? readFileSync(documentPath, "utf8") : null;

  let failures = 0;
  failures += report("members", checkMembers(members, rosters, document));
  failures += report("deps", checkDeps(members, banned, document));
  failures += report("agents", checkAgents(root, members));

  if (failures > 0) {
    process.stderr.write(
      `\ndocs-contract: ${failures} contract violation(s). Every line above is a place where ` +
        `${ARCHITECTURE_DOC} or the agent instruction surface says something the workspace does ` +
        "not, which is exactly what an agent reading it first would act on.\n",
    );
    return 1;
  }

  const edges = buildEdges(members).size;
  const instructionFiles = (members.length + 1) * 2;
  process.stdout.write(
    `docs-contract: ${members.length} member(s), ${edges} dependency edge(s) and ` +
      `${instructionFiles} instruction file(s) checked; ${ARCHITECTURE_DOC} matches the ` +
      "workspace.\n",
  );
  return 0;
}

let exitCode;
try {
  exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`docs-contract: ${error.message}\n`);
    exitCode = 2;
  } else {
    process.stderr.write(
      `docs-contract: internal error\n${error instanceof Error ? error.stack : String(error)}\n`,
    );
    exitCode = 70;
  }
}
process.exitCode = exitCode;
