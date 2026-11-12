/**
 * The toolchain manifest: what `xplainer setup` is allowed to fetch, and what it must hash to.
 *
 * [ADR 0005](../../../../docs/adr/0005-download-on-first-run-chrome-headless-shell-and-tts.md)
 * books this document as infrastructure rather than an afterthought — "a CDN and a
 * version/checksum manifest become infrastructure … the download path has to verify the checksum
 * before extracting" — and this module is that document's shape, its address, and the functions
 * that decide which row in it describes *this* machine.
 *
 * **The address is the hostname Terraform provisions and no other.** `infra/terraform/main.tf`
 * declares `cdn_hostname = "cdn.${var.zone_name}"` as a **proxied** CNAME onto the R2 bucket, and
 * `variables.tf` defaults `zone_name` to `xplainer.video`. The bucket's own `r2.dev` URL is
 * excluded by that file's own argument — "the bucket's own r2.dev URL is explicitly not cached by
 * Cloudflare, so serving a ~110 MB CLI binary or a several-hundred-megabyte voice pack from it
 * would pay origin egress on every single download" — so an `r2.dev` host is refused here by
 * {@link toolchainManifestUrl} rather than being merely discouraged in prose.
 *
 * **Format 2, at a path of its own** ([ADR 0031](../../../../docs/adr/0031-an-owned-renderer-replaces-remotion-ffmpeg-encodes.md)'s
 * note of 2026-11-12, D3). Released CLIs read `toolchain/v1/manifest.json` and refuse a document
 * of a newer format, so the version-1 document stays where it is for them and this build reads
 * `toolchain/v2/manifest.json`. Its `browser` and `ffmpeg` blocks are **selected by
 * `<platform>-<arch>`** — there is exactly one artefact per platform for each, and the one Linux
 * variation, the C library, is a constraint on that artefact that {@link assertLibcSatisfied}
 * expresses rather than a branch to another one. `speech` is carried over from format 1 unchanged.
 *
 * **The manifest names the URL, and code names who may serve it.** Selected by key, a row supplies
 * its own URL, so every `browser` and `ffmpeg` URL has to begin with a prefix
 * {@link ARTEFACT_ALLOWLIST} maps to a publisher — checked when the document is parsed, before a
 * byte is fetched, and a prefix rather than a host because `github.com` hosts every GitHub user's
 * releases. A new publisher is a reviewed code change, never a manifest edit. Speech bundles keep
 * their own, older and narrower rule: they are ours, so they come from
 * {@link TOOLCHAIN_CDN_HOSTNAME}.
 *
 * **The digest is expected, never recorded.** Nothing in this module or in `download.ts` writes a
 * manifest, and no code path takes a digest from the bytes that arrived: `sha256` is a required
 * field, captured when the manifest was built and reviewed like any other pinned input. A digest
 * recorded on first acquisition cannot reject an incorrect-but-intact archive — it only detects
 * later drift — which is why the field is an input to the download rather than an output of it.
 * FFmpeg's rows carry the same promise one level down: `member_sha256` is what the one binary kept
 * out of the archive must hash to.
 */

import process from "node:process";
import { PRECONDITION_UNMET_EXIT_CODE } from "../daemon/exit-codes.js";
import { ArchiveRefusal, safeJoin } from "./archive.js";

/** The Cloudflare zone `infra/terraform/variables.tf` defaults `zone_name` to. */
export const TOOLCHAIN_ZONE_NAME = "xplainer.video";

/** `infra/terraform/main.tf`'s `local.cdn_hostname`, which is also `outputs.tf`'s `cdn_hostname`. */
export const TOOLCHAIN_CDN_HOSTNAME: string = `cdn.${TOOLCHAIN_ZONE_NAME}`;

/**
 * Where the manifest sits under that hostname. `v2` is the path, `format_version` is the shape.
 *
 * The two moved together on purpose: a format-2 document at the version-1 path would be refused
 * as "newer" by every released CLI, which reads that path.
 */
export const TOOLCHAIN_MANIFEST_PATH = "toolchain/v2/manifest.json";

/** The one address `setup` reads the manifest from, built by the same rule any other zone is. */
export const TOOLCHAIN_MANIFEST_URL: string = toolchainManifestUrl(TOOLCHAIN_ZONE_NAME);

