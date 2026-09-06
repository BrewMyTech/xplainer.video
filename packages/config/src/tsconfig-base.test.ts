import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `tsconfig/base.json` is the only file in this package that is read as *data*
 * rather than compiled, and nothing else in the repository parses it. `tsc`
 * reads tsconfig as JSONC and accepts `//`, so without this file the invariant
 * in `AGENTS.md` — "carries no comments, because it is parsed as strict JSON" —
 * would be a claim with no gate behind it, and AC-15a and AC-15d would be
 * assertions only a human ever executed.
 *
 * `JSON.parse` is the whole comment check: a `//` line makes it throw, and the
 * throw is the failing test. The flag lists below are AC-15a's ten and AC-15d's
 * one; they are here rather than in a comment because a compiler flag silently
 * dropped from a shared preset turns a rule off for every member at once, which
 * is exactly the change that should not be able to pass unnoticed.
 */

const BASE_CONFIG_PATH = fileURLToPath(new URL("../tsconfig/base.json", import.meta.url));

/** AC-15a, the eight it turns on. `strict` is asserted separately, as its own line. */
const REQUIRED_ENABLED = [
  "noUncheckedIndexedAccess",
  "exactOptionalPropertyTypes",
  "noImplicitOverride",
  "noImplicitReturns",
  "noFallthroughCasesInSwitch",
  "erasableSyntaxOnly",
  "noUnusedLocals",
  "noUnusedParameters",
] as const;

/** AC-15a, the two of its ten that are `false` rather than `true`. */
const REQUIRED_DISABLED = ["allowUnreachableCode", "allowUnusedLabels"] as const;

/** AC-15d: absent on purpose. ADR 0026 records the argument. */
const REQUIRED_ABSENT = ["noPropertyAccessFromIndexSignature"] as const;

interface BaseConfig {
  readonly compilerOptions?: Record<string, unknown>;
}

function readBaseConfig(): BaseConfig {
  return JSON.parse(readFileSync(BASE_CONFIG_PATH, "utf8")) as BaseConfig;
}

describe("tsconfig/base.json", () => {
  it("parses as strict JSON, so a comment in it is a failing gate", () => {
    expect(() => readBaseConfig()).not.toThrow();
  });

  it("declares compilerOptions", () => {
    expect(readBaseConfig().compilerOptions).toBeTypeOf("object");
  });

  it("sets strict", () => {
    expect(readBaseConfig().compilerOptions?.strict).toBe(true);
  });

  it.each(REQUIRED_ENABLED)("turns %s on (AC-15a)", (flag) => {
    expect(readBaseConfig().compilerOptions?.[flag]).toBe(true);
  });

  it.each(REQUIRED_DISABLED)("turns %s off (AC-15a)", (flag) => {
    expect(readBaseConfig().compilerOptions?.[flag]).toBe(false);
  });

  it.each(REQUIRED_ABSENT)("leaves %s unset (AC-15d)", (flag) => {
    const options = readBaseConfig().compilerOptions ?? {};
    expect(Object.hasOwn(options, flag)).toBe(false);
  });
});
