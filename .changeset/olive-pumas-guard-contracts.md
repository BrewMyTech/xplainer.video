---
"@xplainer/protocol": minor
"@xplainer/mcp-server": patch
"@xplainer/cli": patch
---

Advertise the contract version, and make the `error_code` enum open.

Spike P1-S3 settled the four questions ADR 0025 §Part two left proposed, and
this is the code half of that answer.

`MCP_CONTRACT_VERSION` moves to `@xplainer/protocol`, generated from
`schemas/manifest.json`'s `version` and exported from the entry point.
`@xplainer/mcp-server` re-exports it, so no caller changes; the value now comes
from the package that owns the contract, which is what lets
`xplainer mcp --attach` read a daemon's version without depending on the MCP
server it may be about to refuse. `@xplainer/protocol` also gains
`isContractCompatible(daemon, shim)` — **major-compatible**, symmetric, and
fail-closed on a version it cannot parse.

`xplainer serve` now answers `GET /healthz` with `contract_version` beside the
existing `version`. The two are different numbers on purpose: `version` is the
release, and it is what the MCP handshake reports in `serverInfo.version`, which
is why the handshake could never have carried this.

The `error_code` enum is now **open**: adding a member is a minor contract
change, and both generated bindings decode a member they do not know as
`internal` rather than rejecting the record. `schemas/manifest.json` gains an
`open_enums` table, and codegen emits a decoder per language from it — an
`enum._missing_` hook on the Python `StrEnum`, which pydantic otherwise rejects
unknown members against, and a `toJobErrorCode()` function beside a frozen
`JOB_ERROR_CODE_VALUES` tuple in TypeScript, where the erased union gave a
consumer nothing to call. A non-string `error_code` is still rejected: tolerance
is for a newer contract, not for a malformed record.
