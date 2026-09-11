#!/usr/bin/env node
/**
 * Public API report generator and staleness gate (plan T12; acceptance criteria
 * AC-17a … AC-17e).
 *
 * Writes one Markdown report per published, declaration-emitting workspace
 * member at `<member>/api/<unscoped-name>.api.md`, and — with `--check` —
 * regenerates every report into memory and exits 1 with a unified diff if a
 * committed report disagrees. That is deliberately the same shape as the
 * codegen staleness check (`turbo codegen && git diff --exit-code`): a
 * contributor who has met one has met both.
 *
 * WHY THE REPORT IS ROOTED AT THE ENTRY POINT, NOT AT `dist/**\/*.d.ts`. A
 * report that globs every emitted declaration reports internal modules as
 * though they were public surface, so an internal refactor shows up as an API
 * change and the gate becomes noise. This one starts at each manifest's
 * `exports["."].types` and follows that file's re-export lists, so a symbol
 * exported from an implementation module but not re-exported through the
 * barrel is absent from the report — which is exactly what makes the report
 * worth diffing.
 *
 * WHY A SCRIPT AND NOT api-extractor. `@microsoft/api-extractor@7.59.0` was
 * measured against this workspace's TypeScript 7.0.2-emitted declarations
 * before this file was written, and the measurement — not an assertion — is
 * the reason it was not adopted:
 *
 *   * Its bundled TypeScript 5.9.3 parses 7.0.2-emitted `.d.ts` without
 *     complaint. The syntax was never the problem.
 *   * Run in its documented default configuration (`compiler.tsconfigFilePath`
 *     defaulting to the member's own `tsconfig.json`), extraction succeeds on
 *     four of the five entry points and aborts on `packages/render-core` with
 *     `Internal Error: Unable to follow symbol for "Buffer" … You have
 *     encountered a software defect`. The trigger is
 *     `readScaffoldTemplate(name: ScaffoldFile): Buffer` — the global `Buffer`
 *     that `@types/node@26.4.1` declares inside
 *     `declare module "node:buffer" { global { … } }`. A one-line `.d.ts`
 *     containing only `export declare function readBytes(name: string): Buffer;`
 *     reproduces it; changing that return type to `Uint8Array` makes the same
 *     run succeed.
 *   * All five entry points do extract, byte-stably across two runs, but only
 *     under a hand-written inline `compiler.overrideTsconfig` that both narrows
 *     `include` to `dist/**\/*.d.ts` and pins `typeRoots` at the workspace's
 *     `node_modules/@types`. That configuration is a workaround for a crash,
 *     found by bisection rather than by documentation, and it would have to be
 *     rediscovered the next time `@types/node` moves.
 *   * T12's own rule decides the rest: extraction that covers four packages in
 *     the natural configuration and needs a bespoke fifth is a partial pass,
 *     and a partial pass takes this branch.
 *
 * The measurement is recorded here rather than only in a review comment so the
 * rejection stays evidence rather than assertion; ADR 0026 (written by T18)
 * records the same finding for a reader who never opens this file.
 *
 * Exit codes:
 *   0  every report is present and current (`--check`), or was written (default)
 *   1  a report is stale, missing, or orphaned, or the reported roster has
 *      drifted from the workspace on disk
 *   2  the generator could not run: no workspace root, a member has not been
 *      built, a manifest cannot be read, or an entry point uses a construct
 *      this reader deliberately does not implement (see below)
 *
 * SCOPE, STATED HONESTLY. This reader walks re-export lists; it does not build
 * a type graph. It can do that because T10 leaves every barrel as an explicit
 * `export { … } from "./x"` list with no `export *` anywhere, and because the
 * five surfaces name every public symbol in one. Three consequences follow, and
 * each one fails loudly rather than quietly producing a thinner report:
 *
 *   * `export *` in a reachable file exits 2 and names the file.
 *   * A name re-exported from another package (a non-relative specifier) exits
 *     2, because the declaration lives in a tarball this script is not reading.
 *   * A requested name that no reachable file declares exits 2.
 *
 * The report also omits `import` statements on purpose. Emitting them would
 * make an internal-only edit — a new import used by no exported declaration —
 * change the report, and AC-17e says an internal-only edit must not fire the
 * gate. A signature that mentions an import alias therefore appears exactly as
 * TypeScript emitted it, alias and all: the report records the public
 * signature, it is not a compilable file.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Directories that hold workspace members, mirroring `pnpm-workspace.yaml`. */
