---
"@xplainer/cli": minor
---

Give `xplainer serve` a durable job store, exclusive ownership and boot reconciliation.

`serve` now does three things in a fixed order before it binds — acquire exclusive ownership of the
state directory, reconcile the jobs a previous run left behind, and build the job runner — which is
the invariant ADR 0024 §Exclusive ownership makes: reconciliation rewrites other processes' records,
so a second `serve` has to be turned away *first*. It exits `10` having written nothing, and the
test hashes every file in the state directory either side of the refusal to prove it.

The store is one JSON file per job under `jobs/`, written temp-then-`rename` with the file and then
the containing directory flushed, so `enqueue()` returns a `job_id` only once no crash can lose the
record. At boot, every job still `queued` or `running` whose daemon is gone becomes `error` with
`error_code: "daemon_restarted"`, a `finished_at` and a bounded log tail — never a `404`, and never
a `running` that never advances. Orphaned workers are killed only on a positive match of the
identity triple (pid, process start time, machine boot id); one that cannot be identified is left
alone, the record carries `workers_uncertain: true`, and the job's output directory is quarantined
so a retry writes somewhere fresh. A record written by a *newer* daemon is reported but never
rewritten, and an unparseable one is moved to `jobs/corrupt/` rather than stopping the boot.

Jobs run one at a time as child processes in their own process group, with stdout and stderr
captured into the record's bounded tail and the record made durable on every state transition;
cancelling or draining tears down the whole group, not just the leader. `recentStarts[]` and the
`stalled` flag now live in the durable `daemon.json` rather than in the ephemeral `runtime.json`,
which systemd deletes on every clean stop.

The eight tools still answer "not implemented in this phase": the runner exists and is exercised by
its own tests, and the render backend that enqueues against it is the next step.
