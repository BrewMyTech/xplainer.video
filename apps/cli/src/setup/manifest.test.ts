/**
 * The manifest's address, its shape, and the one question it exists to answer.
 *
 * Two things are checked against something outside this module rather than against a copy of it:
 * the **hostname** comes out of `infra/terraform`, and the **committed manifest** is read as a
 * document rather than as a fixture — its recorded digests against the ones ADR 0031's note of
 * 2026-11-12 published, and every row against the allowlist the parser applies. A test that
 * asserted a URL against a constant declared beside it would agree with itself for ever.
 *
 * Note, 2026-11-11: the **selector** used to be a third such check, compared with the previous
 * renderer's own URL function over its whole 80-row branch matrix, until this package stopped
 * installing it. Note, 2026-11-12: format 2 deleted the selector itself. A row is chosen by
 * `<platform>-<arch>`, so the cases that pinned the mirror's branches went with it, and what stands
 * in their place is the allowlist — the one thing that now decides where a download may come from.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACCEPTED_FFMPEG_LICENCES,
  ARTEFACT_ALLOWLIST,
  assertLibcSatisfied,
  BROWSER_PLATFORMS,
  deliveryPosition,
  FFMPEG_PLATFORMS,
  type HostProbe,
  parseToolchainManifest,
  probeHost,
  REQUIRED_SPEECH_PLATFORMS,
  selectBrowserArtefact,
  selectFfmpegArtefact,
  selectSpeechBundle,
  speechPlatformKey,
  TOOLCHAIN_CDN_HOSTNAME,
  TOOLCHAIN_MANIFEST_FORMAT_VERSION,
  TOOLCHAIN_MANIFEST_PATH,
  TOOLCHAIN_MANIFEST_URL,
  type ToolchainManifest,
  ToolchainManifestError,
  ToolchainSelectionRefusal,
  toolchainManifestUrl,
} from "./manifest.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY = join(HERE, "..", "..", "..", "..");
const COMMITTED_MANIFEST = join(HERE, "toolchain.manifest.json");
const ADR_0031 = join(
  REPOSITORY,
  "docs/adr/0031-an-owned-renderer-replaces-remotion-ffmpeg-encodes.md",
);

function readCommittedManifest(): ToolchainManifest {
  return parseToolchainManifest(
    readFileSync(COMMITTED_MANIFEST, "utf8"),
    "apps/cli/src/setup/toolchain.manifest.json",
  );
}

function probe(overrides: Partial<HostProbe> = {}): HostProbe {
  return { platform: "linux", arch: "x64", glibc: [2, 36], ...overrides };
}

/** The probe a `<platform>-<arch>` key describes, on a glibc new enough for every Linux row. */
function probeFor(key: string): HostProbe {
  const [platform = "", arch = ""] = key.split("-");
  return probe({ platform, arch, glibc: platform === "linux" ? [2, 36] : null });
}

/** What `fn` threw, as the refusal it must be. */
function refusalOf(fn: () => unknown): ToolchainSelectionRefusal {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolchainSelectionRefusal);
    return error as ToolchainSelectionRefusal;
  }
  return expect.unreachable("the selection must refuse");
}

