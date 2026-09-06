---
"@xplainer/protocol": patch
---

`schemas/captions.json` now documents the spacing rule the code actually implements.

The `text` description still said that the first word of a segment always carries a leading space.
That stopped being true when the punctuation-first case was fixed: a punctuation-only token that
*opens* a segment cannot be folded into the previous word — the fold would stretch that caption's
`endMs` across the whole inter-segment gap — so it is emitted as its own caption, keeping its own
span, and it is emitted **bare**, because a leading space there renders `"Alpha , beta"`. The
description now states both halves of the exception. The schema shape is unchanged, so the
regenerated TypeScript and Python bindings differ only in their doc comments.
