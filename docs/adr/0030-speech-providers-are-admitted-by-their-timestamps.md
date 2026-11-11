# 0030. Speech providers are admitted by their timestamps, and the machine's owner chooses one

- Status: accepted
- Date: 2026-11-11
- Deciders: @rishavanand
- Settled by: the specification for this work, `.omc/autopilot/spec.md` on branch
  `feat-tts-providers`. Fable wrote its decisions D1–D12; Codex answered the same questions
  independently (round 1) and then accepted or objected to the lead's resolution of each (round 2);
  its §11 *Consensus record* is binding where it differs from D1–D12. That file was never committed
  to either repository, so **everything it settled is restated below**, including which side won each
  disagreement and why, and nothing in this record needs it to resolve.
- Amends, by dated note and without rewriting either body:
  **[ADR 0006](0006-kokoro-fastapi-http-contract-as-tts-interface.md)** — its fourth Decision
  Driver, *"Self-hostable and open-weight, because the local tier must work with no account and no
  per-character billing"*, and its sentence *"Option 2 was rejected for the local tier on cost and
  self-hostability, not on quality; it remains available as a future hosted-only upgrade behind the
  same client interface"*; and **[ADR 0020](0020-always-running-local-daemon.md)** — R-SEC-5 and
  R-SEC-6, which now govern a second credential.
- Builds on: **[ADR 0028](0028-in-process-onnx-speech-and-a-g2p-we-own.md)** — its D5, *no
  configuration of this product may silently drop a word from narration*, is the rule a remote
  provider is held to; **[ADR 0018](0018-engine-owns-the-composition-shell.md)** — narration and
  captions are the engine's, which is why a word that goes missing is the engine's defect;
  **[ADR 0007](0007-mcp-tool-contract-and-put-source.md)** — the tool contract this record adds no
  field to.
- **What ElevenLabs documents was read on 2026-11-11, and what it does was measured the same day**
  by the lead against the live API (pay-as-you-go tier, voice `JBFqnCBsd6RMkjVDRZzb`,
  `output_format=pcm_24000`). Where the two disagree the measurement is used, and the disagreement
  is named.

## Context and Problem Statement

Narration speaks through Kokoro today, by one of three routes — in-process ONNX
([ADR 0028](0028-in-process-onnx-speech-and-a-g2p-we-own.md)), a Kokoro-FastAPI server, or a
fixture directory — all behind one port in `@xplainer/render-core`:
`SpeechSynthesiser.captionedSpeech(request) → { audio: base64 WAV, timestamps: WordTimestamp[] }`.
Everything below that port — `decodeWav`, `planSegments`, `buildCaptions`, `buildTimings` — is
built from **measured** word spans. `timings.json` takes every scene's frame range from them and
`captions.json` is burned in from the same spans, so a voice that cannot say when each word was
spoken is not a lesser voice for this product; it is one this product cannot narrate with at all.
That is [ADR 0006](0006-kokoro-fastapi-http-contract-as-tts-interface.md)'s first driver, and
nothing here weakens it.

Users asked for a better-sounding voice than Kokoro-82M, and named ElevenLabs. ADR 0006 considered
exactly this as its option 2 — "a hosted commercial TTS API (ElevenLabs, OpenAI, Azure). Better
voices, per-character cost, and a hard problem for the free local tier — plus word timing support
that varies by vendor and by voice" — and rejected it **for the local tier on cost and
self-hostability, not on quality**. Two things have changed since. ElevenLabs now has an endpoint
that answers with timing beside the audio, and the cost objection is answerable by making the
provider the **owner's** choice rather than the product's default.

So the question is not "should the product speak through ElevenLabs" but four narrower ones: what
makes *any* provider admissible, who may choose one, where that choice and its secret live so that
a supervised daemon can read them, and what the product does when the provider fails.

### What the documentation says, and what was measured

From the ElevenLabs documentation, read 2026-11-11:

