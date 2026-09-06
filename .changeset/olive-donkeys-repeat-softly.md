---
"@xplainer/render-core": minor
---

Add the narration port: pacing, word spans, WAV concatenation, `timings.json` and `captions.json`.

`src/narrate/` turns a narration script into three files — `narration.wav`, `captions.json` and
`timings.json` — with every scene duration measured from real speech rather than written by hand.
`narrate()` synthesises each segment through `@xplainer/tts-client` (a new `dependencies` edge; its
contract is unchanged), and `planSegments()` is the pure half that places every segment and every
word and can be tested from a fixture.

Three decisions are worth knowing before calling it:

- **A word's end is the server's `end_time`, never the next word's `start_time`.** The space
  between two Kokoro spans is real silence, and a caption stretched across it reads as lag.
- **A segment's spoken length is measured from its PCM frames.** Synthesised audio routinely runs
  past its last word, so inferring the length from the spans would shift every later segment.
- **Silence is quantised to whole samples in the plan, and the track builder writes exactly those
  counts**, so `timings.json`'s `totalMs` equals the WAV's own sample count over its sample rate
  rather than merely being close to it.

`LEAD_IN_MS` (400), `GAP_MS` (620) and `TAIL_MS` (800) are exported, along with the WAV primitives
(`decodeWav`, `encodeWav`, `silentFrames`, `silenceSamples`), the document builders (`buildCaptions`,
`buildTimings`, `buildTrack`), the writers, `estimateSpeech` and `NarrationError`. WAV handling is a
small RIFF reader and writer in this package rather than a dependency; it accepts 16-bit integer PCM
and refuses every other encoding by name, because a zeroed frame is silence at that depth and is not
at others.

`narrate({ dryRun: true })` needs no server and no client: it estimates each segment and reports
`mode: "dry_run"`, so an invented timing can never be mistaken for a measured one.