const MEMBER_ROOTS = ["apps", "packages", "services"];

/** Where a member's report lives, and what it is called. */
const REPORT_DIRECTORY = "api";
const REPORT_EXTENSION = ".api.md";

/**
 * The members that get a report, declared rather than discovered.
 *
 * Discovery alone cannot catch drift, for the same reason
 * `check-publish-contract.mjs` writes its roster out: a member that quietly
 * gained a published TypeScript entry point would simply be discovered and
 * reported, and a member that quietly lost one would simply disappear from the
 * run. Both lists are written out, and `checkRoster` fails if the workspace on
 * disk disagrees with either — in either direction.
 *
 * The rule behind the two lists: a member is reported when it is published
 * (`private` is not `true`) AND its manifest declares an `exports["."].types`
 * entry point. That is the intersection of published and
 * declaration-emitting.
 */
const REPORTED_MEMBERS = [
  { dir: "apps/cli", name: "@xplainer/cli" },
  { dir: "packages/mcp-server", name: "@xplainer/mcp-server" },
  { dir: "packages/protocol", name: "@xplainer/protocol" },
  { dir: "packages/render-core", name: "@xplainer/render-core" },
  { dir: "packages/tts-client", name: "@xplainer/tts-client" },
];

/** The members that get no report, each with the reason a reader would ask for. */
const UNREPORTED_MEMBERS = [
  {
    dir: "apps/desktop",
    name: "@xplainer/desktop",
    reason: "it is private: true — an Electron application, not a published surface",
  },
  {
    dir: "packages/alias",
    name: "xplainer",
    reason:
      'it is published but has no importable surface at all: the unscoped alias declares a "bin" ' +
      'and no "exports", so there is nothing a consumer could import and nothing to report',
  },
  {
    dir: "packages/config",
    name: "@xplainer/config",
    reason:
      "it emits declarations but is private: true, so its surface is internal and isolatedDeclarations alone covers it",
  },
  {
    dir: "packages/skill",
    name: "@xplainer/skill",
    reason:
      'it is published but has no TypeScript surface: the bundle is built by node scripts/build.mjs and the manifest declares no exports["."].types',
  },
  {
    dir: "services/tts-sidecar",
    name: "@xplainer/tts-sidecar",
    reason: "it is private: true — a Python service",
  },
];

/** A problem the caller can fix by editing the tree: exit 1. */
class ContractError extends Error {}

/** A problem that stops the generator from running at all: exit 2. */
class GeneratorError extends Error {}

/** The nearest ancestor directory holding `pnpm-workspace.yaml`, or `null`. */
function findWorkspaceRoot() {
  const candidates = [process.cwd(), dirname(fileURLToPath(import.meta.url))];
  for (const candidate of candidates) {
    let directory = resolve(candidate);
    for (;;) {
      if (existsSync(join(directory, "pnpm-workspace.yaml"))) {
        return directory;
      }
      const parent = dirname(directory);
      if (parent === directory) {
        break;
      }
      directory = parent;
    }
  }
  return null;
}

