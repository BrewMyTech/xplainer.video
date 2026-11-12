/**
 * The FFmpeg provider: the pinned build this platform's manifest row names, or one a user names.
 *
 * Every render pipes its frames into an `ffmpeg` process, and [ADR 0031](../../../../../docs/adr/0031-an-owned-renderer-replaces-remotion-ffmpeg-encodes.md)'s
 * note of 2026-11-12 decides where that process comes from (D6): `setup` downloads the pin, or
 * records a binary named with `--ffmpeg-path`, and nothing ever finds one on `PATH` by itself. This
 * module is both routes. The render half — `XPLAINER_FFMPEG`, then the recorded `ffmpeg.path` — is
 * `render/encode.ts`'s.
 *
 * **Who built it, under what licence, and where its source is, is said before the first request.**
 * FFmpeg arrives as somebody else's GPL program, run beside this one and never linked into it, so
 * the line a user reads before the download is the one a Debian installer prints before it fetches
 * a non-free firmware blob: the publisher (from the code allowlist in `manifest.ts`, never from the
 * document), the licence, that it is a separate program, and the corresponding source — the row's
 * `source_url`, or the publisher's own release page where the row names none.
 *
 * **Two digests, and both are expected.** The archive is verified against the row's `sha256` before
 * a byte of it is unpacked, as every artefact is (`download.ts`). The executable inside it is then
 * verified against the row's `member_sha256` and `member_size` in the `stage` hook, before the
 * commit — so an archive that is intact and right and holds the wrong binary is still a refusal that
 * commits nothing. `stopAfter` ends an xz decode at the last kept member; it is an economy, and the
 * hook's own check is what says the member arrived.
 *
 * **Then the binary is asked what it is**, with no shell and a ten-second budget per question:
 * `-version` (whose libavcodec line is what the gate's floor is judged on), `-buildconf`, `-L` and
 * `-encoders`. Its own `configure` has to agree with the row's licence twice over — `-buildconf`'s
 * `--enable-gpl` and `--enable-version3`, and `-L`'s statement — and it has to carry `libx264` and a
 * non-experimental `aac`, which is every encoder `encodeArgs()` names. The first three answers are
 * recorded verbatim in the marker's `probe`, so a support report can read them without running the
 * binary again. A refusal at any of these steps throws inside the hook, so the staging tree is
 * removed and nothing is committed.
 *
 * **What lands is four or five files, side by side**: the executable, the licence text, our own
 * build's `SOURCE.txt` and `BUILDINFO.txt` where the row keeps them, and a `PROVENANCE.txt` this
 * provider writes — the URL, both digests, the publisher, the licence, the version, the source and
 * the date — so the licence obligation travels with the binary rather than with a manifest the
 * machine may never read again. The archive's own directory layout is not kept: a 400 MB BtbN build
 * contributes one binary and one licence, and they are all a render or a reader needs.
 *
 * **On macOS nothing has to be un-quarantined.** `com.apple.quarantine` is set by the application
 * that downloads a file when it opts in (a browser, `curl` never); `download.ts` speaks `node:http`
 * and sets no extended attribute, exactly as for the Chrome for Testing shell the browser provider
 * commits and launches unaltered. Our arm64 build carries the linker's ad-hoc signature, which is
 * what Apple silicon requires of any executable, and there is no Developer ID (the note's
 * §Signing).
 *
 * **A warm cache is re-verified, never trusted** (`acquired.ts`): the destination's name carries
 * the archive's digest, its record says what it was admitted on, every kept file is re-hashed, and
 * the executable is asked the same questions again so the marker's `probe` is always this run's.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import type { ToolchainFfmpeg, ToolchainFfmpegProbe, ToolchainFile } from "@xplainer/protocol";
import { PRECONDITION_UNMET_EXIT_CODE } from "../../daemon/exit-codes.js";
import { isExecutableFile } from "../../render/encode.js";
import { hashFile } from "../../runtime/manifest.js";
import { type AcquiredFile, stageAcquired, verifyAcquired } from "../acquired.js";
import { extractZip } from "../archive.js";
import { type ArchiveFormat, acquireArtefact, assertZipArtefact } from "../download.js";
import {
  ACCEPTED_FFMPEG_LICENCES,
  type FfmpegSelection,
  type HostProbe,
  probeHost,
  selectFfmpegArtefact,
  type ToolchainManifest,
} from "../manifest.js";
import { assertTarballArtefact, extractTar } from "../tar.js";
import { FFMPEG_MIN_LIBAVCODEC } from "../toolchain.js";

/** The `provider` token for the pinned build the manifest's row for this platform names. */
export const FFMPEG_MANIFEST_PROVIDER = "manifest";

