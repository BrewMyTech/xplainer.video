/**
 * The toolchain manifest: what `xplainer setup` is allowed to fetch, and what it must hash to.
 *
 * [ADR 0005](../../../../docs/adr/0005-download-on-first-run-chrome-headless-shell-and-tts.md)
 * books this document as infrastructure rather than an afterthought — "a CDN and a
 * version/checksum manifest become infrastructure … the download path has to verify the checksum
 * before extracting" — and this module is that document's shape, its address, and the one function
 * that decides which entry in it describes *this* machine.
 *
 * **The address is the hostname Terraform provisions and no other.** `infra/terraform/main.tf`
 * declares `cdn_hostname = "cdn.${var.zone_name}"` as a **proxied** CNAME onto the R2 bucket, and
 * `variables.tf` defaults `zone_name` to `xplainer.video`. The bucket's own `r2.dev` URL is
 * excluded by that file's own argument — "the bucket's own r2.dev URL is explicitly not cached by
 * Cloudflare, so serving a ~110 MB CLI binary or a several-hundred-megabyte voice pack from it
 * would pay origin egress on every single download" — so an `r2.dev` host is refused here by
 * {@link toolchainManifestUrl} rather than being merely discouraged in prose.
 *
 * **The manifest cannot redirect a download.** The URL `setup` fetches for Chrome is the one the
 * *pinned Remotion line's own selector* returns for this machine ({@link chromeDownloadUrl}); the
 * manifest is then searched for an entry carrying **that exact URL**, and all the entry
 * contributes is the expected digest and the C-library constraint. So a manifest that named a
 * different artefact matches nothing and produces a refusal, not a download from somewhere else.
 *
 * **The digest is expected, never recorded.** Nothing in this module or in `download.ts` writes a
 * manifest, and no code path takes a digest from the bytes that arrived: `sha256` is a required
 * field, captured when the manifest was built and reviewed like any other pinned input. A digest
 * recorded on first acquisition cannot reject an incorrect-but-intact archive — it only detects
 * later drift — which is why the field is an input to the download rather than an output of it.
 *
 * **Selection is by resolved URL, not by `<os>-<arch>`.** `@remotion/renderer`'s
 * `getChromeDownloadUrl({platform, version, chromeMode})` branches on Amazon Linux 2023, on
 * `chromeMode`, and on whether the host's glibc is at least 2.35, so one platform and architecture
 * resolve to **several different artefacts**. {@link chromeDownloadUrl} mirrors that function
 * branch for branch — `manifest.test.ts` compares the two over the whole 80-row matrix, driving
 * the real module — and a configuration with no recorded entry is a named refusal, because a key
 * that ignores the C library selects an artefact that installs and cannot run.
 */

import { readFileSync } from "node:fs";
import process from "node:process";
import { PRECONDITION_UNMET_EXIT_CODE } from "../daemon/exit-codes.js";

/** The Cloudflare zone `infra/terraform/variables.tf` defaults `zone_name` to. */
export const TOOLCHAIN_ZONE_NAME = "xplainer.video";

/** `infra/terraform/main.tf`'s `local.cdn_hostname`, which is also `outputs.tf`'s `cdn_hostname`. */
export const TOOLCHAIN_CDN_HOSTNAME: string = `cdn.${TOOLCHAIN_ZONE_NAME}`;

/** Where the manifest sits under that hostname. `v1` is the path, `format_version` is the shape. */
export const TOOLCHAIN_MANIFEST_PATH = "toolchain/v1/manifest.json";

/** The one address `setup` reads the manifest from, built by the same rule any other zone is. */
export const TOOLCHAIN_MANIFEST_URL: string = toolchainManifestUrl(TOOLCHAIN_ZONE_NAME);

/** The shape this build understands. A newer document is reported, never guessed at. */
export const TOOLCHAIN_MANIFEST_FORMAT_VERSION = 1;

/**
 * The speech platforms a manifest must have an answer for, even when the answer is "not published".
 *
 * These are the four the plan names, and requiring them makes the difference between a manifest
 * that has nothing to say about Windows and one that says Windows has no bundle yet — the first is
 * a hole a reader has to notice, the second is a sentence `setup` can print.
 */
