---
"@xplainer/render-core": patch
---

A segment that opens with punctuation no longer renders `Alpha , beta`.

Kokoro timestamps a comma as its own token, so a narration segment whose first token is one hands
`buildCaptions` punctuation in first position. The leading space that every *word* after the first
carries — the fix that stopped `one.Segment` welding together across a segment boundary — was being
applied to that token too, which put a space in front of the comma and moved the burned caption
from `Alpha, beta` to `Alpha , beta`.

Punctuation in that position is now emitted bare. It is still emitted as its **own** caption rather
than folded into the caption before it: the fold extends the previous caption's `endMs`, and the
previous segment's last word is a whole inter-segment gap away, so folding would hold that caption
on screen through the silence. The separation the earlier fix bought is untouched — two *words*
across a boundary still read as `one. Segment`.

`captions.json` is unchanged in shape and still validates against
`packages/protocol/schemas/captions.json`.