/** The shape this build understands. Any other is reported, never guessed at. */
export const TOOLCHAIN_MANIFEST_FORMAT_VERSION = 2;

/**
 * Every URL prefix a `browser` or `ffmpeg` row may name, and who publishes what is under it.
 *
 * The publisher travels with the parsed row, so what `setup` prints and records about an artefact's
 * origin is decided here, in code, and never by the document it is checking. Each prefix ends in a
 * `/` and is matched against the URL's normal form, so neither a sibling path
 * (`…/FFmpeg-Builds-evil/`) nor a `..` segment can stand in for it.
 */
export const ARTEFACT_ALLOWLIST: Readonly<Record<string, string>> = {
  "https://storage.googleapis.com/chrome-for-testing-public/": "Google (Chrome for Testing)",
  "https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/": "BtbN FFmpeg-Builds",
  [`https://${TOOLCHAIN_CDN_HOSTNAME}/toolchain/v1/ffmpeg/`]: "xplainer.video",
};

/**
 * The platforms a manifest must have a `browser` answer for, even when the answer is "unavailable".
 *
 * The five Chrome for Testing publishes a headless shell for. `win32-arm64` is not one of them, so
 * it is not required here, and a machine asking for it is refused as an unsupported platform.
 */
export const BROWSER_PLATFORMS: readonly string[] = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
];

/**
 * The platforms a manifest must have an `ffmpeg` answer for: the browser's five and `win32-arm64`,
 * which has an FFmpeg pin and no Chrome row, and so cannot render (ADR 0031, Follow-up 5).
 */
export const FFMPEG_PLATFORMS: readonly string[] = [...BROWSER_PLATFORMS, "win32-arm64"];

/**
 * The licences an FFmpeg row may declare: FFmpeg's own four free configurations, as SPDX ids.
 *
 * `configure` reports exactly one of `LGPL version 2.1 or later`, `LGPL version 3 or later`,
 * `GPL version 2 or later`, `GPL version 3 or later` or `nonfree and unredistributable`, and only
 * the last is missing here: a build nobody may redistribute is not one a manifest may name.
 */
export const ACCEPTED_FFMPEG_LICENCES: readonly string[] = [
  "LGPL-2.1-or-later",
  "LGPL-3.0-or-later",
  "GPL-2.0-or-later",
  "GPL-3.0-or-later",
];

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
  /** The URL the selected row names, where the refusal is about one. */
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
  /** The exact URL this digest describes. */
  url: string;
  /** Lowercase hex SHA-256, captured at manifest-build time. */
  sha256: string;
  /** The artefact's length in bytes, cross-checked against the `Content-Length` on the way in. */
  size: number;
};

/** One artefact the manifest deliberately has no digest for, and the measured reason why. */
export type UnavailableArtefact = {
  status: "unavailable";
  /** The URL this entry is about, where there is one. */
  url?: string;
  /** What `setup` prints. A measurement or a decision, never "todo". */
  reason: string;
};

/** The C-library floor an artefact was built against, where the artefact has one. */
export type LibcConstraint = {
  libc?: "glibc" | "musl";
  min_glibc?: string;
};

/** A `browser` row with a digest: a Chrome for Testing headless shell, and where it unpacks to. */
export type RecordedBrowserArtefact = RecordedArtefact & {
  /** The Chrome build, exactly as its publisher spells it. */
  version: string;
  /** The headless shell executable inside the archive, as the archive names it. */
  member: string;
  /** The licence file inside the archive, as the archive names it. */
  licence_member: string;
  /** Who serves the URL: {@link ARTEFACT_ALLOWLIST}'s answer, never the document's. */
  publisher: string;
} & LibcConstraint;

/** One row of `browser.expected`. */
export type BrowserArtefact = RecordedBrowserArtefact | (UnavailableArtefact & LibcConstraint);

