# Scaffold fixtures — provenance

`src/scaffold/scaffold.test.ts` compares every file `scaffoldVideo()` writes
against a fixture in `scaffold/`, with `Buffer.compare`. The fixtures do not all
carry the same guarantee, and the distinction is deliberate: conflating them
would let a regenerated file pass as evidence of something it cannot prove.

| Fixture | Kind | What a passing test proves |
| --- | --- | --- |
| `scaffold/index.ts.golden` | provenance | still byte-identical to the upstream scaffold |
| `scaffold/types.ts.golden` | provenance | still byte-identical to the upstream scaffold |
| `scaffold/Root.tsx.golden` | provenance | still byte-identical to the upstream scaffold |
| `scaffold/Captions.tsx.golden` | provenance | still byte-identical to the upstream scaffold |
| `scaffold/Video.tsx.golden` | change detector | still the reviewed xplainer bytes |
| `scaffold/Scenes.tsx.golden` | change detector | still the reviewed xplainer bytes |
| `scaffold/upstream/Video.tsx.max` | retained upstream | what the upstream `Video.tsx` was, kept so the divergence stays checkable |

## Provenance fixtures — the four inherited files

These four were extracted once from the reference implementation and are never
authored here. AC-7b is the assertion that carries provenance.

| | |
| --- | --- |
| Source | A private predecessor project by the same author, from which xplainer's render wiring and its TTS contract were derived. It is not published and this repository does not name it. |
| File | `server/explainer_mcp.py` |
| Symbol | `_SCAFFOLD` (`explainer_mcp.py:254-260`), which maps each filename to `_INDEX_TS`, `_TYPES_TS`, `_ROOT_TSX`, `_CAPTIONS_TSX` and `_VIDEO_TSX` |
| Commit at extraction | `d11615e19f138984960b0466a9a3a720cd9f6b96` |

The file, the symbol, the line range and the commit are kept because that *is*
the provenance and it costs nothing to state precisely. Only the location is
withheld.

**Say the honest thing about what AC-7b proves.** It asserts that four files are
byte-identical to code in a repository a reader of this one cannot open. The
assertion is real — it runs on every `pnpm --filter @xplainer/render-core test`,
it is byte-for-byte, and it fails loudly if the generator drifts — but it is
**not independently reproducible** from this repository alone. What it protects
is that these four files stay what they were when they were reviewed, which is
worth having on its own. What it cannot do is let a stranger re-derive them.

Extracted once with, where `$UPSTREAM` is the checkout of that repository at the
commit above:

```sh
python3 -c "import sys;sys.path.insert(0,'$UPSTREAM/server');import explainer_mcp as m,pathlib;[pathlib.Path('packages/render-core/test/fixtures/scaffold',k+'.golden').write_text(v) for k,v in m._SCAFFOLD.items()]"
```

Re-extract only when the upstream wiring contract deliberately changes, and
record the new commit above in the same edit. **Do not re-run that one-liner as
written.** It loops over `_SCAFFOLD` and would overwrite `Video.tsx.golden`,
which no longer comes from upstream — see below.

## Change detectors — the two xplainer-authored files

`Video.tsx.golden` and `Scenes.tsx.golden` are copies of
`src/scaffold/templates/Video.tsx.txt` and `Scenes.tsx.txt`. A golden
regenerated from the template it tests cannot prove where the bytes came from;
it can only prove they have not changed since review. That is what AC-7e claims
and all it claims: editing either template without updating its fixture in the
same commit fails the test.

Regenerate one of these by hand, one file at a time — never with a loop over the
template directory, which would also flatten the four provenance fixtures into
self-referential copies of their own templates and silently retire the only
assertion tying this package to its upstream:

```sh
cp packages/render-core/src/scaffold/templates/Video.tsx.txt \
   packages/render-core/test/fixtures/scaffold/Video.tsx.golden
```

## The retained upstream copy

`scaffold/upstream/Video.tsx.max` holds the upstream `Video.tsx` bytes,
unchanged from commit `d11615e1`. It is not scaffolded and not compared against
generator output. It exists because `Video.tsx` is the one file xplainer
deliberately diverges on (ADR 0018): the upstream copy was agent-owned, carried a
"REPLACE THIS" banner, and also mounted `<Audio>` and `<Captions>`, so an agent
rewriting it for a visual reason shipped a silent video.

The divergence suite in `scaffold.test.ts` uses this file to assert both that the
divergence is real and that it is the intended one — audio, captions and
per-segment sequencing present in the engine-owned `Video.tsx` and absent from
the agent-owned `Scenes.tsx`. That encodes the *reason* for the divergence, which
a refreshed golden cannot: an edit walking the change back would fail even if
both goldens were dutifully updated alongside it.

