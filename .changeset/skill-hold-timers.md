---
"@xplainer/skill": patch
---

The render-hold guidance says what a hold's timers now do: they run while the frame waits, in order and one at a time, stopping at the one that releases the hold, so a timer started beside `setTimeout(() => continueRender(handle), 100)` for later lands on the same frame on every render.