/** An `ffmpeg` row with a digest: an archive, and the one binary and the licence kept out of it. */
export type RecordedFfmpegArtefact = RecordedArtefact & {
  /** The build, exactly as its publisher spells it — `9.0.2`, `n9.0.2-39-g7adfbe40dc`. */
  version: string;
  /** The `ffmpeg[.exe]` inside the archive, as the archive names it. */
  member: string;
  /** What {@link RecordedFfmpegArtefact.member} must hash to, captured at manifest-build time. */
  member_sha256: string;
  /** Its length in bytes. */
  member_size: number;
  /** One of {@link ACCEPTED_FFMPEG_LICENCES}: what the build's own `configure` says it is. */
  licence: string;
  /** The licence text inside the archive, kept beside the binary. */
  licence_member: string;
  /** Further members kept beside the binary — our own build's `SOURCE.txt` and `BUILDINFO.txt`. */
  extra_members?: string[];
  /** Where this build's corresponding source is offered, where its publisher names one. */
  source_url?: string;
  /** Who serves the URL: {@link ARTEFACT_ALLOWLIST}'s answer, never the document's. */
  publisher: string;
} & LibcConstraint;

/** One row of `ffmpeg.expected`. */
export type FfmpegArtefact = RecordedFfmpegArtefact | (UnavailableArtefact & LibcConstraint);

/** One row of `speech`: a per-OS bundle, or the statement that none is published. */
export type SpeechArtefact = (RecordedArtefact & { version: string }) | UnavailableArtefact;

/** The document at {@link TOOLCHAIN_MANIFEST_URL}. */
export type ToolchainManifest = {
  format_version: number;
  /** Keyed by `<platform>-<arch>`, in Node's spelling, and selected by that key. */
  browser: { expected: Record<string, BrowserArtefact> };
  /** Keyed and selected the same way. */
  ffmpeg: { expected: Record<string, FfmpegArtefact> };
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
 * The delivery position, in the words a user meets when the published address cannot be read.
 *
 * **Rewritten 2026-09-11**, when the manifest was first published: a fetch failure here **is** a
 * failure — no route, a proxy, DNS, or an outage — and the message names those causes rather than
 * explaining away an empty address. **Rewritten again 2026-11-12, for format 2**: the version-2
 * document at {@link TOOLCHAIN_MANIFEST_URL} is uploaded as a release step, and the release check
 * refuses to publish a CLI until the served copy is byte-identical to the committed one (ADR 0031's
 * note, D8), so a published build that reads this message is reading it about an address that was
 * answering when that build shipped.
 *
 * What the 2026-11-12 rewrite changed is the paragraph about what the failure blocks. It used to
 * say the browser's URL came from a mirrored selector and that the manifest contributed only a
 * digest for it. Neither is true of format 2: the manifest names both the browser's URL — Chrome
 * for Testing, on Google's storage — and ffmpeg's — BtbN's FFmpeg-Builds releases on GitHub for
 * Linux and Windows, this project's CDN for macOS — and code admits only the publishers
 * {@link ARTEFACT_ALLOWLIST} names. So the two components that cannot be improvised are now the
 * browser and ffmpeg, and that is what the message says.
 *
 * Two claims are deliberately kept because they remain accurate. **No command in this repository
 * uploads a manifest** — the release check reads the served copy and never writes it — so a stale
 * manifest is a thing a human forgot rather than a pipeline that failed. And the **per-platform
 * speech bundles are still unpublished**, which is phase 4 and is deferred by choice rather than
 * broken, because the `onnx` route acquires an engine from its components' own upstream homes.
 *
 * **There is one message for every platform.** This function used to carry a second, harder
 * message for `win32`: that all three speech routes were unavailable there. The `onnx` route closes
 * that on `win32-x64` and `win32-arm64` alike, so a sentence saying Windows has no speech would be
 * the most confidently wrong line in the product.
 */
export function deliveryPosition(probe: HostProbe = probeHost()): string {
  const position =
    `The toolchain manifest is published at ${TOOLCHAIN_MANIFEST_URL}, so this is a failure to ` +
    "read it rather than an address that was never meant to answer. The usual causes, in the " +
    "order worth checking: no network route to " +
    `${TOOLCHAIN_CDN_HOSTNAME}; an HTTP proxy that intercepted the request (a 407 or an HTML ` +
    "filter page rather than JSON); DNS that does not resolve the hostname; or an outage at the " +
    "delivery edge. infra/terraform declares the bucket, the custom domain and its Cache Rule, " +
    "and infra/README.md records the whole position. One thing it cannot tell you: no command in " +
    "this repository uploads a manifest, so a document that is present but older than this build " +
    "expects is a manual release step somebody skipped, not a pipeline that failed.";

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
    "The browser and ffmpeg are both named by this manifest: the browser is Google's Chrome for " +
    "Testing headless shell, and ffmpeg is a BtbN FFmpeg-Builds release on Linux and Windows and " +
    `this project's own build, served from ${TOOLCHAIN_CDN_HOSTNAME}, on macOS. The manifest ` +
    "supplies each one's URL and expected digest, and setup admits a URL only from a publisher " +
    "this build names in code. Neither can be improvised: without the reviewed digest there is " +
    "nothing to admit the download on, and setup refuses rather than unpacking unreviewed bytes. " +
    "So the browser and ffmpeg are what this failure actually blocks, and " +
    "`--manifest <path or https URL>` naming a reviewed copy is how to get past it on a machine " +
    "that cannot reach the published one."
  );
}

