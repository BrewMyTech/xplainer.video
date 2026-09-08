/**
 * The manifest's address, its shape, and the one question it exists to answer.
 *
 * Three things are checked against something outside this module rather than against a copy of it:
 * the **hostname** comes out of `infra/terraform`, the **selector** is compared with the pinned
 * Remotion line's own function over its whole branch matrix, and the **committed manifest** is read
 * as a document rather than as a fixture. A test that asserted the URL against a constant declared
 * beside it would agree with itself for ever.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertLibcSatisfied,
  type ChromeMode,
  type ChromeSelection,
  canUseRemotionMediaBinaries,
  chromeDownloadUrl,
  DEFAULT_CHROME_MODE,
  deliveryPosition,
  type HostProbe,
  hostChromeSelection,
  isAmazonLinux2023,
  parseToolchainManifest,
  probeHost,
  REMOTION_PLAYWRIGHT_BUILD,
  REMOTION_TESTED_CHROME_VERSION,
  REQUIRED_SPEECH_PLATFORMS,
  type RemotionPlatform,
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

/**
 * The real `getChromeDownloadUrl`, from the renderer the **pinned `@remotion/cli`** resolves.
 *
 * It is reached in two steps and neither is incidental. `@remotion/cli` is this package's declared
 * devDependency at 4.0.495, so resolving the renderer *through it* is the renderer a render
 * actually uses rather than whatever a hoisted tree happens to expose. And the function itself is
 * loaded by absolute path, because `@remotion/renderer`'s `exports` map publishes four entry points
 * and this is in none of them — which is exactly why `manifest.ts` mirrors it instead of importing
 * it, and why the mirror has to be compared with the original here.
 */
function realSelector(): {
  getChromeDownloadUrl: (options: {
    platform: RemotionPlatform;
    version: string | null;
    chromeMode: ChromeMode;
  }) => string;
  TESTED_VERSION: string;
  isAmazonLinux2023: () => boolean;
  canUseRemotionMediaBinaries: () => boolean;
} {
  const fromHere = createRequire(import.meta.url);
  const fromCli = createRequire(fromHere.resolve("@remotion/cli/package.json"));
  const renderer = dirname(fromCli.resolve("@remotion/renderer/package.json"));
  return fromHere(join(renderer, "dist", "browser", "get-chrome-download-url.js"));
}

const PLATFORMS: RemotionPlatform[] = ["linux64", "linux-arm64", "mac-x64", "mac-arm64", "win64"];
const MODES: ChromeMode[] = ["headless-shell", "chrome-for-testing"];

/** Every configuration the real function branches on: 5 × 2 × 2 × 2 × 2 = 80. */
function matrix(): ChromeSelection[] {
  const rows: ChromeSelection[] = [];
  for (const platform of PLATFORMS) {
    for (const chromeMode of MODES) {
      for (const version of [null, "1500"]) {
        for (const amazonLinux2023 of [false, true]) {
          for (const remotionMediaBinaries of [false, true]) {
            rows.push({ platform, version, chromeMode, amazonLinux2023, remotionMediaBinaries });
          }
        }
      }
    }
  }
  return rows;
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

  it("says nothing is published, and that the two delivery steps are manual", () => {
    const readme = readFileSync(README, "utf8");
    const message = deliveryPosition(probe({ platform: "darwin", arch: "arm64", glibc: null }));

    // The two steps the module documents as its own, which is why the message can promise them.
    expect(readme).toContain("Connect the bucket to the custom domain.");
    expect(readme).toContain("Add a Cache Rule for that hostname.");
    // And what the message tells a user, in the same terms.
    expect(message).toContain(`Nothing is published to ${TOOLCHAIN_MANIFEST_URL} in this phase`);
    expect(message).toContain("custom domain");
    expect(message).toContain("Cache Rule");
    expect(message).toContain("manual steps Terraform does not manage");
    expect(message).toContain("infra/README.md");
  });

  it("names the publisher as the release owner in phase 4, not a command in this repository", () => {
    const message = deliveryPosition(probe({ platform: "linux", arch: "x64" }));

    expect(message).toContain("no command in this repository uploads a manifest");
    expect(message).toContain("release owner's step, in phase 4");
  });

  it("names the two speech routes that do work on macOS and Linux", () => {
    for (const host of [
      probe({ platform: "darwin", arch: "arm64", glibc: null }),
      probe({ platform: "linux", arch: "arm64" }),
    ]) {
      const message = deliveryPosition(host);

      expect(message).toContain(`two routes that work on ${speechPlatformKey(host)}`);
      expect(message).toContain("--tts-url <url>");
      expect(message).toContain("the docker route pulls the pinned Kokoro-FastAPI image by digest");
    }
  });

  /**
   * §2.5's asymmetry, which is the roadmap's: P2-4 is met on macOS and Linux and pending on
   * Windows, so the Windows message offers neither route it cannot deliver and names the milestone
   * that closes the gap instead.
   */
  it("tells a Windows machine it has no working speech route, and names phase 4", () => {
    const message = deliveryPosition(probe({ platform: "win32", arch: "x64", glibc: null }));

    expect(message).toContain("Windows has no working speech route at all this phase");
    expect(message).toContain("None of the three is available");
    expect(message).toContain("The milestone that closes it is phase 4");
    // Neither route is offered as available: no "routes that work" sentence, and no bare
    // instruction to pull an image or to pass a URL.
    expect(message).not.toMatch(/routes that work/);
    expect(message).not.toContain("the docker route pulls the pinned Kokoro-FastAPI image");
    expect(message).not.toContain("`xplainer setup --tts-url <url>` records");
    // What it does say about each of them is why it is not one.
    expect(message).toContain("needs a linux/amd64 container engine");
    expect(message).toContain("rather than acquiring speech on this machine");
  });
});

