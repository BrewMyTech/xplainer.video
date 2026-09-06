/**
 * Behavioural proof for the scaffold generator (acceptance criteria AC-7b..AC-7e).
 *
 * Every comparison uses `Buffer.compare`, never normalised string equality: a
 * trailing-newline or CRLF difference is a real difference and must fail here
 * rather than surface as a broken Remotion build later.
 *
 * The goldens do not all mean the same thing, and the tests below are split so
 * that the difference stays visible:
 *
 *   * `index.ts`, `types.ts`, `Root.tsx`, `Captions.tsx` are PROVENANCE
 *     fixtures. They were extracted from `_SCAFFOLD` in the reference
 *     implementation and assert "these are still max's bytes".
 *   * `Video.tsx` and `Scenes.tsx` are xplainer-authored CHANGE DETECTORS.
 *     They can only assert "these are still the reviewed bytes": editing a
 *     template without updating its fixture in the same commit fails here.
 *     AC-7d carries the guarantee a regenerated golden cannot.
 *
 * See `test/fixtures/README.md`.
 */

import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_OWNED_FILES as PROTOCOL_ENGINE_OWNED_FILES } from "@xplainer/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_OWNED_FILES,
  ENGINE_OWNED_FILES,
  isEngineOwned,
  SCAFFOLD_FILES,
  type ScaffoldFile,
  scaffoldVideo,
} from "./index.js";

const FIXTURE_DIR = fileURLToPath(new URL("../../test/fixtures/scaffold/", import.meta.url));

const golden = (name: ScaffoldFile): Buffer => readFileSync(join(FIXTURE_DIR, `${name}.golden`));

/** Max's original agent-owned `Video.tsx`, retained for the divergence test (AC-7d). */
const upstreamVideo = (): Buffer => readFileSync(join(FIXTURE_DIR, "upstream", "Video.tsx.max"));

/** The four files inherited byte-for-byte from the reference implementation (AC-7b). */
const INHERITED_FILES = ["index.ts", "types.ts", "Root.tsx", "Captions.tsx"] as const;

const tempDirs: string[] = [];

function freshVideoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "xplainer-scaffold-"));
  tempDirs.push(dir);
  return join(dir, "videos", "demo");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("the scaffold's ownership split", () => {
  // The list this generator restores from and the list the schema and the MCP
  // guard reject against must be one list, not three that agree today. Identity
  // rather than deep equality, so a local copy pasted back in fails here.
  it("takes the engine-owned set from the protocol contract rather than restating it", () => {
    expect(ENGINE_OWNED_FILES).toBe(PROTOCOL_ENGINE_OWNED_FILES);
  });

  it("reserves exactly the five engine-owned names and nothing nested under them", () => {
    expect([...ENGINE_OWNED_FILES]).toEqual([
      "index.ts",
      "types.ts",
      "Root.tsx",
      "Captions.tsx",
      "Video.tsx",
    ]);
    expect([...AGENT_OWNED_FILES]).toEqual(["Scenes.tsx"]);
    expect([...SCAFFOLD_FILES]).toEqual([...ENGINE_OWNED_FILES, ...AGENT_OWNED_FILES]);

    // Reservation is by exact relative path: the agent's own scenes/ directory
    // may hold a file of any name, including one the engine reserves at the top.
    expect(isEngineOwned("Root.tsx")).toBe(true);
    expect(isEngineOwned("scenes/Root.tsx")).toBe(false);
    expect(isEngineOwned("Scenes.tsx")).toBe(false);
  });
});