describe("where the toolchain manifest is fetched from", () => {
  it("is the hostname infra/terraform provisions, read out of the Terraform sources", () => {
    const variables = readFileSync(join(REPOSITORY, "infra/terraform/variables.tf"), "utf8");
    const main = readFileSync(join(REPOSITORY, "infra/terraform/main.tf"), "utf8");
    const zone = /variable "zone_name"[\s\S]*?default\s*=\s*"([^"]+)"/.exec(variables)?.[1];

    expect(zone).toBe("xplainer.video");
    // A regex rather than a string: the Terraform interpolation this pins is `${…}`, which is
    // also JavaScript's own, and a plain string carrying it is what noTemplateCurlyInString flags.
    expect(main).toMatch(/cdn_hostname\s*=\s*"cdn\.\$\{var\.zone_name}"/);
    expect(TOOLCHAIN_CDN_HOSTNAME).toBe(`cdn.${zone}`);
    expect(TOOLCHAIN_MANIFEST_URL).toBe(toolchainManifestUrl(zone as string));
  });

  /**
   * Format 2 lives at a path of its own. Released CLIs read `toolchain/v1/manifest.json` and refuse
   * a newer format there, so a format-2 document at the old path would break every one of them.
   */
  it("is the version-2 path, which no released CLI reads", () => {
    expect(TOOLCHAIN_MANIFEST_URL).toBe("https://cdn.xplainer.video/toolchain/v2/manifest.json");
    expect(TOOLCHAIN_MANIFEST_PATH).toBe("toolchain/v2/manifest.json");
    expect(TOOLCHAIN_MANIFEST_FORMAT_VERSION).toBe(2);
  });

  it("is never the bucket's own r2.dev host, which Cloudflare does not cache", () => {
    expect(TOOLCHAIN_MANIFEST_URL).not.toContain("r2.dev");
    expect(TOOLCHAIN_MANIFEST_URL).not.toContain("r2.cloudflarestorage.com");
    expect(() => toolchainManifestUrl("xplainer-artifacts.4f1.r2.dev")).toThrow(
      ToolchainManifestError,
    );
    expect(() => toolchainManifestUrl("xplainer-artifacts.4f1.r2.dev")).toThrow(/r2\.dev/);
    expect(() => toolchainManifestUrl("  ")).toThrow(ToolchainManifestError);
  });
});

/**
 * The position is asserted against `infra/README.md` and against `infra/terraform` rather than
 * against a copy of the sentence declared beside it: the claim being made is about the *state of
 * the delivery*, and a test that only compared the message with itself would keep passing on the
 * day something is finally published.
 */
