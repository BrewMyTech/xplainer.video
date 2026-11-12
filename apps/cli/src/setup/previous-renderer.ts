/**
 * The previous renderer's install, removed from the workspace once nothing can need it again.
 *
 * Releases before ADR 0031's Phase 2 had `xplainer setup --workspace` install a pinned dependency
 * tree into the video workspace — about 234 MB of `node_modules` beside the template's
 * `package.json` and `package-lock.json`, described by a `workspace.manifest.json` — and no render
 * has read it since the owned renderer replaced the one it was for. The owner's decision (ADR 0031
 * §Note, 2026-11-12, D7) is that `setup` deletes it rather than reporting it, and this module is
 * that deletion and the test that licenses it.
 *
 * **It removes a tree only when that tree is provably the one an earlier `setup` wrote.** The
 * workspace root is `XPLAINER_VIDEOS_DIR` when that is set, and a user may point it at a project of
 * their own that has a `node_modules` and a `package.json` of its own. So two documents have to say
 * so, and both are read here rather than through any reader of the old payload, which is gone:
 *
 * 1. `workspace.manifest.json` is a workspace manifest — `kind: "workspace"` — that records the
 *    previous renderer's CLI entry ({@link PREVIOUS_ENTRY_FIELD}). Only the two `setup --workspace`
 *    routes and `runtime build --workspace` ever wrote one.
 * 2. `package.json`'s `name`, `dependencies` and `devDependencies` are **exactly** the last
 *    template's ({@link LAST_TEMPLATE}) — the file both routes copied in verbatim. A tree resolved
 *    from an older template, or a project that only resembles one, keeps everything.
 *
 * **It removes four entries and nothing else** ({@link PREVIOUS_RENDERER_ENTRIES}). `videos/`,
 * `public/`, `out/`, `requests/` and `locks/` are the user's work and the daemon's, and
 * `tailwind.css` and `tsconfig.json` are still template files the renderer reads. The order is the
 * evidence last: `node_modules/` first, because it is the cost, and the two documents that license
 * the deletion after it, so an interrupted run leaves a tree the next one still recognises. The
 * one interruption that leaves `package.json` gone and `workspace.manifest.json` behind is finished
 * on the manifest's word alone: with the other three entries already removed there is nothing left
 * for `package.json` to vouch for, and the manifest is the only entry left to remove.
 *
 * It is called by `commands/setup.ts` only after the refusal to cross the marker's cut has passed
 * (D2 (c)): a machine still running a daemon from before the cut is one whose renderer may still
 * read this tree, and that refusal is what tells such a machine to reinstall first.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** The document an earlier `setup --workspace` wrote beside the tree it installed. */
export const PREVIOUS_WORKSPACE_MANIFEST = "workspace.manifest.json";

/**
 * The field of that document that records the previous renderer's CLI entry, spelled once.
 *
 * It carries the previous renderer's name, so `scripts/check-no-remotion.mjs` admits this one line
 * of this file and nothing else; the tests build their manifests from it rather than spelling it.
 */
export const PREVIOUS_ENTRY_FIELD = "remotion_entry";

/** What is removed, in the order it is removed: the cost first, the evidence for it last. */
export const PREVIOUS_RENDERER_ENTRIES = [
  "node_modules",
  "package-lock.json",
  "package.json",
  "workspace.manifest.json",
] as const;

/**
 * `@xplainer/render-core`'s `template/package.json` as `73be23c` left it: the last template any
 * release installed, and so the only `package.json` this module will recognise as its own.
 *
 * Written out rather than read from anywhere, because the template no longer carries a
 * `package.json` at all — and a value that cannot change is the point: a tree resolved from a
 * different template is not one this module can vouch for.
 */
export const LAST_TEMPLATE: {
  readonly name: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
} = {
  name: "@xplainer/render-workspace",
  dependencies: {
    "@remotion/captions": "4.0.495",
    "@remotion/cli": "4.0.495",
    "@remotion/media": "4.0.495",
    "@remotion/tailwind-v4": "4.0.495",
    react: "19.2.3",
    "react-dom": "19.2.3",
    remotion: "4.0.495",
    tailwindcss: "4.0.0",
    zod: "4.3.6",
  },
  devDependencies: {
    "@types/react": "19.2.3",
    typescript: "5.7.3",
  },
};

