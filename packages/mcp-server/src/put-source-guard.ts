/**
 * The runtime half of file ownership (ADR 0018, layer 2).
 *
 * The engine owns the composition shell — `Video.tsx` mounts the narration
 * `<Audio>`, the `<Captions>` track and the per-segment `<Sequence>`s, and
 * `Root.tsx`, `Captions.tsx`, `types.ts` and `index.ts` are the wiring around
 * it. An agent asked to "make the title smaller" that rewrote one of those files
 * would drop the soundtrack, the render would still succeed, and the pipeline
 * would ship a silent MP4. Nothing downstream notices, which is exactly why the
 * write has to be refused at the door rather than inspected afterwards.
 *
 * **Why this exists when the schema already says it.**
 * `explainer_put_source.input.json` reserves the same five names in a
 * `not`/`enum`, and that is the published contract — it is what an ajv-validating
 * client and `protocol.test.ts` check against. It is not the runtime gate:
 * `json-schema-to-typescript` and `datamodel-code-generator` both ignore `not`,
 * so the generated `SourceFile.path` is a plain `string` in both languages, and
 * this phase publishes an open object as every tool's input schema rather than
 * the per-tool schemas, so nothing validates arguments at the boundary today. Read
 * the generated types as the enforcement and this guard looks redundant; it is
 * the only thing actually enforcing the rule.
 *
 * **Where it runs.** `createMcpServer()` calls it before dispatching to the
 * backend, so the CLI's stdio surface, the CLI's Streamable HTTP surface and the
 * hosted media-service all inherit it from one registration and a future backend
 * cannot forget it. A backend reached by some other route — the CLI's own
 * subcommands, the media-service's internal HTTP API — re-checks against
 * `ENGINE_OWNED_FILES` at the disk boundary (layer 3); this module is the door,
 * not the disk.
 */

import { ENGINE_OWNED_FILES } from "@xplainer/protocol";

/**
 * The same names case-folded, because the filesystem — not this process — decides
 * which file a write lands on.
 *
 * macOS (APFS/HFS+ by default) and Windows (NTFS) are case-INSENSITIVE, so a write
 * to `video.tsx` opens the very same inode as `Video.tsx`. A case-sensitive guard
 * therefore refuses `Video.tsx`, waves `video.tsx` through, and the engine-owned
 * shell — the `<Audio>` and `<Captions>` mounts this whole boundary exists to
 * protect — is overwritten anyway. The bypass is silent: the render still succeeds
 * and simply ships without sound, which is exactly the failure ADR 0018 was written
 * to make impossible.
 *
 * So this guard is deliberately STRICTER than the schema's `not`/`enum`, which can
 * only express exact strings. Layer 2 refusing a superset of layer 1 is the correct
 * direction for defence in depth: the inner door may be harder to open than the
 * outer one, never easier. The cost is that an agent cannot create a genuinely
 * distinct `video.tsx` on a case-sensitive Linux box. That file would be a trap for
 * every macOS and Windows contributor, so refusing it everywhere is the behaviour we
 * want regardless of the host.
 *
 * Case folding only; no Unicode normalization is applied, because all five reserved
 * names are pure ASCII and NFC/NFD cannot map a non-ASCII path onto one of them.
 */
const RESERVED_FOLDED: ReadonlySet<string> = new Set<string>(
  ENGINE_OWNED_FILES.map((name) => name.toLowerCase()),
);

/** The machine-readable code carried by {@link EngineOwnedPathError}. */
export const ENGINE_OWNED_PATH_ERROR_CODE = "ENGINE_OWNED_PATH";