describe("the delivery position, when the published address answers nothing", () => {
  const README = join(REPOSITORY, "infra/README.md");

  /**
   * Rewritten 2026-09-11, and the assertions are inverted rather than adjusted.
   *
   * This case used to require the message to say "Nothing is published … in this phase" and
   * "manual steps Terraform does not manage", and required `infra/README.md` to carry the two
   * manual steps by name. All four are now false: the manifest answers `200`, and both Cloudflare
   * steps are declared in `infra/terraform`. A test that kept asserting them would have pinned the
   * product to a reassurance — "an address that answers nothing is the expected state" — on the one
   * path whose job is to explain a genuine failure.
   *
   * So what is pinned now is the opposite: that the message calls a fetch failure a failure, and
   * that it names causes a reader can act on.
   */
  it("calls an unreadable manifest a failure, and names what usually causes it", () => {
    const readme = readFileSync(README, "utf8");
    const message = deliveryPosition(probe({ platform: "darwin", arch: "arm64", glibc: null }));

    // The README must no longer describe the two Cloudflare steps as manual, because Terraform
    // declares both. This is the assertion that would have caught the message going stale.
    expect(readme).toContain("cloudflare_r2_custom_domain");
    expect(readme).toContain("cloudflare_ruleset.cdn_cache");
    expect(readme).not.toContain("Connect the bucket to the custom domain.");

    // And what the message tells a user.
    expect(message).toContain(`The toolchain manifest is published at ${TOOLCHAIN_MANIFEST_URL}`);
    expect(message).toContain("this is a failure to read it");
    expect(message).toContain("proxy");
    expect(message).toContain("DNS");
    expect(message).toContain("infra/README.md");
    // The retired reassurance, asserted absent so it cannot come back by accident.
    expect(message).not.toContain("expected state rather than an outage");
    expect(message).not.toContain("manual steps Terraform does not manage");
  });

  it("still says no command here uploads a manifest, because that has not changed", () => {
    const message = deliveryPosition(probe({ platform: "linux", arch: "x64" }));

    expect(message).toContain("no command in this repository uploads a manifest");
    // A stale-but-present manifest is a skipped human step, not a broken pipeline — the one thing
    // a reader cannot work out from the HTTP status.
    expect(message).toContain("a manual release step somebody skipped");
    // "the release owner's step, in phase 4" is gone: phase 4 owns the speech bundles, not the
    // manifest, and the manifest shipped in phase 2.
    expect(message).not.toContain("release owner's step, in phase 4");
  });

  it("names the three speech routes that read no manifest, and the one that does", () => {
    for (const host of [
      probe({ platform: "darwin", arch: "arm64", glibc: null }),
      probe({ platform: "linux", arch: "arm64" }),
    ]) {
      const message = deliveryPosition(host);

      expect(message).toContain(
        `Speech is not waiting on this address on ${speechPlatformKey(host)}`,
      );
      expect(message).toContain("Three of its four routes read no manifest at all");
      expect(message).toContain("--tts-url <url>");
      expect(message).toContain("the docker route pulls the pinned Kokoro-FastAPI image by digest");
      expect(message).toContain("the onnx route fetches the Kokoro model");
      expect(message).toContain("Only the bundle route reads this manifest");
    }
  });

  /**
   * Rewritten 2026-11-12 for format 2. The paragraph used to say the browser's URL came from a
   * mirrored selector and the manifest contributed only its digest; the manifest now names the
   * URL of both the browser and ffmpeg, and code admits only the publishers it names. So both are
   * what an unreadable manifest blocks, and the message has to say who each one comes from.
   */
  it("says the browser and ffmpeg are what the failure blocks, and who publishes each", () => {
    const message = deliveryPosition(probe({ platform: "darwin", arch: "arm64", glibc: null }));

    expect(message).toContain("the browser and ffmpeg are what this failure actually blocks");
    expect(message).toContain("Chrome for Testing");
    expect(message).toContain("BtbN FFmpeg-Builds");
    expect(message).toContain(`served from ${TOOLCHAIN_CDN_HOSTNAME}, on macOS`);
    expect(message).toContain("a publisher this build names in code");
    expect(message).toContain("--manifest <path or https URL>");
    // The retired account of where the browser's URL came from.
    expect(message).not.toMatch(/selector|line resolves|only the expected digest/);
  });

  /**
   * The asymmetry §2.5 recorded has gone, and this is the case that pins its removal.
   *
   * This message used to carry a second, harder paragraph for `win32`: that all three speech routes
   * were unavailable there and that phase 4 was the milestone which would close it. The `onnx`
   * route closes it instead and closes it now — `win32-x64` and `win32-arm64` are both in
   * `onnxruntime-node`'s published set — so Windows gets the same message every other platform
   * does, and the sentence claiming it has no speech is gone rather than merely unreached.
   */
  it("gives Windows the same message as every other platform, with no phase-4 gap", () => {
    const windows = probe({ platform: "win32", arch: "x64", glibc: null });
    const message = deliveryPosition(windows);

    expect(message).not.toContain("Windows has no working speech route");
    expect(message).not.toContain("The milestone that closes it is phase 4");
    expect(message).toContain("Speech is not waiting on this address on win32-x64");
    expect(message).toContain("the onnx route fetches the Kokoro model");
    // The one thing that genuinely is waiting on the address, on every platform alike.
    expect(message).toContain("Only the bundle route reads this manifest");
    expect(message).toContain("the browser and ffmpeg are what this failure actually blocks");
  });
});

