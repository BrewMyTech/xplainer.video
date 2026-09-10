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
`onnxruntime-node` package carries all five platforms' binaries at 296 MB — so the published
tarball and payload 1 are unchanged.

**The product selects this route itself, and `onnx` now sits above `docker` in `setup`.** Both are
part of switching it on rather than refinements of it. `resolveSpeech()` reads
`<state>/toolchain.json`, so a daemon on a machine that has run `setup` finds the engine `setup`
acquired: before this it defaulted to reading `XPLAINER_ONNX_MODEL`, `XPLAINER_ONNX_VOICE` and
`XPLAINER_ONNX_RUNTIME`, so the engine spoke only for a caller who exported three variables. Those
three still work, above the marker, as the way to point it at a model no `setup` acquired.

`setup`'s acquisition order is now `--tts-url`, `onnx`, `docker`, `bundle`. Below `docker`, every
machine with a container engine recorded `docker` and never took the in-process route — which is the
machine class this work exists for, since the point is that a voiceover needs no Docker. Three
things come with the swap:

- **`xplainer setup --speech <onnx|docker>`** pins a route and does not walk the precedence. A route
  somebody named is an instruction, so a named route that is unavailable is a refusal naming why
  rather than a fall-through to something else. `--tts-url` still wins outright.
- **A machine that already records a working `docker` route keeps it.** `setup` is re-runnable by
  design, and a re-run is the worst moment to move narration onto a different engine: the container
  is running, it is what every previous narration was spoken by, and switching would fetch ~204 MB
  to replace something that works. So a recorded `docker` component whose image Docker can still
  address takes the route again, and `setup` prints that it did and names `--speech onnx`. A machine
  that has *lost* its engine falls through and gets the in-process route.
- **`setup` prints which route it took and why the others were not**, and distinguishes the two
  reasons: a route above the one taken was probed and reported itself unavailable, a route below it
  was never asked at all.
