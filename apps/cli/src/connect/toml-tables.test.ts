/**
 * The structural questions a surgical edit of somebody else's `config.toml` has to answer.
 *
 * Each case here is a shape that really appears in a Codex configuration on this machine — a
 * `[projects."/Users/…"]` header whose key contains slashes and dots, an `env` sub-table under a
 * server, a comment between two tables — plus the three ways of declaring the same server that a
 * line-oriented replacement must refuse rather than duplicate. The refusals are the important half:
 * appending a second definition of one key produces a `config.toml` that does not load *at all*, so
 * a wrong answer here breaks the user's whole agent rather than just this entry.
 */

import { describe, expect, it } from "vitest";
import { findConflictingDefinition, findTableSpan, parseDottedKey } from "./toml-tables.js";

const PATH: readonly string[] = ["mcp_servers", "xplainer"];

function lines(document: string): string[] {
  return document.split("\n");
}

describe("parseDottedKey", () => {
  it("splits on unquoted dots and keeps quoted ones", () => {
    expect(parseDottedKey("mcp_servers.xplainer")).toEqual(["mcp_servers", "xplainer"]);
    expect(parseDottedKey(' projects."/Users/me/projects/acme" ')).toEqual([
      "projects",
      "/Users/me/projects/acme",
    ]);
    expect(parseDottedKey("a . b")).toEqual(["a", "b"]);
    expect(parseDottedKey("'a.b'")).toEqual(["a.b"]);
  });

  it("rejects what is not a key path", () => {
    expect(parseDottedKey("")).toBeNull();
    expect(parseDottedKey("a..b")).toBeNull();
    expect(parseDottedKey('"unterminated')).toBeNull();
  });
});

describe("findTableSpan", () => {
  it("covers the header and its keys, and stops at the next table", () => {
    const document = lines(
      [
        'model = "gpt-6"',
        "",
        "[mcp_servers.xplainer]",
        'command = "xplainer"',
        'args = ["mcp", "--attach"]',
        "",
        "[mcp_servers.other]",
        'command = "other"',
      ].join("\n"),
    );

    expect(findTableSpan(document, PATH)).toEqual({ start: 2, end: 5 });
  });

  /** A sub-table belongs to the entry: leaving it behind would attach it to whatever came next. */
  it("swallows a sub-table of the same entry", () => {
    const document = lines(
      [
        "[mcp_servers.xplainer]",
        'command = "xplainer"',
        "",
        "[mcp_servers.xplainer.env]",
        'XPLAINER_STATE_DIR = "/tmp/x"',
        "",
        "[mcp_servers.other]",
      ].join("\n"),
    );

    expect(findTableSpan(document, PATH)).toEqual({ start: 0, end: 5 });
  });

  it("runs to the end of the document when nothing follows", () => {
    const document = lines(["[mcp_servers.xplainer]", 'command = "xplainer"', "", ""].join("\n"));

    expect(findTableSpan(document, PATH)).toEqual({ start: 0, end: 2 });
  });

  it("matches a quoted header key, and misses a table that is not there", () => {
    expect(findTableSpan(lines('[mcp_servers."xplainer"]\ncommand = "x"'), PATH)).toEqual({
      start: 0,
      end: 2,
    });
    expect(findTableSpan(lines('[mcp_servers.other]\ncommand = "x"'), PATH)).toBeNull();
  });

  /** A trailing comment on a header is ordinary; reading the last `]` on the line would miss it. */
  it("reads a header that carries a trailing comment", () => {
    const document = lines('[mcp_servers.xplainer] # replaces [mcp_servers.old]\ncommand = "x"');

    expect(findTableSpan(document, PATH)).toEqual({ start: 0, end: 2 });
  });

  /** A `[` at the start of a line inside a `"""` value is a character, not a table. */
  it("does not see a table header inside a multi-line string", () => {
    const document = lines(
      [
        'instructions = """',
        "[mcp_servers.xplainer]",
        'do not read this as a table"""',
        "",
        "[mcp_servers.other]",
      ].join("\n"),
    );

    expect(findTableSpan(document, PATH)).toBeNull();
  });
});

describe("findConflictingDefinition", () => {
  it("passes an ordinary document, including one that already has the table", () => {
    expect(findConflictingDefinition(lines('model = "gpt-6"'), PATH)).toBeNull();
    expect(
      findConflictingDefinition(lines('[mcp_servers.xplainer]\ncommand = "xplainer"'), PATH),
    ).toBeNull();
    expect(
      findConflictingDefinition(lines('[mcp_servers]\nother = { command = "o" }'), PATH),
    ).toBeNull();
  });

  it("names a dotted key that already assigns the same name", () => {
    const found = findConflictingDefinition(
      lines('model = "gpt-6"\nmcp_servers.xplainer = { command = "x" }'),
      PATH,
    );

    expect(found).toContain("line 2");
    expect(found).toContain("as a key rather than a table");
  });

  it("names an inline parent that already defines this entry as a value", () => {
    const found = findConflictingDefinition(
      lines('mcp_servers = { xplainer = { command = "x" } }'),
      PATH,
    );

    expect(found).toContain("already defines");
    expect(found).toContain("parent");
  });

  it("names an entry inside an [mcp_servers] table", () => {
    const found = findConflictingDefinition(
      lines('[mcp_servers]\nxplainer = { command = "x" }'),
      PATH,
    );

    expect(found).toContain("line 2");
  });

  it("names an array of tables", () => {
    const found = findConflictingDefinition(lines('[[mcp_servers.xplainer]]\ncommand = "x"'), PATH);

    expect(found).toContain("array of tables");
  });
});
