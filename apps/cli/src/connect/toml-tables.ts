/**
 * Finding one table inside a TOML document, without becoming a TOML library.
 *
 * `xplainer connect codex` edits `~/.codex/config.toml`, a file whose other contents belong entirely
 * to the user: model settings, per-project trust levels, other MCP servers, and their comments. A
 * parse-and-reserialise round trip through a TOML library would return a *semantically* identical
 * file with every comment deleted and every table reordered, which is a rewrite of somebody's
 * configuration presented as an edit. So this module answers the one structural question a surgical
 * edit needs — **which lines, if any, are `[mcp_servers.xplainer]`'s** — and the writer replaces
 * exactly those lines and touches nothing else.
 *
 * That is a deliberately smaller job than parsing TOML, and the boundary is drawn where a mistake
 * would be silent rather than loud:
 *
 * - **Quoted keys are understood**, because they are real: a `config.toml` on this machine holds
 *   `[projects."/Users/…/projects/max"]`, and splitting a header on `.` without respecting quotes
 *   would read that as five key segments.
 * - **Multi-line strings are tracked**, so a `[` that is the first character of a line *inside* a
 *   `"""…"""` value is never mistaken for a table header.
 * - **Every other way of declaring the same table is refused rather than guessed at.** A dotted key
 *   (`mcp_servers.xplainer = { … }`), an inline parent (`mcp_servers = { xplainer = … }`) and an
 *   array of tables (`[[mcp_servers.xplainer]]`) all define the same name that an appended
 *   `[mcp_servers.xplainer]` header would define a second time — which is not a merge, it is invalid
 *   TOML, and Codex would stop reading the whole file. {@link findConflictingDefinition} exists so
 *   that case ends in a sentence the user can act on instead.
 *
 * The values inside the table are never parsed: the writer replaces the table wholesale, so what the
 * old one said does not matter.
 */

/** A half-open range of line indices: `[start, end)`. */
export type TableSpan = {
  start: number;
  end: number;
};

/** One structural line: a table header, or an assignment whose key path is known. */
type Structure =
  | { kind: "table"; path: string[]; line: number }
  | { kind: "array-table"; path: string[]; line: number }
  | { kind: "key"; path: string[]; line: number };

/** How a character scan of one line ended, which is where the next line starts. */
type StringState = "none" | "basic" | "literal";

/**
 * Advance the multi-line-string state across one line.
 *
 * Only the state matters to the caller — what a value *is* is never this module's business — so the
 * scan skips single-line strings and comments wholesale and reports only whether a `"""` or `'''`
 * was left open at the end of the line.
 */
function scanLine(line: string, entering: StringState): StringState {
  let index = 0;
  let state = entering;
  while (index < line.length) {
    if (state === "basic") {
      const close = line.indexOf('"""', index);
      if (close < 0) {
        return "basic";
      }
      index = close + 3;
      state = "none";
      continue;
    }
    if (state === "literal") {
      const close = line.indexOf("'''", index);
      if (close < 0) {
        return "literal";
      }
      index = close + 3;
      state = "none";
      continue;
    }
    const character = line[index];
    if (character === "#") {
      return "none";
    }
    if (line.startsWith('"""', index)) {
      state = "basic";
      index += 3;
      continue;
    }
    if (line.startsWith("'''", index)) {
      state = "literal";
      index += 3;
      continue;
    }
    if (character === '"') {
      index = endOfSingleLineString(line, index + 1, '"', true);
      continue;
    }
    if (character === "'") {
      index = endOfSingleLineString(line, index + 1, "'", false);
      continue;
    }
    index += 1;
  }
  return state;
}

/** The index just past a single-line string's closing quote, or the end of the line. */
function endOfSingleLineString(
  line: string,
  from: number,
  quote: string,
  escapes: boolean,
): number {
  let index = from;
  while (index < line.length) {
    const character = line[index];
    if (escapes && character === "\\") {
      index += 2;
      continue;
    }
    if (character === quote) {
      return index + 1;
    }
    index += 1;
  }
  return line.length;
}

/** What TOML allows in an unquoted key segment. */
const BARE_KEY_CHARACTER = /[A-Za-z0-9_-]/;

/**
 * Split a dotted key into its segments, honouring quoting, or `null` when it is malformed.
 *
 * `a.b`, `a . b`, `"a.b"` and `'a.b'` are three different keys and one of them contains a dot; a
 * caller that split on `.` would conflate them.
 */
export function parseDottedKey(text: string): string[] | null {
  const segments: string[] = [];
  let index = 0;
  let expectingSegment = true;
  while (index < text.length) {
    const character = text[index];
    if (character === undefined) {
      break;
    }
    if (character === " " || character === "\t") {
      index += 1;
      continue;
    }
    if (character === ".") {
      if (expectingSegment) {
        return null;
      }
      expectingSegment = true;
      index += 1;
      continue;
    }
    if (!expectingSegment) {
      return null;
    }
    if (character === '"' || character === "'") {
      const end = endOfSingleLineString(text, index + 1, character, character === '"');
      if (text[end - 1] !== character) {
        return null;
      }
      const body = text.slice(index + 1, end - 1);
      segments.push(character === '"' ? unescapeBasic(body) : body);
      index = end;
      expectingSegment = false;
      continue;
    }
    let end = index;
    while (end < text.length && BARE_KEY_CHARACTER.test(text[end] ?? "")) {
      end += 1;
    }
    if (end === index) {
      return null;
    }
    segments.push(text.slice(index, end));
    index = end;
    expectingSegment = false;
  }
  if (expectingSegment || segments.length === 0) {
    return null;
  }
  return segments;
}

