# AGENTS.md — `@xplainer/render-core`

Workspace rules and the post-change procedure: root [`AGENTS.md`](../../AGENTS.md).

## What this package is

Five things that travel together: the **Remotion workspace template** under `template/`, the
**layout of the workspace that template becomes** in `src/workspace.ts`, the **ownership-aware
scaffold generator** under `src/scaffold/`, the **narration port** under `src/narrate/`, and the
**render preflight** that refuses an unrenderable job before Chrome is launched.

`src/workspace.ts` is the map: `videoPaths(root, slug)` is the only place `videos/<slug>` and
`public/<slug>` are paired, `materialiseWorkspace()` copies the four template files in without ever
overwriting one, and `remotionBinary()` answers `null` for a workspace nobody has installed. It
writes directories and copies files; it spawns nothing, renders nothing and installs nothing.

The narration port is where a scene duration comes from. It synthesises each segment through
`@xplainer/tts-client`, measures the audio it got back, and writes `narration.wav`,
`captions.json` and `timings.json` — the document the composition reads and the one thing
`preflight()` refuses to render without.

File ownership is the idea the whole package is built around
([ADR 0018](../../docs/adr/0018-engine-owns-the-composition-shell.md)): the **engine** owns five
files — `index.ts`, `types.ts`, `Root.tsx`, `Captions.tsx`, `Video.tsx` — and the **agent** owns
one, `Scenes.tsx`.

## Public surface

From `src/index.ts`: `scaffoldVideo`, `readScaffoldTemplate`, `isEngineOwned`,
`ENGINE_OWNED_FILES`, `AGENT_OWNED_FILES`, `SCAFFOLD_FILES` and their types; `preflight`,
`assertRenderable`, `PreflightError` and the preflight problem types; `renderArgs`, `stillArgs`,
`entryPoint`, `COMPOSITION_ID`, `REMOTION_BIN`, `DEFAULT_STILL_FRAME`, `DEFAULT_STILL_SCALE`; and
the narration port — `narrate`, `planSegments`, `buildCaptions`, `buildTimings`, `buildTrack`,
`reconcileFormat`, `estimateSpeech`, the writers `writeTimings` / `writeCaptions` /
`writeNarrationTrack`, the WAV primitives `decodeWav` / `encodeWav` / `silentFrames` /
`silenceSamples` / `pcmFrameBytes` / `pcmDurationMs` / `samePcmFormat`, `NarrationError`, and the
pacing constants `LEAD_IN_MS`, `GAP_MS`, `TAIL_MS`, `DEFAULT_SAMPLE_RATE`, `DEFAULT_FPS`,
`DEFAULT_VOICE`, `NARRATION_AUDIO_FILE`, `TIMINGS_FILE`, `CAPTIONS_FILE`; and the workspace layout —
`videoPaths`, `stillOutput`, `materialiseWorkspace`, `remotionBinary`, `isWorkspaceInstalled`,
`workspaceNotInstalledMessage`, `listVideoSlugs`, `WORKSPACE_FILES`, `VIDEOS_DIR`, `PUBLIC_DIR`,
`OUT_DIR`, `MEDIA_DIR`, `RENDERED_FILE`, `NARRATION_SPEC_FILE` and their types. The Remotion template
itself is not a JavaScript export — it is files, reached through `./template/*`.

Published, emits declarations, carries `api/render-core.api.md`.

## Commands

```bash
pnpm --filter @xplainer/render-core test
pnpm turbo build --filter @xplainer/render-core   # also copies the templates
```

Then the root procedure: `pnpm verify`.

## Invariants

