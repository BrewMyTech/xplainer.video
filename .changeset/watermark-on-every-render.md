---
"@xplainer/render-core": patch
---

Put the `xplainer.video` mark on every rendered frame.

The watermark lives in the scaffolded `Video.tsx`, which is engine-owned: `explainer_put_source`
refuses to write it and `explainer_create` restores it whenever its bytes drift. So the mark is not
something an agent can drop by redesigning the video, and an existing video picks it up on its next
render without anyone re-creating it. It is mounted last, above the caption track, so nothing a
scene draws can cover it.

Its position is decided by the caption band rather than by taste. `Captions.tsx` anchors its pill
with `paddingBottom: 84`, so the strip below that is free across the full width no matter what the
caption says or how many lines it wraps to — and because the pill is anchored to the bottom, a
taller caption grows upward and away. Bottom-right also clears the pill's right edge, which a
`maxWidth: 1480` caption centred in a 1920 frame can push out to x=1700.
