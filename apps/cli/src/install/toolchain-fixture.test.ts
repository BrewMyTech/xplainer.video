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
 * two stand-ins beside it are what those digests describe — so a stand-in edited without the marker
 * being updated fails here rather than being discovered as a puzzle inside an install test.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

  it("points at two stand-ins that exist and hash to the digests it records", () => {
    const stateDir = stateDirectory();

    const marker = writeToolchainMarker(stateDir);

    for (const component of [marker.chrome, marker.speech]) {
      expect(existsSync(component.path)).toBe(true);
      expect(createHash("sha256").update(readFileSync(component.path)).digest("hex")).toBe(
        component.sha256,
      );
    }
    // The copies live under the state directory, which is what lets a refusal test remove one
    // without reaching into the repository.
    expect(marker.chrome.path.startsWith(stateDir)).toBe(true);
    expect(marker.speech.path.startsWith(stateDir)).toBe(true);
  });

  it("is labelled a fixture by where it lives and by every version string in it", () => {
    const fixture = readToolchainFixture();

    expect(TOOLCHAIN_FIXTURE_FILE).toContain("__fixtures__");
    expect(fixture.chrome.version).toContain("fixture");
    expect(fixture.speech.version).toContain("fixture");
    expect(fixture.workspace.version).toContain("fixture");
  });
});
