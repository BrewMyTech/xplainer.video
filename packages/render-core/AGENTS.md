# AGENTS.md — `@xplainer/render-core`

Workspace rules and the post-change procedure: root [`AGENTS.md`](../../AGENTS.md).

## What this package is

Six things that travel together: the **Remotion workspace template** under `template/`, the
**layout of the workspace that template becomes** in `src/workspace.ts`, the **ownership-aware
scaffold generator** under `src/scaffold/`, the **narration port** under `src/narrate/`, the
**grapheme-to-phoneme port** under `src/g2p/`, and the
**render preflight** that refuses an unrenderable job before Chrome is launched.

`src/workspace.ts` is the map: `videoPaths(root, slug)` is the only place `videos/<slug>` and
`public/<slug>` are paired, `materialiseWorkspace()` copies the template files in without ever
overwriting one, and `remotionBinary()` answers `null` for a workspace nobody has installed. It
writes directories and copies files; it spawns nothing, renders nothing and installs nothing.

The narration port is where a scene duration comes from. It synthesises each segment through
`@xplainer/tts-client`, measures the audio it got back, and writes `narration.wav`,
`captions.json` and `timings.json` — the document the composition reads and the one thing
`preflight()` refuses to render without.

The G2P port is what an in-process synthesiser needs before it can speak: English text to
Kokoro's IPA phoneme string, plus a character span per word so the model's own per-token duration
predictions can be accumulated back into word timings. It is pure — no network, no ONNX, no clock,
and no I/O beyond three committed data files under `src/g2p/data/` — and it resolves each word
through **four layers, in this order**: the curated domain lexicon (`data/lexicon.txt`), CMUdict,
a deterministic letter-to-sound ruleset, and a named refusal. It lives here rather than in
`apps/cli` because it is upstream of the narration port and downstream of nothing, and because it
is the same kind of thing this package already holds: pure arithmetic over narration, tested from
committed data rather than from a live server.

| Module | What it owns |
|---|---|
| `g2p/phonemise.ts` | The entry point: tokens in, one phoneme string and one span per word out |
| `g2p/tokenise.ts` | What a word is, which punctuation survives, and which symbols are read aloud |
| `g2p/resolve.ts` | The four layers in order, plus the possessive and compound decompositions |
| `g2p/lexicon.ts` | Layer 1: the parser for `data/lexicon.txt` |
| `g2p/cmudict.ts` | Layer 2: the parser for `data/cmudict.dict`, its variants and its annotations |
| `g2p/letters.ts` | Layer 3a: letter names, and the initialism speller |
| `g2p/lts.ts` | Layer 3b: the context-sensitive ruleset and the stress assignment over it |
| `g2p/numbers.ts` | Digits to English words, so a number never reaches the ruleset |
| `g2p/arpabet.ts` | ARPAbet to IPA, restricted to symbols Kokoro has a token for |
| `g2p/vocab.ts` | The vendored 115-symbol vocabulary, and the refusal that will not drop a symbol |
| `g2p/errors.ts` | `G2pError`: the refusal D5 requires instead of an empty string |

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
`OUT_DIR`, `MEDIA_DIR`, `RENDERED_FILE`, `NARRATION_SPEC_FILE` and their types; and the G2P port —
`phonemise`, `kokoroVocabulary`, `kokoroTokenIds`, `unsupportedSymbols`, `G2pError`, and the types
`Phonemisation`, `WordSpan`,
`DerivedPronunciation`, `PhonemeSource` and `G2pErrorCode`. The Remotion template
itself is not a JavaScript export — it is files, reached through `./template/*`. Neither are the
G2P data files: they are read at runtime through `import.meta.url` and shipped by
`scripts/copy-g2p-data.mjs`.

Published, emits declarations, carries `api/render-core.api.md`.

## Commands

