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
 * 2. **The host.** `runtime build` copies `process.execPath`, so payload 1 carries the build host's
 *    own architecture; and `@remotion/compositor-<platform>` is a platform-specific optional
 *    dependency, so payload 2 is only valid on the platform it was installed on. A payload built
 *    elsewhere is refused **before** anything is hashed, because every hash in it would match and
 *    the payload would still not run. This is what turns §1.3d B's dropped x64 mac artefact from a
 *    spawn error on a user's Intel Mac into a named refusal.
 * 3. **The paths.** No manifest path may be absolute or escape the payload — the rule the assembler
 *    enforces on the way in, re-checked on the way out, because a manifest is a file and files are
 *    edited.
 * 4. **The contents**, in sorted path order: present, a regular file, the recorded size, the
 *    recorded hash; then every symlink by its unresolved target.
 * 5. **Anything extra — and how much of it is allowed depends on which payload this is.** The two
 *    payloads make different promises about their directories, so step 5 takes a
 *    {@link TreeMode} rather than a single rule:
 *
 *    - **`"exhaustive"` (payload 1).** A file in the tree that the manifest does not describe is a
 *      mismatch: "the payload is exactly what was assembled" is the property, not "the payload
 *      contains what was assembled". Nothing but `runtime build` and `install stage` ever write
 *      inside a runtime payload, so an extra file there is a real integrity failure.
 *    - **`"described"` (payload 2).** The workspace is a *live* directory. Its manifest describes
 *      `node_modules/`, `package.json` and `package-lock.json` and deliberately nothing else
 *      (`setup/providers/workspace.ts`), while `setup` also copies in the engine-owned template
 *      files — `remotion.config.ts`, `tailwind.css`, `tsconfig.json` — and the user's own work
 *      lands beside them in `videos/`, `out/` and `public/`, with Remotion's `node_modules/.cache/`
 *      and `.remotion/` appearing after the first render. Requiring the tree to hold nothing but
 *      the manifest would refuse every workspace `setup` has ever produced, which is what made
 *      `daemon update` exit `3` on every real machine. So the described entries must all be
 *      present with matching digests — that is what proves the pins — and an undescribed file is
 *      permitted **unless it shadows a described one**: a package copy nested under the described
 *      `node_modules/` whose name that tree also carries at the top level. Node resolves the
 *      nearest `node_modules` first, so such a copy is the version a render loads while the
 *      manifest still records the pinned one, and that is the single way an extra file can make
 *      the pin comparison below a lie.
 *
 * {@link verifyWorkspacePayload} then adds the check D2 exists for: the manifest's **resolved**
 * versions against the template's declared **pins**, package by package. A workspace resolved from
 * the wrong tree passes every hash in its own manifest and still fails `remotion versions` with
 * `zod: installed 4.5.4, required 4.3.6` — which is a failure inside a render rather than a
 * refusal before one, and is exactly the class this comparison moves earlier.
 */

import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
  hashFile,
  isPayloadPath,
  listTree,
  ManifestError,
  type ManifestFile,
  type ManifestLink,
  RUNTIME_MANIFEST_FILE,
  type RuntimeManifest,
  readRuntimeManifest,
  readWorkspaceManifest,
  toPayloadPath,
  WORKSPACE_MANIFEST_FILE,
  type WorkspaceManifest,
} from "./manifest.js";
import { templateDirectory } from "./template.js";

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
  | "unexpected"
  | "shadowed"
  | "pin-missing"
  | "pin-mismatch";

/**
 * How completely a payload's tree must match its manifest, chosen per payload and never globally.
 *
 * A parameter rather than a setting, because the answer is a property of the *payload* and not of
 * the machine: payload 1 is a sealed directory nothing else writes into, payload 2 is a working
 * directory whose whole purpose is that renders write into it. A process-wide switch would let one
 * caller's tolerance relax the other caller's integrity check.
 */
export type TreeMode =
  /** The tree holds the manifest and nothing else. Payload 1. */
  | "exhaustive"
  /** The manifest's entries must all match; other files are allowed unless they shadow one. */
  | "described";

/** The one mismatch a failed verification reports. */
export type VerifyFailure = {
  reason: VerifyFailureReason;
  /** What is wrong, by name: a payload-relative path, or a package name for the two pin reasons. */
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
  return verifyTree(
    payloadDir,
    manifest.files,
    manifest.links,
    RUNTIME_MANIFEST_FILE,
    "exhaustive",
  );
}

/**
 * Re-hash payload 2 against its own manifest, then compare its resolved versions with the pins.
 *
 * `pins` defaults to the template that shipped inside this very CLI, which is the copy a `setup`
 * on a user's machine would install from — so "the manifest matches the template's pins" is asked
 * of the same two documents at build time and at install time.
 *
 * The tree is checked in `"described"` mode: this is a live workspace, and step 5 of the module
 * header says why the alternative refuses every one of them.
 */
export function verifyWorkspacePayload(
  workspaceDir: string,
  pins: Record<string, string> = readTemplatePins(),
): VerifyReport {
  let manifest: WorkspaceManifest;
  try {
    manifest = readWorkspaceManifest(workspaceDir);
  } catch (error) {
    return unreadable(join(workspaceDir, WORKSPACE_MANIFEST_FILE), error);
  }
  const host = checkHost(manifest.platform, manifest.arch, "workspace payload");
  if (host !== null) {
    return { ok: false, checked: 0, failure: host };
  }
  const tree = verifyTree(
    workspaceDir,
    manifest.files,
    manifest.links,
    WORKSPACE_MANIFEST_FILE,
    "described",
  );
  if (!tree.ok) {
    return tree;
  }
  return comparePins(manifest, pins, tree.checked);
}

