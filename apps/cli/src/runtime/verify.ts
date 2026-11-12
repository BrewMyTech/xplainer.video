/**
 * `runtime verify`: is this directory still the payload its manifest describes?
 *
 * The check is deliberately ordered, and it stops at the **first** mismatch and names it. A
 * verifier that prints thirty thousand differences has told a reader nothing they can act on; a
 * verifier that names one path has.
 *
 * The order is the order in which a failure invalidates the ones after it:
 *
 * 1. **The manifest itself** — absent, unreadable, or not the document it claims to be.
 * 2. **The host.** `runtime build` copies `process.execPath`, so the payload carries the build
 *    host's own native interpreter and architecture. A payload built elsewhere is refused
 *    **before** anything is hashed, because every hash in it would match and the payload would
 *    still not run. This is what turns §1.3d B's dropped x64 mac artefact from a spawn error on a
 *    user's Intel Mac into a named refusal.
 * 3. **The paths.** No manifest path may be absolute or escape the payload — the rule the assembler
 *    enforces on the way in, re-checked on the way out, because a manifest is a file and files are
 *    edited.
 * 4. **The contents**, in sorted path order: present, a regular file, the recorded size, the
 *    recorded hash; then every symlink by its unresolved target.
 * 5. **Anything extra.** A file in the tree that the manifest does not describe is a mismatch: "the
 *    payload is exactly what was assembled" is the property, not "the payload contains what was
 *    assembled". Nothing but `runtime build` and `install stage` ever write inside a runtime
 *    payload, so an extra file there is a real integrity failure.
 *
 * There used to be a second, more tolerant mode for payload 2 — a live render workspace whose
 * manifest described only its install — and a comparison of that manifest's resolved versions with
 * the template's pins. Both left with the payload (ADR 0031 §Note, 2026-11-12, D7).
 */

import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
  hashFile,
  isPayloadPath,
  listTree,
  type ManifestFile,
  type ManifestLink,
  RUNTIME_MANIFEST_FILE,
  type RuntimeManifest,
  readRuntimeManifest,
  toPayloadPath,
} from "./manifest.js";

/** Why a payload failed to verify. One value per distinguishable condition, never a catch-all. */
export type VerifyFailureReason =
  | "manifest-unreadable"
  | "wrong-platform"
  | "wrong-arch"
  | "absolute-path"
  | "missing"
  | "not-a-file"
  | "resized"
  | "changed"
  | "link-missing"
  | "link-changed"
  | "unexpected";

/** The one mismatch a failed verification reports. */
export type VerifyFailure = {
  reason: VerifyFailureReason;
  /** What is wrong, by name: a payload path, the manifest file, or the platform or arch built for. */
  name: string;
  /** One sentence a reader can act on. */
  detail: string;
};

/**
 * What one verification found.
 *
 * A discriminated union rather than a record with a nullable field, so a caller that has checked
 * `ok` has the failure without a fallback: "it did not verify and there is no reason" is not a
 * state this module can be in, and the type is where that is said.
 */
export type VerifyReport =
  | {
      ok: true;
      /** How many manifest entries were examined. */
      checked: number;
      failure: null;
    }
  | {
      ok: false;
      /** How many manifest entries were examined before the answer was known. */
      checked: number;
      /** The first mismatch, in path order. */
      failure: VerifyFailure;
    };

/** Re-hash payload 1 against its own manifest. */
export function verifyRuntimePayload(payloadDir: string): VerifyReport {
  let manifest: RuntimeManifest;
  try {
    manifest = readRuntimeManifest(payloadDir);
  } catch (error) {
    return unreadable(join(payloadDir, RUNTIME_MANIFEST_FILE), error);
  }
  const host = checkHost(manifest.platform, manifest.arch, "runtime payload");
  if (host !== null) {
    return { ok: false, checked: 0, failure: host };
  }
  return verifyTree(payloadDir, manifest.files, manifest.links, RUNTIME_MANIFEST_FILE);
}

