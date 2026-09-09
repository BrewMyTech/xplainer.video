/**
 * The eight tools, against a real workspace and a real job runner.
 *
 * Nothing here is stubbed. The runner is the daemon's own — a real job store under a temporary
 * state directory, a real queue — because `explainer_job` *is* `runner.get()` and a double there
 * would make the tool's answers this file's invention rather than the daemon's. The workspace is a
 * temporary directory and the assertions are about the bytes that end up in it.
 *
 * Two of these tests are the ones that would be worth writing even if everything else were deleted:
 *
 *   * `explainer_put_source` refuses `Video.tsx` **called directly**, with no MCP registration
 *     anywhere in the stack. That is ADR 0018's layer 3, and the whole reason it exists is that
 *     layer 2 sits on `createMcpServer()` and this backend is also reachable without it.
 *   * the slug and media-name patterns are read out of `packages/protocol/schemas/` and compared
 *     with the copies in `backend.ts`, so the two cannot drift into two rules that merely used to
 *     agree.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RenderBackend } from "@xplainer/mcp-server";
import type { Narration } from "@xplainer/protocol";
import { readScaffoldTemplate, videoPaths } from "@xplainer/render-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalBackend } from "./backend.js";
import { createJobStore } from "./daemon/job-store.js";
import { createJobRunner, type JobRunner } from "./daemon/runner.js";
import { selfIdentity } from "./daemon/worker-identity.js";
import { readJobRequest } from "./job-request.js";
import { recordTestToolchain } from "./setup/testing/toolchain.js";

/** `packages/protocol/schemas/`, from this file rather than from a hard-coded depth. */
const SCHEMAS = fileURLToPath(new URL("../../../packages/protocol/schemas/", import.meta.url));

function schemaPattern(path: string, pointer: readonly string[]): string {
  let node: unknown = JSON.parse(readFileSync(join(SCHEMAS, path), "utf8"));
  for (const key of pointer) {
    node = (node as Record<string, unknown>)[key];
  }
  const pattern = (node as { pattern?: unknown }).pattern;
  if (typeof pattern !== "string") {
    throw new Error(`${path} has no string pattern at ${pointer.join("/")}`);
  }
  return pattern;
}

const directories: string[] = [];
let root = "";
let stateDir = "";
let backend: RenderBackend;
let runner: JobRunner;

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

beforeEach(() => {
  root = temporaryDirectory("xplainer-backend-workspace-");
  stateDir = temporaryDirectory("xplainer-backend-state-");
  const store = createJobStore(stateDir);
  // No worker registry: nothing in this file lets a job start, and a kind with no worker fails as
  // a job rather than as a tool call, which is the behaviour `runner.ts` documents.
  runner = createJobRunner({ store, owner: { ...selfIdentity(), run_id: "backend-test" } });
  backend = createLocalBackend({ runner, root, stateDir });
});