/** The `provider` token for an executable named with `setup --ffmpeg-path`. */
export const FFMPEG_PATH_PROVIDER = "path";

/** The directory name, under the toolchain directory, one acquisition commits itself to. */
export const FFMPEG_DIR_NAME = "ffmpeg";

/** How many hex characters of the archive digest go in that name — enough to be an identity. */
export const FFMPEG_DIGEST_IN_NAME = 12;

/** The record this provider writes beside the binary. */
export const PROVENANCE_FILE = "PROVENANCE.txt";

/** How long one probe question may take before the binary is refused as unusable. */
export const FFMPEG_PROBE_TIMEOUT_MS = 10_000;

/** How much of a probe's output a refusal quotes. */
const PROBE_TAIL_CHARS = 600;

/** Why an FFmpeg was not recorded. One value per distinguishable condition. */
export type FfmpegRefusalReason =
  | "member-missing"
  | "member-mismatch"
  | "cache-unverified"
  | "not-executable"
  | "probe-failed"
  | "too-old"
  | "missing-encoder"
  | "licence-disagrees";

/** The FFmpeg was not recorded, and nothing was committed. */
export class FfmpegRefusal extends Error {
  readonly reason: FfmpegRefusalReason;
  readonly exitCode: number = PRECONDITION_UNMET_EXIT_CODE;

  constructor(reason: FfmpegRefusalReason, message: string) {
    super(message);
    this.name = "FfmpegRefusal";
    this.reason = reason;
  }
}

/** What one executable said about itself. */
export type ProbedFfmpeg = {
  /** The token after `ffmpeg version ` on the first line of `-version`. */
  version: string;
  /** The libavcodec it reported having loaded, `major.minor.micro`. */
  libavcodec: string;
  /** `-version`, `-buildconf` and `-L`, one entry per line, as the marker records them. */
  probe: ToolchainFfmpegProbe;
  /** `-encoders`, as `{ flags, name }` rows, for the capability check. Not recorded. */
  encoders: readonly { flags: string; name: string }[];
};

/** What {@link acquireFfmpeg} was asked to do. */
export type AcquireFfmpegOptions = {
  /** The reviewed document the row and its digests come from. */
  manifest: ToolchainManifest;
  /** Where acquisitions live on this machine — `<state>/toolchain`, as `setup` resolves it. */
  toolchainDir: string;
  /** This machine, as `manifest.ts` describes one. Defaults to a real probe. */
  probe?: HostProbe | undefined;
  /** Where the provider's progress lines go — the sentence first. Defaults to nowhere. */
  log?: (line: string) => void;
  /** The clock `PROVENANCE.txt` and the acquisition record are dated by. */
  now?: () => Date;
  /** Each probe question's budget. Defaults to {@link FFMPEG_PROBE_TIMEOUT_MS}. */
  probeTimeoutMs?: number;
};

/** What one acquisition produced, in the shape `toolchain.json` records. */
export type AcquiredFfmpeg = {
  component: ToolchainFfmpeg;
  /** The committed directory the executable, its licence and its provenance live in. */
  destination: string;
  /** Whether this call fetched anything, or found the tree already there and verified it. */
  fetched: boolean;
};

/**
 * Where the corresponding source of the selected build is published.
 *
 * The row's own `source_url` where it names one — our macOS build does, because the bucket serves no
 * directory index. A GitHub release otherwise, whose tag page is where that publisher states what
 * it built from; and the artefact's origin as the last resort, so the sentence never says nothing.
 */
export function ffmpegSourceOf(selection: FfmpegSelection): string {
  if (selection.source_url !== undefined) {
    return selection.source_url;
  }
  const release = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\//.exec(
    selection.url,
  );
  if (release !== null) {
    return `https://github.com/${release[1]}/${release[2]}/releases/tag/${release[3]}`;
  }
  return new URL(selection.url).origin;
}

