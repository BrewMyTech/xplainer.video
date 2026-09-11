/**
 * The directory layout `npm i -g xplainer` actually produces, as a fixture.
 *
 * **npm does not hoist here, and that is the whole reason this fixture exists.** A global install of
 * the unscoped alias leaves `@xplainer/cli` *nested* inside the alias's own `node_modules` rather
 * than beside it — measured against a real `npm install -g` into a temp prefix, where
 * `lib/node_modules/xplainer` is the sole top-level entry and all 102 dependencies sit under it. So
 * anything resolving a global install has to walk *through* the alias to the package that carries
 * the daemon, and a fixture that hoisted would quietly assert the opposite.
 *
 * The alias's own `bin` is a decoy on purpose: it is a forwarder with no daemon in it, so a resolver
 * that treated it as the entry would register a supervisor pointing at a file that exits
 * immediately. Tests assert the entry is the CLI's, which only means something because this layout
 * makes the wrong answer available.
 *
 * Lives in `testing/` because `tsconfig.build.json` excludes `src/**\/testing/**`, so it is
 * type-checked and linted and never compiled into `dist/` or shipped.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What {@link writeInstalledPackage} was asked to lay out. */
export type InstalledPackageOptions = {
  /** The directory that will hold `node_modules/`, as an npm prefix's `lib` does. */
  root: string;
  /** The version both manifests declare. */
  version: string;
  /**
   * The CLI entry's source.
   *
   * Defaults to a file that exits `0` immediately, which is enough for anything that only resolves
   * or assembles. A caller whose install runs to a health check has to pass a real miniature daemon
   * — `testing/payload.ts`'s `entrySource` — because a payload whose entry never binds registers
   * and starts fine and then fails the health check, which is a confusing way to learn that the
   * daemon was never a daemon.
   */
  entry?: string | undefined;
};

/** Where the alias landed: the directory an assembler takes as its `repoRoot`. */
export function writeInstalledPackage(options: InstalledPackageOptions): string {
  const aliasDir = join(options.root, "node_modules", "xplainer");
  const cliDir = join(aliasDir, "node_modules", "@xplainer", "cli");
  mkdirSync(join(cliDir, "dist"), { recursive: true });
  mkdirSync(join(aliasDir, "dist"), { recursive: true });

  writeFileSync(
    join(aliasDir, "package.json"),
    JSON.stringify({
      name: "xplainer",
      version: options.version,
      bin: { xplainer: "./dist/bin.js" },
      dependencies: { "@xplainer/cli": options.version },
      files: ["dist/**/*.js"],
    }),
  );
  writeFileSync(join(aliasDir, "dist", "bin.js"), "// the alias forwarder, not the daemon\n");

  writeFileSync(
    join(cliDir, "package.json"),
    JSON.stringify({
      name: "@xplainer/cli",
      version: options.version,
      bin: { xplainer: "./dist/bin.js" },
      files: ["dist/**/*.js"],
    }),
  );
  writeFileSync(
    join(cliDir, "dist", "bin.js"),
    options.entry ?? "#!/usr/bin/env node\nprocess.exit(0);\n",
  );

  return aliasDir;
}