/** The pins `@xplainer/render-core`'s shipped `template/package.json` declares. */
export function readTemplatePins(): Record<string, string> {
  const file = join(templateDirectory(), "package.json");
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ManifestError(`${file} is not a JSON object.`);
  }
  const manifest = parsed as Record<string, unknown>;
  const pins: Record<string, string> = {};
  for (const field of ["dependencies", "devDependencies"]) {
    const group = manifest[field];
    if (typeof group !== "object" || group === null || Array.isArray(group)) {
      continue;
    }
    for (const [name, range] of Object.entries(group as Record<string, unknown>)) {
      if (typeof range === "string") {
        pins[name] = range;
      }
    }
  }
  return pins;
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
        `Payload contents are platform-specific — the interpreter is a native binary and ` +
        `@remotion/compositor-<platform> is an optional dependency chosen per platform — so it has ` +
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
 * Every file and link, in sorted order, then everything the manifest did not describe.
 *
 * The first two passes are the same for both payloads: what the manifest names must be on disk,
 * the recorded size, the recorded hash, and — for links — the recorded target. Only the third pass
 * reads `mode`, and only in the direction of tolerance: `"described"` never accepts a described
 * entry that `"exhaustive"` would reject.
 */
function verifyTree(
  root: string,
  files: readonly ManifestFile[],
  links: readonly ManifestLink[],
  manifestFile: string,
  mode: TreeMode,
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
  const packages = mode === "described" ? topLevelPackages(described) : new Set<string>();
  for (const path of listTree(root)) {
    if (described.has(path)) {
      continue;
    }
    if (mode === "exhaustive") {
      return fail(
        checked,
        "unexpected",
        path,
        `${join(root, ...path.split("/"))} is in the payload and not in the manifest.`,
      );
    }
    const shadowed = shadowedPackage(path, packages);
    if (shadowed !== null) {
      return fail(
        checked,
        "shadowed",
        path,
        `${join(root, ...path.split("/"))} is a nested copy of ${shadowed}, which this manifest ` +
          `also describes at node_modules/${shadowed}. Node resolves the nearest node_modules ` +
          `first, so the nested copy is what a render would load and the version this manifest ` +
          `records is no longer the version in use. Reinstall the workspace with ` +
          `\`xplainer setup --workspace\`.`,
      );
    }
  }

  return { ok: true, checked, failure: null };
}

/**
 * The package names the manifest describes directly under the workspace's own `node_modules/`.
 *
 * Scoped names count as one package — `@remotion/cli`, not `@remotion` — because that is the
 * directory depth Node's resolver treats as a package root, and it is the granularity
 * `WorkspaceManifest.resolved` and the template's pins are both written at.
 */
function topLevelPackages(described: ReadonlySet<string>): Set<string> {
  const names = new Set<string>();
  for (const path of described) {
    const segments = path.split("/");
    if (segments[0] !== "node_modules") {
      continue;
    }
    const name = packageNameAt(segments, 1);
    if (name !== null) {
      names.add(name);
    }
  }
  return names;
}

/**
 * The described package an undescribed path would be resolved in place of, or `null`.
 *
 * Only a `node_modules` *nested inside* the workspace's own can shadow: a new name at the top level
 * satisfies an import that previously failed rather than changing one that already resolved, and no
 * pin the manifest records is affected by it.
 */
function shadowedPackage(path: string, packages: ReadonlySet<string>): string | null {
  const segments = path.split("/");
  if (segments[0] !== "node_modules") {
    return null;
  }
  const nested = segments.lastIndexOf("node_modules");
  if (nested < 1) {
    return null;
  }
  const name = packageNameAt(segments, nested + 1);
  return name !== null && packages.has(name) ? name : null;
}

/** The package name starting at `index`, taking the two segments a scoped name occupies. */
function packageNameAt(segments: readonly string[], index: number): string | null {
  const head = segments[index];
  if (head === undefined || head === "" || segments[index + 1] === undefined) {
    return null;
  }
  if (!head.startsWith("@")) {
    return head;
  }
  const scope = segments[index + 1];
  return scope !== undefined && segments[index + 2] !== undefined ? `${head}/${scope}` : null;
}

/** The manifest's resolved versions against the template's pins, package by package. */
function comparePins(
  manifest: WorkspaceManifest,
  pins: Record<string, string>,
  checked: number,
): VerifyReport {
  for (const name of Object.keys(pins).sort()) {
    const wanted = pins[name];
    const found = manifest.resolved[name];
    if (wanted === undefined) {
      continue;
    }
    if (found === undefined) {
      return fail(
        checked,
        "pin-missing",
        name,
        `the template pins ${name}@${wanted} and the installed workspace has no ${name} at all.`,
      );
    }
    if (found !== wanted) {
      return fail(
        checked,
        "pin-mismatch",
        name,
        `the template pins ${name}@${wanted} and the installed workspace resolved ${found}. ` +
          `A tree Remotion's own \`versions\` command rejects is a render that fails rather than a ` +
          `build that refuses.`,
      );
    }
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
