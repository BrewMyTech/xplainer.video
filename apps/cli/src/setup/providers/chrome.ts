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
 * file a render actually needs — the row's `member`, inside the unpacked tree — while the `sha256`
 * beside it is the reviewed digest the archive was admitted on. The two answer different questions
 * and the schema's own wording keeps them apart. The row's `licence_member` has to be in the tree
 * too, because ADR 0031's note of 2026-11-12 (D4) pins one publisher, one version and "an in-archive
 * licence everywhere", and only an acquisition that refuses an archive without one makes that so.
 *
 * **A warm cache is re-verified, never trusted** (`acquired.ts`), exactly as ffmpeg's is: the
 * directory's name carries the archive's digest, the tree carries a record of what it was admitted
 * on, and a re-run re-hashes the executable and the licence against that record before it records
 * anything. Until 2026-11-12 a directory named after the version alone was recorded at the reviewed
 * digest with nothing about it checked, so a `#!/bin/sh` stub there passed as the browser. A tree in
 * that older layout is not reused; it is simply not the name this build looks for.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolchainComponent } from "@xplainer/protocol";
import { PRECONDITION_UNMET_EXIT_CODE } from "../../daemon/exit-codes.js";
import { isExecutableFile } from "../../render/encode.js";
import { stageAcquired, verifyAcquired } from "../acquired.js";
import { acquireArtefact } from "../download.js";
import {
  type BrowserSelection,
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

/** How many hex characters of the archive digest go in that name — enough to be an identity. */
export const CHROME_DIGEST_IN_NAME = 12;

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

/**
 * The directory one build commits itself under: its version **and** its archive's digest.
 *
 * The version is what a person reads; the digest is what makes the name an identity, so a
 * re-published archive at an unchanged version cannot be served out of the tree the last one left.
 */
export function chromeDestination(toolchainDir: string, selection: BrowserSelection): string {
  return join(
    toolchainDir,
    `${CHROME_DIR_NAME}-${selection.version}-${selection.sha256.slice(0, CHROME_DIGEST_IN_NAME)}`,
  );
}

/** Why a browser was not recorded. One value per distinguishable condition. */
export type ChromeRefusalReason =
  | "cache-unverified"
  | "member-missing"
  | "licence-missing"
  | "not-executable";

/** The browser was not acquired, and nothing was committed. */
export class ChromeRefusal extends Error {
  readonly reason: ChromeRefusalReason;
  readonly exitCode: number = PRECONDITION_UNMET_EXIT_CODE;

  constructor(reason: ChromeRefusalReason, message: string) {
    super(message);
    this.name = "ChromeRefusal";
    this.reason = reason;
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
  /** Whether this call fetched anything, or found the tree already there and verified it. */
  fetched: boolean;
};

/**
 * Acquire the headless shell, or refuse by name having committed nothing.
 *
 * Idempotent on purpose: a re-run over a tree an earlier run committed re-verifies it and
 * re-records it rather than re-fetching ~100 MB. `setup` is the command a user runs again after an
 * interrupted first attempt, and a provider that could only work on an empty machine would make the
 * second run worse than the first.
 */
export async function acquireChrome(options: AcquireChromeOptions): Promise<AcquiredChrome> {
  const log = options.log ?? ((): void => {});
  const probe = options.probe ?? probeHost();
  const selection = selectBrowserArtefact(options.manifest, probe);
  const destination = chromeDestination(options.toolchainDir, selection);
  const expectation = chromeRequest(options.manifest, probe);
  /** The two files the tree is made of, as far as anything here reads it. */
  const witnesses = [selection.member, selection.licence_member];
  const executable = inTree(destination, selection.member);

  if (existsSync(destination)) {
    const verdict = verifyAcquired(destination, expectation);
    if (!verdict.ok) {
      throw new ChromeRefusal("cache-unverified", `chrome: ${verdict.detail}`);
    }
    const witnessed = verdict.files.map((file) => file.path);
    const unwitnessed = witnesses.filter(
      (member) => !witnessed.includes(inTree(destination, member)),
    );
    if (unwitnessed.length > 0) {
      throw new ChromeRefusal(
        "cache-unverified",
        `chrome: ${destination} was committed without ${unwitnessed.join(" and ")} in its ` +
          `record, so it is not the tree this row admits. Remove ${destination} and run setup ` +
          "again.",
      );
    }
    if (!isExecutableFile(executable)) {
      throw new ChromeRefusal(
        "cache-unverified",
        `chrome: ${executable} is no longer an executable file, though its bytes are the ones ` +
          `acquired. Remove ${destination} and run setup again.`,
      );
    }
    log(`chrome: already acquired and verified at ${destination}`);
    return { component: component(selection, executable), destination, fetched: false };
  }

  log(`chrome: ${selection.url}`);
  log(`chrome: expecting sha256 ${selection.sha256} (${selection.key})`);
  await acquireArtefact({
    request: expectation,
    destination,
    stage: (staging) => {
      assertTree(selection, staging);
      stageAcquired(staging, expectation, witnesses);
    },
  });
  return { component: component(selection, executable), destination, fetched: true };
}

/** A `/`-separated archive member, as a path under `root`. */
function inTree(root: string, member: string): string {
  return join(root, ...member.split("/"));
}

/** The marker entry: the row's version, its member's path, and the archive's reviewed digest. */
function component(selection: BrowserSelection, executable: string): ToolchainComponent {
  return {
    version: selection.version,
    path: executable,
    sha256: selection.sha256,
    provider: CHROME_PROVIDER,
  };
}

/**
 * Refuse a staging tree that lacks the row's executable or its licence, or whose executable will
 * not run, before it is committed. The archive matched its reviewed digest, so each of these is a
 * row that does not describe that archive rather than a bad download.
 */
function assertTree(selection: BrowserSelection, staging: string): void {
  const executable = inTree(staging, selection.member);
  if (!existsSync(executable)) {
    throw new ChromeRefusal(
      "member-missing",
      `chrome: ${selection.url} matched its reviewed digest and does not contain ` +
        `${selection.member}, which its manifest row names as the headless shell. Nothing was ` +
        "committed.",
    );
  }
  if (!existsSync(inTree(staging, selection.licence_member))) {
    throw new ChromeRefusal(
      "licence-missing",
      `chrome: ${selection.url} matched its reviewed digest and does not contain ` +
        `${selection.licence_member}, the licence its manifest row names. A browser is recorded ` +
        "only with the licence it is distributed under beside it. Nothing was committed.",
    );
  }
  if (!isExecutableFile(executable)) {
    throw new ChromeRefusal(
      "not-executable",
      `chrome: ${selection.member} in ${selection.url} is not an executable file, so it is not a ` +
        "headless shell a render can launch. Nothing was committed.",
    );
  }
}
