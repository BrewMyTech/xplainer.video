---
"@xplainer/skill": patch
---

The skill now tells the agent what to do about words the voice has to guess at.

Editable pronunciations shipped in 0.0.8 and the skill never mentioned them, so
the one actor best placed to notice a mangled tool name did not know the file
existed.

The instruction is reactive on purpose. `explainer_narrate` already prints one
line per word it had to derive — the word, the phonemes it chose, the file to
correct them in, and a line to paste into it — and that reaches the agent
through `explainer_job`'s output. Asking the agent to hunt for hard words
*before* narrating would have it invent phonemes for words it cannot hear and
mostly did not need to touch; CMUdict already handles most technical English,
and a wrong override breaks a word that was fine. So the loop is narrate, read
the warnings, fix what is actually wrong, narrate again.

It also says the three things that are easy to get wrong: the lexicon is the
user's machine-wide file rather than this video's, a lower-case spelling
matches any case while a capitalised one matches exactly, and spelling a term
out in the narration is often the better fix than teaching the voice to say it.
