---
"@xplainer/cli": minor
---

`xplainer setup` writes `toolchain.json` at `format_version` 2: the browser and speech it acquired,
the ffmpeg it acquired or was pointed at when there is one — ffmpeg is the one optional component —
and no longer the render workspace, because no render reads one. A marker an older `setup` wrote is
still read, as a toolchain that has a browser and speech and nothing else, and the next `setup` that
writes the marker rewrites it as version 2.

`explainer_still`, `explainer_render`, `daemon install` and `/healthz` judge the marker the same way
they did, minus the workspace: a still or a render is no longer refused, and `/healthz` no longer
reports `degraded`, because a workspace is missing or was resolved for another template. A marker
that records an ffmpeg has that ffmpeg checked too — its files must still exist (`toolchain_missing`),
the binary must still be the size `setup` recorded, and its recorded libavcodec must be 60 or newer
(`toolchain_stale`, both).