/** Read and parse one member manifest, or throw a GeneratorError naming it. */
function readManifest(root, memberDir) {
  const relativePath = posix.join(memberDir, "package.json");
  try {
    return JSON.parse(readFileSync(join(root, memberDir, "package.json"), "utf8"));
  } catch (error) {
    throw new GeneratorError(
      `${relativePath}: cannot be read as JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/** `@xplainer/tts-client` -> `tts-client`. The report file is named after this. */
function unscopedName(name) {
  const slash = name.lastIndexOf("/");
  return slash === -1 ? name : name.slice(slash + 1);
}

/** The `exports["."].types` entry point as a member-relative path, or `null`. */
function entryPointOf(manifest) {
  const types = manifest.exports?.["."]?.types;
  if (typeof types !== "string" || !types.endsWith(".d.ts")) {
    return null;
  }
  return types.replace(/^\.\//, "");
}

/** Every member directory on disk under `MEMBER_ROOTS`, in path order. */
function collectMemberDirs(root) {
  const dirs = [];
  for (const memberRoot of MEMBER_ROOTS) {
    const absolute = join(root, memberRoot);
    if (!existsSync(absolute)) {
      continue;
    }
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      if (entry.isDirectory() && existsSync(join(absolute, entry.name, "package.json"))) {
        dirs.push(posix.join(memberRoot, entry.name));
      }
    }
  }
  return dirs;
}

/**
 * Compare the declared rosters against the workspace on disk.
 *
 * Returns violation strings; an empty array means the two lists above still
 * describe the workspace.
 */
function checkRoster(root) {
  const violations = [];
  const reported = new Map(REPORTED_MEMBERS.map((member) => [member.dir, member]));
  const unreported = new Map(UNREPORTED_MEMBERS.map((member) => [member.dir, member]));

  for (const memberDir of collectMemberDirs(root)) {
    const manifest = readManifest(root, memberDir);
    const needsReport = manifest.private !== true && entryPointOf(manifest) !== null;
    const declaredReported = reported.get(memberDir);
    const declaredUnreported = unreported.get(memberDir);

    if (declaredReported === undefined && declaredUnreported === undefined) {
      const verdict = needsReport
        ? 'it is published and declares an exports["."].types entry point, so it needs a report'
        : "it needs no report";
      violations.push(
        `${memberDir} (${manifest.name}) is in neither REPORTED_MEMBERS nor UNREPORTED_MEMBERS in scripts/api-report.mjs, and ${verdict}.`,
      );
      continue;
    }
    if (declaredReported !== undefined && declaredReported.name !== manifest.name) {
      violations.push(
        `${memberDir}: REPORTED_MEMBERS calls it ${declaredReported.name}, the manifest calls it ${manifest.name}.`,
      );
    }
    if (declaredUnreported !== undefined && declaredUnreported.name !== manifest.name) {
      violations.push(
        `${memberDir}: UNREPORTED_MEMBERS calls it ${declaredUnreported.name}, the manifest calls it ${manifest.name}.`,
      );
    }
    if (needsReport && declaredReported === undefined) {
      violations.push(
        `${memberDir} (${manifest.name}) is published and declares an exports["."].types entry point, so it needs an api/ report, but UNREPORTED_MEMBERS lists it as needing none.`,
      );
    }
    if (!needsReport && declaredReported !== undefined) {
      violations.push(
        `${memberDir} (${manifest.name}) is listed in REPORTED_MEMBERS but no longer emits a published declaration entry point, so its api/ report is now orphaned.`,
      );
    }
    reported.delete(memberDir);
    unreported.delete(memberDir);
  }

  for (const member of [...reported.values(), ...unreported.values()]) {
    violations.push(
      `${member.dir} (${member.name}) is declared in scripts/api-report.mjs but is not a workspace member on disk.`,
    );
  }
  return violations;
}

/**
 * Blank out comments and string bodies, preserving offsets and newlines.
 *
 * Every boundary decision below runs against this mask rather than the source,
 * so a brace inside a doc comment or a string literal cannot be mistaken for a
 * block delimiter. The declarations themselves are always sliced out of the
 * ORIGINAL text, so nothing the report prints has been through the mask.
 */
function maskCommentsAndStrings(text) {
  const out = text.split("");
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2);
      const stop = close === -1 ? text.length : close + 2;
      for (let k = index; k < stop; k += 1) {
        if (out[k] !== "\n") {
          out[k] = " ";
        }
      }
      index = stop;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      const close = text.indexOf("\n", index);
      const stop = close === -1 ? text.length : close;
      for (let k = index; k < stop; k += 1) {
        out[k] = " ";
      }
      index = stop;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      let cursor = index + 1;
      while (cursor < text.length) {
        if (text[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (text[cursor] === char) {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      for (let k = index + 1; k < cursor - 1; k += 1) {
        if (out[k] !== "\n") {
          out[k] = " ";
        }
      }
      index = cursor;
      continue;
    }
    index += 1;
  }
  return out.join("");
}

/** Declaration keywords whose statement ends at the closing brace of a body. */
const BODY_KEYWORDS = /\b(?:class|interface|enum|namespace|module|global)\b/;

/** Split a masked declaration file into top-level statement spans. */
function topLevelSpans(masked) {
  const spans = [];
  let depth = 0;
  let start = -1;
  let index = 0;
  while (index < masked.length) {
    const char = masked[index];
    if (start === -1) {
      if (/\s/.test(char)) {
        index += 1;
        continue;
      }
      start = index;
    }
    if (char === "{" || char === "(" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === ")" || char === "]") {
      depth -= 1;
      if (depth === 0 && char === "}") {
        let after = index + 1;
        while (after < masked.length && /\s/.test(masked[after])) {
          after += 1;
        }
        const head = masked.slice(start, Math.min(start + 80, masked.length));
        if (masked[after] === ";") {
          spans.push([start, after + 1]);
          start = -1;
          index = after + 1;
          continue;
        }
        if (BODY_KEYWORDS.test(head)) {
          spans.push([start, index + 1]);
          start = -1;
          index += 1;
          continue;
        }
      }
    } else if (char === ";" && depth === 0) {
      spans.push([start, index + 1]);
      start = -1;
      index += 1;
      continue;
    }
    index += 1;
  }
  if (start !== -1) {
    spans.push([start, masked.length]);
  }
  return spans;
}

/**
 * Extend a span backwards over the doc comment directly above it.
 *
 * "Directly above" means only whitespace with at most one newline sits between
 * the end of the comment and the start of the statement, which is what
 * TypeScript emits. A comment separated by a blank line belongs to nothing and
 * is left out.
 */
function withLeadingComment(text, start) {
  let cursor = start;
  for (;;) {
    let newlines = 0;
    let scan = cursor - 1;
    while (scan >= 0 && /\s/.test(text[scan])) {
      if (text[scan] === "\n") {
        newlines += 1;
      }
      scan -= 1;
    }
    if (newlines > 1 || scan < 1) {
      return cursor;
    }
    if (text[scan] === "/" && text[scan - 1] === "*") {
      const open = text.lastIndexOf("/*", scan - 1);
      if (open === -1) {
        return cursor;
      }
      cursor = open;
      continue;
    }
    const lineStart = text.lastIndexOf("\n", scan) + 1;
    if (
      text
        .slice(lineStart, scan + 1)
        .trimStart()
        .startsWith("//")
    ) {
      cursor = lineStart;
      continue;
    }
    return cursor;
  }
}

/** One entry of an `export { … }` clause. */
function parseExportEntries(clause) {
  const entries = [];
  for (const raw of clause.split(",")) {
    const item = raw.trim();
    if (item.length === 0) {
      continue;
    }
    const match = /^(type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(item);
    if (match === null) {
      return null;
    }
    entries.push({ local: match[2], exported: match[3] ?? match[2] });
  }
  return entries;
}

const DECLARATION_NAME =
  /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:const\s+enum|const|let|var|function\s*\*?|class|interface|type|enum|namespace|module)\s+([A-Za-z_$][\w$]*)/;
const LOCAL_DECLARATION_NAME =
  /^(?:declare\s+)?(?:abstract\s+)?(?:const\s+enum|const|let|var|function\s*\*?|class|interface|type|enum|namespace|module)\s+([A-Za-z_$][\w$]*)/;

/**
 * Parse one emitted declaration file into the two things this reader needs:
 * the top-level declarations it holds, by name, and the re-export lists that
 * point at other files.
 */
function parseDeclarationFile(absolutePath, relativePath) {
  const raw = readFileSync(absolutePath, "utf8").replace(/\r\n/g, "\n");
  const masked = maskCommentsAndStrings(raw);
  const statements = [];
  const declarations = new Map();
  const reexports = [];
  const localExports = [];

  for (const [start, end] of topLevelSpans(masked)) {
    const maskedText = masked.slice(start, end);
    const sourceText = raw.slice(start, end);
    if (/^import\b/.test(maskedText)) {
      continue;
    }
    if (/^export\s+\*/.test(maskedText)) {
      throw new GeneratorError(
        `${relativePath}: uses \`export *\`, which this reader cannot resolve to named declarations. Every barrel must be an explicit \`export { … }\` list (plan T10).`,
      );
    }
    const clauseMatch = /^export\s+(type\s+)?\{([^}]*)\}\s*(?:from\s*["']([^"']+)["'])?/.exec(
      sourceText,
    );
    if (clauseMatch !== null) {
      const entries = parseExportEntries(clauseMatch[2]);
      if (entries === null) {
        throw new GeneratorError(
          `${relativePath}: export clause ${JSON.stringify(clauseMatch[2].trim())} is not a plain name list, which this reader cannot resolve.`,
        );
      }
      if (clauseMatch[3] === undefined) {
        localExports.push(...entries);
      } else {
        reexports.push({ specifier: clauseMatch[3], entries });
      }
      continue;
    }
    const exported = DECLARATION_NAME.exec(maskedText);
    const name = exported?.[1] ?? LOCAL_DECLARATION_NAME.exec(maskedText)?.[1];
    if (name === undefined) {
      continue;
    }
    const index = statements.length;
    statements.push({ text: raw.slice(withLeadingComment(raw, start), end).trimEnd() });
    const existing = declarations.get(name);
    if (existing === undefined) {
      declarations.set(name, { indexes: [index], exported: exported !== null });
    } else {
      existing.indexes.push(index);
      existing.exported = existing.exported || exported !== null;
    }
  }
  return { relativePath, statements, declarations, reexports, localExports };
}

