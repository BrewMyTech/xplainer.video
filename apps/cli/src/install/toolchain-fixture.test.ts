/**
 * The synthetic setup marker, checked against the schema that owns its shape.
 *
 * `install` refuses without a `toolchain.json` and `xplainer setup` is two batches away, so this
 * story ships a fixture — and a fixture that quietly stops matching its schema is worse than none,
 * because every install test would then be proving that a document nothing accepts is accepted.
 * So the fixture is validated **against `packages/protocol/schemas/toolchain.json` itself**, read
 * through the package's own `exports` map rather than by walking up the tree: the schema is the
 * contract, and a copy of it here would be a second one.
 *
 * Ajv rather than a hand-written check, and the same Ajv the protocol package's own suite uses
 * (`strict: true`, `allErrors`, `ajv-formats` for `date-time`): a validator written here would
 * agree with the schema only until one of them changed.
 *
 * The digests are checked too. The marker records a `sha256` for each acquired component, and the
 * stand-ins beside it are what those digests describe — so a stand-in edited without the marker
 * being updated fails here rather than being discovered as a puzzle inside an install test.
 *
 * **And the shape on the other side of the cut is checked against the same schema.** A version-1
 * marker — a `workspace`, no `ffmpeg` — is what every machine set up before ADR 0031's cut holds,
 * and this build reads it; a schema that stopped accepting it would make that a claim about a
 * document the contract calls invalid.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Toolchain } from "@xplainer/protocol";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterEach, describe, expect, it } from "vitest";
import { TOOLCHAIN_FORMAT_VERSION, toolchainMarkerPath } from "./preflight.js";
import {
  readToolchainFixture,
  resolvedToolchainFixture,
  TOOLCHAIN_FIXTURE_FILE,
  writeToolchainMarker,
} from "./testing/toolchain.js";

const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function stateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "xplainer-toolchain-"));
  scratch.push(directory);
  return directory;
}

/** The published schema, resolved through `@xplainer/protocol`'s own `exports` map. */
function toolchainValidator(): ValidateFunction {
  const require = createRequire(import.meta.url);
  const schemaFile = require.resolve("@xplainer/protocol/schemas/toolchain.json");
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv.compile(JSON.parse(readFileSync(schemaFile, "utf8")) as object);
}

describe("the synthetic toolchain marker", () => {
  it("validates against packages/protocol/schemas/toolchain.json as committed", () => {
    const validate = toolchainValidator();

    expect(validate(readToolchainFixture()), JSON.stringify(validate.errors)).toBe(true);
  });

  it("still validates once its two paths have been resolved and it has been materialised", () => {
    const validate = toolchainValidator();
    const stateDir = stateDirectory();

    const marker = writeToolchainMarker(stateDir);

    expect(validate(marker), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(resolvedToolchainFixture()), JSON.stringify(validate.errors)).toBe(true);
    // The written file is what an install reads, so it is read back rather than trusted.
    const onDisk = JSON.parse(readFileSync(toolchainMarkerPath(stateDir), "utf8")) as Toolchain;
    expect(validate(onDisk), JSON.stringify(validate.errors)).toBe(true);
    expect(onDisk).toEqual(marker);
    expect(onDisk.format_version).toBe(TOOLCHAIN_FORMAT_VERSION);
  });

  it("points at stand-ins that exist and hash to the digests it records", () => {
    const stateDir = stateDirectory();

    const marker = writeToolchainMarker(stateDir);
    const ffmpeg = marker.ffmpeg;

    expect(ffmpeg).toBeDefined();
    for (const component of [
      marker.chrome,
      marker.speech,
      ...(ffmpeg === undefined ? [] : [ffmpeg]),
    ]) {
      expect(existsSync(component.path)).toBe(true);
      expect(createHash("sha256").update(readFileSync(component.path)).digest("hex")).toBe(
        component.sha256,
      );
    }
    // The ffmpeg's executable is `files[0]`, at the same path, with its real length: the size is
    // what the daemon's gate stats, so a recorded length that drifted would be a fixture that reads
    // as a replaced binary.
    expect(ffmpeg?.files[0].path).toBe(ffmpeg?.path);
    expect(ffmpeg?.files[0].bytes).toBe(statSync(ffmpeg?.path ?? "").size);
    // The copies live under the state directory, which is what lets a refusal test remove one
    // without reaching into the repository.
    expect(marker.chrome.path.startsWith(stateDir)).toBe(true);
    expect(marker.speech.path.startsWith(stateDir)).toBe(true);
    expect(ffmpeg?.path.startsWith(stateDir)).toBe(true);
  });

  it("is labelled a fixture by where it lives and by every version string in it", () => {
    const fixture = readToolchainFixture();

    expect(TOOLCHAIN_FIXTURE_FILE).toContain("__fixtures__");
    expect(fixture.chrome.version).toContain("fixture");
    expect(fixture.speech.version).toContain("fixture");
    expect(fixture.ffmpeg?.version).toContain("fixture");
  });

  it("is the version-2 shape, with no workspace", () => {
    const fixture = readToolchainFixture();

    expect(fixture.format_version).toBe(2);
    expect(fixture).not.toHaveProperty("workspace");
  });
});

describe("the toolchain schema across the cut", () => {
  it("still validates a version-1 marker: a workspace and no ffmpeg", () => {
    const validate = toolchainValidator();
    const { ffmpeg: _dropped, ...rest } = readToolchainFixture();
    const versionOne = {
      ...rest,
      format_version: 1,
      workspace: { platform: "darwin-arm64", version: "0.0.0-fixture" },
    };

    expect(validate(versionOne), JSON.stringify(validate.errors)).toBe(true);
  });

  it("validates a version-2 marker with no ffmpeg, because the gate and not the schema needs one", () => {
    const validate = toolchainValidator();
    const { ffmpeg: _dropped, ...versionTwo } = readToolchainFixture();

    expect(validate(versionTwo), JSON.stringify(validate.errors)).toBe(true);
  });

  /** AC-A2: `additionalProperties: false`, `files` with at least one entry, and the probe's three. */
  it("refuses an ffmpeg with no files, an unknown field, or a probe missing a transcript", () => {
    const validate = toolchainValidator();
    const fixture = readToolchainFixture();
    const ffmpeg = fixture.ffmpeg;
    expect(ffmpeg).toBeDefined();
    if (ffmpeg === undefined) {
      return;
    }
    const { license: _license, ...probe } = ffmpeg.probe;
    const { licence: _licence, ...unlicensed } = ffmpeg;

    for (const broken of [
      { ...ffmpeg, files: [] },
      { ...ffmpeg, found_at: "/usr/bin" },
      { ...ffmpeg, probe },
      unlicensed,
      { ...ffmpeg, libavcodec: "62" },
    ]) {
      expect(validate({ ...fixture, ffmpeg: broken }), JSON.stringify(broken)).toBe(false);
    }
  });
});
