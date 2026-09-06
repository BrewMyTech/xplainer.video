# 0018. The engine owns the composition shell; the agent writes scenes

- Status: accepted
- Date: 2026-09-05
- Deciders: @rishavanand
- Settled by: external architecture review of the scaffold, 2026-09-05 (recorded as
  interview Round 12, a post-consensus amendment) — "the file the agent rewrites is the same
  file that mounts the audio"
- Amends, but does **not** supersede, [ADR 0007](0007-mcp-tool-contract-and-put-source.md):
  its eight-tool contract and its schema-as-source-of-truth rule stand unchanged; what this
  record adds is who may write which file. ADR 0007 carries a dated addendum pointing here,
  and both records stay `accepted`.

## Context and Problem Statement

ADR 0007 fixed *how* the agent hands source over. It said nothing about *which* files the
agent may hand over, because the `max` reference implementation says nothing either. An
outside architecture review of this scaffold found the defect that follows from that silence,
and it is not hypothetical.

`explainer_create` scaffolds five files. Four of them — `index.ts`, `types.ts`, `Root.tsx`,
`Captions.tsx` — are wiring the agent is told to leave alone. The fifth, `Video.tsx`, is
scaffolded as an agent-owned stub carrying a `REPLACE THIS` banner, and it does four jobs in
one file:

1. draws the outer `<AbsoluteFill>`;
2. lays out one `<Sequence>` per measured narration segment;
3. mounts the voiceover — `<Sequence name="Narration"><Audio src={staticFile(timings.audio)} /></Sequence>`;
4. mounts the caption track — `<Sequence name="Captions"><Captions captions={captions} /></Sequence>`.

Its doc comment **asks** the agent to keep (2), (3) and (4): "The wiring below (audio,
captions, per-segment Sequences) is the part that must stay." That request is the only thing
protecting the soundtrack.

**The failure it permits is ordinary, not exotic.** "Make the title smaller" is an edit to the
picture. The agent is told to replace this file wholesale, so it rewrites the file, and (3)
and (4) — two lines that have nothing to do with the title and everything to do with the
audio — are precisely what a picture-focused rewrite drops. The render then succeeds. A
silent, caption-less MP4 ships, and nothing in the pipeline notices, because nothing in the
pipeline is looking. The still looks right. The job exits zero.

A second defect, verified in the schemas rather than inferred, compounds it: the
`explainer_put_source` input schema constrains `path` against directory traversal and against
nothing else, so the agent can write `Root.tsx` and `Captions.tsx` too. **Path-traversal
restrictions establish where a file may be written; they never establish who owns it.**

The underlying mistake is an ownership boundary drawn in a doc comment. A comment is a
request, and a request is not a contract.

## Decision Drivers

- **A silent video must be an unreachable state, not an unlikely one.** The current design
  makes it reachable by the most common edit request there is.
