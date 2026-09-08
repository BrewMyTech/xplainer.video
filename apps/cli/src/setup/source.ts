/**
 * Where the toolchain manifest is read from, and what it means when it cannot be reached.
 *
 * `manifest.ts` fixes the *address* — `https://cdn.<zone_name>/toolchain/v1/manifest.json`, the one
 * hostname `infra/terraform` provisions — and this module is the fetch, the two overrides, and the
 * report of which of them answered. Three sources, in a fixed precedence:
 *
 * 1. **`--manifest <path|url>`**, or `XPLAINER_TOOLCHAIN_MANIFEST`. A local file or an `https` URL.
 *    It exists because the manifest is a *reviewed document*, and reviewing a change to it means
 *    running `setup` against the candidate before it is anywhere near a CDN.
 * 2. **The published manifest**, over the network.
 * 3. **The reviewed copy committed beside this module**, which is present when the CLI is running
 *    from its own sources — a checkout, and every test and proof in this repository — and is
 *    **absent from a built payload**, because `package.json`'s `files` allowlist ships compiled
 *    JavaScript and declarations and no JSON. So the fallback is a development convenience with a
 *    stated
 *    boundary, and a published `xplainer setup` has exactly two sources rather than a silent third.
 *
 * **Nothing is published to `cdn.xplainer.video` in this phase** (§2.5): the custom-domain
 * connection and the Cache Rule are manual steps Terraform does not manage. So on a machine running
 * a published build, source 2 fails and source 3 is not there, and the refusal has to say so in
 * terms a user can act on rather than reporting a DNS error. {@link ManifestUnreachable} is that
 * refusal, and it carries `manifest.ts`'s {@link deliveryPosition} — why the address is empty, who
 * would have published to it, and which speech routes still work on the machine reading the
 * message, which on Windows is none of them.
 */

import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { PRECONDITION_UNMET_EXIT_CODE } from "../daemon/exit-codes.js";
import {
  deliveryPosition,
  type HostProbe,
  parseToolchainManifest,
  TOOLCHAIN_MANIFEST_URL,
  type ToolchainManifest,
} from "./manifest.js";

/** The environment variable that names a manifest, for a reviewer and for this repository's gates. */
export const MANIFEST_SOURCE_ENV = "XPLAINER_TOOLCHAIN_MANIFEST";

/** The committed document's name, which is also its name beside this module. */
export const COMMITTED_MANIFEST_FILE = "toolchain.manifest.json";

/** How long the manifest fetch may take before it is treated as unreachable. */
export const MANIFEST_TIMEOUT_MS = 15_000;

/** Which of the three sources answered. Reported, because they are not equivalent. */
export type ManifestSourceKind = "override" | "published" | "committed";

/** A manifest, and where it came from. */
export type LoadedManifest = {
  manifest: ToolchainManifest;
  kind: ManifestSourceKind;
  /** The file or URL, exactly as it will be printed. */
  source: string;
  /**
   * Why every source ahead of this one was passed over, in the order they were tried.
   *
   * Carried on a **success** and not only on the refusal, because "the published manifest is
   * corrupt and this run used the checkout's copy" is a fact a reader has to be given: a fall-back
   * that reports nothing is a fall-back that hides an infrastructure failure for as long as the
   * local copy keeps working.
   */
  attempts: readonly string[];
};

/** No manifest could be read, and nothing was downloaded. */
export class ManifestUnreachable extends Error {
  readonly exitCode: number = PRECONDITION_UNMET_EXIT_CODE;
  /** Why each source failed, in the order they were tried. */
  readonly attempts: readonly string[];

  constructor(message: string, attempts: readonly string[]) {
    super(message);
    this.name = "ManifestUnreachable";
    this.attempts = attempts;
  }
}