/** The manifest is missing, unparseable, or not the document it claims to be. */
function unreadable(file: string, error: unknown): VerifyReport {
  return {
    ok: false,
    checked: 0,
    failure: {
      reason: "manifest-unreadable",
      name: file,
      detail: error instanceof Error ? error.message : String(error),
    },
  };
}

/** Refuse a payload assembled for another host, before a single byte is hashed. */
function checkHost(platform: string, arch: string, what: string): VerifyFailure | null {
  if (platform !== process.platform) {
    return {
      reason: "wrong-platform",
      name: platform,
      detail:
        `this ${what} was assembled on ${platform} and this host is ${process.platform}. ` +
        `Payload contents are platform-specific — the interpreter is a native binary — so it has ` +
        `to be built on the platform it targets.`,
    };
  }
  if (arch !== process.arch) {
    return {
      reason: "wrong-arch",
      name: arch,
      detail:
        `this ${what} carries a ${arch} interpreter and this host is ${process.arch}. ` +
        `\`runtime build\` copies the build host's own \`process.execPath\`, so a payload only ` +
        `runs on the architecture it was built on.`,
    };
  }
  return null;
}

/**
 * Every file and link, in sorted order, then everything the manifest did not describe: what the
 * manifest names must be on disk with the recorded size and hash — and, for links, the recorded
 * target — and nothing may be there that it does not name.
 */
function verifyTree(
  root: string,
  files: readonly ManifestFile[],
  links: readonly ManifestLink[],
  manifestFile: string,
): VerifyReport {
  let checked = 0;

  for (const entry of files) {
    if (!isPayloadPath(entry.path)) {
      return fail(
        checked,
        "absolute-path",
        entry.path,
        "a manifest path must be payload-relative.",
      );
    }
    const full = join(root, ...entry.path.split("/"));
    checked += 1;
    if (!existsSync(full)) {
      return fail(checked, "missing", entry.path, `${full} is in the manifest and not on disk.`);
    }
    const stats = lstatSync(full);
    if (!stats.isFile()) {
      return fail(checked, "not-a-file", entry.path, `${full} is not a regular file.`);
    }
    if (stats.size !== entry.bytes) {
      return fail(
        checked,
        "resized",
        entry.path,
        `${full} is ${stats.size} bytes and the manifest records ${entry.bytes}.`,
      );
    }
    const digest = hashFile(full);
    if (digest !== entry.sha256) {
      return fail(
        checked,
        "changed",
        entry.path,
        `${full} hashes to ${digest} and the manifest records ${entry.sha256}.`,
      );
    }
  }

  for (const link of links) {
    if (!isPayloadPath(link.path)) {
      return fail(checked, "absolute-path", link.path, "a manifest path must be payload-relative.");
    }
    const full = join(root, ...link.path.split("/"));
    checked += 1;
    let target: string;
    try {
      if (!lstatSync(full).isSymbolicLink()) {
        return fail(checked, "link-changed", link.path, `${full} is no longer a symbolic link.`);
      }
      target = toPayloadPath(readlinkSync(full));
    } catch {
      return fail(
        checked,
        "link-missing",
        link.path,
        `${full} is in the manifest and not on disk.`,
      );
    }
    if (target !== link.target) {
      return fail(
        checked,
        "link-changed",
        link.path,
        `${full} points at ${target} and the manifest records ${link.target}.`,
      );
    }
  }

  const described = new Set<string>([
    manifestFile,
    ...files.map((entry) => entry.path),
    ...links.map((entry) => entry.path),
  ]);
  const extra = listTree(root).find((path) => !described.has(path));
  if (extra !== undefined) {
    return fail(
      checked,
      "unexpected",
      extra,
      `${join(root, ...extra.split("/"))} is in the payload and not in the manifest.`,
    );
  }

  return { ok: true, checked, failure: null };
}

/** One failure, with the count of what had already been examined when it was found. */
function fail(
  checked: number,
  reason: VerifyFailureReason,
  name: string,
  detail: string,
): VerifyReport {
  return { ok: false, checked, failure: { reason, name, detail } };
}
