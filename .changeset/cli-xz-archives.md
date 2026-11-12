---
"@xplainer/cli": patch
---

`xplainer setup` can now unpack `.tar.xz` archives, which is the only form the Linux FFmpeg builds
it is about to acquire are published in. xz is decoded by `xz-decompress` 0.2.3 (MIT, no
dependencies, no install script), a new dependency of this package; `NOTICE` names it and the three
parts it contains. The zip reader can now take only the members a caller names, without inflating
the rest, and both readers refuse two members that would land on one path. A tarball whose own
compressed stream is damaged — an xz CRC64 that does not match, a stream cut short, a gzip handed to
the xz decoder — is refused as `corrupt-stream` rather than surfacing the decoder's raw error.
