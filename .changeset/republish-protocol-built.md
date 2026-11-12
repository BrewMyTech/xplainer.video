---
"@xplainer/protocol": patch
---

0.1.0 shipped types generated before the release. They lacked `ToolchainFfmpeg` and `ToolchainFfmpegProbe`, so `toolchain.json` format 2 could not be typed from the package. 0.1.1 ships the types generated from 0.1.0's schemas.