/** The two facts about this machine that selection and the C-library check are computed from. */
export type HostProbe = {
  /** `process.platform`. */
  platform: string;
  /** `process.arch`. */
  arch: string;
  /** The runtime glibc as `[major, minor]`, or `null` where Node does not report one. */
  glibc: [number, number] | null;
};

/** {@link HostProbe} for the process that is running now. */
export function probeHost(): HostProbe {
  return {
    platform: process.platform,
    arch: process.arch,
    glibc: runtimeGlibc(),
  };
}

/**
 * The runtime glibc, as Node reports it.
 *
 * `process.report.getReport().header.glibcVersionRuntime` is present only on a glibc Linux, which
 * is exactly what makes its absence meaningful: a musl host reports nothing here, and an unreadable
 * version is treated as "not compatible", to be safe. A version that is not two dot-separated
 * numbers is `null` for the same reason.
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

/** A selected browser row, and the manifest key it was selected by. */
export type BrowserSelection = RecordedBrowserArtefact & { key: string };

/** A selected ffmpeg row, and the manifest key it was selected by. */
export type FfmpegSelection = RecordedFfmpegArtefact & { key: string };

/**
 * The reviewed browser for this machine, or a refusal saying why there is none.
 *
 * It takes the **probe** rather than a key so that the C-library check cannot be skipped by a
 * caller who only wanted a URL: selection and constraint are one answer, and ADR 0020's "Alpine is
 * blocked on rendering, not on init" is what skipping it buys.
 */
export function selectBrowserArtefact(
  manifest: ToolchainManifest,
  probe: HostProbe,
): BrowserSelection {
  return selectRow("browser", BROWSER_PLATFORMS, manifest.browser.expected, probe);
}

/** The reviewed ffmpeg for this machine, or a refusal saying why there is none. */
export function selectFfmpegArtefact(
  manifest: ToolchainManifest,
  probe: HostProbe,
): FfmpegSelection {
  return selectRow("ffmpeg", FFMPEG_PLATFORMS, manifest.ffmpeg.expected, probe);
}

function selectRow<Row extends { status: "recorded" } & LibcConstraint>(
  component: string,
  supported: readonly string[],
  expected: Record<string, Row | (UnavailableArtefact & LibcConstraint)>,
  probe: HostProbe,
): Row & { key: string } {
  const key = speechPlatformKey(probe);
  const entry = expected[key];
  if (entry === undefined) {
    if (!supported.includes(key)) {
      throw new ToolchainSelectionRefusal(
        "unsupported-platform",
        `There is no ${component} for ${key}; one is published for ${supported.join(", ")}.`,
      );
    }
    throw new ToolchainSelectionRefusal(
      "no-recorded-entry",
      `The toolchain manifest records no expected digest for a ${component} on ${key}. setup ` +
        "will not trust an artefact it has no reviewed digest for; the manifest has to record " +
        "this platform first.",
    );
  }
  if (entry.status === "unavailable") {
    throw new ToolchainSelectionRefusal(
      "artefact-unavailable",
      `The toolchain manifest records the ${component} for ${key} as unavailable: ${entry.reason}`,
      entry.url,
    );
  }
  assertLibcSatisfied(`The ${component} for ${key}`, entry, probe);
  return { ...entry, key };
}

/**
 * Refuse an artefact whose C library this machine does not have.
 *
 * ADR 0020 records that "Alpine is blocked on rendering, not on init", and this is the check that
 * makes the block legible at acquisition instead: a musl host reports no runtime glibc at all, and
 * a glibc older than the artefact's floor produces a binary that unpacks and cannot start. Both
 * are stated before a hundred megabytes are fetched.
 */