- **Expressiveness must not be narrowed to buy safety.** Explainer content is open-ended —
  the whole product bet (spec §Goal, and SKILL.md's "show the mechanism") is that the agent
  designs something specific to *this* subject. Anything that constrains what a scene may
  contain attacks the product, not the bug.
- **`Root.tsx`, `types.ts`, `Captions.tsx` and `index.ts` must stay byte-identical to
  `max`.** AC-7's provenance assertion is the only thing tying this scaffold to a
  working reference implementation, and it is the safety net for this very change.
- **One rule, one place.** ADR 0007 established that both MCP surfaces assert against the
  manifest and never against each other. A reserved-file list restated in four codebases
  drifts the same way two hand-written contracts drift.
- **Failures must be loud in the direction that matters.** Missing audio is invisible in a
  still and fatal in a ship. A missing scene is visible in the first still and harmless.
  These two deserve opposite treatment.

## Considered Options

1. **Keep the doc comment, add a lint or a reviewer step.** Ask harder.
2. **Post-render probe only:** let the agent own `Video.tsx`, and assert after rendering that
   the MP4 carries a non-silent audio stream.
3. **The engine owns the composition shell.** `Video.tsx` becomes engine-owned and mounts
   audio, captions and the per-segment sequencing; the agent writes a new `Scenes.tsx` and the
   components it imports, which the engine places.
4. **A constrained component library.** Ship a fixed set of vetted scene components —
   `TitleCard`, `Timeline`, `StateMachine`, `CodeExcerpt`, `BarChart` — and let the agent
   compose only those.
5. **A structured scene document.** The agent writes JSON, not TSX: a declarative scene
   description that a fixed renderer interprets.

## Decision Outcome

Chosen: **option 3 — the engine owns the composition shell.**

`Video.tsx` stays at the same path, keeps the same `Video` export and the same props
(`{ timings: Timings | null; captions: Caption[] }`), so `Root.tsx` needs no change and keeps
its byte-identity with `max`. What changes is authorship. The engine's copy mounts the
narration and the captions **at the exact bytes `max` mounts them**, lays out one `<Sequence>`
per measured segment, and imports the agent's work through one fixed module specifier:

```tsx
import * as authored from "./Scenes";
const agent: SceneModule = authored;
```

The agent's new entry file, `Scenes.tsx`, exports `scenes: Record<string, React.FC<SceneProps>>`
— one component per narration segment id — plus two optional whole-composition layers,
`Backdrop` and `Overlay`. It is scaffolded once, as an **empty** map, and never overwritten.
Empty is deliberate: a stub containing an example key would throw the unknown-id error against
any real narration, whereas an empty map renders every segment as a visible `MissingScene`
placeholder — obviously unfinished, never silently wrong.

Order and duration come from `timings.segments` and are not reachable from agent code; binding
comes from the record key. The agent expresses **which** scene, never **when** or **how long**.
That is the same discipline the old `at(id)` helper asked for by convention, made structural.

Options 1 and 2 were rejected on the first driver. Option 1 is what exists today and is the
defect. Option 2 catches the silent video after minutes of rendering, needs `ffprobe` in the
render image, and — decisively — leaves the bad state reachable rather than removing it; it is
retained as an optional belt at roadmap phase 1, not as the fix.

### The option not taken, and why it matters most

**Options 4 and 5 were considered seriously and rejected: a constrained component library, or
a structured scene schema.** Both would have solved the defect completely — an agent that
cannot write TSX cannot delete an `<Audio>` tag — and both would have solved it by removing
the product.

Explainer content is **open-ended**. The subject is a race condition today, a billing model
tomorrow, a build graph the week after. SKILL.md's own guidance — show a timeline that plays,
a token stalling in a state machine, two lanes drifting against one clock, a value
conspicuously not changing — is a list of things a *fixed component set cannot contain*,
because the next subject needs the visual that was not on the list. A component library
becomes the bottleneck the moment the video needs something its authors did not foresee, and
the failure is not a compile error the agent can route around; it is a worse video, shipped,
with no signal that a better one was possible. The same argument applies to a JSON scene
document with more force, since a schema is a component library with the escape hatch welded
shut.

So the boundary is drawn at the narrowest place that still fixes the bug. **A scene remains
arbitrary React.** There is no registry, no component allow-list, no scene schema, no
constrained props. The one capability removed is the ability to write the file that mounts
`<Audio>` and `<Captions>`.

The claim that expressiveness is unchanged is checkable rather than rhetorical, and it rests
on three facts:

- **The props are a strict superset.** A scene receives `{ segment, timings, captions }`. The
  old agent-owned `Video.tsx` received `timings` and `captions`, and had to find its own
  `segment` by hand.
- **The z-order is identical.** `Overlay` renders above the scenes and below the caption
  layer, which is exactly where the old file's content sat — its segment `Sequence`s all
  preceded the `Captions` `Sequence`.
- **The two whole-composition layers exist solely to preserve what the old outer
  `<AbsoluteFill>` could do**: a background behind everything, and an element spanning the
  whole video. Cut them and the change *would* narrow expressiveness, and this paragraph would
  have to be softened.

### A structured scene document remains available later — as a fast path, not as a fix

Option 5 is **deferred, not dead**. A declarative scene document is a plausible future
addition as an *optional* fast path alongside hand-written TSX: for the common shapes — a
title card, a bullet reveal, a code excerpt with a moving highlight — a short JSON block would
cost fewer tokens to author, render more consistently across videos, and let a non-agent
client (the desktop app, a web editor) produce a scene without an LLM in the loop.

Two things are recorded so a later reader does not mistake its purpose:

1. **It would be a cost-and-consistency measure, not a correctness one.** Correctness is
   settled here, by ownership. If a structured document is added later and any part of its
   justification is "it stops the agent breaking the audio", that justification is already
   spent — the audio is already unreachable from agent code.
2. **It must arrive as an additional scene *kind*, never as a replacement for TSX.** A
   `Scenes.tsx` entry that resolves to a declarative document and one that is hand-written
   React must be able to sit side by side in the same video. The moment the fast path becomes
   the only path, the rejection reasoning above applies in full and the product loses the
   open-endedness it exists for.

### Enforcement: four layers, one list

The reserved list is authoritative in exactly one place — a new top-level `engine_owned_files`
in `packages/protocol/schemas/manifest.json`, generated into `ENGINE_OWNED_FILES` for both
TypeScript and Python beside `TOOL_NAMES` (ADR 0007). Nothing restates it; `render-core`
derives it from `@xplainer/protocol`. Exactly five exact relative paths are reserved —
`index.ts`, `types.ts`, `Root.tsx`, `Captions.tsx`, `Video.tsx` — so a nested `scenes/Root.tsx`
is the agent's and stays writable.

1. **JSON Schema.** `explainer_put_source.input.json`'s `path` keeps its traversal pattern and
   gains a sibling `not`/`enum`. `not`/`enum` rather than a negative lookahead, because
   pydantic v2 compiles patterns with the Rust regex engine, which has no lookaround.
2. **Server runtime, at the tool boundary.** A pre-dispatch guard in `createMcpServer()`,
   registered once so every backend inherits it. **All-or-nothing**: if any file in the batch
   names a reserved path, the whole call is refused and nothing is written, so the agent never
   lands half a change. It fails as an MCP tool error (`isError: true`) carrying
   `ENGINE_OWNED_PATH`, the rejected paths, the full reserved list and `written: []` — written
   to be recoverable on the first retry rather than to be looped on.
3. **The filesystem writer.** Whichever backend implements `put_source` re-checks after path
   resolution. Layer 2 guards the MCP door; layer 3 guards the disk, for callers that reach
   the backend by another route.
4. **Render preflight.** Engine-owned files are derived output, so a file that differs from
   its template is restored from the template and warned about. This is the only layer that
   covers `write_source_to`, where the agent writes with its own tools and no MCP guard can
   see it.

### Loud failure, in the direction that matters

The structural change is the fix: `<Audio>` and `<Captions>` now appear only in a file the
agent cannot write, so "the agent removed the soundtrack" stops being a reachable state. The
gates cover the remaining cause, which is narration that was never produced.

A pure `preflight(videoDir, publicDir)` — spawning nothing, so it fits `render-core`'s
scaffold-phase charter and is unit-testable today — reports `NARRATION_MISSING`,
`CAPTIONS_MISSING`, `CAPTIONS_EMPTY`, `AUDIO_MISSING`, `AUDIO_EMPTY`, `SCENES_MISSING` and
`ENGINE_FILE_ALTERED`, each with a code and a fix sentence, failing a job in a second rather
than after minutes of rendering. Inside the composition, an absent `timings.audio` and an
empty `captions` array both throw, covering the still path, the Studio path and a
present-but-corrupt file. The null-`timings` branch stops rendering a black frame — the same
visual a genuinely broken render produces — and becomes a `NotNarratedYet` card.
`Root.tsx`'s `calculateMetadata` already aborts the render when either JSON file is absent,
and is named here as a **load-bearing gate** so a later refactor does not "simplify" those
fetches into the component.

A missing *scene* is deliberately **not** a hard failure. `MissingScene` draws the segment id
and the words "no scene" on the frame, so the iterate-one-scene-at-a-time workflow keeps
working. A blank scene is visible in the first still; silent audio is not.

## Consequences

- **The scaffold is six files, split by ownership, derived from one list.** Five engine-owned
  in `max`'s original order, plus `Scenes.tsx` appended last so the first five keep their
  positions and `created`/`skipped` ordering stays recognisable.
- **`explainer_create` stops being purely additive, and that is a deliberate narrowing of a
  property `max` advertises.** The agent-owned file keeps the never-overwrite rule — the
  agent's work always survives a re-`create` — but an engine-owned file that is missing *or*
  whose bytes differ from the template is rewritten and reported in a new `restored` array on
  `ScaffoldResult` and on `explainer_create`'s output schema. That is what ownership means:
  engine files are derived output, not user state. Read as a regression against the reference
  implementation it would look like one, which is why it is stated here and in AC-7c rather
  than left to be discovered.
- **AC-7 splits into two different guarantees, and the difference is not cosmetic.** For the
  four inherited files a golden means "these are `max`'s bytes" — provenance. For `Video.tsx`
  and `Scenes.tsx`, which xplainer authored, a golden can only mean "these are the reviewed
  bytes; editing the template without updating the fixture in the same commit fails the test"
  — change detection. A golden regenerated from the template it tests proves nothing about
  provenance. `test/fixtures/README.md` records the split, and **regenerating all six fixtures
  in one loop would silently convert `max`'s provenance assertion into a tautology.**
- **The divergence from `max` is recorded as a test, not as prose.** `max`'s original
  `Video.tsx` bytes are retained at `test/fixtures/scaffold/upstream/Video.tsx.max`, and a test
  asserts both that the template differs from them and that the difference is the *intended*
  one — audio, captions and per-segment sequencing present in the engine file and absent from
  the agent file. An edit that moved audio back into the agent's file fails it. The repo
  already uses this device: `protocol.test.ts` carries
  `describe("the deliberate divergences from max")` for ADR 0007's dropped `command` field.
- **`render-core` gains its first runtime dependency, `@xplainer/protocol`.** Both are
  `open-later`, so ADR 0003's tier rule holds, but it adds a build-order edge in Turbo and
  makes `render-core`'s tests depend on protocol's generated output. A stale protocol build now
  breaks `render-core` rather than only itself.
- **The `Video.tsx ↔ Scenes.tsx` cycle exists only in the type graph.** `Scenes.tsx` imports
  its `SceneMap` type with `import type`, which erases at compile time. Written as a value
  import, some bundler configurations emit a real runtime cycle and `agent.scenes` can read as
  `undefined` at module-init. The scaffolded stub uses `import type`, and so must every
  snippet in SKILL.md.
- **The generated types are not the enforcement.** `json-schema-to-typescript` and
  `datamodel-code-generator` both ignore `not`, so the generated TypeScript type and the
  pydantic model still describe `path` as a plain string. The runtime guard carries a doc
  comment saying why it exists despite the schema, because a reader who mistakes the generated
  types for the gate will read the guard as redundant and delete it.
- **An unknown segment id is now a hard render failure.** An agent that renames a narration
  segment, re-narrates and forgets `Scenes.tsx` gets a failed render where it previously got a
  subtly wrong picture. That is the intended trade, and it is why the error names both the
  offending key and every valid id — an error that does not costs a retry cycle.
- **The hosted tier can still ship without this guard.** `apps/api`'s eight tools are
  placeholders in this phase, so only the generated constant and a pytest pinning it to the
  schema land in Python now. **The obligation is recorded here:** whoever implements
  `explainer_put_source` on the hosted control plane implements layers 2 and 3 with it, using
  the same `ENGINE_OWNED_PATH` code string.
- **`write_source_to` remains an unguarded path, knowingly.** Between a direct local write and
  the next render, the workspace can hold a tampered engine file; only the preflight's restore
  closes it, and only at render time. The alternative — withdrawing `write_source_to` — costs
  the local ergonomics ADR 0007 bought on purpose.
- **`Scenes.tsx` and the `scenes/` directory sit side by side.** They cannot collide on a
  case-insensitive filesystem, but the pairing reads as confusing. `Storyboard.tsx` is the
  fallback name if the confusion is judged worse than the extra syllable.
- **SKILL.md's ownership paragraph becomes a statement of fact rather than a request**, and it
  ships byte-for-byte into both plugin bundles (ADR 0013). Its rewrite must keep every tool
  name it mentions inside the protocol set, or AC-10's check fails.
