/**
 * The eight tools, implemented against one shared Remotion workspace on this machine.
 *
 * This is the local half of `RenderBackend` ([ADR 0016](../../../docs/adr/0016-cli-first-local-runtime-desktop-is-an-optional-client.md)).
 * The split inside it is [ADR 0008](../../../docs/adr/0008-async-job-model-poll-and-progress-no-agent-webhooks.md)'s:
 *
 * - `explainer_create`, `explainer_put_source`, `explainer_put_media` and `explainer_list` are
 *   filesystem work that finishes in milliseconds, so they happen here and now;
 * - `explainer_narrate`, `explainer_still` and `explainer_render` take tens of seconds, so they are
 *   handed to the daemon's job runner and answered with a `job_id`;
 * - `explainer_job` **is** `runner.get()`, relayed. The runner already returns the contract shape.
 *
 * The layout, the scaffold, the argv builders and the preflight all come from
 * `@xplainer/render-core`; nothing about a video's shape is decided here. What is decided here is
 * the boundary: which refusals an agent gets immediately, and which become a failed job.
 *
 * **Every argument arrives unvalidated.** This phase publishes an open object as each tool's input
 * schema (`packages/mcp-server/src/server.ts` says why), so nothing between an agent and this file
 * checks a type, a pattern or a required field. Each method therefore validates what it is about to
 * put on disk, and the slug and media-name patterns below are the schemas' own — pinned to them by
 * `backend.test.ts`, which reads the JSON rather than trusting the copies.
 *
 * **`explainer_put_source` re-checks file ownership at the disk boundary.** `createMcpServer()`
 * already refuses the five engine-owned files (ADR 0018, layer 2) and this is layer 3, on purpose:
 * that guard sits on the MCP registration, and this backend is also reachable without it — from a
 * CLI subcommand, from a future internal HTTP route, from a test calling the method directly. The
 * guard above that route is not the guard above this one.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RenderBackend } from "@xplainer/mcp-server";
import type {
  ExplainerCreateInput,
  ExplainerCreateOutput,
  ExplainerJobInput,
  ExplainerJobOutput,
  ExplainerListInput,
  ExplainerListOutput,
  ExplainerNarrateInput,
  ExplainerNarrateOutput,
  ExplainerPutMediaInput,
  ExplainerPutMediaOutput,
  ExplainerPutSourceInput,
  ExplainerPutSourceOutput,
  ExplainerRenderInput,
  ExplainerRenderOutput,
  ExplainerStillInput,
  ExplainerStillOutput,
  JobState,
  Narration,
  VideoSummary,
} from "@xplainer/protocol";
import {
  DEFAULT_STILL_FRAME,
  DEFAULT_STILL_SCALE,
  ENGINE_OWNED_FILES,
  isWorkspaceInstalled,
  listVideoSlugs,
  materialiseWorkspace,
  SCAFFOLD_FILES,
  type ScaffoldFile,
  scaffoldVideo,
  type VideoPaths,
  videoPaths,
  workspaceNotInstalledMessage,
} from "@xplainer/render-core";
import type { JobRunner } from "./daemon/runner.js";
import { resolveStateDir } from "./daemon/state-dir.js";
import { type JobRequest, writeJobRequest } from "./job-request.js";
import { checkToolchain } from "./setup/toolchain.js";
import { resolveWorkspaceRoot } from "./workspace-root.js";

/**
 * `schemas/slug.json`'s pattern, verbatim.
 *
 * The slug is a directory name on every backend, which is why the schema pins it and why this file
 * checks it again: a value reaching here has been validated by nothing, and `..` or `/` in a slug
 * is a write outside the workspace.
 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `schemas/tools/explainer_put_media.input.json`'s `name` pattern, verbatim. */
const MEDIA_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The base64 alphabet and its padding, as the schema's `contentEncoding` means it. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** Which refusal a {@link LocalBackendError} carries, for a caller that branches on it. */
export type LocalBackendCode =
  /** The slug is not the shape `schemas/slug.json` describes. */
  | "INVALID_SLUG"
  /** No video by that slug: `explainer_create` has not been called for it. */
  | "NO_SUCH_VIDEO"
  /** A `put_source` path names one of the five files the engine owns (ADR 0018, layer 3). */
  | "ENGINE_OWNED_PATH"
  /** A `put_source` path is absolute, or climbs out of the video's source directory. */
  | "INVALID_SOURCE_PATH"
  /** A `put_media` name is not the bare filename the schema's pattern allows. */
  | "INVALID_MEDIA_NAME"
  /** A `put_media` payload is not base64, so the asset would land truncated. */
  | "INVALID_MEDIA_PAYLOAD"
  /** The narration spec has no segments to speak. */
  | "NO_SEGMENTS"
  /** A still's frame or scale is outside what the schema allows. */
  | "INVALID_STILL_ARGUMENT"
  /** The video has never been narrated, so no scene has a length yet. */
  | "NARRATION_MISSING"
  /** The shared Remotion workspace has no dependencies installed. */
  | "WORKSPACE_NOT_INSTALLED";