export const REQUIRED_SPEECH_PLATFORMS: readonly string[] = [
  "linux-x64",
  "linux-arm64",
  "darwin-arm64",
  "win32-x64",
];

/** Lowercase hex, 32 bytes. The one digest form this project records anywhere. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** `2.31`, `2.35` — a glibc floor as its own release spells it. */
const GLIBC_VERSION = /^\d+\.\d+$/;

/** A document that is not a toolchain manifest, or is one this build cannot read. */
export class ToolchainManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolchainManifestError";
  }
}

/** Why no artefact could be selected for this machine. One value per distinguishable condition. */
export type ToolchainSelectionReason =
  | "unsupported-platform"
  | "no-recorded-entry"
  | "artefact-unavailable"
  | "libc-unsatisfied";

/**
 * The manifest has no reviewed artefact for this machine, and nothing has been downloaded.
 *
 * It carries exit code `3` for the reason [ADR 0020](../../../../docs/adr/0020-always-running-local-daemon.md)
 * §Degraded paths gives it: every condition here is a precondition of writing that was knowable
 * before any byte was fetched.
 */
export class ToolchainSelectionRefusal extends Error {
  readonly reason: ToolchainSelectionReason;
  readonly exitCode: number = PRECONDITION_UNMET_EXIT_CODE;
  /** The URL the pinned selector resolved to, where the refusal is about one. */
  readonly url: string | undefined;

  constructor(reason: ToolchainSelectionReason, message: string, url?: string) {
    super(message);
    this.name = "ToolchainSelectionRefusal";
    this.reason = reason;
    this.url = url;
  }
}

/** One artefact the manifest has a reviewed digest for. */
export type RecordedArtefact = {
  status: "recorded";
  /** The exact URL this digest describes. For Chrome it is what the pinned selector returns. */
  url: string;
  /** Lowercase hex SHA-256, captured at manifest-build time. */
  sha256: string;
  /** The artefact's length in bytes, cross-checked against the `Content-Length` on the way in. */
  size: number;
};

/** One artefact the manifest deliberately has no digest for, and the measured reason why. */
export type UnavailableArtefact = {
  status: "unavailable";
  /** The URL this entry is about, where there is one — a Chrome branch always has one. */
  url?: string;
  /** What `setup` prints. A measurement or a decision, never "todo". */
  reason: string;
};

/** The C-library floor an artefact was built against, where the artefact has one. */
export type LibcConstraint = {
  libc?: "glibc" | "musl";
  min_glibc?: string;
};

/** One row of `chrome.expected`: an artefact plus the C library it needs. */
export type ChromeArtefact = (RecordedArtefact | UnavailableArtefact) & LibcConstraint;

/** One row of `speech`: a per-OS bundle, or the statement that none is published. */
export type SpeechArtefact = (RecordedArtefact & { version: string }) | UnavailableArtefact;

/** The document at {@link TOOLCHAIN_MANIFEST_URL}. */
export type ToolchainManifest = {
  format_version: number;
  chrome: {
    /** The Remotion line whose selector chose every URL below. */
    remotion: string;
    /** The Chrome build those URLs carry — `@remotion/renderer`'s own `TESTED_VERSION`. */
    version: string;
    /** Keyed for a human reader; **selected** by {@link ChromeArtefact.url}. */
    expected: Record<string, ChromeArtefact>;
  };
  speech: Record<string, SpeechArtefact>;
};

/**
 * The manifest URL for a zone, refusing the bucket's uncached `r2.dev` host by name.
 *
 * Taking the zone as an argument keeps this honest: `infra/terraform`'s `zone_name` is a variable
 * with a default, so a deployment that changes it changes this URL, and a test can prove the
 * refusal without pointing the shipped constant at a bucket.
 */
export function toolchainManifestUrl(zoneName: string): string {
  const trimmed = zoneName.trim();
  if (trimmed === "") {
    throw new ToolchainManifestError(
      "The delivery zone is empty, so there is no manifest to read.",
    );
  }
  if (trimmed.endsWith("r2.dev") || trimmed.includes(".r2.dev")) {
    throw new ToolchainManifestError(
      `${trimmed} is an r2.dev host. Cloudflare does not cache r2.dev, so a several-hundred-` +
        "megabyte artefact served from it pays origin egress on every download; " +
        "infra/terraform/main.tf provisions the proxied cdn.<zone_name> record for this.",
    );
  }
  return `https://cdn.${trimmed}/${TOOLCHAIN_MANIFEST_PATH}`;
}

