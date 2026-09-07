---
"@xplainer/render-core": patch
---

`decodeWav` reads Kokoro's streaming header, which is the one every live narration arrives in.

`kokoro-fastapi` builds its response with a streaming writer and therefore does not know the length
when it writes the header, so it puts the all-ones sentinel in both size fields —
`RIFF ffffffff … LIST … data ffffffff` — and it does that for `stream: false` requests too. Read as
a byte count, that sentinel made every real narration fail with `WAV chunk "data" claims 4294967295
bytes but only 322100 remain`, which is the shape of a decoder bug rather than of the server saying
"the file ends where it ends". A chunk size of `0xffffffff` now means exactly that: everything left
in the payload.

A size that is merely too large still fails, unchanged, so a truncated download is not read as a
short take — the two cases look alike in a header and are opposites in a track.

Found by the end-to-end run against a live container (`pnpm e2e:render`), which is the only place
this package meets a WAV it did not write.
