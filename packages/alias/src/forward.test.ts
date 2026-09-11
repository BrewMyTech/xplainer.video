/**
 * Finding the command this alias forwards to, and every way that can fail.
 *
 * `resolveCliBin` takes its three effects as arguments, so each case here is a
 * hand-written install: a resolver that answers or throws, a set of files, and
 * the manifest bytes at each of them. That is the only way to write the cases
 * that matter — "not installed", "installed with no manifest above the entry",
 * "manifest naming a file that is not there" — since none of them can be
 * arranged by importing this module inside a workspace where the dependency is
 * present and correct.
 *
 * The hand-over itself is asserted in `bin.test.ts`, against a real process.
 */

import { isAbsolute, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AliasRefusal, CLI_PACKAGE, type ForwardHost, resolveCliBin } from "./forward.ts";

/** An absolute directory on either platform: `isAbsolute` accepts a leading separator on Windows. */
const INSTALL = resolve(join("/", "install", "node_modules", "@xplainer", "cli"));

/** A host whose filesystem is the given map, and whose resolver answers with `entry`. */
function hostWith(files: Record<string, string>, entry: string): ForwardHost {
  return {
    resolve: () => entry,
    exists: (path) => Object.hasOwn(files, path),
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) {
        throw new Error(`${path} does not exist`);
      }
      return text;
    },
  };
}

const manifest = (extra: Record<string, unknown>): string =>
  JSON.stringify({ name: CLI_PACKAGE, version: "0.0.1", ...extra });

describe("resolveCliBin", () => {
  it("answers with the file the dependency's own manifest declares as its xplainer bin", () => {
    const entry = join(INSTALL, "dist", "index.js");
    const bin = join(INSTALL, "dist", "bin.js");
    const host = hostWith(
      {
        [join(INSTALL, "package.json")]: manifest({ bin: { xplainer: "./dist/bin.js" } }),
        [bin]: "",
      },
      entry,
    );

    expect(resolveCliBin(host)).toBe(bin);
  });

  it("accepts the string form of bin, which npm treats as the package's own name", () => {
    const entry = join(INSTALL, "dist", "index.js");
    const bin = join(INSTALL, "cli.js");
    const host = hostWith(
      { [join(INSTALL, "package.json")]: manifest({ bin: "./cli.js" }), [bin]: "" },
      entry,
    );

    expect(resolveCliBin(host)).toBe(bin);
  });

  it("walks past a nested package.json that does not name the package being looked for", () => {
    // A `{"type":"commonjs"}` marker in a subdirectory is the ordinary reason
    // for one of these, and it carries no `bin` field to read.
    const entry = join(INSTALL, "dist", "cjs", "index.js");
    const bin = join(INSTALL, "dist", "bin.js");
    const host = hostWith(
      {
        [join(INSTALL, "dist", "cjs", "package.json")]: JSON.stringify({ type: "commonjs" }),
        [join(INSTALL, "package.json")]: manifest({ bin: { xplainer: "./dist/bin.js" } }),
        [bin]: "",
      },
      entry,
    );

    expect(resolveCliBin(host)).toBe(bin);
  });

  it("refuses, naming the reinstall, when the dependency is not resolvable at all", () => {
    const host: ForwardHost = {
      resolve: () => {
        throw new Error("ERR_MODULE_NOT_FOUND");
      },
      exists: () => false,
      readFile: () => "",
    };

    expect(() => resolveCliBin(host)).toThrow(AliasRefusal);
    expect(() => resolveCliBin(host)).toThrow(/is not installed beside this command/);
  });

  it("refuses when no manifest naming the dependency sits above the resolved entry", () => {
    const entry = join(INSTALL, "dist", "index.js");

    expect(() => resolveCliBin(hostWith({}, entry))).toThrow(/no package.json naming/);
  });

  it("refuses when the manifest declares no xplainer command", () => {
    const entry = join(INSTALL, "dist", "index.js");
    const host = hostWith(
      { [join(INSTALL, "package.json")]: manifest({ bin: { other: "./dist/other.js" } }) },
      entry,
    );

    expect(() => resolveCliBin(host)).toThrow(/declares no `xplainer` command/);
  });

  it("refuses when the declared bin is not on disk, and says which path is missing", () => {
    const entry = join(INSTALL, "dist", "index.js");
    const host = hostWith(
      { [join(INSTALL, "package.json")]: manifest({ bin: { xplainer: "./dist/bin.js" } }) },
      entry,
    );

    expect(() => resolveCliBin(host)).toThrow(/is\s+not on disk/);
  });

  it("refuses on an unreadable manifest rather than guessing a layout", () => {
    const entry = join(INSTALL, "dist", "index.js");
    const host = hostWith({ [join(INSTALL, "package.json")]: "{ not json" }, entry);

    expect(() => resolveCliBin(host)).toThrow(/is not readable JSON/);
  });

  it("keeps an absolute bin path as it is", () => {
    const entry = join(INSTALL, "dist", "index.js");
    const bin = resolve(join("/", "elsewhere", "bin.js"));
    expect(isAbsolute(bin)).toBe(true);
    const host = hostWith(
      { [join(INSTALL, "package.json")]: manifest({ bin: { xplainer: bin } }), [bin]: "" },
      entry,
    );

    expect(resolveCliBin(host)).toBe(bin);
  });
});