/**
 * The sentence `setup` prints before it asks the publisher for a single byte.
 *
 * Everything in it is the row's or the code's: the publisher is the allowlist's answer for the URL,
 * the licence is one of the four `manifest.ts` accepts and the binary is later held to.
 */
export function ffmpegSentence(selection: FfmpegSelection): string {
  return (
    `ffmpeg: FFmpeg ${selection.version} for ${selection.key} is built and published by ` +
    `${selection.publisher} under ${selection.licence}. It runs as a separate program — xplainer ` +
    "starts it with arguments and never links it — and its source is at " +
    `${ffmpegSourceOf(selection)}.`
  );
}

/**
 * The directory one build commits itself under: its version **and** its archive's digest.
 *
 * The version is what a person reads; the digest is what makes the name an identity, so a
 * re-published archive at an unchanged version cannot be served out of the tree the last one left.
 */
export function ffmpegDestination(toolchainDir: string, selection: FfmpegSelection): string {
  return join(
    toolchainDir,
    `${FFMPEG_DIR_NAME}-${selection.version}-${selection.sha256.slice(0, FFMPEG_DIGEST_IN_NAME)}`,
  );
}

/** The last `/`-separated segment of an archive member's name. */
function memberBasename(member: string): string {
  return member.slice(member.lastIndexOf("/") + 1);
}

/**
 * The members this provider keeps, each mapped to the name it lands at: its own basename, so the
 * executable, its licence and the build's notes sit side by side. Executable first, which is the
 * order the marker's `files` records them in.
 */
function keptMembers(selection: FfmpegSelection): ReadonlyMap<string, string> {
  const members = [selection.member, selection.licence_member, ...(selection.extra_members ?? [])];
  return new Map(members.map((member) => [member, memberBasename(member)]));
}

/**
 * How this row's archive is refused and unpacked, keeping only {@link keptMembers}.
 *
 * Chosen by the URL's extension, because the two publishers disagree: BtbN's Linux builds are
 * `.tar.xz` only, and its Windows builds and our macOS one are zips. The xz decode stops once every
 * kept member has been seen.
 */
function ffmpegArchive(
  selection: FfmpegSelection,
  kept: ReadonlyMap<string, string>,
): ArchiveFormat {
  if (new URL(selection.url).pathname.toLowerCase().endsWith(".tar.xz")) {
    return {
      assert: (url) => {
        assertTarballArtefact(url, "xz");
      },
      extract: (archive, staging) =>
        extractTar(archive, staging, (header) => kept.get(header.name) ?? null, {
          decompressor: "xz",
          stopAfter: [...kept.keys()],
        }),
    };
  }
  return {
    assert: assertZipArtefact,
    extract: (archive, staging) => extractZip(archive, staging, (name) => kept.get(name) ?? null),
  };
}

/**
 * Acquire the pinned FFmpeg for this platform, or refuse by name having committed nothing.
 *
 * Idempotent, like the browser provider: a re-run over a committed tree re-verifies it, asks the
 * binary again, and records it, rather than fetching it twice.
 */
