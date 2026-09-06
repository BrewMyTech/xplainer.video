/**
 * Let a spawned `node` run this package's TypeScript sources directly.
 *
 * Several of the properties this story has to prove are only true of a **real** process: a record
 * that survives `SIGKILL`, a second `serve` that exits `10` having written nothing, an orphaned
 * worker whose group is torn down by the next boot. Vitest runs in one process, so those tests have
 * to spawn children — and a child cannot simply `import` a `.ts` file that says `./job-store.js`,
 * because Node's type stripping resolves specifiers literally.
 *
 * The alternative was to spawn `node dist/…`, which would make the suite depend on a build:
 * `turbo.json` gives `test` a `dependsOn` of `^build` — the *dependencies'* builds, not this
 * package's own — so `dist/` may be absent or stale when the tests run, and a stale one is a green
 * test over code that is not the code.
 *
 * So: `node --import ./ts-source-hook.ts <entry>.ts`. `module.registerHooks` (Node ≥ 22.15) rewrites
 * a relative `./x.js` specifier to `./x.ts`, and Node's own type stripping — unflagged since 23.6
 * and on by default in the 24 this repository pins — does the rest. Nothing here needs a transform:
 * `@xplainer/config`'s base preset sets `erasableSyntaxOnly`, so no source in this workspace
 * contains syntax that stripping cannot erase.
 *
 * **The rewrite is confined to this package's own `src/`, by the importer's path.** Every dependency
 * in `node_modules` is JavaScript that means `./x.js` literally — commander's `index.js` imports
 * `./lib/argument.js`, and rewriting that asks Node for a file nobody wrote. Checking the parent
 * rather than only the target is what keeps the hook from reaching outside the tree it is here for.
 */

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

/** `apps/cli/src/`, derived from this file's own location rather than from a hard-coded depth. */
const PACKAGE_SOURCE_ROOT = new URL("../../", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL;
    if (
      parent?.startsWith(PACKAGE_SOURCE_ROOT) === true &&
      specifier.startsWith(".") &&
      specifier.endsWith(".js")
    ) {
      const asTypeScript = `${specifier.slice(0, -".js".length)}.ts`;
      const resolved = new URL(asTypeScript, parent);
      if (existsSync(fileURLToPath(resolved))) {
        return nextResolve(asTypeScript, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
