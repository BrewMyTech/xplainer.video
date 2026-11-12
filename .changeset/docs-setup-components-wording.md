---
"@xplainer/cli": patch
"xplainer": patch
"@xplainer/mcp-server": patch
"@xplainer/motion": patch
"@xplainer/protocol": patch
"@xplainer/render-core": patch
"@xplainer/skill": patch
"@xplainer/tts-client": patch
---

Wording only, no behaviour change. Every package's `LICENSE` and `NOTICE` drop the paragraphs about
Remotion, because nothing installs it any more, and `NOTICE` now closes by saying that Apache-2.0
does not cover the components `xplainer setup` acquires, the FFmpeg builds among them; it names
BtbN's FFmpeg-Builds at its current address, `github.com/FFmpeg-Builds/FFmpeg-Builds`. The
`@xplainer/cli`, `xplainer` and `@xplainer/render-core` READMEs describe `setup` acquiring the
browser, FFmpeg and speech, the licences those downloads carry, and the two-file workspace template,
and a doc comment in `@xplainer/mcp-server`'s published types no longer names Remotion.