export async function acquireFfmpeg(options: AcquireFfmpegOptions): Promise<AcquiredFfmpeg> {
  const log = options.log ?? ((): void => {});
  const now = options.now ?? ((): Date => new Date());
  const timeoutMs = options.probeTimeoutMs ?? FFMPEG_PROBE_TIMEOUT_MS;
  const selection = selectFfmpegArtefact(options.manifest, options.probe ?? probeHost());
  // Before anything else can reach the network: who built it, its licence, that it is a separate
  // program, and where its source is.
  log(ffmpegSentence(selection));

  const destination = ffmpegDestination(options.toolchainDir, selection);
  const kept = keptMembers(selection);
  const executableName = memberBasename(selection.member);
  const expectation = { url: selection.url, sha256: selection.sha256, size: selection.size };

  if (existsSync(destination)) {
    const verdict = verifyAcquired(destination, expectation);
    if (!verdict.ok) {
      throw new FfmpegRefusal("cache-unverified", `ffmpeg: ${verdict.detail}`);
    }
    const executable = join(destination, executableName);
    const witnessed = verdict.files.find((file) => file.path === executable);
    if (
      witnessed === undefined ||
      witnessed.sha256 !== selection.member_sha256 ||
      witnessed.bytes !== selection.member_size
    ) {
      throw new FfmpegRefusal(
        "cache-unverified",
        `ffmpeg: ${destination} was committed without ${executableName} at the row's ` +
          `member_sha256 ${selection.member_sha256} (${String(selection.member_size)} bytes), so ` +
          `it is not the build this manifest pins. Remove ${destination} and run setup again.`,
      );
    }
    const probed = admitPinned(executable, selection, timeoutMs);
    log(`ffmpeg: already acquired and verified at ${destination}`);
    return {
      component: manifestComponent(selection, executable, verdict.files, probed),
      destination,
      fetched: false,
    };
  }

  log(`ffmpeg: ${selection.url}`);
  log(
    `ffmpeg: expecting sha256 ${selection.sha256} (${selection.key}), and ${selection.member} ` +
      `inside it at ${selection.member_sha256}`,
  );
  // A holder rather than a `let`: the hook assigns it inside a closure, which control-flow
  // narrowing cannot see, so a `let … | null` would read as `null` for ever after the call.
  const admitted: { files: readonly ToolchainFile[]; probed: ProbedFfmpeg | null } = {
    files: [],
    probed: null,
  };
  await acquireArtefact({
    request: expectation,
    destination,
    archive: ffmpegArchive(selection, kept),
    stage: (staging) => {
      const executable = join(staging, executableName);
      assertMember(selection, staging, kept);
      if (process.platform !== "win32") {
        // A zip or a tar records a mode, and a publisher can record the wrong one; the file is
        // the one whose digest was just checked, so making it executable changes nothing about it.
        chmodSync(executable, 0o755);
      }
      admitted.probed = admitPinned(executable, selection, timeoutMs);
      writeFileSync(join(staging, PROVENANCE_FILE), provenance(selection, now()));
      const record = stageAcquired(staging, expectation, [...kept.values(), PROVENANCE_FILE], now);
      admitted.files = inDestination(destination, record.files);
    },
  });
  const probed = admitted.probed;
  if (probed === null) {
    throw new Error(`ffmpeg: ${destination} was committed without being probed.`);
  }
  return {
    component: manifestComponent(
      selection,
      join(destination, executableName),
      admitted.files,
      probed,
    ),
    destination,
    fetched: true,
  };
}

/** The record's tree-relative witnesses, as absolute paths under the committed directory. */
function inDestination(destination: string, files: readonly AcquiredFile[]): ToolchainFile[] {
  return files.map((file) => ({
    path: join(destination, ...file.path.split("/")),
    sha256: file.sha256,
    bytes: file.bytes,
  }));
}

/**
 * Refuse a staging tree that lacks a kept member, or whose executable is not the reviewed one.
 *
 * Length first, so a wrong binary is refused without hashing a hundred megabytes of it.
 */
function assertMember(
  selection: FfmpegSelection,
  staging: string,
  kept: ReadonlyMap<string, string>,
): void {
  for (const [member, name] of kept) {
    if (!existsSync(join(staging, name))) {
      throw new FfmpegRefusal(
        "member-missing",
        `ffmpeg: ${selection.url} matched its reviewed digest and does not contain ${member}, ` +
          "which its manifest row names. Nothing was committed.",
      );
    }
  }
  const executable = join(staging, memberBasename(selection.member));
  const bytes = statSync(executable).size;
  const digest = bytes === selection.member_size ? hashFile(executable) : null;
  if (digest !== selection.member_sha256) {
    throw new FfmpegRefusal(
      "member-mismatch",
      `ffmpeg: ${selection.member} in ${selection.url} is ${String(bytes)} bytes hashing to ` +
        `${digest ?? "(not hashed: the length already disagrees)"}, and the manifest row expects ` +
        `${String(selection.member_size)} bytes at ${selection.member_sha256}. The archive is ` +
        "the one that was reviewed and the binary inside it is not. Nothing was committed.",
    );
  }
}

/** Probe a pinned build and hold it to what its row says, refusing by name. */
function admitPinned(
  executable: string,
  selection: FfmpegSelection,
  timeoutMs: number,
): ProbedFfmpeg {
  const probed = probeFfmpeg(executable, timeoutMs);
  assertRenders(executable, probed);
  const disagreement = licenceDisagreement(selection.licence, probed.probe);
  if (disagreement !== null) {
    throw new FfmpegRefusal(
      "licence-disagrees",
      `ffmpeg: the manifest row for ${selection.key} declares ${selection.licence} and ` +
        `${executable} ${disagreement}. setup records the licence a build actually carries, and ` +
        "will not record one its own configure contradicts. Nothing was committed.",
    );
  }
  return probed;
}