/**
 * A refusal an agent can act on, rather than a stack trace.
 *
 * `createMcpServer()` turns a rejection into a tool error carrying the message, so the message is
 * the whole interface: it says what was refused and names the one call that fixes it. `code` is for
 * a caller below the tool boundary — this package's tests, a future structured error — and never
 * has to be parsed back out of prose.
 */
export class LocalBackendError extends Error {
  readonly code: LocalBackendCode;

  constructor(code: LocalBackendCode, message: string) {
    super(message);
    this.name = "LocalBackendError";
    this.code = code;
  }
}

/** What {@link createLocalBackend} needs. */
export type CreateLocalBackendOptions = {
  /** The daemon's job runner: where narrate, still and render go, and what `explainer_job` reads. */
  runner: JobRunner;
  /**
   * The shared Remotion workspace root.
   *
   * Defaults to `XPLAINER_VIDEOS_DIR`, then `<state dir>/workspace`. `commands/serve.ts` passes the
   * root the daemon already resolved, so the backend and the worker registry cannot disagree about
   * where the videos are.
   */
  root?: string;
  /**
   * The daemon's state directory, where `xplainer setup` wrote `toolchain.json`.
   *
   * Defaults to `state-dir.ts`'s resolution. `commands/serve.ts` passes the directory the daemon
   * took ownership of, for the same reason it passes `root`: `serve --state-dir` moves it, and a
   * backend reading the environment would gate a tool call on a marker in a directory this daemon
   * is not using.
   */
  stateDir?: string;
};

function assertSlug(slug: unknown): string {
  if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) {
    throw new LocalBackendError(
      "INVALID_SLUG",
      `invalid slug ${JSON.stringify(slug)}: use lowercase letters, digits and hyphens, starting ` +
        "with a letter or digit, at most 64 characters.",
    );
  }
  return slug;
}

/** Report a set of scaffold files in `SCAFFOLD_FILES` order, which is the contract order. */
function inScaffoldOrder(names: readonly ScaffoldFile[]): ScaffoldFile[] {
  const present = new Set<string>(names);
  return SCAFFOLD_FILES.filter((name) => present.has(name));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** `timings.json`'s `totalMs` as seconds, or `null` if the file is unreadable. */
function narrationSeconds(timingsPath: string): number | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(timingsPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const totalMs = (parsed as { totalMs?: unknown }).totalMs;
    return typeof totalMs === "number" ? round1(totalMs / 1000) : null;
  } catch {
    return null;
  }
}

function sizeMb(path: string): number | null {
  try {
    return round1(statSync(path).size / 1_048_576);
  } catch {
    return null;
  }
}

/**
 * Reduce one `put_source` path to what it names, refusing anything that could land outside the
 * video's source directory.
 *
 * Stricter than `assertAgentOwnedPaths()` in `@xplainer/mcp-server`, and that is the right
 * direction for the inner door: that guard *normalises* `..` away because its only job is to decide
 * whether the result is a reserved name; this one is about to open a file, so a path containing
 * `..`, a leading slash or a drive letter is refused outright rather than repaired into something
 * the caller did not write.
 */
function assertWritableSourcePath(raw: unknown): string {
  if (typeof raw !== "string" || raw === "") {
    throw new LocalBackendError(
      "INVALID_SOURCE_PATH",
      `explainer_put_source refused: ${JSON.stringify(raw)} is not a file path. Nothing was written.`,
    );
  }
  const path = raw.replace(/\\/g, "/");
  const segments = path.split("/");
  const escapes =
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..");
  if (escapes) {
    throw new LocalBackendError(
      "INVALID_SOURCE_PATH",
      `explainer_put_source refused: ${JSON.stringify(raw)} is not a relative path inside the ` +
        "video. Use plain segments, as in scenes/Intro.tsx. Nothing was written.",
    );
  }
  return path;
}