afterEach(async () => {
  await runner.drain(0);
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A machine where `xplainer setup` has run: a Remotion CLI in the workspace, and the marker.
 *
 * Both halves, because the two render tools now ask the same question the worker factory asks a
 * moment later — a tool call that succeeded and a job that then failed on the toolchain is exactly
 * the outcome an agent holding a `job_id` cannot act on.
 */
function pretendInstalled(): void {
  const bin = join(root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, process.platform === "win32" ? "remotion.cmd" : "remotion"),
    "#!/bin/sh\n",
  );
  recordTestToolchain({ stateDir, workspaceRoot: root });
}

/** A narrated video, without running a narration: what `still` and `render` require on disk. */
function pretendNarrated(slug: string): void {
  const video = videoPaths(root, slug);
  writeFileSync(
    video.timings,
    JSON.stringify({
      fps: 30,
      durationInFrames: 60,
      totalMs: 2000,
      audio: "narration.wav",
      segments: [],
    }),
  );
  writeFileSync(video.captions, JSON.stringify([{ text: "hi", startMs: 0, endMs: 100 }]));
  writeFileSync(video.audio, Buffer.alloc(64));
}

describe("the schemas are the source of the patterns", () => {
  it("accepts and refuses exactly what schemas/slug.json's pattern does", async () => {
    const pattern = new RegExp(schemaPattern("slug.json", []));

    for (const slug of ["demo", "a", "0-9-x", "a".repeat(64)]) {
      expect(pattern.test(slug), slug).toBe(true);
      await expect(backend.explainer_create({ slug })).resolves.toMatchObject({ slug });
    }
    for (const slug of ["Demo", "-demo", "de mo", "../escape", "a".repeat(65), ""]) {
      expect(pattern.test(slug), slug).toBe(false);
      await expect(backend.explainer_create({ slug })).rejects.toThrow(/invalid slug/);
    }
  });

  it("accepts and refuses exactly what explainer_put_media's name pattern does", async () => {
    const pattern = new RegExp(
      schemaPattern("tools/explainer_put_media.input.json", ["properties", "name"]),
    );
    await backend.explainer_create({ slug: "demo" });
    const base64 = Buffer.from("bytes").toString("base64");

    for (const name of ["logo.png", "a", "a-b_c.2.webm"]) {
      expect(pattern.test(name), name).toBe(true);
      await expect(backend.explainer_put_media({ slug: "demo", name, base64 })).resolves.toEqual({
        slug: "demo",
        name,
        bytes: 5,
      });
    }
    for (const name of ["../escape.png", "nested/logo.png", ".hidden", ""]) {
      expect(pattern.test(name), name).toBe(false);
      await expect(backend.explainer_put_media({ slug: "demo", name, base64 })).rejects.toThrow(
        /bare filename/,
      );
    }
  });
});

describe("explainer_create", () => {
  it("scaffolds the six files and reports where source and media go", async () => {
    const result = await backend.explainer_create({ slug: "demo" });
    const video = videoPaths(root, "demo");

    expect(result).toEqual({
      slug: "demo",
      created: ["index.ts", "types.ts", "Root.tsx", "Captions.tsx", "Video.tsx", "Scenes.tsx"],
      already_present: [],
      write_source_to: video.source,
      put_media_in: video.media,
      next: expect.arrayContaining([expect.stringContaining("explainer_narrate")]),
    });
    expect(readFileSync(join(video.source, "Video.tsx"))).toEqual(
      readScaffoldTemplate("Video.tsx"),
    );
    // The workspace itself is materialised on the first create, never installed by it.
    expect(existsSync(join(root, "package.json"))).toBe(true);
    expect(existsSync(join(root, "node_modules"))).toBe(false);
  });

  it("never overwrites the agent's Scenes.tsx, and restores an engine file that drifted", async () => {
    await backend.explainer_create({ slug: "demo" });
    const video = videoPaths(root, "demo");
    writeFileSync(join(video.source, "Scenes.tsx"), "export const scenes = { hook: () => null };");
    writeFileSync(join(video.source, "Video.tsx"), "// hand-edited through write_source_to");

    const again = await backend.explainer_create({ slug: "demo" });

    expect(again.created).toEqual(["Video.tsx"]);
    expect(again.already_present).toEqual([
      "index.ts",
      "types.ts",
      "Root.tsx",
      "Captions.tsx",
      "Scenes.tsx",
    ]);
    expect(readFileSync(join(video.source, "Video.tsx"))).toEqual(
      readScaffoldTemplate("Video.tsx"),
    );
    expect(readFileSync(join(video.source, "Scenes.tsx"), "utf8")).toContain("hook");
  });
});

describe("explainer_put_source", () => {
  it("refuses an engine-owned file at the disk boundary, with no MCP guard in the stack", async () => {
    await backend.explainer_create({ slug: "demo" });
    const video = videoPaths(root, "demo");

    await expect(
      backend.explainer_put_source({
        slug: "demo",
        files: [
          { path: "scenes/Intro.tsx", content: "export const Intro = () => null;" },
          { path: "Video.tsx", content: "// the shell an agent must not own" },
        ],
      }),
    ).rejects.toThrow(/engine-owned/);

    expect(readFileSync(join(video.source, "Video.tsx"))).toEqual(
      readScaffoldTemplate("Video.tsx"),
    );
    // All-or-nothing: the legitimate scene beside it was not written either.
    expect(existsSync(join(video.source, "scenes"))).toBe(false);
  });

  it("refuses a case-folded spelling of an engine-owned file", async () => {
    await backend.explainer_create({ slug: "demo" });

    await expect(
      backend.explainer_put_source({
        slug: "demo",
        files: [{ path: "video.tsx", content: "// a case-insensitive filesystem's back door" }],
      }),
    ).rejects.toThrow(/engine-owned/);
  });

  it("refuses a path that would escape the video directory", async () => {
    await backend.explainer_create({ slug: "demo" });

    for (const path of ["../other/Scenes.tsx", "/etc/passwd", "scenes/../../out"]) {
      await expect(
        backend.explainer_put_source({ slug: "demo", files: [{ path, content: "x" }] }),
      ).rejects.toThrow(/relative path inside the video/);
    }
  });

  it("writes the agent's own files, including a nested Root.tsx", async () => {
    await backend.explainer_create({ slug: "demo" });
    const video = videoPaths(root, "demo");

    const result = await backend.explainer_put_source({
      slug: "demo",
      files: [
        { path: "Scenes.tsx", content: "export const scenes = {};" },
        { path: "scenes/Root.tsx", content: "export const Root = () => null;" },
      ],
    });

    expect(result).toEqual({ slug: "demo", written: ["Scenes.tsx", "scenes/Root.tsx"] });
    expect(readFileSync(join(video.source, "scenes", "Root.tsx"), "utf8")).toContain("Root");
  });

  it("refuses every tool for a video that was never created", async () => {
    await expect(
      backend.explainer_put_source({
        slug: "absent",
        files: [{ path: "Scenes.tsx", content: "" }],
      }),
    ).rejects.toThrow(/explainer_create/);
  });
});

describe("explainer_put_media", () => {
  it("writes the decoded bytes into the video's media directory", async () => {
    await backend.explainer_create({ slug: "demo" });
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const result = await backend.explainer_put_media({
      slug: "demo",
      name: "logo.png",
      base64: bytes.toString("base64"),
    });

    expect(result).toEqual({ slug: "demo", name: "logo.png", bytes: bytes.length });
    expect(readFileSync(join(videoPaths(root, "demo").media, "logo.png"))).toEqual(bytes);
  });

  it("refuses a payload that is not really base64, rather than writing it truncated", async () => {
    await backend.explainer_create({ slug: "demo" });

    await expect(
      backend.explainer_put_media({ slug: "demo", name: "logo.png", base64: "not base64!!" }),
    ).rejects.toThrow(/not valid base64/);
    expect(existsSync(join(videoPaths(root, "demo").media, "logo.png"))).toBe(false);
  });
});

describe("explainer_narrate", () => {
  it("records the spec and the request, and answers with a pollable job id", async () => {
    await backend.explainer_create({ slug: "demo" });
    const narration: Narration = {
      segments: [{ id: "hook", text: "What if your build was already broken?" }],
    };

    const result = await backend.explainer_narrate({ slug: "demo", narration });

    expect(result).toEqual({
      job_id: 1,
      status: "queued",
      what: expect.stringContaining("narrating demo: 1 segment"),
      poll: "explainer_job(job_id=1)",
    });
    expect(JSON.parse(readFileSync(videoPaths(root, "demo").narrationSpec, "utf8"))).toEqual(
      narration,
    );
    expect(readJobRequest(root, 1, "explainer_narrate")).toEqual({
      job_type: "explainer_narrate",
      slug: "demo",
      dry_run: false,
    });
  });

  it("refuses a narration with no segments", async () => {
    await backend.explainer_create({ slug: "demo" });

    // `Narration` is a non-empty tuple in TypeScript and an open object on the wire: this phase
    // publishes an open input schema, so an agent really can send this and the backend really has
    // to refuse it. The cast is the wire shape, not a convenience.
    const empty = { segments: [] } as unknown as Narration;

    await expect(backend.explainer_narrate({ slug: "demo", narration: empty })).rejects.toThrow(
      /no segments/,
    );
  });
});

describe("explainer_still and explainer_render", () => {
  it("refuse a video that has never been narrated", async () => {
    await backend.explainer_create({ slug: "demo" });
    pretendInstalled();

    await expect(backend.explainer_still({ slug: "demo" })).rejects.toThrow(/timings\.json/);
    await expect(backend.explainer_render({ slug: "demo" })).rejects.toThrow(/timings\.json/);
  });

  it("refuse a workspace whose dependencies were never installed", async () => {
    await backend.explainer_create({ slug: "demo" });
    pretendNarrated("demo");

    await expect(backend.explainer_render({ slug: "demo" })).rejects.toThrow(
      /xplainer setup --workspace/,
    );
  });

  /**
   * The gate the tool call and the worker factory now share.
   *
   * An installed workspace is not the whole answer: the browser every frame is drawn with comes
   * from `xplainer setup` and nothing else on this machine records that it is here, so a machine
   * with a workspace and no marker has to be refused at the call rather than inside a job.
   */
  it("refuse a machine where setup has never run, even with a workspace installed", async () => {
    await backend.explainer_create({ slug: "demo" });
    pretendNarrated("demo");
    const bin = join(root, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, process.platform === "win32" ? "remotion.cmd" : "remotion"),
      "#!/bin/sh\n",
    );

    await expect(backend.explainer_render({ slug: "demo" })).rejects.toThrow(/xplainer setup/);
    await expect(backend.explainer_still({ slug: "demo" })).rejects.toThrow(/xplainer setup/);
  });

  it("record the still's frame and scale, defaulted from the schema", async () => {
    await backend.explainer_create({ slug: "demo" });
    pretendNarrated("demo");
    pretendInstalled();

    const defaulted = await backend.explainer_still({ slug: "demo" });
    const explicit = await backend.explainer_still({ slug: "demo", frame: 12, scale: 1 });

    expect(readJobRequest(root, defaulted.job_id, "explainer_still")).toEqual({
      job_type: "explainer_still",
      slug: "demo",
      frame: 90,
      scale: 0.5,
    });
    expect(readJobRequest(root, explicit.job_id, "explainer_still")).toEqual({
      job_type: "explainer_still",
      slug: "demo",
      frame: 12,
      scale: 1,
    });
  });

  it("refuse a frame or a scale the schema does not allow", async () => {
    await backend.explainer_create({ slug: "demo" });
    pretendNarrated("demo");
    pretendInstalled();

    await expect(backend.explainer_still({ slug: "demo", frame: -1 })).rejects.toThrow(/frame/);
    await expect(backend.explainer_still({ slug: "demo", scale: 0 })).rejects.toThrow(/scale/);
    await expect(backend.explainer_still({ slug: "demo", scale: 2 })).rejects.toThrow(/scale/);
  });
});