/**
 * The delivery position, in the words a user meets when the published address answers nothing.
 *
 * The address above is provisioned and **empty**. `infra/terraform` declares the R2 bucket and the
 * proxied `cdn.<zone_name>` record and stops there; `infra/README.md` §"R2 delivery needs a custom
 * domain **and** a Cache Rule" records the two steps that module deliberately does not manage —
 * connecting the bucket to the custom domain, and the Cache Rule for the hostname — and neither is
 * scheduled in this phase. No command in this repository uploads a manifest either, so there is no
 * publisher to be waiting on: the upload is the release owner's step, in the phase-4 work that
 * builds the per-platform speech bundles.
 *
 * **So a fetch that fails here is the expected state and not an outage**, and a message that
 * reported only a DNS or HTTP error would send a reader to look for a broken CDN. This function is
 * the rest of that message: what is true about delivery, and then which routes still work on the
 * machine that is reading it.
 *
 * **There is no longer a Windows paragraph, and its removal is the point.** This function used to
 * carry a second, harder message for `win32`: that all three speech routes were unavailable there —
 * nothing published for `bundle`, a `docker` route needing a linux/amd64 engine a Windows host need
 * not have, and `--tts-url` recording a server rather than acquiring one — and that phase 4 was the
 * milestone which would close it. The `onnx` route closes it instead and closes it now, on
 * `win32-x64` and `win32-arm64` alike, by fetching the model, a voice and that platform's ONNX
 * Runtime from their own upstream homes and reading no manifest at all. So the asymmetry that
 * paragraph described has gone, and keeping a sentence that said Windows has no speech would have
 * been the most confidently wrong line in the product.
 *
 * What is left is one message for every platform: the address is empty, three of the four speech
 * routes never read it, and the one thing that genuinely is waiting on it is the **browser's**
 * expected digest.
 */
export function deliveryPosition(probe: HostProbe = probeHost()): string {
  const position =
    `Nothing is published to ${TOOLCHAIN_MANIFEST_URL} in this phase, so an address that answers ` +
    "nothing is the expected state rather than an outage. infra/terraform creates the R2 bucket " +
    `and the proxied ${TOOLCHAIN_CDN_HOSTNAME} record and stops there: connecting the bucket to ` +
    "that custom domain and adding the Cache Rule for the hostname are manual steps Terraform " +
    "does not manage, neither is scheduled here, and no command in this repository uploads a " +
    "manifest — that is the release owner's step, in phase 4. infra/README.md records both.";

  return (
    `${position}\n\n` +
    `Speech is not waiting on this address on ${speechPlatformKey(probe)}. Three of its four ` +
    "routes read no manifest at all:\n\n" +
    "  - `xplainer setup --tts-url <url>` records a Kokoro-FastAPI server you already run. " +
    "Nothing is downloaded and nothing is started.\n" +
    "  - the docker route pulls the pinned Kokoro-FastAPI image by digest. setup pulls it; the " +
    "daemon never starts a container.\n" +
    "  - the onnx route fetches the Kokoro model, one voice and this platform's ONNX Runtime, each " +
    "pinned by digest and each from its own upstream home, and synthesises in the narration " +
    "worker: no container, no Python and no server.\n\n" +
    "Only the bundle route reads this manifest, and it is the one with nothing published.\n\n" +
    "The browser is fetched from Google's own storage host at the URL the pinned Remotion line " +
    "resolves, and all this manifest contributes is the expected digest for that exact URL — so " +
    "`--manifest <path or https URL>` naming a reviewed copy is what lets a browser acquisition " +
    "run at all."
  );
}

/**
 * The five platform names `@remotion/renderer` knows, which are not Node's.
 *
 * `mac-arm64` rather than `darwin-arm64`, `win64` rather than `win32-x64`: the selector this module
 * mirrors takes Remotion's spelling, and translating at the boundary is what keeps the mirror
 * comparable with the original.
 */
