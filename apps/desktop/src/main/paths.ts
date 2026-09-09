/**
 * Where the packaged application finds payload 1, and what it spawns out of it.
 *
 * The app ships the `xplainer runtime build` artefact as an **`extraResources` payload** rather
 * than relying on the injected `node_modules` copy alone. Two rules force that placement and both
 * are ADRs rather than preferences:
 *
 *   * **Nothing is spawned from inside `app.asar`** (ADR 0004, ADR 0005). Electron patches `fs` so
 *     a child process *can read* the archive, but it cannot `execve` a file that has no path on the
 *     filesystem — and the payload's whole point is an interpreter that is executed. `extraResources`
 *     puts the payload beside the archive, not inside it.
 *   * **The payload is a directory, not a package.** A payload defined as "the `@xplainer/cli`
 *     directory" omits the interpreter, npm and the workspace packages the runtime reads, which is
 *     what `extraResources: [{ from: ../../.artefacts/xplainer-runtime }]` ships whole.
 *
 * Every path below is derived from Electron's own **`process.resourcesPath`**, which is the same
 * directory on all three platforms without deriving it from `appPath`:
 *
 * | Platform | `process.resourcesPath` | This module's payload root |
 * |---|---|---|
 * | macOS | `<app>.app/Contents/Resources` | `<app>.app/Contents/Resources/xplainer-runtime/` |
 * | Linux | `<dir>/resources` | `<dir>/resources/xplainer-runtime/` |
 * | Windows | `<dir>\resources` | `<dir>\resources\xplainer-runtime\` |
 *
 * The functions take the resources path and the platform as arguments rather than reading
 * `process`, so all three shapes are assertable from one `vitest` run on one machine — the reason
 * round 2's macOS-only derivation was scheduled on three runners and could only ever have been
 * checked on one. `node:path`'s `join` follows the *host*, so the flavour is selected explicitly:
 * a Windows layout is composed with backslashes even when the assertion runs on macOS.
 *
 * The payload-relative constants are the other half of {@link ../../../cli/src/runtime/manifest.ts}'s
 * `LaunchContract` — `bin/node`, `lib/node_modules/@xplainer/cli/dist/bin.js` — and `spawn.ts`
 * compares what it derives here against what the payload's own manifest records, so a payload whose
 * layout moved is named as a layout mismatch instead of failing later inside `spawn`.
 */

import { posix, win32 } from "node:path";
import process from "node:process";

/**
 * The `extraResources` destination.
 *
 * Must equal the `to:` value in `apps/desktop/electron-builder.yml`. It is the one string this
 * module and the packaging configuration have to agree on.
 */
export const PACKAGED_PAYLOAD_DIRECTORY = "xplainer-runtime";

/**
 * Payload 1's manifest file, at the payload root.
 *
 * Must equal `RUNTIME_MANIFEST_FILE` in `apps/cli/src/runtime/manifest.ts`. It is duplicated rather
 * than imported because the packaged app reads this file **before** it is willing to run anything
 * out of the payload: importing the constant from `@xplainer/cli` would make the check that decides
 * whether the payload is usable depend on the copy of the CLI inside the archive.
 */
export const RUNTIME_MANIFEST_FILE = "runtime.manifest.json";

/** Where payload 1 puts the interpreter, payload-relative. `PAYLOAD_BIN_DIR` in the assembler. */
const PAYLOAD_BIN_DIR = "bin";

/** Where payload 1 puts every package, payload-relative. `PAYLOAD_LIB_DIR` in the assembler. */
const PAYLOAD_LIB_DIR = "lib/node_modules";

/**
 * The CLI entry inside the payload, payload-relative and `/`-separated.
 *
 * This is `LaunchContract.entry` as `runtime build` records it, and it is the file every one of
 * D10's pre-install commands is run as — never a `bin/xplainer` shim, which is a symlink on POSIX
 * and a generated `.cmd` on Windows and exists to be found on a `PATH` the payload deliberately
 * does not provide.
 */
export const PAYLOAD_CLI_ENTRY = `${PAYLOAD_LIB_DIR}/@xplainer/cli/dist/bin.js`;

/** Every absolute path the packaged app needs to run its payload. */
export type PackagedPayloadLayout = {
  /** The payload directory itself. */
  root: string;
  /** The interpreter to spawn — `bin/node`, or `bin\node.exe` on Windows. */
  interpreter: string;
  /** The CLI entry to run under it. */
  entry: string;
  /** The manifest that says which host the payload was built for. */
  manifest: string;
};

/** The interpreter's payload-relative path, which is the only per-platform name in the payload. */
export function payloadInterpreterEntry(platform: NodeJS.Platform = process.platform): string {
  return `${PAYLOAD_BIN_DIR}/${platform === "win32" ? "node.exe" : "node"}`;
}

/**
 * The payload directory inside a packaged application.
 *
 * `resourcesPath` is Electron's `process.resourcesPath` and nothing else: `app.getAppPath()` points
 * *into* the archive, so a payload derived from it would name a path no `execve` can reach.
 */
export function packagedPayloadRoot(
  resourcesPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return pathsFor(platform).join(resourcesPath, PACKAGED_PAYLOAD_DIRECTORY);
}

/** The payload's own interpreter: `bin/node` on POSIX, `bin\node.exe` on Windows. */
export function packagedInterpreter(
  payloadRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return pathsFor(platform).join(payloadRoot, ...payloadInterpreterEntry(platform).split("/"));
}

/** The CLI entry inside the payload, absolute. */
export function packagedCliEntry(
  payloadRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return pathsFor(platform).join(payloadRoot, ...PAYLOAD_CLI_ENTRY.split("/"));
}

/** Payload 1's manifest, absolute. */
export function packagedRuntimeManifest(
  payloadRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return pathsFor(platform).join(payloadRoot, RUNTIME_MANIFEST_FILE);
}

/** All four paths at once, which is what a caller about to spawn actually wants. */
export function packagedPayloadLayout(
  resourcesPath: string,
  platform: NodeJS.Platform = process.platform,
): PackagedPayloadLayout {
  const root = packagedPayloadRoot(resourcesPath, platform);
  return {
    root,
    interpreter: packagedInterpreter(root, platform),
    entry: packagedCliEntry(root, platform),
    manifest: packagedRuntimeManifest(root, platform),
  };
}

/** The `node:path` flavour a platform composes paths with, so a host's separator is never assumed. */
function pathsFor(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}