describe("the committed manifest", () => {
  it("parses as format 2, with a row for every platform each block is selected on", () => {
    const manifest = readCommittedManifest();

    expect(manifest.format_version).toBe(TOOLCHAIN_MANIFEST_FORMAT_VERSION);
    expect(Object.keys(manifest.browser.expected).sort()).toEqual([...BROWSER_PLATFORMS].sort());
    expect(Object.keys(manifest.ffmpeg.expected).sort()).toEqual([...FFMPEG_PLATFORMS].sort());
    expect(FFMPEG_PLATFORMS).toEqual([...BROWSER_PLATFORMS, "win32-arm64"]);
  });

  /**
   * Chrome for Testing 157.0.8103.50 on all five (ADR 0031's note of 2026-11-12, D4), each row's
   * digest the one that note records — read out of the ADR, so a digest changed here without a
   * record changed there fails — and each archive's own executable and licence file named.
   */
  it("pins the browser to Chrome for Testing 157.0.8103.50 everywhere, at the digests D4 records", () => {
    const manifest = readCommittedManifest();
    const adr = readFileSync(ADR_0031, "utf8");

    for (const key of BROWSER_PLATFORMS) {
      const row = selectBrowserArtefact(manifest, probeFor(key));
      expect(row.version).toBe("157.0.8103.50");
      expect(row.publisher).toBe("Google (Chrome for Testing)");
      expect(row.url).toMatch(
        /^https:\/\/storage\.googleapis\.com\/chrome-for-testing-public\/157\.0\.8103\.50\/[a-z0-9-]+\/chrome-headless-shell-[a-z0-9-]+\.zip$/,
      );
      expect(adr).toContain(row.sha256);
      expect(adr).toContain(row.size.toLocaleString("en-GB"));
      expect(row.member).toMatch(
        /^chrome-headless-shell-[a-z0-9-]+\/chrome-headless-shell(\.exe)?$/,
      );
      expect(row.licence_member).toMatch(
        /^chrome-headless-shell-[a-z0-9-]+\/LICENSE\.headless_shell$/,
      );
    }
    // The Linux floor is the publisher's own `deb.deps` (`libc6 (>= 2.25)`), on both architectures.
    for (const key of ["linux-x64", "linux-arm64"]) {
      expect(manifest.browser.expected[key]).toMatchObject({ libc: "glibc", min_glibc: "2.25" });
    }
  });

  /**
   * The macOS rows are our own build, published by run `43133391215`; the note quotes them, so
   * the archive and binary digests are read back out of it. Every other platform is BtbN's
   * `autobuild-2026-10-31-12-59`, GPL variant — whose `configure` enables version 3, so the row
   * says so, as `-buildconf` will when the binary is probed.
   */
  it("pins ffmpeg to our macOS 9.0.2 and BtbN's n9.0.2 everywhere else", () => {
    const manifest = readCommittedManifest();
    const adr = readFileSync(ADR_0031, "utf8");

    for (const key of ["darwin-arm64", "darwin-x64"]) {
      const row = selectFfmpegArtefact(manifest, probeFor(key));
      expect(row).toMatchObject({
        version: "9.0.2",
        publisher: "xplainer.video",
        licence: "GPL-2.0-or-later",
        source_url: `https://${TOOLCHAIN_CDN_HOSTNAME}/toolchain/v1/ffmpeg/9.0.2/source/README.txt`,
      });
      expect(row.url).toBe(
        `https://${TOOLCHAIN_CDN_HOSTNAME}/toolchain/v1/ffmpeg/9.0.2/ffmpeg-9.0.2-${key}.zip`,
      );
      expect(adr).toContain(row.sha256);
      expect(adr).toContain(row.member_sha256);
      expect(row.member).toBe(`ffmpeg-9.0.2-${key}/ffmpeg`);
      expect(row.extra_members).toEqual([
        `ffmpeg-9.0.2-${key}/SOURCE.txt`,
        `ffmpeg-9.0.2-${key}/BUILDINFO.txt`,
      ]);
    }
    for (const key of ["linux-x64", "linux-arm64", "win32-x64", "win32-arm64"]) {
      const row = selectFfmpegArtefact(manifest, probeFor(key));
      expect(row).toMatchObject({
        version: "n9.0.2-39-g7adfbe40dc",
        publisher: "BtbN FFmpeg-Builds",
        licence: "GPL-3.0-or-later",
      });
      expect(row.url).toMatch(
        /^https:\/\/github\.com\/FFmpeg-Builds\/FFmpeg-Builds\/releases\/download\/autobuild-2026-10-31-12-59\/ffmpeg-n9\.0\.2-39-g7adfbe40dc-[a-z0-9]+-gpl-9\.0\.(tar\.xz|zip)$/,
      );
      expect(row.member).toMatch(/\/bin\/ffmpeg(\.exe)?$/);
      expect(row.licence_member).toMatch(/\/LICENSE\.txt$/);
      expect(row.extra_members).toBeUndefined();
    }
    // The one BtbN row the note measured end to end, through the xz decoder.
    const arm64 = selectFfmpegArtefact(manifest, probeFor("linux-arm64"));
    expect(adr).toContain(arm64.sha256);
    expect(adr).toContain(arm64.member_sha256);
    for (const key of ["linux-x64", "linux-arm64"]) {
      expect(manifest.ffmpeg.expected[key]).toMatchObject({ libc: "glibc", min_glibc: "2.28" });
    }
  });

  it("has an answer for every speech platform, and none of them is a fabricated digest", () => {
    const manifest = readCommittedManifest();

    expect(Object.keys(manifest.speech).sort()).toEqual([...REQUIRED_SPEECH_PLATFORMS].sort());
    for (const platform of REQUIRED_SPEECH_PLATFORMS) {
      const entry = manifest.speech[platform];
      expect(entry?.status).toBe("unavailable");
      try {
        selectSpeechBundle(manifest, platform);
        expect.unreachable("an unpublished bundle must refuse");
      } catch (error) {
        expect((error as ToolchainSelectionRefusal).reason).toBe("artefact-unavailable");
        // The refusal has to name a route that works, and which route that is changed on
        // 2026-09-11. It used to say `--tts-url`, because when every bundle was unpublished the
        // only answers were a server you already ran and the Docker image. The `onnx` route is
        // now above both in the precedence and acquires an engine from its components' own
        // upstream homes, so it is the route a reader of this refusal should take — and the one
        // that makes an unpublished bundle a deferral rather than a missing feature.
        expect((error as ToolchainSelectionRefusal).message).toContain("onnx");
      }
    }
    expect(speechPlatformKey(probeHost())).toBe(`${process.platform}-${process.arch}`);
    expect(() => selectSpeechBundle(manifest, "sunos-sparc")).toThrow(/no speech entry/);
  });
});