/**
 * The disk-boundary half of file ownership (ADR 0018, layer 3).
 *
 * Case-folded like layer 2, because a case-insensitive filesystem resolves `video.tsx` onto the
 * engine's `Video.tsx` and would let the shell be rewritten through a spelling.
 */
function assertNotEngineOwned(path: string): void {
  const [first, ...rest] = path.split("/");
  if (rest.length > 0 || first === undefined) {
    // Only the five top-level names are reserved: a nested scenes/Root.tsx is the agent's.
    return;
  }
  const folded = first.toLowerCase();
  if (ENGINE_OWNED_FILES.some((name) => name.toLowerCase() === folded)) {
    throw new LocalBackendError(
      "ENGINE_OWNED_PATH",
      `explainer_put_source refused: ${JSON.stringify(path)} is engine-owned and cannot be ` +
        "written by an agent. The engine-owned files mount the narration audio, the caption track " +
        "and the per-segment sequencing, so a video whose shell an agent had rewritten would " +
        "render silent. Write your scenes to Scenes.tsx — one component per narration segment id " +
        "— and put the components it imports under scenes/. Nothing was written.",
    );
  }
}

/**
 * Decode a `put_media` payload, refusing anything that is not really base64.
 *
 * `Buffer.from(…, "base64")` is lenient: it drops every character outside the alphabet and never
 * says so, so a mistyped payload would be written as a shorter, corrupt asset that only fails later
 * — inside a render, minutes away from its cause. Re-encoding and comparing is what turns that into
 * a refusal at the call.
 */
function decodeBase64(name: string, raw: unknown): Buffer {
  if (typeof raw !== "string" || raw === "") {
    throw new LocalBackendError(
      "INVALID_MEDIA_PAYLOAD",
      `explainer_put_media refused ${JSON.stringify(name)}: base64 must be a non-empty string.`,
    );
  }
  const compact = raw.replace(/\s+/g, "");
  const decoded = Buffer.from(compact, "base64");
  const unpadded = compact.replace(/=+$/, "");
  if (!BASE64_PATTERN.test(compact) || decoded.toString("base64").replace(/=+$/, "") !== unpadded) {
    throw new LocalBackendError(
      "INVALID_MEDIA_PAYLOAD",
      `explainer_put_media refused ${JSON.stringify(name)}: the payload is not valid base64, so ` +
        "the asset would have been written truncated. Nothing was written.",
    );
  }
  return decoded;
}

function requireNarrationSpec(narration: unknown): Narration {
  if (
    typeof narration !== "object" ||
    narration === null ||
    !Array.isArray((narration as { segments?: unknown }).segments) ||
    (narration as { segments: unknown[] }).segments.length === 0
  ) {
    throw new LocalBackendError(
      "NO_SEGMENTS",
      "explainer_narrate refused: narration has no segments. Pass " +
        '{"segments": [{"id": "hook", "text": "…"}]} — one segment per scene, and the scene ids ' +
        "in Scenes.tsx are these ids.",
    );
  }
  return narration as Narration;
}

/**
 * Build the local backend over one workspace root.
 *
 * Nothing is created until a tool is called: a daemon starts before any video exists, and the first
 * `explainer_create` is what materialises the workspace.
 */
