#!/usr/bin/env node
/**
 * Emit the two plugin bundles.
 *
 * One skill, two marketplaces. `SKILL.md`, `claude-plugin/` and `codex-plugin/`
 * in this package are the reviewed sources; this script arranges them into the
 * directory shapes each client actually loads:
 *
 *   dist/claude-plugin/.claude-plugin/plugin.json
 *   dist/claude-plugin/.claude-plugin/marketplace.json
 *   dist/claude-plugin/.mcp.json
 *   dist/claude-plugin/skills/xplainer/SKILL.md
 *   dist/codex-plugin/.codex-plugin/plugin.json
 *   dist/codex-plugin/.mcp.json
 *   dist/codex-plugin/skills/xplainer/SKILL.md
 *
 * Two rules shape the code below.
 *
 * The manifests carry no `version` in source; it is stamped in here from
 * `package.json`. A version written in three files is a version that will
 * eventually disagree with itself, and the disagreement shows up as an
 * already-published marketplace entry pointing at the wrong release.
 *
 * Each bundle directory is removed before it is written. A build that only ever
 * adds files will keep shipping a manifest someone deleted from source, and the
 * bundle is what gets published, so the stale copy is the one users install.
 *
 * The `.mcp.json` files are copied byte for byte rather than re-serialised: the
 * endpoint the plugins point at is a reviewed fact, and re-serialising invites a
 * transform to sit between the review and the artefact.
 *
 * Usage:
 *   node scripts/build.mjs            write the bundles into ./dist
 *   node scripts/build.mjs <out-dir>  write them into <out-dir> instead
 */

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The directory name each client looks for its manifests in. */
const CLAUDE_MANIFEST_DIR = ".claude-plugin";
const CODEX_MANIFEST_DIR = ".codex-plugin";

/** Both clients discover skills at `skills/<name>/SKILL.md`. */
const SKILL_NAME = "xplainer";

/** Read and parse one JSON file under the package root. */
function readJson(relative) {
  return JSON.parse(readFileSync(path.join(PACKAGE_ROOT, relative), "utf8"));
}

/**
 * Return `manifest` with `version` inserted directly after `name`.
 *
 * Insertion order is preserved rather than appended so the emitted manifest
 * reads the way the published ones do — identity first, then the listing.
 *
 * The result is checked rather than trusted, which catches both ways this can
 * go wrong: a source manifest with no `name` gives the version nowhere to go,
 * and a source manifest that hardcodes its own `version` would overwrite the
 * stamped one and reintroduce exactly the drift this function exists to prevent.
 */
function stampVersion(manifest, version) {
  const stamped = {};
  for (const [key, value] of Object.entries(manifest)) {
    stamped[key] = value;
    if (key === "name") {
      stamped.version = version;
    }
  }
  if (stamped.version !== version) {
    throw new Error(
      `cannot stamp version ${version}: the source manifest must carry a \`name\` and must not ` +
        "declare a `version` of its own",
    );
  }
  return stamped;
}

/**
 * Stamp a Claude document, whichever of the two it is.
 *
 * `plugin.json` carries the version itself; `marketplace.json` carries a list of
 * plugin entries that each carry their own. Both come from the same package
 * version, so they are stamped in one place.
 */
function stampClaudeDocument(document, version) {
  if (Array.isArray(document.plugins)) {
    return {
      ...document,
      plugins: document.plugins.map((plugin) => stampVersion(plugin, version)),
    };
  }
  return stampVersion(document, version);
}

/** Write `value` as formatted JSON, creating parent directories as needed. */
function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Copy one file verbatim, creating parent directories as needed. */
function copyVerbatim(from, to) {
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
}

/**
 * Build both bundles under `outRoot` and return every file written, in the
 * order it was written, relative to `outRoot`.
 */
function build(outRoot) {
  const version = readJson("package.json").version;
  const skillSource = path.join(PACKAGE_ROOT, "SKILL.md");
  const claudeRoot = path.join(outRoot, "claude-plugin");
  const codexRoot = path.join(outRoot, "codex-plugin");
  const written = [];

  for (const bundleRoot of [claudeRoot, codexRoot]) {
    rmSync(bundleRoot, { recursive: true, force: true });
  }

  const claudeManifests = [
    ["plugin.json", "claude-plugin/plugin.json"],
    ["marketplace.json", "claude-plugin/marketplace.json"],
  ];
  for (const [outName, sourcePath] of claudeManifests) {
    const file = path.join(claudeRoot, CLAUDE_MANIFEST_DIR, outName);
    writeJson(file, stampClaudeDocument(readJson(sourcePath), version));
    written.push(path.relative(outRoot, file));
  }

  const codexManifest = path.join(codexRoot, CODEX_MANIFEST_DIR, "plugin.json");
  writeJson(codexManifest, stampVersion(readJson("codex-plugin/plugin.json"), version));
  written.push(path.relative(outRoot, codexManifest));

  for (const [bundleRoot, source] of [
    [claudeRoot, "claude-plugin/.mcp.json"],
    [codexRoot, "codex-plugin/.mcp.json"],
  ]) {
    const file = path.join(bundleRoot, ".mcp.json");
    copyVerbatim(path.join(PACKAGE_ROOT, source), file);
    written.push(path.relative(outRoot, file));
  }

  for (const bundleRoot of [claudeRoot, codexRoot]) {
    const file = path.join(bundleRoot, "skills", SKILL_NAME, "SKILL.md");
    copyVerbatim(skillSource, file);
    written.push(path.relative(outRoot, file));
  }

  return written;
}

function main() {
  const outRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.join(PACKAGE_ROOT, "dist");
  const written = build(outRoot);
  for (const file of written) {
    process.stdout.write(`skill: wrote ${path.join(path.basename(outRoot), file)}\n`);
  }
}

main();
