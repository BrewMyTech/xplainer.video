/**
 * Where the real command is, and the one rule for finding it.
 *
 * This package is a name, not a program: `xplainer` on npm is an alias for
 * `@xplainer/cli`, pinned to the exact same version, and the whole of its
 * behaviour is to hand over to that package's own `bin`. This module answers
 * the only question that hand-over has to get right — *which file* — and it
 * answers it out of the dependency's **own manifest** rather than by guessing a
 * path inside it.
 *
 * WHY THE MANIFEST AND NOT A PATH. `@xplainer/cli`'s published `exports` map
 * carries `"."` and nothing else, so a subpath import of its binary
 * (`@xplainer/cli/bin`) is not resolvable and cannot be made resolvable
 * retroactively: 0.0.1 is on the registry and immutable. What *is* resolvable is
 * `"."`, which lands inside the package (`dist/index.js` today). Deriving
 * `dist/bin.js` from that by string surgery would encode a layout this package
 * does not own; reading `bin["xplainer"]` out of the manifest beside it asks the
 * dependency where its own entry is, which is the same field npm reads when it
 * links the command. The two cannot disagree.
 *
 * Every failure here is a refusal with a sentence that names the fix, because
 * the only way this can fail is a broken or partial install and the user needs
 * to be told which.
 */

import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";

/**
 * The package this command is an alias for.
 *
 * `package.json` pins it to one exact version (`workspace:0.0.1`, rewritten to
 * `0.0.1` when the tarball is built), so there is never a range to reason about:
 * `xplainer@X` forwards to `@xplainer/cli@X`.
 */
export const CLI_PACKAGE = "@xplainer/cli";

/**
 * The command name, which both manifests declare.
 *
 * npm links this package's `bin.xplainer` as `xplainer`, and the package it
 * forwards to declares its own entry under the same key. Reading that key is
 * what makes the alias hand over to the file npm itself would have run.
 */
export const BIN_NAME = "xplainer";

/**
 * The exit code for a refusal from this forwarder.
 *
 * It is `70` — "anything else" in the exit-code table
 * (`docs/ARCHITECTURE.md` §6) — and this package deliberately invents no code
 * of its own. Every other row in that table belongs to something `@xplainer/cli`
 * decided, and a refusal here means the CLI never ran at all, so borrowing one
 * of its codes would say something specific and false. `70` is the one row that
 * says only "this was not one of the outcomes anybody planned for", which is
 * exactly what a broken install is.
 */
export const REFUSAL_EXIT_CODE = 70;

/** A refusal: the CLI this command forwards to could not be located or run. */
export class AliasRefusal extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AliasRefusal";
  }
}

/**
 * The three effects {@link resolveCliBin} needs, as arguments.
 *
 * `resolve` is `import.meta.resolve` narrowed to a filesystem path, and it is a
 * seam for the same reason the rest of this repository takes its environment as
 * an argument: the failure modes worth testing are "not installed", "installed
 * but no manifest" and "manifest names a file that is not there", and none of
 * them can be arranged by importing this module.
 */
export interface ForwardHost {
  /** Resolve a package specifier to an absolute path inside that package. Throws if absent. */
  resolve(specifier: string): string;
  /** Whether a path exists on disk. */
  exists(path: string): boolean;
  /** Read a file as UTF-8. Throws if absent or unreadable. */
  readFile(path: string): string;
}

/** One property of an unknown value, without asserting anything about its shape. */
function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }
  return Reflect.get(value, key);
}

/**
 * The absolute path of the file `@xplainer/cli` declares as its `xplainer` bin.
 *
 * @throws AliasRefusal with a sentence naming the fix.
 */
export function resolveCliBin(host: ForwardHost): string {
  let entry: string;
  try {
    entry = host.resolve(CLI_PACKAGE);
  } catch {
    throw new AliasRefusal(
      `${CLI_PACKAGE} is not installed beside this command, so there is nothing to forward to. ` +
        `It is the single dependency of the \`${BIN_NAME}\` package; reinstall with ` +
        `\`npm i -g ${BIN_NAME}\`, or install ${CLI_PACKAGE} directly.`,
    );
  }

  const root = packageRootOf(host, entry);
  const manifestPath = join(root, "package.json");
  const manifest = parseManifest(host.readFile(manifestPath), manifestPath);
  const declared = binEntry(field(manifest, "bin"), manifestPath);
  const binPath = isAbsolute(declared) ? declared : resolvePath(root, declared);

  if (!host.exists(binPath)) {
    throw new AliasRefusal(
      `${manifestPath} declares its \`${BIN_NAME}\` command as ${declared}, and ${binPath} is ` +
        `not on disk. The ${CLI_PACKAGE} install is incomplete; reinstall it.`,
    );
  }
  return binPath;
}

/**
 * Walk up from a file inside the package to the directory holding its manifest.
 *
 * The resolved entry point is wherever that package's `exports` map points, so
 * the number of directories to climb is the dependency's business and not
 * something to hard-code. The climb stops at the first `package.json` that
 * names the package being looked for — never at the first `package.json` of any
 * kind, because a package may carry a nested one (an ESM/CJS `type` marker in a
 * subdirectory is the common case) and that file has no `bin` field.
 */
function packageRootOf(host: ForwardHost, entry: string): string {
  let directory = dirname(entry);
  for (;;) {
    const candidate = join(directory, "package.json");
    if (host.exists(candidate)) {
      const manifest = parseManifest(host.readFile(candidate), candidate);
      if (field(manifest, "name") === CLI_PACKAGE) {
        return directory;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new AliasRefusal(
        `${CLI_PACKAGE} resolved to ${entry}, and no package.json naming ${CLI_PACKAGE} sits ` +
          "above it. That install is not one this command can read; reinstall " +
          `\`${BIN_NAME}\`.`,
      );
    }
    directory = parent;
  }
}

function parseManifest(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new AliasRefusal(
      `${path} is not readable JSON (${error instanceof Error ? error.message : String(error)}), ` +
        `so ${CLI_PACKAGE}'s own entry point cannot be read.`,
    );
  }
}

/**
 * The `bin` field, in either of the two forms npm accepts, narrowed to the one
 * command this package is an alias for.
 */
function binEntry(bin: unknown, manifestPath: string): string {
  if (typeof bin === "string") {
    return bin;
  }
  const named = field(bin, BIN_NAME);
  if (typeof named === "string") {
    return named;
  }
  throw new AliasRefusal(
    `${manifestPath} declares no \`${BIN_NAME}\` command, so this alias has nothing to forward ` +
      `to. It is pinned to one exact version of ${CLI_PACKAGE}; an install that disagrees with ` +
      "that pin is the thing to fix.",
  );
}