describe("selecting a row", () => {
  it("selects by <platform>-<arch>, whatever the row's URL is", () => {
    const manifest = readCommittedManifest();

    for (const key of BROWSER_PLATFORMS) {
      expect(selectBrowserArtefact(manifest, probeFor(key)).key).toBe(key);
    }
    for (const key of FFMPEG_PLATFORMS) {
      expect(selectFfmpegArtefact(manifest, probeFor(key)).key).toBe(key);
    }
  });

  /**
   * win32-arm64 has an FFmpeg pin and no Chrome for Testing build, so it cannot render (ADR 0031,
   * Follow-up 5) — and a 32-bit Linux has neither. Both are refused by name before a byte moves.
   */
  it("refuses a platform a block has no answer for, rather than inventing one", () => {
    const manifest = readCommittedManifest();
    const windowsArm = probe({ platform: "win32", arch: "arm64", glibc: null });

    const noBrowser = refusalOf(() => selectBrowserArtefact(manifest, windowsArm));
    expect(noBrowser.reason).toBe("unsupported-platform");
    expect(noBrowser.exitCode).toBe(3);
    expect(noBrowser.message).toContain("no browser for win32-arm64");
    expect(selectFfmpegArtefact(manifest, windowsArm).key).toBe("win32-arm64");

    for (const select of [selectBrowserArtefact, selectFfmpegArtefact]) {
      expect(refusalOf(() => select(manifest, probe({ arch: "ia32" }))).reason).toBe(
        "unsupported-platform",
      );
    }
  });

  it("refuses a supported platform the manifest in hand records nothing for", () => {
    const manifest = readCommittedManifest();
    const host = probeFor("darwin-arm64");
    const { "darwin-arm64": _browser, ...otherBrowsers } = manifest.browser.expected;
    const { "darwin-arm64": _ffmpeg, ...otherFfmpegs } = manifest.ffmpeg.expected;
    const emptied: ToolchainManifest = {
      ...manifest,
      browser: { expected: otherBrowsers },
      ffmpeg: { expected: otherFfmpegs },
    };

    const browser = refusalOf(() => selectBrowserArtefact(emptied, host));
    expect(browser.reason).toBe("no-recorded-entry");
    expect(browser.message).toContain("records no expected digest for a browser on darwin-arm64");
    expect(refusalOf(() => selectFfmpegArtefact(emptied, host)).reason).toBe("no-recorded-entry");
  });

  it("refuses a row the manifest records as unavailable, quoting its reason", () => {
    const manifest = readCommittedManifest();
    const unavailable: ToolchainManifest = {
      ...manifest,
      ffmpeg: {
        expected: {
          ...manifest.ffmpeg.expected,
          "linux-x64": { status: "unavailable", reason: "the publisher withdrew this build" },
        },
      },
    };

    const refusal = refusalOf(() => selectFfmpegArtefact(unavailable, probeFor("linux-x64")));
    expect(refusal.reason).toBe("artefact-unavailable");
    expect(refusal.message).toContain("the publisher withdrew this build");
  });

  it("refuses an artefact this machine's C library cannot run, in the same call", () => {
    const manifest = readCommittedManifest();
    // Alpine: a glibc-free Linux, where Node reports no runtime glibc at all.
    const alpine = probe({ glibc: null });

    for (const select of [selectBrowserArtefact, selectFfmpegArtefact]) {
      const refusal = refusalOf(() => select(manifest, alpine));
      expect(refusal.reason).toBe("libc-unsatisfied");
      expect(refusal.message).toContain("Alpine");
    }
    // A glibc below the browser's floor, and one between the browser's and ffmpeg's.
    expect(
      refusalOf(() => selectBrowserArtefact(manifest, probe({ glibc: [2, 24] }))).message,
    ).toMatch(/needs glibc 2\.25 or newer and this machine reports 2\.24/);
    expect(selectBrowserArtefact(manifest, probe({ glibc: [2, 27] })).key).toBe("linux-x64");
    expect(
      refusalOf(() => selectFfmpegArtefact(manifest, probe({ glibc: [2, 27] }))).message,
    ).toMatch(/needs glibc 2\.28 or newer/);
  });

  it("refuses an artefact whose C library this machine does not have", () => {
    const glibcOnly = { libc: "glibc" as const, min_glibc: "2.31" };

    expect(() =>
      assertLibcSatisfied("linux-x64", glibcOnly, probe({ glibc: [2, 36] })),
    ).not.toThrow();
    expect(() => assertLibcSatisfied("linux-x64", glibcOnly, probe({ glibc: null }))).toThrow(
      /musl/,
    );
    expect(() => assertLibcSatisfied("linux-x64", glibcOnly, probe({ glibc: [2, 28] }))).toThrow(
      /glibc 2\.31 or newer and this machine reports 2\.28/,
    );
    // A macOS or Windows host has no glibc to compare and no constraint to satisfy.
    expect(() =>
      assertLibcSatisfied("darwin-arm64", {}, probe({ platform: "darwin", glibc: null })),
    ).not.toThrow();
  });
});

