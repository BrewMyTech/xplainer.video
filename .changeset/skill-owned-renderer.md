---
"@xplainer/skill": minor
---

The skill now describes xplainer's own renderer instead of Remotion.

Every authoring API is imported from `@xplainer/motion`, and the skill says so in one place.
`Easing.spring()` — which never existed — is now `spring()`. Images go through `<Img>` and
`staticFile()`; video assets and a second `<Audio>` fail the render with `NOT_SUPPORTED_IN_V1`,
because the narration is the only audio track, and `staticFile()` stays inside the video's public
directory. CSS and Tailwind animations are no longer
described as frozen: the renderer seeks them to the frame being drawn, and a still matches the
render, but CSS time ignores the timing components and the narration, so motion stays
`interpolate()`. The skill also explains the
`delayRender` timer rule, that a render needs ffmpeg, and that frames are reproducible on one
machine rather than across machines.

One paragraph covers videos written for the previous renderer: `remotion`, `@remotion/media` and
`@remotion/captions` imports still compile for one more release through an alias, and it lists what
does not carry over.

The Remotion licence line is gone from `SKILL.md` and from the three plugin and marketplace
`description` fields, because rendering no longer uses Remotion, and the `remotion` keyword and tag
are gone from the manifests.
