#!/usr/bin/env node
/**
 * Workspace tier checker (plan §4 S1.5; acceptance criteria AC-3a and AC-3b).
 *
 * Reads every workspace member manifest under `apps/*`, `packages/*` and
 * `services/*`, takes each one's `name`, its `xplainer.tier`, and the union of
 * its `dependencies` and `devDependencies` keys that begin `@xplainer/`, and
 * feeds that graph to `checkTierGraph` from `../src/tiers.ts`.
 *
 * Exit codes:
 *   0  every member declares a tier and no open-later -> hosted edge exists
 *   1  at least one tier violation (AC-3b)
 *   2  a member is missing or misdeclares `xplainer.tier`, a manifest cannot be
 *      read, or the rule implementation cannot be loaded
 *
 * Scope, stated honestly (plan §2 P4): this checker sees DECLARED dependency
 * edges only. The workspace sets `node-linker=hoisted`, so an UNDECLARED import
 * of a hosted package still resolves at runtime and in tsc, and no amount of
 * manifest reading can see it. The Biome specifier ban in `biome.json`
 * `overrides` is the backstop for that case. Neither check alone is sufficient.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Directories that hold workspace members, mirroring `pnpm-workspace.yaml`. */
const MEMBER_ROOTS = ["apps", "packages", "services"];

/** Only dependencies in our own scope are in-workspace edges. */
const SCOPE = "@xplainer/";

/** Dependency fields that count as an edge, per plan S1.5. */
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies"];

const VALID_TIERS = new Set(["hosted", "open-later"]);

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Load the rule implementation.
 *
 * `../src/tiers.ts` is preferred and is imported directly: Node 24 strips the
 * types itself, so the checker always runs the current source and never needs a
 * build to have happened first. That import fails when this package has been
 * copied under a `node_modules/` directory, because Node refuses to strip types
 * inside dependencies — so the built `../dist/tiers.js` is the fallback. Both
 * paths lead to the same single source of truth; the rule is never duplicated
 * here.
 */
async function loadCheckTierGraph() {
  const candidates = [join(HERE, "..", "src", "tiers.ts"), join(HERE, "..", "dist", "tiers.js")];
  const failures = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      failures.push(`${candidate}: not found`);
      continue;
    }
    try {
      const module = await import(pathToFileURL(candidate).href);
      if (typeof module.checkTierGraph === "function") {
        return module.checkTierGraph;
      }
      failures.push(`${candidate}: does not export checkTierGraph`);
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`cannot load the tier rule implementation\n  ${failures.join("\n  ")}`);
}

/**
 * Locate the workspace root by walking up for `pnpm-workspace.yaml`, first from
 * the current working directory (the `pnpm lint:tiers` case) and then from this
 * file's own location (the installed-bin case).
 */
function findWorkspaceRoot() {
  for (const start of [process.cwd(), resolve(HERE, "..", "..", "..")]) {
    let dir = resolve(start);
    for (;;) {
      if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
        return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  return null;
}

/** Every member manifest path, sorted so output order does not depend on the filesystem. */
function collectManifestPaths(root) {
  const found = [];
  for (const memberRoot of MEMBER_ROOTS) {
    const dir = join(root, memberRoot);
    if (!existsSync(dir)) {
      continue;
    }
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) {
        continue;
      }
      const relativePath = `${memberRoot}/${entry}/package.json`;
      if (existsSync(join(root, relativePath))) {
        found.push(relativePath);
      }
    }
  }
  return found.sort((a, b) => a.localeCompare(b));
}

/** Build the tier graph, collecting metadata errors rather than throwing on the first one. */
function readGraph(root, relativePaths) {
  const nodes = [];
  const errors = [];
  for (const relativePath of relativePaths) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(root, relativePath), "utf8"));
    } catch (error) {
      errors.push(
        `${relativePath}: cannot be parsed as JSON (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }

    const name = manifest.name;
    if (typeof name !== "string" || name.length === 0) {
      errors.push(`${relativePath}: has no "name"`);
      continue;
    }

    const tier = manifest.xplainer?.tier;
    if (tier === undefined) {
      errors.push(
        `${relativePath}: ${name} declares no "xplainer": { "tier": ... }. Every workspace member must declare its tier (AC-3a).`,
      );
      continue;
    }
    if (!VALID_TIERS.has(tier)) {
      errors.push(
        `${relativePath}: ${name} declares tier ${JSON.stringify(tier)}; expected "hosted" or "open-later".`,
      );
      continue;
    }

    const dependsOn = [];
    for (const field of DEPENDENCY_FIELDS) {
      for (const dependency of Object.keys(manifest[field] ?? {})) {
        if (dependency.startsWith(SCOPE) && !dependsOn.includes(dependency)) {
          dependsOn.push(dependency);
        }
      }
    }

    nodes.push({ name, tier, dependsOn, manifestPath: relativePath });
  }
  return { nodes, errors };
}

async function main() {
  const root = findWorkspaceRoot();
  if (root === null) {
    process.stderr.write(
      "check-tiers: no pnpm-workspace.yaml found above the working directory or this script.\n",
    );
    return 2;
  }

  const relativePaths = collectManifestPaths(root);
  const { nodes, errors } = readGraph(root, relativePaths);

  if (errors.length > 0) {
    process.stderr.write(`check-tiers: ${errors.length} tier metadata problem(s):\n`);
    for (const error of errors) {
      process.stderr.write(`  ${error}\n`);
    }
    return 2;
  }

  const known = new Set(nodes.map((node) => node.name));
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!known.has(dependency)) {
        process.stderr.write(
          `check-tiers: warning: ${node.manifestPath} depends on ${dependency}, which is not a workspace member, so it has no tier to check.\n`,
        );
      }
    }
  }

  const checkTierGraph = await loadCheckTierGraph();
  const violations = checkTierGraph(nodes);

  if (violations.length > 0) {
    process.stderr.write(`check-tiers: ${violations.length} tier violation(s):\n`);
    for (const violation of violations) {
      process.stderr.write(`  ${violation.message}\n`);
    }
    return 1;
  }

  const edges = nodes.reduce((total, node) => total + node.dependsOn.length, 0);
  process.stdout.write(
    `check-tiers: ${nodes.length} workspace member(s), ${edges} in-workspace dependency edge(s), no tier violations.\n`,
  );
  return 0;
}

process.exitCode = await main().catch((error) => {
  process.stderr.write(`check-tiers: ${error instanceof Error ? error.message : String(error)}\n`);
  return 2;
});