/** Resolve a relative specifier from one declaration file to another. */
function resolveSpecifier(memberAbsolute, fromRelative, specifier) {
  if (!specifier.startsWith(".")) {
    throw new GeneratorError(
      `${fromRelative}: re-exports from ${JSON.stringify(specifier)}, another package, whose declarations this reader is not reading. Re-export the symbol's own package instead, or declare it locally.`,
    );
  }
  const base = posix.join(posix.dirname(fromRelative), specifier);
  const candidates = base.endsWith(".js")
    ? [`${base.slice(0, -3)}.d.ts`]
    : [`${base}.d.ts`, posix.join(base, "index.d.ts")];
  for (const candidate of candidates) {
    if (existsSync(join(memberAbsolute, candidate))) {
      return candidate;
    }
  }
  throw new GeneratorError(
    `${fromRelative}: re-exports from ${JSON.stringify(specifier)}, which resolves to none of ${candidates.join(", ")}.`,
  );
}

/** Every name a declaration file exports, in source order. */
function exportedNames(file) {
  const names = [];
  for (const reexport of file.reexports) {
    for (const entry of reexport.entries) {
      names.push(entry.exported);
    }
  }
  for (const entry of file.localExports) {
    names.push(entry.exported);
  }
  for (const [name, declaration] of file.declarations) {
    if (declaration.exported) {
      names.push(name);
    }
  }
  return names;
}

