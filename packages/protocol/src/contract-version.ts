/**
 * The compatibility predicate the `xplainer mcp --attach` shim applies before it
 * proxies anything (ADR 0025 §Part two, settled by spike P1-S3).
 *
 * It lives here, beside the contract itself, for the same reason
 * {@link MCP_CONTRACT_VERSION} does: both halves of a skew check must come from
 * one place, and `@xplainer/protocol` is the package every surface already
 * depends on. `@xplainer/mcp-server` re-exports the constant so the name stays
 * where callers have always found it.
 *
 * **The predicate is major-compatible, not exact.** A shim is spawned per
 * session and the daemon is not, so an exact predicate would exit `8` on every
 * live session the moment the daemon gained an eighth `error_code` — which is
 * precisely the outcome ADR 0025's "compare the contract, not the release" rule
 * exists to prevent. Additive changes therefore move the minor component and
 * attach cleanly; a change that removes or repurposes something moves the major
 * and refuses. The generated decoders in `src/generated/open-enums.ts` are what
 * make the additive half safe rather than merely permitted.
 */

/**
 * A contract version, split into the components the predicate compares.
 *
 * `major` is the only component compatibility depends on. `rest` is kept so a
 * caller can report the whole version back to a user, and so an unparseable
 * version is distinguishable from a version whose major happens to differ.
 */
type ParsedContractVersion = {
  /** The leading integer component. Compatibility is equality of this alone. */
  major: number;
};

/**
 * Parse `major`, `major.minor` or `major.minor.patch` into its major component.
 *
 * Deliberately strict: every component must be a run of digits with no sign, no
 * leading `v`, no pre-release suffix and no empty component. Anything else is a
 * version this build does not understand, and the caller treats "cannot parse"
 * the same way it treats "incompatible" — a shim that cannot read the daemon's
 * advertisement has not established that it may talk to it.
 *
 * `schemas/manifest.json` carries a bare major (`"1"`) today, so the two-and
 * three-component forms exist for the first additive bump rather than for
 * anything shipping now.
 */
function parseContractVersion(version: string): ParsedContractVersion | undefined {
  const components = version.split(".");
  if (components.length < 1 || components.length > 3) {
    return undefined;
  }
  for (const component of components) {
    if (!/^\d+$/.test(component)) {
      return undefined;
    }
  }
  const major = Number(components[0]);
  return Number.isSafeInteger(major) ? { major } : undefined;
}

/**
 * Whether a shim speaking `shim` may attach to a daemon speaking `daemon`.
 *
 * True when both versions parse and share a major component. The relation is
 * **symmetric** on purpose: a newer shim meeting an older daemon is the upgrade
 * case, and an older shim meeting a newer daemon is the not-yet-restarted-agent
 * case, and neither is more dangerous than the other once unknown enum members
 * decode instead of throwing.
 *
 * A version this build cannot parse is **incompatible**, never "probably fine".
 * That is the fail-closed direction: the cost of refusing is one legible error
 * naming both versions, and the cost of attaching anyway is the illegible
 * failure ADR 0025 was written to eliminate.
 *
 * @param daemon The contract version the daemon advertised, from `/healthz`'s
 *   `contract_version` or the ready line's `contract`.
 * @param shim This process's own {@link MCP_CONTRACT_VERSION}.
 * @returns `true` if the pair may speak to each other.
 */
export function isContractCompatible(daemon: string, shim: string): boolean {
  const parsedDaemon = parseContractVersion(daemon);
  const parsedShim = parseContractVersion(shim);
  if (parsedDaemon === undefined || parsedShim === undefined) {
    return false;
  }
  return parsedDaemon.major === parsedShim.major;
}
