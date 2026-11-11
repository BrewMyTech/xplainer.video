# Scaffold fixtures — provenance

`src/scaffold/scaffold.test.ts` compares every file `scaffoldVideo()` writes
against a fixture in `scaffold/`, with `Buffer.compare`. The fixtures do not all
carry the same guarantee, and the distinction is deliberate: conflating them
would let a regenerated file pass as evidence of something it cannot prove.

| Fixture | Kind | What a passing test proves |
| --- | --- | --- |
| `scaffold/types.ts.golden` | provenance | still byte-identical to the upstream scaffold |
| `scaffold/index.ts.golden` | change detector (provenance until 2026-11-11) | still the reviewed xplainer bytes |
| `scaffold/Root.tsx.golden` | change detector (provenance until 2026-11-11) | still the reviewed xplainer bytes |
| `scaffold/Captions.tsx.golden` | change detector (provenance until 2026-11-11) | still the reviewed xplainer bytes |
| `scaffold/Video.tsx.golden` | change detector | still the reviewed xplainer bytes |
| `scaffold/Scenes.tsx.golden` | change detector | still the reviewed xplainer bytes |

> **Note, 2026-11-11 — provenance ended by construction for three of the four inherited files.**
> The scaffold stopped importing the previous renderer's packages: `index.ts`, `Root.tsx`,
> `Captions.tsx` and `Video.tsx` now import `@xplainer/motion`, the authoring API the renderer in
> `@xplainer/cli` resolves from its own install. Upstream's files import the old packages, so from
> that edit on no xplainer template that imports anything can be byte-identical to upstream, and a
> fixture claiming so would be a fixture that had to be regenerated from its own template to pass
> — a change detector wearing a provenance label. So `index.ts`, `Root.tsx` and `Captions.tsx` are
> change detectors from this date, and **`types.ts` is the one provenance fixture left**: it
> imports nothing, so it is still the upstream bytes and AC-7b still means what it says for it.
> (`Captions.tsx` had already stopped being upstream's bytes on the release that made captions
> break on sentences; its row kept the provenance label regardless. This note retires that too.)
>
> **The retained upstream `Video.tsx` went with them.** `scaffold/upstream/Video.tsx.max` held the
> upstream bytes so `scaffold.test.ts` could assert the shipped `Video.tsx` differs from them. Once
> the template's import lines changed, it differs by construction and that assertion could not
> fail, so the file and the two cases that read it were deleted. The *reason* for the divergence
> (ADR 0018) is still asserted, as content: audio, captions and per-segment sequencing present in
> the engine-owned `Video.tsx` and absent from the agent-owned `Scenes.tsx`.

## Provenance fixtures — the inherited files

These were extracted once from the reference implementation and are never
authored here. AC-7b is the assertion that carries provenance. Since
2026-11-11 it covers `types.ts` alone (see the note above); the extraction
record below is kept because it is still where that file came from.

| | |
| --- | --- |
| Source | A private predecessor project by the same author, from which xplainer's render wiring and its TTS contract were derived. It is not published and this repository does not name it. |
| File | `server/explainer_mcp.py` |
| Symbol | `_SCAFFOLD` (`explainer_mcp.py:254-260`), which maps each filename to `_INDEX_TS`, `_TYPES_TS`, `_ROOT_TSX`, `_CAPTIONS_TSX` and `_VIDEO_TSX` |
| Commit at extraction | `d11615e19f138984960b0466a9a3a720cd9f6b96` |

The file, the symbol, the line range and the commit are kept because that *is*
the provenance and it costs nothing to state precisely. Only the location is
withheld.

**Say the honest thing about what AC-7b proves.** It asserts that `types.ts` —
four files until 2026-11-11 — is byte-identical to code in a repository a reader
of this one cannot open. The assertion is real — it runs on every
`pnpm --filter @xplainer/render-core test`, it is byte-for-byte, and it fails
loudly if the generator drifts — but it is **not independently reproducible**
from this repository alone. What it protects is that the file stays what it was
when it was reviewed, which is worth having on its own. What it cannot do is let
a stranger re-derive it.

Extracted once with, where `$UPSTREAM` is the checkout of that repository at the
commit above:

```sh
python3 -c "import sys;sys.path.insert(0,'$UPSTREAM/server');import explainer_mcp as m,pathlib;[pathlib.Path('packages/render-core/test/fixtures/scaffold',k+'.golden').write_text(v) for k,v in m._SCAFFOLD.items()]"
```

**Do not re-run that one-liner.** It loops over `_SCAFFOLD` and would overwrite
every golden but `Scenes.tsx.golden` with upstream bytes — including the four
that no longer come from upstream, see below.

## Change detectors — the xplainer-authored files

`index.ts.golden`, `Root.tsx.golden`, `Captions.tsx.golden`, `Video.tsx.golden`
and `Scenes.tsx.golden` are copies of the matching `src/scaffold/templates/*.txt`.
A golden regenerated from the template it tests cannot prove where the bytes
came from; it can only prove they have not changed since review. That is what
AC-7e claims and all it claims: editing a template without updating its
fixture in the same commit fails the test.

Regenerate one of these by hand, one file at a time — never with a loop over the
template directory, which would also flatten `types.ts.golden` into a
self-referential copy of its own template and silently retire the only
assertion tying this package to its upstream:

```sh
cp packages/render-core/src/scaffold/templates/Video.tsx.txt \
   packages/render-core/test/fixtures/scaffold/Video.tsx.golden
```

## Why the `.golden` suffix

The fixture text imports `@xplainer/motion`, `react` and `../../tailwind.css`.
None of the three is a dependency of `@xplainer/render-core` — the renderer in
`@xplainer/cli` resolves the two packages from its own install, and the
stylesheet sits at the root of the workspace a video is scaffolded into. Left as
`.ts` and `.tsx`, both `tsc` and Biome would pull these files into their graphs,
try to resolve all three specifiers, and take
`pnpm turbo build lint typecheck test` (AC-2a) down with them. The suffix keeps
every tool out.

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