export type RemotionPlatform = "linux64" | "linux-arm64" | "mac-x64" | "mac-arm64" | "win64";

/** Remotion's two acquisition modes. `headless-shell` is what a render uses. */
export type ChromeMode = "headless-shell" | "chrome-for-testing";

/** Everything `getChromeDownloadUrl` branches on, as data rather than as globals. */
export type ChromeSelection = {
  platform: RemotionPlatform;
  /** A pinned build number, or `null` for the tested one. Remotion's own parameter. */
  version: string | null;
  chromeMode: ChromeMode;
  /** `isAmazonLinux2023()` — `/etc/os-release` names Amazon Linux and `VERSION="2023"`. */
  amazonLinux2023: boolean;
  /** `canUseRemotionMediaBinaries()` — Linux with glibc ≥ 2.35. */
  remotionMediaBinaries: boolean;
};

/** `@remotion/renderer`'s `TESTED_VERSION` at the pinned line, mirrored and asserted against it. */
export const REMOTION_TESTED_CHROME_VERSION = "149.0.7790.0";

/** The Playwright build number that line falls back to on arm64, mirrored and asserted. */
export const REMOTION_PLAYWRIGHT_BUILD = "1421";

/** The glibc floor Remotion's own `MINIMUM_GLIBC_FOR_REMOTION_MEDIA` sets for its Linux builds. */
export const REMOTION_MEDIA_MIN_GLIBC: readonly [number, number] = [2, 35];

/**
 * The URL the pinned Remotion line downloads Chrome from, branch for branch.
 *
 * This is a **mirror**, and it is a mirror on purpose: `getChromeDownloadUrl` is not part of
 * `@remotion/renderer`'s public surface — the package's `exports` map offers `.`, `./client`,
 * `./pure` and `./error-handling`, and the function is in none of their declarations — so calling
 * it from product code would be reaching into somebody else's internals. What the test does
 * instead is drive the real module by absolute path and compare every branch, so the mirror is
 * checked rather than assumed, and a Remotion upgrade that changes a URL fails the suite here
 * instead of failing a user's render.
 */
export function chromeDownloadUrl(selection: ChromeSelection): string {
  const { platform, version, chromeMode, amazonLinux2023, remotionMediaBinaries } = selection;
  if (platform === "linux-arm64") {
    if (amazonLinux2023 && chromeMode === "headless-shell" && !version) {
      return "https://remotion.media/chromium-headless-shell-amazon-linux-arm64-149.0.7790.0.zip?clear";
    }
    if (chromeMode === "chrome-for-testing") {
      return `https://playwright.azureedge.net/builds/chromium/${version ?? REMOTION_PLAYWRIGHT_BUILD}/chromium-linux-arm64.zip`;
    }
    if (version) {
      return `https://playwright.azureedge.net/builds/chromium/${version}/chromium-headless-shell-linux-arm64.zip`;
    }
    if (remotionMediaBinaries) {
      return `https://remotion.media/chromium-headless-shell-linux-arm64-${REMOTION_TESTED_CHROME_VERSION}.zip?clear`;
    }
    return `https://playwright.azureedge.net/builds/chromium/${REMOTION_PLAYWRIGHT_BUILD}/chromium-headless-shell-linux-arm64.zip`;
  }
  if (chromeMode === "headless-shell") {
    if (amazonLinux2023 && platform === "linux64" && !version) {
      return "https://remotion.media/chromium-headless-shell-amazon-linux-x64-149.0.7790.0.zip?clear";
    }
    if (platform === "linux64" && version === null) {
      if (remotionMediaBinaries) {
        return `https://remotion.media/chromium-headless-shell-linux-x64-${REMOTION_TESTED_CHROME_VERSION}.zip?clear`;
      }
      return `https://storage.googleapis.com/chrome-for-testing-public/${REMOTION_TESTED_CHROME_VERSION}/${platform}/chrome-headless-shell-${platform}.zip`;
    }
    return `https://storage.googleapis.com/chrome-for-testing-public/${version ?? REMOTION_TESTED_CHROME_VERSION}/${platform}/chrome-headless-shell-${platform}.zip`;
  }
  return `https://storage.googleapis.com/chrome-for-testing-public/${version ?? REMOTION_TESTED_CHROME_VERSION}/${platform}/chrome-${platform}.zip`;
}