/**
 * Select the declarations reachable from one module's export list, following
 * re-exports into the files that declare them.
 */
function select(state, relativePath, names, trail) {
  let file = state.files.get(relativePath);
  if (file === undefined) {
    file = parseDeclarationFile(join(state.memberAbsolute, relativePath), relativePath);
    state.files.set(relativePath, file);
  }
  for (const name of names ?? exportedNames(file)) {
    const key = `${relativePath}#${name}`;
    if (trail.has(key)) {
      throw new GeneratorError(
        `${relativePath}: re-export of ${JSON.stringify(name)} is circular (${[...trail, key].join(" -> ")}).`,
      );
    }
    const via = file.reexports.find((reexport) =>
      reexport.entries.some((entry) => entry.exported === name),
    );
    if (via !== undefined) {
      const entry = via.entries.find((candidate) => candidate.exported === name);
      const target = resolveSpecifier(state.memberAbsolute, relativePath, via.specifier);
      select(state, target, [entry.local], new Set([...trail, key]));
      continue;
    }
    const local = file.localExports.find((entry) => entry.exported === name);
    const declaration = file.declarations.get(local?.local ?? name);
    if (declaration === undefined) {
      throw new GeneratorError(
        `${relativePath}: exports ${JSON.stringify(name)}, but no top-level declaration in that file declares it.`,
      );
    }
    let selected = state.selected.get(relativePath);
    if (selected === undefined) {
      selected = new Set();
      state.selected.set(relativePath, selected);
    }
    for (const index of declaration.indexes) {
      selected.add(index);
    }
  }
}

