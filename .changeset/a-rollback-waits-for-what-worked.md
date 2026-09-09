---
"@xplainer/cli": patch
---

**A short `healthTimeoutMs` was also the budget the rollback got for putting the previous runtime
back — so the smaller a caller made it, the likelier `daemon update` was to leave the machine with
no daemon at all.**

`updateDaemon` and `recoverUpdate` take one readiness budget, and it is a budget for the runtime
being *installed*: "how long am I prepared to wait to find out this is not going to work". A caller
is entitled to make it small. The rollback's own wait — on the retained previous runtime, the one
thing in the transaction already known to work — was reading the same number, so a two-second budget
for the replacement was a two-second budget for the comeback. When that expired the transaction
refused with `4` and the sentence "The previous runtime … was put back and it did not answer
either", leaving a journal, a stopped daemon and a `xplainer daemon recover` for the user to run by
hand — over a daemon that was seconds from answering.

The rollback's wait now takes the ordinary `REPLACEMENT_READY_TIMEOUT_MS` as a **floor**
(`ROLLBACK_READY_FLOOR_MS`), via `Math.max`, so a caller who asked for longer still gets longer and
one who asked for less does not get less where it matters. Nothing else about the transaction
changes: the forward wait, the refusal codes, the journal and every boundary are as they were.

Found as a flake rather than reasoned. T33's rollback rerun passes `healthTimeoutMs: 1_500` so that
a *deliberately* doomed replacement fails fast, and on `windows-latest` that 1.5 s became the whole
budget for a real `xplainer serve` to start: run `34319281465` shows the case failing with "A is
answering /healthz as release 0.0.0" over a daemon whose log had reached its second line. The same
case failed once before (run `34308497439`) with no explanation. `setup/testing/rollback-render.ts`
now also prints the refusal's own sentence beside the daemon log tail, because "the rollback gave up
on its comeback" and "the rollback succeeded and the daemon stopped afterwards" are different bugs
that produced the same failed assertion.