/** The three facts about this machine the two Remotion predicates are computed from. */
export type HostProbe = {
  /** `process.platform`. */
  platform: string;
  /** `process.arch`. */
  arch: string;
  /** `/etc/os-release`, or `null` where it cannot be read — which is every non-Linux host. */
  osRelease: string | null;
  /** The runtime glibc as `[major, minor]`, or `null` where Node does not report one. */
  glibc: [number, number] | null;
};

/** {@link HostProbe} for the process that is running now. */
export function probeHost(): HostProbe {
  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: readOsRelease(),
    glibc: runtimeGlibc(),
  };
}

function readOsRelease(): string | null {
  if (process.platform !== "linux") {
    return null;
  }
  try {
    return readFileSync("/etc/os-release", "utf-8");
  } catch {
    return null;
  }
}

/**
 * The runtime glibc, read the way Remotion reads it.
 *
 * `process.report.getReport().header.glibcVersionRuntime` is present only on a glibc Linux, which
 * is exactly what makes its absence meaningful: a musl host reports nothing here, and Remotion's
 * own `isGlibcVersionAtLeast` treats an unreadable version as "not compatible, to be safe". A
 * version that is not two dot-separated numbers is `null` for the same reason it is in Remotion —
 * agreeing with the original matters more than parsing more forms than it does.
 */
function runtimeGlibc(): [number, number] | null {
  if (process.platform !== "linux") {
    return null;
  }
  const report = process.report?.getReport();
  if (report === undefined || typeof report === "string") {
    return null;
  }
  const header = (report as { header?: { glibcVersionRuntime?: unknown } }).header;
  const runtime = header?.glibcVersionRuntime;
  if (typeof runtime !== "string") {
    return null;
  }
  const parts = runtime.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    return null;
  }
  return [major, minor];
}

/** `isAmazonLinux2023()`, over a probe rather than over the filesystem. */
export function isAmazonLinux2023(probe: HostProbe): boolean {
  if (probe.platform !== "linux" || probe.osRelease === null) {
    return false;
  }
  return probe.osRelease.includes("Amazon Linux") && probe.osRelease.includes('VERSION="2023"');
}

/** `canUseRemotionMediaBinaries()`, over a probe. Linux only, and glibc ≥ 2.35. */
export function canUseRemotionMediaBinaries(probe: HostProbe): boolean {
  if (probe.platform !== "linux") {
    return false;
  }
  return atLeastGlibc(probe.glibc, REMOTION_MEDIA_MIN_GLIBC);
}

function atLeastGlibc(
  found: [number, number] | null,
  required: readonly [number, number],
): boolean {
  if (found === null) {
    return false;
  }
  if (found[0] > required[0]) {
    return true;
  }
  return found[0] === required[0] && found[1] >= required[1];
}

/** Node's platform and architecture in Remotion's spelling, or `null` where Remotion has none. */
export function remotionPlatform(platform: string, arch: string): RemotionPlatform | null {
  if (platform === "darwin") {
    return arch === "arm64" ? "mac-arm64" : arch === "x64" ? "mac-x64" : null;
  }
  if (platform === "win32") {
    return arch === "x64" ? "win64" : null;
  }
  if (platform === "linux") {
    return arch === "x64" ? "linux64" : arch === "arm64" ? "linux-arm64" : null;
  }
  return null;
}

/** How `setup` acquires Chrome. Remotion's default and ours is the headless shell. */
export const DEFAULT_CHROME_MODE: ChromeMode = "headless-shell";

/**
 * What the pinned Remotion line would download on the machine this probe describes.
 *
 * Refuses `unsupported-platform` rather than guessing: a 32-bit Linux or a Windows arm64 has no
 * Remotion platform name at all, and inventing one would produce a URL that 404s halfway through
 * `setup` instead of a sentence before it starts.
 */
