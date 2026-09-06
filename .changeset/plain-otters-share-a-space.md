---
"@xplainer/render-core": patch
---

Captions no longer weld two segments together: `segment one.Segment two` reads `segment one.
Segment two`.

`buildCaptions()` gave the first token of *every segment* no leading space, on the belief that a
segment starts a caption page and a page never begins with a space. Only the first half of that was
ever true. `@remotion/captions`' `createTikTokStyleCaptions()` — the pager the engine-owned
`Captions.tsx` calls — cuts a new page by elapsed time, and the token it cuts on is precisely one
that *begins with a space*; it then trims that space off the token it opens the page with. So the
bare token could not start a page, welded onto the previous segment's last word inside the page it
landed in, and burned into the video as `one.Segment`. The leading space is what permits the page
break, not what spoils it.

Now only the first token of the whole track is bare. The fold that folds a punctuation-only token
into the word before it is unchanged and still stops at a segment boundary — it extends the previous
caption's `endMs`, and the previous segment's last word is a whole inter-segment gap away. Timings
are untouched: this changes `text` and nothing else, so no existing `captions.json` shifts on the
clock, and `packages/protocol/schemas/captions.json` describes the rule it always meant to.

Re-narrate to pick it up; a `captions.json` already on disk keeps the old spacing.
