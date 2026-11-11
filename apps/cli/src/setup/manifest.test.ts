/**
 * The manifest's address, its shape, and the one question it exists to answer.
 *
 * Two things are checked against something outside this module rather than against a copy of it:
 * the **hostname** comes out of `infra/terraform`, and the **committed manifest** is read as a
 * document rather than as a fixture — so every URL the selector can produce for a supported host
 * has to be one a reviewed digest was recorded for. A test that asserted the URL against a constant
 * declared beside it would agree with itself for ever.
 *
 * Note, 2026-11-11: the **selector** used to be a third such check, compared with the pinned
 * Remotion line's own `getChromeDownloadUrl` over its whole 80-row branch matrix by loading that
 * function out of this checkout's installed `@remotion/cli`. This package stopped depending on it
 * when the renderer became its own, so there is no installed original left to drive and the three
 * cases that did were retired here. The mirror in `manifest.ts` is now the selector this package
 * owns, frozen at that line; its URL table and the committed digests are unchanged, and the cases
 * under "the committed manifest" below are what still tie the two together.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertLibcSatisfied,
  canUseRemotionMediaBinaries,
  chromeDownloadUrl,
  deliveryPosition,
  type HostProbe,
  hostChromeSelection,
  isAmazonLinux2023,
  parseToolchainManifest,
  probeHost,
  REMOTION_TESTED_CHROME_VERSION,
  REQUIRED_SPEECH_PLATFORMS,
  remotionPlatform,
  selectChromeArtefact,
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

function readCommittedManifest(): ToolchainManifest {
  return parseToolchainManifest(
    readFileSync(COMMITTED_MANIFEST, "utf8"),
    "apps/cli/src/setup/toolchain.manifest.json",
  );
}

function probe(overrides: Partial<HostProbe> = {}): HostProbe {
  return { platform: "linux", arch: "x64", osRelease: null, glibc: [2, 36], ...overrides };
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
    expect(TOOLCHAIN_MANIFEST_URL).toBe("https://cdn.xplainer.video/toolchain/v1/manifest.json");
    expect(TOOLCHAIN_MANIFEST_PATH).toBe("toolchain/v1/manifest.json");
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
    // Reworded 2026-09-11 with the rest of this message: `--manifest` used to be "what lets a
    // browser acquisition run at all", which was true only while nothing was published. It is now
    // the way past a manifest this machine cannot reach, and the browser is what the failure blocks.
    expect(message).toContain("the browser is what this failure actually blocks");
  });
});

describe("the mirror of the pinned Remotion line's Chrome selector", () => {
  // Note, 2026-11-11: three cases stood here — the mirror against the real getChromeDownloadUrl
  // on all 80 branch combinations, the pinned TESTED_VERSION and Playwright build read out of the
  // real module, and this machine's own configuration answered by the unpatched original. Each
  // loaded the function out of this checkout's installed @remotion/cli, and this package no longer
  // installs it: the renderer is its own, and the mirror is the selector it owns. They were retired
  // rather than pointed at a copy, because a mirror compared with itself proves nothing.
  it("refuses a platform the pinned line has no build for, rather than inventing a URL", () => {
    expect(remotionPlatform("linux", "ia32")).toBeNull();
    expect(remotionPlatform("win32", "arm64")).toBeNull();
    expect(remotionPlatform("freebsd", "x64")).toBeNull();
    expect(() => hostChromeSelection(probe({ arch: "ia32" }))).toThrow(ToolchainSelectionRefusal);
    try {
      hostChromeSelection(probe({ arch: "ia32" }));
      expect.unreachable("a platform with no Remotion build must refuse");
    } catch (error) {
      expect((error as ToolchainSelectionRefusal).reason).toBe("unsupported-platform");
      expect((error as ToolchainSelectionRefusal).exitCode).toBe(3);
    }
  });

  it("reads Amazon Linux and glibc the way the real predicates do", () => {
    const amazon = probe({
      osRelease: 'NAME="Amazon Linux"\nVERSION="2023"\nID="amzn"\n',
    });

    expect(isAmazonLinux2023(amazon)).toBe(true);
    expect(isAmazonLinux2023(probe({ osRelease: 'NAME="Amazon Linux"\nVERSION="2"\n' }))).toBe(
      false,
    );
    expect(isAmazonLinux2023(probe({ platform: "darwin", osRelease: 'NAME="Amazon Linux"' }))).toBe(
      false,
    );
    expect(canUseRemotionMediaBinaries(probe({ glibc: [2, 35] }))).toBe(true);
    expect(canUseRemotionMediaBinaries(probe({ glibc: [2, 34] }))).toBe(false);
    expect(canUseRemotionMediaBinaries(probe({ glibc: [3, 0] }))).toBe(true);
    expect(canUseRemotionMediaBinaries(probe({ glibc: null }))).toBe(false);
    expect(canUseRemotionMediaBinaries(probe({ platform: "darwin", glibc: [2, 39] }))).toBe(false);
  });
});

describe("the committed manifest", () => {
  it("parses, and pins the selector's line and the Chrome build the selector names", () => {
    const manifest = readCommittedManifest();

    expect(manifest.format_version).toBe(TOOLCHAIN_MANIFEST_FORMAT_VERSION);
    // Until 2026-11-11 this compared the line with this package's own devDependency on it, which
    // the move to an owned renderer removed. What is left to assert is that the field names one
    // exact release, which is what a refusal quotes back to the user.
    expect(manifest.chrome.remotion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.chrome.version).toBe(REMOTION_TESTED_CHROME_VERSION);
  });

  it("records an expected digest for every URL the pinned selector can resolve to here", () => {
    const manifest = readCommittedManifest();
    // The nine configurations `setup` can meet: three platform-and-architecture pairs with one
    // artefact each, and the two Linux architectures with their three C-library branches.
    const supported: HostProbe[] = [
      probe({ platform: "darwin", arch: "arm64", glibc: null }),
      probe({ platform: "darwin", arch: "x64", glibc: null }),
      probe({ platform: "win32", arch: "x64", glibc: null }),
      probe({ platform: "linux", arch: "x64", glibc: [2, 31] }),
      probe({ platform: "linux", arch: "x64", glibc: [2, 36] }),
      probe({ platform: "linux", arch: "x64", osRelease: 'NAME="Amazon Linux"\nVERSION="2023"' }),
      probe({ platform: "linux", arch: "arm64", glibc: [2, 36] }),
      probe({ platform: "linux", arch: "arm64", osRelease: 'NAME="Amazon Linux"\nVERSION="2023"' }),
    ];

    for (const host of supported) {
      const acquisition = selectChromeArtefact(manifest, host);
      expect(acquisition.url).toBe(chromeDownloadUrl(hostChromeSelection(host)));
      expect(acquisition.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(acquisition.size).toBeGreaterThan(1_000_000);
    }
    expect(supported).toHaveLength(8);
    expect(Object.keys(manifest.chrome.expected)).toContain("linux-x64-glibc");
    expect(manifest.chrome.expected["linux-x64-glibc"]).toMatchObject({
      libc: "glibc",
      min_glibc: "2.31",
    });
    expect(Object.keys(manifest.chrome.expected).some((key) => key.startsWith("linux-arm64"))).toBe(
      true,
    );
  });

  it("says so, rather than trusting the bytes, where an artefact cannot be recorded", () => {
    const manifest = readCommittedManifest();
    // arm64 Linux below glibc 2.35 and not Amazon Linux: the pinned line selects a Playwright
    // build whose CDN answers 400 through its redirect, so there is nothing to digest.
    const host = probe({ arch: "arm64", glibc: [2, 31] });
    const selection = hostChromeSelection(host);

    expect(chromeDownloadUrl(selection)).toContain("playwright.azureedge.net");
    try {
      selectChromeArtefact(manifest, host);
      expect.unreachable("an unavailable artefact must refuse");
    } catch (error) {
      const refusal = error as ToolchainSelectionRefusal;
      expect(refusal.reason).toBe("artefact-unavailable");
      expect(refusal.url).toBe(chromeDownloadUrl(selection));
      expect(refusal.message).toContain("GatewayExceptionResponse");
      expect(refusal.exitCode).toBe(3);
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

describe("selecting an entry", () => {
  it("matches on the resolved URL and not on an os-and-architecture key", () => {
    const manifest = readCommittedManifest();
    const host = probe({ platform: "darwin", arch: "arm64", glibc: null });
    const renamed: ToolchainManifest = {
      ...manifest,
      chrome: {
        ...manifest.chrome,
        expected: { "a-key-nobody-would-guess": manifest.chrome.expected["darwin-arm64"] as never },
      },
    };

    expect(selectChromeArtefact(renamed, host).key).toBe("a-key-nobody-would-guess");
    expect(selectChromeArtefact(renamed, host).url).toBe(
      chromeDownloadUrl(hostChromeSelection(host)),
    );
  });

  it("refuses an artefact this machine's C library cannot run, in the same call", () => {
    const manifest = readCommittedManifest();
    // Alpine: a glibc-free Linux, where Node reports no runtime glibc at all.
    const alpine = probe({
      glibc: null,
      osRelease: 'NAME="Alpine Linux"\nID=alpine\nVERSION_ID=3.21.0\n',
    });

    try {
      selectChromeArtefact(manifest, alpine);
      expect.unreachable("a musl host must refuse");
    } catch (error) {
      expect((error as ToolchainSelectionRefusal).reason).toBe("libc-unsatisfied");
      expect((error as ToolchainSelectionRefusal).message).toContain("Alpine");
    }
  });

  it("refuses a configuration the manifest does not record, naming the URL", () => {
    const manifest = readCommittedManifest();

    try {
      selectChromeArtefact(manifest, probe({ platform: "darwin", arch: "arm64", glibc: null }), {
        version: "1500",
      });
      expect.unreachable("an unrecorded configuration must refuse");
    } catch (error) {
      const refusal = error as ToolchainSelectionRefusal;
      expect(refusal.reason).toBe("no-recorded-entry");
      expect(refusal.message).toContain("1500");
      expect(refusal.message).toContain(manifest.chrome.remotion);
    }
  });

  it("refuses an artefact whose C library this machine does not have", () => {
    const glibcOnly = { libc: "glibc" as const, min_glibc: "2.31" };

    expect(() =>
      assertLibcSatisfied("linux-x64-glibc", glibcOnly, probe({ glibc: [2, 36] })),
    ).not.toThrow();
    expect(() => assertLibcSatisfied("linux-x64-glibc", glibcOnly, probe({ glibc: null }))).toThrow(
      /musl/,
    );
    expect(() =>
      assertLibcSatisfied("linux-x64-glibc", glibcOnly, probe({ glibc: [2, 28] })),
    ).toThrow(/glibc 2\.31 or newer and this machine reports 2\.28/);
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
    expect(() => parseToolchainManifest(JSON.stringify(document), "fixture")).toThrow(pattern);
  }

  /** The `darwin-arm64` row of a parsed document, as a plain record to edit. */
  function macEntry(document: Record<string, unknown>): Record<string, unknown> {
    const chrome = document.chrome as { expected: Record<string, Record<string, unknown>> };
    const entry = chrome.expected["darwin-arm64"];
    expect(entry).toBeDefined();
    return entry as Record<string, unknown>;
  }

  it("refuses a document it cannot read, by naming what is wrong with it", () => {
    expect(() => parseToolchainManifest("{", "fixture")).toThrow(/not valid JSON/);
    expect(() => parseToolchainManifest("[]", "fixture")).toThrow(/the manifest is not an object/);
    refuses((d) => {
      d.format_version = 2;
    }, /format_version 2; this build reads 1/);
    refuses((d) => {
      delete (d.speech as Record<string, unknown>)["win32-x64"];
    }, /no speech entry for win32-x64/);
    refuses((d) => {
      macEntry(d).sha256 = "NOTHEX";
    }, /not a lowercase 64-character hex SHA-256/);
    refuses((d) => {
      macEntry(d).url = "http://storage.googleapis.com/x.zip";
    }, /http:\/\/, and an artefact is fetched over https only/);
    refuses((d) => {
      macEntry(d).status = "trusted";
    }, /is neither "recorded" nor "unavailable"/);
    refuses((d) => {
      (d.chrome as Record<string, unknown>).expected = {};
    }, /records no Chrome artefacts at all/);
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