/** The marker entry for the pinned build: the archive's reviewed digest, the executable first. */
function manifestComponent(
  selection: FfmpegSelection,
  executable: string,
  files: readonly ToolchainFile[],
  probed: ProbedFfmpeg,
): ToolchainFfmpeg {
  const binary = files.find((file) => file.path === executable);
  const rest = files.filter((file) => file.path !== executable);
  return {
    version: probed.version,
    path: executable,
    sha256: selection.sha256,
    provider: FFMPEG_MANIFEST_PROVIDER,
    files: [
      binary ?? { path: executable, sha256: selection.member_sha256, bytes: selection.member_size },
      ...rest,
    ],
    libavcodec: probed.libavcodec,
    licence: selection.licence,
    publisher: selection.publisher,
    ...(selection.source_url === undefined ? {} : { source_url: selection.source_url }),
    probe: probed.probe,
  };
}

/** `PROVENANCE.txt`: what a reader of this directory needs, with no manifest to hand. */
function provenance(selection: FfmpegSelection, at: Date): string {
  return [
    `FFmpeg ${selection.version} for ${selection.key}, acquired by \`xplainer setup\``,
    "",
    "xplainer runs this ffmpeg as a separate program, with arguments, and is not linked with it.",
    `The licence text is ${memberBasename(selection.licence_member)}, beside this file.`,
    "",
    `publisher:  ${selection.publisher}`,
    `licence:    ${selection.licence}`,
    `version:    ${selection.version}`,
    `url:        ${selection.url}`,
    `sha256:     ${selection.sha256} (the archive, verified before it was unpacked)`,
    `executable: ${memberBasename(selection.member)}, ${String(selection.member_size)} bytes, ` +
      `sha256 ${selection.member_sha256}`,
    `source:     ${ffmpegSourceOf(selection)}`,
    `acquired:   ${at.toISOString()}`,
    "",
  ].join("\n");
}

// ── `setup --ffmpeg-path` ──────────────────────────────────────────────────────────────────────

/** What {@link recordFfmpegPath} was asked to record. */
export type RecordFfmpegPathOptions = {
  /** The file the user named, absolute or relative to this process's working directory. */
  path: string;
  log?: (line: string) => void;
  /** Each probe question's budget. Defaults to {@link FFMPEG_PROBE_TIMEOUT_MS}. */
  probeTimeoutMs?: number;
};

/**
 * Record an FFmpeg the user named, having asked it everything the pinned build is asked.
 *
 * Its digest is **recorded, not expected**: nobody reviewed it, so the digest proves nothing about
 * where it came from and only lets a later check tell a replaced binary from the one probed. Its
 * licence is the one the build itself states, which `-L` and `-buildconf` must agree on and which
 * must be one of FFmpeg's four free configurations — there is no row to compare it with. No
 * publisher is recorded, because none vouches for it.
 */
export function recordFfmpegPath(options: RecordFfmpegPathOptions): ToolchainFfmpeg {
  const log = options.log ?? ((): void => {});
  const executable = resolve(options.path);
  if (!isExecutableFile(executable)) {
    throw new FfmpegRefusal(
      "not-executable",
      `ffmpeg: --ffmpeg-path names ${executable}, which is not an executable file. Name the ffmpeg ` +
        "binary itself. Nothing was recorded.",
    );
  }
  const probed = probeFfmpeg(executable, options.probeTimeoutMs ?? FFMPEG_PROBE_TIMEOUT_MS);
  assertRenders(executable, probed);
  const statement = licenceFromStatement(probed.probe.license);
  const configured = licenceFromBuildconf(probed.probe.buildconf);
  if (
    statement === null ||
    statement !== configured ||
    !ACCEPTED_FFMPEG_LICENCES.includes(statement)
  ) {
    throw new FfmpegRefusal(
      "licence-disagrees",
      `ffmpeg: ${executable} states ${statement ?? "no licence this build recognises"} (\`-L\`) ` +
        `and was configured as ${configured} (\`-buildconf\`). setup records an ffmpeg whose two ` +
        `answers agree on one of ${ACCEPTED_FFMPEG_LICENCES.join(", ")}. Nothing was recorded.`,
    );
  }
  const sha256 = hashFile(executable);
  const bytes = statSync(executable).size;
  log(
    `ffmpeg: ${executable} is FFmpeg ${probed.version} (libavcodec ${probed.libavcodec}, ` +
      `${statement}) and carries libx264 and aac. It is recorded as you named it rather than ` +
      `downloaded, so its digest ${sha256} is recorded, not expected.`,
  );
  return {
    version: probed.version,
    path: executable,
    sha256,
    provider: FFMPEG_PATH_PROVIDER,
    files: [{ path: executable, sha256, bytes }],
    libavcodec: probed.libavcodec,
    licence: statement,
    probe: probed.probe,
  };
}