/** What {@link loadToolchainManifest} was asked to do. */
export type LoadManifestOptions = {
  /** `--manifest`, when it was given. */
  override?: string | undefined;
  /** The environment `XPLAINER_TOOLCHAIN_MANIFEST` is read from. Defaults to this process's. */
  env?: NodeJS.ProcessEnv | undefined;
  /** The published address. A parameter so a test can point it at a loopback server. */
  url?: string | undefined;
  /**
   * The committed copy's path, or `null` for a build that carries none.
   *
   * Defaults to the file beside this module. It is a parameter for the reason `install/preflight.ts`
   * takes its two Linux paths as one: `null` is what a **published** `@xplainer/cli` looks like from
   * here — `files` ships compiled JavaScript and declarations and no JSON — and that is the case
   * whose refusal a user on a real machine meets, so it has to be assertable from a checkout rather
   * than only from a tarball.
   */
  committed?: string | null | undefined;
  /**
   * The machine the refusal is written for. Defaults to a real probe.
   *
   * A parameter for one reason: the delivery position **differs by platform** — Windows is told it
   * has no working speech route at all — and a message that can only be read on the machine that
   * produces it is a message no test on any other machine can assert.
   */
  probe?: HostProbe | undefined;
  log?: (line: string) => void;
};

/**
 * Read the manifest from the first source that answers, or refuse naming every one that did not.
 *
 * An override that fails is **not** fallen through: a reviewer who named a candidate manifest and
 * silently got the published one would be reviewing the wrong document, and every digest in the
 * report would be about bytes they never chose.
 */
export async function loadToolchainManifest(
  options: LoadManifestOptions = {},
): Promise<LoadedManifest> {
  const log = options.log ?? ((): void => {});
  const env = options.env ?? process.env;
  const attempts: string[] = [];

  const override = options.override ?? env[MANIFEST_SOURCE_ENV];
  if (override !== undefined && override.trim() !== "") {
    const source = override.trim();
    log(`manifest: ${source}`);
    return { manifest: await readFrom(source), kind: "override", source, attempts };
  }

  const url = options.url ?? TOOLCHAIN_MANIFEST_URL;
  try {
    log(`manifest: ${url}`);
    return { manifest: await readFrom(url), kind: "published", source: url, attempts };
  } catch (error) {
    attempts.push(`${url} — ${error instanceof Error ? error.message : String(error)}`);
    log(`manifest: ${attempts[0]}`);
  }

  const committed = options.committed === undefined ? committedManifestPath() : options.committed;
  if (committed !== null) {
    log(`manifest: falling back to ${committed}, this checkout's reviewed copy`);
    return { manifest: await readFrom(committed), kind: "committed", source: committed, attempts };
  }
  attempts.push(
    `${COMMITTED_MANIFEST_FILE} is not beside this build, which is expected: a published ` +
      "@xplainer/cli ships dist/**/*.js and no JSON, so the committed copy is a checkout's " +
      "convenience and never a shipped fallback.",
  );

  throw new ManifestUnreachable(
    `the toolchain manifest could not be read, so setup has no reviewed digest to verify an ` +
      `artefact against and downloaded nothing. Sources tried:\n\n` +
      attempts.map((attempt) => `  - ${attempt}`).join("\n") +
      `\n\n${deliveryPosition(options.probe)}` +
      `\n\nPass \`--manifest <path or https URL>\` (or set ${MANIFEST_SOURCE_ENV}) to name one.`,
    attempts,
  );
}

/** The committed copy beside this module, or `null` when this build does not carry one. */
export function committedManifestPath(): string | null {
  const path = fileURLToPath(new URL(COMMITTED_MANIFEST_FILE, import.meta.url));
  return existsSync(path) ? path : null;
}

/** Read one source — a local file, or an `https` URL — and parse it as a manifest. */
async function readFrom(source: string): Promise<ToolchainManifest> {
  if (looksLikeUrl(source)) {
    return parseToolchainManifest(await fetchText(source), source);
  }
  return parseToolchainManifest(readFileSync(source, "utf8"), source);
}

/** `http(s)://…` is a URL; everything else is a path, including a Windows `C:\…`. */
function looksLikeUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

/** Fetch a manifest, with a bounded wait and a message that names the status rather than the body. */
async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`answered HTTP ${response.status}`);
  }
  return await response.text();
}
