/**
 * The FFmpeg provider: the sentence before the download, both digests, the probe, and the licence.
 *
 * The heart of this file is AC-A4, and it is run against a **real** ffmpeg packed into a zip and
 * served from the loopback artefact server (`testing/artefact-server.ts`): the binary this machine
 * has — Homebrew's here, `ci.yml`'s `apt-get install ffmpeg` there — found by the test-only lookup in
 * `testing/toolchain.ts`. That is what makes "the marker's `probe` comes from the real binary" a
 * fact rather than a fixture agreeing with itself. The ways a binary can be wrong — too old, no
 * libx264, an `-L` contradicting its `-buildconf`, an answer that never comes — are a scripted
 * ffmpeg (`testing/fake-ffmpeg.ts`), because no real binary is wrong on demand.
 */

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { hashFile } from "../../runtime/manifest.js";
import { ACQUIRED_FILE, readAcquired } from "../acquired.js";
import { sha256Of } from "../archive.js";
import { DownloadRefusal } from "../download.js";
import {
  ACCEPTED_FFMPEG_LICENCES,
  type FfmpegSelection,
  parseToolchainManifest,
  probeHost,
  type RecordedFfmpegArtefact,
  selectFfmpegArtefact,
  speechPlatformKey,
  type ToolchainManifest,
} from "../manifest.js";
import { committedManifestPath } from "../source.js";
import { extractTar } from "../tar.js";
import {
  ARTEFACT_ROUTES,
  type ArtefactServer,
  startArtefactServer,
  tarXzRoute,
} from "../testing/artefact-server.js";
import { LICENCE_STATEMENTS, writeFakeFfmpeg } from "../testing/fake-ffmpeg.js";
import { findTestFfmpeg } from "../testing/toolchain.js";
import { buildZip } from "../testing/zip-builder.js";
import {
  acquireFfmpeg,
  FFMPEG_MANIFEST_PROVIDER,
  FFMPEG_PATH_PROVIDER,
  FfmpegRefusal,
  ffmpegDestination,
  ffmpegSentence,
  ffmpegSourceOf,
  licenceDisagreement,
  licenceFromBuildconf,
  licenceFromStatement,
  PROVENANCE_FILE,
  parseEncoders,
  parseLibavcodec,
  probeFfmpeg,
  recordFfmpegPath,
} from "./ffmpeg.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const XZ_FIXTURE = join(HERE, "..", "fixtures", "ffmpeg-build-fixture.tar.xz");

const directories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** The reviewed document this repository commits, read the way `setup` reads one. */
function committedManifest(): ToolchainManifest {
  const path = committedManifestPath();
  expect(path, "this checkout has no committed toolchain manifest").not.toBeNull();
  return parseToolchainManifest(readFileSync(path ?? "", "utf8"), path ?? "");
}

/** The committed row for `key`, selected as `setup` selects it. */
function committedSelection(key: string): FfmpegSelection {
  const [platform, arch] = key.split("-");
  return selectFfmpegArtefact(committedManifest(), {
    platform: platform ?? "",
    arch: arch ?? "",
    glibc: [2, 39],
  });
}

/** A manifest whose `ffmpeg` row for this machine is `row`, every other block as committed. */
function withRow(row: RecordedFfmpegArtefact): ToolchainManifest {
  const manifest = committedManifest();
  return {
    ...manifest,
    ffmpeg: { expected: { ...manifest.ffmpeg.expected, [speechPlatformKey(probeHost())]: row } },
  };
}

