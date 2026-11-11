# @xplainer/motion

**The API explainer scenes are written against, and the page-side harness the xplainer renderer
drives one frame at a time.** A scene is ordinary React: it reads the frame, computes its picture
from it, and the renderer captures that picture once per frame.

```bash
npm i @xplainer/motion react react-dom
```

```tsx
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "@xplainer/motion";

export const Title: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" });
  const scale = spring({ frame, fps, config: { damping: 12 } });
  const y = interpolate(frame, [0, 30], [40, 0], {
    easing: Easing.out(Easing.cubic),
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <h1 style={{ opacity, transform: `translateY(${y}px) scale(${scale})` }}>{text}</h1>
    </AbsoluteFill>
  );
};
```

## What is in it

| Kind | Exports |
|---|---|
| Frame and video | `useCurrentFrame`, `useVideoConfig` |
| Motion | `interpolate`, `Easing`, `spring`, `measureSpring`, `random` |
| Timing and layout | `Sequence`, `Series`, `Loop`, `Freeze`, `AbsoluteFill` |
| Media | `Img`, `Audio` (the narration marker), `staticFile` |
| Render holds | `delayRender`, `continueRender`, `cancelRender` |
| The video itself | `registerRoot`, `Composition`, `registerVideo`, `CalculateMetadataFunction` |
| Captions | `paginateCaptions`, `Caption`, `TikTokPage` |

Every motion function is a pure function of the frame, so a frame rendered out of order, or a
single still, is the same picture the full render shows. `spring` is the closed-form solution of a
damped harmonic oscillator; `Easing` holds the textbook closed forms; `random(seed)` is
deterministic per seed.

`<Video>` and `<OffthreadVideo>` throw `NOT_SUPPORTED_IN_V1` when rendered: video assets are not
supported by this renderer yet, so use `<Img>` stills.

## The harness

`@xplainer/motion/harness` is a separate entry point with side effects, imported only by the
renderer's generated bundle, before the scene code. It runs the page on film time — `Date`,
`performance.now`, `setTimeout`, `setInterval` and `requestAnimationFrame` all advance only when the
renderer asks for the next frame — and waits for render holds, images and fonts before each frame
is captured. A scene never imports it.

The exported surface of the main entry point is recorded in `api/motion.api.md` in the repository.

## Docs

- [Architecture][architecture] — the members and the dependency direction
- [Decision records][adr]
- [Roadmap][roadmap] — what is built and what is not

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`, both shipped inside this package.

[architecture]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/ARCHITECTURE.md
[adr]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/adr/README.md
[roadmap]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/ROADMAP.md