/**
 * What a plain `setup` does with an ffmpeg an earlier `setup --ffmpeg-path` recorded: keep it, ask
 * it again, or — only when it is gone — give way to the pinned build. `null` is the last of the
 * three, and says so.
 *
 * **A user-chosen ffmpeg survives a re-run**, which is the speech route's migration rule applied to
 * ffmpeg (`providers/speech.ts`), and for a sharper reason. `xplainer update` runs a plain `setup`
 * on every upgrade, and `--ffmpeg-path` exists for the machines the pinned build cannot serve —
 * musl and Alpine above all (ADR 0031 §Note, 2026-11-12, D6) — so replacing the named binary with
 * the pin there would fail the pin's own C-library check and break `setup` and `update` both. So:
 *
 * - the recorded binary is still the one probed — its digest equals the recorded one — and it is
 *   kept, with a line naming `--ffmpeg-pinned` and `--ffmpeg-path`, the two ways to change it;
 * - it is there and is a different binary — a package manager upgraded it in place — and it is
 *   probed again at the same path and recorded anew, or refused as `--ffmpeg-path` would refuse it;
 * - it is not an executable file any more, and the pinned build is acquired in its place.
 *
 * The digest is a full read of the binary, which `/healthz`'s stat-only gate never does: this is a
 * `setup`, a command somebody ran, and the one moment it is affordable.
 */
export function keepNamedFfmpeg(
  recorded: ToolchainFfmpeg,
  log: (line: string) => void,
): ToolchainFfmpeg | null {
  const path = recorded.path;
  if (!isExecutableFile(path)) {
    log(
      `ffmpeg: ${path}, which an earlier \`xplainer setup --ffmpeg-path\` recorded, is no longer ` +
        "an executable file there, so the pinned build is acquired in its place.",
    );
    return null;
  }
  if (hashFile(path) === recorded.sha256) {
    log(
      `ffmpeg: kept ${path}, which an earlier \`xplainer setup --ffmpeg-path\` recorded — it is ` +
        "still the binary setup probed, so a re-run does not swap it for the pinned build. " +
        "`xplainer setup --ffmpeg-pinned` downloads the pinned build in its place, and " +
        "`xplainer setup --ffmpeg-path <file>` records another.",
    );
    return recorded;
  }
  log(
    `ffmpeg: ${path}, which an earlier \`xplainer setup --ffmpeg-path\` recorded, is no longer ` +
      "the binary setup probed — its digest has changed, as an upgrade in place changes it — so " +
      "it is probed again where it is.",
  );
  try {
    return recordFfmpegPath({ path, log });
  } catch (error) {
    if (error instanceof FfmpegRefusal) {
      throw new FfmpegRefusal(
        error.reason,
        `${error.message} It was recorded with --ffmpeg-path: name a working one with ` +
          "`xplainer setup --ffmpeg-path <file>`, or download the pinned build with " +
          "`xplainer setup --ffmpeg-pinned`.",
      );
    }
    throw error;
  }
}

// ── the probe ──────────────────────────────────────────────────────────────────────────────────

/**
 * Ask an executable the four questions, with no shell and a budget per question.
 *
 * `spawnSync` with an argument vector, so a path holding a space or a quote is one argument, and
 * `SIGKILL` on the budget, so an ffmpeg that waits on a terminal or a hung mount costs ten seconds
 * rather than the run. `-hide_banner` keeps the copyright banner out of every answer.
 */