export function assertLibcSatisfied(
  subject: string,
  entry: LibcConstraint,
  probe: HostProbe,
): void {
  if (entry.libc === undefined && entry.min_glibc === undefined) {
    return;
  }
  if (probe.platform !== "linux") {
    return;
  }
  if (entry.libc === "glibc" && probe.glibc === null) {
    throw new ToolchainSelectionRefusal(
      "libc-unsatisfied",
      `${subject} is a glibc build and this machine reports no runtime glibc, which is what a musl ` +
        "system (Alpine) looks like. The artefact would unpack and fail to start; use a glibc " +
        "base image.",
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
      `${subject} needs glibc ${entry.min_glibc} or newer and this machine reports ${found}.`,
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

/**
 * `<platform>-<arch>` in Node's own spelling, which is how all three blocks are keyed.
 *
 * The name is the speech map's, which was keyed this way first; `browser` and `ffmpeg` adopted the
 * same key in format 2.
 */
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
      formatVersion < TOOLCHAIN_MANIFEST_FORMAT_VERSION
        ? `${source} says format_version ${formatVersion}; this build reads ` +
            `${TOOLCHAIN_MANIFEST_FORMAT_VERSION}, at ${TOOLCHAIN_MANIFEST_PATH}. An older ` +
            "document is the one released CLIs read, and it does not describe ffmpeg."
        : `${source} says format_version ${formatVersion}; this build reads ` +
            `${TOOLCHAIN_MANIFEST_FORMAT_VERSION}. A newer manifest is a rollback signal and never ` +
            "corruption: nothing here is guessed at.",
    );
  }
  const browser = asBlock(
    document.browser,
    source,
    "browser",
    BROWSER_PLATFORMS,
    asBrowserArtefact,
  );
  const ffmpeg = asBlock(document.ffmpeg, source, "ffmpeg", FFMPEG_PLATFORMS, asFfmpegArtefact);
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
    browser,
    ffmpeg,
    speech: speechEntries,
  };
}

/** A `browser` or `ffmpeg` block: `{ expected: { <platform>-<arch>: row } }`, all keys required. */
function asBlock<Row>(
  value: unknown,
  source: string,
  name: string,
  required: readonly string[],
  asRow: (value: unknown, source: string, field: string) => Row,
): { expected: Record<string, Row> } {
  const block = asRecord(value, source, name);
  const expected = asRecord(block.expected, source, `${name}.expected`);
  const entries: Record<string, Row> = {};
  for (const [key, row] of Object.entries(expected)) {
    entries[key] = asRow(row, source, `${name}.expected.${key}`);
  }
  for (const platform of required) {
    if (entries[platform] === undefined) {
      throw new ToolchainManifestError(
        `${source} has no ${name} entry for ${platform}. Every platform ${name} is selected on ` +
          'needs an answer, and "unavailable, because …" is one — a missing key is not.',
      );
    }
  }
  return { expected: entries };
}

function asBrowserArtefact(value: unknown, source: string, field: string): BrowserArtefact {
  const entry = asRecord(value, source, field);
  const libc = asLibc(entry.libc, source, `${field}.libc`);
  const minGlibc = asMinGlibc(entry.min_glibc, source, `${field}.min_glibc`);
  if (entry.status === "unavailable") {
    return asUnavailable(entry, source, field, { ...libc, ...minGlibc });
  }
  const { url, publisher } = asAllowedUrl(entry.url, source, `${field}.url`);
  return {
    status: asRecorded(entry.status, source, field),
    version: asNonEmptyString(entry.version, source, `${field}.version`),
    url,
    sha256: asSha256(entry.sha256, source, `${field}.sha256`),
    size: asSize(entry.size, source, `${field}.size`),
    member: asMember(entry.member, source, `${field}.member`),
    licence_member: asMember(entry.licence_member, source, `${field}.licence_member`),
    publisher,
    ...libc,
    ...minGlibc,
  };
}

