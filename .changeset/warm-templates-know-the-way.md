---
"@xplainer/render-core": minor
---

The workspace layout, as code: `src/workspace.ts`.

`template/` said what a Remotion workspace contains; nothing said where a video's pieces go inside
one, so every caller would have had to join those paths itself. `videoPaths(root, slug)` is now the
only place `videos/<slug>` and `public/<slug>` are paired, which matters because the pairing is
load-bearing and fails quietly: `--public-dir` is what Remotion serves `staticFile()` from and
`Root.tsx` fetches `timings.json` through it at metadata time, so pointing it at the source
directory does not error — it renders the `durationInFrames={300}` placeholder, silently.

`materialiseWorkspace()` copies the four template files in and creates `videos/`, `public/` and
`out/`, never overwriting a file that is already there: `package.json` is what a package manager
recorded `node_modules/` against, and rewriting it from the template on every `explainer_create`
would un-pin a workspace someone had already installed. It installs nothing —
`remotionBinary()` answers `null` for a workspace nobody has run `npm install` in, and
`workspaceNotInstalledMessage()` is the sentence a caller shows instead of failing inside `spawn`
with an `ENOENT`.

Also exported: `stillOutput()`, `isWorkspaceInstalled()`, `listVideoSlugs()`, and the directory and
filename constants the layout is built from.
