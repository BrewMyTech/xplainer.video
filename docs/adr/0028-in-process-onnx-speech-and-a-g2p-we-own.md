# 0028. Speech runs in the narration worker on ONNX, and the grapheme-to-phoneme layer is ours

- Status: accepted
- Date: 2026-09-10
- Deciders: @rishavanand
- Settled by: `.omc/plans/ralplan-speech-onnx.md`, approved 2026-09-10. It **supersedes**
  `ralplan-speech-bundle.md` — three revisions, two Architect reviews and one Critic review of a
  plan that packaged Kokoro-FastAPI as a native per-OS bundle. The two spikes it gated on are
  written up in `.omc/artifacts/spike-speech-onnx.md`, which also carries a dated correction of its
  own audio. Neither document is public; [`README.md` §Provenance](README.md#provenance) is where
  citations of this kind resolve.
- Amended by dated note, and neither body rewritten:
  **[ADR 0006](0006-kokoro-fastapi-http-contract-as-tts-interface.md)**, whose driver "the same
  contract must be satisfiable by a hosted container and by a per-OS local install, so it has to be
  a **network contract**, not a library API" has lost its premise; and
  **[ADR 0005](0005-download-on-first-run-chrome-headless-shell-and-tts.md)**, whose
  download-on-first-run decision this is the speech half of, finally implemented.
- Builds on: **[ADR 0023](0023-split-the-repository.md)** — the hosted tier's relocation is what
  removed ADR 0006's second backend; **[ADR 0022](0022-open-source-the-published-packages.md)** —
  the published packages are Apache-2.0, so a copyleft component in the closure is a licence
  problem and not a preference; **[ADR 0027](0027-relocatable-runtime-artefact-and-the-supervisor-switch.md)** —
  the acquired-toolchain machinery, the payload boundary and the verify-then-`rename` commit this
  reuses rather than reinvents; and
  **[ADR 0018](0018-engine-owns-the-composition-shell.md)** — narration and captions belong to the
  engine, which is why a word that goes missing is the engine's defect and nobody else's.
- **Every number below is a measurement**, from the three commits that carry the work — `83db21c`
  (the G2P), `ce26d75` (acquisition), `f0af433` (the synthesiser) — their changesets, or the spike
  artefact. Where a figure moved between the spike and the finished code, the later one is used and
  the earlier one is named.

## Context and Problem Statement

Phase 2 left the local tier with two speech routes and a hole. `--tts-url` records a
Kokoro-FastAPI server somebody else already runs; the `docker` route pulls the pinned
`ghcr.io/remsky/kokoro-fastapi-cpu` image by digest. Both work on macOS and Linux. On **Windows
neither is available** — the image is `linux/amd64` and a Windows host need not have an engine that
runs one, and `--tts-url` acquires nothing — so `P2-4` is *pending on Windows* and the milestone
named to close it was a phase-4 artefact: a native speech bundle per platform, published behind a
custom domain that no command in this repository uploads to.

That bundle was planned, reviewed three times, and would not have shipped. **The obstruction is not
the model. It is grapheme-to-phoneme.**

**Neural speech needs phonemes, not letters, and G2P is where the open-TTS ecosystem keeps its
copyleft.** espeak-ng is the de-facto implementation and is GPL-3.0-or-later. Kokoro reaches it
through `misaki[en]`, which hard-depends on `phonemizer-fork` (**GPLv3+**) *and* on
`espeakng-loader` — MIT Python whose wheels ship the GPL espeak-ng binary and its data, confirmed by
unzipping one. So the planned native bundle was a Python closure with a GPL component inside it,
distributed by us, from packages whose own licence is Apache-2.0 (ADR 0022). Piper is the same trap
and harder: its development repository is `OHF-Voice/piper1-gpl`, GPL-3.0, and states that it
embeds espeak-ng for phonemization. The espeak question was never an optional refinement of the
bundle plan; it was structural, and the plan could not have avoided it by leaving espeak out.

**And leaving espeak out does not degrade the audio — it deletes words.** `kokoro/pipeline.py`
constructs its G2P with `unk=''`, and `model.py` then filters away any symbol outside the
115-symbol vocabulary. Without the espeak fallback an unknown word becomes the empty string and
**vanishes from the audio**, logging a warning nobody reads. In this product narration is the source
of truth for every frame range — `timings.json` measures scene durations from word-level timestamps
and captions are burned from the same spans (ADR 0006, ADR 0018) — so a word that is silently
absent is a correctness bug that surfaces, if at all, as a video whose pacing is subtly wrong. That
is the finding that produced **D5**: *no configuration of this product may silently drop a word from
narration.* D5 is a rule about the product and it outlives whatever engine satisfies it.

The question this record answers is therefore not "which TTS" but: **is there a speech path that
returns word-level timestamps, needs no espeak, ships nothing copyleft, and reaches every platform
the CLI does?**

## Decision Drivers

- **Word-level timestamps are still non-negotiable.** ADR 0006's first driver is untouched by
  anything here. Without them `timings.json` cannot be computed and captions cannot be aligned.
- **No copyleft component may be fetched, shipped or linked** — a consequence of ADR 0022, not a
  taste. A GPL binary inside an artefact `xplainer setup` downloads is the same problem as one
  inside a tarball we publish.
- **Nothing silent.** D5. An unresolved word must be a named refusal, and a pronunciation derived
  rather than looked up must be announced.
- **The npm tarball and payload 1 must not grow**, and `AC-1d` forbids anything that downloads at
  install time — including a dependency's own `postinstall`, on the user's machine rather than ours.
- **One code path for every platform.** The superseded plan's cost was a four-platform build matrix;
  the reason Windows had no speech was that a per-platform artefact had not been built and published
  for it. Anything that reintroduces per-platform builds reintroduces that failure mode.
- **The existing port must not change shape.** `resolveSpeech()` already returns a
  `SpeechSynthesiser` with two implementations. A third is a contained change; a new contract is not.

## Considered Options

1. **Kokoro-82M as an ONNX graph in this process, with a G2P we write** —
   `onnx-community/Kokoro-82M-v1.0-ONNX-timestamped` (Apache-2.0) on ONNX Runtime (MIT), phonemes
   from a curated lexicon → CMUdict (2-clause BSD) → a deterministic letter-to-sound ruleset →
   a refusal.
2. **The plan of record: package Kokoro-FastAPI natively, per OS.** Four platform builds, standalone
   CPython, a wheel closure, `patchelf` and `install_name_tool` relocation, several-hundred-megabyte
   archives, an R2 publish workflow with a credential, and a manifest generator.
3. **sherpa-onnx.** A mature, permissive C++ runtime with prebuilt binaries.
4. **Piper.**
5. **Kyutai TTS 1.6B.**
6. **pocket-tts for audio plus CTC forced alignment over `wav2vec2-base-960h` for timings** — two
   models, no G2P anywhere in the stack.
7. **Some other forced aligner** over whichever engine: `MMS_FA`, CrisperWhisper,
   `ctc-forced-aligner`'s default model, `aeneas`, `whisper-timestamped`.
8. **Keep the two existing routes and leave Windows without speech until phase 4.** The status quo,
   which is a real option and was the recorded plan.

**Option 2 is not distributable as designed**, per §Context. Its Python closure carries
`phonemizer-fork` (GPLv3+) and an espeak-ng binary; removing them deletes words. This is why the
plan behind it was superseded rather than revised.

**Option 3 fails on the one requirement that is not negotiable.** sherpa-onnx's TTS C API returns
**no timestamps at all** — audio and nothing else — so it would have to be paired with option 7,
and it statically links espeak anyway. It also ships only `.tar.bz2`, a third archive format.

**Option 4 is GPL-3.0** and embeds espeak. **Option 5 has no CPU path**, which ends it for a local
tier that must run on an ordinary laptop.

**Option 6 works and is the recorded fallback rather than the choice.** Measured word-boundary error
against exact model durations is **47–49 ms**, about a frame and a half at 30 fps; the weights are
MIT and, decisively for the licence question, `wav2vec2-base-960h` has a **character** vocabulary,
so no G2P exists in it to license. What it costs is two models, two failure modes and *estimated*
rather than exact timing — which is precisely the objection ADR 0006 raised against **its own third
option** five days earlier: "forced alignment adds a second model and a second failure mode to the
one number the whole render depends on". pocket-tts also has no upstream timestamps and CC-BY-4.0
weights. It is written down in the plan §9 so that the decision is ready if option 1 ever stops
holding.

**Option 7's field is mostly unusable and it is a licence problem, not a quality one.** `MMS_FA`,
CrisperWhisper and `ctc-forced-aligner`'s default model are **CC-BY-NC** — non-commercial, which
this product is not. `aeneas` and `whisper-timestamped` are **AGPL**. That includes `aeneas` by
name, which ADR 0006 offered by hand as one of the two aligners in its third option.

**Option 8 is what this record rejects, and the reason it can be rejected is that option 1 costs
less than the milestone it replaces.** The phase-4 bundle needed a publish workflow, a credential,
a connected custom domain and a Cache Rule — infrastructure nobody had scheduled — to close one
platform. Option 1 closes it with the same code that serves every other platform.

## Decision Outcome

Chosen: **option 1.** Speech runs inside the narration worker, on an ONNX Runtime `xplainer setup`
acquires, with a grapheme-to-phoneme layer this repository owns. No Python, no espeak, nothing
copyleft, and word timings from the model's own duration predictor.

```
workers/narrate.ts (existing child process, existing process group, existing drain)
  └── resolveSpeech()
        ├── fixture           (existing)
        ├── KokoroClient      (existing — --tts-url and the docker route, both unchanged)
        └── OnnxSynthesiser   (new: apps/cli/src/speech/)
              ├── @xplainer/render-core's G2P (packages/render-core/src/g2p/)
              ├── ONNX Runtime, acquired for this platform only
              └── word spans accumulated from `durations`, the per-token predictor output
```

### Why this model, and not merely this format

`onnx-community/Kokoro-82M-v1.0-ONNX-timestamped`, revision
`dd4401a9add81ac692d20e240d22ec9dda82cc29`, Apache-2.0, exports a second output beside the audio:

```
INPUTS : input_ids int64[1,seq]   style float32[1,256]   speed float32[1]
OUTPUTS: waveform  float32[1,n]   durations float32[1,seq]
```

`durations` is the duration predictor's own per-token output — the same mechanism Kokoro-FastAPI
uses internally to build the `timestamps` array ADR 0006 pinned. Accumulated across each word's
token span it yields word start and end times **from the model that produced the audio**, not from
a second model's estimate of it. That is the whole reason this export was chosen over any other
Kokoro ONNX conversion, and it is the requirement ADR 0006 wrote down and this record inherits
unchanged.

### The G2P, and D5 made mechanical (`83db21c`)

`packages/render-core/src/g2p/` resolves a word through four layers, in order:

1. a **curated domain lexicon**, 272 entries, committed as reviewable data with a gloss on every
   line — "nginx" is *engine X*, "PostgreSQL" is *post-gres-Q-L*, and no rule about English would
   ever produce either;
2. **CMUdict**, vendored verbatim under its 2-clause BSD licence;
3. a **deterministic letter-to-sound ruleset** plus an initialism speller, both of which report what
   they derived so the caller can log it;
4. a **named refusal** carrying the word — never an empty string.

**The lexicon is layer 1 and not a polish item, and coverage is why.** CMUdict covers **50 of 50**
words of ordinary narration prose and **5 of 47** software terms — 11%. Missing: `Kubernetes`,
`nginx`, `OAuth`, `PostgreSQL`, `TypeScript`, `idempotent`, `webhook`, `systemd`, `npm`, `gRPC`,
`YAML`, `ONNX`, `Remotion` and 29 more. The honest framing is that **espeak-ng guesses at these
too**: a curated lexicon is not a workaround for having no phonemizer, it is the only way to be
reliably right about this product's actual subject matter.

**D5 holds mechanically rather than by intention**, at both ends. `phonemise()` refuses a word no
layer can pronounce, carrying the word as a field so the fix is one line of `data/lexicon.txt`; and
`kokoroTokenIds()` refuses a phoneme outside the 115-symbol vocabulary rather than dropping it,
asserted over every symbol every layer can emit. The second half is not redundant with the first:
the model has no error path for an unknown symbol either, so a stray ASCII `g` where `ɡ` (U+0261)
belongs turns "go" into "oh" with nothing anywhere saying so. Nothing in this path can produce
Kokoro's own `unk=''`.

**D8** decides the long tail in favour of the deterministic ruleset over the Apache-2.0 neural
fallback, for predictability: the same word always yields the same pronunciation, it needs no second
model, and it is reviewable. What keeps it compatible with D5 is that a guess announces itself —
`phonemise()` *returns* what it derived and the narration worker logs it to the job's output, rather
than the pure function acquiring a hidden dependency on somebody's logger. An auditable guess
replaces an unauditable one, and never silence.

One detail is load-bearing and is recorded here because it is invisible in the finished IPA. The
ARPAbet table emits misaki's single-character affricates and diphthongs (`ʧ ʤ A I O W Y`) rather
than `tʃ dʒ eɪ aɪ oʊ aʊ ɔɪ`, because Kokoro was trained against misaki and reads a two-symbol
sequence as two segments: measured, the affricate region stretches **×1.70 in 24 of 24**
occurrences and the diphthong **×1.66 in 18 of 18**, and a sentence with eight of them ran **9.5%
long**. The table is the only place that can make the distinction correctly — English has genuine
`t`+`ʃ` and `ɔ`+`ɪ` clusters ("nutshell", "drawing") that are character-identical to the fused
forms in IPA, so a contraction pass over the finished string would mispronounce them. ARPAbet is the
last representation that still separates `CH` from `T SH`.

### D6 — the duration-to-seconds conversion is derived per run, and may never be written down

`durations` is in units whose size depends on the request. The published figure for this model is
`duration / 80`; the spike measured a divisor of ≈40 (592.3 samples per unit at 24 kHz), derived
twice from independent runs — and the finished work then measured **583 samples per unit at speed
0.8 and 1042 at speed 4**, because the predictor floors at one unit per token. The ratio moves by
79% across the speaking-rate range the port accepts. A researched constant of 80 was wrong by a
factor of two; the 592.3 this session measured would have been right only at speed 1.

So samples-per-unit is computed as `waveform.length / Σ durations` for the inference in hand, which
makes the timings agree with the audio whatever the unit means. `deriveWordTimings` refuses rather
than emit timings that disagree with the audio it was given: a durations array not aligned with the
tokens fed, a non-finite or negative duration, a zero sum, a ratio outside 50–5000, a word span
covering no token, overlapping spans, spans running backwards. This is the arithmetic every caption
and every scene boundary rests on, and a wrong constant here would be a silent, systematic drift.

### D7 — ONNX Runtime is an acquired toolchain component, not an npm dependency (`ce26d75`)

`onnxruntime-node` declares **no `optionalDependencies`** and carries five platforms in one
package — `darwin/arm64` 88,043,128 bytes, `linux/x64` 45,116,232, `linux/arm64` 24,932,672,
`win32/x64` 66,310,760, `win32/arm64` 71,871,080, and no `darwin/x64` at all — so depending on it
would put **296,273,872 bytes** of foreign-platform binaries into payload 1's closure and into every
global install. It also declares a `postinstall` that fetches a **191,730,792-byte** CUDA package
from `api.nuget.org` on `linux/x64`, on the user's `npm install` rather than on ours. `AC-1d` forbids
that outright, and it cannot be turned off from inside this repository.

Microsoft's per-platform release archives are not the alternative the spike assumed. They carry the
C shared library, the headers and the CMake package, and **no `onnxruntime_binding.node`** — the
N-API binding exists only inside the npm package — and the two are different builds of the same
version (28,497,752 bytes against 44,726,808 on `linux/x64`), so the halves cannot be mixed. So
`setup` fetches the npm tarball, keeps this platform's `bin/napi-v6` subtree plus Microsoft's `dist/`
loader verbatim, and places `onnxruntime-common` where that loader's own `require` resolves it: no
`NODE_PATH`, no symlink, no reimplemented glue. The same bytes cross the wire either way; a third of
them stay on disk. Measured end to end on darwin-arm64: **39.7 s** to acquire all four artefacts,
16 files and 88,062,119 bytes taken out of the 296 MB archive, 181,392,041 bytes committed, and the
acquired tree loads through `createRequire` and answers `waveform[1,33600]` / `durations[1,9]` on
the pinned voice.

**D2 is unchanged and D3 is not needed.** Every artefact comes from its own upstream home, pinned by
revision and digest — the model graph and voice pack from HuggingFace, the runtime from the npm
registry — so this project hosts none of it, and the CDN, the R2 credential and the publish workflow
the superseded plan required do not exist in this one rather than being solved.

## Consequences

- **The narration worker is 2.6× realtime and peaks at 747 MB RSS on darwin-arm64, which matches the
  route it replaces.** 15.68 s of audio from 418 tokens in 5,950 ms here, against 16.35 s in 5,720 ms
  through Docker Kokoro on 2026-09-07. ONNX Runtime Web was measured and rejected on the same
  machine: 1.0× realtime with SIMD and four threads, 1019 MB, against WASM's one appeal — a single
  4.7 MB artefact identical on every platform. Speech is already the slowest thing a user waits on.
  **747 MB in a worker is high and is now a recorded budget rather than a discovery**, and these are
  one platform's numbers: Windows and Linux are unmeasured, which the plan's AC 6 asks for and this
  record does not claim.
- **Windows has a speech route for the first time, and it arrives by the same code as every other
  platform.** `win32-x64` and `win32-arm64` are both in `onnxruntime-node`'s published set, so the
  asymmetry `P2-4` recorded has gone rather than become unreachable — but it has not been *run*
  there. The route exists; the platform evidence does not. Nothing external prevents it: the
  repository is public and Actions has been running since 2026-09-09, when every Phase 2 proof went
  green on all three platforms. The gap is simply that `e2e-speech.yml` has to reach `main` before
  `workflow_dispatch` can register it, and then be dispatched.
- **An Intel Mac is refused by name, before a byte moves.** `onnxruntime-node` ships no
  `darwin/x64` binding at all, so the `onnx` route reports itself unavailable there. `darwin-x64`
  keeps the two routes it already had — this takes nothing away from it — but it is now the
  narrowest platform in the product: no in-process speech here, and no supported desktop installer
  at all, which `P2-2` records for its own reason.
- **The daemon supervises no speech process, and the plan's whole process-lifecycle workstream
  disappeared rather than being built** (D4, dissolved). Narration already runs in a spawned child
  in its own process group, covered by the existing drain; speech became a library call inside it.
  Readiness, port discovery, a breaker and a supervised child were all deleted from the plan.
- **A clip comes back untrimmed, 8–13% longer than the same sentence from Kokoro-FastAPI, and that
  is a decision rather than an oversight.** That server trims; this does not, because the head is a
  noise floor below **−66 dBFS** rather than digital silence and the first phoneme's onset begins
  *before* the boundary the duration predictor implies — so a trim needs an audibility threshold,
  and a threshold set slightly wrong clips a phoneme, which is unrecoverable where untidy padding is
  not. Roughly 0.32–0.49 s of near-silence before the first phoneme and 0.19 s after the last.
  **The padding does not move the timings**, which is what makes leaving it in safe: they are
  absolute offsets into the clip as delivered, and the first word's `start_time` lands 13–41 ms
  (mean 29 ms) after the audible onset — under a frame and a half at 30 fps. Pacing stays
  `@xplainer/render-core`'s `LEAD_IN_MS` / `GAP_MS` / `TAIL_MS`, which apply to every engine.
- **The curated lexicon is a maintained asset now, and nothing retires it.** 272 entries is a
  starting position rather than a finished set: every new subject area this product narrates will
  contain terms CMUdict has never seen, and D8 means those are **pronounced by rule and announced as
  derived** rather than refused — audible, deterministic, reviewable, and for software vocabulary
  frequently wrong, because no rule about English produces *engine X* from `nginx`. The maintenance
  loop is therefore reading what the ruleset announced and promoting the terms that matter into
  layer 1, and it is worth being blunt about the trade D8 made: a wrong lexicon entry is worse than
  no entry, because layer 3 would at least have said it was guessing. A refusal is the last layer
  and now rare; the recurring cost is the review.
- **The style vector is indexed, not sliced, and the spike that missed this is corrected in place.**
  A voice pack is 510 rows of 256 float32 chosen by utterance length. Reading row 0 — what the S0b
  prototype did, and what the brief written from it said — gives audio that is fluent,
  self-consistent, quieter and **17.1% wrong on length, 30.6% at worst**: a 112-token sentence in
  4.83 s where the reference takes 6.95 s. Row `len-1` is Kokoro's own choice and lands within 0.3%.
  The general lesson is recorded because it will recur: a plausible-sounding generative output is
  not evidence, and the only thing that caught this was a side-by-side against the reference
  implementation speaking the same phoneme string.
- **The `onnx` route sits below `docker` and above `bundle` in `setup`, decided against the proofs
  rather than by preference.** `scripts/e2e/toolchain.mjs` opens `marker.speech.path` *as the docker
  receipt* on any machine whose `docker version` answers, so an `onnx`-first order would have that
  gate parse a 92 MB model. At run time the precedence is `XPLAINER_TTS_FIXTURE`, then a server
  somebody **named** (`XPLAINER_TTS_URL` or `KOKORO_URL`), then the in-process engine, then the
  tts-client's own `localhost:8880` default — a server that was named wins because naming one was an
  intention, and the default is a guess.
- **`toolchain.json` stays at `format_version: 1`.** The component gains an optional `files[]`
  recording every acquired path with its digest, so the install preflight checks all of them rather
  than the four it used to whitelist. An older build reads the marker exactly as before.
- **`NOTICE` gains four components, and the two halves of that list are not the same kind of thing.**
  **Redistributed** by `@xplainer/render-core`, so their notices travel inside the tarball: CMUdict
  (`cmudict.dict`, 2-clause BSD, with its licence copied beside it because clause 1 requires exactly
  that) and the model's tokenizer (`kokoro-tokenizer.json`, Apache-2.0, as the authoritative list of
  symbols the model accepts). **Fetched and never redistributed**, so `NOTICE` says where they come
  from and what they must hash to rather than carrying them: the Kokoro weights and voice pack
  (Apache-2.0, from the HuggingFace repository, pinned by revision and digest) and ONNX Runtime
  (MIT, from the npm registry, this platform's build only).
- **A warm cache is re-verified rather than trusted**, which is a fix to a defect that predates this
  work and is independent of it: `acquireSpeechBundle` skipped the download **and the verification**
  when its destination already existed, then recorded the digest it had merely been told. Because
  the destination was named after the *version*, a re-published artefact at an unchanged version
  would have been served from that cold cache for ever. Cache identity now binds the digest, and
  every committed acquisition carries a record inside the tree it commits that a later run
  re-verifies. Nothing records a digest it did not observe.
- **Two archive readers are now ours.** The npm tarball needs a tar reader, and this repository
  hand-wrote its zip reader rather than take a runtime dependency on the publish path; the same
  argument applies, so `setup/tar.ts` is ours and tested. It **streams**, because `gunzipSync` on
  that tarball would hold 111 MB compressed and 296 MB decompressed in two live Buffers at once.
- **`services/tts-sidecar` and `@xplainer/tts-client` keep their jobs.** The Docker route is
  unchanged, `--tts-url` is unchanged, the pinned image is still pinned by digest, and ADR 0006's
  contract is still the contract for anything that speaks over a network. This adds a route; it
  retires none.
- **One licensing question is recorded rather than assumed away.** misaki's 90k gold and silver
  pronunciation dictionaries carry no documented provenance and no `NOTICE`. Nothing here depends on
  them, and nothing here should start to without an answer.
- **The proof is `pnpm e2e:speech`, and it sits outside `pnpm verify`** as every proof in
  `scripts/e2e/` does and for the same reason: it renders a real video. What the plan's S6 asks of
  it is that on a machine with **no Docker, no `--tts-url` and no Python**, `setup` acquires the
  artefacts and `narrate → still → render` produces a real MP4 — `ffprobe` for streams and duration,
  `timings.json` and `captions.json` for word timing, a frame diff against a captions-disabled
  render — plus the assertion the superseded plan's proof did not know it needed: that a script full
  of out-of-dictionary technical terms produces audio in which **every word is present**. It lands in
  this batch; this record does not report a run of it, and the roadmap row is where platform
  evidence is named.

## Note on the three reviews of the plan this supersedes

Recorded because the cost is easy to read as waste and was not. The superseded bundle plan went
through two Architect reviews and one Critic review — roughly an hour — which caught four blocking
defects and prompted the question that led here. Four things from it survive into this record
because they were right about the product rather than about the plan: **D5**, which came from
discovering how the old path fails; the warm-cache verification defect, which was real independently
of any of this; the rule that a failure must be visible rather than silent; and the licence-gate
discipline, which is much cheaper now that the closure is small. What the reviews prevented is the
four-platform build matrix being built, at four platforms' expense, before anyone discovered that
its Python closure was GPL and that its espeak decision deleted words.

## Note, 2026-09-10: the product now selects this route, and `onnx` moved above `docker`

This record was written while the engine worked and the product did not choose it. Two sentences
above are amended, and nothing else in this record changes.

**The sentence "The `onnx` route sits below `docker` and above `bundle` in `setup`, decided against
the proofs rather than by preference" is amended: the order is now `--tts-url`, `onnx`, `docker`,
`bundle`.** The reasoning that put `onnx` second-to-last was sound about the proof and wrong about
the product. It was sound about the proof: `scripts/e2e/toolchain.mjs` opens `marker.speech.path`
*as the docker receipt* on any machine whose `docker version` answers, so an `onnx`-first order would
have had that gate `JSON.parse` 92 MB of model graph. It was wrong about the product, because the
consequence — stated in the record and in the module and still true when read back — was that **no
machine with a container engine ever took the in-process route**. That is the machine class this
whole record exists for: the reason to build any of it is that a user should not need Docker for a
voiceover, and an ordering under which every Docker user keeps the container delivers that to nobody
who already had an alternative. The fix is that the gate now *names* the route it is proving
(`setup --speech docker`) instead of inferring it from a precedence it does not own — which is the
better arrangement independently, since a proof whose subject is decided elsewhere is one reordering
away from proving something else.

**Two things were added with the swap, because a reordering that moves a working machine is not an
improvement.** First, `--speech <route>`, over the two routes that acquire something: a route
somebody names is an instruction like `--tts-url` is, so a named route that is unavailable is a
refusal naming why and never a fall-through. Second, **a recorded, still-working `docker` route
keeps the machine it is on.** `setup` is re-runnable by design and a re-run is the worst moment to
move a machine's narration onto a different engine: the container is running, it is what every
previous narration was spoken by, and the switch would fetch ~204 MB from three hosts to replace
something that works. So a recorded `docker` component whose image `docker image inspect` can still
address takes the route again, `setup` prints that it did and names `xplainer setup --speech onnx`,
and a machine that has *lost* its engine falls through and gets the in-process route — which is the
migration arriving when the container has stopped being the answer. The rule is deliberately narrow
rather than "whatever the marker says wins": `docker` is the only provider this reordering displaces,
and a general rule would freeze a machine on a `--tts-url` receipt for ever. Every route not taken is
now printed on a successful run too, and the two reasons are different sentences — a route *above*
the one taken was probed and said why, a route *below* it was never asked.

**The run-time sentence "the precedence is `XPLAINER_TTS_FIXTURE`, then a server somebody named
(`XPLAINER_TTS_URL` or `KOKORO_URL`), then the in-process engine, then the tts-client's own
`localhost:8880` default" is amended in its third step only: the in-process engine is found by
reading `toolchain.json`.** As accepted, `resolveSpeech()`'s locator defaulted to
`onnxSpeechFromEnvironment`, so the engine `setup` had acquired spoke only for a caller who exported
`XPLAINER_ONNX_MODEL`, `XPLAINER_ONNX_VOICE` and `XPLAINER_ONNX_RUNTIME` — which means **a daemon on
a machine that had run `setup` could not find its own engine**, and `pnpm e2e:speech` supplied the
three variables by hand out of the marker `setup` had just written. `setup/speech-locate.ts` is the
reader the seam was declared for; the three variables stay, above it, as the way to point the engine
at a model no `setup` acquired, and every locator now reports *which* of the two answered so the
worker's provenance line can say. The proof's three lines are deleted and it asserts the marker's
own path on that line instead, so a regression that put the engine back behind three variables makes
it unable to narrate at all.

One consequence of reading a marker at all: the state directory is a **setting**, so the daemon now
puts its own into the narration worker's environment. A worker resolving it for itself would take
the platform default on exactly the supervised machines `serve --state-dir` exists for — all three
settings travel in argv on every platform because Task Scheduler's `<Exec>` action has no
environment map — and would narrate against a container while a daemon two directories away had
acquired an engine.
