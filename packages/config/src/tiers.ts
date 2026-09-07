/**
 * The tier boundary rule (acceptance criterion AC-3, ADR 0003).
 *
 * The workspace is split into two tiers. `hosted` packages are the ones that
 * stay private and run on our own infrastructure; `open-later` packages are the
 * ones that are extracted and open-sourced at roadmap phase 5. A hosted package
 * may depend on an open-later package, because the extracted set is still a
 * complete, self-contained subgraph afterwards. The reverse edge — an
 * open-later package depending on a hosted one — would drag a private package
 * into the extraction, so it is forbidden.
 *
 * This module is a pure function over a declared graph and touches nothing
 * else: no filesystem, no process, no network. `bin/check-tiers.mjs` builds the
 * graph from the workspace manifests and feeds it here, and `tiers.test.ts`
 * feeds it hand-written graphs.
 */

/** The two tiers a workspace member can declare in its `xplainer.tier` field. */
export type Tier = "hosted" | "open-later";

/** One workspace member, reduced to what the tier rule needs to know about it. */
export type PackageNode = {
  /** The package name, e.g. `@xplainer/render-core`. */
  name: string;
  /** The tier the package declares. */
  tier: Tier;
  /** Names of the in-workspace packages this one declares a dependency on. */
  dependsOn: string[];
};

/** One forbidden edge: an `open-later` package depending on a `hosted` one. */
export type Violation = {
  /** The depending package — always `open-later`. */
  from: string;
  /** `from`'s tier. Present so a violation is self-describing when printed. */
  fromTier: Tier;
  /** The depended-upon package — always `hosted`. */
  to: string;
  /** `to`'s tier. */
  toTier: Tier;
  /** A human-readable one-line explanation naming both packages. */
  message: string;
};

/**
 * Report every edge in `nodes` where an `open-later` package depends on a
 * `hosted` package.
 *
 * Edges whose target is not itself a node in `nodes` are not reported: this
 * function judges only the graph it is given, and an unresolved name has no
 * tier to compare against. `bin/check-tiers.mjs` is what notices such a name,
 * because it is the layer that knows the full set of workspace members.
 *
 * Duplicate entries in `dependsOn` are collapsed, so a package that lists the
 * same dependency in both `dependencies` and `devDependencies` produces one
 * violation rather than two. The returned order is stable: violations are
 * grouped by depending package in the order `nodes` was given, and within a
 * package in the order `dependsOn` was given.
 */
export function checkTierGraph(nodes: PackageNode[]): Violation[] {
  const tierByName = new Map<string, Tier>();
  for (const node of nodes) {
    tierByName.set(node.name, node.tier);
  }

  const violations: Violation[] = [];
  for (const node of nodes) {
    if (node.tier !== "open-later") {
      continue;
    }
    const seen = new Set<string>();
    for (const dependency of node.dependsOn) {
      if (seen.has(dependency)) {
        continue;
      }
      seen.add(dependency);
      if (tierByName.get(dependency) !== "hosted") {
        continue;
      }
      violations.push({
        from: node.name,
        fromTier: node.tier,
        to: dependency,
        toTier: "hosted",
        message: `${node.name} (open-later) must not depend on ${dependency} (hosted): an open-later package may never depend on a hosted one.`,
      });
    }
  }
  return violations;
}
