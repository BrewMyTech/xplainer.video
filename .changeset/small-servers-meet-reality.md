---
"@xplainer/mcp-server": patch
---

Documentation only: `RenderBackend`'s local implementation is now `createLocalBackend()` in
`apps/cli/src/backend.ts`, not the stub this package's AGENTS.md pointed at. No behaviour, no
exports and no types changed — the registration is exactly as backend-agnostic as it was, which is
the point of the seam.