describe("scaffoldVideo", () => {
  it("writes all six files, each byte-identical to its golden", () => {
    const dir = freshVideoDir();

    const result = scaffoldVideo(dir);

    expect(result.created).toEqual([...SCAFFOLD_FILES]);
    expect(result.skipped).toEqual([]);
    expect(result.restored).toEqual([]);

    for (const name of SCAFFOLD_FILES) {
      const actual = readFileSync(join(dir, name));
      expect(
        Buffer.compare(actual, golden(name)),
        `${name} differs from test/fixtures/scaffold/${name}.golden`,
      ).toBe(0);
    }
  });

  // AC-7b. This is the assertion that carries provenance, and it covers only
  // the four files xplainer inherited unchanged.
  it("produces the four inherited wiring files byte-identically to max's scaffold", () => {
    const dir = freshVideoDir();

    scaffoldVideo(dir);

    for (const name of INHERITED_FILES) {
      expect(
        Buffer.compare(readFileSync(join(dir, name)), golden(name)),
        `${name} is an inherited file and must still match max's bytes`,
      ).toBe(0);
    }
    expect(readFileSync(join(dir, "index.ts"), "utf8")).toContain('import "../../tailwind.css";');
  });

  // AC-7c, first half: the reference implementation's never-overwrite rule,
  // now scoped to the file the agent actually owns.
  it("never overwrites the agent-owned Scenes.tsx", () => {
    const dir = freshVideoDir();
    scaffoldVideo(dir);

    const mine = Buffer.from(
      "// my own scenes, do not clobber\nexport const scenes = {};\n",
      "utf8",
    );
    writeFileSync(join(dir, "Scenes.tsx"), mine);

    const second = scaffoldVideo(dir);

    expect(second.created).toEqual([]);
    expect(second.restored).toEqual([]);
    expect(second.skipped).toEqual([...SCAFFOLD_FILES]);
    expect(Buffer.compare(readFileSync(join(dir, "Scenes.tsx")), mine)).toBe(0);
  });

  // AC-7c, second half. This is the deliberate narrowing of max's promise:
  // engine files are derived output, so a hand-edited one is restored rather
  // than preserved. It is the only thing covering the write_source_to hole,
  // where the agent writes files with its own tools and no MCP guard can see.
  it("restores an engine-owned file whose bytes were altered, and reports it", () => {
    const dir = freshVideoDir();
    scaffoldVideo(dir);

    const shell = join(dir, "Video.tsx");
    writeFileSync(shell, "// look ma, no audio\nexport const Video = () => null;\n", "utf8");

    const second = scaffoldVideo(dir);

    expect(second.restored).toEqual(["Video.tsx"]);
    expect(second.created).toEqual([]);
    expect(second.skipped).toEqual([
      "index.ts",
      "types.ts",
      "Root.tsx",
      "Captions.tsx",
      "Scenes.tsx",
    ]);
    expect(Buffer.compare(readFileSync(shell), golden("Video.tsx"))).toBe(0);
  });

  it("restores the files that are missing, engine-owned or not", () => {
    const dir = freshVideoDir();
    scaffoldVideo(dir);

    unlinkSync(join(dir, "types.ts"));
    unlinkSync(join(dir, "Captions.tsx"));
    unlinkSync(join(dir, "Scenes.tsx"));

    const third = scaffoldVideo(dir);

    expect(third.created).toEqual(["types.ts", "Captions.tsx", "Scenes.tsx"]);
    expect(third.skipped).toEqual(["index.ts", "Root.tsx", "Video.tsx"]);
    expect(third.restored).toEqual([]);
    expect(Buffer.compare(readFileSync(join(dir, "types.ts")), golden("types.ts"))).toBe(0);
    expect(Buffer.compare(readFileSync(join(dir, "Captions.tsx")), golden("Captions.tsx"))).toBe(0);
    expect(Buffer.compare(readFileSync(join(dir, "Scenes.tsx")), golden("Scenes.tsx"))).toBe(0);
  });
});