describe("the mirror of the pinned Remotion line's Chrome selector", () => {
  it("agrees with the real getChromeDownloadUrl on all 80 branch combinations", () => {
    const real = realSelector();
    const disagreements: string[] = [];

    for (const selection of matrix()) {
      // The real function reads `/etc/os-release` and `process.report` through two of its own
      // exported predicates. Replacing those two — and nothing else — drives the real branching
      // code for a configuration this machine is not, which is the only way to compare the Amazon
      // Linux and glibc branches from one host. It is not a stub of the thing under test: the
      // function being compared with is the shipped one, entirely.
      real.isAmazonLinux2023 = () => selection.amazonLinux2023;
      real.canUseRemotionMediaBinaries = () => selection.remotionMediaBinaries;
      const expected = real.getChromeDownloadUrl({
        platform: selection.platform,
        version: selection.version,
        chromeMode: selection.chromeMode,
      });
      const found = chromeDownloadUrl(selection);
      if (found !== expected) {
        disagreements.push(`${JSON.stringify(selection)}\n  real: ${expected}\n  ours: ${found}`);
      }
    }

    expect(disagreements).toEqual([]);
    expect(matrix()).toHaveLength(80);
  });

  it("carries the same pinned versions the real module does", () => {
    const real = realSelector();

    expect(REMOTION_TESTED_CHROME_VERSION).toBe(real.TESTED_VERSION);
    // The Playwright build number is not exported, so it is read out of the branch that uses it.
    real.isAmazonLinux2023 = () => false;
    real.canUseRemotionMediaBinaries = () => false;
    expect(
      real.getChromeDownloadUrl({
        platform: "linux-arm64",
        version: null,
        chromeMode: "headless-shell",
      }),
    ).toContain(`/builds/chromium/${REMOTION_PLAYWRIGHT_BUILD}/`);
  });

  it("resolves this machine's own configuration to what Remotion would download here", () => {
    const real = realSelector();
    const here = probeHost();
    const platform = remotionPlatform(here.platform, here.arch);

    expect(platform).not.toBeNull();
    expect(hostChromeSelection(here)).toEqual({
      platform,
      version: null,
      chromeMode: DEFAULT_CHROME_MODE,
      amazonLinux2023: isAmazonLinux2023(here),
      remotionMediaBinaries: canUseRemotionMediaBinaries(here),
    });
    // No patching here: this is the unmodified module answering for the machine the suite is on.
    expect(chromeDownloadUrl(hostChromeSelection(here))).toBe(
      real.getChromeDownloadUrl({
        platform: platform as RemotionPlatform,
        version: null,
        chromeMode: DEFAULT_CHROME_MODE,
      }),
    );
  });

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
  it("parses, and pins the Remotion line and the Chrome build this package depends on", () => {
    const manifest = readCommittedManifest();
    const cliManifest = JSON.parse(
      readFileSync(join(HERE, "..", "..", "package.json"), "utf8"),
    ) as { devDependencies: Record<string, string> };

    expect(manifest.format_version).toBe(TOOLCHAIN_MANIFEST_FORMAT_VERSION);
    expect(manifest.chrome.remotion).toBe(cliManifest.devDependencies.remotion);
    expect(manifest.chrome.version).toBe(realSelector().TESTED_VERSION);
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
        expect((error as ToolchainSelectionRefusal).message).toContain("--tts-url");
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