/** Render the selected declarations as the committed Markdown report. */
function renderReport(state, packageName, entryRelative) {
  const lines = [
    `# ${packageName} — public API report`,
    "",
    "<!--",
    "Generated by `node scripts/api-report.mjs` (`pnpm api:report`). Do not edit by hand:",
    "`pnpm check:api-report` regenerates it and fails if this file disagrees.",
    "",
    'Rooted at this package\'s `exports["."].types` entry point and covering the declarations',
    "reachable from it. Files appear in path order, declarations in source order, so an added",
    "overload shows up where it was added. No timestamps, no version numbers: the only thing",
    "that changes this file is a change to the public surface.",
    "-->",
    "",
    `Entry point: \`${entryRelative}\``,
    "",
  ];
  for (const relativePath of [...state.selected.keys()].sort()) {
    const file = state.files.get(relativePath);
    const indexes = [...state.selected.get(relativePath)].sort((a, b) => a - b);
    lines.push(`## \`${relativePath}\``, "", "```ts");
    indexes.forEach((index, position) => {
      lines.push(file.statements[index].text);
      if (position < indexes.length - 1) {
        lines.push("");
      }
    });
    lines.push("```", "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Build the report text for one member. */
function buildReport(root, member) {
  const manifest = readManifest(root, member.dir);
  const entryRelative = entryPointOf(manifest);
  if (entryRelative === null) {
    throw new ContractError(
      `${member.dir} (${member.name}) declares no exports["."].types entry point, so it has no public surface to report.`,
    );
  }
  const memberAbsolute = join(root, member.dir);
  if (!existsSync(join(memberAbsolute, entryRelative))) {
    throw new GeneratorError(
      `${posix.join(member.dir, entryRelative)} does not exist: ${member.name} has not been built. Run \`pnpm turbo build\` first.`,
    );
  }
  const state = { memberAbsolute, files: new Map(), selected: new Map() };
  select(state, entryRelative, null, new Set());
  return renderReport(state, manifest.name, entryRelative);
}

/** Member-relative path of a member's report file. */
function reportPath(member) {
  return posix.join(
    member.dir,
    REPORT_DIRECTORY,
    `${unscopedName(member.name)}${REPORT_EXTENSION}`,
  );
}

/** Every `*.api.md` under a member's `api/` directory, in path order. */
function existingReports(root, memberDir) {
  const directory = join(root, memberDir, REPORT_DIRECTORY);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    return [];
  }
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(REPORT_EXTENSION))
    .sort()
    .map((entry) => posix.join(memberDir, REPORT_DIRECTORY, entry));
}

/** Longest common subsequence table walk, enough for a unified diff of one file. */
function commonSubsequence(before, after) {
  const rows = before.length + 1;
  const columns = after.length + 1;
  const table = new Uint32Array(rows * columns);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i * columns + j] =
        before[i] === after[j]
          ? table[(i + 1) * columns + j + 1] + 1
          : Math.max(table[(i + 1) * columns + j], table[i * columns + j + 1]);
    }
  }
  const operations = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      operations.push([" ", before[i]]);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * columns + j] >= table[i * columns + j + 1]) {
      operations.push(["-", before[i]]);
      i += 1;
    } else {
      operations.push(["+", after[j]]);
      j += 1;
    }
  }
  while (i < before.length) {
    operations.push(["-", before[i]]);
    i += 1;
  }
  while (j < after.length) {
    operations.push(["+", after[j]]);
    j += 1;
  }
  return operations;
}

