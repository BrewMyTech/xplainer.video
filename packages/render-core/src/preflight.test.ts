/**
 * Behavioural proof for the render preflight (ADR 0018, layer 4).
 *
 * The bug this guards is a render that succeeds and ships something wrong: no
 * narration, no captions, or a zero-byte audio track produce a perfectly valid
 * MP4 that nobody can hear. Every test below asserts the refusal, and the
 * `assertRenderable` cases assert it as a throw, because a checker whose result
 * a caller can forget to read is not a gate.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertRenderable,
  type PreflightCode,
  PreflightError,
  type PreflightProblem,
  preflight,
} from "./preflight.js";
import { SCAFFOLD_FILES, scaffoldVideo } from "./scaffold/index.js";

const tempDirs: string[] = [];

type WorkspaceOptions = {
  /** Omit `timings.json`. */
  noTimings?: boolean;
  /** Omit `captions.json`. */
  noCaptions?: boolean;
  /** Write `captions.json` as `[]`. */
  emptyCaptions?: boolean;
  /** Omit the audio file `timings.json` names. */
  noAudio?: boolean;
  /** Write the audio file with zero bytes. */
  emptyAudio?: boolean;
  /** Write unparseable bytes into `timings.json`. */
  corruptTimings?: boolean;
  /** Write unparseable bytes into `captions.json`. */
  corruptCaptions?: boolean;
  /** Skip `scaffoldVideo()`, leaving the source directory bare. */
  noScaffold?: boolean;
};

/** A fully narrated, fully scaffolded video, minus whatever the options remove. */
function workspace(options: WorkspaceOptions = {}): { videoDir: string; publicDir: string } {
  const root = mkdtempSync(join(tmpdir(), "xplainer-preflight-"));
  tempDirs.push(root);

  const videoDir = join(root, "videos", "demo");
  const publicDir = join(root, "public", "demo");
  mkdirSync(videoDir, { recursive: true });
  mkdirSync(join(publicDir, "media"), { recursive: true });

  if (!options.noScaffold) scaffoldVideo(videoDir);

  if (options.corruptTimings) {
    writeFileSync(join(publicDir, "timings.json"), "{ not json");
  } else if (!options.noTimings) {
    writeFileSync(
      join(publicDir, "timings.json"),
      JSON.stringify({
        fps: 30,
        durationInFrames: 300,
        totalMs: 10000,
        audio: "media/narration.mp3",
        segments: [
          { id: "symptom", index: 0, startMs: 0, endMs: 10000, from: 0, durationInFrames: 300 },
        ],
      }),
    );
  }

  if (options.corruptCaptions) {
    writeFileSync(join(publicDir, "captions.json"), "nope");
  } else if (!options.noCaptions) {
    const captions = options.emptyCaptions
      ? []
      : [{ text: "hello", startMs: 0, endMs: 500, timestampMs: 250, confidence: null }];
    writeFileSync(join(publicDir, "captions.json"), JSON.stringify(captions));
  }

  if (!options.noAudio) {
    writeFileSync(join(publicDir, "media", "narration.mp3"), options.emptyAudio ? "" : "ID3fake");
  }

  return { videoDir, publicDir };
}

