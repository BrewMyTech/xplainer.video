---
"@xplainer/cli": patch
"@xplainer/mcp-server": patch
"@xplainer/protocol": patch
"@xplainer/render-core": patch
"@xplainer/skill": patch
"@xplainer/tts-client": patch
---

Give every published package a `README.md`, a `homepage`, a `repository` and an `author`.

None of the six had a README, so each one's npm page would have rendered blank —
including `@xplainer/cli`, which is the page a human reads before deciding to
install a background daemon on their machine. Each README is derived from the
member's own `AGENTS.md`, states what the package is and links to the repository
docs rather than restating their invariants; `@xplainer/cli` and
`@xplainer/render-core` also carry the Remotion disclosure ADR 0022 requires on
a surface a user reads *before* installing — Remotion is declared, never bundled,
and a company above three people needs its own licence.

`repository.directory` names the member inside the monorepo, so "view source"
lands on the package a reader is looking at instead of on the repository root.