describe("explainer_job", () => {
  it("reports a queued job through the runner, and says so for an id that does not exist", async () => {
    await backend.explainer_create({ slug: "demo" });
    pretendNarrated("demo");
    pretendInstalled();
    const { job_id } = await backend.explainer_render({ slug: "demo" });

    const state = await backend.explainer_job({ job_id });

    expect(state).toMatchObject({ job_id, job_type: "explainer_render", status: "queued" });
    await expect(backend.explainer_job({ job_id: 999 })).rejects.toThrow(/no job with id 999/);
  });
});

describe("explainer_list", () => {
  it("reports every video, in slug order, with what each one has on disk", async () => {
    await backend.explainer_create({ slug: "second" });
    await backend.explainer_create({ slug: "first" });
    pretendNarrated("first");
    const video = videoPaths(root, "first");
    writeFileSync(video.mp4, Buffer.alloc(1_048_576 + 524_288));

    expect(await backend.explainer_list({})).toEqual({
      videos: [
        {
          slug: "first",
          has_narration: true,
          rendered: true,
          mp4: video.mp4,
          size_mb: 1.5,
          seconds: 2,
        },
        { slug: "second", has_narration: false, rendered: false },
      ],
    });
  });

  it("reports an empty workspace as no videos rather than failing", async () => {
    expect(await backend.explainer_list({})).toEqual({ videos: [] });
  });
});