const codes = (problems: PreflightProblem[]): PreflightCode[] => problems.map((p) => p.code);

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("preflight", () => {
  it("passes a narrated, scaffolded video", () => {
    const { videoDir, publicDir } = workspace();
    expect(preflight(videoDir, publicDir)).toEqual([]);
  });

  it("reports a video that was never narrated", () => {
    const { videoDir, publicDir } = workspace({ noTimings: true, noCaptions: true, noAudio: true });

    const problems = preflight(videoDir, publicDir);

    expect(codes(problems)).toEqual(["NARRATION_MISSING", "CAPTIONS_MISSING"]);
    expect(problems[0]?.message).toContain("timings.json");
    expect(problems[0]?.message).toContain("explainer_narrate");
    expect(problems.every((p) => p.severity === "error")).toBe(true);
  });

  it("reports missing captions on their own", () => {
    const { videoDir, publicDir } = workspace({ noCaptions: true });
    expect(codes(preflight(videoDir, publicDir))).toEqual(["CAPTIONS_MISSING"]);
  });

  it("reports a caption file that parses to an empty array", () => {
    const { videoDir, publicDir } = workspace({ emptyCaptions: true });

    const problems = preflight(videoDir, publicDir);

    expect(codes(problems)).toEqual(["CAPTIONS_EMPTY"]);
    expect(problems[0]?.message).toContain("no caption track");
  });

  it("reports narration whose audio file is absent", () => {
    const { videoDir, publicDir } = workspace({ noAudio: true });

    const problems = preflight(videoDir, publicDir);

    expect(codes(problems)).toEqual(["AUDIO_MISSING"]);
    expect(problems[0]?.message).toContain("silent");
  });

  it("reports narration whose audio file is zero bytes", () => {
    const { videoDir, publicDir } = workspace({ emptyAudio: true });

    const problems = preflight(videoDir, publicDir);

    expect(codes(problems)).toEqual(["AUDIO_EMPTY"]);
    expect(problems[0]?.message).toContain("silent");
  });

  it("reports a video with no Scenes.tsx", () => {
    const { videoDir, publicDir } = workspace({ noScaffold: true });

    const problems = preflight(videoDir, publicDir);

    expect(problems.some((p) => p.code === "SCENES_MISSING")).toBe(true);
  });

  it("warns, without blocking, when an engine-owned file has been altered", () => {
    const { videoDir, publicDir } = workspace();
    writeFileSync(join(videoDir, "Video.tsx"), "// audio? never heard of her\n");

    const problems = preflight(videoDir, publicDir);

    expect(codes(problems)).toEqual(["ENGINE_FILE_ALTERED"]);
    expect(problems[0]?.severity).toBe("warning");
    expect(problems[0]?.message).toContain("engine-owned");
    expect(problems[0]?.message).toContain("Scenes.tsx");
  });

  it("does not mind the agent's own files, at any depth", () => {
    const { videoDir, publicDir } = workspace();
    mkdirSync(join(videoDir, "scenes"), { recursive: true });
    writeFileSync(join(videoDir, "scenes", "Root.tsx"), "export const Root = () => null;\n");
    writeFileSync(join(videoDir, "lib.ts"), "export const two = 2;\n");
    writeFileSync(join(videoDir, "Scenes.tsx"), "export const scenes = {};\n");

    expect(preflight(videoDir, publicDir)).toEqual([]);
  });

  it("reports rather than throws on unparseable JSON", () => {
    const { videoDir, publicDir } = workspace({ corruptTimings: true, corruptCaptions: true });

    const problems = preflight(videoDir, publicDir);

    expect(codes(problems)).toEqual(["NARRATION_UNREADABLE", "CAPTIONS_UNREADABLE"]);
  });

  it("writes nothing: a checker that repaired the workspace would be a surprise", () => {
    const { videoDir, publicDir } = workspace();
    writeFileSync(join(videoDir, "Video.tsx"), "// tampered\n");

    preflight(videoDir, publicDir);

    expect(readFileSync(join(videoDir, "Video.tsx"), "utf8")).toBe("// tampered\n");
  });
});

describe("assertRenderable", () => {
  it("throws rather than letting a never-narrated video render to a silent file", () => {
    const { videoDir, publicDir } = workspace({ noTimings: true, noCaptions: true, noAudio: true });

    expect(() => assertRenderable(videoDir, publicDir)).toThrow(PreflightError);
    try {
      assertRenderable(videoDir, publicDir);
      expect.unreachable("assertRenderable must refuse a video with no narration");
    } catch (error) {
      expect(error).toBeInstanceOf(PreflightError);
      const preflightError = error as PreflightError;
      expect(preflightError.code).toBe("PREFLIGHT_FAILED");
      expect(codes([...preflightError.problems])).toEqual([
        "NARRATION_MISSING",
        "CAPTIONS_MISSING",
      ]);
      expect(preflightError.message).toContain("explainer_narrate");
    }
  });

  it("throws on a zero-byte audio track, the case a render would happily encode", () => {
    const { videoDir, publicDir } = workspace({ emptyAudio: true });

    expect(() => assertRenderable(videoDir, publicDir)).toThrow(/silent/);
  });

  it("throws on empty captions", () => {
    const { videoDir, publicDir } = workspace({ emptyCaptions: true });

    expect(() => assertRenderable(videoDir, publicDir)).toThrow(/caption/);
  });

  it("reports every blocking problem at once, so one retry can fix them all", () => {
    const { videoDir, publicDir } = workspace({
      noTimings: true,
      emptyCaptions: true,
      noScaffold: true,
    });

    try {
      assertRenderable(videoDir, publicDir);
      expect.unreachable("assertRenderable must refuse this video");
    } catch (error) {
      const problems = [...(error as PreflightError).problems];
      expect(codes(problems)).toEqual(["NARRATION_MISSING", "CAPTIONS_EMPTY", "SCENES_MISSING"]);
    }
  });

  it("returns the warnings, and does not block, when only an engine file drifted", () => {
    const { videoDir, publicDir } = workspace();
    writeFileSync(join(videoDir, "Video.tsx"), "// tampered\n");

    const warnings = assertRenderable(videoDir, publicDir);

    expect(codes(warnings)).toEqual(["ENGINE_FILE_ALTERED"]);
  });

  it("returns nothing to warn about for a healthy video", () => {
    const { videoDir, publicDir } = workspace();

    expect(assertRenderable(videoDir, publicDir)).toEqual([]);
    // ...and that healthy video is the six-file scaffold.
    expect(SCAFFOLD_FILES).toHaveLength(6);
  });
});