/** A unified diff with three lines of context, in `diff -u` shape. */
function unifiedDiff(path, before, after) {
  let beforeLine = 0;
  let afterLine = 0;
  const rows = commonSubsequence(before.split("\n"), after.split("\n")).map(([kind, text]) => {
    if (kind !== "+") {
      beforeLine += 1;
    }
    if (kind !== "-") {
      afterLine += 1;
    }
    return { kind, text, before: beforeLine, after: afterLine };
  });

  const context = 3;
  const hunks = [];
  rows.forEach((row, index) => {
    if (row.kind === " ") {
      return;
    }
    const start = Math.max(0, index - context);
    const end = Math.min(rows.length - 1, index + context);
    const last = hunks.at(-1);
    if (last !== undefined && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      hunks.push({ start, end });
    }
  });
  if (hunks.length === 0) {
    return "";
  }

  const lines = [`--- a/${path}`, `+++ b/${path}`];
  for (const hunk of hunks) {
    const slice = rows.slice(hunk.start, hunk.end + 1);
    const kept = slice.filter((row) => row.kind !== "+");
    const added = slice.filter((row) => row.kind !== "-");
    const beforeStart = kept[0]?.before ?? slice[0].before;
    const afterStart = added[0]?.after ?? slice[0].after;
    lines.push(`@@ -${beforeStart},${kept.length} +${afterStart},${added.length} @@`);
    for (const row of slice) {
      lines.push(`${row.kind}${row.text}`);
    }
  }
  return lines.join("\n");
}

function main() {
  const check = process.argv.includes("--check");
  const root = findWorkspaceRoot();
  if (root === null) {
    process.stderr.write(
      "api-report: no pnpm-workspace.yaml found above the working directory or this script.\n",
    );
    return 2;
  }

  const violations = checkRoster(root);
  for (const member of UNREPORTED_MEMBERS) {
    for (const orphan of existingReports(root, member.dir)) {
      violations.push(
        `${orphan} exists, but ${member.name} has no public API report because ${member.reason}. Delete it.`,
      );
    }
  }

  const expected = new Map();
  for (const member of REPORTED_MEMBERS) {
    expected.set(reportPath(member), buildReport(root, member));
    for (const found of existingReports(root, member.dir)) {
      if (found !== reportPath(member)) {
        violations.push(
          `${found} is not a report this generator writes; ${member.name}'s report is ${reportPath(member)}. Delete it.`,
        );
      }
    }
  }

  const stale = [];
  for (const [path, content] of expected) {
    const absolute = join(root, path);
    if (!existsSync(absolute)) {
      if (check) {
        violations.push(`${path} is missing. Regenerate it with \`pnpm api:report\`.`);
      } else {
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, content);
      }
      continue;
    }
    const committed = readFileSync(absolute, "utf8");
    if (committed === content) {
      continue;
    }
    if (check) {
      stale.push(unifiedDiff(path, committed, content));
      violations.push(`${path} is out of date. Regenerate it with \`pnpm api:report\`.`);
    } else {
      writeFileSync(absolute, content);
    }
  }

  if (violations.length > 0) {
    process.stderr.write(`api-report: ${violations.length} public API report problem(s):\n`);
    for (const violation of violations) {
      process.stderr.write(`  ${violation}\n`);
    }
    for (const diff of stale) {
      process.stderr.write(`\n${diff}\n`);
    }
    return 1;
  }

  process.stdout.write(
    `api-report: ${expected.size} report(s) ${check ? "current" : "written"}, ${UNREPORTED_MEMBERS.length} member(s) deliberately unreported.\n`,
  );
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  if (error instanceof ContractError) {
    process.stderr.write(`api-report: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`api-report: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
