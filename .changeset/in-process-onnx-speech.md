---
"@xplainer/cli": minor
---

Narrate in this process: a third `SpeechSynthesiser` behind `resolveSpeech()`, running Kokoro-82M
on an ONNX Runtime under `apps/cli/src/speech/`. With it a machine needs **no Docker, no
`--tts-url` and no Python** to produce narration, and no GPL component is fetched, shipped or
linked. `--tts-url` and the Docker route keep working unchanged.

The route is chosen the way the other two are — by what the machine has, never by a flag a tool
call carries. The precedence is `XPLAINER_TTS_FIXTURE`, then a server somebody named
(`XPLAINER_TTS_URL` or `KOKORO_URL`), then the in-process engine, then the tts-client's own default.
A server that was *named* wins over the local engine because naming one was an intention; the
`localhost:8880` default is a guess, and loses to it.

Word timings come from the model's own per-token duration predictor rather than from an alignment
estimate, which is why this model was chosen. **The duration-to-seconds conversion is derived from
the run that produced the audio** — `waveform.length / Σ durations` — and never written down: the
published figure for this model is off by a factor of two, and the true ratio moves by 79% across
the speaking-rate range the port accepts (583 samples per unit at speed 0.8, 1042 at speed 4). A
constant would be a silent, systematic drift in every caption and every scene boundary, so
`timing.ts` refuses rather than emitting timings that disagree with the audio it returned.

Two consequences worth knowing before this is switched on:

- **A clip is returned untrimmed.** Kokoro-FastAPI trims its output; this does not, because the
  head is a noise floor below −66 dBFS rather than digital silence, the first phoneme's onset
  begins *before* the boundary the duration predictor implies, and a trim threshold set slightly
  wrong clips the start of the first word. The same sentence therefore comes back 8–13% longer than
  from a server — ≈0.32–0.49 s of near-silence before the first phoneme, ≈0.19 s after the last.
  The speech is the same length; the padding is not, and pacing belongs to
  `@xplainer/render-core`'s `LEAD_IN_MS` / `GAP_MS` / `TAIL_MS`, which apply to every engine.
  **The padding does not shift the timings**, which is what makes leaving it in safe: they are
  absolute offsets into the clip as delivered, and the first word's `start_time` lands 13–41 ms
  (mean 29 ms) after the audible onset — under a frame and a half at 30 fps, and the predictor's
  own alignment rather than an arithmetic error. Nothing downstream needs to know.
- **A voice this machine has no pack for is refused, not substituted**, and a server-side blend
  such as `af_bella(2)+af_sky(1)` has no meaning on this route at all.

Nothing is added to this package's public surface: `src/speech/` is internal, like `src/daemon/`.
The ONNX Runtime is an acquired toolchain component rather than an npm dependency — one
`onnxruntime-node` package carries all three platforms' binaries at 285 MB — so the published
tarball and payload 1 are unchanged.
