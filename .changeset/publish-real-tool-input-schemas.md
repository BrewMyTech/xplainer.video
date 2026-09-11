---
"@xplainer/protocol": patch
"@xplainer/mcp-server": patch
---

Publish each tool's real input schema in `tools/list`, instead of an open object.

Every tool was registered with one `z.looseObject({})`, so a client was told the arguments of all
eight were `{"type":"object","properties":{}}`. An agent was therefore never told that `narration`
is an object, that `files` is an array, or that `slug` is required — and one that guessed a JSON
string for `narration` was rejected by the backend with an error naming neither the argument nor its
shape. Reported from a real session where the operator abandoned the tool and drove the daemon from
a hand-written script instead.

The reason the schemas were withheld was real: they are written with cross-file `$ref`s
(`../slug.json`, `../narration.json`) that a client holding a single schema cannot resolve.
`@xplainer/protocol` now generates `TOOL_INPUT_SCHEMAS`, the same documents with those references
inlined and their `$defs` hoisted, and `@xplainer/mcp-server` publishes those.

Two behaviour changes follow, both of them the contract finally being enforced rather than new
rules: arguments are now **validated** at the tool boundary instead of reaching the backend
unchecked, and `additionalProperties: false` now refuses an undeclared key rather than forwarding
it. `not` is dropped during bundling, which is the position `explainer_put_source.input.json`
already documents — the runtime gate for engine-owned paths is `assertAgentOwnedPaths()`, which is
unchanged and still runs on every call.