export function probeFfmpeg(
  executable: string,
  timeoutMs: number = FFMPEG_PROBE_TIMEOUT_MS,
): ProbedFfmpeg {
  const versionText = ask(executable, "-version", timeoutMs);
  const buildconf = lines(ask(executable, "-buildconf", timeoutMs));
  const license = lines(ask(executable, "-L", timeoutMs));
  const encoders = parseEncoders(ask(executable, "-encoders", timeoutMs));
  const version = /^ffmpeg version (\S+)/m.exec(versionText)?.[1];
  const libavcodec = parseLibavcodec(versionText);
  if (version === undefined || libavcodec === null) {
    throw new FfmpegRefusal(
      "probe-failed",
      `ffmpeg: ${executable} answered \`-version\` without ${
        version === undefined ? "an `ffmpeg version` line" : "a libavcodec version"
      }, so it is not an ffmpeg this build can judge: ${tail(versionText)}`,
    );
  }
  return {
    version,
    libavcodec,
    probe: { version: lines(versionText), buildconf, license },
    encoders,
  };
}

/** One probe question's stdout, or a refusal saying why there is none. */
function ask(executable: string, flag: string, timeoutMs: number): string {
  const result = spawnSync(executable, ["-hide_banner", flag], {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    const timedOut = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    throw new FfmpegRefusal(
      "probe-failed",
      timedOut
        ? `ffmpeg: ${executable} did not answer \`${flag}\` within ${String(timeoutMs)} ms and ` +
            "was stopped. Nothing was recorded."
        : `ffmpeg: ${executable} could not be run (${result.error.message}). Nothing was recorded.`,
    );
  }
  if (result.status !== 0) {
    throw new FfmpegRefusal(
      "probe-failed",
      `ffmpeg: ${executable} ${flag} exited ${
        result.status === null
          ? `on signal ${String(result.signal)}`
          : `with ${String(result.status)}`
      }: ${tail(`${result.stdout}${result.stderr}`)} Nothing was recorded.`,
    );
  }
  // ffmpeg routes these answers through a log callback that writes to stdout; a build that left
  // the default callback in place writes them to stderr instead, and the answer is the same.
  return result.stdout.trim() === "" ? result.stderr : result.stdout;
}

/** Output as the marker records it: one entry per line, trailing blank lines dropped. */
function lines(text: string): string[] {
  const split = text.replace(/\r\n/g, "\n").split("\n");
  while (split.length > 0 && split[split.length - 1]?.trim() === "") {
    split.pop();
  }
  return split;
}

/** The end of a probe's output, on one line, for a refusal to quote. */
function tail(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat === "" ? "(it printed nothing)" : flat.slice(-PROBE_TAIL_CHARS);
}

/**
 * The libavcodec an executable says it loaded, `major.minor.micro`, from `-version`.
 *
 * The line reads `libavcodec     62. 11.100 / 62. 11.100` — what it was built against, then what it
 * is running with. The second is taken, because that is the library the encode will actually use.
 */
export function parseLibavcodec(versionText: string): string | null {
  const match =
    /^libavcodec\s+\d+\.\s*\d+\.\s*\d+\s*\/\s*(\d+)\.\s*(\d+)\.\s*(\d+)/m.exec(versionText) ??
    /^libavcodec\s+(\d+)\.\s*(\d+)\.\s*(\d+)/m.exec(versionText);
  return match === null ? null : `${match[1]}.${match[2]}.${match[3]}`;
}

/** `-encoders` as rows: the six capability flags and the name, after the listing's `---` rule. */
export function parseEncoders(text: string): { flags: string; name: string }[] {
  const all = text.replace(/\r\n/g, "\n").split("\n");
  const rule = all.findIndex((line) => /^\s*-+\s*$/.test(line));
  return all
    .slice(rule + 1)
    .map((line) => /^\s*([A-Z.]{6})\s+(\S+)/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ flags: match[1] ?? "", name: match[2] ?? "" }));
}

/**
 * Refuse an ffmpeg this renderer cannot encode with: libavcodec below the floor, or no `libx264`,
 * or an `aac` that is missing or experimental — every encoder `encodeArgs()` names, and the floor
 * `setup/toolchain.ts`'s gate holds a recorded one to.
 */
