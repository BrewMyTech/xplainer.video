/**
 * Where `@xplainer/render-core`'s `template/` directory is, on the machine this is running on.
 *
 * **One function, and it has its own module for a boundary reason.** It was exported from
 * `runtime/assemble.ts`, which put the 146 MB assembler into the import closure of everything that
 * needed to find the template — including `runtime/verify.ts`, which writes nothing and is imported
 * by `install/program.ts`, whose whole contract is that asking it a question costs nothing. Moving
 * it to `runtime/manifest.ts` fixed that and created a smaller wrong: that module owns the two
 * payload *manifests*, ~20 modules import it, and locating somebody else's template is not a fact
 * about a manifest. So it lives here, where both readers — `runtime/verify.ts` and
 * `setup/providers/workspace.ts` — can take it without taking anything else.
 */

import { createRequire } from "node:module";
import { dirname } from "node:path";

/**
 * `@xplainer/render-core`'s `template/` directory, wherever this CLI is running from.
 *
 * Resolved through the package's own `exports` rather than by walking up from this file, because
 * the two places this runs are a checkout and an assembled payload, and only the module resolver
 * knows both layouts. `render-core`'s `files` allowlist ships `template`, so the directory exists
 * in a published copy exactly as it does in the checkout.
 */
export function templateDirectory(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve("@xplainer/render-core/template/package.json"));
}