export function createLocalBackend(options: CreateLocalBackendOptions): RenderBackend {
  const { runner } = options;
  const stateDir = options.stateDir ?? resolveStateDir();
  const root = options.root ?? resolveWorkspaceRoot(stateDir);

  function requireVideo(slug: string): VideoPaths {
    const video = videoPaths(root, slug);
    if (!existsSync(video.source)) {
      throw new LocalBackendError(
        "NO_SUCH_VIDEO",
        `no video called ${JSON.stringify(slug)} — call explainer_create(${JSON.stringify(slug)}) first.`,
      );
    }
    return video;
  }

  function requireNarrated(slug: string): VideoPaths {
    const video = requireVideo(slug);
    if (!existsSync(video.timings)) {
      throw new LocalBackendError(
        "NARRATION_MISSING",
        `${slug} has no timings.json, so no scene has a length yet: every duration comes from the ` +
          `measured narration. Call explainer_narrate(${JSON.stringify(slug)}, narration) and ` +
          "poll explainer_job until it is done.",
      );
    }
    return video;
  }

  /**
   * Refuse a render this machine's toolchain cannot carry out, with the worker factory's own answer.
   *
   * The two gates asked different questions before this: the tool call asked `isWorkspaceInstalled`
   * — is there a `.bin/remotion` shim anywhere up the tree — while the worker factory resolved
   * `@remotion/cli`'s own package and read `toolchain.json`. Two predicates over one condition is
   * how a tool call succeeds and the job it queued then fails, which is precisely the outcome an
   * agent holding a `job_id` cannot act on. So the call now asks `checkToolchain`, the same
   * judgement `daemon/workers.ts` applies a moment later, and the shim check stays as the first
   * thing said about a workspace nobody has installed at all — its sentence names the one command
   * that fixes it, and the toolchain's names whichever component is actually absent.
   */
  function requireInstalledWorkspace(): void {
    if (!isWorkspaceInstalled(root)) {
      throw new LocalBackendError("WORKSPACE_NOT_INSTALLED", workspaceNotInstalledMessage(root));
    }
    const toolchain = checkToolchain({ stateDir, workspaceRoot: root });
    if (!toolchain.ok) {
      throw new LocalBackendError("WORKSPACE_NOT_INSTALLED", toolchain.detail);
    }
  }

  /**
   * Queue one job and record what it was asked to do.
   *
   * The request document is written after `enqueue()` resolves and before the runner can start the
   * worker — `job-request.ts` records why that ordering holds rather than being hoped for.
   */
  async function enqueue(
    request: JobRequest,
    outputDir: string | null,
    what: string,
  ): Promise<{ job_id: number; status: JobState; what: string; poll: string }> {
    const jobId = await runner.enqueue({
      job_type: request.job_type,
      video_id: request.slug,
      output_dir: outputDir,
    });
    writeJobRequest(root, jobId, request);
    // The envelope all three queueing tools answer with; it is identical by schema.
    return { job_id: jobId, status: "queued", what, poll: `explainer_job(job_id=${jobId})` };
  }

  return {
    async explainer_create(input: ExplainerCreateInput): Promise<ExplainerCreateOutput> {
      const slug = assertSlug(input.slug);
      const video = videoPaths(root, slug);

      materialiseWorkspace(root);
      for (const directory of [video.source, video.publicDir, video.media, video.out]) {
        mkdirSync(directory, { recursive: true });
      }

      const scaffold = scaffoldVideo(video.source);
      return {
        slug,
        // A restored engine file WAS written by this call, so it belongs in `created` and not in
        // `already_present`, whose whole promise is "left exactly as it was".
        created: inScaffoldOrder([...scaffold.created, ...scaffold.restored]),
        already_present: inScaffoldOrder(scaffold.skipped),
        write_source_to: video.source,
        put_media_in: video.media,
        next: [
          `explainer_narrate(${JSON.stringify(slug)}, narration) — every scene length comes from the timings it measures, never from a number you choose`,
          "write your scenes into Scenes.tsx, one component per narration segment id; the other five files are engine-owned and are restored if you edit them",
          `explainer_still(${JSON.stringify(slug)}, frame) to check the layout, then explainer_render(${JSON.stringify(slug)})`,
        ],
      };
    },

    async explainer_put_source(input: ExplainerPutSourceInput): Promise<ExplainerPutSourceOutput> {
      const slug = assertSlug(input.slug);
      const video = requireVideo(slug);
      const files = Array.isArray(input.files) ? input.files : [];
      if (files.length === 0) {
        throw new LocalBackendError(
          "INVALID_SOURCE_PATH",
          "explainer_put_source refused: files is empty, so there is nothing to write.",
        );
      }

      // All-or-nothing: every path is checked before any byte is written, so one refused path in a
      // batch of ten never leaves half a change on disk.
      const planned = files.map((file) => {
        const path = assertWritableSourcePath(file.path);
        assertNotEngineOwned(path);
        if (typeof file.content !== "string") {
          throw new LocalBackendError(
            "INVALID_SOURCE_PATH",
            `explainer_put_source refused ${JSON.stringify(path)}: content must be a string. ` +
              "Nothing was written.",
          );
        }
        return { path, content: file.content, target: join(video.source, path) };
      });

      for (const file of planned) {
        mkdirSync(dirname(file.target), { recursive: true });
        writeFileSync(file.target, file.content, "utf8");
      }

      return { slug, written: planned.map((file) => file.path) };
    },

    async explainer_put_media(input: ExplainerPutMediaInput): Promise<ExplainerPutMediaOutput> {
      const slug = assertSlug(input.slug);
      const video = requireVideo(slug);
      const name = input.name;
      if (typeof name !== "string" || !MEDIA_NAME_PATTERN.test(name)) {
        throw new LocalBackendError(
          "INVALID_MEDIA_NAME",
          `explainer_put_media refused ${JSON.stringify(name)}: name is a bare filename — letters, ` +
            "digits, dot, underscore and hyphen, starting with a letter or digit, at most 128 " +
            "characters. Never a path.",
        );
      }

      const bytes = decodeBase64(name, input.base64);
      mkdirSync(video.media, { recursive: true });
      writeFileSync(join(video.media, name), bytes);
      return { slug, name, bytes: bytes.length };
    },

    async explainer_narrate(input: ExplainerNarrateInput): Promise<ExplainerNarrateOutput> {
      const slug = assertSlug(input.slug);
      const video = requireVideo(slug);
      const narration = requireNarrationSpec(input.narration);
      const dryRun = input.dry_run === true;

      mkdirSync(video.publicDir, { recursive: true });
      // The spec goes to disk before the job is queued, because the worker is a separate process
      // and this file is how it is told what to say.
      writeFileSync(video.narrationSpec, `${JSON.stringify(narration, null, 2)}\n`, "utf8");

      const count = narration.segments.length;
      // `output_dir` is deliberately null. Reconciliation quarantines a job's output directory when
      // a worker of uncertain identity may still hold it, and narration's directory is the video's
      // public directory — which also holds the media an agent uploaded. Moving that aside to
      // protect three files narration rewrites wholesale would lose work no retry can recreate.
      return enqueue(
        { job_type: "explainer_narrate", slug, dry_run: dryRun },
        null,
        `narrating ${slug}: ${count} segment${count === 1 ? "" : "s"}` +
          (dryRun ? ", dry run — estimated silence, not measured speech" : ""),
      );
    },

    async explainer_still(input: ExplainerStillInput): Promise<ExplainerStillOutput> {
      const slug = assertSlug(input.slug);
      const video = requireNarrated(slug);
      requireInstalledWorkspace();

      const frame = input.frame ?? DEFAULT_STILL_FRAME;
      const scale = input.scale ?? DEFAULT_STILL_SCALE;
      if (!Number.isInteger(frame) || frame < 0) {
        throw new LocalBackendError(
          "INVALID_STILL_ARGUMENT",
          `explainer_still refused: frame is a whole number from 0, not ${JSON.stringify(frame)}.`,
        );
      }
      if (!Number.isFinite(scale) || scale <= 0 || scale > 1) {
        throw new LocalBackendError(
          "INVALID_STILL_ARGUMENT",
          `explainer_still refused: scale is greater than 0 and at most 1, not ${JSON.stringify(scale)}.`,
        );
      }

      mkdirSync(video.out, { recursive: true });
      return enqueue(
        { job_type: "explainer_still", slug, frame, scale },
        video.out,
        `still of ${slug} at frame ${frame}, scale ${scale}`,
      );
    },

    async explainer_render(input: ExplainerRenderInput): Promise<ExplainerRenderOutput> {
      const slug = assertSlug(input.slug);
      const video = requireNarrated(slug);
      requireInstalledWorkspace();

      mkdirSync(video.out, { recursive: true });
      return enqueue({ job_type: "explainer_render", slug }, video.out, `rendering ${slug} to MP4`);
    },

    async explainer_job(input: ExplainerJobInput): Promise<ExplainerJobOutput> {
      return runner.get(input);
    },

    async explainer_list(_input: ExplainerListInput): Promise<ExplainerListOutput> {
      const videos: VideoSummary[] = listVideoSlugs(root).map((slug) => {
        const video = videoPaths(root, slug);
        const rendered = existsSync(video.mp4);
        const hasNarration = existsSync(video.timings);
        const seconds = hasNarration ? narrationSeconds(video.timings) : null;
        const megabytes = rendered ? sizeMb(video.mp4) : null;
        return {
          slug,
          has_narration: hasNarration,
          rendered,
          ...(rendered ? { mp4: video.mp4 } : {}),
          ...(megabytes === null ? {} : { size_mb: megabytes }),
          ...(seconds === null ? {} : { seconds }),
        };
      });
      return { videos };
    },
  };
}
