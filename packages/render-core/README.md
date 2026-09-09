# @xplainer/render-core

Four things that travel together:

- **the Remotion workspace template** under `template/`, copied onto your machine as the
  workspace your videos render inside — and `materialiseWorkspace()` / `videoPaths()`, which
  lay it out and never overwrite a file that is already there;
- **the ownership-aware scaffold generator**, which writes the six files of a new video;
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
import { videoPaths, scaffoldVideo, narrate, assertRenderable, renderArgs } from "@xplainer/render-core";
```

Nothing here installs anything. `materialiseWorkspace()` copies the template files and creates
the directories; `remotionBinary()` answers `null` for a workspace you have not run
`xplainer setup --workspace` for, so a caller can tell you that rather than failing
inside `spawn`.

The scaffold templates and the workspace template ship as readable, editable text on purpose:
they land on your disk and you edit them. The exported surface is recorded in
`api/render-core.api.md` in the repository.

## Remotion

Rendering depends on [Remotion](https://remotion.dev), which is licensed commercially by
Remotion AG on its own terms. **This package declares Remotion; it never bundles it.** The
`template/package.json` it scaffolds names `remotion` and the `@remotion/*` packages, so your
own package manager fetches them under Remotion's terms, on your machine, in your name — which
makes you, plainly, the party operating Remotion.

**Depending on the size of your company and how you use it, you may need your own Remotion
licence** — free for individuals and companies of up to three people, chargeable above that.
See <https://remotion.pro/license>.

## Docs

- [Architecture][architecture] — the members and the dependency direction
- [Decision records][adr] — the engine owns the composition shell (ADR 0018)
- [Roadmap][roadmap] — what is built and what is not

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`, both shipped inside this package. The Remotion licence
above is separate and is not granted by it.

[architecture]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/ARCHITECTURE.md
[adr]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/adr/README.md
[roadmap]: https://github.com/BrewMyTech/xplainer.video/blob/main/docs/ROADMAP.md