- [Create speech with timing](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps)
  — `POST /v1/text-to-speech/{voice_id}/with-timestamps`, header `xi-api-key`. Query
  `output_format`, default `mp3_44100_128`, with `pcm_24000` among the values; "PCM and WAV formats
  with 44.1kHz sample rate requires you to be subscribed to Pro tier or above", and `pcm_24000`
  carries no tier note. `model_id` defaults to `eleven_multilingual_v2`; `language_code` "is not
  supported for multilingual_v2 models"; `voice_settings.speed` defaults to 1. The response carries
  `audio_base64` (required) and `alignment` and `normalized_alignment`, **both optional and
  nullable**, each three parallel arrays: `characters`, `character_start_times_seconds`,
  `character_end_times_seconds`.
- [Models](https://elevenlabs.io/docs/models) — `eleven_multilingual_v2` 10,000 characters per
  request, `eleven_flash_v2_5` 40,000, `eleven_v3` 5,000, `eleven_v4` 10,000. The page says nothing
  about which models support with-timestamps.
- [Request stitching](https://elevenlabs.io/docs/eleven-api/guides/how-to/text-to-speech/request-stitching)
  — "not available for the `eleven_v3` model".
- [Speed control](https://elevenlabs.io/docs/eleven-agents/customization/voice/speed-control) —
  0.7 to 1.2, and not available on Eleven v3.
- [Errors](https://elevenlabs.io/docs/eleven-api/resources/errors) — a body of
  `{detail: {type, code, message, status, request_id}}`, to be branched on `detail.code`.
- [Quickstart](https://elevenlabs.io/docs/eleven-api/quickstart) — voice `JBFqnCBsd6RMkjVDRZzb`
  ("George"), the variable name `ELEVENLABS_API_KEY`. No voice is documented as *the* default.

Measured against the live API the same day:

- `eleven_multilingual_v2`, `eleven_flash_v2_5` and `eleven_v4` **all** return a non-null
  `alignment` whose characters, joined, equal the text sent **exactly** — digits and `—` included.
  `normalized_alignment` does not: it turns `—` into `--` and pads the text with spaces.
- **Alignment can run past the audio.** `eleven_v4` returned 4.88 s of alignment over 4.80 s of
  audio; `eleven_multilingual_v2` 3.158 s over 3.1579 s.
- **The error body does not mean what the documentation says.** A `401` arrives as
  `{"detail":{"type":"authentication_error","code":"unauthorized","status":"invalid_api_key",…}}`;
  a `404` carries `voice_not_found` in both fields; a `400` for a bad model is
  `{"detail":{"status":"model_not_found","message":…}}`, with no `code` at all. The specific reason
  is in `status`, not in `code`.

All three responses are committed, as recorded, under `packages/tts-client/test/fixtures/elevenlabs/`.

## Decision Drivers

- **Measured timings or nothing.** ADR 0006's first driver and ADR 0028's D5. A provider that
  returns audio without timings is refused by name, and a provider that returns timings which
  disagree with the script is refused rather than repaired.
- **The person who pays chooses.** ElevenLabs bills per character to an account. An agent must not
  be able to start spending that money, choose a dearer model, or read the key.
- **A supervised daemon must be able to read the choice.** launchd, systemd and Task Scheduler do
  not inherit a shell, and `daemon/workers.ts` gives the narration worker the daemon's environment
  plus `XPLAINER_STATE_DIR`, so a shell `export` never arrives.
- **One credential rule, not two.** R-SEC-5 and R-SEC-6 already say how this repository stores a
  secret.
- **Nothing silent.** A failure is a failed job with a named cause, never a different voice.
- **Kokoro is unchanged.** Its three routes, their precedence and the log lines the end-to-end
  proofs read stay byte-for-byte; `packages/render-core` is not edited.

## Considered Options

1. **A provider level above the Kokoro routes, admitted by its timestamps and chosen by the owner
   in two state-directory files.** ElevenLabs is the first remote provider.
2. **A `provider` argument on `explainer_narrate`.**
3. **Environment variables only** — `XPLAINER_TTS_PROVIDER` and `ELEVENLABS_API_KEY`, no files.
4. **Forced alignment over any provider's plain audio**, so a provider without timestamps becomes
   admissible.
5. **A new workspace member, `@xplainer/tts-elevenlabs`.**

**Option 2 hands the account to whoever is typing the prompt.** Choosing among voices on an
account the owner already enabled costs the same per character; choosing the provider or the model
does not. A field on the tool is also a contract change for every client of a fact the job log can
already carry.

**Option 3 cannot reach the daemon.** A key exported in a shell profile reaches the commands typed
in that terminal and never a LaunchAgent, a user unit or a Scheduled Task, so it would work in
`--spawn` mode and fail under the daemon with no visible difference in configuration.

**Option 4 is ADR 0028's option 6 again, and the objection is the same one.** Forced alignment
adds a second model and a second failure mode to the one number the whole render depends on, and
ADR 0028 measured the permissive candidate at 47–49 ms of word-boundary error. It is not needed:
the endpoint chosen here returns the timing from the model that produced the audio.

**Option 5 costs a member for about three hundred lines** — the ten-member tables, four scripts, a
publish contract and an API report — when the wire half is exactly what `@xplainer/tts-client` is
for, and ADR 0006 already said a commercial API would sit "behind the same client interface".

## Decision Outcome

Chosen: **option 1.**

```
workers/narrate.ts → resolveSpeech()                       (apps/cli/src/workers/speech.ts)
  1. XPLAINER_TTS_FIXTURE set                    → fixture  (unchanged; always wins, never bills)
  2. provider = XPLAINER_TTS_PROVIDER            → else config.json tts.provider → else "kokoro"
  3. provider == "elevenlabs"                    → ElevenLabs; no Kokoro variable is consulted
  4. provider == "kokoro"                        → the existing chain, byte for byte:
       XPLAINER_TTS_URL / KOKORO_URL → XPLAINER_ONNX_* / toolchain.json → tts-client default
```

### The admissibility rule, and where it is enforced

**A provider is admissible only if it returns word- or character-level timestamps with its audio.**
Every provider is declared once, in `TTS_PROVIDERS` in `apps/cli/src/tts/provider.ts`, with the
granularity of the timestamps it returns (`word`, `character` or `none`), whether the narration
text leaves the machine and whether it is billed. The rule is enforced at two points:

- **At configuration**, by name. `xplainer config set tts.provider <name>` refuses a name outside
  the registry, exit `1`, with the sentence every refusal of a provider uses: *speech provider "x"
  is not one this build knows. Admissible providers: kokoro, elevenlabs. A provider is admissible
  only if it returns word or character timestamps with its audio.* A descriptor that declares
  `timestamps: "none"` is refused by `admitProvider` when the registry loads, and a test asserts
  it, so an inadmissible provider cannot be registered by accident.
- **At run time**, on every response. The ElevenLabs client refuses a response whose `alignment`
  is absent, `null` or empty (`alignment_missing`), and every **remote** provider is wrapped in
  `requireWordSpans`, which refuses a segment containing a letter or a digit that came back with
  no spans at all.

### Configuration: two files in the state directory

`<state>/config.json` holds the non-secret settings and `<state>/credentials.json` the API key, both
`{"format_version": 1, "tts": {…}}`, written by a new command group, **`xplainer config`**, with
four verbs — `set`, `get`, `unset`, `list` — over four keys: `tts.provider`, `tts.elevenlabs.voice`,
`tts.elevenlabs.model`, `tts.elevenlabs.api_key`. The state directory is already `0700`, already
travels to the worker, already holds the user's `lexicon.txt`, and is the one store a supervised
daemon reliably reads. The worker reads both files **per job**, so a change takes effect on the next
narration with no restart. An unreadable file — invalid JSON, an unknown `format_version` — is exit
`11` at the command and a failed job at the worker, **never "no config"**: answering "no config"
would turn a typo in a hand-edited file into a silent switch back to Kokoro. Unknown keys are
preserved on write, so an older build cannot erase a newer one's setting.

`XPLAINER_TTS_PROVIDER` overrides `config.json` for the one process it is set in, and
`ELEVENLABS_API_KEY` overrides `credentials.json`. **An `ELEVENLABS_API_KEY` in the environment never
selects the provider**: it only supplies the key once the provider is `elevenlabs`, because a key
left in a shell profile for some other tool must not start billing anyone. `config list` and
`xplainer status` name the origin of every value — `environment`, the file, or `default` — and say
when one comes from the shell, which a supervised daemon does not inherit.

### The key

`credentials.json` is governed by R-SEC-5 and R-SEC-6 exactly as the daemon's bearer token is: mode
`0600` inside the `0700` directory, a temporary file created empty with `wx` at `STATE_FILE_MODE`,
narrowed on Windows by the same `restrictToOwner` call `daemon/windows-acl.ts` makes for the token,
and only then given the key and renamed into place — `daemon/token.ts`'s rotation write, with two
differences that both follow from the key being somebody else's credential. The narrowing comes
**before** the key is written, so no reader the directory's inherited entries admit can open a file
that already holds it; and an `icacls` that fails is a **refusal** — nothing stored, exit `70` —
where for the token it is a warning, because a daemon that will not start is worse than a weaker
token file, and a `config set` that stores nothing costs only a re-run. The key is
never on argv: `xplainer config set tts.elevenlabs.api_key <value>` is **refused, exit `1`, with
nothing written**, and the key arrives through a prompt that does not echo, through stdin when stdin
is not a terminal, or with `--from-env`. It is never printed — `get` and `list` say `set (<origin>)`
or `unset` — and never written to a job record, a request document or a log line; the client
replaces it with `[redacted]` in every message it composes from text it did not write.

**Rejected**, and why: the key in `config.json` (then every `config list`, bug report and
`status --json` needs redaction to be safe — a separate file means the non-secret one has nothing to
redact); an OS keychain (three platform back ends, and a launchd or systemd daemon cannot always
unlock one); `config set <key> <value>` for the secret (shell history and `ps`).

### What an agent may still choose

[`workers/speech.ts`](../../apps/cli/src/workers/speech.ts)'s docblock says of the speech sources,
*"an agent chooses none of them"*. That sentence now covers the provider, the model and the key as
well: **`explainer_narrate` gains no field**, and `narration.json` changes in `description` strings
only. The one thing an agent may still choose is the **voice**, because choosing among voices on an
account the owner already enabled costs the same per character:

- `voice` omitted, or the schema default `af_heart` — which render-core's `speechRequest()` always
  fills in — means the voice the owner configured, `tts.elevenlabs.voice`;
- a value matching `^[A-Za-z0-9]{20}$` is used as an ElevenLabs voice id for that narration;
- **any other value is refused before the first request**, with zero client calls
  (`VOICE_UNSUPPORTED`).
- `speed` `1` sends no `voice_settings`; `0.7`–`1.2` is sent as `voice_settings.speed`; anything else
  is refused before the first request (`SPEED_UNSUPPORTED`).
- `langCode` is ignored, and the job log says so once: Kokoro's codes are a different vocabulary,
  and the default model refuses `language_code`.

### Wire, alignment and audio

**`packages/tts-client/src/elevenlabs/` is wire only** — the payload builder, `ElevenLabsClient` over
the injected `FetchLike`, `ElevenLabsError` and the pure `alignmentToWordTimestamps()`. No audio
handling, no environment, no retry, no workspace dependency. **`apps/cli/src/tts/`** owns the
registry, the selection resolver and `createElevenLabsSynthesiser()`, which wraps the PCM through
render-core's `encodeWav`, bounds spans by the decoded audio, retries and logs. It returns
render-core's existing `SpeechSynthesiser`, so nothing below the port changes and `CHECKED:deps` in
`docs/ARCHITECTURE.md` gains no row. The synthesiser cannot live in tts-client: it needs `encodeWav`,
and render-core already depends on tts-client.

**`alignment`, never `normalized_alignment`.** `alignment` is timed over the characters as sent;
`normalized_alignment` over the service's reading of them, so captions built from it would read
"five dollars" where the script says "$5", and the live measurement above shows it rewriting `—`.
A missing, `null` or empty `alignment` is refused even when `normalized_alignment` is present.

**A word is a maximal run of non-whitespace characters**; it starts at its first character's start
and ends at its **last character's own end** — never the next word's start, which is `plan.ts`'s
load-bearing rule for where silence and caption changes go. Punctuation stays attached
(`"failed."`), the shape the ONNX route emits; a free-standing `—` is its own token and
`buildCaptions` folds it into the previous caption as it does Kokoro's punctuation. The CLI adapter
then compares the alignment's whitespace-split tokens with the text it sent and **refuses on any
difference** (`ALIGNMENT_MISMATCH`, naming the first differing token) — splitting the request text
and mapping times by index would be silently wrong the moment the service dropped one character.

**`output_format=pcm_24000`, fixed.** Raw signed 16-bit mono at 24 kHz is exactly
`DEFAULT_SAMPLE_RATE` and what the Kokoro routes return, so `reconcileFormat` and the template see
nothing new, on every tier. `wav_24000` would hand us a RIFF header we have not seen and
`decodeWav` reads 16-bit PCM only; MP3 needs a decoder; `pcm_44100` needs Pro. An odd byte count is
refused.

**Defaults, and what is not sent.** Model `eleven_multilingual_v2` — the endpoint's documented
default and the one model the documentation positively ties to `speed` and 10,000-character
requests. Voice `JBFqnCBsd6RMkjVDRZzb`, the one ElevenLabs' own quickstart uses. `previous_text`,
`next_text`, `seed`, `language_code` and `pronunciation_dictionary_locators` are **not sent**: the
port carries one segment at a time, support is per model, and every segment is already an
independent utterance separated by `GAP_MS` of silence.

**The lexicon is Kokoro's.** `<state>/lexicon.txt`'s second column is Kokoro's phoneme alphabet and
feeds only render-core's G2P, so under ElevenLabs it is not read; if it holds an entry, the job log
says once that those pronunciations apply to the built-in Kokoro voice only and were not used. The
fix for a mispronounced word under ElevenLabs is respelling it in the narration text.

### Failure: a named job failure, and never Kokoro instead

Every failure is a failed narration job — worker exit `1`, the existing error mapping, **no new
`error_code`** — whose log tail names the cause and the remedy. `narrate()` writes nothing until
every segment has been spoken, so a failed run leaves the previous `narration.wav`, `timings.json`
and `captions.json` intact. **There is no fallback to Kokoro, for any failure.** A fallback would
deliver a video in a voice the owner did not choose, with nothing saying so; a provider configured
with no key stored fails with a sentence naming `xplainer config set tts.elevenlabs.api_key`, saying
that a key exported in a shell does not reach a supervised daemon, and saying how to go back to
Kokoro deliberately.

**Retries are two at most, at 1 s and then 4 s, and only for HTTP `429` and `5xx`** — the failures
the service itself reports as "not now". A `400`, `401`, `402`, `403`, `404` or `422`, and a response
the client or the adapter refuses, is never retried. **Neither is a timeout (120 s) or a transport
error**: either can follow a request the service completed and billed, so the message says the
request may already have been billed and that re-running `explainer_narrate` is the remedy. That
re-run is billed again, in full, from the first segment; a run that fails at segment *k* has paid
for *k*−1 and written nothing. One request at a time, as now. `Retry-After` is not honoured, because
the `HttpResponseLike` seam exposes no headers. There is no spend cap in this version.

**A `5xx` retry is not strictly free either.** A `502` or `504` from a gateway in front of the
service can follow a request the service behind it finished and billed, exactly as a timeout can.
It is retried anyway (C8 in the table below), because a `5xx` is far more often a request that never
completed than one that did; the cost of being wrong is a segment billed twice, at most three times
in all, and the log line each retry writes says that it happened.

The success path names the provider, voice, model and where each came from on its first line, says
`elevenlabs is billed per character to that account` with the character count, and ends
`mode elevenlabs`. **Every Kokoro route's first line and `mode` line, and a dry run's, are
byte-identical to before**, because `scripts/e2e/*.mjs` read them.

### Narration text leaves this machine only when its owner opts in

Under Kokoro nothing leaves the machine after `setup`, and that remains the default. With
`tts.provider` set to `elevenlabs`, the narration text of every non-dry-run narration is sent to
`api.elevenlabs.io`. `config set tts.provider elevenlabs` says so when it is run, and so do the
README and the skill. Nothing else is sent: not the source, not the stills, not the video.

### The consensus record: what each side proposed, and which position stands

Fable wrote the decisions; Codex answered them independently and then reviewed the lead's
resolutions. Where they differed, this is the outcome and the reason.

| | Fable | Codex | Stands | Why |
|---|---|---|---|---|
| **C1** precedence | fixture → provider (env → `config.json` → `kokoro`) → Kokoro chain only under `kokoro`; `config.json` | round 1: `XPLAINER_TTS_URL` / `KOKORO_URL` *above* the configured provider; a `speech.json` | **Fable's**, Codex conceding in round 2 | Those variables are Kokoro *route* settings, not provider settings, and a stale `KOKORO_URL` in a shell profile would silently undo `config set tts.provider elevenlabs`. The log says once when one is set and not consulted |
| **C2** the secret | `credentials.json`, `xplainer config` | `xplainer auth set elevenlabs` and `<state>/credentials/elevenlabs.key` | **Fable's** | Equivalent protection; one command group owns one concept |
| **C3** a voice that is not ElevenLabs' | substitute the configured voice and log it once | refuse it | **Codex's** | A value that is neither the default nor an ElevenLabs id is an explicit request that cannot be honoured, and speaking it in another voice is the silent substitution this record refuses everywhere else. `af_heart` still means "the configured voice", because render-core always fills it in |
| **C4** default voice | `JBFqnCBsd6RMkjVDRZzb` | accepted | **Agreed** | The documentation names no default; this is the quickstart's voice |
| **C5** models | `eleven_multilingual_v2`, others allowed | any id matching `^[a-z0-9_]{1,64}$`, with a warning outside the measured set | **Codex's amendment** | `config set tts.elevenlabs.model` warns, exit `0`, outside `ELEVENLABS_VERIFIED_MODELS` — the three measured above. A model that answers without alignment fails its narration by name, whatever it is |
| **C6** alignment past the audio | not foreseen | refuse a word that starts at or after the audio's end; clamp an end that runs over | **Codex's**, after the measurement | With *D* the decoded duration, a word whose `start_time >= D` is refused (`ALIGNMENT_OUT_OF_BOUNDS`, naming the word, its span and *D*), and otherwise `end_time` becomes `min(end_time, D)`. In the adapter, which knows *D*, not in the pure conversion |
| **C7** ordering | per-character checks | also refuse words whose starts or ends go backwards | **Codex's** | `alignmentToWordTimestamps` refuses a decreasing start or end as `alignment_invalid`; equal times and overlap are accepted, because the service reports both and neither reorders the script |
| **C8** retries | 2 retries on `429`, `5xx`, timeout and network | `429` and `5xx` only | **Codex's** | A timeout or a transport error may follow a request that was billed. `ElevenLabsError.retryable` is true for `429`/`5xx` only |
| **C9** render-core's `mode` | — | leave render-core unedited | **Agreed** | See the first known gap below |
| **C10** zero spans | `requireWordSpans` on every provider | remote providers only | **Codex's** | See the second known gap below |
| **C11** test plan | whitespace-token equality on final captions; the live test asserts duration ≥ last character | strict equality at the adapter; captions assert lexical tokens in order; the live test asserts alignment validity and in-bounds spans | **Codex's** | `buildCaptions` folds a free-standing `—` into the previous caption, so `"failed — start"` reads `"failed—"`, `" start"`; and C6 makes "duration ≥ last character" false on real data |
| **C12** fixtures | synthetic, overwritten by a recording mode | — | **Recorded, no recording mode** | The lead recorded three responses from the live API; a rewrite mode in the test suite was dropped as unneeded |

### Two known gaps, recorded rather than closed

- **`NarrateResult.mode` stays `"kokoro"` for every measured run, ElevenLabs included.**
  render-core's `NarrateMode` is `"kokoro" | "dry_run"`, and the literal has always meant
  *measured, not estimated*: the ONNX route and the fixture have reported `kokoro` since they
  existed. It is a published type in `@xplainer/render-core`'s API report, and renaming it here
  would be a breaking change to a package this work otherwise leaves untouched, for a fact the job
  log already carries. So the narration worker prints `mode ${provider}` from its own resolution —
  `mode elevenlabs` — and does not print render-core's literal. A future change that wants the
  provider *in* `NarrateResult` renames the literal deliberately, with its own changeset.
- **The zero-spans guard applies to remote providers only, so a Kokoro server that returns zero
  spans is still accepted, exactly as before.** `requireWordSpans` wraps ElevenLabs; the three Kokoro
  routes are unchanged byte for byte, which this work promised. A Kokoro-FastAPI server whose
  `/dev/captioned_speech` answered without `timestamps` would therefore still produce a narration
  with no measured spans for that segment. That was true before this record and is not made worse
  by it; closing it means applying the guard to every route and re-proving the three Kokoro routes.

## Consequences

- **ADR 0006's fourth Decision Driver is true of the default and no longer of every
  configuration.** "The local tier must work with no account and no per-character billing" still
  describes a machine nobody has configured, and every machine after `xplainer setup`. A machine
  whose owner ran `config set tts.provider elevenlabs` has an account and pays per character, by
  their own choice. ADR 0006's note of 2026-11-11 says so.
- **ADR 0006's option 2 is now available locally, opt-in, rather than "a future hosted-only
  upgrade".** It sits behind the interface ADR 0006 said it would — the narration port, and a client
  in `@xplainer/tts-client` — and the reason it was rejected for the local tier, cost, is answered by
  making it the owner's decision rather than removed.
- **The state directory gains two files under R-SEC-5 and R-SEC-6.** `credentials.json` is the
  second credential this repository stores and the first that is someone else's. **`daemon
  uninstall` does not delete it** — it deletes the daemon's own token — and `xplainer config unset
  tts.elevenlabs.api_key` does. ADR 0020's note of 2026-11-11 records this.
- **Privacy has a configuration in which text leaves the machine.** The README's "nothing is
  uploaded" becomes "nothing is uploaded unless you choose ElevenLabs", and the three places the
  owner meets the choice — `config set`, the README and the skill — say what is sent and where.
- **The token-equality rule may prove too strict.** If ElevenLabs alters characters in `alignment`
  on some input — smart quotes, a dropped emoji, collapsed marks — paid narrations fail with
  `ALIGNMENT_MISMATCH`. The measurement above found exact equality on digits and `—`, which is the
  evidence there is. If it bites, the correction is to compare after stripping characters that are
  neither letters nor digits, recorded as a dated note here — not a silent loosening.
- **`eleven_v3` and `eleven_v4` are undocumented for this endpoint.** `eleven_v4` was measured to
  return alignment; `eleven_v3` was not measured and has no speed control. An owner may set either;
  the service's own `400`/`422`, or a refusal by name, is what they get if it does not work.
- **The default voice is a judgement.** If premade voices are restricted on some tier, the first
  narration fails with `voice_not_found` or a `403` naming `tts.elevenlabs.voice` — clear, and a bad
  first run.
- **Punctuation can absorb a pause.** ElevenLabs may assign silence to a full stop's own character,
  so a caption can stay up slightly into the pause after it — as Kokoro's folded punctuation already
  does.
- **The live test bills whoever exports `ELEVENLABS_API_KEY`**, about 45 characters per run of
  `pnpm --filter @xplainer/tts-client test`. It does not run under `pnpm verify`, because turbo's
  strict environment mode passes the variable to no task; `packages/tts-client/AGENTS.md` records the
  check.
- **Adding a provider is now a recipe** (`apps/cli/AGENTS.md` §How to add *A speech provider*): a
  descriptor with an honest `timestamps` value, a wire client in `@xplainer/tts-client`, an adapter
  in `apps/cli/src/tts/` returning the port's envelope, a branch in `resolveSpeech`, its settings in
  `config/keys.ts`, and a dated note on this record. A provider that cannot return timestamps is
  refused by the registry, not by review.
