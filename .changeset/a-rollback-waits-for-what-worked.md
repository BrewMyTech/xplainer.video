---
"@xplainer/cli": patch
---

**A short `healthTimeoutMs` was also the budget the rollback got for putting the previous runtime
back — so the smaller a caller made it, the likelier `daemon update` was to leave the machine with
no daemon at all.**

`updateDaemon` and `recoverUpdate` took one readiness budget, and it is a budget for the runtime
being *installed*: "how long am I prepared to wait to find out this is not going to work". A caller
is entitled to make it small. The rollback's own wait — on the retained previous runtime, the one
thing in the transaction already known to work — was reading the same number, so a two-second budget
for the replacement was a two-second budget for the comeback. When that expired the transaction
refused with `4` and the sentence "The previous runtime … was put back and it did not answer
either", leaving a journal, a stopped daemon and a `xplainer daemon recover` for the user to run by
hand — over a daemon that was seconds from answering.

They are two questions now, and they are resolved separately. `UpdateRequest` gains
**`rollbackHealthTimeoutMs`**, which defaults to `healthTimeoutMs` or `REPLACEMENT_READY_TIMEOUT_MS`,
**whichever is larger** — so shortening the wait for the incoming runtime no longer shortens the wait
for the one being put back, and a caller who asked for longer still gets longer. Nothing else about
the transaction changes: the forward wait, the refusal codes, the journal and every boundary are as
they were. The new field exists for one kind of caller, and both of them are in this repository's own
suite: a case that has made **both** runtimes unstartable on purpose, where waiting the ordinary
minute for a start that cannot happen measures nothing.

Found as a flake rather than reasoned. T33's rollback rerun passes `healthTimeoutMs: 1_500` so that a
*deliberately* doomed replacement fails fast, and on `windows-latest` that 1.5 s became the whole
budget for a real `xplainer serve` to start: run `34319281465` shows the `started` case failing with
"A is answering /healthz as release 0.0.0" over a daemon whose log had reached its second line. The
same case failed once before (run `34308497439`) with no explanation. All six rollback cases pass in
run `34320488979`.

Two things were added so the next one says more. `transaction.test.ts` pins the separation directly —
both runtimes refused, the two budgets given deliberately different values, and the refusal must name
the rollback's own — and `setup/testing/rollback-render.ts` now prints the refusal's own sentence
beside the daemon log tail, because "the rollback gave up on its comeback" and "the rollback
succeeded and the daemon stopped afterwards" are different bugs that produced the same failed
assertion.