- **The five engine-owned scaffold files are byte-identity fixtures.** Editing a template without
  updating its golden in the same commit fails `AC-7b` (the four inherited wiring files, compared
  against the upstream reference extraction) or `AC-7e` (`Video.tsx` and `Scenes.tsx`, compared
  against xplainer's own goldens). The two sets are different in kind — provenance fixtures versus
  change detectors — and `test/fixtures/README.md` records why.
- **`Video.tsx` diverges from upstream deliberately** ([ADR 0018](../../docs/adr/0018-engine-owns-the-composition-shell.md)).
  Upstream's is agent-owned; ours is engine-owned, mounts the narration audio, the captions track
  and the per-segment sequences, and `explainer_put_source` **refuses to write it**. The upstream
  bytes are kept at `test/fixtures/scaffold/upstream/Video.tsx.max` so the difference stays a tested
  claim rather than a memory.
- **`scaffoldVideo()` never overwrites `Scenes.tsx`**, and restores any engine-owned file that is
  missing or whose bytes differ (`AC-7c`). A second call on the same directory reports all five
  engine names plus `Scenes.tsx` as skipped and changes nothing on disk.
- **`isolatedDeclarations` is on the *build* config**, so `pnpm turbo build` is what surfaces
  `TS9010` — not `typecheck`, and not your editor. `SCAFFOLD_FILES` carries a deliberately widened
  annotation (`readonly (EngineOwnedFile | AgentOwnedFile)[]`); the ordering comment describes the
  values, not the type.
- **A word's end is the server's `end_time`.** Never the next word's `start_time`. The space
  between two Kokoro spans is real silence — a breath, a comma — and a caption stretched across it
  reads as lag. `plan.test.ts` asserts the 100 ms gap the fixture carries survives into
  `captions.json`.
- **Every caption token but the first of the whole track carries a leading space.**
  `@remotion/captions` builds a page by concatenating `text` and cuts a new page by elapsed time,
  never at a segment boundary it cannot see, so two segments routinely share a page. A bare first
  word of a segment welded the burned caption into `segment one.Segment two`;
  `src/narrate/captions.test.ts` holds that boundary against the `adjacent.json` fixture.
- **A segment's spoken length is measured from its PCM frames**, never from its last word's
  `end_time`. A synthesised clip routinely runs past its last word, and a planner that inferred the
  length from the spans would shift every later segment earlier than the audio.
- **Silence is quantised to whole samples in `planSegments()`, and `buildTrack()` writes exactly
  those counts.** That is why `timings.json`'s `totalMs` equals the WAV's own sample count over its
  sample rate; `build.test.ts` asserts the two agree within 1 ms. If either side ever rounds
  independently, the two drift by a fraction of a sample per gap.
- **`src/narrate/wav.ts` reads 16-bit integer PCM only.** Every other encoding is refused by name,
  because a zeroed frame is silence at that depth and is not at 8-bit or in µ-law, so a permissive
  reader would pad the track with clicks instead of failing.
- **A chunk size of `0xffffffff` means "to the end of the payload", and every other overrun is
  still a truncated file.** Kokoro answers `/dev/captioned_speech` from a streaming writer, so both
  its `RIFF` and `data` sizes carry that sentinel even for `stream: false`; reading it as a length
  is what made every live narration fail. The two cases look alike in a header and are opposites in
  a track, so only the exact sentinel is honoured.
- **A dry run is labelled.** `narrate()` reports `mode: "dry_run"` when it estimated rather than
  measured, so nothing downstream can mistake an invented timing for a measured one.
- **`--public-dir` is `public/<slug>`, never the video's source directory.** `Root.tsx` fetches
  `timings.json` and `captions.json` through `staticFile()` at metadata time, so pointing it at the
  source directory does not fail — it renders the `durationInFrames={300}` placeholder, silently.
  `videoPaths()` is the one place the pair is built, which is what keeps them from drifting apart.
- **`materialiseWorkspace()` never overwrites, and never installs.** `package.json` is what a
  package manager recorded `node_modules/` against, so rewriting it from the template on every
  `explainer_create` would un-pin a workspace someone had already installed; and installing is a
  visible step a user takes ([ADR 0005](../../docs/adr/0005-download-on-first-run-chrome-headless-shell-and-tts.md)),
  never something a tool call does. `remotionBinary()` returning `null` — rather than a guessed path
  — is what lets a caller say "run `npm install` in `<root>`" instead of failing inside `spawn`.

## How to add

**A template file:** add it under `template/` or `src/scaffold/templates/`, decide its owner, add it
to `ENGINE_OWNED_FILES` (in `packages/protocol`'s schemas, which is where the list is generated
from) or to `AGENT_OWNED_FILES`, and add its golden fixture in the same commit.

**A preflight check:** add the code to the `PreflightCode` union, emit the problem from
`preflight()`, and test both the firing and the not-firing case.

**A path in the workspace:** add it to `VideoPaths` in `src/workspace.ts` and derive it there from
the root and the slug — never join a path at a call site, because a second place that knows the
layout is a second place that can be wrong about it.

**A narration change:** put the arithmetic in `src/narrate/plan.ts`, which is pure and takes
measured input, and assert it from the fixtures in `test/fixtures/narrate/` — never from a live
server. If the change alters what is written, re-check both documents against
`packages/protocol/schemas/{timings,captions}.json` in `build.test.ts`; those schemas, not this
package, are the contract. A change to the pacing constants is a change to every existing video's
timing, so it needs a changeset that says so.

Finish with `pnpm verify`.