> **On the `.max` suffix.** It is a leftover shorthand for the upstream project,
> and it appears in this one filename and in several test names in
> `scaffold.test.ts`. It names nothing a reader can look up, but it is a residual
> reference to a repository this one does not name, and renaming it — the file,
> the constant in `scaffold.test.ts`, and the test titles, in one commit — is
> open follow-up work. It was left alone here because a documentation pass must
> not silently change bytes a byte-identity test reads.

## Why the `.golden` and `.max` suffixes

The fixture text imports `remotion`, `@remotion/captions`, `@remotion/media` and
`../../tailwind.css`. None of the four is a dependency of
`@xplainer/render-core` — they are dependencies of the generated Remotion
workspace described by `template/package.json`. Left as `.ts` and `.tsx`, both
`tsc` and Biome would pull these files into their graphs, try to resolve all
four specifiers, and take `pnpm turbo build lint typecheck test` (AC-2a) down
with them. The suffix keeps every tool out.

Belt and braces, this directory is excluded twice over:

- `packages/render-core/tsconfig.json` and `tsconfig.build.json` list
  `test/fixtures` under `exclude`;
- the root `biome.json` carries `!packages/render-core/test/fixtures` inside
  `files.includes`, alongside the matching negation for
  `src/scaffold/templates`.

Either exclusion alone would do today. Both are written down so that a future
glob change in one tool cannot quietly pull the fixtures back into a type graph.

The suffix changes the filename and never a byte of content: the comparison in
`scaffold.test.ts` stays byte-for-byte, and `.gitattributes` pins
`* text=auto eol=lf` so it still holds on a Windows checkout (AC-13c).

## Narration fixtures — `narrate/`

`src/narrate/*.test.ts` read these. They exist so the narration port can be tested against real
audio and real-shaped word timings with no Kokoro container anywhere.

| Fixture | What it is |
| --- | --- |
| `narrate/narration.json` | A three-segment narration script: a spoken hook, a silent `beat` with `holdSeconds: 2`, and a spoken `cause` with `holdSeconds: 3`. Every pacing branch in one document. |
| `narrate/hook-words.json` | Kokoro-shaped `{word, start_time, end_time}` spans for the hook, including a 100 ms silence between `build` and `was` and a trailing `?` as its own token. |
| `narrate/cause-words.json` | The same for `cause`, ending in a `.` token. |
| `narrate/hook.wav` | 2.35 s of mono 16-bit PCM at 24 kHz — deliberately longer than the last word's `end_time`, which is what makes "measure the frames, do not infer from the spans" a testable claim. |
| `narrate/cause.wav` | 0.75 s of the same, at a different frequency. |
| `narrate/adjacent.json` | A two-segment narration script, both segments spoken, whose words spell the string `captions.test.ts` asserts on. It exists because the caption weld between adjacent segments needs two *spoken* neighbours, which `narration.json`'s silent middle segment deliberately denies it. |
| `narrate/one-words.json` | Kokoro-shaped spans for `adjacent.json`'s first segment: `Segment`, `one`, and a trailing `.` as its own token. |
| `narrate/two-words.json` | The same for its second segment: `Segment`, `two`, `.`. |

The three `adjacent*` fixtures carry no WAV. `captions.test.ts` never decodes audio — it passes
`planSegments()` a measured `spokenMs` directly — so a WAV there would pin nothing and would only
invite the arithmetic to be re-derived from it.

**The two WAVs were written by Python's standard-library `wave` module**, which is the encoder the
reference implementation reads and writes with — deliberately not by this package's own
`encodeWav()`. A reader tested only against its own writer proves that two bugs agree; these prove
the reader handles a container it did not produce. They hold a quiet sine rather than silence, so
`decodeWav()` returning zeroes would fail rather than pass.

Regenerate them only if the arithmetic they pin deliberately changes, and update the millisecond
constants in `plan.test.ts` in the same edit — `HOOK_SPOKEN_MS` and `CAUSE_SPOKEN_MS` are those
files' real durations, and the assertions are written out as arithmetic rather than as snapshots so
a changed fixture fails loudly instead of re-baselining itself.

```sh
uv run --no-sync --project packages/protocol python - <<'PY'
import math, struct, wave
for name, seconds, freq in (("hook", 2.35, 220.0), ("cause", 0.75, 330.0)):
    frames = int(round(24000 * seconds))
    data = b"".join(
        struct.pack("<h", int(8000 * math.sin(2 * math.pi * freq * n / 24000)))
        for n in range(frames)
    )
    with wave.open(f"packages/render-core/test/fixtures/narrate/{name}.wav", "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(data)
PY
```