/** The escapes a quoted key can realistically carry. Anything else is left as written. */
function unescapeBasic(body: string): string {
  return body.replace(/\\(["\\])/g, "$1");
}

/** Classify every structural line in the document, skipping anything inside a multi-line string. */
function scanDocument(lines: readonly string[]): Structure[] {
  const structures: Structure[] = [];
  let state: StringState = "none";
  let table: string[] = [];

  for (const [line, text] of lines.entries()) {
    if (state === "none") {
      const trimmed = text.trim();
      if (trimmed !== "" && !trimmed.startsWith("#")) {
        if (trimmed.startsWith("[")) {
          const isArray = trimmed.startsWith("[[");
          const opening = isArray ? 2 : 1;
          const closing = indexOfHeaderClose(trimmed, opening);
          const path = closing > opening ? parseDottedKey(trimmed.slice(opening, closing)) : null;
          if (path !== null) {
            structures.push({ kind: isArray ? "array-table" : "table", path, line });
            table = path;
          }
        } else {
          const equals = indexOfAssignment(text);
          if (equals > 0) {
            const key = parseDottedKey(text.slice(0, equals));
            if (key !== null) {
              structures.push({ kind: "key", path: [...table, ...key], line });
            }
          }
        }
      }
    }
    state = scanLine(text, state);
  }
  return structures;
}

/**
 * The index of a header's closing `]`, ignoring any inside a quoted key.
 *
 * Scanning forward rather than taking the last `]` on the line is what keeps
 * `[mcp_servers.xplainer] # replaces [mcp_servers.old]` from parsing as a key path five segments
 * long — a trailing comment on a table header is ordinary, and misreading one would silently hide
 * the table this module exists to find.
 */
function indexOfHeaderClose(line: string, from: number): number {
  let index = from;
  while (index < line.length) {
    const character = line[index];
    if (character === '"' || character === "'") {
      index = endOfSingleLineString(line, index + 1, character, character === '"');
      continue;
    }
    if (character === "]") {
      return index;
    }
    index += 1;
  }
  return -1;
}

/** The index of the `=` that separates a key from its value, ignoring any inside quotes. */
function indexOfAssignment(line: string): number {
  let index = 0;
  while (index < line.length) {
    const character = line[index];
    if (character === '"' || character === "'") {
      index = endOfSingleLineString(line, index + 1, character, character === '"');
      continue;
    }
    if (character === "=") {
      return index;
    }
    if (character === "#") {
      return -1;
    }
    index += 1;
  }
  return -1;
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function isDescendant(candidate: readonly string[], ancestor: readonly string[]): boolean {
  return (
    candidate.length > ancestor.length &&
    ancestor.every((segment, index) => segment === candidate[index])
  );
}

/**
 * The lines `[<path>]` owns — its header, its keys and any sub-table beneath it — or `null`.
 *
 * The span runs to the next header that is *not* a descendant, because `[mcp_servers.xplainer.env]`
 * is part of this entry and replacing the entry without it would leave an orphaned environment
 * block attached to whatever came next. Trailing blank lines are left outside the span so that
 * replacing it keeps the separation the file already had.
 */
export function findTableSpan(lines: readonly string[], path: readonly string[]): TableSpan | null {
  const structures = scanDocument(lines);
  const headerIndex = structures.findIndex(
    (structure) => structure.kind === "table" && samePath(structure.path, path),
  );
  if (headerIndex < 0) {
    return null;
  }
  const header = structures[headerIndex];
  if (header === undefined) {
    return null;
  }

  let end = lines.length;
  for (const structure of structures.slice(headerIndex + 1)) {
    if (structure.kind === "key") {
      continue;
    }
    if (isDescendant(structure.path, path)) {
      continue;
    }
    end = structure.line;
    break;
  }
  while (end > header.line + 1 && (lines[end - 1] ?? "").trim() === "") {
    end -= 1;
  }
  return { start: header.line, end };
}

/**
 * The sentence naming a declaration of `path` that a line-oriented replacement cannot safely
 * rewrite, or `null` when there is none.
 *
 * Each of these would make an appended `[<path>]` header a **duplicate key** rather than an update,
 * and a TOML file with a duplicate key does not load at all — so the user hears about it here
 * instead of the next time their agent starts.
 */
export function findConflictingDefinition(
  lines: readonly string[],
  path: readonly string[],
): string | null {
  const dotted = path.join(".");
  for (const structure of scanDocument(lines)) {
    if (structure.kind === "array-table" && samePath(structure.path, path)) {
      return `line ${structure.line + 1} declares [[${dotted}]], an array of tables`;
    }
    if (structure.kind !== "key") {
      continue;
    }
    if (samePath(structure.path, path)) {
      return `line ${structure.line + 1} assigns ${dotted} directly, as a key rather than a table`;
    }
    if (isDescendant(path, structure.path)) {
      return (
        `line ${structure.line + 1} assigns ${structure.path.join(".")}, ` +
        `which already defines ${dotted}'s parent as a value`
      );
    }
  }
  return null;
}