export function hostChromeSelection(
  probe: HostProbe,
  options: { chromeMode?: ChromeMode; version?: string | null } = {},
): ChromeSelection {
  const platform = remotionPlatform(probe.platform, probe.arch);
  if (platform === null) {
    throw new ToolchainSelectionRefusal(
      "unsupported-platform",
      `The pinned Remotion line has no Chrome build for ${probe.platform}-${probe.arch}. ` +
        "Supported: darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64.",
    );
  }
  return {
    platform,
    version: options.version ?? null,
    chromeMode: options.chromeMode ?? DEFAULT_CHROME_MODE,
    amazonLinux2023: isAmazonLinux2023(probe),
    remotionMediaBinaries: canUseRemotionMediaBinaries(probe),
  };
}

/** A selected Chrome artefact: which manifest row it came from, and what it must hash to. */
export type ChromeAcquisition = {
  /** The manifest key, for a message a human reads. */
  key: string;
  /** The URL the **selector** produced, which is what makes the manifest unable to redirect it. */
  url: string;
  /** The configuration that URL was resolved for, so a report can say why this artefact. */
  selection: ChromeSelection;
  sha256: string;
  size: number;
};

/**
 * The reviewed digest for what this machine would download, or a refusal saying why there is none.
 *
 * The lookup is by exact URL and never by `<os>-<arch>`: `chrome.expected`'s keys are for a human
 * reviewing the file, and the machine matches on the artefact itself, which is the only key that
 * survives Remotion's distribution and glibc branches.
 *
 * It takes the **probe** rather than a {@link ChromeSelection} so that the C-library check cannot
 * be skipped by a caller who only wanted a URL: selection and constraint are one answer, and
 * ADR 0020's "Alpine is blocked on rendering, not on init" is what skipping it buys.
 */
export function selectChromeArtefact(
  manifest: ToolchainManifest,
  probe: HostProbe,
  options: { chromeMode?: ChromeMode; version?: string | null } = {},
): ChromeAcquisition {
  const selection = hostChromeSelection(probe, options);
  const url = chromeDownloadUrl(selection);
  const found = Object.entries(manifest.chrome.expected).find(([, entry]) => entry.url === url);
  if (found === undefined) {
    throw new ToolchainSelectionRefusal(
      "no-recorded-entry",
      `The toolchain manifest records no expected digest for ${url}, which is what the pinned ` +
        `Remotion line (${manifest.chrome.remotion}) downloads on this machine. setup will not ` +
        "trust an artefact it has no reviewed digest for; the manifest has to record this " +
        "configuration first.",
      url,
    );
  }
  const [key, entry] = found;
  if (entry.status === "unavailable") {
    throw new ToolchainSelectionRefusal(
      "artefact-unavailable",
      `The toolchain manifest records ${key} as unavailable: ${entry.reason}`,
      url,
    );
  }
  assertLibcSatisfied(key, entry, probe);
  return { key, url, selection, sha256: entry.sha256, size: entry.size };
}

/**
 * Refuse an artefact whose C library this machine does not have.
 *
 * ADR 0020 records that "Alpine is blocked on rendering, not on init", and this is the check that
 * makes the block legible at acquisition instead: a musl host reports no runtime glibc at all, and
 * a glibc older than the artefact's floor produces a browser that unpacks and cannot start. Both
 * are stated before ~100 MB is fetched.
 */
export function assertLibcSatisfied(key: string, entry: LibcConstraint, probe: HostProbe): void {
  if (entry.libc === undefined && entry.min_glibc === undefined) {
    return;
  }
  if (probe.platform !== "linux") {
    return;
  }
  if (entry.libc === "glibc" && probe.glibc === null) {
    throw new ToolchainSelectionRefusal(
      "libc-unsatisfied",
      `${key} is a glibc build and this machine reports no runtime glibc, which is what a musl ` +
        "system (Alpine) looks like. The artefact would unpack and fail to start; use a glibc " +
        "base image, or point setup at a Chrome you supply.",
    );
  }
  if (entry.min_glibc === undefined) {
    return;
  }
  const required = parseGlibc(entry.min_glibc);
  if (!atLeastGlibc(probe.glibc, required)) {
    const found = probe.glibc === null ? "none" : probe.glibc.join(".");
    throw new ToolchainSelectionRefusal(
      "libc-unsatisfied",
      `${key} needs glibc ${entry.min_glibc} or newer and this machine reports ${found}.`,
    );
  }
}

