# @xplainer/render-core

Four things that travel together:

- **the workspace template** under `template/` — `tailwind.css` and a `tsconfig.json` for your
  editor, copied into the workspace your videos live in — and `materialiseWorkspace()` /
  `videoPaths()`, which lay it out and never overwrite a file that is already there;
- **the ownership-aware scaffold generator**, which writes the six files of a new video against
  `@xplainer/motion`'s authoring API;
- **the narration port**, which measures real speech into `narration.wav`, `captions.json` and
  the `timings.json` every scene length comes from; and
- **the render preflight**, which refuses an unrenderable job before Chrome is ever launched.

```bash
npm i @xplainer/render-core
```

## File ownership is the idea the package is built around

The **engine** owns five files — `index.ts`, `types.ts`, `Root.tsx`, `Captions.tsx`,
`Video.tsx` — and the **agent** owns one, `Scenes.tsx`. `scaffoldVideo()` reports what it
`created`, `skipped` and `restored`: an engine-owned file whose bytes drifted is restored from
the template, and an agent-owned file is never touched. That is what keeps a hand-edited
composition shell from producing a silently wrong MP4.

```ts
import { videoPaths, scaffoldVideo, narrate, assertRenderable } from "@xplainer/render-core";
```

Nothing here renders and nothing here installs anything. `materialiseWorkspace()` copies the
template files and creates the directories; the renderer is `@xplainer/cli`'s, which bundles a
video's files against its own copy of `@xplainer/motion` and React. The workspace holds a video's
sources and outputs, and nothing a package manager installed.

The scaffold templates and the workspace template ship as readable, editable text on purpose:
they land on your disk and you edit them. The exported surface is recorded in
`api/render-core.api.md` in the repository.

## Docs

- [Architecture][architecture] — the members and the dependency direction
- [Decision records][adr] — the engine owns the composition shell (ADR 0018)
- [Roadmap][roadmap] — what is built and what is not

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`, both shipped inside this package. `NOTICE` also names the
two pieces of third-party data this package redistributes: the CMU Pronouncing Dictionary
(2-clause BSD) and the Kokoro tokenizer (Apache-2.0).

[architecture]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/ARCHITECTURE.md
[adr]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/adr/README.md
[roadmap]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/ROADMAP.md