function assertRenders(executable: string, probed: ProbedFfmpeg): void {
  const major = Number(probed.libavcodec.split(".")[0]);
  if (major < FFMPEG_MIN_LIBAVCODEC) {
    throw new FfmpegRefusal(
      "too-old",
      `ffmpeg: ${executable} is FFmpeg ${probed.version} with libavcodec ${probed.libavcodec}, and ` +
        `this build encodes with libavcodec ${String(FFMPEG_MIN_LIBAVCODEC)} or newer, which is ` +
        "FFmpeg 6.0. Nothing was recorded.",
    );
  }
  const libx264 = probed.encoders.some(
    (row) => row.name === "libx264" && row.flags.startsWith("V"),
  );
  const aac = probed.encoders.some(
    (row) => row.name === "aac" && row.flags.startsWith("A") && row.flags[3] !== "X",
  );
  if (!libx264 || !aac) {
    const missing = [libx264 ? null : "libx264", aac ? null : "a non-experimental aac"].filter(
      (name): name is string => name !== null,
    );
    throw new FfmpegRefusal(
      "missing-encoder",
      `ffmpeg: ${executable} lists no ${missing.join(" and no ")} encoder in \`-encoders\`, and ` +
        "every render encodes H.264 with libx264 and its narration with aac. An ffmpeg configured " +
        "with --enable-gpl --enable-libx264 carries both. Nothing was recorded.",
    );
  }
}

// ── the licence a build carries ─────────────────────────────────────────────────────────────────

/**
 * The licence `configure` gave a build, from `-buildconf`'s flags — FFmpeg's own rule.
 *
 * `--enable-nonfree` makes it unredistributable whatever else is set; `--enable-gpl` makes it GPL;
 * `--enable-version3` moves either family to version 3. Neither flag is LGPL 2.1, the default.
 * Matched as whole flags, because `--enable-demuxer='…'` and its kin contain the word `--enable-`.
 */
export function licenceFromBuildconf(buildconf: readonly string[]): string {
  const flags = new Set(buildconf.flatMap((line) => line.trim().split(/\s+/)));
  if (flags.has("--enable-nonfree")) {
    return "nonfree";
  }
  const version3 = flags.has("--enable-version3");
  if (flags.has("--enable-gpl")) {
    return version3 ? "GPL-3.0-or-later" : "GPL-2.0-or-later";
  }
  return version3 ? "LGPL-3.0-or-later" : "LGPL-2.1-or-later";
}

/**
 * The licence a build states for itself in `-L`, as an SPDX id — or `nonfree`, or `null` for a
 * statement that is none of FFmpeg's five.
 *
 * `-L` prints exactly one of five texts, chosen by the same `configure` flags: "nonfree parts
 * compiled in", or the GNU General or Lesser General Public License at "either version 2", "2.1"
 * or "3 of the License, or (at your option) any later version".
 */
export function licenceFromStatement(license: readonly string[]): string | null {
  const text = license.join(" ").replace(/\s+/g, " ");
  if (/nonfree parts compiled in/.test(text)) {
    return "nonfree";
  }
  const version =
    /either version (2\.1|2|3) of the License, or \(at your option\) any later version/.exec(
      text,
    )?.[1];
  if (version === undefined) {
    return null;
  }
  if (/GNU Lesser General Public License/.test(text)) {
    return version === "3" ? "LGPL-3.0-or-later" : version === "2.1" ? "LGPL-2.1-or-later" : null;
  }
  if (/GNU General Public License/.test(text)) {
    return version === "3" ? "GPL-3.0-or-later" : version === "2" ? "GPL-2.0-or-later" : null;
  }
  return null;
}

/**
 * How a build's own answers contradict the licence a row declares, or `null` when both agree.
 *
 * Both answers are held to it, because they can disagree with each other: `-buildconf` is the
 * configure line and `-L` is what the binary prints, and a build whose two answers differ is one
 * whose licence nobody can state from the outside.
 */
export function licenceDisagreement(
  licence: string,
  probe: Pick<ToolchainFfmpegProbe, "buildconf" | "license">,
): string | null {
  const configured = licenceFromBuildconf(probe.buildconf);
  const statement = licenceFromStatement(probe.license);
  const contradictions = [
    configured === licence ? null : `was configured as ${configured} (\`-buildconf\`)`,
    statement === licence
      ? null
      : `states ${statement ?? "no licence this build recognises"} (\`-L\`)`,
  ].filter((part): part is string => part !== null);
  return contradictions.length === 0 ? null : contradictions.join(" and ");
}