function parseGlibc(version: string): [number, number] {
  const parts = version.split(".");
  return [Number(parts[0]), Number(parts[1])];
}

/** The speech bundle for a platform, or a refusal naming what the manifest says instead. */
export function selectSpeechBundle(
  manifest: ToolchainManifest,
  platformKey: string,
): RecordedArtefact & { version: string } {
  const entry = manifest.speech[platformKey];
  if (entry === undefined) {
    throw new ToolchainSelectionRefusal(
      "no-recorded-entry",
      `The toolchain manifest has no speech entry for ${platformKey}.`,
    );
  }
  if (entry.status === "unavailable") {
    throw new ToolchainSelectionRefusal(
      "artefact-unavailable",
      `The toolchain manifest records no speech bundle for ${platformKey}: ${entry.reason}`,
    );
  }
  return entry;
}

/** `<platform>-<arch>` in Node's own spelling, which is how the speech map is keyed. */
export function speechPlatformKey(probe: HostProbe): string {
  return `${probe.platform}-${probe.arch}`;
}

/** Read and validate a manifest document. `source` names the file or URL in every message. */
export function parseToolchainManifest(text: string, source: string): ToolchainManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ToolchainManifestError(
      `${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const document = asRecord(parsed, source, "the manifest");
  const formatVersion = asNumber(document.format_version, source, "format_version");
  if (formatVersion !== TOOLCHAIN_MANIFEST_FORMAT_VERSION) {
    throw new ToolchainManifestError(
      `${source} says format_version ${formatVersion}; this build reads ` +
        `${TOOLCHAIN_MANIFEST_FORMAT_VERSION}. A newer manifest is a rollback signal and never ` +
        "corruption: nothing here is guessed at.",
    );
  }
  const chrome = asRecord(document.chrome, source, "chrome");
  const expected = asRecord(chrome.expected, source, "chrome.expected");
  const chromeEntries: Record<string, ChromeArtefact> = {};
  for (const [key, value] of Object.entries(expected)) {
    chromeEntries[key] = asChromeArtefact(value, source, `chrome.expected.${key}`);
  }
  if (Object.keys(chromeEntries).length === 0) {
    throw new ToolchainManifestError(`${source} records no Chrome artefacts at all.`);
  }
  const speech = asRecord(document.speech, source, "speech");
  const speechEntries: Record<string, SpeechArtefact> = {};
  for (const [key, value] of Object.entries(speech)) {
    speechEntries[key] = asSpeechArtefact(value, source, `speech.${key}`);
  }
  for (const platform of REQUIRED_SPEECH_PLATFORMS) {
    if (speechEntries[platform] === undefined) {
      throw new ToolchainManifestError(
        `${source} has no speech entry for ${platform}. Every supported platform needs an ` +
          'answer, and "no bundle is published yet" is one — a missing key is not.',
      );
    }
  }
  return {
    format_version: formatVersion,
    chrome: {
      remotion: asNonEmptyString(chrome.remotion, source, "chrome.remotion"),
      version: asNonEmptyString(chrome.version, source, "chrome.version"),
      expected: chromeEntries,
    },
    speech: speechEntries,
  };
}

function asChromeArtefact(value: unknown, source: string, field: string): ChromeArtefact {
  const entry = asRecord(value, source, field);
  const libc = asLibc(entry.libc, source, `${field}.libc`);
  const minGlibc = asMinGlibc(entry.min_glibc, source, `${field}.min_glibc`);
  if (entry.status === "unavailable") {
    return {
      status: "unavailable",
      ...(entry.url === undefined ? {} : { url: asArtefactUrl(entry.url, source, `${field}.url`) }),
      reason: asNonEmptyString(entry.reason, source, `${field}.reason`),
      ...libc,
      ...minGlibc,
    };
  }
  return {
    status: asRecorded(entry.status, source, field),
    url: asArtefactUrl(entry.url, source, `${field}.url`),
    sha256: asSha256(entry.sha256, source, `${field}.sha256`),
    size: asSize(entry.size, source, `${field}.size`),
    ...libc,
    ...minGlibc,
  };
}

function asSpeechArtefact(value: unknown, source: string, field: string): SpeechArtefact {
  const entry = asRecord(value, source, field);
  if (entry.status === "unavailable") {
    return {
      status: "unavailable",
      reason: asNonEmptyString(entry.reason, source, `${field}.reason`),
    };
  }
  const url = asArtefactUrl(entry.url, source, `${field}.url`);
  assertDeliveredByUs(url, source, `${field}.url`);
  return {
    status: asRecorded(entry.status, source, field),
    version: asNonEmptyString(entry.version, source, `${field}.version`),
    url,
    sha256: asSha256(entry.sha256, source, `${field}.sha256`),
    size: asSize(entry.size, source, `${field}.size`),
  };
}

/**
 * A speech bundle is **ours**, so it comes from the hostname Terraform provisions and no other.
 *
 * Chrome is not checked this way on purpose: its URL is chosen by the pinned Remotion selector, so
 * the host is whatever that line publishes to, and the manifest only supplies the digest.
 */
function assertDeliveredByUs(url: string, source: string, field: string): void {
  const host = new URL(url).host;
  if (host !== TOOLCHAIN_CDN_HOSTNAME) {
    throw new ToolchainManifestError(
      `${source}: ${field} is served from ${host}, and speech bundles are served from ` +
        `${TOOLCHAIN_CDN_HOSTNAME} — the proxied, cached record infra/terraform provisions. An ` +
        "r2.dev URL in particular is uncached and pays origin egress on every download.",
    );
  }
}

function asRecord(value: unknown, source: string, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolchainManifestError(`${source}: ${field} is not an object.`);
  }
  return value as Record<string, unknown>;
}

function asNumber(value: unknown, source: string, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolchainManifestError(`${source}: ${field} is not a finite number.`);
  }
  return value;
}

function asNonEmptyString(value: unknown, source: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolchainManifestError(`${source}: ${field} is not a non-empty string.`);
  }
  return value;
}

function asRecorded(value: unknown, source: string, field: string): "recorded" {
  if (value !== "recorded") {
    throw new ToolchainManifestError(
      `${source}: ${field}.status is ${JSON.stringify(value)}, which is neither "recorded" nor ` +
        '"unavailable".',
    );
  }
  return value;
}

function asSha256(value: unknown, source: string, field: string): string {
  const digest = asNonEmptyString(value, source, field);
  if (!SHA256_HEX.test(digest)) {
    throw new ToolchainManifestError(
      `${source}: ${field} is not a lowercase 64-character hex SHA-256.`,
    );
  }
  return digest;
}

function asSize(value: unknown, source: string, field: string): number {
  const size = asNumber(value, source, field);
  if (!Number.isInteger(size) || size <= 0) {
    throw new ToolchainManifestError(
      `${source}: ${field} is not a positive whole number of bytes.`,
    );
  }
  return size;
}

function asArtefactUrl(value: unknown, source: string, field: string): string {
  const url = asNonEmptyString(value, source, field);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ToolchainManifestError(`${source}: ${field} is not an absolute URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new ToolchainManifestError(
      `${source}: ${field} is ${parsed.protocol}//, and an artefact is fetched over https only.`,
    );
  }
  return url;
}

function asLibc(value: unknown, source: string, field: string): { libc?: "glibc" | "musl" } {
  if (value === undefined) {
    return {};
  }
  if (value !== "glibc" && value !== "musl") {
    throw new ToolchainManifestError(
      `${source}: ${field} is ${JSON.stringify(value)}, which is neither "glibc" nor "musl".`,
    );
  }
  return { libc: value };
}

function asMinGlibc(value: unknown, source: string, field: string): { min_glibc?: string } {
  if (value === undefined) {
    return {};
  }
  const version = asNonEmptyString(value, source, field);
  if (!GLIBC_VERSION.test(version)) {
    throw new ToolchainManifestError(`${source}: ${field} is not a <major>.<minor> glibc version.`);
  }
  return { min_glibc: version };
}