/** What one {@link removePreviousRendererTree} call found, and what it did about it. */
export type PreviousRendererOutcome =
  /** No `workspace.manifest.json` recording the previous renderer: nothing to do, nothing said. */
  | { kind: "absent" }
  /** It is the tree an earlier `setup` wrote, and these entries were removed, in this order. */
  | { kind: "removed"; removed: string[] }
  /** A manifest says it is ours and `package.json` disagrees, so everything was left in place. */
  | { kind: "kept"; reason: string }
  /** It was ours, and removing one entry failed; `removed` is what had already gone. */
  | { kind: "failed"; removed: string[]; entry: string; error: string };

/**
 * Remove the previous renderer's install from `workspaceRoot`, if it is provably the one an earlier
 * `setup` wrote — and never anything else.
 */
export function removePreviousRendererTree(workspaceRoot: string): PreviousRendererOutcome {
  const manifest = readObject(join(workspaceRoot, PREVIOUS_WORKSPACE_MANIFEST));
  if (
    manifest === null ||
    manifest.kind !== "workspace" ||
    typeof manifest[PREVIOUS_ENTRY_FIELD] !== "string" ||
    manifest[PREVIOUS_ENTRY_FIELD] === ""
  ) {
    return { kind: "absent" };
  }

  // **The last step of an interrupted removal.** `package.json` is removed second to last, so a run
  // stopped between it and the manifest leaves the manifest alone — and the template check below
  // would then keep it for ever, for want of the very file this module had already removed. With
  // the other three entries gone there is nothing of anyone's left that the manifest could be
  // vouching for, so it goes on its own word.
  const evidenceOnly = PREVIOUS_RENDERER_ENTRIES.filter(
    (entry) => entry !== PREVIOUS_WORKSPACE_MANIFEST,
  ).every((entry) => !existsSync(join(workspaceRoot, entry)));
  if (evidenceOnly) {
    return removeEntries(workspaceRoot, [PREVIOUS_WORKSPACE_MANIFEST]);
  }

  const reason = templateMismatch(readObject(join(workspaceRoot, "package.json")));
  if (reason !== null) {
    return { kind: "kept", reason };
  }
  return removeEntries(workspaceRoot, PREVIOUS_RENDERER_ENTRIES);
}

/** Remove `entries` from `workspaceRoot` in order, skipping what is already gone. */
function removeEntries(workspaceRoot: string, entries: readonly string[]): PreviousRendererOutcome {
  const removed: string[] = [];
  for (const entry of entries) {
    const path = join(workspaceRoot, entry);
    if (!existsSync(path)) {
      continue;
    }
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) {
      return {
        kind: "failed",
        removed,
        entry,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    removed.push(entry);
  }
  return { kind: "removed", removed };
}

/** Why `package.json` is not the last template's, or `null` when it is exactly that. */
function templateMismatch(document: Record<string, unknown> | null): string | null {
  if (document === null) {
    return "its package.json is missing or is not a JSON object";
  }
  if (document.name !== LAST_TEMPLATE.name) {
    return `its package.json is named ${JSON.stringify(document.name)}, not ${LAST_TEMPLATE.name}`;
  }
  for (const field of ["dependencies", "devDependencies"] as const) {
    if (!samePins(document[field], LAST_TEMPLATE[field])) {
      return `its package.json's ${field} are not the ones the last template pinned`;
    }
  }
  return null;
}

/** Whether `value` is a name → version map with exactly the entries of `expected`. */
function samePins(value: unknown, expected: Readonly<Record<string, string>>): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const found = value as Record<string, unknown>;
  const names = Object.keys(expected);
  return (
    Object.keys(found).length === names.length &&
    names.every((name) => found[name] === expected[name])
  );
}

/** A JSON object off disk, or `null` for a file that is absent, unreadable or not an object. */
function readObject(file: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}