/**
 * Reduce a caller-supplied path to the relative path it actually names.
 *
 * The schema's pattern already forbids `.`, `..`, a leading slash and a
 * backslash, but this phase publishes an open input schema, so a path reaching
 * this guard has been validated by nothing. Resolving the traversal here means
 * `./Video.tsx` and `scenes/../Video.tsx` are refused rather than waved through
 * on a technicality. A leading `..` that would escape the video directory is
 * dropped rather than preserved, which is the conservative direction: it can
 * only turn a path into a reserved name, never out of one.
 *
 * Comparison is case-sensitive and exact, matching the schema's `not`/`enum`, so
 * layer 1 and layer 2 refuse exactly the same set. Only the five top-level names
 * are reserved: `scenes/Root.tsx` is the agent's file and stays writable.
 */
function normalizeRelativePath(raw: string): string {
  const segments: string[] = [];
  for (const segment of raw.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/**
 * Thrown when a call to `explainer_put_source` names a file the engine owns.
 *
 * Carries the offending paths and the full reserved list so the tool boundary
 * can answer with a structured error an agent can act on, rather than a bare
 * message it has to parse.
 */
export class EngineOwnedPathError extends Error {
  /** Stable machine-readable code. Unchanged if this ever becomes a `-32602`. */
  readonly code = ENGINE_OWNED_PATH_ERROR_CODE;

  /** The engine-owned paths the call asked to write, in the order it listed them. */
  readonly rejected: readonly string[];

  /** The whole reserved set, so the caller need not have the contract to hand. */
  readonly engineOwned: readonly string[] = ENGINE_OWNED_FILES;

  constructor(rejected: readonly string[]) {
    super(engineOwnedPathMessage(rejected));
    this.name = "EngineOwnedPathError";
    this.rejected = [...rejected];
  }
}

/**
 * The refusal an agent reads.
 *
 * Written to be recovered from on the first retry rather than looped on: it
 * names what was refused, why refusing it protects the video, where the agent's
 * work belongs instead, the full reserved list, and — the part that stops a
 * half-applied change being guessed at — that nothing was written.
 */
function engineOwnedPathMessage(rejected: readonly string[]): string {
  const quoted = rejected.map((path) => JSON.stringify(path)).join(", ");
  const verb = rejected.length === 1 ? "is" : "are";
  return [
    `explainer_put_source refused: ${quoted} ${verb} engine-owned and cannot be written by an agent.`,
    "The engine-owned files mount the narration audio, the caption track and the per-segment",
    "sequencing; a video whose shell an agent had rewritten would render silent.",
    "Write your scenes to Scenes.tsx — one component per narration segment id — and put the",
    `components it imports under scenes/. Engine-owned: ${ENGINE_OWNED_FILES.join(", ")}.`,
    "Nothing was written.",
  ].join(" ");
}

/**
 * Refuse a whole `explainer_put_source` call that names any engine-owned file.
 *
 * All-or-nothing on purpose: one reserved path in a batch of ten rejects the
 * batch, so the agent never lands half a change and then has to work out which
 * half. Every offending path is reported at once, so a call naming two of them
 * costs one retry rather than two.
 *
 * Anything that is not a string path is left alone — arguments arrive
 * unvalidated, and a malformed call is the backend's error to report, in its own
 * words. This guard has exactly one job.
 *
 * @throws EngineOwnedPathError if any file names a path the engine owns.
 */
export function assertAgentOwnedPaths(input: Record<string, unknown>): void {
  const files = input.files;
  if (!Array.isArray(files)) {
    return;
  }

  const rejected: string[] = [];
  for (const file of files) {
    if (file === null || typeof file !== "object") {
      continue;
    }
    const candidate = (file as { path?: unknown }).path;
    if (typeof candidate !== "string") {
      continue;
    }
    const normalized = normalizeRelativePath(candidate);
    // Case-folded, because a case-insensitive filesystem would resolve `video.tsx`
    // to the engine-owned `Video.tsx`. See RESERVED_FOLDED. The path is reported
    // back to the caller as they wrote it, so the error names the string they sent.
    if (RESERVED_FOLDED.has(normalized.toLowerCase()) && !rejected.includes(normalized)) {
      rejected.push(normalized);
    }
  }

  if (rejected.length > 0) {
    throw new EngineOwnedPathError(rejected);
  }
}
