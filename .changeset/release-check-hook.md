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

No behaviour change for anyone who installs the package. Its `package.json` gains a
`prepublishOnly` script, which runs this repository's release check before the package is
published and refuses the publish while anything listed as blocking a release is still open. npm
and pnpm run it only on a publish, never on an install.
