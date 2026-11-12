# @xplainer/motion

## 0.1.0

### Minor Changes

- 90b24b9: New package: `@xplainer/motion`, the API explainer scenes are written against, and the page-side
  harness the xplainer renderer drives one frame at a time.

  The main entry point is side-effect free and imports in Node: `useCurrentFrame` and
  `useVideoConfig`; `interpolate` (per-segment easing, `extend`/`clamp`/`identity`/`wrap` on each
  side, and a named error for a table it cannot read); `Easing`, the closed-form curves plus CSS
  `cubic-bezier`; `spring` and `measureSpring`, the closed-form damped harmonic oscillator with
  `delay`, `durationInFrames`, `reverse` and `overshootClamping` (which rests at the target from its
  first arrival); a seeded `random`, held bit for bit across releases; the timing
  components `Sequence`, `Series`, `Loop` and `Freeze`; `AbsoluteFill`, `Img`, the `<Audio>`
  narration marker and `staticFile`; the render holds `delayRender`, `continueRender` and
  `cancelRender`; `registerRoot`, `Composition` and `registerVideo` with `calculateMetadata`; and
  `paginateCaptions`, with `createTikTokStyleCaptions` as its older name. Every motion function is a
  pure function of the frame, so a still and the full render show the same picture; the math is held
  to an independent derivation at 1e-9 in the test suite.

  `<Video>` and `<OffthreadVideo>` throw `NOT_SUPPORTED_IN_V1` when rendered: this renderer has no
  video decoder yet, so use `<Img>` stills. So does a second `<Audio>`: the narration is the only
  track the encoder muxes, and a second one would otherwise vanish from the MP4. `staticFile()`
  refuses a leading `/` and any `..` segment. `random(seed)` is deterministic per seed, but its values
  are its own, not those of any other library.

  `@xplainer/motion/harness` runs the page on film time — `Date`, `performance.now`, timers and
  animation frames advance only when the renderer asks for the next frame, and CSS animations are
  paused and seeked to it — and releases a frame only once the page has stopped changing: no render
  hold out, every image complete and decoded, no font loading, and a pass that changed no node (a
  frame that never settles is released with a warning). `Math.random` in the page is seeded and
  reset at mount, so it repeats from run to run. While
  a `delayRender` hold is outstanding, the timers and animation-frame callbacks created since the
  previous frame run on the wall clock, so `const h = delayRender(); setTimeout(() =>
continueRender(h), 100)` releases instead of deadlocking; when it releases, the timers the wait
  created are rebased onto the frame's film time, so how long the wait took never reaches the
  video.

### Patch Changes

- 839886c: Wording only, no behaviour change. Every package's `LICENSE` and `NOTICE` drop the paragraphs about
  Remotion, because nothing installs it any more, and `NOTICE` now closes by saying that Apache-2.0
  does not cover the components `xplainer setup` acquires, the FFmpeg builds among them; it names
  BtbN's FFmpeg-Builds at its current address, `github.com/FFmpeg-Builds/FFmpeg-Builds`. The
  `@xplainer/cli`, `xplainer` and `@xplainer/render-core` READMEs describe `setup` acquiring the
  browser, FFmpeg and speech, the licences those downloads carry, and the two-file workspace template,
  and a doc comment in `@xplainer/mcp-server`'s published types no longer names Remotion.
- 5ef65e9: No behaviour change for anyone who installs the package. Its `package.json` gains a
  `prepublishOnly` script, which runs this repository's release check before the package is
  published and refuses the publish while anything listed as blocking a release is still open. An
  install from the registry never runs it. Inside this repository, where pnpm also runs it when it
  installs the workspace, the check stands aside unless a publish started it.
