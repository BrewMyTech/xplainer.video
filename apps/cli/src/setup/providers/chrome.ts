/**
 * The Chrome provider: the Chrome for Testing headless shell the manifest records for this
 * platform, verified first.
 *
 * **The row is selected by `<platform>-<arch>`, and its URL is admitted by code.** Format 2 of the
 * toolchain manifest names the browser's URL in the row itself, so `manifest.ts` refuses, when the
 * document is parsed, any URL that does not begin with a prefix its `ARTEFACT_ALLOWLIST` maps to a
 * publisher — for the browser, Google's `chrome-for-testing-public` bucket. A manifest naming an
 * artefact anywhere else is a refusal before anything is fetched, not a download from somewhere
 * else.
 *
 * **The digest is expected, never recorded.** Round 3 recorded the digest of whatever arrived, which
 * cannot reject an incorrect-but-intact archive on a first acquisition — it only detects later
 * drift. Where the manifest has no entry for this machine, `setup` says so instead of trusting the
 * bytes.
 *
 * **What is recorded is the executable, and what is verified is the archive.** ADR 0020's install
 * preflight checks that `toolchain.json`'s paths still exist, so the path recorded has to be the
 * file a render actually needs — the headless shell binary inside the unpacked tree — while the
 * `sha256` beside it is the reviewed digest the archive was admitted on. The two answer different
 * questions and the schema's own wording keeps them apart.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import type { ToolchainComponent } from "@xplainer/protocol";
import { PRECONDITION_UNMET_EXIT_CODE } from "../../daemon/exit-codes.js";
import { acquireArtefact } from "../download.js";
import {
  type HostProbe,
  probeHost,
  selectBrowserArtefact,
  type ToolchainManifest,
} from "../manifest.js";

/**
 * The `provider` token the marker records for this route: the browser the manifest's own row names.
 *
 * Until format 2 of the manifest it was the previous renderer's name, after the URL selector this
 * package mirrored from it, which format 2 deleted. A marker an older `setup` wrote still carries
 * the old token; the schema constrains only its spelling, and nothing branches on either.
 */
export const CHROME_PROVIDER = "manifest";

/** The directory name, under the toolchain directory, one acquisition commits itself to. */
export const CHROME_DIR_NAME = "chrome-headless-shell";

/**
 * The executable names a headless-shell archive unpacks to.
 *
 * Two spellings, because publishers disagree: Chrome for Testing ships `chrome-headless-shell`, and
 * Playwright's Chromium builds — the linux-arm64 source ADR 0031's note of 2026-11-12 keeps as the
 * fallback — ship `headless_shell`. Both are searched for rather than one being assumed, because
 * assuming produces a `toolchain.json` whose recorded path does not exist on exactly the platforms
 * that need the other one.
 */
export const CHROME_EXECUTABLE_NAMES: readonly string[] = [
  "chrome-headless-shell",
  "chrome-headless-shell.exe",
  "headless_shell",
  "headless_shell.exe",
];

/**
 * What would be fetched for this machine, and what it must hash to.
 *
 * A named function rather than an object literal inside {@link acquireChrome}, because this is the
 * one join the provider exists for: this platform's row, its allowlisted URL and its reviewed
 * digest. `download.ts` refuses a body that hashes to anything else (`checksum-mismatch`, and it
 * deletes the partial so a wrong body is never resumed onto), so what is asserted here is that the
 * reviewed digest is what reaches it.
 */
export function chromeRequest(
  manifest: ToolchainManifest,
  probe: HostProbe,
): { url: string; sha256: string; size: number } {
  const selection = selectBrowserArtefact(manifest, probe);
  return { url: selection.url, sha256: selection.sha256, size: selection.size };
}

/** The browser was not acquired, and nothing was committed. */
export class ChromeRefusal extends Error {
  readonly exitCode: number = PRECONDITION_UNMET_EXIT_CODE;

  constructor(message: string) {
    super(message);
    this.name = "ChromeRefusal";
  }
}

/** What {@link acquireChrome} was asked to do. */
export type AcquireChromeOptions = {
  /** The reviewed document the expected digest comes from. */
  manifest: ToolchainManifest;
  /** Where acquisitions live on this machine — `<state>/toolchain`, as `setup` resolves it. */
  toolchainDir: string;
  /** This machine, as `manifest.ts` describes one. Defaults to a real probe. */
  probe?: HostProbe | undefined;
  /** Where the provider's progress lines go. Defaults to nowhere. */
  log?: (line: string) => void;
};

/** What one acquisition produced, in the shape `toolchain.json` records. */
export type AcquiredChrome = {
  component: ToolchainComponent;
  /** The unpacked tree's root, which is the directory a re-run finds already committed. */
  destination: string;
  /** Whether this call fetched anything, or found the tree already there. */
  fetched: boolean;
};

/**
 * Acquire the headless shell, or refuse by name having downloaded nothing.
 *
 * Idempotent on purpose: a re-run over an already-committed tree re-locates the executable and
 * re-records it rather than re-fetching ~100 MB. `setup` is the command a user runs again after an
 * interrupted first attempt, and a provider that could only work on an empty machine would make the
 * second run worse than the first.
 */
export async function acquireChrome(options: AcquireChromeOptions): Promise<AcquiredChrome> {
  const log = options.log ?? ((): void => {});
  const probe = options.probe ?? probeHost();
  const selection = selectBrowserArtefact(options.manifest, probe);
  const destination = join(options.toolchainDir, `${CHROME_DIR_NAME}-${selection.version}`);

  let fetched = false;
  if (existsSync(destination)) {
    log(`chrome: already acquired at ${destination}`);
  } else {
    log(`chrome: ${selection.url}`);
    log(`chrome: expecting sha256 ${selection.sha256} (${selection.key})`);
    await acquireArtefact({ request: chromeRequest(options.manifest, probe), destination });
    fetched = true;
  }

  const executable = findExecutable(destination);
  if (executable === null) {
    throw new ChromeRefusal(
      `${destination} holds no headless shell executable — none of ` +
        `${CHROME_EXECUTABLE_NAMES.join(", ")} is in it. The archive at ${selection.url} matched ` +
        "its reviewed digest, so this is a layout this build does not know rather than a bad " +
        "download. Nothing was recorded.",
    );
  }
  return {
    component: {
      version: selection.version,
      path: executable,
      sha256: selection.sha256,
      provider: CHROME_PROVIDER,
    },
    destination,
    fetched,
  };
}

/**
 * The headless shell inside an unpacked tree, or `null`.
 *
 * A search rather than a fixed relative path: Chrome for Testing unpacks to
 * `chrome-headless-shell-<platform>/chrome-headless-shell` and Playwright's builds unpack to a
 * differently-named root, so one hard-coded path would be right on some platforms and produce a
 * recorded path that does not exist on the others. The walk is bounded to three levels, which every
 * published layout is well inside, so a malformed tree cannot turn this into a filesystem crawl.
 */
export function findExecutable(root: string, depth = 3): string | null {
  if (depth < 0 || !existsSync(root)) {
    return null;
  }
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && CHROME_EXECUTABLE_NAMES.includes(entry.name)) {
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
