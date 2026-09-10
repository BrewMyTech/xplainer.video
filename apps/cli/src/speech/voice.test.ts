import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readVoicePack, STYLE_DIMENSION, styleRow } from "./voice.js";

const directories: string[] = [];

/** A pack of `rows` rows whose every value is its own row number, so a row is identifiable. */
function writePack(rows: number): string {
  const directory = mkdtempSync(join(tmpdir(), "xplainer-voice-"));
  directories.push(directory);
  const path = join(directory, "af_heart.bin");
  const floats = new Float32Array(rows * STYLE_DIMENSION);
  for (let row = 0; row < rows; row += 1) {
    floats.fill(row, row * STYLE_DIMENSION, (row + 1) * STYLE_DIMENSION);
  }
  writeFileSync(path, Buffer.from(floats.buffer));
  return path;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("readVoicePack", () => {
  it("reads a whole number of style rows", () => {
    const pack = readVoicePack(writePack(510), "af_heart");

    expect(pack.rowCount).toBe(510);
    expect(pack.voice).toBe("af_heart");
    expect(pack.rows).toHaveLength(510 * STYLE_DIMENSION);
  });

  it("refuses a pack that is not whole rows rather than reading a short one as a style", () => {
    const directory = mkdtempSync(join(tmpdir(), "xplainer-voice-"));
    directories.push(directory);
    const path = join(directory, "af_heart.bin");
    writeFileSync(path, Buffer.alloc(STYLE_DIMENSION * 4 + 8));

    expect(() => readVoicePack(path, "af_heart")).toThrow(/not a whole number of 256-float/);
  });

  it("refuses an empty pack", () => {
    const directory = mkdtempSync(join(tmpdir(), "xplainer-voice-"));
    directories.push(directory);
    const path = join(directory, "af_heart.bin");
    writeFileSync(path, Buffer.alloc(0));

    expect(() => readVoicePack(path, "af_heart")).toThrow(/not a whole number/);
  });

  it("names the path and the repair when there is no pack", () => {
    expect(() => readVoicePack(join(tmpdir(), "no-such-voice.bin"), "af_heart")).toThrow(
      /no voice pack at .*xplainer setup/s,
    );
  });
});

describe("styleRow", () => {
  const pack = readVoicePack(writePack(510), "af_heart");

  it("selects row `tokenCount - 1`, which is what Kokoro's own Python selects", () => {
    // Measured 2026-09-10: row 0 for every sentence — what the S0b prototype did — speaks a
    // 112-token sentence in 4.83 s where the reference implementation takes 6.95 s, a 30% error
    // that is inaudible without a side-by-side. See voice.ts's docblock for the table.
    expect(styleRow(pack, 43)[0]).toBe(42);
    expect(styleRow(pack, 1)[0]).toBe(0);
  });

  it("returns exactly one row's worth of floats", () => {
    expect(styleRow(pack, 43)).toHaveLength(STYLE_DIMENSION);
  });

  it("clamps at both ends rather than failing a job over a very short or very long segment", () => {
    expect(styleRow(pack, 0)[0]).toBe(0);
    expect(styleRow(pack, 5000)[0]).toBe(509);
  });
});