function asFfmpegArtefact(value: unknown, source: string, field: string): FfmpegArtefact {
  const entry = asRecord(value, source, field);
  const libc = asLibc(entry.libc, source, `${field}.libc`);
  const minGlibc = asMinGlibc(entry.min_glibc, source, `${field}.min_glibc`);
  if (entry.status === "unavailable") {
    return asUnavailable(entry, source, field, { ...libc, ...minGlibc });
  }
  const { url, publisher } = asAllowedUrl(entry.url, source, `${field}.url`);
  return {
    status: asRecorded(entry.status, source, field),
    version: asNonEmptyString(entry.version, source, `${field}.version`),
    url,
    sha256: asSha256(entry.sha256, source, `${field}.sha256`),
    size: asSize(entry.size, source, `${field}.size`),
    member: asMember(entry.member, source, `${field}.member`),
    member_sha256: asSha256(entry.member_sha256, source, `${field}.member_sha256`),
    member_size: asSize(entry.member_size, source, `${field}.member_size`),
    licence: asLicence(entry.licence, source, `${field}.licence`),
    licence_member: asMember(entry.licence_member, source, `${field}.licence_member`),
    ...(entry.extra_members === undefined
      ? {}
      : { extra_members: asMembers(entry.extra_members, source, `${field}.extra_members`) }),
    ...(entry.source_url === undefined
      ? {}
      : { source_url: asArtefactUrl(entry.source_url, source, `${field}.source_url`) }),
    publisher,
    ...libc,
    ...minGlibc,
  };
}

function asUnavailable(
  entry: Record<string, unknown>,
  source: string,
  field: string,
  constraint: LibcConstraint,
): UnavailableArtefact & LibcConstraint {
  return {
    status: "unavailable",
    ...(entry.url === undefined
      ? {}
      : { url: asAllowedUrl(entry.url, source, `${field}.url`).url }),
    reason: asNonEmptyString(entry.reason, source, `${field}.reason`),
    ...constraint,
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
 * Narrower than {@link ARTEFACT_ALLOWLIST} on purpose, and older: a speech bundle has no
 * third-party publisher at all, so the one host that is ours is the whole list.
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

/**
 * An artefact URL under a prefix {@link ARTEFACT_ALLOWLIST} names, and the publisher it maps to.
 *
 * The URL must already be in its normal form, so the string a reviewer read is the one fetched: a
 * `..` segment, a backslash or an upper-case host would each be normalised by the HTTP client into
 * a URL nobody reviewed, and a prefix check on the raw string would have passed it.
 */
function asAllowedUrl(
  value: unknown,
  source: string,
  field: string,
): { url: string; publisher: string } {
  const url = asArtefactUrl(value, source, field);
  const normal = new URL(url).href;
  if (normal !== url) {
    throw new ToolchainManifestError(
      `${source}: ${field} is ${url}, which is not in its normal form (${normal}). The URL a ` +
        "manifest names has to be the URL that is fetched.",
    );
  }
  const allowed = Object.entries(ARTEFACT_ALLOWLIST).find(([prefix]) => url.startsWith(prefix));
  if (allowed === undefined) {
    throw new ToolchainManifestError(
      `${source}: ${field} is ${url}, and no publisher this build trusts serves it. The allowlist ` +
        `in setup/manifest.ts admits ${Object.keys(ARTEFACT_ALLOWLIST).join(", ")}; a new ` +
        "publisher is a reviewed code change, never a manifest edit.",
    );
  }
  return { url, publisher: allowed[1] };
}

/** An archive member's name, refused here if unpacking it could leave the destination. */
function asMember(value: unknown, source: string, field: string): string {
  const member = asNonEmptyString(value, source, field);
  try {
    safeJoin(".", member);
  } catch (error) {
    if (error instanceof ArchiveRefusal) {
      throw new ToolchainManifestError(`${source}: ${field} is refused: ${error.message}`);
    }
    throw error;
  }
  return member;
}

function asMembers(value: unknown, source: string, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new ToolchainManifestError(`${source}: ${field} is not an array.`);
  }
  return value.map((member, index) => asMember(member, source, `${field}[${index}]`));
}

function asLicence(value: unknown, source: string, field: string): string {
  const licence = asNonEmptyString(value, source, field);
  if (!ACCEPTED_FFMPEG_LICENCES.includes(licence)) {
    throw new ToolchainManifestError(
      `${source}: ${field} is ${JSON.stringify(licence)}, which is not one of the SPDX ids this ` +
        `build accepts for FFmpeg: ${ACCEPTED_FFMPEG_LICENCES.join(", ")}.`,
    );
  }
  return licence;
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
