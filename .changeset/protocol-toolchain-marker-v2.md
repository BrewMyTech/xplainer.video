---
"@xplainer/protocol": minor
---

`toolchain.json`'s schema describes the marker at `format_version` 2. `workspace` is no longer
required — it is kept as a deprecated optional property, so a version-1 marker still validates — and
`ffmpeg` is a new optional component with its own definition, `ToolchainFfmpeg`: the executable's
version, path, digest and provider, the files it is made of (the executable first, at least one),
the libavcodec version it reported, its licence as an SPDX id, an optional publisher and source URL,
and `probe`, the verbatim output of `ffmpeg -version`, `-buildconf` and `-L`
(`ToolchainFfmpegProbe`). Both new types are exported, and the generated TypeScript and Python carry
them. `Toolchain.workspace` is now optional in both languages, which is a change for any reader that
assumed it was present.