// AC-7d. A golden regenerated from the template it tests proves only that the
// bytes have not changed; it cannot say why they are what they are. These
// assertions encode the reason, so an edit that walked the divergence back —
// moving <Audio> or <Captions> into the agent's file — fails here even if both
// goldens were dutifully refreshed alongside it.
describe("the deliberate divergence from max's Video.tsx", () => {
  const engine = (): string => golden("Video.tsx").toString("utf8");
  const agent = (): string => golden("Scenes.tsx").toString("utf8");

  it("really diverges: the shipped Video.tsx is not max's Video.tsx", () => {
    expect(Buffer.compare(golden("Video.tsx"), upstreamVideo())).not.toBe(0);
  });

  it("keeps max's retained copy as the agent-owned REPLACE THIS stub it was", () => {
    const upstream = upstreamVideo().toString("utf8");
    expect(upstream).toContain("REPLACE THIS");
    expect(upstream).toContain('import { Audio } from "@remotion/media";');
    expect(upstream).toContain("<Captions");
    expect(upstream).toContain("<Sequence");
  });

  it("mounts the audio, the captions and the per-segment sequencing in the engine file", () => {
    expect(engine()).toContain('import { Audio } from "@remotion/media";');
    expect(engine()).toContain("<Audio src={staticFile(timings.audio)} />");
    expect(engine()).toContain("<Captions captions={captions} />");
    expect(engine()).toContain("from={segment.from}");
    expect(engine()).toContain("durationInFrames={segment.durationInFrames}");
    expect(engine()).not.toContain("REPLACE THIS");
  });

  it("keeps all three out of the agent-owned Scenes.tsx", () => {
    expect(agent()).not.toContain("@remotion/media");
    expect(agent()).not.toContain("<Captions");
    expect(agent()).not.toContain("<Sequence");
  });

  it("hands a scene strictly more than max's Video.tsx received", () => {
    // segment is new; timings and captions are what the old file already had.
    expect(engine()).toContain(
      "export type SceneProps = { segment: Segment; timings: Timings; captions: Caption[] };",
    );
    expect(engine()).toContain('import * as authored from "./Scenes";');
    expect(engine()).toContain("const agent: SceneModule = authored;");
  });

  it("keeps the Scenes.tsx stub's back-reference type-only, so the cycle never exists at runtime", () => {
    expect(agent()).toContain('import type { SceneMap } from "./Video";');
    expect(agent()).not.toContain("import { SceneMap }");
  });

  it("ships an empty scene map, which cannot trip the unknown-id guard", () => {
    expect(agent()).toContain("export const scenes: SceneMap = {};");
  });

  it("leaves types.ts untouched by putting the scene contract in Video.tsx", () => {
    // The scene types live in the engine shell precisely so types.ts keeps its
    // byte-identity with max (AC-7b).
    expect(golden("types.ts").toString("utf8")).not.toContain("SceneMap");
    expect(engine()).toContain("export type SceneMap = Record<string, Scene>;");
  });
});

// The composition-level half of the loud-failure design (ADR 0018, "Loud
// failure, in the direction that matters"). These guards run inside Remotion,
// which this scaffold-phase package does not host, so they are asserted as
// template content; the executable proof of "refuses rather than ships
// something silent" is in `preflight.test.ts`.
describe("the render guards in the engine shell", () => {
  const engine = (): string => golden("Video.tsx").toString("utf8");

  it("throws rather than rendering a video with no audio track", () => {
    expect(engine()).toContain(
      'if (!timings.audio) throw new Error("timings.json names no audio track — re-run explainer_narrate.");',
    );
  });

  it("throws rather than rendering a video with no captions", () => {
    expect(engine()).toContain(
      'if (captions.length === 0) throw new Error("captions.json is empty — re-run explainer_narrate.");',
    );
  });

  it("throws on a scene keyed to a segment the narration does not contain", () => {
    expect(engine()).toContain(
      "const unknown = Object.keys(agent.scenes).filter((id) => !ids.has(id));",
    );
    expect(engine()).toContain("Known ids:");
  });

  it("shows a card, not a black frame, when there are no timings at all", () => {
    expect(engine()).toContain("if (!timings) return <NotNarratedYet />;");
    expect(engine()).toContain("not narrated yet — call explainer_narrate");
    expect(engine()).not.toContain(
      'if (!timings) return <AbsoluteFill style={{ backgroundColor: "#0A0C10" }} />;',
    );
  });

  it("draws a visible placeholder, not a throw, for a segment with no scene", () => {
    expect(engine()).toContain("const Scene = agent.scenes[segment.id] ?? MissingScene;");
    expect(engine()).toContain("no scene");
  });
});
