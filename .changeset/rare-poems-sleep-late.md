---
"@xplainer/render-core": minor
---

Widen `SCAFFOLD_FILES` from a six-element readonly tuple to a readonly array.

`isolatedDeclarations` cannot infer a type through the two spreads that build the
list, so the declaration is written out as
`readonly (EngineOwnedFile | AgentOwnedFile)[]` rather than emitted as a tuple.
The order is unchanged and is still a guarantee about the values — the engine's
five first, `Scenes.tsx` last — but it is no longer a guarantee expressed in the
type: a consumer indexing by position or reading `.length` loses the narrowing.
Nothing in this workspace does either, and `ScaffoldFile` is still the union of
the same six literal types.
