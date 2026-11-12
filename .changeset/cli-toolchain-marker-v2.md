---
"@xplainer/cli": minor
---

`xplainer setup` writes `toolchain.json` at `format_version` 2: the browser and speech it acquired,
and no longer the render workspace. `setup --workspace` still installs the workspace, but nothing
records or checks it any more, because no render reads it. A marker an older `setup` wrote is still
read, as a toolchain that has a browser and speech and nothing else, and the next `setup` that writes
the marker rewrites it as version 2.

`explainer_still`, `explainer_render`, `daemon install` and `/healthz` judge the marker the same way
they did, minus the workspace: a still or a render is no longer refused, and `/healthz` no longer
reports `degraded`, because a workspace is missing or was resolved for another template. A marker
that records an ffmpeg has that ffmpeg checked too — its files must still exist (`toolchain_missing`),
the binary must still be the size `setup` recorded, and its recorded libavcodec must be 60 or newer
(`toolchain_stale`, both).
