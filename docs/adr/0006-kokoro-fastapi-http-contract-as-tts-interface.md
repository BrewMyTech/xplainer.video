# 0006. The Kokoro-FastAPI HTTP contract is the TTS interface

- Status: accepted
- Date: 2026-09-05
- Deciders: @rishavanand
- Settled by: interview round 8 (stack lock); contract inherited from
  `max/.explainers/scripts/narrate.py`

## Context and Problem Statement

Narration is the source of truth for timing in this product. `timings.json` — per-segment
frame ranges measured from **word-level** TTS timestamps — drives every `Sequence` in the
rendered video, and captions are burned from word-level `Caption[]` in `@remotion/captions`
format. Agents never hand-write durations.

That makes the TTS interface unusually load-bearing: we do not merely need audio, we need
audio **plus per-word start and end times in the same response**. Most speech APIs do not
return that, and the ones that do return it in incompatible shapes.

Two backends have to satisfy this contract: a hosted container and a locally installed
service, and spec §Constraints requires that local and hosted behave identically.

## Decision Drivers

- Word-level timestamps are non-negotiable; without them `timings.json` cannot be computed
  and captions cannot be aligned.
- The same contract must be satisfiable by a hosted container and by a per-OS local
  install, so it has to be a **network contract**, not a library API.
- The `max` reference implementation already speaks this contract in production
  (`narrate.py`), so adopting it costs nothing and porting away from it costs a rewrite.
- Self-hostable and open-weight, because the local tier must work with no account and no
  per-character billing.

## Considered Options

1. **Kokoro-FastAPI's HTTP contract** — `GET /v1/audio/voices` and
   `POST /dev/captioned_speech`, the latter returning base64 WAV plus a `timestamps` array
   of `{word, start_time, end_time}`.
2. **A hosted commercial TTS API** (ElevenLabs, OpenAI, Azure). Better voices, per-character
   cost, and a hard problem for the free local tier — plus word timing support that varies
   by vendor and by voice.
3. **A slimmer `kokoro-onnx` in-process path with forced alignment** (WhisperX or
   `aeneas`) to recover word timings.

## Decision Outcome

Chosen: **option 1 — the Kokoro-FastAPI HTTP contract**, treated as an interface rather
than as a product. Anything that answers those two endpoints is a valid backend.

`packages/tts-client` pins the contract in typed code now, in this scaffold phase, even
though §Non-Goals forbids synthesising anything. It shapes a request and parses a response;
it writes no audio, concatenates no WAV frames, and computes no timings or captions. What
it pins is the exact payload built at `max/.explainers/scripts/narrate.py:147-157`:

```
{ model: "kokoro", input, voice, response_format: "wav", speed,
  stream: false, return_timestamps: true }
```

`stream: false` and `return_timestamps: true` are asserted by a unit test with an injected
`fetch` stub, because inverting either one **silently loses every word timing** — streaming
returns raw audio rather than the JSON envelope that carries the timestamps, and the
failure surfaces much later as a video whose scene durations are wrong. `narrate.py` has a
comment at that exact line saying so; the test is that comment made executable.

The voice listing is normalised across both observed response shapes — `[{id, name}]` on
current builds and plain strings on older ones (`narrate.py:127-131`).

Option 2 was rejected for the local tier on cost and self-hostability, not on quality; it
remains available as a future hosted-only upgrade behind the same client interface, which
is the point of treating this as an interface.

Option 3 stays open as a **spike**, not a decision: a smaller local footprint is attractive
(ADR 0005's download is the largest artefact the local tier fetches), but forced alignment
adds a second model and a second failure mode to the one number the whole render depends
on. It is evaluated against the same HTTP contract, so adopting it would not change any
caller.

## Consequences

- **The contract is pinned in a tested client from day one**, which removes a whole class
  of phase-1 debugging — the class where a payload flag is wrong and the symptom is a
  mistimed video rather than an error.
- **`services/tts-sidecar` pins the upstream image by digest**
  (`ghcr.io/remsky/kokoro-fastapi-cpu`), not by tag, so the hosted TTS container cannot
  change under us between builds. Its `Dockerfile` adds only a healthcheck on
  `/v1/audio/voices`.
- **Defaults come from `max` and are recorded, not re-derived:** base URL
  `http://localhost:8880`, default voice `af_heart`, `voices_path = /v1/audio/voices`,
  `speech_path = /dev/captioned_speech`, all overridable through the `XPLAINER_KOKORO_`
  environment prefix and asserted by `services/tts-sidecar/tests/test_config.py`.
- **We are coupled to a community project's non-standard endpoint.** `/dev/captioned_speech`
  is not an OpenAI-compatible route and its shape could change upstream. The digest pin
  bounds that risk, and the client is small enough that adapting it is a contained change.
- **The narration pipeline itself — pacing constants, word-span assignment, WAV
  concatenation, `timings.json` and `captions.json` generation — is not ported in this
  phase.** It is narration logic and §Non-Goals forbids it; it lands at roadmap phase 1
  as a port of `narrate.py`.