```bash
pnpm --filter @xplainer/render-core test
pnpm turbo build --filter @xplainer/render-core   # also copies the templates and the G2P data
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
- **Every caption *word* but the first of the whole track carries a leading space; punctuation
  never does.** `@remotion/captions` builds a page by concatenating `text` and cuts a new page by
  elapsed time, never at a segment boundary it cannot see, so two segments routinely share a page.
  A bare first word of a segment welded the burned caption into `segment one.Segment two`. The
  exception is a segment whose *first* token is punctuation-only: it cannot fold — the fold extends
  the previous caption's `endMs`, and the previous segment's last word is a whole inter-segment gap
  away — so it is emitted as its own caption and emitted bare, or `"Alpha"` and `", beta"` read as
  `"Alpha , beta"`. `src/narrate/captions.test.ts` holds both halves: the boundary against the
  `adjacent.json` fixture, and the two token orders against plans it spells out.
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
  — is what lets a caller say "run `xplainer setup --workspace`" instead of failing inside `spawn`.
- **`package-lock.json` is a member of `WORKSPACE_FILES`, and that is what makes the install
  possible.** `npm ci` — the command both ends of the pinned resolution run, the staged payload at
  build time and `xplainer setup --workspace` on a user's machine — exits `EUSAGE` in a directory
  with no lockfile. So the two files travel together, placed by the one function that places the
  template, rather than by whichever installer happens to run next. Adding a file here changes
  `WORKSPACE_FILES`, which is exported, so it changes this package's API report as well.

- **Nothing the G2P emits may fall outside Kokoro's 115-symbol vocabulary.** The model has no
  error path for an unknown symbol: it drops it, so a stray ASCII `g` where `ɡ` (U+0261) belongs
  turns "go" into "oh" with nothing anywhere saying so. `src/g2p/vocab.test.ts` enumerates every
  symbol every layer can produce — the ARPAbet table at each stress level, the letter names, every
  phone the ruleset can emit, and every line of `data/lexicon.txt` — and asserts each is a key in
  the vendored tokenizer. `kokoroTokenIds()` refuses rather than skipping, which is the last line
  rather than the first.
- **A word the G2P cannot pronounce is a named error, never an empty string** (plan D5). Upstream
  Kokoro builds its G2P with `unk=` and filters the result, so an out-of-dictionary word vanishes
  from the audio; in a product where the narration fixes every scene boundary that is a correctness
  defect. `G2pError` carries the word as a field so the fix — one line in `data/lexicon.txt` — is
  mechanical.
- **A pronunciation that was derived rather than looked up is returned, not logged.**
  `phonemise()` answers with `derived`, and the narration worker decides where those go. A pure
  function that logs has a hidden dependency on somebody's logger, and a guess that announces
  itself is the thing that keeps D8's fallback compatible with D5.
- **The stress mark goes immediately before the vowel, in all four layers.** `kˈæʃt`, never
  `ˈkæʃt`. That is misaki's convention and therefore Kokoro's, and it is what ARPAbet produces
  naturally. `data/lexicon.txt` is written to the same convention on purpose: a term that
  graduates from the initialism speller into the lexicon must not change how it sounds.
- **Affricates and diphthongs are single characters, and the ARPAbet table is the only place that
  may decide it.** `CH` is `ʧ`, `JH` is `ʤ`, and `EY`/`AY`/`OW`/`AW`/`OY` are misaki's `A`/`I`/
  `O`/`W`/`Y`. Kokoro was trained against misaki, and it reads a two-symbol sequence as two
  segments: measured against misaki's own string, the affricate region stretches ×1.70 in 24 of 24
  occurrences and the diphthong ×1.66 in 18 of 18. **Never add a contraction pass over a finished
  IPA string** — English has genuine `t`+`ʃ` and `ɔ`+`ɪ` sequences that are character-identical
  ("nutshell" `nˈʌtʃˌɛl`, "drawing" `dɹˈɔɪŋ`), and contracting them gives "nu-chell" and
  "droy-ing". ARPAbet still separates `CH` from `T SH`, so the table gets it right by construction.
  `cmudict.test.ts` §"the affricate against the genuine cluster" is what fails if somebody tries.
  The hand-written `data/lexicon.txt` is the one layer that could regress by habit, so
  `lexicon.test.ts` forbids the sequences there outright — and forbids every upper-case letter but
  those five, because `Q`, `S` and `T` also have token ids and would tokenise cleanly while
  meaning something else.
- **Layer 1 beats CMUdict, not just the fallback.** CMUdict carries `sql` and `mac`, and its
  readings of them are not the ones a narration about software wants. The lexicon is allowed to
  correct the dictionary and not only to extend it, which is why it is first.
- **The G2P data files are read at runtime and must ship byte-identical.** They are resolved
  relative to `import.meta.url`, so `scripts/copy-g2p-data.mjs` puts a copy beside
  `dist/g2p/*.js`, `package.json`'s `files` names `dist/g2p/data/*`, and
  `scripts/check-publish-contract.mjs` lists all four under `MUST_SHIP_FILES` with `identicalTo`.
  `cmudict.LICENSE` is there for a different reason from the other three: CMUdict is 2-clause BSD
  and clause 1 requires the notice to travel with the source.

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

**A pronunciation:** put it in `src/g2p/data/lexicon.txt`, in the section it belongs to, with a
gloss, and say the gloss out loud before you commit it. An entry that is wrong is worse than no
entry — layer 3 would at least have reported that it was guessing. If you are correcting something
the letter-to-sound ruleset produced, add a spot-check to `lexicon.test.ts` too, because the
ruleset will happily keep producing it for the next word that looks the same.

**A letter-to-sound rule:** add it to `RULES` in `src/g2p/lts.ts`, in its letter's group, ABOVE
every rule it must beat — order is the whole design there, and a rule in the wrong place is not a
syntax error, it is a rule that never fires. Assert it in `lts.test.ts` through the phones it
produces, with a real English word a reader can say out loud, and check that no case already in
that file changed.

Finish with `pnpm verify`.
