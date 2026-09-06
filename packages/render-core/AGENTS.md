# AGENTS.md — `@xplainer/render-core`

Workspace rules and the post-change procedure: root [`AGENTS.md`](../../AGENTS.md).

## What this package is

Four things that travel together: the **Remotion workspace template** under `template/`, the
**ownership-aware scaffold generator** under `src/scaffold/`, the **narration port** under
`src/narrate/`, and the **render preflight** that refuses an unrenderable job before Chrome is
launched.

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
`DEFAULT_VOICE`, `NARRATION_AUDIO_FILE`, `TIMINGS_FILE`, `CAPTIONS_FILE`. The Remotion template
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
- **A dry run is labelled.** `narrate()` reports `mode: "dry_run"` when it estimated rather than
  measured, so nothing downstream can mistake an invented timing for a measured one.

## How to add

**A template file:** add it under `template/` or `src/scaffold/templates/`, decide its owner, add it
to `ENGINE_OWNED_FILES` (in `packages/protocol`'s schemas, which is where the list is generated
from) or to `AGENT_OWNED_FILES`, and add its golden fixture in the same commit.

**A preflight check:** add the code to the `PreflightCode` union, emit the problem from
`preflight()`, and test both the firing and the not-firing case.

**A narration change:** put the arithmetic in `src/narrate/plan.ts`, which is pure and takes
measured input, and assert it from the fixtures in `test/fixtures/narrate/` — never from a live
server. If the change alters what is written, re-check both documents against
`packages/protocol/schemas/{timings,captions}.json` in `build.test.ts`; those schemas, not this
package, are the contract. A change to the pacing constants is a change to every existing video's
timing, so it needs a changeset that says so.

Finish with `pnpm verify`.
