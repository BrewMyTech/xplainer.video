---
"@xplainer/motion": minor
---

New package: `@xplainer/motion`, the API explainer scenes are written against, and the page-side
harness the xplainer renderer drives one frame at a time.

The main entry point is side-effect free and imports in Node: `useCurrentFrame` and
`useVideoConfig`; `interpolate` (per-segment easing, `extend`/`clamp`/`identity`/`wrap` on each
side, and a named error for a table it cannot read); `Easing`, the closed-form curves plus CSS
`cubic-bezier`; `spring` and `measureSpring`, the closed-form damped harmonic oscillator with
`delay`, `durationInFrames`, `reverse` and `overshootClamping`; a seeded `random`; the timing
components `Sequence`, `Series`, `Loop` and `Freeze`; `AbsoluteFill`, `Img`, the `<Audio>`
narration marker and `staticFile`; the render holds `delayRender`, `continueRender` and
`cancelRender`; `registerRoot`, `Composition` and `registerVideo` with `calculateMetadata`; and
`paginateCaptions`, with `createTikTokStyleCaptions` as its older name. Every motion function is a
pure function of the frame, so a still and the full render show the same picture; the math is held
to an independent derivation at 1e-9 in the test suite.

`<Video>` and `<OffthreadVideo>` throw `NOT_SUPPORTED_IN_V1` when rendered: this renderer has no
video decoder yet, so use `<Img>` stills. `random(seed)` is deterministic per seed, but its values
are its own, not those of any other library.

`@xplainer/motion/harness` runs the page on film time — `Date`, `performance.now`, timers and
animation frames advance only when the renderer asks for the next frame, and CSS animations are
paused and seeked to it — and waits for render holds, images and fonts before each capture. While a
`delayRender` hold is outstanding, pending timers run on the wall clock, so
`const h = delayRender(); setTimeout(() => continueRender(h), 100)` releases instead of
deadlocking.