/** Every entry under `directory`, sorted, so "nothing was committed" is one comparison. */
function listing(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

describe("what the build says about itself", () => {
  it("reads libavcodec as the version the binary loaded", () => {
    expect(parseLibavcodec("libavcodec     62. 28.101 / 62. 28.101\n")).toBe("62.28.101");
    expect(parseLibavcodec("libavcodec     63.  1.102 / 63.  1.102\n")).toBe("63.1.102");
    // Built against one and running with another: the one the encode uses is the second.
    expect(parseLibavcodec("libavcodec     61.  3.100 / 62.  0.100\n")).toBe("62.0.100");
    expect(parseLibavcodec("libavutil      61.  1.102 / 61.  1.102\n")).toBeNull();
  });

  it("reads -encoders as rows after the rule, flags and name", () => {
    const rows = parseEncoders(
      "Encoders:\n V..... = Video\n ------\n V....D libx264   libx264 H.264\n A..X.. opus  Opus\n",
    );
    expect(rows).toEqual([
      { flags: "V....D", name: "libx264" },
      { flags: "A..X..", name: "opus" },
    ]);
  });

  /** FFmpeg's own rule: nonfree wins, gpl makes it GPL, version3 moves either family to 3. */
  it("derives the licence from -buildconf's whole flags, never a substring of one", () => {
    const conf = (...flags: string[]): string[] => [
      "  configuration:",
      ...flags.map((f) => `    ${f}`),
    ];
    expect(licenceFromBuildconf(conf("--enable-gpl"))).toBe("GPL-2.0-or-later");
    expect(licenceFromBuildconf(conf("--enable-gpl", "--enable-version3"))).toBe(
      "GPL-3.0-or-later",
    );
    expect(licenceFromBuildconf(conf("--enable-version3"))).toBe("LGPL-3.0-or-later");
    expect(licenceFromBuildconf(conf())).toBe("LGPL-2.1-or-later");
    expect(licenceFromBuildconf(conf("--enable-gpl", "--enable-nonfree"))).toBe("nonfree");
    // Our macOS build's demuxer list contains `--enable-` and must not read as a flag.
    expect(licenceFromBuildconf(conf("--enable-demuxer='image2pipe,--enable-gpl'"))).toBe(
      "LGPL-2.1-or-later",
    );
  });

  it("derives the licence from each of the five statements -L prints", () => {
    for (const [licence, statement] of Object.entries(LICENCE_STATEMENTS)) {
      expect(licenceFromStatement(statement), licence).toBe(licence);
    }
    expect(licenceFromStatement(["something else entirely"])).toBeNull();
  });

  it("names every answer that contradicts the row's licence, and nothing when both agree", () => {
    const gpl2 = {
      buildconf: ["--enable-gpl"],
      license: [...(LICENCE_STATEMENTS["GPL-2.0-or-later"] ?? [])],
    };
    expect(licenceDisagreement("GPL-2.0-or-later", gpl2)).toBeNull();
    expect(licenceDisagreement("GPL-3.0-or-later", gpl2)).toBe(
      "was configured as GPL-2.0-or-later (`-buildconf`) and states GPL-2.0-or-later (`-L`)",
    );
    expect(
      licenceDisagreement("GPL-2.0-or-later", {
        ...gpl2,
        license: [...(LICENCE_STATEMENTS["GPL-3.0-or-later"] ?? [])],
      }),
    ).toBe("states GPL-3.0-or-later (`-L`)");
  });
});

describe("the sentence before the download", () => {
  /**
   * The Debian-installer sentence: who built it, its licence, that it is a separate program, and
   * where its source is. Our own build names its source page in the row; BtbN's is its release.
   */
  it("names the publisher, the licence, a separate program, and the source", () => {
    const macos = committedSelection("darwin-arm64");
    expect(ffmpegSentence(macos)).toBe(
      "ffmpeg: FFmpeg 9.0.2 for darwin-arm64 is built and published by xplainer.video under " +
        "GPL-2.0-or-later. It runs as a separate program — xplainer starts it with arguments and " +
        "never links it — and its source is at " +
        "https://cdn.xplainer.video/toolchain/v1/ffmpeg/9.0.2/source/README.txt.",
    );

    const linux = committedSelection("linux-arm64");
    expect(ffmpegSourceOf(linux)).toBe(
      "https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/tag/autobuild-2026-10-31-12-59",
    );
    expect(ffmpegSentence(linux)).toContain("is built and published by BtbN FFmpeg-Builds");
    expect(ffmpegSentence(linux)).toContain("under GPL-3.0-or-later");
  });
});

describe("setup --ffmpeg-path", () => {
  it("records the named binary as it answers, its digest recorded rather than expected", () => {
    const fake = writeFakeFfmpeg(temporaryDirectory("xplainer-fake-ffmpeg-"), {
      version: "7.1.1",
      libavcodec: "61.19.101",
      licence: "GPL-3.0-or-later",
    });
    const lines: string[] = [];

    const ffmpeg = recordFfmpegPath({ path: fake, log: (line) => lines.push(line) });

    expect(ffmpeg).toMatchObject({
      version: "7.1.1",
      path: fake,
      sha256: hashFile(fake),
      provider: FFMPEG_PATH_PROVIDER,
      libavcodec: "61.19.101",
      licence: "GPL-3.0-or-later",
    });
    expect(ffmpeg).not.toHaveProperty("publisher");
    expect(ffmpeg.files).toEqual([
      { path: fake, sha256: hashFile(fake), bytes: readFileSync(fake).length },
    ]);
    expect(ffmpeg.probe.version[0]).toBe(
      "ffmpeg version 7.1.1 Copyright (c) 2000-2026 the FFmpeg developers",
    );
    expect(ffmpeg.probe.license).toEqual(LICENCE_STATEMENTS["GPL-3.0-or-later"]);
    expect(lines.join("\n")).toContain("recorded, not expected");
  });

  it("refuses a path that is not an executable file", () => {
    const directory = temporaryDirectory("xplainer-fake-ffmpeg-");
    const plain = join(directory, "ffmpeg");
    writeFileSync(plain, "not a program\n");
    chmodSync(plain, 0o644);

    expect(() => recordFfmpegPath({ path: plain })).toThrow(/is not an executable file/);
    expect(() => recordFfmpegPath({ path: join(directory, "missing") })).toThrow(FfmpegRefusal);
  });

  it("refuses a libavcodec below the floor, a missing libx264 and an experimental aac", () => {
    const old = writeFakeFfmpeg(temporaryDirectory("xplainer-fake-ffmpeg-"), {
      libavcodec: "59.37.100",
    });
    expect(() => recordFfmpegPath({ path: old })).toThrow(/libavcodec 59\.37\.100/);

    const noX264 = writeFakeFfmpeg(temporaryDirectory("xplainer-fake-ffmpeg-"), {
      encoders: [" A....D aac                  AAC (Advanced Audio Coding)"],
    });
    expect(() => recordFfmpegPath({ path: noX264 })).toThrow(/lists no libx264 encoder/);

    const experimental = writeFakeFfmpeg(temporaryDirectory("xplainer-fake-ffmpeg-"), {
      encoders: [
        " V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10",
        " A..X.D aac                  AAC (Advanced Audio Coding)",
      ],
    });
    expect(() => recordFfmpegPath({ path: experimental })).toThrow(
      /lists no a non-experimental aac encoder/,
    );
  });

  it("refuses a binary whose -L and -buildconf disagree, and a nonfree one", () => {
    const split = writeFakeFfmpeg(temporaryDirectory("xplainer-fake-ffmpeg-"), {
      licence: "GPL-3.0-or-later",
      buildconfLicence: "GPL-2.0-or-later",
    });
    expect(() => recordFfmpegPath({ path: split })).toThrow(
      /states GPL-3\.0-or-later \(`-L`\) and was configured as GPL-2\.0-or-later/,
    );

    const nonfree = writeFakeFfmpeg(temporaryDirectory("xplainer-fake-ffmpeg-"), {
      licence: "nonfree",
    });
    let refusal: unknown;
    try {
      recordFfmpegPath({ path: nonfree });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(FfmpegRefusal);
    expect((refusal as FfmpegRefusal).reason).toBe("licence-disagrees");
    expect(ACCEPTED_FFMPEG_LICENCES).not.toContain("nonfree");
  });

  /** No shell and a budget per question: an ffmpeg that never answers costs the budget, not the run. */
  it("stops a binary that does not answer within its budget, by name", () => {
    const hangs = writeFakeFfmpeg(temporaryDirectory("xplainer-fake-ffmpeg-"), { hangs: true });
    const started = performance.now();

    // A budget a loaded machine's `/bin/sh` and `cat` answer well inside, and `sleep 30` does not.
    expect(() => recordFfmpegPath({ path: hangs, probeTimeoutMs: 2_000 })).toThrow(
      /did not answer `-buildconf` within 2000 ms and was stopped/,
    );
    expect(performance.now() - started).toBeLessThan(15_000);
  });
});

/**
 * The `.tar.xz` route, through the committed BtbN-layout fixture. Its `bin/ffmpeg` is not a program,
 * so this proves selection, the member digest and a probe refusal — each committing nothing — and
 * the zip route below proves a real binary landing.
 */
describe("a .tar.xz row", () => {
  let server: ArtefactServer;
  let row: RecordedFfmpegArtefact;

  beforeAll(async () => {
    const archive = readFileSync(XZ_FIXTURE);
    const out = mkdtempSync(join(tmpdir(), "xplainer-xz-member-"));
    try {
      await extractTar(
        XZ_FIXTURE,
        out,
        (header) => (header.name === "ffmpeg-fixture-linuxarm64-gpl/bin/ffmpeg" ? "ffmpeg" : null),
        { decompressor: "xz" },
      );
      const member = join(out, "ffmpeg");
      server = await startArtefactServer(archive);
      row = {
        status: "recorded",
        version: "n9.0.2-fixture",
        url: server.url(tarXzRoute(ARTEFACT_ROUTES.good)),
        sha256: sha256Of(archive),
        size: archive.length,
        member: "ffmpeg-fixture-linuxarm64-gpl/bin/ffmpeg",
        member_sha256: hashFile(member),
        member_size: readFileSync(member).length,
        licence: "GPL-3.0-or-later",
        licence_member: "ffmpeg-fixture-linuxarm64-gpl/LICENSE.txt",
        publisher: "BtbN FFmpeg-Builds",
      };
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await server.close();
  });

  it("refuses a binary that is not the row's member, committing nothing", async () => {
    const toolchainDir = temporaryDirectory("xplainer-ffmpeg-toolchain-");
    const wrong = { ...row, member_sha256: "0".repeat(64) };

    const refusal = acquireFfmpeg({ manifest: withRow(wrong), toolchainDir });

    await expect(refusal).rejects.toMatchObject({ reason: "member-mismatch" });
    await expect(refusal).rejects.toThrow(/bin\/ffmpeg in .* hashing to [0-9a-f]{64}/);
    expect(listing(toolchainDir).filter((name) => name !== ".setup")).toEqual([]);
  });

  /**
   * Every kept member lands at its base name beside the binary, next to the two files this
   * provider writes itself. A row whose member would land on `PROVENANCE.txt` or `.acquired.json`
   * — in any case, for APFS and NTFS — or on another kept member is refused before any request.
   */
  it("refuses a row whose kept members collide on one name, before anything is fetched", async () => {
    const toolchainDir = temporaryDirectory("xplainer-ffmpeg-toolchain-");
    const before = server.requests.length;
    const colliding: Partial<RecordedFfmpegArtefact>[] = [
      { licence_member: "ffmpeg-fixture-linuxarm64-gpl/PROVENANCE.txt" },
      { licence_member: "ffmpeg-fixture-linuxarm64-gpl/doc/provenance.TXT" },
      { extra_members: ["ffmpeg-fixture-linuxarm64-gpl/.acquired.json"] },
      { extra_members: ["ffmpeg-fixture-linuxarm64-gpl/bin/LICENSE.txt"] },
    ];

    for (const overrides of colliding) {
      await expect(
        acquireFfmpeg({ manifest: withRow({ ...row, ...overrides }), toolchainDir }),
      ).rejects.toMatchObject({ reason: "member-collision" });
    }
    expect(server.requests.length).toBe(before);
    expect(listing(toolchainDir)).toEqual([]);
  });

  it("takes the right member and refuses it when it does not answer the probe", async () => {
    const toolchainDir = temporaryDirectory("xplainer-ffmpeg-toolchain-");

    await expect(acquireFfmpeg({ manifest: withRow(row), toolchainDir })).rejects.toMatchObject({
      reason: "probe-failed",
    });
    expect(listing(toolchainDir).filter((name) => name !== ".setup")).toEqual([]);
  });
});

// A real ffmpeg, so the same switch as the render test: CI installs one and never sets it.
describe.skipIf(process.env.XPLAINER_SKIP_RENDER_TEST === "1")(
  "acquireFfmpeg, over the loopback server, with a real ffmpeg packed into a zip (AC-A4)",
  () => {
    const ROOT = "ffmpeg-test-build";
    const LICENCE_TEXT = "the licence texts this build is distributed under\n";
    let server: ArtefactServer;
    let archive: Buffer;
    let binary: Buffer;
    let realLicence: string;
    let realVersion: string;

    beforeAll(async () => {
      const real = findTestFfmpeg();
      if (real === null) {
        throw new Error(
          "no ffmpeg on this machine: install one, point XPLAINER_FFMPEG at one, or set " +
            "XPLAINER_SKIP_RENDER_TEST=1",
        );
      }
      const probed = probeFfmpeg(real);
      realLicence = licenceFromStatement(probed.probe.license) ?? "";
      realVersion = probed.version;
      expect(ACCEPTED_FFMPEG_LICENCES).toContain(realLicence);
      binary = readFileSync(real);
      archive = buildZip([
        { name: `${ROOT}/ffmpeg`, contents: binary, mode: 0o755 },
        { name: `${ROOT}/LICENSE`, contents: LICENCE_TEXT },
        { name: `${ROOT}/SOURCE.txt`, contents: "where the source is\n" },
        { name: `${ROOT}/BUILDINFO.txt`, contents: "how it was built\n" },
        // In the archive and in no row: it must not land.
        { name: `${ROOT}/ffprobe`, contents: "a second program setup never keeps\n", mode: 0o755 },
      ]);
      server = await startArtefactServer(archive);
    });

    afterAll(async () => {
      await server?.close();
    });

    /** A row for the real binary inside the zip, served from `route`. */
    function realRow(
      route: string = ARTEFACT_ROUTES.good,
      overrides: Partial<RecordedFfmpegArtefact> = {},
    ): RecordedFfmpegArtefact {
      return {
        status: "recorded",
        version: "9.0.2-test",
        url: server.url(route),
        sha256: sha256Of(archive),
        size: archive.length,
        member: `${ROOT}/ffmpeg`,
        member_sha256: sha256Of(binary),
        member_size: binary.length,
        licence: realLicence,
        licence_member: `${ROOT}/LICENSE`,
        extra_members: [`${ROOT}/SOURCE.txt`, `${ROOT}/BUILDINFO.txt`],
        source_url: "https://cdn.xplainer.video/toolchain/v1/ffmpeg/9.0.2/source/README.txt",
        publisher: "xplainer.video",
        ...overrides,
      };
    }

    it("says who built it before the first request, then lands the binary, its licence and its provenance", async () => {
      const toolchainDir = temporaryDirectory("xplainer-ffmpeg-toolchain-");
      const manifest = withRow(realRow());
      const before = server.requests.length;
      const lines: { line: string; requestsSoFar: number }[] = [];

      const acquired = await acquireFfmpeg({
        manifest,
        toolchainDir,
        log: (line) => lines.push({ line, requestsSoFar: server.requests.length - before }),
        now: () => new Date("2026-11-12T08:00:00.000Z"),
      });

      // Ordering: the sentence is the first line, and the server had seen nothing when it was said.
      const selection = selectFfmpegArtefact(manifest, probeHost());
      expect(lines[0]).toEqual({ line: ffmpegSentence(selection), requestsSoFar: 0 });
      expect(lines[0]?.line).toContain("built and published by xplainer.video");
      expect(server.requests.length - before).toBeGreaterThan(0);

      // What landed: four kept files and two this provider wrote, under the digest-named directory.
      expect(acquired.fetched).toBe(true);
      expect(acquired.destination).toBe(ffmpegDestination(toolchainDir, selection));
      expect(listing(acquired.destination)).toEqual(
        [ACQUIRED_FILE, "BUILDINFO.txt", "LICENSE", PROVENANCE_FILE, "SOURCE.txt", "ffmpeg"].sort(),
      );
      const executable = join(acquired.destination, "ffmpeg");
      expect(hashFile(executable)).toBe(sha256Of(binary));
      expect(readFileSync(join(acquired.destination, "LICENSE"), "utf8")).toBe(LICENCE_TEXT);
      const provenance = readFileSync(join(acquired.destination, PROVENANCE_FILE), "utf8");
      for (const fact of [
        selection.url,
        selection.sha256,
        "publisher:  xplainer.video",
        `licence:    ${realLicence}`,
        "version:    9.0.2-test",
        "source:     https://cdn.xplainer.video/toolchain/v1/ffmpeg/9.0.2/source/README.txt",
        "acquired:   2026-11-12T08:00:00.000Z",
      ]) {
        expect(provenance).toContain(fact);
      }
      expect(readAcquired(acquired.destination)?.files.map((file) => file.path)).toEqual([
        "ffmpeg",
        "LICENSE",
        "SOURCE.txt",
        "BUILDINFO.txt",
        PROVENANCE_FILE,
      ]);

      // The marker's component: the archive's reviewed digest, the executable first at the
      // member's, and a probe that is the real binary's own answer.
      const component = acquired.component;
      expect(component).toMatchObject({
        path: executable,
        sha256: selection.sha256,
        provider: FFMPEG_MANIFEST_PROVIDER,
        licence: realLicence,
        publisher: "xplainer.video",
        source_url: "https://cdn.xplainer.video/toolchain/v1/ffmpeg/9.0.2/source/README.txt",
        version: realVersion,
      });
      expect(component.files[0]).toEqual({
        path: executable,
        sha256: sha256Of(binary),
        bytes: binary.length,
      });
      expect(
        component.files.map((file) => file.path.slice(acquired.destination.length + 1)),
      ).toEqual(["ffmpeg", "LICENSE", "SOURCE.txt", "BUILDINFO.txt", PROVENANCE_FILE]);
      const fresh = probeFfmpeg(executable);
      expect(component.probe).toEqual(fresh.probe);
      expect(component.libavcodec).toBe(fresh.libavcodec);
      expect(component.probe.version[0]).toMatch(/^ffmpeg version /);
      expect(component.probe.license.length).toBeGreaterThan(0);
      expect(component.probe.buildconf.join("\n")).toContain("--enable-gpl");
    });

    it("re-verifies a warm tree instead of fetching it, and refuses one that has changed", async () => {
      const toolchainDir = temporaryDirectory("xplainer-ffmpeg-toolchain-");
      const manifest = withRow(realRow());
      const first = await acquireFfmpeg({ manifest, toolchainDir });
      const before = server.requests.length;

      const second = await acquireFfmpeg({ manifest, toolchainDir });

      expect(second.fetched).toBe(false);
      expect(server.requests.length).toBe(before);
      expect(second.component.files).toEqual(first.component.files);
      expect(second.component.probe).toEqual(first.component.probe);

      writeFileSync(join(first.destination, "LICENSE"), "edited after it was acquired\n");
      await expect(acquireFfmpeg({ manifest, toolchainDir })).rejects.toMatchObject({
        reason: "cache-unverified",
      });
    });

    it("refuses a wrong archive as checksum-mismatch, committing nothing", async () => {
      const toolchainDir = temporaryDirectory("xplainer-ffmpeg-toolchain-");

      const refusal = acquireFfmpeg({
        manifest: withRow(realRow(ARTEFACT_ROUTES.corrupt)),
        toolchainDir,
      });

      await expect(refusal).rejects.toBeInstanceOf(DownloadRefusal);
      await expect(refusal).rejects.toMatchObject({ reason: "checksum-mismatch" });
      expect(listing(toolchainDir).filter((name) => name !== ".setup")).toEqual([]);
    });

    it("refuses a right archive whose binary is not the row's member, committing nothing", async () => {
      const toolchainDir = temporaryDirectory("xplainer-ffmpeg-toolchain-");

      const refusal = acquireFfmpeg({
        manifest: withRow(realRow(ARTEFACT_ROUTES.good, { member_sha256: "f".repeat(64) })),
        toolchainDir,
      });

      await expect(refusal).rejects.toMatchObject({ reason: "member-mismatch" });
      await expect(refusal).rejects.toThrow(/the binary inside it is not/);
      expect(listing(toolchainDir).filter((name) => name !== ".setup")).toEqual([]);
    });

    it("refuses a row whose licence the binary's own -buildconf and -L contradict, committing nothing", async () => {
      const toolchainDir = temporaryDirectory("xplainer-ffmpeg-toolchain-");
      const other = ACCEPTED_FFMPEG_LICENCES.find((licence) => licence !== realLicence) ?? "";

      const refusal = acquireFfmpeg({
        manifest: withRow(realRow(ARTEFACT_ROUTES.good, { licence: other })),
        toolchainDir,
      });

      await expect(refusal).rejects.toMatchObject({ reason: "licence-disagrees" });
      await expect(refusal).rejects.toThrow(
        new RegExp(
          `declares ${other.replace(/[.+]/g, "\\$&")} and .* states ${realLicence.replace(/[.+]/g, "\\$&")}`,
        ),
      );
      expect(listing(toolchainDir).filter((name) => name !== ".setup")).toEqual([]);
    });
  },
);
