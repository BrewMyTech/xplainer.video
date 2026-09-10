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
 *
 * **A warm cache used to defeat verify-before-extract, and this is where that was fixed.** Until
 * 2026-09-10 this module skipped the download **and the verification** whenever its destination
 * already existed, and then recorded `sha256: entry.sha256` — the digest the manifest had merely
 * *told* it — for a tree nothing on this machine had ever checked. Worse, the destination was named
 * `speech-bundle-<version>`, so **cache identity bound the version and not the digest**: a
 * re-published artefact at an unchanged version would be served out of that cold cache for ever.
 * Both halves are closed here. The digest is in the directory name, so a manifest whose digest
 * moved names a directory that does not exist and is fetched; and a populated destination is judged
 * by `acquired.ts` against the digest **its own receipt says it was admitted on**, with a missing,
 * unreadable or disagreeing receipt a refusal rather than a free pass. Nothing in this module now
 * records a digest that was not either verified in this run or attested by a record committed
 * inside the tree by the run that did verify it.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import type { ToolchainComponent, ToolchainFile } from "@xplainer/protocol";
import { stageAcquired, verifyAcquired, witnessPath } from "../acquired.js";
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

/** How many hex characters of the digest go in the directory name — enough to be an identity. */
export const BUNDLE_DIGEST_IN_NAME = 12;

/** What one acquisition produced, in the shape `toolchain.json` records. */
export type AcquiredSpeechBundle = {
  component: ToolchainComponent;
  destination: string;
  fetched: boolean;
};

/**
 * The directory one bundle commits itself under: the version **and** the digest.
 *
 * Both, because they answer different questions. The version is what a person reads; the digest is
 * what makes the name an identity, so a re-published artefact at an unchanged version cannot be
 * served out of the cache the last one left.
 */
export function bundleDestination(toolchainDir: string, version: string, sha256: string): string {
  return join(
    toolchainDir,
    `${BUNDLE_DIR_NAME}-${version}-${sha256.slice(0, BUNDLE_DIGEST_IN_NAME)}`,
  );
}

/** A bundle is on this machine and is not the artefact the manifest describes. */
export class SpeechBundleRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeechBundleRefusal";
  }
}

/**
 * Acquire the speech bundle for this platform, or refuse with the manifest's own reason.
 *
 * The refusal for "no bundle is published for this platform" comes from `selectSpeechBundle` and
 * carries exit code `3`; it is not caught here, because the decision about what to do next belongs
 * to the caller that knows which other routes are still available. A destination that is present
 * and does not verify is a **different** refusal and deliberately not one of those: it is a fact
 * about this machine that the user has to act on, so it raises rather than falling through to the
 * next route with the evidence thrown away.
 */
export async function acquireSpeechBundle(
  options: AcquireBundleOptions,
): Promise<AcquiredSpeechBundle> {
  const log = options.log ?? ((): void => {});
  const probe = options.probe ?? probeHost();
  const platform = speechPlatformKey(probe);
  const entry = selectSpeechBundle(options.manifest, platform);
  const expectation = { url: entry.url, sha256: entry.sha256, size: entry.size };
  const destination = bundleDestination(options.toolchainDir, entry.version, entry.sha256);

  if (existsSync(destination)) {
    const verdict = verifyAcquired(destination, expectation);
    if (!verdict.ok) {
      throw new SpeechBundleRefusal(`speech: ${verdict.detail}`);
    }
    log(`speech: already acquired and verified at ${destination}`);
    return {
      component: component(destination, entry.version, entry.sha256, verdict.files),
      destination,
      fetched: false,
    };
  }

  log(`speech: ${entry.url}`);
  log(`speech: expecting sha256 ${entry.sha256}`);
  let files: readonly ToolchainFile[] = [];
  await acquireArtefact({
    request: expectation,
    destination,
    stage: (staging) => {
      // The witness is the executable, where the layout has one this build recognises: it is the
      // file a render would reach for, so it is the one worth re-hashing on a later run. A bundle
      // whose entry point this build does not know still gets a record — the archive digest in it
      // is the whole of the fix — and an empty witness list is honest about there being nothing
      // inside the tree that this build knows how to name.
      const executable = findExecutable(staging);
      const witnesses = executable === null ? [] : [witnessPath(staging, executable)];
      const record = stageAcquired(staging, expectation, witnesses);
      files = record.files.map((file) => ({
        path: join(destination, ...file.path.split("/")),
        sha256: file.sha256,
        bytes: file.bytes,
      }));
    },
  });

  return {
    component: component(destination, entry.version, entry.sha256, files),
    destination,
    fetched: true,
  };
}

/**
 * The marker entry, with `path` naming the executable where there is one.
 *
 * `sha256` is the **archive's** reviewed digest and always has been; what has changed is that it is
 * now only ever recorded after this run either verified that archive or verified the record the
 * verifying run committed inside the tree.
 */
function component(
  destination: string,
  version: string,
  sha256: string,
  files: readonly ToolchainFile[],
): ToolchainComponent {
  const executable = files[0]?.path ?? findExecutable(destination);
  return {
    version,
    path: executable ?? destination,
    sha256,
    provider: BUNDLE_PROVIDER,
    ...(files.length === 0 ? {} : { files: [...files] }),
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
