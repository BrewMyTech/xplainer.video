---
"@xplainer/protocol": minor
"@xplainer/mcp-server": patch
---

Add a machine-readable `error_code` to `explainer_job`'s output.

`error` is prose, so an agent deciding whether to retry has to parse it. The new
`job-error-code.json` enum — `daemon_restarted`, `daemon_shutdown`,
`toolchain_missing`, `render_failed`, `tts_failed`, `cancelled`, `internal` —
says which class of failure produced that prose, and each member's description
says whether retrying is worth anything. `error_code` is required and nullable,
sitting immediately after `error` in both `properties` and `required`; it lands
now because `@xplainer/protocol` is published for the first time in phase 1, and
after that a required field is a breaking change to every consumer.
