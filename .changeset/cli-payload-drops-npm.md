---
"@xplainer/cli": minor
---

The runtime payload no longer carries npm. It travelled with `runtime build`'s output — about
17 MB, a `bin/npm` shim and a `launch.npm_cli` entry in `runtime.manifest.json` — only so that
`setup --workspace` had a package manager on a machine with no Node, and that command is gone.
A payload is now its interpreter, the workspace packages and their runtime dependencies, and its
manifest records neither `npm_version` nor `launch.npm_cli`. A manifest that still records them,
from a payload built before this change, reads exactly as before; nothing reads either field.
`runtime build` stops printing its `npm:` line.
