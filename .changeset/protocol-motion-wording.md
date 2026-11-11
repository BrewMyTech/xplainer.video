---
"@xplainer/protocol": patch
---

Descriptions only, no shape change: `captions.json` is described as the `Caption[]` form
`@xplainer/motion` reads, `timestampMs` says the caption pager pages on `startMs` and does not read
it, a segment's `from` is for the composition's `Sequence`, and `explainer_put_source` writes
agent-authored scene source written against `@xplainer/motion`. The generated TypeScript and
Python carry the same wording.
