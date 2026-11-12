---
"@xplainer/cli": patch
---

0.1.0 reached npm with 0.0.11's build inside it. Its `dist/` was packed from a clone that predated the release commit, so the installed CLI was not the one 0.1.0 describes: `xplainer setup` read the v1 toolchain manifest, fetched Chrome 149 and no FFmpeg, then exited 70 on `ENOENT` for `render-core/template/package.json`. 0.1.1 is 0.1.0's source, built from the release commit. If you installed 0.1.0, install 0.1.1 and run `xplainer setup` again.
