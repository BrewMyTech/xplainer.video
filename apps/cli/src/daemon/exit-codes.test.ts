/**
 * The rule `exit-codes.ts`'s own docblock states, asserted rather than trusted.
 *
 * "Exit codes are a documented table … a new code is added to the table and to the ADR that owns it
 * — never invented at the call site." Both halves are checkable, and neither was checked before:
 * `check:docs-contract` reads headings and not table rows, and nothing at all read the call sites.
 * So this file does the two greps a reviewer would otherwise have to remember to do — every code
 * this package can exit with has a row in `docs/ARCHITECTURE.md` §6, and no command mints one by
 * writing a number into `exit(...)`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NOT_IMPLEMENTED_EXIT_CODE } from "../not-implemented.js";
import * as exitCodes from "./exit-codes.js";

const SRC = fileURLToPath(new URL("../", import.meta.url));
const ARCHITECTURE = fileURLToPath(new URL("../../../../docs/ARCHITECTURE.md", import.meta.url));

/** The files that are allowed to hold a bare exit-code literal: the two that define them. */
const DEFINING_FILES = new Set(["daemon/exit-codes.ts", "not-implemented.ts"]);

/** Every `.ts` under `apps/cli/src`, as paths relative to it, tests excluded. */
function sourceFiles(directory: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...sourceFiles(join(directory, entry.name), relative));
      continue;
    }
    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      found.push(relative);
    }
  }
  return found;
}

/** The codes the table in `docs/ARCHITECTURE.md` §6 documents, read out of its rows. */
function documentedCodes(): number[] {
  const rows = readFileSync(ARCHITECTURE, "utf8").matchAll(/^\| `(\d+)` \|/gm);
  return [...rows].map((row) => Number(row[1]));
}

describe("the exit-code table", () => {
  it("has a row for every code this package can exit with", () => {
    const documented = documentedCodes();
    expect(documented.length).toBeGreaterThan(5);

    const minted: [string, number][] = [
      ...Object.entries(exitCodes),
      ["NOT_IMPLEMENTED_EXIT_CODE", NOT_IMPLEMENTED_EXIT_CODE],
    ];
    const undocumented = minted.filter(([, code]) => !documented.includes(code));

    expect(undocumented).toEqual([]);
    expect(exitCodes.USAGE_EXIT_CODE).toBe(1);
  });

  /**
   * The failure this catches is the one that actually happened: `io.exit(1)` written inline in
   * `serve` and `status`, and a third `const USAGE_EXIT_CODE = 1` beside `connect`'s call sites,
   * for a code the table had no row for. A literal handed to `exit()` is only allowed to be a code
   * §6 documents, which is the difference between reusing a row and minting one.
   *
   * A worker child's own `process.exitCode` is deliberately out of scope: that number becomes the
   * job record's `exit_code`, which is a fact about a render, not a row in the CLI's table.
   */
  it("lets no command exit with a code the table has no row for", () => {
    const documented = documentedCodes();
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (DEFINING_FILES.has(file)) {
        continue;
      }
      const source = readFileSync(join(SRC, file), "utf8");
      for (const match of source.matchAll(/\b(?:io\.exit|process\.exit)\(\s*(\d+)\s*\)/g)) {
        const code = Number(match[1]);
        if (!documented.includes(code)) {
          offenders.push(`${file}: ${match[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The one distinction a reader gets wrong on their own: `7` and `10` are the same symptom seen at
   * two different moments, and the table has to say which is which or the pair is worse than one
   * code would have been. Asserted against the rows rather than against a docblock, because the
   * table is what an operator reads.
   */
  it("says which of `7` and `10` is the install and which is the start", () => {
    const table = readFileSync(ARCHITECTURE, "utf8");
    const rowFor = (code: number): string =>
      table.match(new RegExp(`^\\| \`${code}\` \\|.*$`, "m"))?.[0] ?? "";

    expect(rowFor(7)).toContain("Install-time preflight");
    expect(rowFor(7)).toContain("INSTALL_CONFLICT_EXIT_CODE");
    expect(rowFor(10)).toContain("`serve`-time ownership");
    expect(rowFor(10)).toContain("OWNERSHIP_REFUSED_EXIT_CODE");
    expect(rowFor(5)).toContain("ADMIN_REQUIRED_EXIT_CODE");
    expect(rowFor(6)).toContain("NO_SUPERVISOR_EXIT_CODE");

    expect([
      exitCodes.ADMIN_REQUIRED_EXIT_CODE,
      exitCodes.NO_SUPERVISOR_EXIT_CODE,
      exitCodes.INSTALL_CONFLICT_EXIT_CODE,
      exitCodes.OWNERSHIP_REFUSED_EXIT_CODE,
    ]).toEqual([5, 6, 7, 10]);
  });
});
