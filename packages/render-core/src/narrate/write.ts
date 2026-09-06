/**
 * The three files a narration run leaves behind (`narrate.py:287-298`) —
 * roadmap P1-2, docs/ROADMAP.md.
 *
 * They are written into the video's public directory, which is what Remotion
 * serves `staticFile()` from and what `preflight()` reads before a render. The
 * writers are separate from the builders so a caller can build the documents,
 * inspect or validate them, and only then commit them to disk.
 *
 * JSON is written with the reference implementation's two-space indent, plus a
 * trailing newline so the files behave in a terminal and in a diff.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Captions, Timings } from "@xplainer/protocol";
import { CAPTIONS_FILE, TIMINGS_FILE } from "./pacing.js";
import { encodeWav, type WavAudio } from "./wav.js";

/** Serialise one document the way both files are written. */
function toJsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Write `timings.json` into `outDir`, creating the directory if needed.
 *
 * @returns the path written
 */
export function writeTimings(outDir: string, timings: Timings): string {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, TIMINGS_FILE);
  writeFileSync(path, toJsonText(timings));
  return path;
}

/**
 * Write `captions.json` into `outDir`, creating the directory if needed.
 *
 * @returns the path written
 */
export function writeCaptions(outDir: string, captions: Captions): string {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, CAPTIONS_FILE);
  writeFileSync(path, toJsonText(captions));
  return path;
}

/**
 * Write the narration track into `outDir` under `audioFile`, creating the
 * directory if needed.
 *
 * @returns the path written
 */
export function writeNarrationTrack(outDir: string, audioFile: string, track: WavAudio): string {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, audioFile);
  writeFileSync(path, encodeWav(track));
  return path;
}