describe("reading a manifest document", () => {
  const good = () =>
    JSON.parse(readFileSync(COMMITTED_MANIFEST, "utf8")) as Record<string, unknown>;

  function refuses(mutate: (document: Record<string, unknown>) => void, pattern: RegExp): void {
    const document = good();
    mutate(document);
    expect(() => parseToolchainManifest(JSON.stringify(document), "fixture")).toThrow(
      ToolchainManifestError,
    );
    expect(() => parseToolchainManifest(JSON.stringify(document), "fixture")).toThrow(pattern);
  }

  /** One row of a parsed document's `browser` or `ffmpeg` block, as a plain record to edit. */
  function row(
    document: Record<string, unknown>,
    block: "browser" | "ffmpeg",
    key: string,
  ): Record<string, unknown> {
    const expected = (document[block] as { expected: Record<string, Record<string, unknown>> })
      .expected;
    const entry = expected[key];
    expect(entry).toBeDefined();
    return entry as Record<string, unknown>;
  }

  it("refuses a document it cannot read, by naming what is wrong with it", () => {
    expect(() => parseToolchainManifest("{", "fixture")).toThrow(/not valid JSON/);
    expect(() => parseToolchainManifest("[]", "fixture")).toThrow(/the manifest is not an object/);
    refuses((d) => {
      delete (d.speech as Record<string, unknown>)["win32-x64"];
    }, /no speech entry for win32-x64/);
    refuses((d) => {
      row(d, "browser", "darwin-arm64").sha256 = "NOTHEX";
    }, /not a lowercase 64-character hex SHA-256/);
    refuses((d) => {
      row(d, "browser", "darwin-arm64").url =
        "http://storage.googleapis.com/chrome-for-testing-public/x.zip";
    }, /http:\/\/, and an artefact is fetched over https only/);
    refuses((d) => {
      row(d, "ffmpeg", "darwin-arm64").status = "trusted";
    }, /is neither "recorded" nor "unavailable"/);
    refuses((d) => {
      delete d.ffmpeg;
    }, /ffmpeg is not an object/);
  });

  /**
   * A format-1 document is what released CLIs read, at the version-1 path: refused as older, by
   * name, rather than read as a document with no ffmpeg in it. A newer one is a rollback signal.
   */
  it("refuses a format it does not read, in both directions", () => {
    refuses((d) => {
      d.format_version = 1;
    }, /format_version 1; this build reads 2, at toolchain\/v2\/manifest\.json/);
    refuses((d) => {
      d.format_version = 3;
    }, /format_version 3; this build reads 2\. A newer manifest is a rollback signal/);
  });

  // AC-A3, one refusal each.

  it("refuses a browser URL no allowlisted publisher serves", () => {
    refuses((d) => {
      row(d, "browser", "linux-arm64").url =
        "https://playwright.azureedge.net/builds/chromium/1421/chromium-headless-shell-linux-arm64.zip";
    }, /browser\.expected\.linux-arm64\.url is https:\/\/playwright\.azureedge\.net\/.*no publisher this build trusts serves it/);
  });

  /**
   * A prefix and not a host, because `github.com` hosts every GitHub user's releases: the project's
   * previous owner, a sibling repository and a `..` segment that climbs out of the prefix are all
   * on the right host and all refused.
   */
  it("refuses an ffmpeg URL no allowlisted publisher serves, however close it looks", () => {
    for (const url of [
      "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz",
      "https://github.com/FFmpeg-Builds/FFmpeg-Builds-mirror/releases/download/x/ffmpeg.tar.xz",
      "https://cdn.xplainer.video/toolchain/v1/speech/ffmpeg.zip",
    ]) {
      refuses((d) => {
        row(d, "ffmpeg", "linux-x64").url = url;
      }, /ffmpeg\.expected\.linux-x64\.url is .*no publisher this build trusts serves it/);
    }
    refuses((d) => {
      row(d, "ffmpeg", "linux-x64").url =
        "https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/../../../../evil/x/releases/download/y/ffmpeg.tar.xz";
    }, /not in its normal form \(https:\/\/github\.com\/evil\/x\/releases\/download\/y\/ffmpeg\.tar\.xz\)/);
  });

  it("refuses a block that is missing a platform it is selected on", () => {
    refuses((d) => {
      delete (d.browser as { expected: Record<string, unknown> }).expected["win32-x64"];
    }, /has no browser entry for win32-x64/);
    refuses((d) => {
      delete (d.ffmpeg as { expected: Record<string, unknown> }).expected["win32-arm64"];
    }, /has no ffmpeg entry for win32-arm64/);
  });

  it("refuses a member that could be unpacked outside its destination", () => {
    refuses((d) => {
      row(d, "ffmpeg", "linux-x64").member = "../../bin/ffmpeg";
    }, /ffmpeg\.expected\.linux-x64\.member is refused: .*climbs out of the directory/);
    refuses((d) => {
      row(d, "browser", "win32-x64").member = "C:/Windows/chrome-headless-shell.exe";
    }, /browser\.expected\.win32-x64\.member is refused: .*absolute path/);
  });

  it("refuses a licence member that could be unpacked outside its destination", () => {
    refuses((d) => {
      row(d, "ffmpeg", "win32-x64").licence_member = "ffmpeg\\..\\LICENSE.txt";
    }, /ffmpeg\.expected\.win32-x64\.licence_member is refused: .*backslash/);
  });

  it("refuses an extra member that could be unpacked outside its destination", () => {
    refuses((d) => {
      row(d, "ffmpeg", "darwin-arm64").extra_members = [
        "ffmpeg-9.0.2-darwin-arm64/SOURCE.txt",
        "/etc/BUILDINFO.txt",
      ];
    }, /ffmpeg\.expected\.darwin-arm64\.extra_members\[1\] is refused: .*absolute path/);
  });

  /**
   * A version becomes part of the directory a component is installed under —
   * `ffmpeg-<version>-<digest>`, `chrome-headless-shell-<version>-<digest>` — so one that could be
   * read as a path (`9/../../../../tmp/planted` put the ffmpeg tree in `/tmp`) is refused before it
   * is ever joined onto one.
   */
  it("refuses a version that is not one path segment, in every block that installs by it", () => {
    for (const version of ["9/../../../../tmp/planted", "..", ".", "9.0 2", "9\\..\\x"]) {
      refuses((d) => {
        row(d, "ffmpeg", "darwin-arm64").version = version;
      }, /ffmpeg\.expected\.darwin-arm64\.version is .*, which is not one path segment/);
    }
    refuses((d) => {
      row(d, "browser", "linux-x64").version = "157/../../../../tmp/planted-browser";
    }, /browser\.expected\.linux-x64\.version is .*, which is not one path segment/);
    refuses((d) => {
      (d.speech as Record<string, unknown>)["linux-x64"] = {
        status: "recorded",
        version: "../0.19.0",
        url: `https://${TOOLCHAIN_CDN_HOSTNAME}/toolchain/v1/speech-linux-x64.zip`,
        sha256: "a".repeat(64),
        size: 123,
      };
    }, /speech\.linux-x64\.version is .*, which is not one path segment/);
  });

  it("refuses a member digest that is not a lowercase 64-character hex SHA-256", () => {
    refuses((d) => {
      row(d, "ffmpeg", "linux-arm64").member_sha256 = "091FE4DF";
    }, /ffmpeg\.expected\.linux-arm64\.member_sha256 is not a lowercase 64-character hex SHA-256/);
  });

  it("refuses a licence that is not one of the accepted SPDX ids", () => {
    for (const licence of ["GPL-3.0", "nonfree", "MIT"]) {
      refuses((d) => {
        row(d, "ffmpeg", "win32-arm64").licence = licence;
      }, /ffmpeg\.expected\.win32-arm64\.licence is ".*", which is not one of the SPDX ids/);
    }
    expect(ACCEPTED_FFMPEG_LICENCES).toEqual([
      "LGPL-2.1-or-later",
      "LGPL-3.0-or-later",
      "GPL-2.0-or-later",
      "GPL-3.0-or-later",
    ]);
  });

  /**
   * The publisher on a parsed row is the allowlist's answer, never the document's: a `publisher`
   * the document carries is not read, so a manifest cannot relabel whose bytes it is admitting.
   */
  it("gives every recorded row the publisher its URL prefix maps to, and ignores the document's", () => {
    const document = good();
    row(document, "browser", "darwin-arm64").publisher = "somebody trustworthy";
    const manifest = parseToolchainManifest(JSON.stringify(document), "fixture");

    expect(selectBrowserArtefact(manifest, probeFor("darwin-arm64")).publisher).toBe(
      "Google (Chrome for Testing)",
    );
    expect(Object.values(ARTEFACT_ALLOWLIST).sort()).toEqual([
      "BtbN FFmpeg-Builds",
      "Google (Chrome for Testing)",
      "xplainer.video",
    ]);
    for (const prefix of Object.keys(ARTEFACT_ALLOWLIST)) {
      expect(prefix).toMatch(/^https:\/\/[^/]+\/.+\/$/);
    }
  });

  it("refuses a speech bundle served from anywhere but the provisioned hostname", () => {
    const document = good();
    (document.speech as Record<string, unknown>)["linux-x64"] = {
      status: "recorded",
      version: "1.0.0",
      url: "https://xplainer-artifacts.4f1.r2.dev/toolchain/v1/speech-linux-x64.zip",
      sha256: "0".repeat(64),
      size: 10,
    };

    expect(() => parseToolchainManifest(JSON.stringify(document), "fixture")).toThrow(
      /served from xplainer-artifacts\.4f1\.r2\.dev/,
    );
  });

  it("accepts a speech bundle that is published to the provisioned hostname", () => {
    const document = good();
    (document.speech as Record<string, unknown>)["linux-x64"] = {
      status: "recorded",
      version: "0.19.0",
      url: `https://${TOOLCHAIN_CDN_HOSTNAME}/toolchain/v1/speech-linux-x64.zip`,
      sha256: "a".repeat(64),
      size: 123,
    };
    const manifest = parseToolchainManifest(JSON.stringify(document), "fixture");

    expect(selectSpeechBundle(manifest, "linux-x64")).toEqual({
      status: "recorded",
      version: "0.19.0",
      url: `https://${TOOLCHAIN_CDN_HOSTNAME}/toolchain/v1/speech-linux-x64.zip`,
      sha256: "a".repeat(64),
      size: 123,
    });
  });
});
