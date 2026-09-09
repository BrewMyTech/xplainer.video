/**
 * The `bundle` speech provider: the manifest's own archive, verified by `sha256`.
 *
 * This is the route for a machine with no Docker — the one ADR 0005 describes when it books "a CDN
 * and a version/checksum manifest" as infrastructure — and it is the only speech route whose bytes
 * this project publishes. The manifest's speech entries are therefore constrained twice, in
 * `manifest.ts`: they must be served from `cdn.<zone_name>`, the proxied hostname
 * `infra/terraform` provisions, and each carries a reviewed digest captured when the manifest was
 * built.
 *
 * **A platform with no published bundle is a sentence, not a hole.** The manifest is required to
 * carry an entry for every supported platform even when that entry says "nothing is published
 * yet" — which, in this phase, is all four of them (§2.5: nothing is published to R2). So the
 * refusal a user meets here is the manifest's own recorded reason, quoted, rather than a missing
 * key discovered at the moment of use.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import type { ToolchainComponent } from "@xplainer/protocol";
import { acquireArtefact } from "../download.js";
import {
  type HostProbe,
  probeHost,
  selectSpeechBundle,
  speechPlatformKey,
  type ToolchainManifest,
} from "../manifest.js";

/** The `provider` token the marker records for this route. */
export const BUNDLE_PROVIDER = "bundle";

/** The directory name, under the toolchain directory, one acquisition commits itself to. */
export const BUNDLE_DIR_NAME = "speech-bundle";

/**
 * The executable names a speech bundle unpacks to.
 *
 * Searched for rather than assumed, for the same reason the Chrome provider searches: the recorded
 * path is checked for existence by the install preflight, so a path that was guessed is a marker
 * that fails a check it should have passed.
 */
export const BUNDLE_EXECUTABLE_NAMES: readonly string[] = [
  "kokoro-fastapi",
  "kokoro-fastapi.exe",
  "kokoro",
  "kokoro.exe",
];

/** What {@link acquireSpeechBundle} was asked to do. */
export type AcquireBundleOptions = {
  manifest: ToolchainManifest;
  /** Where acquisitions live on this machine — `<state>/toolchain`, as `setup` resolves it. */
  toolchainDir: string;
  probe?: HostProbe | undefined;
  log?: (line: string) => void;
};

/** What one acquisition produced, in the shape `toolchain.json` records. */
export type AcquiredSpeechBundle = {
  component: ToolchainComponent;
  destination: string;
  fetched: boolean;
};

/**
 * Acquire the speech bundle for this platform, or refuse with the manifest's own reason.
 *
 * The refusal for "no bundle is published for this platform" comes from `selectSpeechBundle` and
 * carries exit code `3`; it is not caught here, because the decision about what to do next belongs
 * to the caller that knows whether Docker or `--tts-url` is still available.
 */
export async function acquireSpeechBundle(
  options: AcquireBundleOptions,
): Promise<AcquiredSpeechBundle> {
  const log = options.log ?? ((): void => {});
  const probe = options.probe ?? probeHost();
  const platform = speechPlatformKey(probe);
  const entry = selectSpeechBundle(options.manifest, platform);
  const destination = join(options.toolchainDir, `${BUNDLE_DIR_NAME}-${entry.version}`);

  let fetched = false;
  if (existsSync(destination)) {
    log(`speech: already acquired at ${destination}`);
  } else {
    log(`speech: ${entry.url}`);
    log(`speech: expecting sha256 ${entry.sha256}`);
    await acquireArtefact({
      request: { url: entry.url, sha256: entry.sha256, size: entry.size },
      destination,
    });
    fetched = true;
  }

  return {
    component: {
      version: entry.version,
      path: findExecutable(destination) ?? destination,
      sha256: entry.sha256,
      provider: BUNDLE_PROVIDER,
    },
    destination,
    fetched,
  };
}

/**
 * The speech executable inside an unpacked bundle, or `null`.
 *
 * `null` is a usable answer here and is not in the Chrome provider: a bundle whose entry point this
 * build does not recognise is still a tree whose existence the preflight can check, so the caller
 * records the directory. A browser with no executable in it is not, because Remotion is handed that
 * one path and nothing else.
 */
export function findExecutable(root: string, depth = 3): string | null {
  if (depth < 0 || !existsSync(root)) {
    return null;
  }
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && BUNDLE_EXECUTABLE_NAMES.includes(entry.name)) {
      const candidate = join(root, entry.name);
      if (process.platform === "win32" || (statSync(candidate).mode & 0o111) !== 0) {
        return candidate;
      }
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = findExecutable(join(root, entry.name), depth - 1);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}
