---
"xplainer": minor
---

`npx -y xplainer` and `npm i -g xplainer` now install `@xplainer/cli` 0.1.0, so everything in that
release reaches this name too. xplainer renders with its own renderer instead of Remotion, and
`xplainer setup` acquires a pinned FFmpeg beside the browser and speech. **A daemon installed by
0.0.11 or earlier has to be reinstalled**: `xplainer update` and `xplainer setup` refuse with exit
`3` and print the three commands that do it, `xplainer daemon uninstall`, `xplainer setup` and
`xplainer daemon install`.
